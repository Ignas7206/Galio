'use strict';
import { auth, db, storage } from './firebase-config.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  setDoc, getDoc, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const WORKER_URL    = 'https://long-moon-d252.ltdigitaltools.workers.dev';
const CATEGORIES    = ['Elektronika','Buitinė technika','Avalynė / drabužiai','Baldai','Automobiliai','Kita'];
const DOC_TYPES     = ['Kvitas / čekis','Sąskaita-faktūra (SF)','Banko išrašas','Kita'];
const WARRANTY_OPTS = [{l:'6 mėnesiai',m:6},{l:'1 metai',m:12},{l:'2 metai',m:24},{l:'3 metai',m:36},{l:'5 metai',m:60},{l:'Kita data',m:null}];
const ALLOWED_IMG   = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const MAX_IMG       = 4*1024*1024;
const MAX_PDF       = 5*1024*1024;
const FREE_LIMIT    = 15;

let state = {
  booted:false, user:null, userDoc:null, loadingItems:false,
  view:'list', addMode:null,
  items:[], itemsUnsub:null,
  selected:null,
  search:'', filterCat:'Visos', sortBy:'newest',
  form:emptyForm(),
  lightbox:null, analyzing:false, uploadPct:null,
  authMode:'login', authError:'', authInfo:'', authBusy:false,
  docError:'', showWarranty:false,
  online: navigator.onLine,
  onboardSlide: 0,
  showOnboarding: !localStorage.getItem('garantijos_onboarded'),
  swipe: { id:null, startX:0, currentX:0, dragging:false },
  addPulse: false,
};

function emptyForm(){return{name:'',category:'Elektronika',shop:'',purchaseDate:today(),warrantyEnd:addMonths(today(),24),warrantyMonths:24,docType:'Kvitas / čekis',docNumber:'',notes:'',docData:null,docMime:null,docFileName:null,docStoragePath:null,notifyEnabled:true};}
function today(){return new Date().toISOString().slice(0,10);}
function addMonths(d,m){if(!d)return '';const r=new Date(d);r.setMonth(r.getMonth()+m);return r.toISOString().slice(0,10);}

// ── Network status ───────────────────────────────────────────────────────
window.addEventListener('online',()=>{state.online=true;render();});
window.addEventListener('offline',()=>{state.online=false;render();});

// ── Helpers ────────────────────────────────────────────────────────────────
function daysLeft(d){if(!d)return null;return Math.ceil((new Date(d)-new Date())/86400000);}
function fmtDate(d){if(!d)return '—';return new Date(d).toLocaleDateString('lt-LT');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtSize(b){return b<1024*1024?(b/1024).toFixed(0)+'KB':(b/1024/1024).toFixed(1)+'MB';}
function badgeHtml(days){
  if(days===null)return '';
  if(days<0)return`<span class="badge badge-exp">Baigėsi</span>`;
  if(days<=30)return`<span class="badge badge-warn">${days}d.</span>`;
  return`<span class="badge badge-ok">${days}d.</span>`;
}
function toast(msg){
  document.querySelectorAll('.toast').forEach(e=>e.remove());
  const el=document.createElement('div');el.className='toast';el.textContent=msg;
  document.getElementById('app').appendChild(el);
  setTimeout(()=>el.remove(),2600);
}
function friendlyAuthError(code){
  const map={
    'auth/email-already-in-use':'Šis el. paštas jau užregistruotas',
    'auth/invalid-email':'Neteisingas el. pašto formatas',
    'auth/weak-password':'Slaptažodis per silpnas (min. 6 simboliai)',
    'auth/user-not-found':'Vartotojas nerastas',
    'auth/wrong-password':'Neteisingas slaptažodis',
    'auth/invalid-credential':'Neteisingas el. paštas arba slaptažodis',
    'auth/too-many-requests':'Per daug bandymų. Pabandykite vėliau',
    'auth/network-request-failed':'Nėra interneto ryšio',
  };
  return map[code]||'Įvyko klaida. Bandykite dar kartą';
}

// ── Auth ───────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user)=>{
  state.booted=true;
  if(user && !user.emailVerified){
    // allow usage but show banner; Firebase still treats them as authenticated
  }
  state.user=user;
  if(user){
    await ensureUserDoc(user);
    attachItemsListener(user.uid);
  }else{
    if(state.itemsUnsub){state.itemsUnsub();state.itemsUnsub=null;}
    state.items=[];
    state.userDoc=null;
  }
  render();
});

async function ensureUserDoc(user){
  const ref_ = doc(db,'users',user.uid);
  const snap = await getDoc(ref_);
  if(!snap.exists()){
    await setDoc(ref_,{ email:user.email, plan:'free', itemCount:0, createdAt: serverTimestamp() });
    state.userDoc = { email:user.email, plan:'free', itemCount:0 };
  }else{
    state.userDoc = snap.data();
  }
  // live updates to plan/itemCount
  onSnapshot(ref_, s=>{ if(s.exists()){ state.userDoc=s.data(); render(); } });
}

function attachItemsListener(uid){
  if(state.itemsUnsub)state.itemsUnsub();
  state.loadingItems = true;
  const q = query(collection(db,'users',uid,'warranties'), orderBy('createdAtMs','desc'));
  state.itemsUnsub = onSnapshot(q, snap=>{
    const wasEmpty = state.loadingItems;
    state.items = snap.docs.map(d=>({id:d.id,...d.data()}));
    state.loadingItems = false;
    if(wasEmpty && state.items.length===0 && !state.addPulse){
      state.addPulse = true;
      setTimeout(()=>{state.addPulse=false;render();}, 3500);
    }
    render();
  }, err=>{
    state.loadingItems = false;
    console.warn('Items listener error:', err);
  });
}

async function doRegister(email,pwd,pwd2){
  state.authError='';state.authInfo='';
  if(!email||!pwd){state.authError='Užpildykite visus laukus';render();return;}
  if(pwd.length<6){state.authError='Slaptažodis turi būti bent 6 simbolių';render();return;}
  if(pwd!==pwd2){state.authError='Slaptažodžiai nesutampa';render();return;}
  state.authBusy=true;render();
  try{
    const cred = await createUserWithEmailAndPassword(auth,email,pwd);
    await sendEmailVerification(cred.user);
    state.authInfo='Paskyra sukurta! Patikrinkite el. paštą patvirtinimui.';
  }catch(e){ state.authError=friendlyAuthError(e.code); }
  state.authBusy=false;render();
}
async function doLogin(email,pwd){
  state.authError='';state.authInfo='';
  if(!email||!pwd){state.authError='Užpildykite visus laukus';render();return;}
  state.authBusy=true;render();
  try{ await signInWithEmailAndPassword(auth,email,pwd); }
  catch(e){ state.authError=friendlyAuthError(e.code); }
  state.authBusy=false;render();
}
async function doReset(email){
  state.authError='';state.authInfo='';
  if(!email){state.authError='Įveskite el. paštą';render();return;}
  state.authBusy=true;render();
  try{ await sendPasswordResetEmail(auth,email); state.authInfo='Slaptažodžio atstatymo nuoroda išsiųsta į el. paštą'; }
  catch(e){ state.authError=friendlyAuthError(e.code); }
  state.authBusy=false;render();
}
async function doLogout(){
  if(state.itemsUnsub){state.itemsUnsub();state.itemsUnsub=null;}
  await signOut(auth);
  state.view='list';state.addMode=null;
}

// ── Render ─────────────────────────────────────────────────────────────────
function render(){
  const scr=document.getElementById('screen');
  const nav=document.getElementById('bottomNav');

  if(!state.booted){ scr.innerHTML='<div class="center-loader"><div class="spinner"></div></div>'; nav.style.display='none'; return; }
  if(state.lightbox){scr.innerHTML=renderLightbox();nav.style.display='none';attachLightboxEvents();return;}
  if(!state.user){
    if(state.showOnboarding){ scr.innerHTML=renderOnboarding(); nav.style.display='none'; attachOnboardingEvents(); return; }
    scr.innerHTML=renderAuth();nav.style.display='none';attachAuthEvents();return;
  }

  nav.style.display='flex';
  let html='';
  if(state.view==='list')          html=renderList();
  else if(state.view==='search')   html=renderSearch();
  else if(state.view==='add'&&!state.addMode) html=renderPicker();
  else if(state.view==='add')      html=renderAdd();
  else if(state.view==='detail')   html=renderDetail();

  const syncPill = `<div class="sync-pill${state.online?'':' offline'}"><span class="dot"></span>${state.online?'Sinchronizuota':'Be interneto · veikia lokaliai'}</div>`;
  scr.innerHTML = (state.online?'':syncPill) + html;

  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===state.view));
  const addCircle = document.querySelector('.nav-add-circle');
  if(addCircle) addCircle.classList.toggle('pulse', state.addPulse && state.view==='list');
  attachEvents();
}

// ── Onboarding ─────────────────────────────────────────────────────────────
const ONBOARD_SLIDES = [
  { icon:'ti-camera', bg:'var(--accent-bg)', color:'var(--accent)', title:'Nufotografuok čekį', text:'AI automatiškai atpažįsta produktą, parduotuvę ir datas iš nuotraukos ar PDF per kelias sekundes.' },
  { icon:'ti-bell-ringing', bg:'var(--orange-bg)', color:'var(--orange)', title:'Niekada nepraleisk garantijos', text:'Matykite iš karto, kurių daiktų garantija baigiasi greitai, ir nepraraskite teisės į nemokamą remontą.' },
  { icon:'ti-cloud-lock', bg:'var(--green-bg)', color:'var(--green)', title:'Saugu ir visada po ranka', text:'Duomenys saugomi debesyje su jūsų paskyra ir pasiekiami iš bet kurio įrenginio, net be interneto.' },
];
function renderOnboarding(){
  const slides = ONBOARD_SLIDES.map(s=>`
    <div class="onboard-slide">
      <div class="onboard-icon" style="background:${s.bg}"><i class="ti ${s.icon}" style="color:${s.color}"></i></div>
      <h2>${esc(s.title)}</h2>
      <p>${esc(s.text)}</p>
    </div>`).join('');
  const dots = ONBOARD_SLIDES.map((_,i)=>`<div class="onboard-dot${i===state.onboardSlide?' active':''}"></div>`).join('');
  const isLast = state.onboardSlide === ONBOARD_SLIDES.length-1;
  return `<div class="onboard-wrap">
    <div class="onboard-slides" id="onboardSlides">${slides}</div>
    <div class="onboard-dots">${dots}</div>
    <div class="onboard-footer">
      <button class="login-btn" id="onboardNext">${isLast?'Pradėti':'Toliau'}</button>
      ${!isLast?`<button class="onboard-skip" id="onboardSkip">Praleisti</button>`:''}
    </div>
  </div>`;
}
function attachOnboardingEvents(){
  const track = document.getElementById('onboardSlides');
  const finish = ()=>{ state.showOnboarding=false; localStorage.setItem('garantijos_onboarded','1'); render(); };
  document.getElementById('onboardNext')?.addEventListener('click',()=>{
    if(state.onboardSlide < ONBOARD_SLIDES.length-1){
      state.onboardSlide++; render();
      const t=document.getElementById('onboardSlides');
      if(t) t.scrollTo({left: t.clientWidth*state.onboardSlide, behavior:'smooth'});
    } else { finish(); }
  });
  document.getElementById('onboardSkip')?.addEventListener('click', finish);
  if(track){
    let scrollTimeout;
    track.addEventListener('scroll',()=>{
      clearTimeout(scrollTimeout);
      scrollTimeout=setTimeout(()=>{
        const idx = Math.round(track.scrollLeft / track.clientWidth);
        if(idx!==state.onboardSlide){ state.onboardSlide=idx; render(); const t=document.getElementById('onboardSlides'); if(t)t.scrollLeft=track.clientWidth*idx; }
      },80);
    });
  }
}

// ── Lightbox ───────────────────────────────────────────────────────────────
function renderLightbox(){return`<div class="lightbox" id="lbOverlay"><div class="lightbox-bar"><button class="lightbox-close" id="lbClose"><i class="ti ti-x"></i></button></div><div class="lightbox-img"><img src="${esc(state.lightbox)}" /></div></div>`;}
function attachLightboxEvents(){
  document.getElementById('lbClose')?.addEventListener('click',()=>{state.lightbox=null;render();});
  document.getElementById('lbOverlay')?.addEventListener('click',e=>{if(e.target.id==='lbOverlay'){state.lightbox=null;render();}});
}

// ── Auth screen ────────────────────────────────────────────────────────────
function renderAuth(){
  const m=state.authMode;
  return`<div class="login-wrap"><div class="login-card">
    <div class="login-logo"><span class="shield">🛡️</span><h1>Garantijos</h1><p>${m==='register'?'Susikurkite paskyrą':m==='reset'?'Atstatykite slaptažodį':'Prisijunkite'}</p></div>

    <input type="email" id="authEmail" class="login-input" placeholder="El. paštas" autocomplete="email" />
    ${m!=='reset'?`<input type="password" id="authPwd" class="login-input" placeholder="Slaptažodis" autocomplete="${m==='register'?'new-password':'current-password'}" />`:''}
    ${m==='register'?`<input type="password" id="authPwd2" class="login-input" placeholder="Pakartokite slaptažodį" autocomplete="new-password" />`:''}

    ${state.authError?`<p class="login-error">${esc(state.authError)}</p>`:''}
    ${state.authInfo?`<p class="login-info">${esc(state.authInfo)}</p>`:''}

    <button id="authSubmit" class="login-btn" ${state.authBusy?'disabled':''}>
      ${state.authBusy?'Prašome palaukti...':m==='register'?'Sukurti paskyrą':m==='reset'?'Siųsti nuorodą':'Prisijungti'}
    </button>

    ${m==='login'?`<div class="login-switch"><button id="toReset">Pamiršote slaptažodį?</button></div>`:''}
    <div class="login-switch">
      ${m==='login'?`Neturite paskyros? <button id="toRegister">Registruotis</button>`
        :m==='register'?`Jau turite paskyrą? <button id="toLogin">Prisijungti</button>`
        :`<button id="toLogin">Grįžti į prisijungimą</button>`}
    </div>
  </div></div>`;
}
function attachAuthEvents(){
  const e1=document.getElementById('authEmail'),p1=document.getElementById('authPwd'),p2=document.getElementById('authPwd2');
  document.getElementById('authSubmit')?.addEventListener('click',()=>{
    const email=e1?.value.trim()||'';
    if(state.authMode==='register') doRegister(email,p1?.value||'',p2?.value||'');
    else if(state.authMode==='reset') doReset(email);
    else doLogin(email,p1?.value||'');
  });
  document.getElementById('toRegister')?.addEventListener('click',()=>{state.authMode='register';state.authError='';state.authInfo='';render();});
  document.getElementById('toLogin')?.addEventListener('click',()=>{state.authMode='login';state.authError='';state.authInfo='';render();});
  document.getElementById('toReset')?.addEventListener('click',()=>{state.authMode='reset';state.authError='';state.authInfo='';render();});
  [e1,p1,p2].forEach(el=>el?.addEventListener('keydown',ev=>{if(ev.key==='Enter')document.getElementById('authSubmit')?.click();}));
  setTimeout(()=>e1?.focus(),50);
}

// ── List ───────────────────────────────────────────────────────────────────
function renderList(){
  const{items,filterCat,sortBy,userDoc}=state;
  const expired =items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d<0;}).length;
  const expiring=items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d>=0&&d<=30;}).length;
  const valid   =items.length-expired;
  const isPremium = userDoc?.plan==='premium';

  const filtered=items
    .filter(i=>filterCat==='Visos'||i.category===filterCat)
    .sort((a,b)=>{
      if(sortBy==='name')return a.name.localeCompare(b.name,'lt');
      if(sortBy==='expiring'){const da=daysLeft(a.warrantyEnd)??99999,db=daysLeft(b.warrantyEnd)??99999;return da-db;}
      return (b.createdAtMs||0)-(a.createdAtMs||0);
    });

  const statsHtml=items.length>0?`<div class="stats-row">
    <div class="stat-tile"><div class="n" style="color:var(--green)">${valid}</div><div class="l">Galioja</div></div>
    <div class="stat-tile"><div class="n" style="color:var(--orange)">${expiring}</div><div class="l">Baigiasi</div></div>
    <div class="stat-tile"><div class="n" style="color:var(--red)">${expired}</div><div class="l">Baigėsi</div></div>
  </div>`:'';

  const planBanner = !isPremium ? `<div class="plan-banner">
    <i class="ti ti-crown"></i>
    <div class="pb-text"><b>${items.length}/${FREE_LIMIT}</b> nemokamų įrašų panaudota</div>
    <button id="upgradeBtn">Premium</button>
  </div>`:'';

  const chips=['Visos',...CATEGORIES].map(c=>`<button class="chip${filterCat===c?' active':''}" data-filter="${esc(c)}">${esc(c)}</button>`).join('');

  const cardsHtml=filtered.map(item=>{
    const days=daysLeft(item.warrantyEnd);
    let thumb;
    if(item.docMime==='application/pdf')
      thumb=`<div class="card-icon" style="background:var(--red-bg)"><i class="ti ti-file-type-pdf" style="color:var(--red)"></i></div>`;
    else if(item.docUrl)
      thumb=`<img class="card-thumb" src="${esc(item.docUrl)}" alt="" loading="lazy" />`;
    else
      thumb=`<div class="card-icon"><i class="ti ti-receipt"></i></div>`;
    const urgentClass = days!==null && days<0 ? ' urgent-exp' : days!==null && days<=30 ? ' urgent-warn' : '';
    return`<div class="swipe-wrap" data-swipe-id="${esc(item.id)}">
      <div class="swipe-delete-bg"><i class="ti ti-trash"></i></div>
      <button class="card${urgentClass}" data-id="${esc(item.id)}">
        ${thumb}
        <div class="card-body">
          <div class="card-top"><span class="card-name">${esc(item.name)}</span>${badgeHtml(days)}</div>
          <div class="card-sub">${esc(item.shop||item.category)}</div>
          ${item.warrantyEnd?`<div class="card-date"><i class="ti ti-calendar" style="font-size:12px"></i>Iki ${fmtDate(item.warrantyEnd)}</div>`:''}
        </div>
      </button>
    </div>`;
  }).join('');

  const skeletonHtml = `<div class="skeleton-card"><div class="skeleton-box skel-thumb"></div><div class="skel-lines"><div class="skeleton-box skel-line" style="width:60%"></div><div class="skeleton-box skel-line" style="width:40%"></div></div></div>`.repeat(3);

  const emptyHtml=state.loadingItems ? skeletonHtml : items.length===0?`<div class="empty-state">
    <div class="empty-icon"><i class="ti ti-shield-check"></i></div>
    <h3>Dar nėra garantijų</h3>
    <p>Pridėkite pirmą daiktą paspausdami + mygtuką apačioje</p>
  </div>`:filtered.length===0?`<div class="empty-state"><div class="empty-icon"><i class="ti ti-filter-off"></i></div><h3>Nieko nerasta</h3><p>Pabandykite kitą kategoriją</p></div>`:'';

  return`<div>
    <div class="page-header">
      <span class="page-title">Garantijos</span>
      <button class="icon-btn" id="logoutBtn"><i class="ti ti-logout" style="font-size:18px"></i></button>
    </div>
    <div style="height:14px"></div>
    ${statsHtml}
    ${planBanner}
    <div class="chips">${chips}</div>
    <div style="padding:0 16px 10px;display:flex;gap:8px;align-items:center">
      <span style="font-size:12px;color:var(--text3)">Rikiuoti:</span>
      <button class="chip${sortBy==='newest'?' active':''}" data-sort="newest" style="font-size:12px;padding:4px 10px">Naujausi</button>
      <button class="chip${sortBy==='expiring'?' active':''}" data-sort="expiring" style="font-size:12px;padding:4px 10px">Baigiasi</button>
      <button class="chip${sortBy==='name'?' active':''}" data-sort="name" style="font-size:12px;padding:4px 10px">A–Z</button>
    </div>
    <div class="cards">${emptyHtml}${cardsHtml}</div>
    <div style="height:8px"></div>
  </div>`;
}

// ── Search ─────────────────────────────────────────────────────────────────
function renderSearch(){
  const q=state.search;
  const results=!q?[]:state.items.filter(i=>{const s=q.toLowerCase();return i.name.toLowerCase().includes(s)||(i.shop||'').toLowerCase().includes(s)||(i.docNumber||'').toLowerCase().includes(s)||(i.notes||'').toLowerCase().includes(s);});
  const cardsHtml=results.map(item=>{
    const days=daysLeft(item.warrantyEnd);
    const thumb=item.docUrl&&item.docMime!=='application/pdf'?`<img class="card-thumb" src="${esc(item.docUrl)}" alt="" loading="lazy" />`:`<div class="card-icon"><i class="ti ti-receipt"></i></div>`;
    return`<button class="card" data-id="${esc(item.id)}">
      ${thumb}
      <div class="card-body">
        <div class="card-top"><span class="card-name">${esc(item.name)}</span>${badgeHtml(days)}</div>
        <div class="card-sub">${esc(item.shop||item.category)}</div>
        ${item.docNumber?`<div class="card-date"><i class="ti ti-hash" style="font-size:12px"></i>${esc(item.docNumber)}</div>`:''}
      </div>
    </button>`;
  }).join('');

  return`<div>
    <div class="page-header" style="padding-bottom:14px"><span class="page-title">Ieškoti</span></div>
    <div style="padding:12px 16px 4px">
      <div class="search-bar" style="margin:0"><i class="ti ti-search"></i><input type="search" id="searchInput" placeholder="Pavadinimas, dok. numeris..." value="${esc(q)}" autofocus /></div>
    </div>
    <div class="cards" style="margin-top:12px">
      ${!q?`<div class="empty-state" style="padding:40px 32px"><div class="empty-icon"><i class="ti ti-search"></i></div><p>Įveskite paieškos žodį</p></div>`:results.length===0?`<div class="empty-state" style="padding:40px 32px"><div class="empty-icon"><i class="ti ti-mood-sad"></i></div><h3>Nieko nerasta</h3></div>`:cardsHtml}
    </div>
  </div>`;
}

// ── Add picker ─────────────────────────────────────────────────────────────
function renderPicker(){
  const atLimit = state.userDoc?.plan!=='premium' && state.items.length>=FREE_LIMIT;
  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-x"></i></button><h2>Pridėti garantiją</h2></div>
    ${atLimit?`<div class="plan-banner" style="margin:16px"><i class="ti ti-lock"></i><div class="pb-text">Pasiekėte nemokamo plano limitą (${FREE_LIMIT} įrašų). Atsinaujinkite į Premium, kad pridėtumėte daugiau.</div><button id="upgradeBtn2">Premium</button></div>`:`
    <div class="picker-cards">
      <button class="picker-card" id="modePhoto">
        <div class="picker-icon" style="background:var(--accent-bg)"><i class="ti ti-camera" style="color:var(--accent)"></i></div>
        <div><h3>Su dokumentu + AI</h3><p>Nufotografuok arba įkelk – AI ištrauks informaciją automatiškai</p></div>
      </button>
      <button class="picker-card" id="modeManual">
        <div class="picker-icon" style="background:var(--green-bg)"><i class="ti ti-pencil" style="color:var(--green)"></i></div>
        <div><h3>Rankiniu būdu</h3><p>Suveskite informaciją patys. Dokumentą galima prisegti</p></div>
      </button>
    </div>`}
  </div>`;
}

// ── Add form ───────────────────────────────────────────────────────────────
function renderAdd(){
  const f=state.form;
  const isPhoto=state.addMode==='photo';
  const selOpt=WARRANTY_OPTS.find(o=>o.m===f.warrantyMonths)||WARRANTY_OPTS[WARRANTY_OPTS.length-1];
  const hasPdf=f.docData&&f.docMime==='application/pdf';
  const hasImg=f.docData&&f.docMime!=='application/pdf';

  let docAreaHtml='';
  if(hasPdf){
    docAreaHtml=`<div class="doc-preview-pdf"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(f.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">PDF pridėtas</div></div></div>`;
  }else if(hasImg){
    docAreaHtml=`<div style="position:relative"><img class="doc-preview-img" id="docThumb" src="${esc(f.docData)}" alt="" /><div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.55);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ti ti-zoom-in" style="font-size:14px;color:#fff"></i></div></div>`;
  }else{
    docAreaHtml=`<label class="doc-drop-zone" for="docInput">
      <i class="ti ti-${isPhoto?'camera':'paperclip'}"></i>
      <p>${isPhoto?'Fotografuoti arba įkelti':'Prisegti dokumentą (neprivaloma)'}</p>
      <small>JPG, PNG, PDF · max 4MB / 5MB PDF</small>
    </label>`;
  }

  const warrantySheet=state.showWarranty?`<div class="warranty-sheet" id="warrantySheet">
    <div class="warranty-overlay" id="warrantyOverlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title">Garantijos trukmė</div>
      ${WARRANTY_OPTS.map(o=>`<button class="warranty-opt${f.warrantyMonths===o.m?' selected':''}" data-wm="${o.m??'x'}">${esc(o.l)}${f.warrantyMonths===o.m?`<i class="ti ti-check"></i>`:''}</button>`).join('')}
    </div>
  </div>`:'';

  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button><h2>${isPhoto?'Pridėti su dokumentu':'Įvesti rankiniu būdu'}</h2></div>
    <div class="form-body">
      ${!state.user.emailVerified&&isPhoto?`<div class="plan-banner" style="margin-bottom:14px"><i class="ti ti-mail-exclamation"></i><div class="pb-text">Patvirtinkite el. paštą, kad galėtumėte naudoti AI analizę</div></div>`:''}
      <div class="doc-upload-area">
        ${docAreaHtml}
        <input type="file" id="docInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" ${isPhoto?'capture="environment"':''} style="display:none" />
        ${f.docData?`<button class="doc-remove-btn" id="removeDoc"><i class="ti ti-trash" style="font-size:14px"></i>Pašalinti dokumentą</button>`:''}
        ${state.docError?`<p class="doc-error">${esc(state.docError)}</p>`:''}
        ${state.analyzing?`<div class="analyzing-row"><div class="spinner"></div><span style="font-size:13px;color:var(--text2)">AI analizuoja dokumentą...</span></div>`:''}
      </div>

      <p class="form-label-section">Pagrindinė informacija</p>
      <div class="form-section">
        <div class="form-row"><label>Pavadinimas</label><input type="text" id="f_name" placeholder="Būtina" value="${esc(f.name)}" /></div>
        <div class="form-row"><label>Parduotuvė</label><input type="text" id="f_shop" placeholder="Neprivaloma" value="${esc(f.shop)}" /></div>
        <div class="form-row"><label>Kategorija</label><select id="f_category">${CATEGORIES.map(c=>`<option${c===f.category?' selected':''}>${esc(c)}</option>`).join('')}</select><i class="ti ti-chevron-right form-row-chevron"></i></div>
      </div>

      <p class="form-label-section">Datos</p>
      <div class="form-section">
        <div class="form-row"><label>Pirkimo data</label><input type="date" id="f_purchaseDate" value="${esc(f.purchaseDate)}" /></div>
        <div class="form-row" id="warrantyBtn" style="cursor:pointer"><label>Garantija</label><span style="font-size:15px;color:var(--text2)">${esc(selOpt.l)}</span><i class="ti ti-chevron-right form-row-chevron"></i></div>
        ${f.warrantyMonths===null?`<div class="form-row"><label>Galioja iki</label><input type="date" id="f_warrantyEnd" value="${esc(f.warrantyEnd)}" /></div>`:''}
      </div>

      <p class="form-label-section">Dokumentas</p>
      <div class="form-section">
        <div class="form-row"><label>Tipas</label><select id="f_docType">${DOC_TYPES.map(d=>`<option${d===f.docType?' selected':''}>${esc(d)}</option>`).join('')}</select><i class="ti ti-chevron-right form-row-chevron"></i></div>
        <div class="form-row"><label>Numeris</label><input type="text" id="f_docNumber" placeholder="pvz. SF-2025-001" value="${esc(f.docNumber)}" /></div>
      </div>

      <p class="form-label-section">Pastabos</p>
      <div class="form-section"><div class="form-row"><textarea id="f_notes" rows="3" placeholder="Papildoma informacija...">${esc(f.notes)}</textarea></div></div>

      ${state.uploadPct!==null?`<div class="upload-progress-row"><div class="upload-progress-bar"><div class="upload-progress-fill" style="width:${state.uploadPct}%"></div></div><span style="font-size:12px;color:var(--text2)">${state.uploadPct}%</span></div>`:''}

      <button class="save-btn" id="saveBtn" ${f.name.trim()&&state.uploadPct===null?'':'disabled'}>${state.uploadPct!==null?'Saugoma...':'Išsaugoti'}</button>
    </div>
    ${warrantySheet}
  </div>`;
}

// ── Detail ─────────────────────────────────────────────────────────────────
function renderDetail(){
  const item=state.items.find(i=>i.id===state.selected);
  if(!item){state.view='list';render();return '';}
  const days=daysLeft(item.warrantyEnd);
  let sc,si,sv;
  if(days===null){sc='var(--bg2)';si='ti-shield';sv='Nenurodyta';}
  else if(days<0){sc='var(--red-bg)';si='ti-shield-x';sv='Garantija baigėsi';}
  else if(days<=30){sc='var(--orange-bg)';si='ti-shield-exclamation';sv=`Liko ${days} d.`;}
  else{sc='var(--green-bg)';si='ti-shield-check';sv=`Liko ${days} d.`;}
  const textColor=days===null?'var(--text2)':days<0?'var(--red)':days<=30?'var(--orange)':'var(--green)';

  let docHtml='';
  if(item.docUrl&&item.docMime==='application/pdf'){
    docHtml=`<div class="detail-section"><a class="doc-preview-pdf" href="${esc(item.docUrl)}" target="_blank"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(item.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">Spustelkite peržiūrėti</div></div><i class="ti ti-external-link" style="font-size:18px;color:var(--red);flex-shrink:0"></i></a></div>`;
  }else if(item.docUrl){
    docHtml=`<div class="detail-section"><img src="${esc(item.docUrl)}" id="docImg" style="width:100%;border-radius:var(--radius);max-height:200px;object-fit:cover;cursor:pointer;display:block" /></div>`;
  }

  const rows=[
    {i:'ti-tag',l:'Pavadinimas',v:item.name},
    {i:'ti-building-store',l:'Parduotuvė',v:item.shop||'—'},
    {i:'ti-category',l:'Kategorija',v:item.category},
    {i:'ti-file-description',l:'Dok. tipas',v:item.docType||'—'},
    {i:'ti-hash',l:'Dok. numeris',v:item.docNumber||'—'},
    {i:'ti-calendar',l:'Pirkimo data',v:fmtDate(item.purchaseDate)},
    {i:'ti-calendar-due',l:'Garantija iki',v:fmtDate(item.warrantyEnd)},
  ].map(r=>`<div class="detail-row"><i class="ti ${r.i}"></i><span class="dr-label">${esc(r.l)}</span><span class="dr-val">${esc(r.v)}</span></div>`).join('');

  return`<div>
    <div class="page-header-sm">
      <button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>${esc(item.name)}</h2>
      <button class="icon-btn" id="deleteBtn" style="color:var(--red)"><i class="ti ti-trash" style="font-size:18px"></i></button>
    </div>
    <div class="detail-status" style="background:${sc}">
      <i class="ti ${si}" style="font-size:36px;color:${textColor}"></i>
      <div><div class="ds-label" style="color:${textColor}">Garantijos statusas</div><div class="ds-val" style="color:${textColor}">${sv}</div></div>
    </div>
    ${docHtml}
    <div class="detail-section"><div class="detail-rows">${rows}</div></div>
    ${item.notes?`<div class="detail-section"><div class="notes-card"><div class="nc-label">Pastabos</div><p>${esc(item.notes)}</p></div></div>`:''}
    <div class="detail-section"><button class="delete-btn" id="deleteBtn2"><i class="ti ti-trash"></i>Ištrinti įrašą</button></div>
    <div style="height:8px"></div>
  </div>`;
}

// ── Events ─────────────────────────────────────────────────────────────────
function attachEvents(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  const onAll=(sel,ev,fn)=>document.querySelectorAll(sel).forEach(el=>el.addEventListener(ev,fn));

  document.getElementById('navList')?.addEventListener('click',()=>{state.view='list';render();});
  document.getElementById('navSearch')?.addEventListener('click',()=>{state.view='search';render();});

  // Add button: tap = picker, long-press = jump straight to camera
  const navAdd = document.getElementById('navAdd');
  if(navAdd){
    let pressTimer=null, longPressed=false;
    const startPress=(e)=>{
      longPressed=false;
      pressTimer=setTimeout(()=>{
        longPressed=true;
        if(navigator.vibrate)navigator.vibrate(12);
        state.form=emptyForm();state.docError='';state.addMode='photo';state.view='add';render();
        setTimeout(()=>document.getElementById('docInput')?.click(),60);
      },480);
    };
    const cancelPress=()=>{ clearTimeout(pressTimer); };
    navAdd.addEventListener('touchstart',startPress,{passive:true});
    navAdd.addEventListener('touchend',e=>{ cancelPress(); if(!longPressed){ state.form=emptyForm();state.docError='';state.addMode=null;state.view='add';render(); } });
    navAdd.addEventListener('touchcancel',cancelPress);
    navAdd.addEventListener('mousedown',startPress);
    navAdd.addEventListener('mouseup',e=>{ cancelPress(); if(!longPressed){ state.form=emptyForm();state.docError='';state.addMode=null;state.view='add';render(); } });
  }

  // Swipe-to-delete on list cards
  onAll('.swipe-wrap','touchstart',e=>{
    const id=e.currentTarget.dataset.swipeId;
    state.swipe={id,startX:e.touches[0].clientX,currentX:0,dragging:true};
  });
  onAll('.swipe-wrap','touchmove',e=>{
    if(!state.swipe.dragging||state.swipe.id!==e.currentTarget.dataset.swipeId)return;
    const dx=e.touches[0].clientX-state.swipe.startX;
    if(dx<0){
      state.swipe.currentX=Math.max(dx,-88);
      if(Math.abs(state.swipe.currentX)>8) state.swipe.justSwiped=true;
      const card=e.currentTarget.querySelector('.card');
      if(card)card.style.transform=`translateX(${state.swipe.currentX}px)`;
    }
  });
  onAll('.swipe-wrap','touchend',e=>{
    if(!state.swipe.dragging||state.swipe.id!==e.currentTarget.dataset.swipeId)return;
    const card=e.currentTarget.querySelector('.card');
    const id=state.swipe.id;
    if(state.swipe.currentX<-60){
      if(card)card.style.transform='translateX(-88px)';
      // confirm via tap on revealed delete area is implicit; auto-trigger confirm dialog
      setTimeout(()=>{ if(card)card.style.transform=''; deleteItem(id); },80);
    } else {
      if(card)card.style.transform='';
    }
    state.swipe={id:null,startX:0,currentX:0,dragging:false};
  });

  on('logoutBtn','click',()=>{if(confirm('Atsijungti?'))doLogout();});
  on('upgradeBtn','click',()=>toast('Premium netrukus! 🚀'));
  on('upgradeBtn2','click',()=>toast('Premium netrukus! 🚀'));
  onAll('.chip[data-filter]','click',e=>{state.filterCat=e.currentTarget.dataset.filter;render();});
  onAll('.chip[data-sort]','click',e=>{state.sortBy=e.currentTarget.dataset.sort;render();});
  onAll('.card[data-id]','click',e=>{
    if(state.swipe.justSwiped){state.swipe.justSwiped=false;return;}
    state.selected=e.currentTarget.dataset.id;state.view='detail';render();
  });

  on('searchInput','input',e=>{state.search=e.target.value;render();});

  on('modePhoto','click',()=>{state.addMode='photo';render();});
  on('modeManual','click',()=>{state.addMode='manual';render();});

  on('backBtn','click',()=>{
    if(state.view==='add'&&state.addMode){state.addMode=null;render();}
    else{state.view='list';render();}
  });

  on('warrantyBtn','click',()=>{state.showWarranty=true;render();});
  on('warrantyOverlay','click',()=>{state.showWarranty=false;render();});
  onAll('.warranty-opt','click',e=>{
    const v=e.currentTarget.dataset.wm;
    if(v==='x'){state.form.warrantyMonths=null;state.form.warrantyEnd='';}
    else{const m=parseInt(v);state.form.warrantyMonths=m;if(state.form.purchaseDate)state.form.warrantyEnd=addMonths(state.form.purchaseDate,m);}
    state.showWarranty=false;render();
  });
  on('f_warrantyEnd','change',e=>{state.form.warrantyEnd=e.target.value;});

  ['name','shop','purchaseDate','docType','docNumber','category','notes'].forEach(k=>{
    on(`f_${k}`,'input',e=>{state.form[k]=e.target.value;if(k==='purchaseDate'&&state.form.warrantyMonths)state.form.warrantyEnd=addMonths(e.target.value,state.form.warrantyMonths);syncSave();});
    on(`f_${k}`,'change',e=>{state.form[k]=e.target.value;if(k==='purchaseDate'&&state.form.warrantyMonths)state.form.warrantyEnd=addMonths(e.target.value,state.form.warrantyMonths);syncSave();});
  });

  on('docInput','change',handleDoc);
  on('removeDoc','click',()=>{state.form.docData=null;state.form.docMime=null;state.form.docFileName=null;state.docError='';render();});
  on('docThumb','click',()=>{if(state.form.docData)state.lightbox=state.form.docData;render();});
  on('docImg','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it?.docUrl)state.lightbox=it.docUrl;render();});

  on('saveBtn','click',saveItem);
  on('deleteBtn','click',()=>deleteItem(state.selected));
  on('deleteBtn2','click',()=>deleteItem(state.selected));
}

function syncSave(){const b=document.getElementById('saveBtn');if(b)b.disabled=!state.form.name.trim();}

async function deleteItem(id){
  if(!confirm('Ištrinti šį įrašą?'))return;
  const item=state.items.find(i=>i.id===id);
  try{
    await deleteDoc(doc(db,'users',state.user.uid,'warranties',id));
    await updateDoc(doc(db,'users',state.user.uid),{itemCount:increment(-1)});
    if(item?.docStoragePath){
      try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){console.warn('Storage delete failed:',e);}
    }
    toast('Ištrinta');
  }catch(e){ toast('Klaida trinant: '+(e.message||'')); }
  state.view='list';render();
}

async function saveItem(){
  if(!state.form.name.trim())return;
  if(state.userDoc?.plan!=='premium' && state.items.length>=FREE_LIMIT){
    toast('Pasiektas nemokamo plano limitas');
    return;
  }
  const f=state.form;
  const payload={
    name:f.name.trim().slice(0,200), category:f.category, shop:(f.shop||'').slice(0,100),
    purchaseDate:f.purchaseDate, warrantyEnd:f.warrantyEnd, warrantyMonths:f.warrantyMonths,
    docType:f.docType, docNumber:(f.docNumber||'').slice(0,100), notes:(f.notes||'').slice(0,1000),
    notifyEnabled:true, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
    createdAt: serverTimestamp(), createdAtMs: Date.now(),
  };

  try{
    const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'), payload);
    await updateDoc(doc(db,'users',state.user.uid),{itemCount:increment(1)});

    // Upload document if present (after creating doc so we have an ID for the storage path)
    if(f.docData && f.docMime){
      state.uploadPct=0; render();
      try{
        const ext = f.docMime==='application/pdf'?'pdf':(f.docMime.split('/')[1]||'jpg');
        const path = `users/${state.user.uid}/documents/${docRef.id}.${ext}`;
        const blob = base64ToBlob(f.docMime==='application/pdf'?f.docData:f.docData.split(',')[1], f.docMime);
        state.uploadPct=40; render();
        await uploadBytes(ref(storage,path), blob, {contentType:f.docMime});
        state.uploadPct=80; render();
        const url = await getDownloadURL(ref(storage,path));
        await updateDoc(docRef, { docUrl:url, docMime:f.docMime, docFileName:f.docFileName, docStoragePath:path });
        state.uploadPct=100; render();
      }catch(e){
        console.warn('Upload failed:',e);
        toast('Dokumentas neišsaugotas (klaida įkeliant failą)');
      }
    }

    toast('Išsaugota ✓');
  }catch(e){
    toast('Klaida saugant: '+(e.message||''));
  }

  state.uploadPct=null;
  state.form=emptyForm();state.docError='';state.addMode=null;state.view='list';render();
}

function base64ToBlob(b64,mime){
  const s=atob(b64),a=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);
  return new Blob([a],{type:mime});
}

// ── Document picking ───────────────────────────────────────────────────────
function handleDoc(e){
  const file=e.target.files[0];if(!file)return;
  const isPdf=file.type==='application/pdf';
  const isImg=ALLOWED_IMG.includes(file.type);
  if(!isPdf&&!isImg){state.docError='Leidžiami formatai: JPG, PNG, WebP, HEIC, PDF';render();return;}
  if(isPdf&&file.size>MAX_PDF){state.docError=`PDF per didelis (max 5MB, jūsų: ${fmtSize(file.size)})`;render();return;}
  if(isImg&&file.size>MAX_IMG){state.docError=`Per didelė (max 4MB, jūsų: ${fmtSize(file.size)})`;render();return;}
  state.docError='';
  const reader=new FileReader();
  reader.onload=async ev=>{
    const dataUrl=ev.target.result,b64=dataUrl.split(',')[1];
    if(isPdf){
      state.form.docData=b64;state.form.docMime='application/pdf';state.form.docFileName=file.name;render();
    }else{
      const img=new Image();
      img.onload=async()=>{
        state.form.docData=dataUrl;state.form.docMime=file.type;state.form.docFileName=file.name;
        if(state.addMode==='photo'){state.analyzing=true;render();await analyzeDoc(b64,file.type);state.analyzing=false;}
        render();
      };
      img.onerror=()=>{state.docError='Failas neatpažintas kaip nuotrauka';render();};
      img.src=dataUrl;
    }
  };
  reader.readAsDataURL(file);
}

async function analyzeDoc(b64,mime){
  try{
    const idToken = await state.user.getIdToken();
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:mime,data:b64}},
        {type:'text',text:`Pirkimo dokumentas. Grąžink TIK JSON be markdown:
{"name":"produktas","shop":"parduotuvė arba null","purchaseDate":"YYYY-MM-DD arba null","docNumber":"dok.nr arba null","docType":"Kvitas / čekis|Sąskaita-faktūra (SF)|Banko išrašas|Kita","price":"kaina arba null","warrantyMonths":24}
warrantyMonths: 6/12/24/36/60 pagal produktą. Nežinant – 24.`}
      ]}]})
    });
    if(res.status===401){toast('Sesija pasibaigė, prisijunkite iš naujo');return;}
    if(res.status===403){toast('Patvirtinkite el. paštą, kad naudotumėte AI analizę');return;}
    if(res.status===429){toast('Pasiektas dienos AI analizių limitas (10/d.)');return;}
    if(!res.ok)return;
    const data=await res.json();
    const p=JSON.parse((data.content||[]).map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());
    if(typeof p.name==='string')state.form.name=p.name.slice(0,200);
    if(typeof p.shop==='string')state.form.shop=p.shop.slice(0,100);
    if(typeof p.purchaseDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.purchaseDate))state.form.purchaseDate=p.purchaseDate;
    if(typeof p.docNumber==='string')state.form.docNumber=p.docNumber.slice(0,100);
    if(DOC_TYPES.includes(p.docType))state.form.docType=p.docType;
    const wm=WARRANTY_OPTS.find(o=>o.m===p.warrantyMonths);
    if(wm){state.form.warrantyMonths=p.warrantyMonths;if(state.form.purchaseDate)state.form.warrantyEnd=addMonths(state.form.purchaseDate,p.warrantyMonths);}
    if(p.price)state.form.notes=`Kaina: ${String(p.price).slice(0,50)}`;
  }catch(err){console.warn('AI:',err);}
}

render();
