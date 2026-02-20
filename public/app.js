// UI_VERSION: 2026-02-20-FIX-ID-MATCH

let selected = null;
let selectedName = '';
let timer = null;

function qs(id){ return document.getElementById(id); }

function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g,m=>(
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
}

function digitsOnly(v){ return String(v||'').replace(/\D/g,''); }

function normalizePhone(v){
  v = String(v||'').split('@')[0];
  const d = digitsOnly(v);
  if(!d) return '';
  return d.startsWith('55') ? d : '55'+d;
}

function initials(n){
  n = String(n||'').trim();
  if(!n) return '—';
  const p = n.split(/\s+/);
  if(p.length===1) return p[0].slice(0,2).toUpperCase();
  return (p[0][0]+p[1][0]).toUpperCase();
}

function fmtTime(ts){
  return new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}

/* =============================
   CONVERSAS
============================= */

async function loadConversations(){
  const list = await fetch('/api/conversations',{credentials:'same-origin'}).then(r=>r.json());

  const box = qs('convoList');
  box.innerHTML='';

  list.forEach(c=>{
    const wa = normalizePhone(c.waId);
    const name = c.name || wa;
    const last = c.last?.text || '';
    const time = c.lastMessageAt ? fmtTime(c.lastMessageAt):'';

    const row = document.createElement('div');
    row.className='px-4 py-3 border-b cursor-pointer hover:bg-[#f5f6f6]';
    row.innerHTML=`
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-full bg-slate-200 flex items-center justify-center font-semibold">
          ${escapeHtml(initials(name))}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between">
            <div class="font-semibold truncate">${escapeHtml(name)}</div>
            <div class="text-xs text-slate-500">${escapeHtml(time)}</div>
          </div>
          <div class="text-sm text-slate-500 truncate">${escapeHtml(last)}</div>
        </div>
      </div>
    `;

    row.onclick=()=>selectConversation(wa,name);
    box.appendChild(row);
  });
}

/* =============================
   MENSAGENS
============================= */

async function loadMessages(force){
  if(!selected) return;

  const msgs = await fetch(`/api/messages/${selected}`,{credentials:'same-origin'}).then(r=>r.json());

  const wrap = qs('messages');
  wrap.innerHTML='';

  msgs.forEach(m=>{
    const isOut = m.direction==='out';
    const div = document.createElement('div');
    div.className=`flex mb-2 ${isOut?'justify-end':'justify-start'}`;

    div.innerHTML=`
      <div class="max-w-[70%] px-4 py-2 rounded-lg text-sm
        ${isOut?'bg-emerald-200':'bg-white'}">
        ${escapeHtml(m.text)}
        <div class="text-[10px] text-slate-500 mt-1 text-right">
          ${fmtTime(m.at)} ${isOut?(m.status==='read'?'✓✓':'✓'):''}
        </div>
      </div>
    `;

    wrap.appendChild(div);
  });

  wrap.scrollTop=wrap.scrollHeight;
}

/* =============================
   SELECIONAR
============================= */

async function selectConversation(wa,name){
  selected=normalizePhone(wa);
  selectedName=name;

  qs('chatTitle').innerText=name;
  qs('chatSubtitle').innerText=selected;
  qs('avatar').innerText=initials(name);
  qs('btnSend').disabled=false;

  await loadMessages(true);
}

/* =============================
   ENVIAR
============================= */

async function sendMessage(){
  if(!selected) return;

  const input = qs('msg');
  const text = input.value.trim();
  if(!text) return;

  await fetch('/api/send',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'same-origin',
    body:JSON.stringify({waId:selected,text})
  });

  input.value='';
  await loadMessages(true);
  await loadConversations();
}

/* =============================
   NOVA CONVERSA
============================= */

async function createConversation(){
  const n = normalizePhone(qs('newNumber').value);
  if(!n) return alert('Número inválido');

  await fetch('/api/conversations',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'same-origin',
    body:JSON.stringify({waId:n})
  });

  qs('newNumber').value='';
  await loadConversations();
  await selectConversation(n,n);
}

/* =============================
   POLLING
============================= */

function startPolling(){
  if(timer) clearInterval(timer);
  timer=setInterval(async()=>{
    await loadConversations();
    if(selected) await loadMessages(false);
  },3000);
}

/* =============================
   BOOT
============================= */

document.addEventListener('DOMContentLoaded',async()=>{
  qs('btnSend').onclick=sendMessage;
  qs('btnNew').onclick=createConversation;
  qs('btnRefresh').onclick=loadConversations;

  qs('msg').addEventListener('keydown',e=>{
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();
      sendMessage();
    }
  });

  await loadConversations();
  startPolling();
});