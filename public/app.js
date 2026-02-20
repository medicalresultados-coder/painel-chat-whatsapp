let selected=null;

function qs(id){return document.getElementById(id);}

function normalizePhone(v){
  v=String(v||'').split('@')[0];
  const d=v.replace(/\D/g,'');
  return d.startsWith('55')?d:'55'+d;
}

function fmt(t){
  return new Date(t).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}

async function loadConversations(){
  const list=await fetch('/api/conversations',{credentials:'same-origin'}).then(r=>r.json());
  const box=qs('convoList');
  box.innerHTML='';

  list.forEach(c=>{
    const wa=normalizePhone(c.waId);
    const row=document.createElement('div');
    row.className='p-4 border-b cursor-pointer hover:bg-gray-100';
    row.innerHTML=`<div><strong>${c.name||wa}</strong></div>
                   <div class="text-xs text-gray-500">${c.last?.text||''}</div>`;
    row.onclick=()=>selectConversation(wa,c.name||wa);
    box.appendChild(row);
  });
}

async function loadMessages(){
  if(!selected) return;
  const msgs=await fetch('/api/messages/'+selected,{credentials:'same-origin'}).then(r=>r.json());
  const box=qs('messages');
  box.innerHTML='';

  msgs.forEach(m=>{
    const div=document.createElement('div');
    div.className=`flex mb-2 ${m.direction==='out'?'justify-end':'justify-start'}`;
    div.innerHTML=`
      <div class="px-3 py-2 rounded-lg ${m.direction==='out'?'bg-emerald-200':'bg-white'}">
        ${m.text}
        <div class="text-[10px] text-gray-500 text-right">
          ${fmt(m.at)} ${m.direction==='out'?(m.status==='read'?'✓✓':'✓'):''}
        </div>
      </div>
    `;
    box.appendChild(div);
  });

  box.scrollTop=box.scrollHeight;
}

async function selectConversation(wa,name){
  selected=normalizePhone(wa);
  qs('chatTitle').innerText=name;
  qs('chatSubtitle').innerText=selected;
  qs('btnSend').disabled=false;
  await loadMessages();
}

async function sendMessage(){
  if(!selected) return;
  const input=qs('msg');
  const text=input.value.trim();
  if(!text) return;

  const resp=await fetch('/api/send',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'same-origin',
    body:JSON.stringify({waId:selected,text})
  }).then(r=>r.json());

  input.value='';
  if(resp.usedTemplate){
    alert("Mensagem enviada como TEMPLATE (fora da janela 24h).");
  }

  await loadMessages();
  await loadConversations();
}

async function createConversation(){
  const n=normalizePhone(qs('newNumber').value);
  await fetch('/api/conversations',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'same-origin',
    body:JSON.stringify({waId:n})
  });
  await loadConversations();
  await selectConversation(n,n);
}

document.addEventListener('DOMContentLoaded',async()=>{
  qs('btnSend').onclick=sendMessage;
  qs('btnNew').onclick=createConversation;
  qs('btnRefresh').onclick=loadConversations;

  qs('msg').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      sendMessage();
    }
  });

  await loadConversations();
  setInterval(loadConversations,3000);
});