// index.js
require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const bodyParser     = require('body-parser');
const mongoose       = require('mongoose');
const path           = require('path');
const bcrypt         = require('bcryptjs');
const jwt            = require('jsonwebtoken');
const AfricasTalking = require('africastalking')({
  username: process.env.AT_USERNAME,
  apiKey:   process.env.AT_API_KEY
});
const SMS            = AfricasTalking.SMS;

const OWM_API_KEY   = process.env.OWM_API_KEY;
const OWM_CITY      = process.env.OWM_CITY     || 'Kaduna';
const OWM_COUNTRY   = process.env.OWM_COUNTRY  || 'NG';
const THRESH        = { moisture: Number(process.env.MOISTURE_THRESH) || 40 };
const JWT_SECRET    = process.env.JWT_SECRET  || 'supersecret_jwt_key';

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
mongoose.connection.on('error', console.error);

const farmerSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  phone:    { type: String, required: true, unique: true },
  password: { type: String, required: true },
  approved: { type: Boolean, default: false },
  isAdmin:  { type: Boolean, default: false }
});
const Farmer = mongoose.model('Farmer', farmerSchema);

let lastReading = { moisture: 0, timestamp: null };

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- MIDDLEWARES ---

function authenticate(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).send('Missing token');
  const token = h.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).send('Invalid token');
  }
}

function authorizeAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).send('Forbidden');
  next();
}

// --- ROUTES ---

// 1) Sensor → backend, only one response
app.post('/reading', async (req, res) => {
  try {
    const { moisture } = req.body;
    console.log(`Received moisture reading: ${moisture}%`);
    lastReading = { moisture, timestamp: new Date() };

    if (moisture < THRESH.moisture) {
      // Fetch weather
      let weatherInfo = '';
      if (OWM_API_KEY) {
        try {
          const wres = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
          );
          const mw = await wres.json();
          weatherInfo = ` Weather: ${mw.weather[0].description}, ${mw.main.temp}°C, humidity ${mw.main.humidity}%`;
        } catch (e) {
          console.error('Weather fetch error', e);
        }
      }

      // Notify farmers
      const farmers = await Farmer.find({ approved: true });
      const numbers = farmers.map(f => f.phone);
      if (numbers.length) {
        const msg = `⚠️ Low soil moisture alert: ${moisture}%.` + weatherInfo;
        await SMS.send({ to: numbers, message: msg });
        console.log('Sent SMS to', numbers);
      }
    }

    // single response
    return res.json({ ok: true, lastReading });
  } catch (e) {
    console.error('Error in /reading:', e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
});

// 2) protected status
app.get('/status', authenticate, (req, res) => {
  // only approved users get here
  if (!req.user.approved) return res.status(403).send('Account not approved');
  res.json({ lastReading, threshold: THRESH.moisture });
});

// 3) login → issue JWT
app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await Farmer.findOne({ phone });
    if (!user) return res.status(401).send('Invalid credentials');
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).send('Invalid credentials');

    const token = jwt.sign({
      id:       user._id,
      approved: user.approved,
      isAdmin:  user.isAdmin
    }, JWT_SECRET, { expiresIn: '8h' });

    return res.json({
      token,
      approved: user.approved,
      isAdmin:  user.isAdmin
    });
  } catch (e) {
    console.error('Error in /login:', e);
    return res.status(500).send('Server error');
  }
});

// 4) register
app.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    await new Farmer({ name, phone, password: hashed }).save();
    return res.json({ message: 'Registration success – pending approval.' });
  } catch (e) {
    console.error('Error in /register:', e);
    if (e.code === 11000) {
      return res.status(400).send('Phone already registered');
    }
    return res.status(400).send('Registration failed');
  }
});

// 5) admin routes, protected by JWT + isAdmin
app.get('/api/farmers', authenticate, authorizeAdmin, async (req, res) => {
  const farmers = await Farmer.find().select('-password');
  res.json(farmers);
});

app.post('/api/approve', authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    await Farmer.findByIdAndUpdate(id, { approved: true });
    res.json({ message: 'Farmer approved.' });
  } catch (e) {
    console.error('Error in /api/approve:', e);
    res.status(500).send('Approval failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
