// package.json

// index.js
require('dotenv').config();
const express        = require('express');
const bodyParser     = require('body-parser');
const AfricasTalking = require('africastalking')({
  username: process.env.AT_USERNAME,
  apiKey:   process.env.AT_API_KEY
});
const SMS = AfricasTalking.SMS;

const app = express();
app.use(bodyParser.json());

const THRESH = {
  moisture: Number(process.env.MOISTURE_THRESH) || 30
};

// POST /reading
// { moisture: Number }
app.post('/reading', async (req, res) => {
  try {
    const { moisture } = req.body;
    console.log(`Received moisture reading: ${moisture}%`);

    if (moisture < THRESH.moisture) {
      const msg = `⚠️ Low soil moisture alert: ${moisture}%`;
      console.log('Sending SMS:', { to: [process.env.FARMER_NUM], message: msg });
      const response = await SMS.send({
        to:      [ process.env.FARMER_NUM ],
        message: msg
      });
      console.log('SMS Response:', JSON.stringify(response, null, 2));
      
      if (response.SMSMessageData?.Recipients) {
        response.SMSMessageData.Recipients.forEach(r => {
          console.log(`Recipient ${r.number} status: ${r.status}, cost: ${r.cost}`);
        });
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Error in /reading:', e);
    res.status(500).send(e.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
