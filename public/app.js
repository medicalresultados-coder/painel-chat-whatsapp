// UI_VERSION: 2026-02-20-FIX-SYNTAX-POLLING

var selected = null;         // waId
var selectedName = '';
var searchTerm = '';
var lastSig = '';
var timer = null;

function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  s = String(s == null ? '' : s);
  return s.replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

function initials(nameOrNumber) {
  var s = String(nameOrNumber || '').trim();
  if (!s) return '—';
  var parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function fmtTime(ts) {
  try {
    var d = new Date(ts);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

async function fetchJSON(url, opts) {
  opts = opts || {};
  var res = await fetch(url, Object.assign({}, opts, { credentials: 'same-origin' }));
  var data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    var msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + res.status);
    var err = new Error(msg);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function renderConversations(list) {
  var box = qs('list');
  if (!box) return;

  if (!Array.isArray(list)) list = [];

  var html = '';
  for (var i = 0; i < list.length; i++) {
    var c = list[i] || {};
    var waId = c.waId || '';
    var name = c.name || waId || '—';
    var last = (c.last && c.last.text) ? c.last.text : '—';
    var t = c.lastMessageAt ? fmtTime(c.lastMessageAt) : '';

    // filtro
    var hay = (name + ' ' + waId + ' ' + last).toLowerCase();
    if (searchTerm && hay.indexOf(searchTerm) === -1) continue;

    var active = (selected === waId) ? 'active' : '';
    html += `
      <div class="row ${active}" data-wa="${escapeHtml(waId)}" data-name="${escapeHtml(name)}">
        <div class="avatar">${escapeHtml(initials(name))}</div>
        <div class="meta">
          <div class="top">
            <div class="name">${escapeHtml(name)}</div>
            <div class="time">${escapeHtml(t)}</div>
          </div>
          <div class="last">${escapeHtml(last).slice(0, 60)}</div>
          <div class="sub">${escapeHtml(waId)}</div>
        </div>
      </div>
    `;
  }

  box.innerHTML = html || `<div class="empty">Sem conversas</div>`;

  // click
  var rows = box.querySelectorAll('.row');
  for (var r = 0; r < rows.length; r++) {
    rows[r].addEventListener('click', function () {
      var wa = this.getAttribute('data-wa');
      var nm = this.getAttribute('data-name');
      selectConversation(wa, nm);
    });
  }
}

async function loadConversations() {
  var list = await fetchJSON('/api/conversations');
  renderConversations(list);

  // assinatura simples pra detectar mudanças
  var sig = '';
  if (Array.isArray(list)) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      sig += (c.waId || '') + '|' + (c.lastMessageAt || '') + ';';
    }
  }
  lastSig = sig;
}

async function loadMessages() {
  if (!selected) return;
  var msgs = await fetchJSON('/api/messages/' + encodeURIComponent(selected));
  if (!Array.isArray(msgs)) msgs = [];

  var area = qs('msgs');
  if (!area) return;

  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i] || {};
    var dir = m.direction === 'out' ? 'out' : 'in';
    var t = m.at ? fmtTime(m.at) : '';
    var text = m.text || '';

    html += `
      <div class="bubble ${dir}">
        <div class="text">${escapeHtml(text)}</div>
        <div class="meta">${escapeHtml(t)}${dir === 'out' ? tick(m.status) : ''}</div>
      </div>
    `;
  }

  area.innerHTML = html || `<div class="empty">Sem mensagens</div>`;
  area.scrollTop = area.scrollHeight;
}

function tick(status) {
  // sent / delivered / read / failed
  if (status === 'read') return ' ✓✓';
  if (status === 'delivered') return ' ✓✓';
  if (status === 'failed') return ' !';
  return ' ✓';
}

async function selectConversation(waId, name) {
  selected = waId;
  selectedName = name || waId;

  var title = qs('chatTitle');
  var sub = qs('chatSub');
  var av = qs('chatAvatar');
  var sendBtn = qs('btnSend');

  if (title) title.innerText = selectedName;
  if (sub) sub.innerText = waId;
  if (av) av.innerText = initials(selectedName);
  if (sendBtn) sendBtn.disabled = false;

  await loadMessages();
  await loadConversations();
}

async function createConversation() {
  var n = qs('newNumber');
  var waIdRaw = (n && n.value ? n.value : '').trim();
  if (!waIdRaw) { alert('Digite um número'); return; }

  try {
    var resp = await fetchJSON('/api/conversations', {
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
  if (!selected) return alert('Selecione uma conversa');
  var input = qs('msg');
  var text = (input && input.value ? input.value : '').trim();
  if (!text) return;

  try {
    await fetchJSON('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: selected, text: text })
    });

    if (input) input.value = '';
    await loadMessages();
    await loadConversations();
  } catch (e) {
    // mostra erro detalhado
    var details = (e && e.data && e.data.details) ? JSON.stringify(e.data.details) : '';
    alert('Erro ao enviar: ' + (e.message || e) + (details ? '\n\n' + details : ''));
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(async function () {
    try {
      await loadConversations();
      if (selected) await loadMessages();
    } catch (e) {}
  }, 3500);
}

function bindUI() {
  var btnNew = qs('btnNew');
  var btnSend = qs('btnSend');
  var btnRefresh = qs('btnRefresh');
  var search = qs('search');
  var newNumber = qs('newNumber');
  var msg = qs('msg');

  if (btnNew) btnNew.addEventListener('click', createConversation);
  if (btnSend) btnSend.addEventListener('click', sendMessage);
  if (btnRefresh) btnRefresh.addEventListener('click', async function () {
    await loadConversations();
    if (selected) await loadMessages();
  });

  if (search) search.addEventListener('input', function (e) {
    searchTerm = (e.target.value || '').toLowerCase().trim();
    loadConversations();
  });

  if (newNumber) newNumber.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') createConversation();
  });

  if (msg) msg.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

(async function boot() {
  try {
    bindUI();
    await loadConversations();
    startPolling();
  } catch (e) {
    alert('Falha ao iniciar UI: ' + (e.message || e));
  }
})();