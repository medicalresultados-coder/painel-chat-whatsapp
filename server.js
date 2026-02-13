require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_token';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'senha_forte';

// ===== Middleware =====
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Proteção por senha (Basic Auth) - libera /webhook
app.use((req, res, next) => {
  // if (req.path.startsWith('/webhook')) return next();

  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type !== 'Basic' || !token) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Painel WhatsApp"');
    return res.status(401).send('Auth required');
  }

  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.setHeader('WWW-Authenticate', 'Basic realm="Painel WhatsApp"');
  return res.status(401).send('Invalid credentials');
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== DB simples em arquivo (para testes locais). Para produção, recomendo Postgres depois. =====
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch { return { conversations: {} }; }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

function upsertConversation(db, waId, name = '') {
  if (!db.conversations[waId]) {
    db.conversations[waId] = { waId, name: name || waId, lastMessageAt: Date.now(), messages: [] };
  } else if (name && db.conversations[waId].name === db.conversations[waId].waId) {
    db.conversations[waId].name = name;
  }
  return db.conversations[waId];
}
function pushMessage(db, waId, msg) {
  const convo = upsertConversation(db, waId);
  convo.messages.push(msg);
  convo.lastMessageAt = Date.now();
}

function normalizePhoneBR(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55')) return digits;
  return '55' + digits;
}

// ===== Painel API =====
app.get('/api/conversations', (req, res) => {
  const db = loadDB();
  const list = Object.values(db.conversations)
    .map(c => ({
      waId: c.waId,
      name: c.name,
      lastMessageAt: c.lastMessageAt,
      last: c.messages[c.messages.length - 1] || null
    }))
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  res.json(list);
});

app.get('/api/messages/:waId', (req, res) => {
  const db = loadDB();
  const convo = db.conversations[req.params.waId];
  res.json(convo ? convo.messages : []);
});

app.post('/api/conversations', (req, res) => {
  const { waId, name } = req.body;
  const phone = normalizePhoneBR(waId);
  if (!phone) return res.status(400).json({ error: 'Número inválido' });

  const db = loadDB();
  upsertConversation(db, phone, name || phone);
  saveDB(db);
  res.json({ ok: true, waId: phone });
});

// ===== Envio inteligente (melhor forma): tenta TEXTO; se falhar por janela 24h, manda TEMPLATE =====
app.post('/api/send', async (req, res) => {
  const { waId, text } = req.body;
  const phone = normalizePhoneBR(waId);

  if (!phone || !text) return res.status(400).json({ error: 'waId e text são obrigatórios' });
  if (!TOKEN || !PHONE_ID) return res.status(500).json({ error: 'Token/Phone ID não configurados no .env' });

  const db = loadDB();
  upsertConversation(db, phone);

  const payloadText = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text }
  };

  // Template fixo (sem variáveis) - seu template aprovado
  const payloadTemplate = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: 'appointment_cancellation_1',
      language: { code: 'pt_BR' }
    }
  };

  async function callWhatsApp(payload) {
    return axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
    );
  }

  try {
    try {
      // tenta texto livre primeiro
      await callWhatsApp(payloadText);
    } catch (err) {
      // fallback: se janela fechada, manda template
      const code = err.response?.data?.error?.code;
      const msg = (err.response?.data?.error?.message || '').toLowerCase();
      const isWindowError =
        code === 131047 ||
        msg.includes('24 hour') ||
        msg.includes('outside the allowed window') ||
        msg.includes('re-engagement');

      if (!isWindowError) throw err;

      await callWhatsApp(payloadTemplate);
    }

    pushMessage(db, phone, { id: 'out_' + Date.now(), direction: 'out', text, at: Date.now() });
    saveDB(db);

    res.json({ ok: true });
  } catch (err) {
    const details = err.response?.data || err.message;
    res.status(500).json({ error: 'Falha ao enviar', details });
  }
});

// ===== Webhook (receber mensagens) =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    const contacts = value?.contacts;

    if (messages && messages.length) {
      const msg = messages[0];
      const from = msg.from;
      const name = contacts?.[0]?.profile?.name || from;

      let text = '[mensagem não-texto]';
      if (msg.type === 'text') text = msg.text?.body || '';
      if (msg.type === 'button') text = msg.button?.text || '[botão]';
      if (msg.type === 'interactive') text = '[interativo]';

      const db = loadDB();
      upsertConversation(db, from, name);
      pushMessage(db, from, { id: msg.id || ('in_' + Date.now()), direction: 'in', text, at: Date.now() });
      saveDB(db);
    }
  } catch {
    // não quebra webhook
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Painel: http://localhost:${PORT}`);
});
