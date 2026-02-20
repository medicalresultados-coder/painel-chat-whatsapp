require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('etag', false);

// Railway/Render/etc: sempre use PORT do ambiente quando existir
const PORT = process.env.PORT || 3000;

// Meta / WhatsApp
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_token';

// Template (o seu aprovado)
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'appointment_cancellation_1';
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'pt_BR';

// Auth do painel (UI)
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

  await dbQuery(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS wamid TEXT;`);
  await dbQuery(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'sent';`);

  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_messages_wa_id_at ON messages(wa_id, at DESC);`);
  await dbQuery(`CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages(wamid);`);

  console.log('DB OK');
}

// ===== Middleware =====
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.options('*', (req, res) => res.sendStatus(200));

// anti-cache API
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ===== Helpers =====
function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizePhoneBR(input) {
  const raw = String(input || '').trim();
  const noAt = raw.split('@')[0];
  const d = digitsOnly(noAt);
  if (!d) return '';
  if (d.startsWith('55')) return d;
  return '55' + d;
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

async function insertMessage({ waId, direction, text, status = 'sent', wamid = null }) {
  await upsertConversation(waId, '');
  await dbQuery(
    `
    INSERT INTO messages (wa_id, direction, text, status, wamid)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [waId, direction, String(text || ''), status, wamid]
  );
}

function normalizeStatus(st) {
  if (st === 'delivered') return 'delivered';
  if (st === 'read') return 'read';
  if (st === 'failed') return 'failed';
  return 'sent';
}

function is24hWindowError(err) {
  const code = err?.response?.data?.error?.code;
  const msg = String(err?.response?.data?.error?.message || '').toLowerCase();
  // códigos/mensagens típicos do WhatsApp Cloud API quando fora da janela
  return (
    code === 131047 ||
    msg.includes('24 hour') ||
    msg.includes('outside the allowed window') ||
    msg.includes('re-engagement') ||
    msg.includes('outside of the allowed window')
  );
}

async function callWhatsApp(payload) {
  return axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

function templatePayload(to, components = undefined) {
  const p = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG }
    }
  };
  if (Array.isArray(components) && components.length) {
    p.template.components = components;
  }
  return p;
}

// ======================
// ✅ WEBHOOK (SEM AUTH)
// ======================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;

        // Mensagens recebidas
        const messages = Array.isArray(value?.messages) ? value.messages : [];
        const contactName = value?.contacts?.[0]?.profile?.name || '';

        for (const msg of messages) {
          const from = normalizePhoneBR(msg?.from);
          if (!from) continue;

          let text = '[não-texto]';
          if (msg.type === 'text') text = msg.text?.body || '';
          else if (msg.type === 'button') text = msg.button?.text || '[botão]';
          else if (msg.type === 'interactive') text = '[interativo]';

          await upsertConversation(from, contactName || from);
          await insertMessage({
            waId: from,
            direction: 'in',
            text,
            status: 'read',
            wamid: msg.id || null
          });

          console.log('IN:', from, text);
        }

        // Status (ticks)
        const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
        for (const st of statuses) {
          if (!st?.id) continue;
          await dbQuery(`UPDATE messages SET status = $1 WHERE wamid = $2`, [
            normalizeStatus(st.status),
            st.id
          ]);
        }
      }
    }
  } catch (e) {
    console.error('Webhook error:', e?.message || e);
  }

  return res.sendStatus(200);
});

// ======================
// ✅ BASIC AUTH SÓ NA UI
// /api e /webhook liberados
// ======================
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

// anti-cache UI
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ======================
// ✅ API DO PAINEL
// ======================

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
    const waId = normalizePhoneBR(req.params.waId);
    const { rows } = await dbQuery(
      `
      SELECT direction, text, status, wamid, EXTRACT(EPOCH FROM at)*1000 AS at
      FROM messages
      WHERE wa_id = $1
      ORDER BY at ASC
      LIMIT 800
      `,
      [waId]
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

// ======================
// ✅ ENVIAR TEXTO com FALLBACK TEMPLATE
// ======================
app.post('/api/send', async (req, res) => {
  const { waId, text } = req.body;
  const phone = normalizePhoneBR(waId);

  if (!phone || !text) return res.status(400).json({ error: 'waId e text obrigatórios' });
  if (!TOKEN || !PHONE_ID) return res.status(500).json({ error: 'Token/Phone ID não configurados' });

  const payloadText = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: String(text) }
  };

  // Se um dia seu template tiver variáveis, você poderá mandar components no body:
  // { templateComponents: [ { type:'body', parameters:[{type:'text', text:'...' }]} ] }
  const templateComponents = Array.isArray(req.body.templateComponents) ? req.body.templateComponents : undefined;
  const payloadTpl = templatePayload(phone, templateComponents);

  try {
    let resp;
    let usedTemplate = false;

    try {
      // 1) tenta texto livre
      resp = await callWhatsApp(payloadText);
    } catch (errText) {
      // 2) se falhar por janela 24h, tenta template
      if (!is24hWindowError(errText)) {
        return res.status(500).json({
          error: 'Falha ao enviar texto (não é janela 24h)',
          details: errText.response?.data || errText.message
        });
      }

      try {
        resp = await callWhatsApp(payloadTpl);
        usedTemplate = true;
      } catch (errTpl) {
        return res.status(500).json({
          error: 'Falha ao enviar template',
          details: errTpl.response?.data || errTpl.message,
          template: { name: TEMPLATE_NAME, lang: TEMPLATE_LANG }
        });
      }
    }

    const wamid = resp.data?.messages?.[0]?.id || null;

    await insertMessage({
      waId: phone,
      direction: 'out',
      text: usedTemplate ? `[TEMPLATE:${TEMPLATE_NAME}] ${text}` : text,
      status: 'sent',
      wamid
    });

    return res.json({ ok: true, wamid, usedTemplate, template: { name: TEMPLATE_NAME, lang: TEMPLATE_LANG } });
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao enviar', details: err.response?.data || err.message });
  }
});

// ======================
// ✅ FORÇAR TEMPLATE (TESTE DEFINITIVO)
// ======================
app.post('/api/send-template', async (req, res) => {
  const { waId } = req.body;
  const phone = normalizePhoneBR(waId);

  if (!phone) return res.status(400).json({ error: 'waId obrigatório' });
  if (!TOKEN || !PHONE_ID) return res.status(500).json({ error: 'Token/Phone ID não configurados' });

  const templateComponents = Array.isArray(req.body.templateComponents) ? req.body.templateComponents : undefined;
  const payloadTpl = templatePayload(phone, templateComponents);

  try {
    const r = await callWhatsApp(payloadTpl);
    const wamid = r.data?.messages?.[0]?.id || null;

    await insertMessage({
      waId: phone,
      direction: 'out',
      text: `[TEMPLATE:${TEMPLATE_NAME}]`,
      status: 'sent',
      wamid
    });

    return res.json({ ok: true, wamid, usedTemplate: true, template: { name: TEMPLATE_NAME, lang: TEMPLATE_LANG } });
  } catch (err) {
    return res.status(500).json({
      error: 'Falha ao enviar template',
      details: err.response?.data || err.message,
      template: { name: TEMPLATE_NAME, lang: TEMPLATE_LANG }
    });
  }
});

// ===== START =====
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

initDB().catch((e) => console.error('DB INIT ERROR:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT EXCEPTION:', e));