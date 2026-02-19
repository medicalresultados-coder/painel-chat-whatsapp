require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');

const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_token';

const ADMIN_USER = process.env.ADMIN_USER || 'med16160';
const ADMIN_PASS = process.env.ADMIN_PASS || 'med16160';

// ===== POSTGRES =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbQuery(text, params) {
  return pool.query(text, params);
}

async function initDB() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS conversations (
      wa_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      wa_id TEXT REFERENCES conversations(wa_id) ON DELETE CASCADE,
      direction TEXT CHECK (direction IN ('in','out')),
      text TEXT,
      at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ===== Middleware =====
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (req.path.startsWith('/webhook')) return next();

  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(' ');
  if (type !== 'Basic' || !token) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Painel WhatsApp"');
    return res.status(401).send('Auth required');
  }

  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  return res.status(401).send('Invalid credentials');
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== Helpers =====
function normalizePhoneBR(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55')) return digits;
  return '55' + digits;
}

async function upsertConversation(waId, name = '') {
  await dbQuery(`
    INSERT INTO conversations (wa_id, name)
    VALUES ($1, $2)
    ON CONFLICT (wa_id)
    DO UPDATE SET
      name = COALESCE(NULLIF($2,''), conversations.name),
      updated_at = NOW()
  `, [waId, name]);
}

async function pushMessage(waId, direction, text) {
  await upsertConversation(waId);
  await dbQuery(`
    INSERT INTO messages (wa_id, direction, text)
    VALUES ($1, $2, $3)
  `, [waId, direction, text]);
}

// ===== API =====
app.get('/api/conversations', async (req, res) => {
  const { rows } = await dbQuery(`
    SELECT c.wa_id AS "waId",
           c.name,
           EXTRACT(EPOCH FROM c.updated_at)*1000 AS "lastMessageAt",
           (
             SELECT json_build_object(
               'direction', m.direction,
               'text', m.text,
               'at', EXTRACT(EPOCH FROM m.at)*1000
             )
             FROM messages m
             WHERE m.wa_id = c.wa_id
             ORDER BY m.at DESC
             LIMIT 1
           ) AS "last"
    FROM conversations c
    ORDER BY c.updated_at DESC
  `);
  res.json(rows);
});

app.get('/api/messages/:waId', async (req, res) => {
  const { rows } = await dbQuery(`
    SELECT direction, text, EXTRACT(EPOCH FROM at)*1000 AS at
    FROM messages
    WHERE wa_id = $1
    ORDER BY at ASC
  `, [req.params.waId]);
  res.json(rows);
});

app.post('/api/conversations', async (req, res) => {
  const phone = normalizePhoneBR(req.body.waId);
  if (!phone) return res.status(400).json({ error: 'Número inválido' });

  await upsertConversation(phone, '');
  res.json({ ok: true, waId: phone });
});

app.post('/api/send', async (req, res) => {
  const { waId, text } = req.body;
  const phone = normalizePhoneBR(waId);

  if (!phone || !text)
    return res.status(400).json({ error: 'waId e text obrigatórios' });

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text }
      },
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    await pushMessage(phone, 'out', text);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: 'Falha ao enviar',
      details: err.response?.data || err.message
    });
  }
});

// ===== Webhook =====
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VERIFY_TOKEN
  ) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];

    if (msg) {
      const from = msg.from;
      const name = contact?.profile?.name || from;
      const text = msg.text?.body || '[não-texto]';

      await upsertConversation(from, name);
      await pushMessage(from, 'in', text);
    }
  } catch {}

  res.sendStatus(200);
});

// ===== START =====
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
});
