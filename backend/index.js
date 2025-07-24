// index.js
require('dotenv').config();
const express        = require('express');
const bodyParser     = require('body-parser');
const mongoose       = require('mongoose');
const path           = require('path');
const bcrypt         = require('bcryptjs');
const AfricasTalking = require('africastalking')({
  username: process.env.AT_USERNAME,
  apiKey:   process.env.AT_API_KEY
});
const SMS            = AfricasTalking.SMS;

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
  approved: { type: Boolean, default: false }
});
const Farmer = mongoose.model('Farmer', farmerSchema);

// --- In-memory State ---
let lastReading = { moisture: 0, timestamp: null };
const THRESH   = { moisture: Number(process.env.MOISTURE_THRESH) || 30 };

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Endpoints ---

// 1. POST /reading: ingest sensor data and alert approved farmers
app.post('/reading', async (req, res) => {
  try {
    const { moisture } = req.body;
    console.log(`Received moisture reading: ${moisture}%`);
    lastReading = { moisture, timestamp: new Date() };

    if (moisture < 35) {
      const farmers = await Farmer.find({ approved: true }).exec();
      const numbers = farmers.map(f => f.phone);
      if (numbers.length) {
        const msg = `⚠️ Low soil moisture alert: ${moisture}%`;
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

// 3. POST /register: farmer signup with name, phone, and password
app.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const farmer = new Farmer({ name, phone, password: hashed });
    await farmer.save();
    res.json({ message: 'Registration successful, pending approval.' });
  } catch (e) {
    console.error('Error in /register:', e);
    res.status(400).send('Registration failed.');
  }
});

// 4. Admin authentication
const adminToken = process.env.ADMIN_TOKEN;
function authAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === adminToken) return next();
  res.status(401).send('Unauthorized');
}

// 5. GET /api/farmers: list all farmers (admin only)
app.get('/api/farmers', authAdmin, async (req, res) => {
  const farmers = await Farmer.find().select('-password').exec();
  res.json(farmers);
});

// 6. POST /api/approve: approve a farmer by ID (admin only)
app.post('/api/approve', authAdmin, async (req, res) => {
  const { id } = req.body;
  await Farmer.findByIdAndUpdate(id, { approved: true }).exec();
  res.json({ message: 'Farmer approved.' });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
