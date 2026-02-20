// UI_VERSION: 2026-02-20-FIX-INBOUND-RENDER-BY-WAID

var selected = null;         // waId normalizado
var selectedName = '';
var searchTerm = '';
var timer = null;

// assinatura para evitar reload desnecessário
var lastConvSig = '';
var lastMsgSig = '';

function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  s = String(s == null ? '' : s);
  return s.replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

// normaliza sempre para 55DDDNÚMERO
function normalizePhoneBR(input) {
  var raw = String(input || '').trim();
  if (!raw) return '';
  // remove sufixo tipo @c.us / @s.whatsapp.net
  raw = raw.split('@')[0];
  var d = digitsOnly(raw);
  if (!d) return '';
  if (d.startsWith('55')) return d;
  return '55' + d;
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

function convSignature(list) {
  if (!Array.isArray(list)) return '';
  var sig = '';
  for (var i = 0; i < list.length; i++) {
    var c = list[i] || {};
    sig += (c.waId || '') + '|' + (c.lastMessageAt || '') + ';';
  }
  return sig;
}

function msgSignature(msgs) {
  if (!Array.isArray(msgs)) return '';
  // usa último item pra detectar mudança sem custo alto
  var last = msgs.length ? (msgs[msgs.length - 1] || {}) : {};
  return String(msgs.length) + '|' + (last.at || '') + '|' + (last.text || '') + '|' + (last.direction || '') + '|' + (last.status || '');
}

function renderConversations(list) {
  var box = qs('list');
  if (!box) return;
  if (!Array.isArray(list)) list = [];

  // se selected existir, tenta “fixar” no waId canônico vindo do backend
  if (selected) {
    for (var k = 0; k < list.length; k++) {
      var w = normalizePhoneBR(list[k]?.waId);
      if (w && w === selected) {
        // ok
        break;
      }
    }
  }

  var html = '';
  for (var i = 0; i < list.length; i++) {
    var c = list[i] || {};
    var waId = normalizePhoneBR(c.waId || '');
    if (!waId) continue;

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
      var wa = normalizePhoneBR(this.getAttribute('data-wa'));
      var nm = this.getAttribute('data-name');
      selectConversation(wa, nm);
    });
  }
}

async function loadConversations() {
  var list = await fetchJSON('/api/conversations');
  var sig = convSignature(list);

  // só re-renderiza se mudou
  if (sig !== lastConvSig) {
    lastConvSig = sig;
    renderConversations(list);
  } else {
    // mesmo sem mudar, atualiza marcação active (caso selecionou agora)
    renderConversations(list);
  }
}

function tick(status) {
  if (status === 'read') return ' ✓✓';
  if (status === 'delivered') return ' ✓✓';
  if (status === 'failed') return ' !';
  return ' ✓';
}

function renderMessages(msgs) {
  var area = qs('msgs');
  if (!area) return;
  if (!Array.isArray(msgs)) msgs = [];

  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i] || {};
    var dir = (m.direction === 'out') ? 'out' : 'in';
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

async function loadMessages(force) {
  if (!selected) return;

  var url = '/api/messages/' + encodeURIComponent(selected);
  var msgs = await fetchJSON(url);
  if (!Array.isArray(msgs)) msgs = [];

  var sig = msgSignature(msgs);
  if (force || sig !== lastMsgSig) {
    lastMsgSig = sig;
    renderMessages(msgs);
  }
}

async function selectConversation(waId, name) {
  var wa = normalizePhoneBR(waId);
  if (!wa) return;

  selected = wa;
  selectedName = name || wa;

  var title = qs('chatTitle');
  var sub = qs('chatSub');
  var av = qs('chatAvatar');
  var sendBtn = qs('btnSend');

  if (title) title.innerText = selectedName;
  if (sub) sub.innerText = selected;
  if (av) av.innerText = initials(selectedName);
  if (sendBtn) sendBtn.disabled = false;

  await loadMessages(true);
  await loadConversations();
}

async function createConversation() {
  var n = qs('newNumber');
  var waIdRaw = (n && n.value ? n.value : '').trim();
  var wa = normalizePhoneBR(waIdRaw);

  if (!wa) { alert('Digite um número válido (com DDD).'); return; }

  try {
    var resp = await fetchJSON('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waId: wa, name: '' })
    });

    if (n) n.value = '';
    await loadConversations();
    await selectConversation(resp.waId || wa, resp.waId || wa);
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
    await loadMessages(true);
    await loadConversations();
  } catch (e) {
    var details = (e && e.data && e.data.details) ? JSON.stringify(e.data.details) : '';
    alert('Erro ao enviar: ' + (e.message || e) + (details ? '\n\n' + details : ''));
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(async function () {
    try {
      await loadConversations();
      if (selected) await loadMessages(false);
    } catch (e) {}
  }, 2500);
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
    if (selected) await loadMessages(true);
  });

  if (search) search.addEventListener('input', function (e) {
    searchTerm = (e.target.value || '').toLowerCase().trim();
    // não chama loadConversations async repetindo, só re-render com o que já tem
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