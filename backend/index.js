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

// Environment variables
const {
  AT_USERNAME,
  AT_API_KEY,
  OWM_API_KEY,
  OWM_CITY    = 'Kaduna',
  OWM_COUNTRY = 'NG',
  MOISTURE_THRESH = 40,
  JWT_SECRET    = 'supersecret_jwt_key',
  MONGODB_URI
} = process.env;

// Threshold
const THRESH = { moisture: Number(MOISTURE_THRESH) };

// Africa's Talking clients
const SMSClient = require('africastalking')({
  username: AT_USERNAME,
  apiKey:   AT_API_KEY,
  environment: 'production'
}).SMS;

const USSDClient = require('africastalking')({
  username: 'sandbox',
  apiKey:   AT_API_KEY,
  environment: 'sandbox'
}).USSD;

// MongoDB setup
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

// In-memory state
let lastReading = { moisture: 0, timestamp: null };

// Express app
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).send('Missing token');
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).send('Invalid token');
  }
}
function authorizeAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).send('Forbidden');
  next();
}

// 1) Public reading endpoint
app.post('/reading', (req, res) => {
  const { moisture } = req.body;
  console.log(`Received moisture: ${moisture}%`);
  lastReading = { moisture, timestamp: new Date() };

  // respond immediately
  res.json({ ok: true, lastReading });

  // if below threshold, send SMS asynchronously
  if (moisture < THRESH.moisture) {
    (async () => {
      let weatherInfo = '';
      if (OWM_API_KEY) {
        try {
          const wres = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
          );
          const mw = await wres.json();
          weatherInfo = ` Weather: ${mw.weather[0].description}, ${mw.main.temp}°C, humidity ${mw.main.humidity}%`;
        } catch (e) {
          console.error('Weather fetch error:', e);
        }
      }

      try {
        const farmers = await Farmer.find({ approved: true });
        const numbers = farmers.map(f => f.phone);
        if (numbers.length) {
          const msg = `⚠️ Low soil moisture alert: ${moisture}%.` + weatherInfo;
          const atResp = await SMSClient.send({ to: numbers, message: msg });
          console.log('SMS sent:', JSON.stringify(atResp, null, 2));
        } else {
          console.log('No approved farmers to notify.');
        }
      } catch (smsErr) {
        console.error('SMS send error:', smsErr);
      }
    })();
  }
});

// 2) Protected status endpoint
app.get('/status', authenticate, (req, res) => {
  if (!req.user.approved) return res.status(403).send('Account not approved');
  res.json({ lastReading, threshold: THRESH.moisture });
});

// 3) Login → issue JWT
app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await Farmer.findOne({ phone });
    if (!user) return res.status(401).send('Invalid credentials');
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).send('Invalid credentials');

    const token = jwt.sign(
      { id: user._id, approved: user.approved, isAdmin: user.isAdmin },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, approved: user.approved, isAdmin: user.isAdmin });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).send('Server error');
  }
});

// 4) Register
app.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await new Farmer({ name, phone, password: hash }).save();
    res.json({ message: 'Registration success – pending approval.' });
  } catch (e) {
    console.error('Registration error:', e);
    if (e.code === 11000) return res.status(400).send('Phone already registered');
    res.status(400).send('Registration failed');
  }
});

// 5) Admin routes
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

// 6) USSD callback (sandbox)
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
        `https://api.openweathermap.org/data/2.5/weather?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
      );
      const mw = await wres.json();
      response = `END Current temperature: ${mw.main.temp}°C`;
    } catch {
      response = 'END Unable to fetch temperature';
    }
  } else if (text === '3') {
    try {
      const wres = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
