require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('etag', false);

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_token';

const ADMIN_USER = process.env.ADMIN_USER || 'med16160';
const ADMIN_PASS = process.env.ADMIN_PASS || 'med16160';

// ================= DATABASE =================
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
      status TEXT DEFAULT 'sent',
      wamid TEXT,
      at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("DB OK");
}

// ================= HELPERS =================
function digitsOnly(v){ return String(v||'').replace(/\D/g,''); }

function normalizePhoneBR(input){
  const raw = String(input||'').split('@')[0];
  const d = digitsOnly(raw);
  if(!d) return '';
  return d.startsWith('55') ? d : '55'+d;
}

async function upsertConversation(waId, name=''){
  await dbQuery(`
    INSERT INTO conversations (wa_id,name)
    VALUES ($1,$2)
    ON CONFLICT (wa_id)
    DO UPDATE SET
      name = COALESCE(NULLIF($2,''), conversations.name),
      updated_at = NOW()
  `,[waId,name]);
}

async function insertMessage({waId,direction,text,status='sent',wamid=null}){
  await upsertConversation(waId,'');
  await dbQuery(`
    INSERT INTO messages (wa_id,direction,text,status,wamid)
    VALUES ($1,$2,$3,$4,$5)
  `,[waId,direction,text,status,wamid]);
}

// ================= MIDDLEWARE =================
app.use(express.json());
app.use(express.urlencoded({extended:true}));

// libera webhook e api
app.use((req,res,next)=>{
  if(req.path.startsWith('/webhook')) return next();
  if(req.path.startsWith('/api')) return next();

  const auth = req.headers.authorization || '';
  const [type,token] = auth.split(' ');
  if(type!=='Basic' || !token){
    res.setHeader('WWW-Authenticate','Basic realm="Painel WhatsApp"');
    return res.status(401).send('Auth required');
  }

  const [user,pass] = Buffer.from(token,'base64').toString().split(':');
  if(user===ADMIN_USER && pass===ADMIN_PASS) return next();

  return res.status(401).send('Invalid credentials');
});

app.use(express.static(path.join(__dirname,'public'),{etag:false,maxAge:0}));

// ================= API =================

app.get('/api/conversations', async (req,res)=>{
  const {rows} = await dbQuery(`
    SELECT c.wa_id AS "waId",
           c.name,
           EXTRACT(EPOCH FROM c.updated_at)*1000 AS "lastMessageAt",
           (
             SELECT json_build_object(
               'direction',m.direction,
               'text',m.text,
               'at',EXTRACT(EPOCH FROM m.at)*1000,
               'status',m.status
             )
             FROM messages m
             WHERE m.wa_id=c.wa_id
             ORDER BY m.at DESC LIMIT 1
           ) AS "last"
    FROM conversations c
    ORDER BY c.updated_at DESC
  `);
  res.json(rows);
});

app.get('/api/messages/:waId', async (req,res)=>{
  const phone = normalizePhoneBR(req.params.waId);
  const {rows} = await dbQuery(`
    SELECT direction,text,status,wamid,
           EXTRACT(EPOCH FROM at)*1000 AS at
    FROM messages
    WHERE wa_id=$1
    ORDER BY at ASC
  `,[phone]);
  res.json(rows);
});

app.post('/api/conversations', async (req,res)=>{
  const phone = normalizePhoneBR(req.body.waId);
  if(!phone) return res.status(400).json({error:'Número inválido'});
  await upsertConversation(phone,'');
  res.json({ok:true,waId:phone});
});

// ================= ENVIO COM FALLBACK =================
app.post('/api/send', async (req,res)=>{
  const {waId,text} = req.body;
  const phone = normalizePhoneBR(waId);

  const payloadText={
    messaging_product:'whatsapp',
    to:phone,
    type:'text',
    text:{body:text}
  };

  const payloadTemplate={
    messaging_product:'whatsapp',
    to:phone,
    type:'template',
    template:{
      name:'appointment_cancellation_1',
      language:{code:'pt_BR'}
    }
  };

  async function call(payload){
    return axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
      payload,
      {headers:{Authorization:`Bearer ${TOKEN}`}}
    );
  }

  try{
    let resp;
    let usedTemplate=false;

    try{
      resp=await call(payloadText);
    }catch(err){
      resp=await call(payloadTemplate);
      usedTemplate=true;
    }

    const wamid=resp.data?.messages?.[0]?.id||null;

    await insertMessage({
      waId:phone,
      direction:'out',
      text,
      status:'sent',
      wamid
    });

    res.json({ok:true,usedTemplate});
  }catch(err){
    res.status(500).json({
      error:'Falha ao enviar',
      details:err.response?.data||err.message
    });
  }
});

// ================= WEBHOOK =================
app.get('/webhook',(req,res)=>{
  if(
    req.query['hub.mode']==='subscribe' &&
    req.query['hub.verify_token']===VERIFY_TOKEN
  ){
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req,res)=>{
  try{
    const value=req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages=value?.messages||[];
    const statuses=value?.statuses||[];
    const contact=value?.contacts?.[0]?.profile?.name||'';

    for(const msg of messages){
      const from=normalizePhoneBR(msg.from);
      const text=msg.text?.body||'[não-texto]';
      await insertMessage({
        waId:from,
        direction:'in',
        text,
        status:'read',
        wamid:msg.id
      });
    }

    for(const st of statuses){
      await dbQuery(
        `UPDATE messages SET status=$1 WHERE wamid=$2`,
        [st.status,st.id]
      );
    }

  }catch(e){
    console.error(e);
  }
  res.sendStatus(200);
});

// ================= START =================
app.listen(PORT,()=>console.log("Servidor rodando na porta",PORT));
initDB();