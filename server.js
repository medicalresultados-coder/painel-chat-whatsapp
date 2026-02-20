require('dotenv').config();
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'med16160';

app.use(express.json());

// TESTE 1 - GET
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('GET WEBHOOK');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.status(200).send('Webhook ativo');
});

// TESTE 2 - POST
app.post('/webhook', (req, res) => {
  console.log('POST WEBHOOK RECEBIDO');
  console.log(JSON.stringify(req.body));
  res.status(200).send('ok');
});

app.listen(PORT, () => {
  console.log('Servidor rodando na porta', PORT);
});