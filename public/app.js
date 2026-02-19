let selected = null;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Erro');
  return data;
}

async function loadConversations() {
  const list = await fetchJSON('/api/conversations');
  const root = document.getElementById('convoList');
  root.innerHTML = '';

  list.forEach(c => {
    const last = c.last?.text ? c.last.text : '—';
    const active = selected === c.waId ? 'bg-slate-100' : '';
    const item = el(`
      <button class="w-full text-left p-3 rounded-xl hover:bg-slate-100 ${active}">
        <div class="flex items-center justify-between">
          <div class="font-semibold truncate">${escapeHtml(c.name)}</div>
          <div class="text-xs text-slate-500">${c.lastMessageAt ? fmtTime(c.lastMessageAt) : ''}</div>
        </div>
        <div class="text-sm text-slate-600 truncate">${escapeHtml(last)}</div>
        <div class="text-xs text-slate-400">${c.waId}</div>
      </button>
    `);
    item.addEventListener('click', () => selectConversation(c.waId, c.name));
    root.appendChild(item);
  });
}

async function selectConversation(waId, name) {
  selected = waId;
  document.getElementById('chatTitle').innerText = name || waId;
  document.getElementById('chatSubtitle').innerText = waId;
  await loadMessages();
  await loadConversations();
}

async function loadMessages() {
  if (!selected) return;
  const msgs = await fetchJSON(`/api/messages/${selected}`);
  const root = document.getElementById('messages');
  root.innerHTML = '';

  msgs.forEach(m => {
    const align = m.direction === 'out' ? 'justify-end' : 'justify-start';
    const bubble = m.direction === 'out' ? 'bg-emerald-500 text-white' : 'bg-white border';
    root.appendChild(el(`
      <div class="flex ${align} mb-2">
        <div class="max-w-[70%] rounded-2xl px-4 py-3 ${bubble}">
          <div class="whitespace-pre-wrap">${escapeHtml(m.text || '')}</div>
          <div class="text-[11px] opacity-80 mt-1 text-right">${fmtTime(m.at)}</div>
        </div>
      </div>
    `));
  });

  root.scrollTop = root.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('msg');
  const text = input.value.trim();
  if (!selected) return alert('Selecione uma conversa');
  if (!text) return;

  input.value = '';

  try {
    await fetchJSON('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: selected, text })
    });

    await loadMessages();
    await loadConversations();
  } catch (e) {
    alert('Falha ao enviar: ' + (e.message || e));
  }
}


async function createConversation() {
  const n = document.getElementById('newNumber');
  const waId = n.value.trim();
  if (!waId) return;

  const resp = await fetchJSON('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waId, name: '' })
  });

  n.value = '';
  await loadConversations();
  await selectConversation(resp.waId, resp.waId);
}

// Atualização automática (tipo tempo real)
setInterval(async () => {
  await loadConversations();
  if (selected) await loadMessages();
}, 2500);

document.getElementById('btnSend').addEventListener('click', sendMessage);
document.getElementById('msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});
document.getElementById('btnNew').addEventListener('click', createConversation);

loadConversations();
