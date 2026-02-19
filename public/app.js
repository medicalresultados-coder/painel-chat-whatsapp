// UI_VERSION: 2026-02-19-ADD-NUMBER
let selected = null;
let selectedName = '';
let searchTerm = '';
let lastSig = '';
let timer = null;

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
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ts) {
  return new Date(ts).toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'2-digit', year:'numeric' });
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    credentials: 'same-origin'  // <-- ADICIONE ISSO
  });

  let data = null;
  try { data = await res.json(); } catch {}

  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

function renderTicks(status) {
  if (!status) return '';
  if (status === 'sent') return '<span class="text-[11px] text-[#667781]">✓</span>';
  if (status === 'delivered') return '<span class="text-[11px] text-[#667781]">✓✓</span>';
  if (status === 'read') return '<span class="text-[11px] text-sky-600">✓✓</span>';
  if (status === 'failed') return '<span class="text-[11px] text-red-600 font-bold">!</span>';
  return '';
}

function convoHTML(c) {
  const lastText = c.last?.text || '—';
  const time = c.lastMessageAt ? fmtTime(c.lastMessageAt) : '';
  const isActive = selected === c.waId;

  return `
    <button data-id="${c.waId}"
      class="w-full text-left px-3 py-3 border-b hover:bg-[#f5f6f6] ${isActive ? 'bg-[#f0f2f5]' : 'bg-white'}">
      <div class="flex items-center gap-3">
        <div class="h-12 w-12 rounded-full bg-slate-200 flex items-center justify-center font-semibold text-slate-600">
          ${escapeHtml(initials(c.name || c.waId))}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between">
            <div class="font-semibold text-[#111b21] truncate">${escapeHtml(c.name || c.waId)}</div>
            <div class="text-xs text-[#667781]">${time}</div>
          </div>
          <div class="text-sm text-[#667781] truncate">${escapeHtml(lastText)}</div>
          <div class="text-[11px] text-[#94a3b8] truncate">${escapeHtml(c.waId)}</div>
        </div>
      </div>
    </button>
  `;
}

function sig(messages) {
  return (messages || []).map(m => `${m.direction}|${m.at}|${m.status||''}|${m.text}`).join('::');
}

function renderMessages(messages) {
  const root = document.getElementById('messages');
  root.innerHTML = '';

  let lastDay = '';

  for (const m of messages) {
    const out = m.direction === 'out';
    const bubble = out ? 'bg-[#d9fdd3]' : 'bg-white';
    const align = out ? 'justify-end' : 'justify-start';
    const time = fmtTime(m.at);

    const day = new Date(m.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      root.insertAdjacentHTML('beforeend', `
        <div class="flex justify-center my-4">
          <div class="text-[11px] px-3 py-1 rounded-full bg-[#e1f0f7] text-[#667781] shadow-sm">
            ${escapeHtml(fmtDay(m.at))}
          </div>
        </div>
      `);
    }

    const ticks = out ? renderTicks(m.status) : '';

    root.insertAdjacentHTML('beforeend', `
      <div class="flex ${align} mb-2">
        <div class="max-w-[72%] ${bubble} rounded-2xl px-4 py-2 shadow-sm">
          <div class="whitespace-pre-wrap text-[#111b21] text-sm">${escapeHtml(m.text)}</div>
          <div class="mt-1 flex items-center justify-end gap-2">
            <span class="text-[11px] text-[#667781]">${time}</span>
            ${ticks}
          </div>
        </div>
      </div>
    `);
  }

  const wrap = document.getElementById('messagesWrap');
  wrap.scrollTop = wrap.scrollHeight;
}

async function loadConversations() {
  const list = await fetchJSON('/api/conversations');

  const filtered = list.filter(c => {
    if (!searchTerm) return true;
    const hay = `${c.name||''} ${c.waId||''} ${(c.last?.text||'')}`.toLowerCase();
    return hay.includes(searchTerm);
  });

  const root = document.getElementById('convoList');
  root.innerHTML = filtered.map(convoHTML).join('');

  root.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const convo = filtered.find(x => x.waId === id);
      await selectConversation(id, convo?.name || id);
    });
  });
}

async function loadMessages() {
  if (!selected) return;
  const msgs = await fetchJSON(`/api/messages/${selected}`);
  const s = sig(msgs);
  if (s === lastSig) return;
  lastSig = s;
  renderMessages(msgs);
}

async function selectConversation(waId, name) {
  selected = waId;
  selectedName = name || waId;

  const title = document.getElementById('chatTitle');
  const sub = document.getElementById('chatSubtitle');
  const av = document.getElementById('avatar');
  const sendBtn = document.getElementById('btnSend');

  if (title) title.innerText = selectedName;
  if (sub) sub.innerText = waId;
  if (av) av.innerText = initials(selectedName);
  if (sendBtn) sendBtn.disabled = false;

  lastSig = '';
  await loadMessages();
  await loadConversations();
}

async function createConversation() {
  const n = document.getElementById('newNumber');
  const waIdRaw = (n?.value || '').trim();
  if (!waIdRaw) return alert('Digite um número');

  try {
    const resp = await fetchJSON('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: waIdRaw, name: '' })
    });

    if (n) n.value = '';
    await loadConversations();
    await selectConversation(resp.waId, resp.waId);
  } catch (e) {
    alert('Falha ao adicionar número: ' + (e.message || e));
  }
}

async function sendMessage() {
  const input = document.getElementById('msg');
  const text = (input?.value || '').trim();
  if (!selected) return alert('Selecione uma conversa');
  if (!text) return;

  if (input) input.value = '';

  try {
    await fetchJSON('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: selected, text })
    });

    lastSig = '';
    await loadMessages();
    await loadConversations();
  } catch (e) {
    alert('Falha ao enviar: ' + (e.message || e));
  }
}

// ===== BINDINGS =====
document.getElementById('btnNew')?.addEventListener('click', createConversation);
document.getElementById('newNumber')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createConversation();
});

document.getElementById('btnSend')?.addEventListener('click', sendMessage);
document.getElementById('msg')?.addEventListener('keydown', (e) => {
  // Enter envia, Shift+Enter quebra linha (se você trocar input por textarea no futuro)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('btnRefresh')?.addEventListener('click', async () => {
  lastSig = '';
  await loadConversations();
  if (selected) await loadMessages();
});

document.getElementById('search')?.addEventListener('input', (e) => {
  searchTerm = (e.target.value || '').toLowerCase();
  loadConversations();
});

// Start
loadConversations().then(() => {
  timer = setInterval(async () => {
    try {
      await loadConversations();
      if (selected) await loadMessages();
    } catch {}
  }, 2000);
});
