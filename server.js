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
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

async function dbQuery(text, params) {
  return pool.query(text, params);
}

async function initDB() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS conversations (
      wa_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      wa_id TEXT NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL DEFAULT '',
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // upgrade (ticks)
  await dbQuery(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS wamid TEXT;`);
  await dbQuery(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_messages_wa_id_at ON messages(wa_id, at DESC);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages(wamid);`);
}

// ===== Middleware base =====
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// evita 405 em preflight
app.options('*', (req, res) => res.sendStatus(200));

// ===== Helpers =====
function normalizePhoneBR(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55')) return digits;
  return '55' + digits;
}

async function upsertConversation(waId, name = '') {
  await dbQuery(
    `
    INSERT INTO conversations (wa_id, name)
    VALUES ($1, $2)
    ON CONFLICT (wa_id)
    DO UPDATE SET
      name = COALESCE(NULLIF($2,''), conversations.name),
      updated_at = NOW()
    `,
    [waId, name]
  );
}

async function insertMessage({ waId, direction, text, status = 'sent', wamid = null, atMs = null }) {
  // não sobrescreve o nome (passa vazio)
  await upsertConversation(waId, '');
  if (atMs) {
    await dbQuery(
      `
      INSERT INTO messages (wa_id, direction, text, status, wamid, at)
      VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
      `,
      [waId, direction, text || '', status, wamid, atMs]
    );
  } else {
    await dbQuery(
      `
      INSERT INTO messages (wa_id, direction, text, status, wamid)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [waId, direction, text || '', status, wamid]
    );
  }
}

function normalizeStatus(st) {
  if (st === 'delivered') return 'delivered';
  if (st === 'read') return 'read';
  if (st === 'failed') return 'failed';
  return 'sent';
}

/**
 * ===========================
 * ✅ WEBHOOK (antes de static)
 * ===========================
 */
app.post('/webhook', async (req, res) => {
  try {
    const entries = req.body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];

      for (const change of changes) {
        const value = change.value;

        // =====================
        // 📩 MENSAGENS RECEBIDAS
        // =====================
        if (value.messages) {
          for (const msg of value.messages) {
            const from = msg.from;
            const name = value.contacts?.[0]?.profile?.name || from;

            let text = '[não-texto]';
            if (msg.type === 'text') text = msg.text?.body || '';
            if (msg.type === 'button') text = msg.button?.text || '[botão]';
            if (msg.type === 'interactive') text = '[interativo]';

            console.log('Recebida:', from, text);

            await upsertConversation(from, name);

            await insertMessage({
              waId: from,
              direction: 'in',
              text,
              status: 'read',
              wamid: msg.id
            });
          }
        }

        // =====================
        // ✔ STATUS (TICKS)
        // =====================
        if (value.statuses) {
          for (const status of value.statuses) {
            if (status.id) {
              await dbQuery(
                `UPDATE messages SET status = $1 WHERE wamid = $2`,
                [normalizeStatus(status.status), status.id]
              );
            }
          }
        }
      }
    }

    // RESPONDE SÓ DEPOIS DE PROCESSAR
    res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(200);
  }
});

/**
 * ===========================
 * ✅ Basic Auth só para a UI
 * /api e /webhook ficam liberados
 * ===========================
 */
app.use((req, res, next) => {
  if (req.path.startsWith('/webhook')) return next();
  if (req.path.startsWith('/api')) return next();

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

// anti-cache para UI
app.use((req, res, next) => {
  if (
    req.path === '/' ||
    req.path.endsWith('.html') ||
    req.path.endsWith('.js') ||
    req.path.endsWith('.css')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// ✅ rota principal do chat
app.get('/', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ✅ arquivos estáticos do chat
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

/**
 * ===========================
 * ✅ API do painel
 * ===========================
 */
app.get('/api/conversations', async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `
      SELECT c.wa_id AS "waId",
             COALESCE(NULLIF(c.name,''), c.wa_id) AS "name",
             EXTRACT(EPOCH FROM c.updated_at)*1000 AS "lastMessageAt",
             (
               SELECT json_build_object(
                 'direction', m.direction,
                 'text', m.text,
                 'at', EXTRACT(EPOCH FROM m.at)*1000,
                 'status', m.status
               )
               FROM messages m
               WHERE m.wa_id = c.wa_id
               ORDER BY m.at DESC
               LIMIT 1
             ) AS "last"
      FROM conversations c
      ORDER BY c.updated_at DESC
      LIMIT 300
      `
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Falha ao listar conversas', details: e.message });
  }
});

app.get('/api/messages/:waId', async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `
      SELECT direction, text, status, wamid, EXTRACT(EPOCH FROM at)*1000 AS at
      FROM messages
      WHERE wa_id = $1
      ORDER BY at ASC
      LIMIT 800
      `,
      [req.params.waId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Falha ao listar mensagens', details: e.message });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const phone = normalizePhoneBR(req.body.waId);
    if (!phone) return res.status(400).json({ error: 'Número inválido' });

    await upsertConversation(phone, '');
    res.json({ ok: true, waId: phone });
  } catch (e) {
    res.status(500).json({ error: 'Falha ao criar conversa', details: e.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { waId, text } = req.body;
  const phone = normalizePhoneBR(waId);

  if (!phone || !text) return res.status(400).json({ error: 'waId e text obrigatórios' });
  if (!TOKEN || !PHONE_ID) return res.status(500).json({ error: 'Token/Phone ID não configurados' });

  try {
    const r = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const wamid = r.data?.messages?.[0]?.id || null;
    await insertMessage({ waId: phone, direction: 'out', text, status: 'sent', wamid });

    res.json({ ok: true, wamid });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao enviar', details: err.response?.data || err.message });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

initDB()
  .then(() => console.log('DB OK'))
  .catch((e) => console.error('DB INIT ERROR:', e?.message || e));