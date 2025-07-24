// index.js
const express      = require('express');
const bodyParser   = require('body-parser');
const AfricasTalking = require('africastalking')({
  apiKey:   process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});
const SMS = AfricasTalking.SMS;

// ─── OPTIONAL: MongoDB STORAGE ───
// To enable, uncomment the block below and set MONGODB_URI in .env
/*
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
const Reading = mongoose.model('Reading', {
  moisture: Number,
  temp:     Number,
  timestamp: Date
});
*/

const THRESH = { moisture: 30, temp: 35 };
const app    = express();
app.use(bodyParser.json());

// POST /reading
// Accepts { moisture: Number, temp: Number }
// Sends SMS if thresholds crossed; optionally saves to MongoDB
app.post('/reading', async (req, res) => {
  try {
    const { moisture, temp } = req.body;

    // if you want persistence, uncomment:
    // await Reading.create({ moisture, temp, timestamp: new Date() });

    if (moisture < THRESH.moisture || temp > THRESH.temp) {
      const msg = `⚠️ Alert! Soil:${moisture}% Temp:${temp}°C`;
      await SMS.send({
        to:      [process.env.FARMER_NUM],
        message: msg
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send(err.toString());
  }
});

// (Optional) GET /status — returns last reading (in-memory only)
let last = { moisture: 0, temp: 0 };
app.get('/status', (req, res) => res.json(last));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
