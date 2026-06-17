'use strict';

const STORAGE_KEY   = 'garantijos_v1';
const AUTH_KEY      = 'garantijos_session';
const BRUTE_KEY     = 'garantijos_brute';
const WORKER_URL    = 'https://muddy-sea-0563.ignas7206.workers.dev';
const CORRECT_HASH  = 'b9cf4364491e63cac7f0668fd4df6457ba29575537bcae6be2c265d05bb926dc';
const CATEGORIES    = ['Elektronika', 'Buitinė technika', 'Avalynė / drabužiai', 'Baldai', 'Automobiliai', 'Kita'];
const DOC_TYPES     = ['Sąskaita-faktūra (SF)', 'Banko išrašas', 'Kvitas / čekis', 'Kita'];
const WARRANTY_OPTS = [
  {label:'6 mėnesiai',months:6},{label:'1 metai',months:12},
  {label:'2 metai',months:24},{label:'3 metai',months:36},
  {label:'5 metai',months:60},{label:'Kita data',months:null},
];
const ALLOWED_IMG   = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const MAX_IMG_BYTES = 4*1024*1024;   // 4MB
const MAX_PDF_BYTES = 5*1024*1024;   // 5MB
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 5*60*1000;

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  view:'list', addMode:null,
  items:[], selected:null,
  search:'', filterCat:'Visos', sortBy:'name',
  form:emptyForm(),
  docPreview:null,   // {type:'image'|'pdf', data:string, name:string}
  lightbox:null,     // base64 image url to show fullscreen
  analyzing:false, authenticated:false,
  pwdError:'', docError:'', showWarrantyPicker:false,
};

function emptyForm(){
  return {
    name:'', category:'Elektronika', shop:'',
    purchaseDate:today(), warrantyEnd:addMonths(today(),24), warrantyMonths:24,
    docType:'Kvitas / čekis', docNumber:'', notes:'',
    docData:null, docMime:null, docFileName:null,
  };
}
function today(){return new Date().toISOString().slice(0,10);}
function addMonths(d,m){if(!d)return '';const r=new Date(d);r.setMonth(r.getMonth()+m);return r.toISOString().slice(0,10);}

// ── SHA-256 / Auth ─────────────────────────────────────────────────────────
async function sha256(s){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function genToken(){const a=new Uint8Array(32);crypto.getRandomValues(a);return Array.from(a).map(x=>x.toString(16).padStart(2,'0')).join('');}
async function checkAuth(){
  const t=sessionStorage.getItem(AUTH_KEY),th=localStorage.getItem(AUTH_KEY+'_hash');
  if(t&&th&&await sha256(t)===th)state.authenticated=true;
}
async function createSession(){
  const t=genToken(),th=await sha256(t);
  sessionStorage.setItem(AUTH_KEY,t);localStorage.setItem(AUTH_KEY+'_hash',th);
  state.authenticated=true;state.pwdError='';render();
}
function logout(){sessionStorage.removeItem(AUTH_KEY);localStorage.removeItem(AUTH_KEY+'_hash');state.authenticated=false;render();}

// ── Brute-force ────────────────────────────────────────────────────────────
function getBrute(){try{return JSON.parse(localStorage.getItem(BRUTE_KEY))||{attempts:0,lockedUntil:0};}catch{return{attempts:0,lockedUntil:0};}}
function setBrute(b){localStorage.setItem(BRUTE_KEY,JSON.stringify(b));}
function resetBrute(){localStorage.removeItem(BRUTE_KEY);}
function bruteStatus(){const b=getBrute(),now=Date.now();if(b.lockedUntil>now)return{locked:true,secs:Math.ceil((b.lockedUntil-now)/1000)};return{locked:false,attempts:b.attempts};}
async function tryLogin(pw){
  const bs=bruteStatus();
  if(bs.locked){state.pwdError=`Per daug bandymų. Palaukite ${bs.secs}s.`;render();return;}
  if(!pw){state.pwdError='Įveskite slaptažodį';render();return;}
  const h=await sha256(pw);
  if(h===CORRECT_HASH){resetBrute();await createSession();}
  else{
    const b=getBrute();b.attempts=(b.attempts||0)+1;
    if(b.attempts>=MAX_ATTEMPTS){b.lockedUntil=Date.now()+LOCKOUT_MS;b.attempts=0;state.pwdError='Per daug bandymų. Užblokuota 5 minutėms.';}
    else state.pwdError=`Neteisingas slaptažodis (${b.attempts}/${MAX_ATTEMPTS})`;
    setBrute(b);render();
  }
}

// ── Persist ────────────────────────────────────────────────────────────────
function load(){try{state.items=JSON.parse(localStorage.getItem(STORAGE_KEY))||[];}catch{state.items=[];}}
function persist(){
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state.items));}
  catch(e){if(e.name==='QuotaExceededError')alert('Vieta telefone baigiasi! Ištrinkite kai kuriuos dokumentus.');}
}

// ── Helpers ────────────────────────────────────────────────────────────────
function daysLeft(d){if(!d)return null;return Math.ceil((new Date(d)-new Date())/86400000);}
function fmtDate(d){if(!d)return '—';return new Date(d).toLocaleDateString('lt-LT');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function safeId(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function badgeHtml(days){
  if(days===null)return '';
  if(days<0)return`<span class="badge badge-exp">Baigėsi</span>`;
  if(days<=30)return`<span class="badge badge-warn">${days}d. liko</span>`;
  return`<span class="badge badge-ok">${days}d. liko</span>`;
}
function fmtSize(bytes){if(bytes<1024)return bytes+'B';if(bytes<1024*1024)return(bytes/1024).toFixed(0)+'KB';return(bytes/1024/1024).toFixed(1)+'MB';}

// ── Render ─────────────────────────────────────────────────────────────────
function render(){
  const root=document.getElementById('root');
  if(state.lightbox){root.innerHTML=renderLightbox();attachLightboxEvents();return;}
  if(!state.authenticated){root.innerHTML=renderLogin();attachLoginEvents();return;}
  if(state.view==='list')root.innerHTML=renderList();
  else if(state.view==='add'&&!state.addMode)root.innerHTML=renderAddPicker();
  else if(state.view==='add')root.innerHTML=renderAdd();
  else if(state.view==='detail')root.innerHTML=renderDetail();
  attachEvents();
}

// ── Lightbox ───────────────────────────────────────────────────────────────
function renderLightbox(){
  return`<div id="lightboxOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:1000;display:flex;flex-direction:column">
    <div style="display:flex;justify-content:flex-end;padding:12px 16px;flex-shrink:0">
      <button id="lightboxClose" style="background:rgba(255,255,255,0.15);border:none;border-radius:50%;width:36px;height:36px;color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center">
        <i class="ti ti-x"></i>
      </button>
    </div>
    <div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:0 8px 16px">
      <img src="${esc(state.lightbox)}" style="max-width:100%;max-height:100%;border-radius:8px;object-fit:contain" />
    </div>
  </div>`;
}
function attachLightboxEvents(){
  const el=document.getElementById('lightboxClose');
  if(el)el.addEventListener('click',()=>{state.lightbox=null;render();});
  document.getElementById('lightboxOverlay')?.addEventListener('click',e=>{if(e.target.id==='lightboxOverlay'){state.lightbox=null;render();}});
}

// ── Login ──────────────────────────────────────────────────────────────────
function renderLogin(){
  const bs=bruteStatus();
  return`<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
    <div style="width:100%;max-width:320px">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:48px;margin-bottom:12px">🛡️</div>
        <h1 style="font-size:22px;font-weight:600;color:var(--text);margin-bottom:6px">Garantijos</h1>
        <p style="font-size:14px;color:var(--text2)">Įveskite slaptažodį</p>
      </div>
      <div style="background:var(--bg);border:0.5px solid var(--border);border-radius:16px;padding:24px">
        <input type="password" id="pwdInput" placeholder="Slaptažodis" autofocus ${bs.locked?'disabled':''}
          style="width:100%;box-sizing:border-box;border-radius:10px;border:0.5px solid ${state.pwdError?'var(--red)':'var(--border2)'};background:var(--bg2);font-size:16px;padding:12px;color:var(--text);margin-bottom:${state.pwdError?'8px':'12px'}" />
        ${state.pwdError?`<p style="font-size:13px;color:var(--red);margin-bottom:12px;text-align:center">${esc(state.pwdError)}</p>`:''}
        <button id="loginBtn" ${bs.locked?'disabled':''} style="width:100%;background:var(--text);color:var(--bg);border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:500;cursor:${bs.locked?'not-allowed':'pointer'};opacity:${bs.locked?'0.5':'1'}">Prisijungti</button>
      </div>
    </div>
  </div>`;
}
function attachLoginEvents(){
  const btn=document.getElementById('loginBtn'),inp=document.getElementById('pwdInput');
  if(btn)btn.addEventListener('click',()=>tryLogin(inp?.value||''));
  if(inp)inp.addEventListener('keydown',e=>{if(e.key==='Enter')tryLogin(inp.value);});
}

// ── List ───────────────────────────────────────────────────────────────────
function renderList(){
  const{items,search,filterCat,sortBy}=state;
  const expired=items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d<0;}).length;
  const expiring=items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d>=0&&d<=30;}).length;
  const valid=items.length-expired;

  const filtered=items
    .filter(i=>{const q=search.toLowerCase();return i.name.toLowerCase().includes(q)||(i.shop||'').toLowerCase().includes(q)||(i.docNumber||'').toLowerCase().includes(q)||(i.notes||'').toLowerCase().includes(q);})
    .filter(i=>filterCat==='Visos'||i.category===filterCat)
    .sort((a,b)=>{
      if(sortBy==='name')return a.name.localeCompare(b.name,'lt');
      if(sortBy==='expiring'){const da=daysLeft(a.warrantyEnd)??99999,db=daysLeft(b.warrantyEnd)??99999;return da-db;}
      if(sortBy==='newest')return b.id-a.id;
      return 0;
    });

  const statsHtml=items.length>0?`<div class="stats">
    <div class="stat-card" style="background:var(--green-bg)"><div class="num" style="color:var(--green)">${valid}</div><div class="lbl" style="color:var(--green)">Galioja</div></div>
    <div class="stat-card" style="background:var(--orange-bg)"><div class="num" style="color:var(--orange)">${expiring}</div><div class="lbl" style="color:var(--orange)">Baigiasi</div></div>
    <div class="stat-card" style="background:var(--red-bg)"><div class="num" style="color:var(--red)">${expired}</div><div class="lbl" style="color:var(--red)">Baigėsi</div></div>
  </div>`:'';

  const filtersHtml=['Visos',...CATEGORIES].map(c=>`<button class="filter-chip${filterCat===c?' active':''}" data-filter="${esc(c)}">${esc(c)}</button>`).join('');
  const sortHtml=items.length>1?`<div class="sort-row"><span>Rikiuoti:</span>
    <button class="sort-chip${sortBy==='name'?' active':''}" data-sort="name">A–Z</button>
    <button class="sort-chip${sortBy==='expiring'?' active':''}" data-sort="expiring">Baigiasi greičiau</button>
    <button class="sort-chip${sortBy==='newest'?' active':''}" data-sort="newest">Naujausi</button>
  </div>`:'';

  const cardsHtml=filtered.map(item=>{
    const days=daysLeft(item.warrantyEnd);
    let thumb;
    if(item.docData&&item.docMime==='application/pdf')
      thumb=`<div class="item-icon" style="background:var(--red-bg)"><i class="ti ti-file-type-pdf" style="font-size:22px;color:var(--red)"></i></div>`;
    else if(item.docData)
      thumb=`<img class="item-thumb" src="${esc(item.docData)}" alt="" loading="lazy" />`;
    else
      thumb=`<div class="item-icon"><i class="ti ti-receipt"></i></div>`;

    return`<div class="item-card" data-id="${esc(String(item.id))}">
      ${thumb}
      <div class="item-info">
        <div class="item-top"><span class="item-name">${esc(item.name)}</span>${badgeHtml(days)}</div>
        <div class="item-meta">${esc(item.shop||'')}${item.shop?' · ':''}${esc(item.category)}</div>
        ${item.docNumber?`<div class="item-meta" style="margin-top:2px"><i class="ti ti-hash" style="font-size:11px;margin-right:3px;vertical-align:-1px"></i>${esc(item.docNumber)}</div>`:''}
        ${item.warrantyEnd?`<div class="item-date"><i class="ti ti-calendar" style="font-size:12px;margin-right:4px;vertical-align:-1px"></i>Iki ${fmtDate(item.warrantyEnd)}</div>`:''}
      </div>
    </div>`;
  }).join('');

  return`<div class="view">
    <div class="header">
      <div class="header-row">
        <div><h1>Mano garantijos</h1><div class="subtitle">${items.length} vnt. išsaugota</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="logoutBtn" title="Atsijungti" style="background:none;border:0.5px solid var(--border2);border-radius:8px;padding:7px 9px;cursor:pointer;color:var(--text2)"><i class="ti ti-logout" style="font-size:16px"></i></button>
          <button class="btn-primary" id="addBtn"><i class="ti ti-plus"></i> Pridėti</button>
        </div>
      </div>
      ${statsHtml}
      <div class="search-wrap"><i class="ti ti-search"></i><input type="search" id="searchInput" placeholder="Ieškoti pagal pavadinimą, dok. nr..." value="${esc(search)}" /></div>
      <div class="filter-row">${filtersHtml}</div>
    </div>
    ${sortHtml}
    <div class="item-list">
      ${items.length===0?`<div class="empty"><i class="ti ti-shield-check"></i><h3>Dar nėra garantijų</h3><p>Pridėkite pirmą daiktą</p><button class="btn-primary" id="addFirst"><i class="ti ti-plus"></i> Pridėti daiktą</button></div>`:''}
      ${cardsHtml}
      ${filtered.length===0&&items.length>0?'<p style="text-align:center;color:var(--text2);font-size:14px;margin-top:40px">Nieko nerasta.</p>':''}
    </div>
  </div>`;
}

// ── Add picker ─────────────────────────────────────────────────────────────
function renderAddPicker(){
  return`<div class="view">
    <div class="header" style="display:flex;align-items:center;gap:10px;padding:16px;">
      <button class="btn-back" id="backBtn"><i class="ti ti-arrow-left" style="font-size:20px"></i></button>
      <h1 style="font-size:17px">Pridėti garantiją</h1>
    </div>
    <div style="padding:24px 16px;display:flex;flex-direction:column;gap:12px">
      <button id="modePhoto" style="background:var(--bg);border:0.5px solid var(--border);border-radius:14px;padding:20px;cursor:pointer;display:flex;align-items:center;gap:14px;text-align:left">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--blue-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-camera" style="font-size:22px;color:var(--blue)"></i>
        </div>
        <div>
          <div style="font-size:15px;font-weight:500;color:var(--text);margin-bottom:3px">Su dokumentu + AI</div>
          <div style="font-size:13px;color:var(--text2)">Nufotografuok arba įkelk PDF – AI ištrauks informaciją automatiškai</div>
        </div>
      </button>
      <button id="modeManual" style="background:var(--bg);border:0.5px solid var(--border);border-radius:14px;padding:20px;cursor:pointer;display:flex;align-items:center;gap:14px;text-align:left">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--green-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <i class="ti ti-pencil" style="font-size:22px;color:var(--green)"></i>
        </div>
        <div>
          <div style="font-size:15px;font-weight:500;color:var(--text);margin-bottom:3px">Rankiniu būdu</div>
          <div style="font-size:13px;color:var(--text2)">Įvesk pats – galima ir dokumentą prisegti vėliau</div>
        </div>
      </button>
    </div>
  </div>`;
}

// ── Add form ───────────────────────────────────────────────────────────────
function renderAdd(){
  const f=state.form;
  const isPhoto=state.addMode==='photo';

  // Document upload section – shown in both modes
  const hasDoc=!!f.docData;
  const isPdf=f.docMime==='application/pdf';
  let docPreviewHtml='';
  if(hasDoc&&isPdf){
    docPreviewHtml=`<div style="background:var(--red-bg);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;margin-top:8px">
      <i class="ti ti-file-type-pdf" style="font-size:24px;color:var(--red);flex-shrink:0"></i>
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;color:var(--red);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.docFileName||'dokumentas.pdf')}</div></div>
      <button id="removeDoc" style="background:none;border:none;cursor:pointer;color:var(--red);padding:4px"><i class="ti ti-x" style="font-size:16px"></i></button>
    </div>`;
  }else if(hasDoc){
    docPreviewHtml=`<div style="position:relative;margin-top:8px">
      <img id="docThumb" src="${esc(f.docData)}" alt="Dokumentas" style="width:100%;border-radius:10px;max-height:160px;object-fit:cover;cursor:pointer" />
      <button id="removeDoc" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.6);border:none;border-radius:50%;width:28px;height:28px;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center"><i class="ti ti-x" style="font-size:14px"></i></button>
    </div>`;
  }

  const docSection=`<div class="field">
    <label>${isPhoto?'Dokumento nuotrauka arba PDF':'Dokumentas (neprivaloma)'}</label>
    ${!hasDoc?`<label class="img-upload">
      ${isPhoto
        ?`<div class="img-upload-placeholder"><i class="ti ti-camera"></i><p>Fotografuoti arba įkelti</p><small>JPG, PNG, PDF – SF, banko išrašas, kvitas...</small></div>`
        :`<div class="img-upload-placeholder"><i class="ti ti-paperclip"></i><p>Prisegti dokumentą</p><small>JPG, PNG, PDF</small></div>`}
      <input type="file" id="docInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" capture="${isPhoto?'environment':''}" style="display:none" />
    </label>`:''}
    ${docPreviewHtml}
    ${state.docError?`<p style="font-size:12px;color:var(--red);margin-top:6px">${esc(state.docError)}</p>`:''}
    ${state.analyzing?`<div class="analyzing"><div class="spinner"></div><span style="font-size:13px;color:var(--text2)">AI analizuoja dokumentą...</span></div>`:''}
  </div>`;

  // Warranty selector
  const selOpt=WARRANTY_OPTS.find(o=>o.months===f.warrantyMonths)||WARRANTY_OPTS[WARRANTY_OPTS.length-1];
  const warrantySection=`<div class="field">
    <label>Garantijos trukmė</label>
    <div style="position:relative">
      <button type="button" id="warrantyBtn" style="width:100%;box-sizing:border-box;border-radius:10px;border:0.5px solid var(--border2);background:var(--bg2);font-size:14px;padding:10px 12px;color:var(--text);display:flex;justify-content:space-between;align-items:center;cursor:pointer">
        <span>${esc(selOpt.label)}</span><i class="ti ti-chevron-down" style="font-size:16px;color:var(--text2)"></i>
      </button>
      ${state.showWarrantyPicker?`<div style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg);border:0.5px solid var(--border2);border-radius:10px;z-index:10;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.12)">
        ${WARRANTY_OPTS.map(o=>`<button type="button" class="warranty-opt" data-months="${o.months??'custom'}" style="width:100%;padding:11px 14px;font-size:14px;color:${f.warrantyMonths===o.months?'var(--blue)':'var(--text)'};background:${f.warrantyMonths===o.months?'var(--blue-bg)':'transparent'};border:none;border-bottom:0.5px solid var(--border);cursor:pointer;text-align:left;font-weight:${f.warrantyMonths===o.months?'500':'400'}">${esc(o.label)}</button>`).join('')}
      </div>`:''}
    </div>
    ${f.warrantyMonths===null?`<div style="margin-top:8px"><input type="date" id="f_warrantyEnd" value="${esc(f.warrantyEnd)}" style="width:100%;box-sizing:border-box;border-radius:10px;border:0.5px solid var(--border2);background:var(--bg2);font-size:14px;padding:10px 12px;color:var(--text)" /></div>`:''}
  </div>`;

  const catOptions=CATEGORIES.map(c=>`<option${c===f.category?' selected':''}>${esc(c)}</option>`).join('');
  const docTypeOpts=DOC_TYPES.map(d=>`<option${d===f.docType?' selected':''}>${esc(d)}</option>`).join('');

  return`<div class="view">
    <div class="header" style="display:flex;align-items:center;gap:10px;padding:16px;">
      <button class="btn-back" id="backBtn"><i class="ti ti-arrow-left" style="font-size:20px"></i></button>
      <h1 style="font-size:17px">${isPhoto?'Su dokumentu':'Rankiniu būdu'}</h1>
    </div>
    <div class="form-wrap">
      ${docSection}
      <div class="field"><label>Pavadinimas *</label><input type="text" id="f_name" placeholder='pvz. Samsung TV 55"' value="${esc(f.name)}" autocomplete="off" /></div>
      <div class="field"><label>Parduotuvė</label><input type="text" id="f_shop" placeholder="pvz. Pigu.lt, Euronics..." value="${esc(f.shop)}" autocomplete="off" /></div>
      <div class="field"><label>Pirkimo data</label><input type="date" id="f_purchaseDate" value="${esc(f.purchaseDate)}" /></div>
      ${warrantySection}
      <div class="field"><label>Dokumento tipas</label><select id="f_docType">${docTypeOpts}</select></div>
      <div class="field">
        <label>Dokumento numeris <span style="font-size:11px;color:var(--text2)">(rekomenduojama)</span></label>
        <input type="text" id="f_docNumber" placeholder="pvz. SF-2025-001234" value="${esc(f.docNumber)}" autocomplete="off" />
      </div>
      <div class="field"><label>Kategorija</label><select id="f_category">${catOptions}</select></div>
      <div class="field"><label>Pastabos</label><textarea id="f_notes" rows="2" placeholder="Papildoma informacija...">${esc(f.notes)}</textarea></div>
      <button class="btn-save" id="saveBtn" ${f.name.trim()?'':'disabled'}>Išsaugoti</button>
    </div>
  </div>`;
}

// ── Detail ─────────────────────────────────────────────────────────────────
function renderDetail(){
  const item=state.items.find(i=>i.id===state.selected);
  if(!item){state.view='list';render();return '';}
  const days=daysLeft(item.warrantyEnd);

  let statusBg,statusColor,statusIcon,statusText;
  if(days===null){statusBg='var(--bg2)';statusColor='var(--text2)';statusIcon='ti-shield';statusText='Nenurodyta';}
  else if(days<0){statusBg='var(--red-bg)';statusColor='var(--red)';statusIcon='ti-shield-x';statusText='Garantija baigėsi';}
  else if(days<=30){statusBg='var(--orange-bg)';statusColor='var(--orange)';statusIcon='ti-shield-exclamation';statusText=`Liko ${days} dienos`;}
  else{statusBg='var(--green-bg)';statusColor='var(--green)';statusIcon='ti-shield-check';statusText=`Liko ${days} dienos`;}

  // Document section
  let docHtml='';
  if(item.docData&&item.docMime==='application/pdf'){
    // PDF – open in new tab
    const blob=b64toBlob(item.docData,'application/pdf');
    const url=URL.createObjectURL(blob);
    docHtml=`<a id="pdfLink" href="${url}" target="_blank" style="display:flex;align-items:center;gap:10px;background:var(--red-bg);border-radius:12px;padding:12px 14px;margin-bottom:16px;text-decoration:none">
      <i class="ti ti-file-type-pdf" style="font-size:28px;color:var(--red);flex-shrink:0"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;color:var(--red);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.docFileName||'dokumentas.pdf')}</div>
        <div style="font-size:11px;color:var(--red);margin-top:2px">Spustelkite norėdami peržiūrėti PDF</div>
      </div>
      <i class="ti ti-external-link" style="font-size:18px;color:var(--red);flex-shrink:0"></i>
    </a>`;
  }else if(item.docData){
    docHtml=`<img id="docImg" src="${esc(item.docData)}" alt="Dokumentas" style="width:100%;border-radius:12px;max-height:200px;object-fit:cover;margin-bottom:16px;cursor:pointer" title="Spustelkite norėdami padidinti" />`;
  }

  const rows=[
    {icon:'ti-tag',label:'Pavadinimas',val:item.name},
    {icon:'ti-building-store',label:'Parduotuvė',val:item.shop||'—'},
    {icon:'ti-category',label:'Kategorija',val:item.category},
    {icon:'ti-file-description',label:'Dokumento tipas',val:item.docType||'—'},
    {icon:'ti-hash',label:'Dokumento nr.',val:item.docNumber||'—'},
    {icon:'ti-calendar',label:'Pirkimo data',val:fmtDate(item.purchaseDate)},
    {icon:'ti-calendar-due',label:'Garantija iki',val:fmtDate(item.warrantyEnd)},
  ].map(r=>`<div class="detail-row"><i class="ti ${r.icon}"></i><span class="dl">${esc(r.label)}</span><span class="dv">${esc(r.val)}</span></div>`).join('');

  return`<div class="view">
    <div class="detail-header">
      <button class="btn-back" id="backBtn"><i class="ti ti-arrow-left" style="font-size:20px"></i></button>
      <h2>${esc(item.name)}</h2>
      <button class="btn-back" id="deleteBtn" style="color:var(--red)"><i class="ti ti-trash" style="font-size:20px"></i></button>
    </div>
    <div style="padding:16px">
      ${docHtml}
      <div class="status-card" style="background:${statusBg}">
        <div><div class="status-label" style="color:${statusColor}">Garantijos statusas</div><div class="status-val" style="color:${statusColor}">${statusText}</div></div>
        <i class="ti ${statusIcon}" style="font-size:32px;color:${statusColor}"></i>
      </div>
      <div class="detail-rows">${rows}</div>
      ${item.notes?`<div class="notes-box"><div class="notes-lbl">Pastabos</div><p>${esc(item.notes)}</p></div>`:''}
      <button class="btn-danger" id="deleteBtn2"><i class="ti ti-trash" style="margin-right:6px;vertical-align:-1px"></i>Ištrinti</button>
    </div>
  </div>`;
}

// ── b64 → Blob ─────────────────────────────────────────────────────────────
function b64toBlob(b64,mime){
  const bytes=atob(b64);const arr=new Uint8Array(bytes.length);
  for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);
  return new Blob([arr],{type:mime});
}

// ── Events ─────────────────────────────────────────────────────────────────
function attachEvents(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  const onAll=(sel,ev,fn)=>document.querySelectorAll(sel).forEach(el=>el.addEventListener(ev,fn));

  on('addBtn','click',()=>{state.form=emptyForm();state.docError='';state.addMode=null;state.view='add';render();});
  on('addFirst','click',()=>{state.form=emptyForm();state.docError='';state.addMode=null;state.view='add';render();});
  on('searchInput','input',e=>{state.search=e.target.value;render();});
  on('logoutBtn','click',()=>{if(confirm('Atsijungti?'))logout();});
  on('modePhoto','click',()=>{state.addMode='photo';render();});
  on('modeManual','click',()=>{state.addMode='manual';render();});

  on('backBtn','click',()=>{
    if(state.view==='add'&&state.addMode){state.addMode=null;render();}
    else{state.view='list';render();}
  });

  onAll('.filter-chip','click',e=>{state.filterCat=e.target.dataset.filter;render();});
  onAll('.sort-chip','click',e=>{state.sortBy=e.target.dataset.sort;render();});
  onAll('.item-card','click',e=>{const id=safeId(e.currentTarget.dataset.id);if(id===null)return;state.selected=id;state.view='detail';render();});

  // Warranty
  on('warrantyBtn','click',()=>{state.showWarrantyPicker=!state.showWarrantyPicker;render();});
  onAll('.warranty-opt','click',e=>{
    const val=e.currentTarget.dataset.months;
    if(val==='custom'){state.form.warrantyMonths=null;state.form.warrantyEnd='';}
    else{const m=parseInt(val);state.form.warrantyMonths=m;if(state.form.purchaseDate)state.form.warrantyEnd=addMonths(state.form.purchaseDate,m);}
    state.showWarrantyPicker=false;render();
  });
  on('f_warrantyEnd','change',e=>{state.form.warrantyEnd=e.target.value;});

  // Document
  on('docInput','change',handleDocUpload);
  on('removeDoc','click',()=>{state.form.docData=null;state.form.docMime=null;state.form.docFileName=null;state.docError='';render();});
  on('docThumb','click',()=>{if(state.form.docData)state.lightbox=state.form.docData;render();});
  on('docImg','click',()=>{const item=state.items.find(i=>i.id===state.selected);if(item?.docData)state.lightbox=item.docData;render();});

  // Form fields
  ['name','shop','purchaseDate','docType','docNumber','category','notes'].forEach(k=>{
    on(`f_${k}`,'input',e=>{state.form[k]=e.target.value;if(k==='purchaseDate'&&state.form.warrantyMonths)state.form.warrantyEnd=addMonths(e.target.value,state.form.warrantyMonths);syncSaveBtn();});
    on(`f_${k}`,'change',e=>{state.form[k]=e.target.value;if(k==='purchaseDate'&&state.form.warrantyMonths)state.form.warrantyEnd=addMonths(e.target.value,state.form.warrantyMonths);syncSaveBtn();});
  });

  on('saveBtn','click',saveItem);
  on('deleteBtn','click',()=>deleteItem(state.selected));
  on('deleteBtn2','click',()=>deleteItem(state.selected));
}

function syncSaveBtn(){const btn=document.getElementById('saveBtn');if(btn)btn.disabled=!state.form.name.trim();}

function deleteItem(id){
  if(!confirm('Ištrinti šį įrašą?'))return;
  state.items=state.items.filter(i=>i.id!==id);persist();state.view='list';render();
}
function saveItem(){
  if(!state.form.name.trim())return;
  state.items.unshift({...state.form,id:Date.now()});
  persist();state.form=emptyForm();state.docError='';state.addMode=null;state.view='list';render();
}

// ── Document upload ────────────────────────────────────────────────────────
function handleDocUpload(e){
  const file=e.target.files[0];if(!file)return;
  const isPdf=file.type==='application/pdf';
  const isImg=ALLOWED_IMG.includes(file.type);

  if(!isPdf&&!isImg){state.docError='Leidžiami formatai: JPG, PNG, WebP, HEIC, PDF';render();return;}
  if(isPdf&&file.size>MAX_PDF_BYTES){state.docError=`PDF per didelis (max 5MB, jūsų: ${fmtSize(file.size)})`;render();return;}
  if(isImg&&file.size>MAX_IMG_BYTES){state.docError=`Nuotrauka per didelė (max 4MB, jūsų: ${fmtSize(file.size)})`;render();return;}

  state.docError='';
  const reader=new FileReader();
  reader.onload=async ev=>{
    const dataUrl=ev.target.result;
    const base64=dataUrl.split(',')[1];

    if(isPdf){
      state.form.docData=base64;
      state.form.docMime='application/pdf';
      state.form.docFileName=file.name;
      render();
      // AI can't analyse PDF directly, skip
    }else{
      // Verify it's a real image
      const img=new Image();
      img.onload=async()=>{
        state.form.docData=dataUrl;
        state.form.docMime=file.type;
        state.form.docFileName=file.name;
        if(state.addMode==='photo'){
          state.analyzing=true;render();
          await analyzeDoc(base64,file.type);
          state.analyzing=false;
        }
        render();
      };
      img.onerror=()=>{state.docError='Failas neatpažintas kaip nuotrauka';render();};
      img.src=dataUrl;
    }
  };
  reader.readAsDataURL(file);
}

// ── AI analysis ────────────────────────────────────────────────────────────
async function analyzeDoc(base64,mimeType){
  try{
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:mimeType,data:base64}},
        {type:'text',text:`Tai pirkimo dokumentas (čekis, SF arba banko išrašas). Grąžink TIK JSON be markdown:
{"name":"produkto pavadinimas","shop":"parduotuvė arba null","purchaseDate":"YYYY-MM-DD arba null","docNumber":"dokumento numeris arba null","docType":"Sąskaita-faktūra (SF)|Banko išrašas|Kvitas / čekis|Kita","price":"kaina su valiuta arba null","warrantyMonths":24}
warrantyMonths – standartinė garantija mėnesiais (6/12/24/36/60). Jei nežinoma – 24.`}
      ]}]})
    });
    if(!res.ok)throw new Error(res.status);
    const data=await res.json();
    const text=(data.content||[]).map(c=>c.text||'').join('');
    const p=JSON.parse(text.replace(/```json|```/g,'').trim());
    if(p.name&&typeof p.name==='string')state.form.name=p.name.slice(0,200);
    if(p.shop&&typeof p.shop==='string')state.form.shop=p.shop.slice(0,100);
    if(p.purchaseDate&&/^\d{4}-\d{2}-\d{2}$/.test(p.purchaseDate))state.form.purchaseDate=p.purchaseDate;
    if(p.docNumber&&typeof p.docNumber==='string')state.form.docNumber=p.docNumber.slice(0,100);
    if(p.docType&&DOC_TYPES.includes(p.docType))state.form.docType=p.docType;
    const wm=WARRANTY_OPTS.find(o=>o.months===p.warrantyMonths);
    if(wm){state.form.warrantyMonths=p.warrantyMonths;if(state.form.purchaseDate)state.form.warrantyEnd=addMonths(state.form.purchaseDate,p.warrantyMonths);}
    const np=[p.price?`Kaina: ${String(p.price).slice(0,50)}`:'',(typeof p.notes==='string'?p.notes.slice(0,300):'')].filter(Boolean);
    if(np.length)state.form.notes=np.join('\n');
  }catch(err){console.warn('AI analizė nepavyko:',err);}
}

// ── Boot ───────────────────────────────────────────────────────────────────
load();
checkAuth().then(()=>render());
