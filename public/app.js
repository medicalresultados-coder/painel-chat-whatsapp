// UI_VERSION: 2026-02-20-TEMPLATE-BUTTON

let selected = null;
let selectedName = '';
let timer = null;

function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

function digitsOnly(v) { return String(v || '').replace(/\D/g, ''); }

function normalizePhone(v) {
  v = String(v || '').trim().split('@')[0];
  const d = digitsOnly(v);
  if (!d) return '';
  return d.startsWith('55') ? d : '55' + d;
}

function initials(n) {
  n = String(n || '').trim();
  if (!n) return '—';
  const p = n.split(/\s+/).filter(Boolean);
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[1][0]).toUpperCase();
}

function fmt(ts) {
  try { return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
  let data = null;
  try { data = await res.json(); } catch { }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function tick(status) {
  if (status === 'read') return ' ✓✓';
  if (status === 'delivered') return ' ✓✓';
  if (status === 'failed') return ' !';
  return ' ✓';
}

async function loadConversations() {
  const list = await fetchJSON('/api/conversations');
  const box = qs('convoList');
  if (!box) return;

  box.innerHTML = '';

  list.forEach(c => {
    const wa = normalizePhone(c.waId);
    const name = c.name || wa;
    const last = c.last?.text || '';
    const time = c.lastMessageAt ? fmt(c.lastMessageAt) : '';

    const row = document.createElement('div');
    row.className = 'px-4 py-3 border-b cursor-pointer hover:bg-[#f5f6f6]';
    row.innerHTML = `
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
          <div class="text-[11px] text-slate-400 truncate">${escapeHtml(wa)}</div>
        </div>
      </div>
    `;
    row.onclick = () => selectConversation(wa, name);
    box.appendChild(row);
  });
}

async function loadMessages() {
  if (!selected) return;

  const msgs = await fetchJSON(`/api/messages/${encodeURIComponent(selected)}`);
  const box = qs('messages');
  if (!box) return;

  box.innerHTML = '';

  msgs.forEach(m => {
    const isOut = m.direction === 'out';
    const wrap = document.createElement('div');
    wrap.className = `flex mb-2 ${isOut ? 'justify-end' : 'justify-start'}`;

    wrap.innerHTML = `
      <div class="max-w-[70%] px-3 py-2 rounded-lg text-sm ${isOut ? 'bg-emerald-200' : 'bg-white'}">
        <div>${escapeHtml(m.text || '')}</div>
        <div class="text-[10px] text-slate-500 mt-1 text-right">
          ${escapeHtml(fmt(m.at))}${isOut ? tick(m.status) : ''}
        </div>
      </div>
    `;
    box.appendChild(wrap);
  });

  box.scrollTop = box.scrollHeight;
}

async function selectConversation(wa, name) {
  selected = normalizePhone(wa);
  selectedName = name || selected;

  const title = qs('chatTitle');
  const sub = qs('chatSubtitle');
  const av = qs('avatar');

  if (title) title.innerText = selectedName;
  if (sub) sub.innerText = selected;
  if (av) av.innerText = initials(selectedName);

  const btnSend = qs('btnSend');
  if (btnSend) btnSend.disabled = false;

  await loadMessages();
}

async function createConversation() {
  const input = qs('newNumber');
  const wa = normalizePhone(input?.value || '');
  if (!wa) return alert('Número inválido');

  await fetchJSON('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waId: wa })
  });

  if (input) input.value = '';
  await loadConversations();
  await selectConversation(wa, wa);
}

async function sendMessage() {
  if (!selected) return alert('Selecione uma conversa');

  const input = qs('msg');
  const text = String(input?.value || '').trim();
  if (!text) return;

  try {
    const resp = await fetchJSON('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: selected, text })
    });

    if (input) input.value = '';

    if (resp.usedTemplate) {
      alert(`Fora da janela 24h: enviado como TEMPLATE (${resp.template?.name || 'appointment_cancellation_1'}).`);
    }

    await loadMessages();
    await loadConversations();
  } catch (e) {
    const details = e?.data ? JSON.stringify(e.data, null, 2) : '';
    alert('Erro ao enviar:\n' + (e.message || e) + (details ? '\n\n' + details : ''));
  }
}

async function sendTemplateForced() {
  if (!selected) return alert('Selecione uma conversa');

  try {
    const resp = await fetchJSON('/api/send-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: selected })
    });

    alert(`Template enviado: ${resp.template?.name || 'appointment_cancellation_1'}`);
    await loadMessages();
    await loadConversations();
  } catch (e) {
    // aqui aparece o motivo REAL do template não estar indo
    const details = e?.data ? JSON.stringify(e.data, null, 2) : '';
    alert('Erro ao enviar TEMPLATE:\n' + (e.message || e) + (details ? '\n\n' + details : ''));
  }
}

function ensureTemplateButton() {
  // Se não existir um botão no HTML, criamos automaticamente perto do btnSend
  if (qs('btnTemplate')) return;

  const btnSend = qs('btnSend');
  if (!btnSend || !btnSend.parentElement) return;

  const b = document.createElement('button');
  b.id = 'btnTemplate';
  b.type = 'button';
  b.className = 'px-3 py-2 rounded bg-slate-700 text-white text-sm ml-2';
  b.innerText = 'Enviar Template';
  b.onclick = sendTemplateForced;

  btnSend.parentElement.appendChild(b);
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(async () => {
    try {
      await loadConversations();
      if (selected) await loadMessages();
    } catch {}
  }, 2500);
}

document.addEventListener('DOMContentLoaded', async () => {
  ensureTemplateButton();

  const btnNew = qs('btnNew');
  const btnSend = qs('btnSend');
  const btnRefresh = qs('btnRefresh');
  const msg = qs('msg');
  const newNumber = qs('newNumber');

  if (btnNew) btnNew.onclick = createConversation;
  if (btnSend) btnSend.onclick = sendMessage;
  if (btnRefresh) btnRefresh.onclick = loadConversations;

  if (msg) {
    msg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  if (newNumber) {
    newNumber.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createConversation();
    });
  }

  await loadConversations();
  startPolling();
});