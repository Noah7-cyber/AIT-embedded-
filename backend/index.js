// index.js
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const mongoose   = require('mongoose');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

// dynamic import for node-fetch v3
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

// production SMS client (uses AT_USERNAME from your .env)
const AfricasTalking = require('africastalking')({
  username: process.env.AT_USERNAME,
  apiKey:   process.env.AT_API_KEY
});
const SMS = AfricasTalking.SMS;

// sandbox USSD client
const AT_SANDBOX = require('africastalking')({
  username: 'sandbox',
  apiKey:   process.env.AT_API_KEY
});
const USSD = AT_SANDBOX.USSD;

const {
  OWM_API_KEY,
  OWM_CITY    = 'Kaduna',
  OWM_COUNTRY = 'NG',
  MOISTURE_THRESH,
  JWT_SECRET  = 'supersecret_jwt_key',
  MONGODB_URI
} = process.env;

const THRESH = { moisture: Number(MOISTURE_THRESH) || 40 };

// ── MONGODB SETUP ──────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).catch(err => console.error('MongoDB error:', err));

const farmerSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  phone:    { type: String, required: true, unique: true },
  password: { type: String, required: true },
  approved: { type: Boolean, default: false },
  isAdmin:  { type: Boolean, default: false }
});
const Farmer = mongoose.model('Farmer', farmerSchema);

let lastReading = { moisture: 0, timestamp: null };

// ── EXPRESS SETUP ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH HELPERS ───────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
    return res.status(401).send('Missing token');
  }
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).send('Invalid token');
  }
}
function authorizeAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).send('Forbidden');
  next();
}

// ── 1) PUBLIC READING ENDPOINT ─────────────────────────────────────────────────
app.post('/reading', (req, res) => {
  const { moisture } = req.body;
  console.log(`Received moisture: ${moisture}%`);
  lastReading = { moisture, timestamp: new Date() };

  // immediately respond to caller
  res.json({ ok: true, lastReading });

  // if below threshold, fire‐and‐forget SMS
  if (moisture < THRESH.moisture) {
    (async () => {
      // 1a) fetch weather
      let weatherInfo = '';
      if (OWM_API_KEY) {
        try {
          const wres = await fetch(
            `https://api.openweathermap.org/data/2.5/weather` +
            `?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
          );
          const mw = await wres.json();
          weatherInfo = ` Weather: ${mw.weather[0].description}, ` +
                        `${mw.main.temp}°C, humidity ${mw.main.humidity}%`;
        } catch (e) {
          console.error('Weather fetch error:', e);
        }
      }

      // 1b) send SMS to approved farmers
      try {
        const farmers = await Farmer.find({ approved: true });
        const numbers = farmers.map(f => f.phone);
        if (!numbers.length) {
          console.log('No approved farmers to notify.');
          return;
        }
        const msg = `⚠️ Low soil moisture alert: ${moisture}%.` + weatherInfo;
        const atResp = await SMS.send({ to: numbers, message: msg });
        console.log('SMS sent:', JSON.stringify(atResp, null, 2));
      } catch (smsErr) {
        console.error('SMS send error (ignored):', smsErr);
      }
    })();
  }
});

// ── 2) PROTECTED STATUS ENDPOINT ───────────────────────────────────────────────
app.get('/status', authenticate, (req, res) => {
  if (!req.user.approved) {
    return res.status(403).send('Account not approved');
  }
  res.json({ lastReading, threshold: THRESH.moisture });
});

// ── 3) LOGIN → ISSUE JWT ───────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await Farmer.findOne({ phone });
    if (!user) return res.status(401).send('Invalid credentials');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).send('Invalid credentials');

    const token = jwt.sign({
      id:       user._id,
      approved: user.approved,
      isAdmin:  user.isAdmin
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({ token, approved: user.approved, isAdmin: user.isAdmin });
  } catch (e) {
    console.error('Error in /login:', e);
    res.status(500).send('Server error');
  }
});

// ── 4) REGISTER ────────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await new Farmer({ name, phone, password: hash }).save();
    res.json({ message: 'Registration success – pending approval.' });
  } catch (e) {
    console.error('Error in /register:', e);
    if (e.code === 11000) {
      return res.status(400).send('Phone already registered');
    }
    res.status(400).send('Registration failed');
  }
});

// ── 5) ADMIN ROUTES ───────────────────────────────────────────────────────────
app.get('/api/farmers', authenticate, authorizeAdmin, async (req, res) => {
  const farmers = await Farmer.find().select('-password');
  res.json(farmers);
});
app.post('/api/approve', authenticate, authorizeAdmin, async (req, res) => {
  try {
    await Farmer.findByIdAndUpdate(req.body.id, { approved: true });
    res.json({ message: 'Farmer approved.' });
  } catch (e) {
    console.error('Approval error:', e);
    res.status(500).send('Approval failed');
  }
});

// ── 6) USSD CALLBACK (SANDBOX) ────────────────────────────────────────────────
app.post('/ussd', async (req, res) => {
  const { sessionId, serviceCode, phoneNumber, text = '' } = req.body;
  let response = '';

  if (text === '') {
    response  = 'CON Welcome to Agri Monitor\n';
    response += '1. Soil moisture\n';
    response += '2. Ambient temp\n';
    response += '3. Humidity';
  } else if (text === '1') {
    response = `END Last soil moisture is ${lastReading.moisture}%`;
  } else if (text === '2') {
    try {
      const wres = await fetch(
        `https://api.openweathermap.org/data/2.5/weather` +
        `?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
      );
      const mw = await wres.json();
      response = `END Current temperature: ${mw.main.temp}°C`;
    } catch {
      response = 'END Unable to fetch temperature';
    }
  } else if (text === '3') {
    try {
      const wres = await fetch(
        `https://api.openweathermap.org/data/2.5/weather` +
        `?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
      );
      const mw = await wres.json();
      response = `END Current humidity: ${mw.main.humidity}%`;
    } catch {
      response = 'END Unable to fetch humidity';
    }
  } else {
    response = 'END Invalid choice';
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
});

// ── START SERVER ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
