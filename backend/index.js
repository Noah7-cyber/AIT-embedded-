// index.js
require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const bodyParser     = require('body-parser');
const mongoose       = require('mongoose');
const path           = require('path');
const bcrypt         = require('bcryptjs');
const AfricasTalking = require('africastalking')({
  username: process.env.AT_USERNAME,
  apiKey:   process.env.AT_API_KEY
});
const SMS            = AfricasTalking.SMS;

const OWM_API_KEY   = process.env.OWM_API_KEY;
const OWM_CITY      = process.env.OWM_CITY || 'Kaduna';
const OWM_COUNTRY   = process.env.OWM_COUNTRY || 'NG';

// --- MongoDB Setup ---
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));

// --- Farmer Model ---
const farmerSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  phone:    { type: String, required: true, unique: true },
  password: { type: String, required: true },
  approved: { type: Boolean, default: false },
  isAdmin:  { type: Boolean, default: false }
});
const Farmer = mongoose.model('Farmer', farmerSchema);

// --- In-memory State ---
let lastReading = { moisture: 0, timestamp: null };
const THRESH   = { moisture: Number(process.env.MOISTURE_THRESH) || 30 };

const app = express();
app.use(cors());                        // enable CORS
app.use(bodyParser.json());             // parse JSON bodies
app.use(express.static(path.join(__dirname, 'public'))); // serve frontend

// --- Endpoints ---

// 1. POST /reading: ingest sensor data & send SMS with weather info
app.post('/reading', async (req, res) => {
  try {
    const { moisture } = req.body;
    console.log(`Received moisture reading: ${moisture}%`);
    lastReading = { moisture, timestamp: new Date() };

    if (moisture < THRESH.moisture) {
      // Fetch weather data
      let weatherInfo = '';
      if (OWM_API_KEY) {
        try {
          const wres = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?q=${OWM_CITY},${OWM_COUNTRY}&units=metric&appid=${OWM_API_KEY}`
          );
          const mw = await wres.json();
          weatherInfo = ` Weather: ${mw.weather[0].description}, ${mw.main.temp}°C, humidity ${mw.main.humidity}%`;
        } catch (err) {
          console.error('Weather fetch error:', err);
        }
      }

      // Notify approved farmers
      const farmers = await Farmer.find({ approved: true }).exec();
      const numbers = farmers.map(f => f.phone);
      if (numbers.length) {
        const msg = `⚠️ Low soil moisture alert: ${moisture}%.` + weatherInfo;
        await SMS.send({ to: numbers, message: msg });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Error in /reading:', e);
    res.status(500).send(e.toString());
  }
});

// 2. GET /status: current system status
app.get('/status', (req, res) => {
  res.json({ lastReading, threshold: THRESH.moisture });
});

// 3. POST /login: authenticate user (farmer or admin)
app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await Farmer.findOne({ phone }).exec();
    if (!user) return res.status(401).send('Invalid credentials');
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).send('Invalid credentials');
    return res.json({ approved: user.approved, isAdmin: user.isAdmin });
  } catch (e) {
    console.error('Error in /login:', e);
    res.status(500).send('Server error');
  }
});

// 4. POST /register: farmer signup
app.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const farmer = new Farmer({ name, phone, password: hashed });
    await farmer.save();
    res.json({ message: 'Registration successful, pending approval.' });
  } catch (e) {
    console.error('Error in /register:', e);
    if (e.code === 11000) {
      return res.status(400).send('Registration failed: phone number already registered.');
    }
    res.status(400).send('Registration failed.');
  }
});

// 5. Admin auth middleware (Basic Auth)
async function authAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Basic ')) {
      return res.status(401).send('Authorization required');
    }
    const [phone, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
    const user = await Farmer.findOne({ phone }).exec();
    if (!user) return res.status(401).send('Unauthorized');
    const match = await bcrypt.compare(password, user.password);
    if (!match || !user.isAdmin) return res.status(403).send('Forbidden');
    next();
  } catch (e) {
    console.error('Error in authAdmin:', e);
    res.status(500).send('Server error');
  }
}

// 6. GET /api/farmers: list all farmers (admin only)
app.get('/api/farmers', authAdmin, async (req, res) => {
  const farmers = await Farmer.find().select('-password').exec();
  res.json(farmers);
});

// 7. POST /api/approve: approve a farmer (admin only)
app.post('/api/approve', authAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    await Farmer.findByIdAndUpdate(id, { approved: true }).exec();
    res.json({ message: 'Farmer approved.' });
  } catch (e) {
    console.error('Error in /api/approve:', e);
    res.status(500).send('Approval failed');
  }
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
