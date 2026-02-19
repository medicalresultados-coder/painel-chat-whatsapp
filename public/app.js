let selected = null;
let selectedName = '';
let searchTerm = '';
let lastRenderSignature = '';
let autoRefreshTimer = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

function initials(nameOrNumber) {
  const s = String(nameOrNumber || '').trim();
  if (!s) return '—';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateDivider(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day:'2-digit', month:'2-digit', year:'numeric' });
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Erro');
  return data;
}

function convoItemHTML(c) {
  const lastText = c.last?.text || '—';
  const time = c.lastMessageAt ? fmtTime(c.lastMessageAt) : '';
  const isActive = selected === c.waId;

  // Unread “fake” (opcional): se quiser real, precisamos salvar status/no-lidas no DB.
  const unreadBadge = '';

  return `
    <button data-id="${c.waId}"
      class="w-full text-left px-4 py-3 border-b hover:bg-slate-50 ${isActive ? 'bg-slate-100' : 'bg-white'}">
      <div class="flex items-center gap-3">
        <div class="h-11 w-11 rounded-full bg-slate-200 flex items-center justify-center font-semibold text-slate-600">
          ${escapeHtml(initials(c.name || c.waId))}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-3">
            <div class="font-semibold text-slate-800 truncate">${escapeHtml(c.name || c.waId)}</div>
            <div class="text-xs text-slate-500 shrink-0">${time}</div>
          </div>
          <div class="flex items-center justify-between gap-3 mt-0.5">
            <div class="text-sm text-slate-600 truncate">${escapeHtml(lastText)}</div>
            ${unreadBadge}
          </div>
          <div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(c.waId)}</div>
        </div>
      </div>
    </button>
  `;
}

async function loadConversations() {
  const list = await fetchJSON('/api/conversations');

  const filtered = list.filter(c => {
    if (!searchTerm) return true;
    const hay = `${c.name||''} ${c.waId||''} ${(c.last?.text||'')}`.toLowerCase();
    return hay.includes(searchTerm);
  });

  const root = document.getElementById('convoList');
  root.innerHTML = filtered.map(convoItemHTML).join('');

  root.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const convo = filtered.find(x => x.waId === id);
      await selectConversation(id, convo?.name || id);
    });
  });

  return filtered;
}

function shouldRenderSame(messages) {
  // Evita redesenhar tudo se não mudou
  const sig = (messages || []).map(m => `${m.direction}|${m.at}|${m.text}`).join('::');
  if (sig === lastRenderSignature) return true;
  lastRenderSignature = sig;
  return false;
}

function renderMessages(messages) {
  const root = document.getElementById('messages');
  root.innerHTML = '';

  let lastDay = '';
  messages.forEach(m => {
    const out = m.direction === 'out';
    const bubble = out ? 'bg-[#d9fdd3]' : 'bg-white';
    const align = out ? 'justify-end' : 'justify-start';
    const time = fmtTime(m.at);

    // Divider por dia (estilo WhatsApp)
    const day = new Date(m.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      root.insertAdjacentHTML('beforeend', `
        <div class="flex justify-center my-4">
          <div class="text-[11px] px-3 py-1 rounded-full bg-[#e1f0f7] text-slate-600 shadow-sm">
            ${escapeHtml(fmtDateDivider(m.at))}
          </div>
        </div>
      `);
    }

    // “ticks” visual (status real exige webhook message_status + DB)
    const ticks = out ? '<span class="text-[11px] text-slate-500">✓✓</span>' : '';

    root.insertAdjacentHTML('beforeend', `
      <div class="flex ${align} mb-2">
        <div class="max-w-[70%] ${bubble} rounded-2xl px-4 py-2 shadow-sm">
          <div class="whitespace-pre-wrap text-slate-800">${escapeHtml(m.text)}</div>
          <div class="mt-1 flex items-center justify-end gap-2">
            <span class="text-[11px] text-slate-500">${time}</span>
            ${ticks}
          </div>
        </div>
      </div>
    `);
  });

  // scroll bottom
  const wrap = document.getElementById('messagesWrap');
  wrap.scrollTop = wrap.scrollHeight;
}

async function loadMessages() {
  if (!selected) return;
  const msgs = await fetchJSON(`/api/messages/${selected}`);
  if (shouldRenderSame(msgs)) return;
  renderMessages(msgs);
}

async function selectConversation(waId, name) {
  selected = waId;
  selectedName = name || waId;

  document.getElementById('chatTitle').innerText = selectedName;
  document.getElementById('chatSubtitle').innerText = waId;
  document.getElementById('avatar').innerText = initials(selectedName);
  document.getElementById('btnSend').disabled = false;

  // reset render signature to force first render
  lastRenderSignature = '';
  await loadMessages();
  await loadConversations();
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
    // force rerender
    lastRenderSignature = '';
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

  try {
    const resp = await fetchJSON('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId, name: '' })
    });
    n.value = '';
    await loadConversations();
    await selectConversation(resp.waId, resp.waId);
  } catch (e) {
    alert('Falha ao criar conversa: ' + (e.message || e));
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    try {
      await loadConversations();
      if (selected) await loadMessages();
    } catch {
      // silêncio
    }
  }, 2500);
}

// Bind UI
document.getElementById('btnSend').addEventListener('click', sendMessage);

// Enter envia (Shift+Enter quebra)
document.getElementById('msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('btnNew').addEventListener('click', createConversation);

document.getElementById('btnRefresh').addEventListener('click', async () => {
  lastRenderSignature = '';
  await loadConversations();
  if (selected) await loadMessages();
});

document.getElementById('search').addEventListener('input', (e) => {
  searchTerm = (e.target.value || '').toLowerCase();
  loadConversations();
});

loadConversations().then(startAutoRefresh);
