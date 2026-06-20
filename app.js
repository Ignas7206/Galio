'use strict';
import { auth, db, storage } from './firebase-config.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, sendEmailVerification,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  setDoc, getDoc, getDocs, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  localGetAll, localPut, localDelete, localClear, localDeleteDatabase, genLocalId
} from './local-db.js';

const WORKER_URL    = 'https://long-moon-d252.ltdigitaltools.workers.dev';
const CATEGORIES    = ['Elektronika','Buitinė technika','Avalynė / drabužiai','Baldai','Automobiliai','Kita'];
const DOC_TYPES     = ['Kvitas / čekis','Sąskaita-faktūra (SF)','Banko išrašas','Kita'];
const WARRANTY_OPTS = [{l:'6 mėnesiai',m:6},{l:'1 metai',m:12},{l:'2 metai',m:24},{l:'3 metai',m:36},{l:'5 metai',m:60},{l:'Kita data',m:null}];
const ALLOWED_IMG   = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const MAX_IMG       = 4*1024*1024;
const MAX_PDF       = 5*1024*1024;
const AI_FREE_USES  = 5; // lifetime AI document-analysis uses before Premium is required
const PREMIUM_DAILY_LIMIT   = 30;  // Premium is capped, not unlimited — bounds our Anthropic billing exposure
const PREMIUM_MONTHLY_LIMIT = 300;

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
  qrScanning: false, qrStream: null,
  adminStats: null,
  storageMode: 'local', // 'local' | 'cloud' — driven by userDoc.storageMode once loaded
  migratingStorage: false, // true while toggleStorageMode() is mid-flight; suppresses auto-reattach
  policyChecking: false, policyResult: null, policyResultFor: null,
  theme: localStorage.getItem('garantijos_theme') || 'auto',
};

function applyTheme(){
  const root = document.documentElement;
  root.classList.remove('theme-light','theme-dark');
  if(state.theme==='light') root.classList.add('theme-light');
  else if(state.theme==='dark') root.classList.add('theme-dark');
  // 'auto' = no override class, falls back to prefers-color-scheme in CSS
}
applyTheme();

function emptyForm(){return{name:'',category:'Elektronika',shop:'',purchaseDate:today(),warrantyEnd:addMonths(today(),24),warrantyMonths:24,docType:'Kvitas / čekis',docNumber:'',notes:'',docData:null,docMime:null,docFileName:null,docStoragePath:null,notifyEnabled:true};}
function today(){return new Date().toISOString().slice(0,10);}
function addMonths(d,m){if(!d)return '';const r=new Date(d);r.setMonth(r.getMonth()+m);return r.toISOString().slice(0,10);}

// ── Network status ───────────────────────────────────────────────────────
window.addEventListener('online',()=>{state.online=true;render();});
window.addEventListener('offline',()=>{state.online=false;render();});

// ── Helpers ────────────────────────────────────────────────────────────────
function daysLeft(d){if(!d)return null;return Math.ceil((new Date(d)-new Date())/86400000);}
function fmtDate(d){if(!d)return '—';return new Date(d).toLocaleDateString('lt-LT');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
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
  state.user=user;
  if(user){
    await ensureUserDoc(user);
    attachItemsListener(user.uid);
    startEmailVerifyPoll(user);
  }else{
    if(state.itemsUnsub){state.itemsUnsub();state.itemsUnsub=null;}
    state.items=[];
    state.userDoc=null;
    stopEmailVerifyPoll();
  }
  render();
});

let verifyPollTimer=null;
function startEmailVerifyPoll(user){
  stopEmailVerifyPoll();
  if(user.emailVerified)return;
  verifyPollTimer=setInterval(async ()=>{
    try{
      await user.reload();
      if(user.emailVerified){
        state.user = auth.currentUser;
        stopEmailVerifyPoll();
        toast('El. paštas patvirtintas ✓');
        render();
      }
    }catch(e){}
  }, 5000);
}
function stopEmailVerifyPoll(){ if(verifyPollTimer){clearInterval(verifyPollTimer);verifyPollTimer=null;} }

async function ensureUserDoc(user){
  const ref_ = doc(db,'users',user.uid);
  const snap = await getDoc(ref_);
  if(!snap.exists()){
    const initial = {
      email:user.email, plan:'free', itemCount:0, notifyEnabled:true,
      storageMode:'local', aiUsesRemaining: AI_FREE_USES,
      createdAt: serverTimestamp(),
    };
    await setDoc(ref_, initial);
    state.userDoc = initial;
  }else{
    state.userDoc = snap.data();
    // Backfill fields for accounts created before this field existed
    if(state.userDoc.aiUsesRemaining === undefined){
      try{ await updateDoc(ref_, { aiUsesRemaining: AI_FREE_USES }); }catch(e){}
      state.userDoc.aiUsesRemaining = AI_FREE_USES;
    }
    if(state.userDoc.storageMode === undefined){
      try{ await updateDoc(ref_, { storageMode: 'local' }); }catch(e){}
      state.userDoc.storageMode = 'local';
    }
  }
  state.storageMode = state.userDoc.storageMode || 'local';
  // live updates to plan/itemCount/storageMode/aiUsesRemaining
  onSnapshot(ref_, s=>{
    if(s.exists()){
      const prevMode = state.storageMode;
      state.userDoc = s.data();
      state.storageMode = state.userDoc.storageMode || 'local';
      // If storage mode changed (e.g. user toggled it in Settings), re-attach
      // the items listener pointed at the correct source — but not while
      // toggleStorageMode() is mid-migration, since it manages the listener
      // lifecycle itself and an early auto-reattach here would show a
      // partially-migrated list before the migration loop finishes.
      if(prevMode !== state.storageMode && !state.migratingStorage){
        attachItemsListener(state.user.uid);
      }
      render();
    }
  });
}

// ── Items listener abstraction ──────────────────────────────────────────
// In 'cloud' mode, items live in Firestore and sync in real time.
// In 'local' mode, items live only in this browser's IndexedDB — nothing
// is ever sent to Firestore/Storage for the warranty content itself.
function attachItemsListener(uid){
  if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }
  state.loadingItems = true;

  if(state.storageMode === 'cloud'){
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
  }else{
    // Local mode: just load once from IndexedDB. There's no live listener
    // concept needed since we're the only writer (single device).
    localGetAll(uid).then(items=>{
      items.sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0));
      const wasEmpty = state.loadingItems;
      state.items = items;
      state.loadingItems = false;
      if(wasEmpty && state.items.length===0 && !state.addPulse){
        state.addPulse = true;
        setTimeout(()=>{state.addPulse=false;render();}, 3500);
      }
      render();
    }).catch(err=>{
      state.loadingItems = false;
      console.warn('Local DB load error:', err);
      render();
    });
  }
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
async function doGoogleLogin(){
  state.authError='';state.authInfo='';state.authBusy=true;render();
  try{
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }catch(e){
    if(e.code!=='auth/popup-closed-by-user' && e.code!=='auth/cancelled-popup-request'){
      state.authError=friendlyAuthError(e.code);
    }
  }
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
async function resendVerification(){
  if(!state.user||state.authBusy)return;
  state.authBusy=true;render();
  try{
    await sendEmailVerification(state.user);
    state.authInfo='Laiškas išsiųstas dar kartą. Patikrinkite Spam aplanką.';
    toast('Patvirtinimo laiškas išsiųstas ✓');
  }catch(e){
    toast('Klaida siunčiant laišką, bandykite vėliau');
  }
  state.authBusy=false;render();
}
async function doLogout(){
  if(state.itemsUnsub){state.itemsUnsub();state.itemsUnsub=null;}
  stopEmailVerifyPoll();
  if(state.qrStream){state.qrStream.getTracks().forEach(t=>t.stop());state.qrStream=null;}
  await signOut(auth);
  // Reset all per-session state so a different account logging in on the
  // same device never briefly sees stale data from the previous user.
  state.view='list'; state.addMode=null; state.selected=null;
  state.items=[]; state.userDoc=null; state.storageMode='local';
  state.form=emptyForm(); state.docError='';
  state.policyResult=null; state.policyResultFor=null; state.policyChecking=false;
  state.search=''; state.lightbox=null;
}

// ── Render ─────────────────────────────────────────────────────────────────
function render(){
  const scr=document.getElementById('screen');
  const nav=document.getElementById('bottomNav');

  if(!state.booted){ scr.innerHTML='<div class="center-loader"><div class="spinner"></div></div>'; nav.style.display='none'; return; }
  if(state.qrScanning){ scr.innerHTML=renderQrScanner(); nav.style.display='none'; document.getElementById('qrCloseBtn')?.addEventListener('click',stopQrScanner); return; }
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
  else if(state.view==='settings') html=renderSettings();
  else if(state.view==='admin-stats') html=renderAdminStats();

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
    <div class="login-logo"><span class="shield">🛡️</span><h1>Galio</h1><p>${m==='register'?'Susikurkite paskyrą':m==='reset'?'Atstatykite slaptažodį':'Prisijunkite'}</p></div>

    ${m!=='reset'?`<button id="googleBtn" class="login-btn" style="background:var(--bg3);color:var(--text);display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:8px" ${state.authBusy?'disabled':''}>
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.84 2.07-1.79 2.71v2.26h2.9c1.7-1.56 2.68-3.87 2.68-6.61z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33C2.44 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.95 10.7c-.18-.54-.28-1.11-.28-1.7s.1-1.16.28-1.7V4.97H.96A8.99 8.99 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      Tęsti su Google
    </button>
    ${m!=='login'?`<p style="font-size:11px;color:var(--text3);text-align:center;margin-bottom:14px">Tęsdami sutinkate su <a href="terms.html" target="_blank" style="color:var(--accent)">Naudojimo sąlygomis</a> ir <a href="privacy.html" target="_blank" style="color:var(--accent)">Privatumo politika</a></p>`:''}
    <div class="login-divider">arba</div>`:''}

    <input type="email" id="authEmail" class="login-input" placeholder="El. paštas" autocomplete="email" />
    ${m!=='reset'?`<input type="password" id="authPwd" class="login-input" placeholder="Slaptažodis" autocomplete="${m==='register'?'new-password':'current-password'}" />`:''}
    ${m==='register'?`<input type="password" id="authPwd2" class="login-input" placeholder="Pakartokite slaptažodį" autocomplete="new-password" />`:''}

    ${m==='register'?`<label class="consent-row">
      <input type="checkbox" id="consentCheck" />
      <span>Sutinku su <a href="terms.html" target="_blank">Naudojimo sąlygomis</a> ir <a href="privacy.html" target="_blank">Privatumo politika</a></span>
    </label>`:''}

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
  document.getElementById('googleBtn')?.addEventListener('click',doGoogleLogin);
  document.getElementById('authSubmit')?.addEventListener('click',()=>{
    const email=e1?.value.trim()||'';
    if(state.authMode==='register'){
      const consent = document.getElementById('consentCheck');
      if(!consent?.checked){
        state.authError='Turite sutikti su Naudojimo sąlygomis ir Privatumo politika';
        render();
        return;
      }
      doRegister(email,p1?.value||'',p2?.value||'');
    }
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

  const aiLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;
  const planBanner = !isPremium ? `<div class="plan-banner">
    <i class="ti ti-sparkles"></i>
    <div class="pb-text">${aiLeft>0?`<b>${aiLeft}</b> nemokam${aiLeft===1?'a':'os'} AI analiz${aiLeft===1?'ė':'ės'} liko`:'AI analizės išnaudotos'} · ${state.storageMode==='cloud'?'Cloud saugojimas':'Saugoma šiame įrenginyje'}</div>
    <button id="upgradeBtn">Premium</button>
  </div>`:'';

  const verifyBanner = !state.user.emailVerified ? `<div class="plan-banner" style="background:var(--accent-bg)">
    <i class="ti ti-mail-exclamation" style="color:var(--accent)"></i>
    <div class="pb-text" style="color:var(--accent)">Patvirtinkite el. paštą, kad galėtumėte naudoti AI analizę. ${state.authInfo&&state.authInfo.includes('iš naujo')?esc(state.authInfo):'Patikrinkite Spam aplanką.'}</div>
    <button id="resendVerifyBtn" style="background:var(--accent)" ${state.authBusy?'disabled':''}>${state.authBusy?'...':'Siųsti dar kartą'}</button>
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
    ${verifyBanner}
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
  const isPremium = state.userDoc?.plan==='premium';
  const aiLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;
  const aiExhausted = !isPremium && aiLeft<=0;

  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-x"></i></button><h2>Pridėti garantiją</h2></div>
    <div class="picker-cards">
      <button class="picker-card" id="modePhoto">
        <div class="picker-icon" style="background:var(--accent-bg)"><i class="ti ti-camera" style="color:var(--accent)"></i></div>
        <div><h3>Su dokumentu${aiExhausted?'':' + AI'}</h3><p>${aiExhausted?'AI analizės išnaudotos – galite vis tiek prisegti dokumentą be automatinio atpažinimo':`Nufotografuok arba įkelk – AI ištrauks informaciją automatiškai${!isPremium?` (liko ${aiLeft})`:''}`}</p></div>
      </button>
      <button class="picker-card" id="modeManual">
        <div class="picker-icon" style="background:var(--green-bg)"><i class="ti ti-pencil" style="color:var(--green)"></i></div>
        <div><h3>Rankiniu būdu</h3><p>Suveskite informaciją patys – visada nemokama. Dokumentą galima prisegti be AI</p></div>
      </button>
    </div>
    ${aiExhausted?`<div class="plan-banner" style="margin:0 16px 16px"><i class="ti ti-sparkles"></i><div class="pb-text">Išnaudojote ${AI_FREE_USES} nemokamas AI analizes. Atsinaujinkite į Premium – iki ${PREMIUM_DAILY_LIMIT}/d.</div><button id="upgradeBtn3">Premium</button></div>`:''}
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
  const qrButtonHtml = !f.docData ? `<button type="button" class="qr-link-btn" id="qrScanBtn"><i class="ti ti-qrcode"></i>Nuskaityti QR kodą iš čekio</button>` : '';
  if(hasPdf){
    docAreaHtml=`<div class="doc-preview-pdf"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(f.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">PDF pridėtas</div></div></div>`;
  }else if(hasImg){
    docAreaHtml=`<div style="position:relative"><img class="doc-preview-img" id="docThumb" src="${esc(f.docData)}" alt="" /><div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.55);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ti ti-zoom-in" style="font-size:14px;color:#fff"></i></div></div>`;
  }else{
    docAreaHtml=`${qrButtonHtml}<label class="doc-drop-zone" for="docInput">
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

  const policySection = `<div class="detail-section">
    ${state.policyChecking ? `<div class="analyzing-row" style="justify-content:center"><div class="spinner"></div><span style="font-size:13px;color:var(--text2)">AI tikrina gamintojo garantijos politiką...</span></div>`
      : state.policyResult && state.policyResultFor===item.id ? `<div class="plan-banner" style="background:var(--accent-bg);align-items:flex-start">
          <i class="ti ti-info-circle" style="color:var(--accent);margin-top:2px"></i>
          <div class="pb-text" style="color:var(--text)"><b style="color:var(--accent)">AI pasiūlymas (patikrinkite patys):</b><br/>${esc(state.policyResult)}</div>
        </div>`
      : `<button class="qr-link-btn" id="checkPolicyBtn"><i class="ti ti-sparkles"></i>Patikrinti gamintojo garantijos terminą su AI</button>`}
  </div>`;

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
    ${policySection}
    <div class="detail-section"><button class="delete-btn" id="deleteBtn2"><i class="ti ti-trash"></i>Ištrinti įrašą</button></div>
    <div style="height:8px"></div>
  </div>`;
}

// ── Settings ───────────────────────────────────────────────────────────────
function renderSettings(){
  const u = state.user;
  const isPremium = state.userDoc?.plan==='premium';
  const isAdmin = state.userDoc?.role==='admin';
  const notifyOn = state.userDoc?.notifyEnabled !== false; // default true
  const aiLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;
  const isCloud = state.storageMode==='cloud';
  const initials = (u.displayName||u.email||'?').trim().charAt(0).toUpperCase();
  const avatarHtml = u.photoURL
    ? `<img src="${esc(u.photoURL)}" alt="" />`
    : initials;

  return `<div>
    <div class="page-header"><span class="page-title">Nustatymai</span></div>

    <div class="settings-profile">
      <div class="settings-avatar">${avatarHtml}</div>
      <div class="settings-profile-info">
        <div class="settings-profile-email">${esc(u.displayName||u.email)}</div>
        <div class="settings-profile-plan${isPremium?' premium':''}">
          ${isPremium?'<i class="ti ti-crown" style="font-size:13px"></i> Premium narys':`Nemokamas planas · ${state.items.length} įrašų`}
        </div>
      </div>
    </div>

    ${!isPremium ? `<div class="plan-banner" style="margin:0 16px 16px">
      <i class="ti ti-crown"></i>
      <div class="pb-text">Atsinaujinkite į Premium – iki ${PREMIUM_DAILY_LIMIT} AI analizių/d. ir cloud sinchronizacija</div>
      <button id="upgradeBtnSettings">Premium</button>
    </div>` : ''}

    <p class="form-label-section" style="margin:0 16px 8px">Saugojimo būdas</p>
    <div class="form-section" style="margin:0 16px 8px">
      <div class="settings-row">
        <i class="ti ti-${isCloud?'cloud':'device-mobile'} row-icon"></i>
        <div class="settings-row-label">${isCloud?'Cloud sinchronizacija':'Saugoma šiame įrenginyje'}<small>${isCloud?'Matoma iš bet kurio įrenginio · reikia Premium':'Duomenys lieka tik šiame telefone, nemokama'}</small></div>
        <button class="toggle-switch${isCloud?' on':''}" id="storageModeToggle"><div class="knob"></div></button>
      </div>
    </div>
    <p style="font-size:11.5px;color:var(--text3);padding:0 16px 20px;line-height:1.5">
      ${isCloud?'Cloud režimas reikalauja Premium. Jei atsinaujinsite atgal į Free, įjunkite šį nustatymą atgal į lokalų.':'Norėdami sinchronizuoti duomenis tarp įrenginių, įjunkite cloud saugojimą (reikalinga Premium prenumerata).'}
    </p>

    <p class="form-label-section" style="margin:0 16px 8px">AI analizė</p>
    <div class="form-section" style="margin:0 16px 20px">
      ${isPremium ? `
      <div class="detail-row" style="padding:13px 16px">
        <i class="ti ti-sparkles" style="font-size:18px;color:var(--text3);width:20px"></i>
        <span class="dr-label">Šiandien</span>
        <span class="dr-val">${state.userDoc?.aiDayKey===new Date().toISOString().slice(0,10)?(state.userDoc?.aiDayCount||0):0}/${PREMIUM_DAILY_LIMIT}</span>
      </div>
      <div class="detail-row" style="padding:13px 16px">
        <i class="ti ti-calendar" style="font-size:18px;color:var(--text3);width:20px"></i>
        <span class="dr-label">Šį mėnesį</span>
        <span class="dr-val">${state.userDoc?.aiMonthKey===new Date().toISOString().slice(0,7)?(state.userDoc?.aiMonthCount||0):0}/${PREMIUM_MONTHLY_LIMIT}</span>
      </div>` : `
      <div class="detail-row" style="padding:13px 16px">
        <i class="ti ti-sparkles" style="font-size:18px;color:var(--text3);width:20px"></i>
        <span class="dr-label">Liko nemokamų analizių</span>
        <span class="dr-val">${aiLeft}/${AI_FREE_USES}</span>
      </div>`}
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Išvaizda</p>
    <div class="form-section" style="margin:0 16px 20px;padding:14px 16px">
      <div class="theme-picker">
        <button class="theme-opt${state.theme==='auto'?' active':''}" data-theme="auto"><i class="ti ti-device-mobile"></i><span>Auto</span></button>
        <button class="theme-opt${state.theme==='light'?' active':''}" data-theme="light"><i class="ti ti-sun"></i><span>Šviesi</span></button>
        <button class="theme-opt${state.theme==='dark'?' active':''}" data-theme="dark"><i class="ti ti-moon"></i><span>Tamsi</span></button>
      </div>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Pranešimai</p>
    <div class="form-section" style="margin:0 16px 20px">
      <div class="settings-row">
        <i class="ti ti-bell row-icon"></i>
        <div class="settings-row-label">Garantijos baigiasi<small>Priminimas likus 30 dienų</small></div>
        <button class="toggle-switch${notifyOn?' on':''}" id="notifyToggle"><div class="knob"></div></button>
      </div>
    </div>

    ${isAdmin ? `<p class="form-label-section" style="margin:0 16px 8px">Administravimas</p>
    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable" id="adminPanelBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-chart-bar row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Admin statistika</span><i class="ti ti-chevron-right" style="color:var(--text3)"></i>
      </button>
    </div>` : ''}

    <p class="form-label-section" style="margin:0 16px 8px">Paskyra</p>
    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable" id="changePwdBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-lock row-icon"></i><span class="settings-row-label">Pakeisti slaptažodį</span><i class="ti ti-chevron-right" style="color:var(--text3)"></i>
      </button>
      <button class="settings-row tappable" id="settingsLogoutBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-logout row-icon"></i><span class="settings-row-label">Atsijungti</span>
      </button>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Pagalba</p>
    <div class="form-section" style="margin:0 16px 20px">
      <a class="settings-row tappable" id="helpMailLink" href="#" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-help-circle row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Susisiekti su pagalba<small>ltdigitaltools@gmail.com</small></span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Teisinė informacija</p>
    <div class="form-section" style="margin:0 16px 20px">
      <a class="settings-row tappable" href="privacy.html" target="_blank" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-shield-lock row-icon"></i><span class="settings-row-label">Privatumo politika</span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
      <a class="settings-row tappable" href="terms.html" target="_blank" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-file-text row-icon"></i><span class="settings-row-label">Naudojimo sąlygos</span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
    </div>

    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable danger" id="deleteAccountBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-trash row-icon"></i><span class="settings-row-label">Ištrinti paskyrą</span>
      </button>
    </div>

    <p style="text-align:center;font-size:11px;color:var(--text3);padding:0 16px 24px">Galio v1.0 · Duomenys saugomi debesyje</p>
  </div>`;
}

// ── Admin stats ────────────────────────────────────────────────────────────
function renderAdminStats(){
  const s = state.adminStats;
  return `<div>
    <div class="page-header-sm">
      <button class="back-btn" id="adminBackBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>Admin statistika</h2>
    </div>
    ${!s ? `<div class="empty-state"><div class="spinner" style="margin:0 auto"></div><p style="margin-top:16px">Kraunama...</p></div>` : `
    <div class="stats-row" style="padding:16px">
      <div class="stat-tile"><div class="n">${s.totalUsers}</div><div class="l">Vartotojų</div></div>
      <div class="stat-tile"><div class="n" style="color:var(--gold)">${s.premiumUsers}</div><div class="l">Premium</div></div>
      <div class="stat-tile"><div class="n" style="color:var(--green)">${s.activeUsers}</div><div class="l">Su įrašais</div></div>
    </div>
    <div class="detail-section">
      <div class="detail-rows">
        <div class="detail-row"><i class="ti ti-receipt"></i><span class="dr-label">Viso garantijų įrašų</span><span class="dr-val">${s.totalItems}</span></div>
        <div class="detail-row"><i class="ti ti-mail-check"></i><span class="dr-label">Patvirtintų el. paštų</span><span class="dr-val">${s.verifiedUsers}/${s.totalUsers}</span></div>
        <div class="detail-row"><i class="ti ti-calendar-plus"></i><span class="dr-label">Naujų per 7 d.</span><span class="dr-val">${s.newLast7Days}</span></div>
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:var(--text3);padding:0 16px 24px">Rodomi tik agreguoti, anoniminiai skaičiai. Vartotojų garantijų turinys niekada nerodomas.</p>
    `}
  </div>`;
}

async function loadAdminStats(){
  state.adminStats = null;
  render();
  try{
    const snap = await getDocs(collection(db,'users'));
    let totalUsers=0, premiumUsers=0, activeUsers=0, totalItems=0, verifiedUsers=0, newLast7Days=0;
    const weekAgoMs = Date.now() - 7*86400000;
    snap.forEach(d=>{
      const u = d.data();
      totalUsers++;
      if(u.plan==='premium') premiumUsers++;
      if((u.itemCount||0)>0) activeUsers++;
      totalItems += (u.itemCount||0);
      // emailVerified isn't stored in Firestore by default; this is an
      // approximation based on whatever we choose to track. For now we
      // skip it unless present.
      if(u.emailVerified) verifiedUsers++;
      if(u.createdAt && u.createdAt.toMillis && u.createdAt.toMillis() > weekAgoMs) newLast7Days++;
    });
    state.adminStats = { totalUsers, premiumUsers, activeUsers, totalItems, verifiedUsers, newLast7Days };
  }catch(e){
    toast('Nepavyko įkelti statistikos');
    state.view='settings';
  }
  render();
}


function attachEvents(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  const onAll=(sel,ev,fn)=>document.querySelectorAll(sel).forEach(el=>el.addEventListener(ev,fn));

  document.getElementById('navList')?.addEventListener('click',()=>{state.view='list';render();});
  document.getElementById('navSearch')?.addEventListener('click',()=>{state.view='search';render();});
  document.getElementById('navSettings')?.addEventListener('click',()=>{state.view='settings';render();});

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
  on('resendVerifyBtn','click',resendVerification);
  on('upgradeBtn','click',()=>toast('Premium netrukus! 🚀'));
  on('upgradeBtn3','click',()=>toast('Premium netrukus! 🚀'));
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
  on('qrScanBtn','click',startQrScanner);
  on('removeDoc','click',()=>{state.form.docData=null;state.form.docMime=null;state.form.docFileName=null;state.docError='';render();});
  on('docThumb','click',()=>{if(state.form.docData)state.lightbox=state.form.docData;render();});
  on('docImg','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it?.docUrl)state.lightbox=it.docUrl;render();});

  on('saveBtn','click',saveItem);
  on('deleteBtn','click',()=>deleteItem(state.selected));
  on('deleteBtn2','click',()=>deleteItem(state.selected));
  on('checkPolicyBtn','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it)checkPolicy(it);});

  // Settings
  on('upgradeBtnSettings','click',()=>toast('Premium netrukus! 🚀'));
  onAll('.theme-opt','click',e=>{
    const t=e.currentTarget.dataset.theme;
    state.theme=t; localStorage.setItem('garantijos_theme',t); applyTheme(); render();
  });
  on('notifyToggle','click',toggleNotify);
  on('storageModeToggle','click',toggleStorageMode);
  on('changePwdBtn','click',()=>{
    if(!state.user.email){toast('Google paskyroms slaptažodžio keisti nereikia');return;}
    sendPasswordResetEmail(auth,state.user.email)
      .then(()=>toast('Nuoroda slaptažodžiui keisti išsiųsta į el. paštą'))
      .catch(()=>toast('Klaida siunčiant laišką'));
  });
  on('settingsLogoutBtn','click',()=>{if(confirm('Atsijungti?'))doLogout();});
  on('deleteAccountBtn','click',confirmDeleteAccount);
  on('adminPanelBtn','click',()=>{state.view='admin-stats';loadAdminStats();});
  on('helpMailLink','click',e=>{
    e.preventDefault();
    const u = state.user;
    const plan = state.userDoc?.plan || 'free';
    const mode = state.storageMode || 'local';
    const body = encodeURIComponent(
      `\n\n---\nDiagnostinė informacija (nereikia trinti, padeda greičiau išspręsti):\nEl. paštas: ${u?.email||'—'}\nVartotojo ID: ${u?.uid||'—'}\nPlanas: ${plan}\nSaugojimo būdas: ${mode}\nEl. paštas patvirtintas: ${u?.emailVerified?'taip':'ne'}\nVersija: Galio v1.0`
    );
    const subject = encodeURIComponent('Galio – pagalbos užklausa');
    window.location.href = `mailto:ltdigitaltools@gmail.com?subject=${subject}&body=${body}`;
  });
  on('adminBackBtn','click',()=>{state.view='settings';render();});
}

function syncSave(){const b=document.getElementById('saveBtn');if(b)b.disabled=!state.form.name.trim();}

async function deleteItem(id){
  if(!confirm('Ištrinti šį įrašą?'))return;
  const item=state.items.find(i=>i.id===id);

  try{
    if(state.storageMode==='cloud'){
      await deleteDoc(doc(db,'users',state.user.uid,'warranties',id));
      await updateDoc(doc(db,'users',state.user.uid),{itemCount:increment(-1)});
      if(item?.docStoragePath){
        try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){console.warn('Storage delete failed:',e);}
      }
      // Cloud mode re-syncs via onSnapshot automatically.
    }else{
      await localDelete(state.user.uid, id);
      state.items = state.items.filter(i=>i.id!==id);
    }
    toast('Ištrinta');
  }catch(e){ toast('Klaida trinant: '+(e.message||'')); }
  state.view='list';render();
}

async function saveItem(){
  if(!state.form.name.trim())return;
  const f=state.form;
  const isCloud = state.storageMode==='cloud';

  const payload={
    name:f.name.trim().slice(0,200), category:f.category, shop:(f.shop||'').slice(0,100),
    purchaseDate:f.purchaseDate, warrantyEnd:f.warrantyEnd, warrantyMonths:f.warrantyMonths,
    docType:f.docType, docNumber:(f.docNumber||'').slice(0,100), notes:(f.notes||'').slice(0,1000),
    notifyEnabled:true, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
    createdAtMs: Date.now(),
  };

  try{
    if(isCloud){
      const fullPayload = { ...payload, createdAt: serverTimestamp() };
      const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'), fullPayload);
      await updateDoc(doc(db,'users',state.user.uid),{itemCount:increment(1)});

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
    }else{
      // Local mode: everything (including the document image/pdf as base64)
      // stays in IndexedDB on this device only. Nothing touches Firestore
      // or Storage for the warranty content itself.
      const localItem = {
        ...payload,
        id: genLocalId(),
        docUrl: f.docData || null, // for local mode we just reuse the data URL directly as "docUrl"
        docMime: f.docMime || null,
        docFileName: f.docFileName || null,
      };
      await localPut(state.user.uid, localItem);
      state.items.unshift(localItem);
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
// ── QR scanner ─────────────────────────────────────────────────────────────
// Lithuanian e-receipts (i.MAS) typically encode a URL like:
// https://www.vmi.lt/cms/.../kvitas?... with date/sum params, or a raw
// pipe/semicolon-delimited string containing date and amount. We try to
// extract a date and amount from whatever pattern appears.
function renderQrScanner(){
  return `<div class="qr-scanner" id="qrScannerOverlay">
    <div class="qr-scanner-bar">
      <button class="back-btn" id="qrCloseBtn"><i class="ti ti-x"></i></button>
    </div>
    <video id="qrVideo" autoplay playsinline muted></video>
    <div class="qr-scanner-overlay" id="qrOverlayBox"><div class="qr-scan-line" id="qrScanLine"></div></div>
    <div class="qr-scanner-status" id="qrStatus"><i class="ti ti-circle-check"></i><span>QR kodas aptiktas!</span></div>
    <div class="qr-scanner-hint" id="qrHint">Nukreipkite kamerą į QR kodą ant čekio</div>
  </div>`;
}

async function startQrScanner(){
  state.qrScanning = true;
  render();
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    state.qrStream = stream;
    const video = document.getElementById('qrVideo');
    if(!video){ stopQrScanner(); return; }
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let detected = false;
    let frameCount = 0;

    const scanFrame = () => {
      if(!state.qrScanning || detected) return;
      if(!video.videoWidth){ requestAnimationFrame(scanFrame); return; }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR ? window.jsQR(imageData.data, imageData.width, imageData.height) : null;

      frameCount++;
      // Subtle "scanning actively" hint update every ~30 frames so the user
      // knows the loop is alive even before anything is found.
      if(frameCount % 30 === 0){
        const hint = document.getElementById('qrHint');
        if(hint) hint.textContent = 'Ieškoma QR kodo...';
      }

      if(code && code.data){
        detected = true;
        showQrDetected();
        setTimeout(()=> handleQrResult(code.data), 550);
        return;
      }
      requestAnimationFrame(scanFrame);
    };
    requestAnimationFrame(scanFrame);
  }catch(e){
    toast('Nepavyko pasiekti kameros');
    stopQrScanner();
  }
}

function showQrDetected(){
  if(navigator.vibrate) navigator.vibrate(15);
  const box = document.getElementById('qrOverlayBox');
  const status = document.getElementById('qrStatus');
  const line = document.getElementById('qrScanLine');
  const hint = document.getElementById('qrHint');
  if(box) box.classList.add('detected');
  if(status) status.classList.add('show','success');
  if(line) line.style.display = 'none';
  if(hint) hint.textContent = 'Apdorojama...';
}

function stopQrScanner(){
  state.qrScanning = false;
  if(state.qrStream){
    state.qrStream.getTracks().forEach(t=>t.stop());
    state.qrStream = null;
  }
  render();
}

function handleQrResult(text){
  stopQrScanner();

  // Try to extract a date (YYYY-MM-DD or DD.MM.YYYY) from the QR payload
  let foundDate = null;
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  const ltMatch = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if(isoMatch){
    foundDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  } else if(ltMatch){
    foundDate = `${ltMatch[3]}-${ltMatch[2]}-${ltMatch[1]}`;
  }

  // Try to extract an amount (e.g. "12.50" near "EUR" or "suma")
  let foundAmount = null;
  const amountMatch = text.match(/(\d+[.,]\d{2})\s*(EUR|€)?/i);
  if(amountMatch) foundAmount = amountMatch[1].replace(',', '.');

  if(foundDate){
    state.form.purchaseDate = foundDate;
    if(state.form.warrantyMonths) state.form.warrantyEnd = addMonths(foundDate, state.form.warrantyMonths);
  }
  if(foundAmount){
    state.form.notes = [state.form.notes, `Kaina (iš QR): ${foundAmount} €`].filter(Boolean).join('\n');
  }
  if(!foundDate && !foundAmount){
    state.form.docNumber = text.slice(0,100);
    toast('QR nuskaitytas, bet datos neatpažinau – patikrinkite duomenis rankiniu būdu');
  } else {
    toast('QR duomenys įkelti ✓');
  }
  render();
}
// Resizes to max 1600px on the longest side and re-encodes as JPEG.
// Typical phone photos (3-8MB) shrink to ~150-400KB while staying readable
// for both humans and the AI receipt parser.
function compressImage(dataUrl, maxDim=1600, quality=0.82){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      let{width,height}=img;
      if(width>maxDim||height>maxDim){
        if(width>height){ height=Math.round(height*(maxDim/width)); width=maxDim; }
        else{ width=Math.round(width*(maxDim/height)); height=maxDim; }
      }
      const canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');
      ctx.drawImage(img,0,0,width,height);
      const out=canvas.toDataURL('image/jpeg',quality);
      resolve(out);
    };
    img.onerror=()=>reject(new Error('Nepavyko apdoroti nuotraukos'));
    img.src=dataUrl;
  });
}

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
    const dataUrl=ev.target.result;
    if(isPdf){
      const b64=dataUrl.split(',')[1];
      state.form.docData=b64;state.form.docMime='application/pdf';state.form.docFileName=file.name;render();
    }else{
      try{
        // Verify it's a real loadable image first
        await new Promise((res,rej)=>{ const t=new Image(); t.onload=res; t.onerror=rej; t.src=dataUrl; });
        const compressed = await compressImage(dataUrl);
        const compB64 = compressed.split(',')[1];
        state.form.docData=compressed; state.form.docMime='image/jpeg'; state.form.docFileName=file.name.replace(/\.[^.]+$/,'.jpg');
        if(state.addMode==='photo'){state.analyzing=true;render();await analyzeDoc(compB64,'image/jpeg');state.analyzing=false;}
        render();
      }catch(err){
        state.docError='Failas neatpažintas kaip nuotrauka';render();
      }
    }
  };
  reader.readAsDataURL(file);
}

async function checkPolicy(item){
  state.policyChecking = true; state.policyResult=null; render();
  try{
    const idToken = await state.user.getIdToken();
    const res = await fetch(WORKER_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body: JSON.stringify({
        model:'claude-sonnet-4-6', max_tokens:500, use_search:true,
        messages:[{role:'user', content:[{type:'text', text:
          `Kiek laiko gamintojas paprastai suteikia garantiją šiam produktui: "${item.name}"${item.shop?` (pirkta iš ${item.shop})`:''}? `+
          `Atsakyk lietuviškai, TRUMPAI (2-3 sakiniai), nurodyk tipinį garantijos terminą ir paminėk, kad tikslią informaciją reikia patikrinti gamintojo svetainėje ar pirkimo dokumentuose, nes ji gali skirtis pagal modelį ir šalį.`
        }]}]
      })
    });
    if(res.status===403){ toast('Patvirtinkite el. paštą šiai funkcijai'); state.policyChecking=false; render(); return; }
    if(res.status===429){ toast('Pasiektas dienos AI limitas'); state.policyChecking=false; render(); return; }
    if(!res.ok) throw new Error('request failed');
    const data = await res.json();
    const text = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join(' ').trim();
    state.policyResult = text || 'Nepavyko gauti atsakymo. Patikrinkite gamintojo svetainę.';
    state.policyResultFor = item.id;
  }catch(e){
    toast('Nepavyko patikrinti – bandykite vėliau');
  }
  state.policyChecking = false;
  render();
}

// ── Settings actions ───────────────────────────────────────────────────────
async function toggleNotify(){
  if(!state.user)return;
  const current = state.userDoc?.notifyEnabled !== false;
  try{
    await updateDoc(doc(db,'users',state.user.uid), { notifyEnabled: !current });
  }catch(e){
    toast('Nepavyko išsaugoti nustatymo');
  }
}

async function toggleStorageMode(){
  if(!state.user)return;
  const isPremium = state.userDoc?.plan==='premium';
  const wantsCloud = state.storageMode !== 'cloud';

  if(wantsCloud && !isPremium){
    toast('Cloud saugojimui reikalingas Premium planas');
    return;
  }

  const confirmMsg = wantsCloud
    ? `Perkelti ${state.items.length} įrašų į cloud? Jie bus pasiekiami iš bet kurio įrenginio.`
    : `Perkelti ${state.items.length} įrašų į šį įrenginį? Jie nebebus matomi kituose įrenginiuose.`;
  if(state.items.length>0 && !confirm(confirmMsg)) return;

  const itemsToMigrate = state.items.slice();
  toast('Perkeliama...');
  state.migratingStorage = true;

  try{
    if(wantsCloud){
      // IMPORTANT ORDERING: Firestore security rules only allow creating
      // warranty documents when the user's profile already has
      // storageMode == 'cloud' (requiresCloudPlan() check) — this stops a
      // Free/local account from writing to the cloud subcollection by
      // mistake or tampering. That means we must flip storageMode (and set
      // the FINAL itemCount we expect to end up with) on the profile FIRST,
      // in one atomic update matching rule variant D, before creating any
      // warranty docs — otherwise every create in the loop below would be
      // rejected by requiresCloudPlan().
      await updateDoc(doc(db,'users',state.user.uid), {
        itemCount: itemsToMigrate.length,
        storageMode: 'cloud',
      });

      // Stop the items listener during migration so the live onSnapshot
      // triggered by the storageMode flip above doesn't race with us
      // rewriting state.items mid-loop — we'll re-attach it once done.
      if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }

      for(const item of itemsToMigrate){
        const payload = {
          name:item.name, category:item.category, shop:item.shop||'',
          purchaseDate:item.purchaseDate, warrantyEnd:item.warrantyEnd, warrantyMonths:item.warrantyMonths,
          docType:item.docType, docNumber:item.docNumber||'', notes:item.notes||'',
          notifyEnabled:true, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
          createdAtMs:item.createdAtMs||Date.now(), createdAt:serverTimestamp(),
        };
        const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'), payload);
        if(item.docUrl && item.docMime){
          try{
            const ext = item.docMime==='application/pdf'?'pdf':(item.docMime.split('/')[1]||'jpg');
            const path = `users/${state.user.uid}/documents/${docRef.id}.${ext}`;
            const b64 = item.docMime==='application/pdf' ? item.docUrl : item.docUrl.split(',')[1];
            const blob = base64ToBlob(b64, item.docMime);
            await uploadBytes(ref(storage,path), blob, {contentType:item.docMime});
            const url = await getDownloadURL(ref(storage,path));
            await updateDoc(docRef, { docUrl:url, docMime:item.docMime, docFileName:item.docFileName, docStoragePath:path });
          }catch(e){ console.warn('Migration upload failed for item:', item.id, e); }
        }
      }
      await localClear(state.user.uid);
      attachItemsListener(state.user.uid);
    }else{
      // cloud -> local: download each cloud item's doc (if any) as base64
      // and store in IndexedDB, then delete the cloud copies.
      // Stop the live Firestore listener first — otherwise each deleteDoc
      // in the loop below triggers onSnapshot mid-migration, briefly
      // showing a half-migrated list in the UI.
      if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }

      for(const item of itemsToMigrate){
        let localDocUrl = null;
        if(item.docUrl){
          try{
            const resp = await fetch(item.docUrl);
            const blob = await resp.blob();
            localDocUrl = await new Promise((res,rej)=>{
              const r = new FileReader();
              r.onload = ()=>res(r.result);
              r.onerror = rej;
              r.readAsDataURL(blob);
            });
          }catch(e){ console.warn('Migration download failed for item:', item.id, e); }
        }
        const localItem = {
          id: genLocalId(), name:item.name, category:item.category, shop:item.shop||'',
          purchaseDate:item.purchaseDate, warrantyEnd:item.warrantyEnd, warrantyMonths:item.warrantyMonths,
          docType:item.docType, docNumber:item.docNumber||'', notes:item.notes||'',
          notifyEnabled:true, createdAtMs:item.createdAtMs||Date.now(),
          docUrl: localDocUrl, docMime: localDocUrl?item.docMime:null, docFileName: localDocUrl?item.docFileName:null,
        };
        await localPut(state.user.uid, localItem);
        if(item.docStoragePath){
          try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){}
        }
        try{ await deleteDoc(doc(db,'users',state.user.uid,'warranties',item.id)); }catch(e){}
      }
      await updateDoc(doc(db,'users',state.user.uid), {
        itemCount: 0,
        storageMode: 'local',
      });
      attachItemsListener(state.user.uid);
    }
    toast('Perkelta ✓');
  }catch(e){
    console.warn('Storage mode migration error:', e);
    toast('Klaida perkeliant duomenis – patikrinkite sąrašą, kai kurie įrašai gali būti nepilnai perkelti');
  }finally{
    state.migratingStorage = false;
  }
}

async function confirmDeleteAccount(){
  if(!confirm('Ar tikrai norite ištrinti paskyrą? Visi jūsų duomenys (garantijos, nuotraukos) bus negrįžtamai ištrinti.'))return;
  if(!confirm('Šis veiksmas negrįžtamas. Tikrai tęsti?'))return;

  const uid = state.user.uid;
  const items = state.items.slice();
  const wasCloud = state.storageMode === 'cloud';

  // Firestore/Storage security rules require request.auth.uid to match —
  // once the Auth account is deleted, request.auth becomes null and these
  // calls would be rejected. So we must delete the data WHILE still
  // authenticated, then delete the Auth account last.
  let cleanupFailed = false;

  if(wasCloud){
    for(const item of items){
      try{ await deleteDoc(doc(db,'users',uid,'warranties',item.id)); }
      catch(e){ cleanupFailed = true; }
      if(item.docStoragePath){
        try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){ /* non-fatal */ }
      }
    }
  }
  try{ await deleteDoc(doc(db,'users',uid)); }catch(e){ cleanupFailed = true; }

  if(cleanupFailed){
    toast('Nepavyko pilnai ištrinti duomenų – bandykite vėliau dar kartą');
    return; // don't delete the Auth account if cleanup was incomplete,
            // otherwise any leftover docs become permanently unreachable
  }

  // Local-mode (or already-migrated) IndexedDB data belongs to this device,
  // not Firestore — clean it up regardless of which mode was active, since
  // a user might have switched modes earlier and left orphaned local data.
  try{ await localDeleteDatabase(uid); }catch(e){ /* best-effort */ }

  try{
    await state.user.delete();
    toast('Paskyra ištrinta');
  }catch(e){
    if(e.code==='auth/requires-recent-login'){
      toast('Duomenys ištrinti. Dėl saugumo prisijunkite iš naujo, kad pabaigtumėte paskyros trynimą.');
      await doLogout();
    }else{
      toast('Duomenys ištrinti, bet paskyros pašalinti nepavyko – susisiekite su mumis');
    }
  }
}

// Premium isn't truly "unlimited" — that would mean unbounded exposure on
// our own Anthropic billing if a Premium account is compromised, scripted,
// or simply misused. Premium gets a generous but hard cap instead.
async function analyzeDoc(b64,mime){
  const isPremium = state.userDoc?.plan==='premium';
  const usesLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;

  if(!isPremium && usesLeft<=0){
    toast(`Išnaudojote ${AI_FREE_USES} nemokamas AI analizes. Atsinaujinkite į Premium.`);
    return;
  }

  // Premium: check (and lazily reset) the day/month counters client-side
  // before calling out, so we don't waste a Worker round-trip when we
  // already know the cap is hit. The Worker/Firestore rules still enforce
  // this server-side too — this is just the fast local pre-check.
  if(isPremium){
    const today = new Date().toISOString().slice(0,10);
    const month = today.slice(0,7);
    const dayKey = state.userDoc?.aiDayKey;
    const monthKey = state.userDoc?.aiMonthKey;
    const dayCount = dayKey===today ? (state.userDoc?.aiDayCount||0) : 0;
    const monthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0) : 0;
    if(dayCount >= PREMIUM_DAILY_LIMIT){
      toast(`Pasiektas dienos limitas (${PREMIUM_DAILY_LIMIT}/d.). Pabandykite rytoj.`);
      return;
    }
    if(monthCount >= PREMIUM_MONTHLY_LIMIT){
      toast(`Pasiektas mėnesio limitas (${PREMIUM_MONTHLY_LIMIT}/mėn.).`);
      return;
    }
  }

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
    if(res.status===429){toast('Pasiektas AI analizių limitas');return;}
    if(!res.ok)return;

    // Successful call — consume quota. Free: lifetime counter -1.
    // Premium: bump day/month counters (resetting them first if the
    // day/month rolled over since the last recorded use).
    if(!isPremium){
      try{ await updateDoc(doc(db,'users',state.user.uid), { aiUsesRemaining: increment(-1) }); }
      catch(e){ console.warn('Failed to decrement AI usage counter:', e); }
    }else{
      const today = new Date().toISOString().slice(0,10);
      const month = today.slice(0,7);
      const dayKey = state.userDoc?.aiDayKey;
      const monthKey = state.userDoc?.aiMonthKey;
      const update = {
        aiDayKey: today,
        aiDayCount: dayKey===today ? increment(1) : 1,
        aiMonthKey: month,
        aiMonthCount: monthKey===month ? increment(1) : 1,
      };
      try{ await updateDoc(doc(db,'users',state.user.uid), update); }
      catch(e){ console.warn('Failed to bump Premium AI usage counters:', e); }
    }

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
