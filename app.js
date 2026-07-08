'use strict';
import { auth, db, storage } from './firebase-config.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, sendEmailVerification,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  setDoc, getDoc, getDocs, getDocsFromServer, serverTimestamp, increment
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
const MAX_IMG       = 10*1024*1024; // phone cameras often produce 6-12MB photos; compression brings this down before upload
const MAX_PDF       = 5*1024*1024;
const AI_FREE_USES  = 5; // lifetime AI document-analysis uses before Premium is required
const PREMIUM_DAILY_LIMIT   = 30;  // Premium is capped, not unlimited — bounds our Anthropic billing exposure
const PREMIUM_MONTHLY_LIMIT = 300;

let state = {
  booted:false, user:null, userDoc:null, loadingItems:false,
  view:'list', addMode:null,
  items:[], itemsUnsub:null,
  selected:null,
  search:'', filterCat:'Visos', sortBy:'newest', sortDropOpen:false, catDropOpen:false,
  form:emptyForm(),
  lightbox:null, analyzing:false, uploadPct:null,
  authMode:'login', authError:'', authInfo:'', authBusy:false,
  authEmail:'', authPwd:'', authPwd2:'',
  docError:'', showWarranty:false,
  online: navigator.onLine,
  onboardSlide: 0,
  showOnboarding: !localStorage.getItem('galio_onboarded') && !localStorage.getItem('garantijos_onboarded'),
  swipe: { id:null, startX:0, currentX:0, dragging:false },
  addPulse: false,
  qrScanning: false, qrStream: null,
  aiRetriesUsedThisItem: 0, // resets each time the add-form is freshly opened; max 2 scan attempts before quota is charged on save
  pendingAiCharge: false, // true once a scan succeeds — saveItem() consumes one quota unit if this is set
  aiMultiItems: [],
  multiItemReceipt: null,
  multiEditIdx: null,
  aiNameReview: false,
  editItemId: null,
  notifModal: null,
  appDialog: null,
  _lastNotifDays: null,
  _lastReturnNotifDays: null,
  _lastSavedId: null,
  adminStats: null,
  storageMode: 'local', // 'local' | 'cloud' — driven by userDoc.storageMode once loaded
  migratingStorage: false, // true while toggleStorageMode() is mid-flight; suppresses auto-reattach
  storageError: '',
  policyChecking: false, policyResult: null, policyResultFor: null,
  contactBusy: false, contactSent: false, contactError: '', contactDraft: '',
  adminUsers: [],
  theme: localStorage.getItem('galio_theme') || 'auto',
};
try{
  const savedNotifPrefs = JSON.parse(localStorage.getItem('galio_notif_prefs') || '{}');
  if(Array.isArray(savedNotifPrefs.warranty)) state._lastNotifDays = savedNotifPrefs.warranty;
  if(Array.isArray(savedNotifPrefs.return)) state._lastReturnNotifDays = savedNotifPrefs.return;
}catch(e){}

function applyTheme(){
  const root = document.documentElement;
  root.classList.remove('theme-light','theme-dark');
  if(state.theme==='light') root.classList.add('theme-light');
  else if(state.theme==='dark') root.classList.add('theme-dark');
  // 'auto' = no override class, falls back to prefers-color-scheme in CSS
}
applyTheme();

function emptyForm(){return{name:'',category:'',shop:'',purchaseDate:'',warrantyEnd:'',warrantyMonths:24,docType:'Kvitas / čekis',docNumber:'',notes:'',docData:null,docMime:null,docFileName:null,docStoragePath:null,notifyEnabled:true,warrantyAppliesWarning:false,qualityWarning:null};}

// Admin, tester ir friend vartotojai automatiškai gauna premium teises
function isPremiumUser(){ return ['premium','tester','friend'].includes(state.userDoc?.plan) || state.userDoc?.role==='admin'; }

// Resets everything tied to "adding one new item" — the form fields plus
// the per-item AI retry counter and pending-charge flag. Centralized here
// so every entry point (tap +, long-press +, picker) stays in sync.
function startNewItem(mode){
  state.form=emptyForm();
  state.docError='';
  state.addMode=mode;
  state.view='add';
  state.aiRetriesUsedThisItem=0;
  state.pendingAiCharge=false;
  state.aiMultiItems=[];
  state.aiNameReview=false;
}
function today(){return new Date().toISOString().slice(0,10);}
function addMonths(d,m){if(!d)return '';const r=new Date(d);r.setMonth(r.getMonth()+m);return r.toISOString().slice(0,10);}
function addDays(d,n){if(!d)return '';const r=new Date(d);r.setDate(r.getDate()+n);return r.toISOString().slice(0,10);}

// ── Network status ───────────────────────────────────────────────────────
window.addEventListener('online',()=>{state.online=true;render();});
window.addEventListener('offline',()=>{state.online=false;render();});

// ── Helpers ────────────────────────────────────────────────────────────────
function daysLeft(d){if(!d)return null;return Math.ceil((new Date(d)-new Date())/86400000);}
function fmtDate(d){if(!d)return '—';return new Date(d).toLocaleDateString('lt-LT');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function normalizeSearchText(value){
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/ą/g,'a').replace(/č/g,'c').replace(/ę/g,'e').replace(/ė/g,'e')
    .replace(/į/g,'i').replace(/š/g,'s').replace(/ų/g,'u').replace(/ū/g,'u').replace(/ž/g,'z')
    .trim();
}
function fmtSize(b){return b<1024*1024?(b/1024).toFixed(0)+'KB':(b/1024/1024).toFixed(1)+'MB';}
function badgeHtml(days){
  if(days===null)return '';
  if(days<0)return`<span class="badge badge-exp">Baigėsi</span>`;
  if(days<=30)return`<span class="badge badge-warn">${days}d.</span>`;
  return`<span class="badge badge-ok">${days}d.</span>`;
}
function returnBadgeHtml(deadline){
  const d = daysLeft(deadline);
  if(d===null)return '';
  if(d<0)return `<span class="badge badge-exp">Grąžinimas baigėsi</span>`;
  if(d===0)return `<span class="badge badge-warn">Grąžinti šiandien</span>`;
  if(d<=3)return `<span class="badge badge-warn">Grąžinti liko ${d}d.</span>`;
  return `<span class="badge badge-ok">Grąžinti ${d}d.</span>`;
}
function isExpiredDate(dateStr){
  if(!dateStr)return false;
  const d = new Date(dateStr + 'T23:59:59');
  return Number.isFinite(d.getTime()) && d < new Date();
}
function confirmExpiredWarranty(dateStr, label='Šios prekės'){
  if(!isExpiredDate(dateStr)) return true;
  return confirm(`${label} garantija jau pasibaigusi (${fmtDate(dateStr)}).\n\nAr tikrai norite pridėti šį įrašą?`);
}
function multiWarrantyEnd(item, receipt){
  if(item?.warrantyEnd) return item.warrantyEnd;
  if(receipt?.purchaseDate && item?.warrantyMonths) return addMonths(receipt.purchaseDate, item.warrantyMonths);
  return '';
}
function toast(msg, ms=5200){
  document.querySelectorAll('.toast').forEach(e=>e.remove());
  const el=document.createElement('div');el.className='toast';el.textContent=msg;
  el.style.whiteSpace='normal';
  el.style.width='calc(100% - 32px)';
  el.style.maxWidth='460px';
  el.style.textAlign='center';
  el.style.lineHeight='1.35';
  el.style.borderRadius='14px';
  document.getElementById('app').appendChild(el);
  setTimeout(()=>el.remove(),ms);
}
function showAppDialog(title, message, supportDraft=''){
  state.appDialog = { title, message, supportDraft };
  render();
}
function openSupportFromDialog(){
  const draft = state.appDialog?.supportDraft || '';
  state.appDialog = null;
  state.contactSent = false;
  state.contactError = '';
  state.contactDraft = draft;
  state.view = 'contact';
  render();
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

// ── Watchdog: savigelbėjimo mechanizmai ────────────────────────────────────

// 1. Boot watchdog — jei per 10s nepasikrovė, rodo "Bandyti iš naujo"
// Paleidžiamas tik po DOMContentLoaded, kad Firebase spėtų inicializuotis
let _bootWatchdog = null;
document.addEventListener('DOMContentLoaded', ()=>{
  _bootWatchdog = setTimeout(()=>{
    if(!state.booted){
      const scr = document.getElementById('screen');
      if(scr) scr.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:32px;text-align:center">
          <i class="ti ti-wifi-off" style="font-size:48px;color:var(--text3)"></i>
          <p style="font-size:16px;font-weight:600;color:var(--text1)">Nepavyko prisijungti</p>
          <p style="font-size:14px;color:var(--text2)">Patikrinkite interneto ryšį ir bandykite iš naujo</p>
          <button onclick="location.reload()" style="background:var(--accent);color:#fff;border:none;border-radius:12px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer">Bandyti iš naujo</button>
        </div>`;
    }
  }, 10000);
});

// 2. Analyzing watchdog — jei AI analizė užtrunka >35s, automatiškai atšaukia
let _analyzeWatchdog = null;
function startAnalyzeWatchdog(){
  clearAnalyzeWatchdog();
  _analyzeWatchdog = setTimeout(()=>{
    if(state.analyzing){
      state.analyzing = false;
      state.uploadPct = null;
      render();
      // toast importuojamas vėliau, naudojam tiesioginį DOM
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = 'AI analizė užtruko per ilgai — bandykite dar kartą';
      document.body.appendChild(t);
      setTimeout(()=>t.remove(), 4000);
    }
  }, 35000);
}
function clearAnalyzeWatchdog(){ if(_analyzeWatchdog){ clearTimeout(_analyzeWatchdog); _analyzeWatchdog=null; } }

// 3. View stuck watchdog — jei per 15s nepavyko įkrauti admin stats, grįžta atgal
let _viewWatchdog = null;
function startViewWatchdog(view){
  clearViewWatchdog();
  _viewWatchdog = setTimeout(()=>{
    if(state.view===view && !state.adminStats && view==='admin-stats'){
      state.view='settings';
      render();
    }
  }, 15000);
}
function clearViewWatchdog(){ if(_viewWatchdog){ clearTimeout(_viewWatchdog); _viewWatchdog=null; } }
onAuthStateChanged(auth, async (user)=>{
  state.booted=true;
  clearTimeout(_bootWatchdog);
  const wasLoggedIn = !!state.user;
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
    // Firebase automatically signs the user out after a password change
    // (it revokes existing sessions as a security measure) — without this
    // message, the user just sees a blank login screen and can easily
    // mistake it for "my data is gone", when really nothing was deleted;
    // they just need to log back in with the new password.
    if(wasLoggedIn && !state._intentionalLogout){
      state.authInfo='Prisijunkite iš naujo — jūsų duomenys saugūs ir niekur nedingo.';
    }
    state._intentionalLogout = false;
  }
  render();
  if(user) render();
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
  state.storageError = '';
  state.appDialog = null;
  const ref_ = doc(db,'users',user.uid);
  const snap = await getDoc(ref_);
  if(!snap.exists()){
    const initial = {
      email:user.email, plan:'free', itemCount:0, notifyEnabled:true,
      storageMode:'local', aiUsesRemaining: AI_FREE_USES,
      emailVerified: user.emailVerified || false,
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
    // Atnaujinti emailVerified jei pasikeitė (pvz. vartotojas patvirtino paštą)
    if(state.userDoc.emailVerified !== user.emailVerified){
      try{ await updateDoc(ref_, { emailVerified: user.emailVerified || false }); }catch(e){}
      state.userDoc.emailVerified = user.emailVerified || false;
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
function attachItemsListener(uid, retryCount=0){
  if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }
  state.loadingItems = true;

  if(state.storageMode === 'cloud'){
    // IMPORTANT: we intentionally do NOT use orderBy('createdAtMs') in the
    // query itself. Per Firestore's documented behavior, an orderBy()
    // clause also filters for existence of that field — any document
    // missing createdAtMs (e.g. one created by an older app version, or
    // edited manually) would be silently excluded from the results
    // entirely, even though it's still physically in the collection. This
    // was one root cause of "I can see the photo in the database console
    // but the app shows nothing" reports. We fetch the full collection
    // unsorted and sort client-side instead, with a safe fallback for any
    // document that happens to be missing the field.
    const q = query(collection(db,'users',uid,'warranties'));

    // ALSO IMPORTANT: Firestore keeps its own IndexedDB cache that is "not
    // automatically cleared between sessions" (per Firebase's own docs).
    // If a document was ever modified outside the normal app flow (e.g.
    // directly in the Firebase console, or during a login retry sequence
    // after a failed password attempt), the very first onSnapshot can
    // serve a stale/empty result straight from that local cache before
    // it has a chance to reconcile with the server — this was the second
    // root cause behind "data visible in the console but not in the app"
    // reports. To guard against that, we do one explicit server-only read
    // first (bypassing the cache entirely) to warm state.items correctly,
    // and only then attach the live onSnapshot listener for ongoing sync.
    getDocsFromServer(q).then(snap=>{
      if(state.storageMode!=='cloud') return; // mode may have changed while this was in flight
      state.items = snap.docs
        .map(d=>({id:d.id,...d.data()}))
        .sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0));
      state.loadingItems = false;
      render();
    }).catch(err=>{
      // Non-fatal — the onSnapshot listener below will still populate the
      // list once it resolves; this is just a best-effort cache bypass.
      console.warn('Server-first fetch failed (will rely on onSnapshot):', err);
    });

    state.itemsUnsub = onSnapshot(q, snap=>{
      const wasEmpty = state.loadingItems;
      state.items = snap.docs
        .map(d=>({id:d.id,...d.data()}))
        .sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0));
      state.loadingItems = false;
      if(wasEmpty && state.items.length===0 && !state.addPulse){
        state.addPulse = true;
        setTimeout(()=>{state.addPulse=false;render();}, 3500);
      }
      render();
    }, err=>{
      console.warn('Items listener error:', err);
      // Right after a fresh login (especially one forced by a password
      // change), the freshly-issued ID token can take a brief moment to
      // propagate to Firestore's backend, causing a transient
      // permission-denied even though the rules and data are fine. Retry
      // once automatically before bothering the user with an error — if
      // it still fails after that, something is actually wrong and we
      // show it instead of silently leaving an empty list on screen.
      if(err.code==='permission-denied' && retryCount<2){
        setTimeout(()=>attachItemsListener(uid, retryCount+1), 800);
        return;
      }
      state.loadingItems = false;
      toast('Nepavyko įkelti garantijų sąrašo — patikrinkite interneto ryšį arba pabandykite atsijungti ir prisijungti iš naujo');
      render();
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
  state.authEmail=email;
  if(!email||!pwd){state.authError='Užpildykite visus laukus';state.authPwd='';state.authPwd2='';render();return;}
  if(pwd.length<6){state.authError='Slaptažodis turi būti bent 6 simbolių';state.authPwd='';state.authPwd2='';render();return;}
  if(pwd!==pwd2){state.authError='Slaptažodžiai nesutampa';state.authPwd='';state.authPwd2='';render();return;}
  state.authBusy=true;render();
  try{
    const cred = await createUserWithEmailAndPassword(auth,email,pwd);
    await sendEmailVerification(cred.user);
    state.authInfo='Paskyra sukurta! Patikrinkite el. paštą patvirtinimui.';
    state.authEmail='';
  }catch(e){
    state.authError=friendlyAuthError(e.code);
  }
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
  state._intentionalLogout = true;
  await signOut(auth);
  // Reset all per-session state so a different account logging in on the
  // same device never briefly sees stale data from the previous user.
  state.view='list'; state.addMode=null; state.selected=null;
  state.items=[]; state.userDoc=null; state.storageMode='local'; state.storageError=''; state.appDialog=null;
  state.form=emptyForm(); state.docError='';
  state.policyResult=null; state.policyResultFor=null; state.policyChecking=false;
  state.search=''; state.lightbox=null;
}

// ── Render ─────────────────────────────────────────────────────────────────
// ── PWA back-button handling ────────────────────────────────────────────
// Without this, pressing the phone's back button/gesture has nothing in
// browser history to "go back" to (since this is a single-page app that
// never changes the URL), so Android closes the whole PWA on the very
// first back-press from the list screen — which feels like a crash.
// We push a history entry every time the visible "screen" changes, and on
// popstate we navigate within the app (back to list) instead of letting
// the browser/OS unload the page.
let lastHistoryView = null;
function pushHistoryIfNeeded(currentViewKey){
  if(currentViewKey === lastHistoryView) return;
  if(lastHistoryView !== null){
    // Only push once we've rendered at least one screen — the very first
    // render shouldn't add an extra history entry before the user has done
    // anything.
    history.pushState({ view: currentViewKey }, '', location.href);
  }
  lastHistoryView = currentViewKey;
}
window.addEventListener('popstate', () => {
  // Any back navigation while inside the app (lightbox, qr scanner, add
  // form, detail, settings, search) returns to the main list rather than
  // exiting — matches the in-app back button's behavior.
  if(state.lightbox){ state.lightbox=null; render(); return; }
  if(state.qrScanning){ stopQrScanner(); return; }
  if(state.view==='add'&&state.addMode){ state.addMode=null; render(); return; }
  if(state.view!=='list'){ state.view='list'; render(); return; }
  // Already at the list screen with nothing else open — let the OS handle
  // it from here (this will actually exit/background the app, same as a
  // native app's root screen would).
});

// Nav handler — vienkartinis, iš index.html
window._appNav = (tab) => { state.view=tab; render(); };
window._appStartNewItem = (mode) => {
  startNewItem(mode);
  if(mode==='photo'){ renderSync(); requestAnimationFrame(()=>document.getElementById('docInput')?.click()); }
  else render();
};

// navAdd — vienkartinis init (long-press = kamera, tap = picker)
function render(){ _doRender(); }
function renderSync(){ _doRender(); }

function _doRender(){
  const scr=document.getElementById('screen');
  const nav=document.getElementById('bottomNav');

  if(!state.booted){ scr.innerHTML='<div class="center-loader"><div class="spinner"></div></div>'; nav.style.display='none'; return; }
  if(state.qrScanning){ scr.innerHTML=renderQrScanner(); nav.style.display='none'; document.getElementById('qrCloseBtn')?.addEventListener('click',stopQrScanner); pushHistoryIfNeeded('qr'); return; }
  if(state.lightbox){scr.innerHTML=renderLightbox();nav.style.display='none';attachLightboxEvents();pushHistoryIfNeeded('lightbox');return;}
  if(!state.user){
    if(state.showOnboarding){ scr.innerHTML=renderOnboarding(); nav.style.display='none'; attachOnboardingEvents(); return; }
    scr.innerHTML=renderAuth();nav.style.display='none';attachAuthEvents();return;
  }

  nav.style.display='flex';
  let html='';
  let viewKey = state.view;
  if(state.view==='list')          html=renderList();
  else if(state.view==='search')   html=renderSearch();
  else if(state.view==='add'&&!state.addMode) { html=renderPicker(); viewKey='add-picker'; }
  else if(state.view==='add')      { html=renderAdd(); viewKey='add-form'; }
  else if(state.view==='detail')   html=renderDetail();
  else if(state.view==='settings') html=renderSettings();
  else if(state.view==='contact')  html=renderContact();
  else if(state.view==='multi-select') html=renderMultiSelect();
  else if(state.view==='admin-stats') html=renderAdminStats();

  pushHistoryIfNeeded(viewKey);

  const syncPill = `<div class="sync-pill${state.online?'':' offline'}"><span class="dot"></span>${state.online?'Sinchronizuota':'Be interneto · veikia lokaliai'}</div>`;
  scr.innerHTML = (state.online?'':syncPill) + html + (state.notifModal ? renderNotifModal() : '') + (state.appDialog ? renderAppDialog() : '');

  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===state.view));
  const addCircle = document.querySelector('.nav-add-circle');
  if(addCircle){
    addCircle.classList.toggle('pulse', state.addPulse && state.view==='list');
    addCircle.style.background = 'var(--accent)';
    addCircle.querySelector('i').style.color = '#fff';
  }
  attachEvents();
}

// ── Onboarding ─────────────────────────────────────────────────────────────
const ONBOARD_SLIDES = [
  { icon:'ti-camera', bg:'var(--accent-bg)', color:'var(--accent)', title:'Nufotografuok čekį', text:'AI automatiškai atpažįsta produktą, parduotuvę ir datas iš nuotraukos ar PDF per kelias sekundes.' },
  { icon:'ti-device-laptop', bg:'var(--orange-bg)', color:'var(--orange)', title:'Sąskaita kompiuteryje?', text:'Ne bėda — atidaryk ją ekrane ir nufotografuok telefonu. AI perskaito net ir ekrano nuotrauką.' },
  { icon:'ti-bell-ringing', bg:'var(--red-bg)', color:'var(--red)', title:'Niekada nepraleisk garantijos', text:'Matykite iš karto, kurių daiktų garantija baigiasi greitai, ir nepraraskite teisės į nemokamą remontą.' },
  { icon:'ti-cloud-lock', bg:'var(--green-bg)', color:'var(--green)', title:'Saugu ir visada po ranka', text:'Duomenys saugomi jūsų paskyroje ir pasiekiami iš bet kurio įrenginio, net be interneto.' },
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
  const finish = ()=>{ state.showOnboarding=false; localStorage.setItem('galio_onboarded','1'); render(); };
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
    ${m!=='login'?`<p style="font-size:15px;color:var(--text3);text-align:center;margin-bottom:14px">Tęsdami sutinkate su <a href="terms.html" target="_blank" style="color:var(--accent)">Naudojimo sąlygomis</a> ir <a href="privacy.html" target="_blank" style="color:var(--accent)">Privatumo politika</a></p>`:''}
    <div class="login-divider">arba</div>`:''}

    <input type="email" id="authEmail" class="login-input" placeholder="El. paštas" autocomplete="email" value="${state.authEmail||''}" />
    ${m!=='reset'?`<input type="password" id="authPwd" class="login-input" placeholder="Slaptažodis" autocomplete="${m==='register'?'new-password':'current-password'}" value="${state.authPwd||''}" />`:''}
    ${m==='register'?`<input type="password" id="authPwd2" class="login-input" placeholder="Pakartokite slaptažodį" autocomplete="new-password" value="${state.authPwd2||''}" />`:''}

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
  // { once: true } — listener automatiškai pašalinamas po pirmo iššaukimo,
  // taip išvengiama kaupimosi per kelis render() iškvietimus
  const once=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn,{once:true});};
  const e1=document.getElementById('authEmail'),p1=document.getElementById('authPwd'),p2=document.getElementById('authPwd2');
  once('googleBtn','click',doGoogleLogin);
  once('authSubmit','click',()=>{
    const email=e1?.value.trim()||'';
    const pwd=p1?.value||'';
    const pwd2=p2?.value||'';
    state.authEmail=email;
    if(state.authMode==='register'){
      const consent = document.getElementById('consentCheck');
      if(!consent?.checked){
        state.authPwd=pwd; state.authPwd2=pwd2;
        state.authError='Turite sutikti su Naudojimo sąlygomis ir Privatumo politika';
        render();
        return;
      }
      state.authPwd=''; state.authPwd2='';
      doRegister(email,pwd,pwd2);
    }
    else if(state.authMode==='reset') doReset(email);
    else {
      state.authPwd='';
      doLogin(email,pwd);
    }
  });
  once('toRegister','click',()=>{state.authEmail=e1?.value.trim()||state.authEmail;state.authMode='register';state.authError='';state.authInfo='';state.authPwd='';state.authPwd2='';render();});
  once('toLogin','click',()=>{state.authEmail=e1?.value.trim()||state.authEmail;state.authMode='login';state.authError='';state.authInfo='';state.authPwd='';state.authPwd2='';render();});
  once('toReset','click',()=>{state.authEmail=e1?.value.trim()||state.authEmail;state.authMode='reset';state.authError='';state.authInfo='';state.authPwd='';state.authPwd2='';render();});
  [e1,p1,p2].forEach(el=>el?.addEventListener('keydown',ev=>{if(ev.key==='Enter')document.getElementById('authSubmit')?.click();}));
  setTimeout(()=>e1?.focus(),50);
}

// ── List ───────────────────────────────────────────────────────────────────
function renderList(){
  const{items,filterCat,sortBy,userDoc}=state;
  const expired =items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d<0;}).length;
  const expiring=items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d>=0&&d<=30;}).length;
  const valid   =items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d>=0;}).length;
  const isPremium = isPremiumUser();

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
    <div class="pb-text">${aiLeft>0?`<b>${aiLeft}</b> nemokam${aiLeft===1?'a':'os'} AI analiz${aiLeft===1?'ė':'ės'} liko`:'AI analizės išnaudotos'} · ${state.storageMode==='cloud'?'Atsarginė kopija įjungta':'Tik šiame telefone'}</div>
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
    const returnLine = item.returnDeadline ? `<div class="card-date" style="color:${(daysLeft(item.returnDeadline)??99)<=3?'var(--orange)':'var(--accent)'};font-weight:600"><i class="ti ti-rotate-2" style="font-size:14px"></i>Grąžinti iki ${fmtDate(item.returnDeadline)}</div>` : '';
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
          <div class="card-top"><span class="card-name">${esc(item.name)}</span>${returnBadgeHtml(item.returnDeadline)||badgeHtml(days)}</div>
          <div class="card-sub">${esc(item.shop||item.category)}</div>
          ${returnLine}
          ${item.warrantyEnd?`<div class="card-date"><i class="ti ti-calendar" style="font-size:14px"></i>Iki ${fmtDate(item.warrantyEnd)}</div>`:''}
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
    </div>
    <div style="height:14px"></div>
    ${statsHtml}
    ${verifyBanner}
    ${planBanner}
    <div style="padding:0 16px 10px;display:flex;align-items:center;gap:8px">
      <button id="catDropBtn" style="flex:1;background:none;border:1px solid var(--border2);border-radius:20px;padding:7px 14px;font-size:14px;font-weight:500;color:var(--text2);display:flex;align-items:center;gap:5px;cursor:pointer;min-width:0">
        <i class="ti ti-filter" style="font-size:15px;flex-shrink:0"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${filterCat}</span>
        <i class="ti ti-chevron-down" style="font-size:15px;flex-shrink:0"></i>
      </button>
      <button id="sortDropBtn" style="flex:1;background:none;border:1px solid var(--border2);border-radius:20px;padding:7px 14px;font-size:14px;font-weight:500;color:var(--text2);display:flex;align-items:center;gap:5px;cursor:pointer;min-width:0">
        <i class="ti ti-arrows-sort" style="font-size:15px;flex-shrink:0"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sortBy==='newest'?'Naujausi':sortBy==='expiring'?'Baigiasi':'A–Z'}</span>
        <i class="ti ti-chevron-down" style="font-size:15px;flex-shrink:0"></i>
      </button>
    </div>
    ${state.catDropOpen ? `<div id="catDropOverlay" style="position:fixed;inset:0;z-index:99"></div>
    <div style="position:fixed;left:16px;top:auto;z-index:100;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:160px;overflow:hidden">
      ${['Visos',...CATEGORIES].map(c=>`<button class="sort-drop-item${filterCat===c?' active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>` : ''}
    ${state.sortDropOpen ? `<div id="sortDropOverlay" style="position:fixed;inset:0;z-index:99"></div>
    <div style="position:fixed;right:16px;top:auto;z-index:100;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:160px;overflow:hidden">
      <button class="sort-drop-item${sortBy==='newest'?' active':''}" data-sort="newest"><i class="ti ti-clock" style="font-size:14px"></i>Naujausi</button>
      <button class="sort-drop-item${sortBy==='expiring'?' active':''}" data-sort="expiring"><i class="ti ti-hourglass" style="font-size:14px"></i>Baigiasi pirmi</button>
      <button class="sort-drop-item${sortBy==='name'?' active':''}" data-sort="name"><i class="ti ti-sort-a-z" style="font-size:14px"></i>A–Z</button>
    </div>` : ''}
    <div class="cards">${emptyHtml}${cardsHtml}</div>
    <div style="height:8px"></div>
  </div>`;
}

// ── Search ─────────────────────────────────────────────────────────────────
function renderSearch(){
  const q=state.search;
  const query=normalizeSearchText(q);
  const results=!query?[]:state.items.filter(i=>{
    const haystack = normalizeSearchText([
      i.name,
      i.shop,
      i.category,
      i.docType,
      i.docNumber,
      i.notes,
      i.purchaseDate,
      i.warrantyEnd,
      i.returnDeadline
    ].filter(Boolean).join(' '));
    return haystack.includes(query);
  });
  const cardsHtml=results.map(item=>{
    const days=daysLeft(item.warrantyEnd);
    const thumb=item.docUrl&&item.docMime!=='application/pdf'?`<img class="card-thumb" src="${esc(item.docUrl)}" alt="" loading="lazy" />`:`<div class="card-icon"><i class="ti ti-receipt"></i></div>`;
    return`<button class="card" data-id="${esc(item.id)}">
      ${thumb}
      <div class="card-body">
        <div class="card-top"><span class="card-name">${esc(item.name)}</span>${badgeHtml(days)}</div>
        <div class="card-sub">${esc(item.shop||item.category)}</div>
        ${item.docNumber?`<div class="card-date"><i class="ti ti-hash" style="font-size:14px"></i>${esc(item.docNumber)}</div>`:''}
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
  const isPremium = isPremiumUser();
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
    ${aiExhausted?`<div class="plan-banner" style="margin:0 16px 16px"><i class="ti ti-sparkles"></i><div class="pb-text">Išnaudojote ${AI_FREE_USES} nemokamas AI analizes. Atsinaujinkite į Premium.</div><button id="upgradeBtn3">Premium</button></div>`:''}
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
  const qrButtonHtml = !f.docData ? `<button type="button" class="qr-link-btn" disabled style="opacity:0.5;cursor:default"><i class="ti ti-qrcode"></i>QR skanavimas — netrukus</button>` : '';
  if(hasPdf){
    docAreaHtml=`<div class="doc-preview-pdf"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(f.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">PDF pridėtas</div></div></div>`;
  }else if(hasImg){
    docAreaHtml=`<div style="position:relative"><img class="doc-preview-img" id="docThumb" src="${esc(f.docData)}" alt="" /><div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.55);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ti ti-zoom-in" style="font-size:14px;color:#fff"></i></div></div>`;
  }else{
    docAreaHtml=`${qrButtonHtml}<label class="doc-drop-zone" for="docInput">
      <i class="ti ti-${isPhoto?'camera':'paperclip'}"></i>
      <p>${isPhoto?'Fotografuoti arba įkelti':'Prisegti dokumentą (neprivaloma)'}</p>
      <small>JPG, PNG, PDF · max 10MB / 5MB PDF</small>
    </label>`;
  }

  const multiItemBanner = state.aiMultiItems.length>0 ? `<div class="plan-banner" style="background:var(--accent-bg);margin-bottom:14px">
    <i class="ti ti-list-details" style="color:var(--accent)"></i>
    <div class="pb-text" style="color:var(--text)">Šiame čekyje rasta dar <b style="color:var(--accent)">${state.aiMultiItems.length}</b> prekė(-ių). Išsaugokite šią, tada pridėkite kitas be pakartotinio skenavimo.</div>
    <button id="nextMultiItemBtn">Kita prekė</button>
  </div>` : '';

  const warrantySheet=state.showWarranty?`<div class="warranty-sheet" id="warrantySheet">
    <div class="warranty-overlay" id="warrantyOverlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title">Garantijos trukmė</div>
      ${WARRANTY_OPTS.map(o=>`<button class="warranty-opt${f.warrantyMonths===o.m?' selected':''}" data-wm="${o.m??'x'}">${esc(o.l)}${f.warrantyMonths===o.m?`<i class="ti ti-check"></i>`:''}</button>`).join('')}
    </div>
  </div>`:'';

  const nameReviewModal=state.aiNameReview?`<div class="warranty-sheet" id="aiNameReviewSheet">
    <div class="warranty-overlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title">Patikrinkite pavadinimą</div>
      <p style="font-size:14px;color:var(--text2);margin:0 0 14px">AI pasiūlė pavadinimą. Pakeiskite jį į tokį, kokį norėsite matyti garantijų sąraše.</p>
      <div class="form-field" style="margin-bottom:14px">
        <input type="text" id="aiNameReviewInput" value="${esc(f.name)}" placeholder="Prekės pavadinimas" autofocus />
      </div>
      <button class="save-btn" id="aiNameReviewSave" ${f.name.trim()?'':'disabled'}>Tinka</button>
    </div>
  </div>`:'';

  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button><h2>${isPhoto?'Pridėti su dokumentu':'Įvesti rankiniu būdu'}</h2></div>
    <div class="form-body">
      ${!state.user.emailVerified&&isPhoto?`<div class="plan-banner" style="margin-bottom:14px"><i class="ti ti-mail-exclamation"></i><div class="pb-text">Patvirtinkite el. paštą, kad galėtumėte naudoti AI analizę</div></div>`:''}
      ${multiItemBanner}
      <div class="doc-upload-area">
        ${docAreaHtml}
        <input type="file" id="docInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" ${isPhoto?'capture="environment"':''} style="display:none" />
        ${f.docData?`<button class="doc-remove-btn" id="removeDoc"><i class="ti ti-trash" style="font-size:14px"></i>Pašalinti dokumentą</button>`:''}
        ${state.docError?`<p class="doc-error">${esc(state.docError)}</p>`:''}
        ${state.analyzing?`<div class="analyzing-row"><div class="spinner"></div><span style="font-size:15px;color:var(--text2)">AI analizuoja dokumentą...</span></div>`:''}
      </div>

      <p class="form-label-section">Pagrindinė informacija</p>
      ${f.qualityWarning ? `<div style="background:var(--orange-bg);border-radius:var(--radius);margin:0 0 16px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start">
        <i class="ti ti-alert-triangle" style="font-size:20px;color:var(--orange);flex-shrink:0;margin-top:1px"></i>
        <div style="min-width:0">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px">${esc(f.qualityWarning)}</div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:10px">Rekomenduojame nufotografuoti iš naujo.</div>
          <button id="rescanBtn" style="background:var(--orange);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
            <i class="ti ti-camera"></i> Fotografuoti iš naujo
          </button>
        </div>
      </div>` : ''}
      <div class="form-section">
        <div class="form-field">
          <label>Prekės pavadinimas</label>
          <input type="text" id="f_name" placeholder="pvz. Samsung TV 55&quot;" value="${esc(f.name)}" />
        </div>
        <div class="form-field">
          <label>Parduotuvė</label>
          <input type="text" id="f_shop" placeholder="pvz. Pigu, Euronics..." value="${esc(f.shop)}" />
        </div>
        <div class="form-field">
          <label>Kategorija</label>
          <select id="f_category">
            <option value="" ${!f.category?'selected':''}>Pasirinkite...</option>
            ${CATEGORIES.map(c=>`<option value="${esc(c)}"${c===f.category?' selected':''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
      </div>

      <p class="form-label-section">Datos</p>
      <div class="form-section">
        <div class="form-field">
          <label>Pirkimo data</label>
          <input type="date" id="f_purchaseDate" value="${esc(f.purchaseDate)}" />
        </div>
        <div class="form-field-row form-field" id="warrantyBtn" style="cursor:pointer;flex-direction:row">
          <label>Garantija</label>
          <span class="fv${!f.warrantyMonths&&f.warrantyMonths!==0?' fv-placeholder':''}">${esc(selOpt.l)}<i class="ti ti-chevron-right" style="font-size:14px;color:var(--text3)"></i></span>
        </div>
      </div>
      ${f.warrantyAppliesWarning ? `<div class="plan-banner" style="margin-bottom:16px;background:var(--orange-bg)">
        <i class="ti ti-info-circle" style="color:var(--orange);flex-shrink:0"></i>
        <div class="pb-text" style="color:var(--text);font-size:14px">AI: šiai prekei garantija paprastai netaikoma. Jei vis tiek norite saugoti, nurodykite garantijos pabaigos datą rankiniu būdu.</div>
      </div>` : ''}
        ${f.warrantyMonths===null?`<div class="form-field"><label>Galioja iki</label><input type="date" id="f_warrantyEnd" value="${esc(f.warrantyEnd)}" /></div>`:''}
        ${f.purchaseDate?`<div style="background:var(--accent-bg);border-radius:var(--radius);padding:14px 16px;margin-top:12px;display:flex;gap:12px;align-items:flex-start">
          <i class="ti ti-rotate-2" style="font-size:22px;color:var(--accent);flex-shrink:0"></i>
          <div>
            <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:3px">Grąžinimas iki ${fmtDate(addDays(f.purchaseDate,14))}</div>
            <div style="font-size:13px;color:var(--text2);line-height:1.35">Patogu sekti internetinių pirkinių grąžinimo terminą.</div>
          </div>
        </div>`:''}
        ${!f.warrantyEnd?`<div style="font-size:13px;color:var(--orange);padding:10px 2px 0">Nurodykite garantijos pabaigos datą, kad galėtumėte išsaugoti.</div>`:''}
      </div>

      <p class="form-label-section">Dokumentas</p>
      <div class="form-section">
        <div class="form-field">
          <label>Tipas</label>
          <select id="f_docType">${DOC_TYPES.map(d=>`<option${d===f.docType?' selected':''}>${esc(d)}</option>`).join('')}</select>
        </div>
        <div class="form-field">
          <label>Numeris</label>
          <input type="text" id="f_docNumber" placeholder="pvz. SF-2025-001" value="${esc(f.docNumber)}" />
        </div>
      </div>

      <p class="form-label-section">Pastabos</p>
      <div class="form-section">
        <div class="form-field">
          <textarea id="f_notes" rows="3" placeholder="Papildoma informacija...">${esc(f.notes)}</textarea>
        </div>
      </div>

      ${state.uploadPct!==null?`<div class="upload-progress-row"><div class="upload-progress-bar"><div class="upload-progress-fill" style="width:${state.uploadPct}%"></div></div><span style="font-size:14px;color:var(--text2)">${state.uploadPct}%</span></div>`:''}

      <div style="height:80px"></div>
    </div>
    ${warrantySheet}
    ${nameReviewModal}
    <div style="position:fixed;bottom:65px;left:0;right:0;padding:10px 16px;background:var(--bg);border-top:0.5px solid var(--border);z-index:50">
      <button class="save-btn" id="saveBtn" ${f.name.trim()&&f.warrantyEnd&&state.uploadPct===null?'':'disabled'}>${state.uploadPct!==null?'Saugoma...':'Išsaugoti'}</button>
    </div>
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
  const isPremium = isPremiumUser();

  let docHtml='';
  if(item.docUrl&&item.docMime==='application/pdf'){
    docHtml=`<div class="detail-section"><a class="doc-preview-pdf" href="${esc(item.docUrl)}" target="_blank"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(item.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">Spustelkite peržiūrėti</div></div><i class="ti ti-external-link" style="font-size:18px;color:var(--red);flex-shrink:0"></i></a></div>`;
  }else if(item.docUrl){
    docHtml=`<div class="detail-section"><img src="${esc(item.docUrl)}" id="docImg" style="width:100%;border-radius:var(--radius);max-height:200px;object-fit:cover;cursor:pointer;display:block" /></div>`;
  }

  const rows=[
    {i:'ti-tag',l:'Prekės pavadinimas',v:item.name},
    {i:'ti-building-store',l:'Parduotuvė',v:item.shop||'—'},
    {i:'ti-category',l:'Kategorija',v:item.category},
    {i:'ti-file-description',l:'Dok. tipas',v:item.docType||'—'},
    {i:'ti-hash',l:'Dok. numeris',v:item.docNumber||'—'},
    {i:'ti-calendar',l:'Pirkimo data',v:fmtDate(item.purchaseDate)},
    {i:'ti-calendar-due',l:'Garantija iki',v:fmtDate(item.warrantyEnd)},
    ...(item.returnDeadline ? [{i:'ti-rotate-2',l:'14 d. grąžinimas iki',v:fmtDate(item.returnDeadline)}] : []),
  ].map(r=>`<div class="detail-row"><i class="ti ${r.i}"></i><span class="dr-label">${esc(r.l)}</span><span class="dr-val">${esc(r.v)}</span></div>`).join('');

  const policySection = isPremium ? `<div class="detail-section">
    ${state.policyChecking ? `<div class="analyzing-row" style="justify-content:center"><div class="spinner"></div><span style="font-size:15px;color:var(--text2)">AI tikrina garantijos politiką...</span></div>`
      : state.policyResult && state.policyResultFor===item.id ? `<div class="plan-banner" style="background:var(--accent-bg);align-items:flex-start">
          <i class="ti ti-info-circle" style="color:var(--accent);margin-top:2px;flex-shrink:0"></i>
          <div class="pb-text" style="color:var(--text);font-size:14px;line-height:1.5"><b style="color:var(--accent)">AI pasiūlymas (patikrinkite patys):</b><br/>${esc(state.policyResult.replace(/\*\*/g,'').replace(/\*/g,''))}</div>
        </div>`
      : `<button class="qr-link-btn" id="checkPolicyBtn"><i class="ti ti-sparkles"></i>Patikrinti gamintojo garantiją su AI</button>`}
  </div>` : '';

  return`<div>
    <div class="page-header-sm">
      <button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>${esc(item.name)}</h2>
      <button class="icon-btn" id="editItemBtn" style="color:var(--accent)"><i class="ti ti-pencil" style="font-size:18px"></i></button>
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
  const isPremium = isPremiumUser();
  const isAdmin = state.userDoc?.role==='admin';
  const notifyOn = state.userDoc?.notifyEnabled !== false; // default true
  const aiLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;
  const isCloud = state.storageMode==='cloud';
  const initials = (u.displayName||u.email||'?').trim().charAt(0).toUpperCase();
  const avatarHtml = u.photoURL
    ? `<img src="${esc(u.photoURL)}" alt="" />`
    : initials;
  const accountEmail = state.userDoc?.email || u.email || 'El. paštas nerastas';
  const accountName = u.displayName || accountEmail;
  const providers = (u.providerData||[]).map(p=>p.providerId);
  const providerLabel = providers.includes('google.com') ? 'Google' : 'El. paštas';
  const canChangePassword = providers.includes('password');
  const uidShort = u.uid ? u.uid.slice(0,8) : '—';
  const planLabel = state.userDoc?.role==='admin'
    ? '<i class="ti ti-shield-check" style="font-size:15px"></i> Administratorius'
    : state.userDoc?.plan==='tester'
      ? '<i class="ti ti-flask" style="font-size:15px"></i> Testeris · Premium teisės'
      : state.userDoc?.plan==='friend'
        ? '<i class="ti ti-heart" style="font-size:15px"></i> Draugas · Premium teisės'
        : isPremium
          ? '<i class="ti ti-crown" style="font-size:15px"></i> Premium narys'
          : `Nemokamas planas · ${state.items.length} įrašų`;

  return `<div>
    <div class="page-header">
      <span class="page-title">Nustatymai</span>
      <button class="icon-btn" id="settingsLogoutBtn2"><i class="ti ti-logout" style="font-size:18px"></i></button>
    </div>

    <div class="settings-profile">
      <div class="settings-avatar">${avatarHtml}</div>
      <div class="settings-profile-info">
        <div class="settings-profile-email">${esc(accountName)}</div>
        <div style="font-size:13px;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(accountEmail)}</div>
        <div class="settings-profile-plan${isPremium?' premium':''}">
          ${planLabel}
        </div>
        <div style="font-size:12px;color:var(--text3);margin-top:2px">${providerLabel} · ID ${esc(uidShort)}</div>
      </div>
    </div>

    ${!isPremium ? `<div class="plan-banner" style="margin:0 16px 16px">
      <i class="ti ti-crown"></i>
      <div class="pb-text">Atsinaujinkite į Premium – paskyros sinchronizacija ir iki ${PREMIUM_DAILY_LIMIT} AI analizių per dieną</div>
      <button id="upgradeBtnSettings">Premium</button>
    </div>` : ''}

    <p class="form-label-section" style="margin:0 16px 8px">Duomenų vieta</p>
    <div class="form-section" style="margin:0 16px 8px">
      <button class="settings-row tappable" id="storageModeToggle" style="width:100%;background:none;border:none;text-align:left;${(!isPremium && !isCloud)?'opacity:0.65':''}" ${(!isPremium && !isCloud)?'disabled':''}>
        <i class="ti ti-${isCloud?'cloud':'device-mobile'} row-icon"></i>
        <div class="settings-row-label">${isCloud?'Atsarginė kopija įjungta':'Tik šiame telefone'}<small>${isCloud?'Įrašai pasiekiami kituose įrenginiuose, veikia automatiniai priminimai':'Įrašai lieka tik šiame įrenginyje, automatiniai priminimai neveikia'}</small></div>
        ${isPremium || isCloud ? `<span style="font-size:14px;color:var(--accent);font-weight:600">${isCloud?'Išjungti':'Įjungti atsarginę kopiją'}</span>` : '<i class="ti ti-lock" style="color:var(--text3);font-size:16px"></i>'}
      </button>
    </div>
    <p style="font-size:13px;color:var(--text3);padding:0 16px 20px;line-height:1.5">
      ${isCloud?'Įrašai saugomi atsarginėje kopijoje: juos matysite prisijungę kituose įrenginiuose, o pasirinkti priminimai galės būti siunčiami į telefoną.':isPremium?'Dabar įrašai laikomi tik šiame telefone. Įjunkite atsarginę kopiją, jei norite juos matyti kituose įrenginiuose ir gauti automatinius priminimus.':'Nemokamame plane įrašai saugomi tik telefone. Atsarginė kopija ir automatiniai priminimai prieinami Premium / Tester / Draugas paskyroms.'}
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
      <div class="settings-row" style="${!isCloud?'opacity:0.65':''}">
        <i class="ti ti-bell row-icon"></i>
        <div class="settings-row-label">Priminimai<small>${isCloud?'Siunčiami tik pasirinkus priminimus prie įrašo':'Veikia tik įjungus atsarginę kopiją'}</small></div>
        <button class="toggle-switch${notifyOn&&isCloud?' on':''}" id="notifyToggle" ${!isCloud?'disabled':''}><div class="knob"></div></button>
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
      ${canChangePassword ? `<button class="settings-row tappable" id="changePwdBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-lock row-icon"></i><span class="settings-row-label">Pakeisti slaptažodį</span><i class="ti ti-chevron-right" style="color:var(--text3)"></i>
      </button>` : `<div class="settings-row">
        <i class="ti ti-brand-google row-icon"></i><span class="settings-row-label">Slaptažodis valdomas per Google<small>Šioje programėlėje jo keisti nereikia</small></span>
      </div>`}
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Pagalba</p>
    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable" id="helpContactBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-help-circle row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Susisiekti su pagalba<small>Rašykite mums tiesiogiai</small></span>
      </button>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Teisinė informacija</p>
    <div class="form-section" style="margin:0 16px 20px">
      <a class="settings-row tappable" href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-shield-lock row-icon"></i><span class="settings-row-label">Privatumo politika</span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
      <a class="settings-row tappable" href="terms.html" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-file-text row-icon"></i><span class="settings-row-label">Naudojimo sąlygos</span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
    </div>

    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable danger" id="deleteAccountBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-trash row-icon"></i><span class="settings-row-label">Ištrinti paskyrą</span>
      </button>
    </div>

  </div>`;
}

// ── Notification modal ─────────────────────────────────────────────────────

// Siūlomi priminimai pagal garantijos ilgį
function suggestNotifDays(warrantyMonths, hasReturn){
  const days = [];
  if(warrantyMonths){
    if(warrantyMonths <= 1)       days.push(3, 1);
    else if(warrantyMonths <= 6)  days.push(14, 7, 1);
    else if(warrantyMonths <= 12) days.push(30, 7, 1);
    else                          days.push(60, 30, 7, 1);
  }
  return days;
}

function showNotifModal(itemId, itemData){
  if(!itemId){ state.view='list'; render(); return; }
  const item = itemData || state.items.find(i=>i.id===itemId);
  if(!item){ state.view='list'; render(); return; }

  if(state.storageMode !== 'cloud'){
    state.view='list';
    showAppDialog(
      'Priminimai neveiks',
      'Šis įrašas saugomas tik šiame telefone, todėl automatiniai pranešimai nebus siunčiami. Jei norite gauti priminimus, nustatymuose įjunkite atsarginę kopiją.',
      'Noriu įjungti priminimus, bet mano įrašai saugomi tik telefone.'
    );
    return;
  }

  const suggested = suggestNotifDays(item?.warrantyMonths, !!item?.returnDeadline);
  // Naudoti paskutinius nustatymus jei yra, kitaip siūlomus
  const defaults = state._lastNotifDays || suggested;

  state.notifModal = {
    itemId,
    selectedDays: [...defaults],
    returnSelectedDays: item?.returnDeadline ? (state._lastReturnNotifDays || [3]) : [],
    hasReturn: !!item?.returnDeadline,
    repeatEnabled: false,
    repeatInterval: 7,
    item,
  };
  state.view='list';
  render();
}

function renderNotifModal(){
  const m = state.notifModal;
  if(!m) return '';
  const DAY_OPTS = [1,3,7,14,30,60];
  const sel = new Set(m.selectedDays);
  const retSel = new Set(m.returnSelectedDays);

  return `<div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;display:flex;align-items:flex-end">
    <div style="background:var(--bg);border-radius:20px 20px 0 0;width:100%;padding:20px 20px 40px;max-height:85vh;overflow-y:auto">
      <div style="width:36px;height:4px;background:var(--border2);border-radius:2px;margin:0 auto 20px"></div>
      <h3 style="font-size:18px;font-weight:700;margin:0 0 6px">Ar norite priminimų?</h3>
      <p style="font-size:14px;color:var(--text3);margin:0 0 20px">Pasirinkite, kada priminti. Galite nuimti visus pasirinkimus, jei šiai prekei pranešimų nereikia.</p>

      ${m.item?.warrantyEnd ? `
      <p style="font-size:13px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">Prieš garantijos pabaigą</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
        ${DAY_OPTS.map(d=>`
          <button class="notif-day-btn${sel.has(d)?' active':''}" data-day="${d}" style="padding:8px 14px;border-radius:20px;border:1.5px solid ${sel.has(d)?'var(--accent)':'var(--border2)'};background:${sel.has(d)?'var(--accent)':'transparent'};color:${sel.has(d)?'#fff':'var(--text2)'};font-size:14px;font-weight:500;cursor:pointer">
            ${d===1?'1 dieną':d===7?'1 savaitę':d===30?'1 mėnesį':d===60?'2 mėnesius':d+' d.'}
          </button>`).join('')}
      </div>` : ''}

      ${m.hasReturn ? `
      <p style="font-size:13px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">Prieš grąžinimo terminą</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
        ${[1,2,3,5,7].map(d=>`
          <button class="notif-ret-btn${retSel.has(d)?' active':''}" data-day="${d}" style="padding:8px 14px;border-radius:20px;border:1.5px solid ${retSel.has(d)?'var(--accent)':'var(--border2)'};background:${retSel.has(d)?'var(--accent)':'transparent'};color:${retSel.has(d)?'#fff':'var(--text2)'};font-size:14px;font-weight:500;cursor:pointer">
            ${d===1?'1 dieną':d===7?'1 savaitę':d+' d.'}
          </button>`).join('')}
      </div>` : ''}

      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-top:0.5px solid var(--border);margin-bottom:20px">
        <div>
          <div style="font-size:15px;font-weight:500">Kartoti kas savaitę</div>
          <div style="font-size:13px;color:var(--text3)">Nuo 30 dienų iki pabaigos</div>
        </div>
        <button class="toggle-switch${m.repeatEnabled?' on':''}" id="notifRepeatToggle"><div class="knob"></div></button>
      </div>

      <button id="notifSaveBtn" class="save-btn" style="margin-bottom:10px">Išsaugoti pasirinkimą</button>
      <button id="notifSkipBtn" style="background:none;border:none;color:var(--text3);font-size:14px;width:100%;padding:10px;cursor:pointer">Be priminimų</button>
    </div>
  </div>`;
}

// ── Contact form ────────────────────────────────────────────────────────────
function renderContact(){
  const busy = state.contactBusy;
  const sent = state.contactSent;
  return `<div>
    <div class="detail-header" style="display:flex;align-items:center;gap:10px;padding:16px 16px 0">
      <button id="contactBackBtn" style="background:none;border:none;padding:4px;cursor:pointer;color:var(--text1)"><i class="ti ti-arrow-left" style="font-size:20px"></i></button>
      <span style="font-size:17px;font-weight:600">Susisiekti su pagalba</span>
    </div>
    ${sent ? `
    <div style="padding:48px 24px;text-align:center">
      <i class="ti ti-circle-check" style="font-size:48px;color:var(--green)"></i>
      <p style="font-size:16px;font-weight:600;margin:16px 0 8px">Žinutė išsiųsta!</p>
      <p style="font-size:14px;color:var(--text2);margin:0 0 24px">Atsakysime į <strong>${state.user?.email||''}</strong> kuo greičiau.</p>
      <button class="btn-primary" id="contactBackBtn2" style="width:auto;padding:10px 28px">Grįžti</button>
    </div>
    ` : `
    <div style="padding:16px">
      <p style="font-size:14px;color:var(--text2);margin:0 0 20px">Turite klausimą ar problemą? Parašykite mums — atsakysime el. paštu.</p>
      <p class="form-label-section" style="margin:0 0 6px">El. paštas</p>
      <div class="form-section" style="margin:0 0 12px;padding:12px 14px">
        <input id="contactEmail" type="email" placeholder="jusu@pastas.lt" style="width:100%;background:none;border:none;outline:none;font-size:15px;color:var(--text1);box-sizing:border-box"
          value="${(state.user?.email||'').replace(/"/g,'&quot;')}">
      </div>
      <p class="form-label-section" style="margin:0 0 6px">Žinutė</p>
      <div class="form-section" style="margin:0 0 20px;padding:12px 14px">
        <textarea id="contactMsg" rows="5" placeholder="Aprašykite problemą arba klausimą..." style="width:100%;background:none;border:none;outline:none;font-size:15px;color:var(--text1);resize:none;box-sizing:border-box">${state.contactDraft||''}</textarea>
      </div>
      ${state.contactError ? `<p style="color:var(--red);font-size:15px;margin:0 0 12px">${state.contactError}</p>` : ''}
      <button id="contactSendBtn" class="btn-primary" style="width:100%" ${busy?'disabled':''}>
        ${busy ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;margin:0 auto"></span>' : '<i class="ti ti-send"></i> Siųsti'}
      </button>
    </div>
    `}
  </div>`;
}

function renderAppDialog(){
  const d = state.appDialog;
  if(!d) return '';
  return `<div class="warranty-sheet" id="appDialog">
    <div class="warranty-overlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title">${esc(d.title||'Pranešimas')}</div>
      <p style="font-size:15px;color:var(--text2);line-height:1.45;margin:0 0 16px">${esc(d.message||'')}</p>
      <div style="display:flex;gap:10px">
        <button id="appDialogSupportBtn" style="flex:1;background:none;border:1px solid var(--border2);color:var(--text);font-size:15px;font-weight:600;border-radius:12px;padding:12px 14px">Pagalba</button>
        <button id="appDialogOkBtn" class="save-btn" style="flex:1">Gerai</button>
      </div>
    </div>
  </div>`;
}

// ── Multi-item select ──────────────────────────────────────────────────────
function renderMultiSelect(){
  const r = state.multiItemReceipt;
  if(!r){ state.view='list'; return ''; }
  const selectedCount = r.items.filter(i=>i.selected).length;

  const rows = r.items.map((item,idx)=>{
    const noWarranty = item.warrantyApplies===false;
    const dimmed = noWarranty && !item.selected;
    return `<div style="display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:0.5px solid var(--border)" class="multi-row" data-midx="${idx}">
      <div style="display:flex;flex-direction:column;align-items:center;gap:5px;flex-shrink:0">
        <div style="width:24px;height:24px;border-radius:6px;border:2px solid ${item.selected?'var(--accent)':'var(--border2)'};background:${item.selected?'var(--accent)':'transparent'};display:flex;align-items:center;justify-content:center;transition:all 0.15s">
          ${item.selected?`<i class="ti ti-check" style="font-size:13px;color:#fff"></i>`:''}
        </div>
        <span style="font-size:12px;font-weight:700;color:var(--text3);line-height:1">${idx+1}</span>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--text3);font-weight:600;margin-bottom:5px">${idx+1} prekė</div>
        <input class="multi-name-input" data-midx="${idx}" value="${esc(item.name)}" placeholder="Prekės pavadinimas" style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:15px;font-weight:600;color:${dimmed?'var(--text3)':'var(--text)'};outline:none" onclick="event.stopPropagation()" />
        <div style="font-size:13px;color:var(--text3);margin-top:2px;display:flex;align-items:center;gap:6px">
          ${item.category?`<span>${esc(item.category)}</span>`:''}
          ${!noWarranty?`<span style="color:var(--green)">${item.warrantyMonths||24} mėn.</span>`:''}
          ${item.price?`<span>${esc(String(item.price))} €</span>`:''}
        </div>
      </div>
      <button class="multi-edit-btn" data-midx="${idx}" style="background:none;border:none;padding:6px;color:var(--text3);cursor:pointer;flex-shrink:0" onclick="event.stopPropagation()">
        <i class="ti ti-pencil" style="font-size:17px"></i>
      </button>
    </div>`;
  }).join('');

  return `<div style="display:flex;flex-direction:column;height:100vh;overflow:hidden">
    <div style="padding:12px 16px 10px;border-bottom:0.5px solid var(--border);background:var(--bg);text-align:center">
      <div style="font-size:14px;font-weight:600;color:var(--text)">${esc(r.shop||'')}</div>
      <div style="font-size:12px;color:var(--text3);margin-top:2px">${r.purchaseDate?fmtDate(r.purchaseDate):''} · Pasirinkite ką išsaugoti</div>
    </div>
    <div style="flex:1;overflow-y:auto;padding-bottom:80px">
      <div style="background:var(--card);border-radius:var(--radius);margin:12px 16px;overflow:hidden">
        ${rows}
      </div>
    </div>
    <div style="position:fixed;bottom:65px;left:0;right:0;padding:10px 16px;background:var(--bg);border-top:0.5px solid var(--border);z-index:50;display:flex;gap:10px;align-items:center">
      <button id="multiCancelBtn" style="background:none;border:1px solid var(--border2);color:var(--text3);font-size:14px;padding:10px 16px;border-radius:12px;cursor:pointer;flex-shrink:0">Atšaukti</button>
      <button id="multiSaveBtn" ${selectedCount===0?'disabled':''} class="save-btn" style="flex:1;opacity:${selectedCount===0?'0.4':'1'}">
        Išsaugoti${selectedCount>0?` (${selectedCount})`:''}
      </button>
    </div>
  </div>`;
}


function renderAdminStats(){
  const s = state.adminStats;
  const users = state.adminUsers || [];
  return `<div>
    <div class="page-header-sm">
      <button class="back-btn" id="adminBackBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>Admin</h2>
    </div>
    ${!s ? `<div class="empty-state"><div class="spinner" style="margin:0 auto"></div><p style="margin-top:16px">Kraunama...</p></div>` : `
    <div class="stats-row" style="padding:16px">
      <div class="stat-tile"><div class="n">${s.totalUsers}</div><div class="l">Vartotojų</div></div>
      <div class="stat-tile"><div class="n" style="color:var(--gold)">${s.premiumUsers}</div><div class="l">Premium</div></div>
      <div class="stat-tile"><div class="n" style="color:var(--accent)">${s.testerUsers}</div><div class="l">Testerių</div></div>
    </div>
    <div class="detail-section" style="margin:0 16px 16px">
      <div class="detail-rows">
        <div class="detail-row"><i class="ti ti-receipt"></i><span class="dr-label">Viso garantijų įrašų</span><span class="dr-val">${s.totalItems}</span></div>
        <div class="detail-row"><i class="ti ti-mail-check"></i><span class="dr-label">Patvirtintų el. paštų</span><span class="dr-val">${s.verifiedUsers}/${s.totalUsers}</span></div>
        <div class="detail-row"><i class="ti ti-calendar-plus"></i><span class="dr-label">Naujų per 7 d.</span><span class="dr-val">${s.newLast7Days}</span></div>
      </div>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Vartotojai</p>
    <div class="form-section" style="margin:0 16px 16px;padding:0">
      ${users.length===0 ? `<div style="padding:16px;text-align:center;color:var(--text3);font-size:14px">Nėra vartotojų</div>` :
        users.map(u => {
          const planLabel = u.plan==='premium' ? '👑 Premium' : u.plan==='tester' ? '🧪 Testeris' : u.plan==='friend' ? '❤️ Draugas' : 'Nemokamas';
          const planColor = u.plan==='premium' ? 'var(--gold)' : u.plan==='tester' ? 'var(--accent)' : u.plan==='friend' ? 'var(--red)' : 'var(--text3)';
          const isTester = u.plan==='tester';
          const isFriend = u.plan==='friend';
          const isPremiumPlan = u.plan==='premium';
          const isAdminUser = u.role==='admin';
          return `<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px;padding:12px 14px">
            <div style="display:flex;width:100%;align-items:center;gap:6px;flex-wrap:wrap">
              <div style="flex:1 1 100%;min-width:0">
                <div style="font-size:15px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.email}</div>
                <div style="font-size:15px;color:${planColor};margin-top:2px">${planLabel}${isAdminUser?' · Admin':''}${u.emailVerified?' · ✓':''} · ${u.itemCount||0} įrašų</div>
              </div>
              ${!isAdminUser ? `<button class="chip${isPremiumPlan?' active':''}" data-uid="${u.uid}" data-action="togglePremium" style="font-size:15px;padding:3px 8px;flex-shrink:0">${isPremiumPlan?'? Premium':'Premium'}</button>` : ''}
              ${!isAdminUser ? `<button class="chip${isTester?' active':''}" data-uid="${u.uid}" data-action="toggleTester" style="font-size:15px;padding:3px 8px;flex-shrink:0">${isTester?'✓ Testeris':'Testeris'}</button>
              <button class="chip${isFriend?' active':''}" data-uid="${u.uid}" data-action="toggleFriend" style="font-size:15px;padding:3px 8px;flex-shrink:0">${isFriend?'✓ Draugas':'Draugas'}</button>` : ''}
            </div>
          </div>`;
        }).join('')
      }
    </div>
    `}
  </div>`;
}

async function loadAdminStats(){
  state.adminStats = null;
  state.adminUsers = [];
  render();
  try{
    const snap = await getDocs(collection(db,'users'));
    let totalUsers=0, premiumUsers=0, testerUsers=0, activeUsers=0, totalItems=0, verifiedUsers=0, newLast7Days=0;
    const weekAgoMs = Date.now() - 7*86400000;
    const usersList = [];

    // Skaičiuojam tikrą warranties kiekį iš subkolekcijos kiekvienam vartotojui
    await Promise.all(snap.docs.map(async d=>{
      const u = d.data();
      totalUsers++;
      if(u.plan==='premium') premiumUsers++;
      if(u.plan==='tester') testerUsers++;
      if(u.emailVerified) verifiedUsers++;
      if(u.createdAt?.toMillis && u.createdAt.toMillis() > weekAgoMs) newLast7Days++;

      // Tikras įrašų skaičius iš warranties subkolekcijos
      let realCount = 0;
      try{
        const wSnap = await getDocs(collection(db,'users',d.id,'warranties'));
        realCount = wSnap.size;
      }catch(e){ realCount = u.itemCount||0; } // fallback į cached jei nepavyksta

      if(realCount > 0) activeUsers++;
      totalItems += realCount;
      usersList.push({ uid: d.id, email: u.email||'—', plan: u.plan||'free', role: u.role||'', itemCount: realCount, emailVerified: !!u.emailVerified });
    }));

    usersList.sort((a,b)=>a.email.localeCompare(b.email));
    state.adminStats = { totalUsers, premiumUsers, testerUsers, activeUsers, totalItems, verifiedUsers, newLast7Days };
    state.adminUsers = usersList;
  }catch(e){
    toast('Nepavyko įkelti statistikos');
    state.view='settings';
  }
  render();
}


function attachEvents(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  const onAll=(sel,ev,fn)=>document.querySelectorAll(sel).forEach(el=>el.addEventListener(ev,fn));

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

  on('resendVerifyBtn','click',resendVerification);
  on('upgradeBtn','click',()=>toast('Premium netrukus! 🚀'));
  on('upgradeBtn3','click',()=>toast('Premium netrukus! 🚀'));
  onAll('.chip[data-filter]','click',e=>{state.filterCat=e.currentTarget.dataset.filter;render();});  on('catDropBtn','click',e=>{ e.stopPropagation(); state.catDropOpen=!state.catDropOpen; state.sortDropOpen=false; render(); });
  on('catDropOverlay','click',()=>{ state.catDropOpen=false; render(); });
  onAll('[data-cat]','click',e=>{ state.filterCat=e.currentTarget.dataset.cat; state.catDropOpen=false; render(); });
  on('sortDropBtn','click',e=>{ e.stopPropagation(); state.sortDropOpen=!state.sortDropOpen; state.catDropOpen=false; render(); });
  on('sortDropOverlay','click',()=>{ state.sortDropOpen=false; render(); });
  onAll('.sort-drop-item[data-sort]','click',e=>{ state.sortBy=e.currentTarget.dataset.sort; state.sortDropOpen=false; render(); });
  onAll('.card[data-id]','click',e=>{
    if(state.swipe.justSwiped){state.swipe.justSwiped=false;return;}
    state.selected=e.currentTarget.dataset.id;state.view='detail';render();
  });

  on('searchInput','input',e=>{
    state.search=e.target.value;
    clearTimeout(state._searchDebounce);
    state._searchDebounce=setTimeout(()=>{
      render();
      const inp=document.getElementById('searchInput');
      if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length,inp.value.length); }
    },200);
  });

  on('rescanBtn','click',()=>{ state.form.qualityWarning=null; state.form.docData=null; state.form.docMime=null; state.form.docFileName=null; renderSync(); document.getElementById('docInput')?.click(); });
  on('modePhoto','click',()=>{
    if(document.getElementById('modePhoto')?.disabled)return;
    state.addMode='photo';state.aiRetriesUsedThisItem=0;state.pendingAiCharge=false;state.aiMultiItems=[];state.aiNameReview=false;
    renderSync();
    requestAnimationFrame(()=>{ document.getElementById('docInput')?.click(); });
  });
  on('modeManual','click',()=>{state.addMode='manual';state.aiNameReview=false;render();});

  on('backBtn','click',()=>{
    if(state.view==='add' && state.multiEditIdx!=null){
      state.view='multi-select'; state.addMode=null; state.multiEditIdx=null; render();
    } else if(state.view==='add' && state.editItemId){
      state.editItemId=null; state.addMode=null; state.view='detail'; render();
    } else if(state.view==='add'&&state.addMode){
      state.addMode=null;render();
    } else {
      state.view='list';render();
    }
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

  on('aiNameReviewInput','input',e=>{state.form.name=e.target.value;const b=document.getElementById('aiNameReviewSave');if(b)b.disabled=!state.form.name.trim();syncSave();});
  on('aiNameReviewSave','click',()=>{if(!state.form.name.trim())return;state.aiNameReview=false;render();});

  on('docInput','change',handleDoc);
  on('qrScanBtn','click',startQrScanner);
  on('removeDoc','click',()=>{state.form.docData=null;state.form.docMime=null;state.form.docFileName=null;state.docError='';render();});
  on('docThumb','click',()=>{if(state.form.docData)state.lightbox=state.form.docData;render();});
  on('docImg','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it?.docUrl)state.lightbox=it.docUrl;render();});

  on('saveBtn','click',()=>{
    if(state.multiEditIdx!=null){
      // Atnaujiname prekę multi sąraše
      const idx=state.multiEditIdx;
      const r=state.multiItemReceipt;
      const f=state.form;
      if(r&&r.items[idx]){
        r.items[idx].name=f.name;
        r.items[idx].category=f.category;
        r.items[idx].warrantyMonths=f.warrantyMonths;
        r.items[idx].warrantyApplies=f.warrantyMonths!==null;
        r.items[idx].warrantyEnd=f.warrantyEnd;
        r.items[idx].price=f.notes.match(/Kaina: (.+)/)?.[1]||r.items[idx].price;
      }
      state.view='multi-select'; state.addMode=null; state.multiEditIdx=null;
      render();
    } else if(state.editItemId){
      updateItem();
    } else {
      saveItem();
    }
  });
  on('nextMultiItemBtn','click',()=>{
    if(state.aiMultiItems.length===0)return;
    const next = state.aiMultiItems.shift();
    state.form = emptyForm();
    state.aiRetriesUsedThisItem = 0;
    // No new AI call/charge here — this item's data already came from the
    // original scan, we're just stepping to the next product from it.
    state.pendingAiCharge = false;
    applyAiItemToForm(next, {shop: next._shop, purchaseDate: next._purchaseDate, docType: next._docType, docNumber: next._docNumber});
    render();
  });
  on('editItemBtn','click',()=>{
    const item = state.items.find(i=>i.id===state.selected);
    if(!item) return;
    state.form = {
      name: item.name||'',
      category: item.category||'',
      shop: item.shop||'',
      purchaseDate: item.purchaseDate||'',
      warrantyEnd: item.warrantyEnd||'',
      warrantyMonths: item.warrantyMonths??24,
      docType: item.docType||'Kvitas / čekis',
      docNumber: item.docNumber||'',
      notes: item.notes||'',
      docData: item.docUrl||null,
      docMime: item.docMime||null,
      docFileName: item.docFileName||null,
      docStoragePath: item.docStoragePath||null,
      notifyEnabled: item.notifyEnabled!==false,
      warrantyAppliesWarning: false,
      qualityWarning: null,
    };
    state.editItemId = item.id;
    state.addMode = 'manual';
    state.view = 'add';
    render();
  });
  on('deleteBtn2','click',()=>deleteItem(state.selected));
  on('checkPolicyBtn','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it)checkPolicy(it);});

  // Settings
  on('upgradeBtnSettings','click',()=>toast('Premium netrukus! 🚀'));
  onAll('.theme-opt','click',e=>{
    const t=e.currentTarget.dataset.theme;
    state.theme=t; localStorage.setItem('galio_theme',t); applyTheme(); render();
  });
  on('notifyToggle','click',toggleNotify);
  on('storageModeToggle','click',toggleStorageMode);
  on('changePwdBtn','click',()=>{
    if(!state.user.email){toast('Google paskyroms slaptažodžio keisti nereikia');return;}
    sendPasswordResetEmail(auth,state.user.email)
      .then(()=>toast('Nuoroda slaptažodžiui keisti išsiųsta į el. paštą'))
      .catch(()=>toast('Klaida siunčiant laišką'));
  });
  on('settingsLogoutBtn2','click',()=>{if(confirm('Atsijungti?'))doLogout();});
  on('deleteAccountBtn','click',confirmDeleteAccount);
  on('multiBackBtn','click',()=>{ state.multiItemReceipt=null; state.view='list'; render(); });
  on('multiCancelBtn','click',()=>{ state.multiItemReceipt=null; state.view='list'; render(); });
  onAll('.multi-row','click',e=>{
    if(e.target.closest('.multi-edit-btn') || e.target.closest('.multi-name-input')) return;
    const idx=parseInt(e.currentTarget.dataset.midx);
    const r=state.multiItemReceipt;
    if(!r) return;
    const item=r.items[idx];
    item.selected=!item.selected;

    // Atnaujinti tik šią eilutę ir mygtuką — be pilno re-render (greitis su ilgais čekiais)
    const row=e.currentTarget;
    const box=row.querySelector('div');
    if(box){
      box.style.border=`2px solid ${item.selected?'var(--accent)':'var(--border2)'}`;
      box.style.background=item.selected?'var(--accent)':'transparent';
      box.innerHTML=item.selected?'<i class="ti ti-check" style="font-size:13px;color:#fff"></i>':'';
    }
    const nameEl=row.querySelector('.multi-name-input');
    if(nameEl){
      const noWarranty=item.warrantyApplies===false;
      nameEl.style.color=(noWarranty&&!item.selected)?'var(--text3)':'var(--text)';
    }
    const btn=document.getElementById('multiSaveBtn');
    if(btn){
      const n=r.items.filter(i=>i.selected).length;
      btn.disabled=n===0;
      btn.style.opacity=n===0?'0.4':'1';
      btn.textContent=`Išsaugoti${n>0?` (${n})`:''}`;
    }
  });
  onAll('.multi-name-input','input',e=>{
    const idx=parseInt(e.currentTarget.dataset.midx);
    if(state.multiItemReceipt?.items[idx]) state.multiItemReceipt.items[idx].name=e.currentTarget.value;
  });
  onAll('.multi-edit-btn','click',e=>{
    e.stopPropagation();
    const idx=parseInt(e.currentTarget.dataset.midx);
    const r=state.multiItemReceipt;
    if(!r) return;
    const item=r.items[idx];
    // Užpildome formą šios prekės duomenimis
    state.form=emptyForm();
    state.form.name=item.name||'';
    state.form.category=item.category||'';
    state.form.shop=r.shop||'';
    state.form.purchaseDate=r.purchaseDate||'';
    state.form.warrantyMonths=item.warrantyApplies===false?null:(item.warrantyMonths||24);
    state.form.warrantyEnd=multiWarrantyEnd(item,r);
    state.form.docType=r.docType||'Kvitas / čekis';
    state.form.docNumber=r.docNumber||'';
    state.form.notes=item.price?`Kaina: ${item.price}`:'';
    state.form.docData=r.docData||null;
    state.form.docMime=r.docMime||null;
    state.form.docFileName=r.docFileName||null;
    state.form.warrantyAppliesWarning=item.warrantyApplies===false;
    state.multiEditIdx=idx;
    state.addMode='manual';
    state.view='add';
    render();
  });
  onAll('.multi-cat','change',e=>{
    const idx=parseInt(e.currentTarget.dataset.midx);
    if(state.multiItemReceipt) state.multiItemReceipt.items[idx].category=e.target.value;
  });
  on('multiSaveBtn','click', saveMultiItems);
  on('notifSkipBtn','click',()=>saveNotifSettings(true));
  on('notifRepeatToggle','click',()=>{ if(state.notifModal) state.notifModal.repeatEnabled=!state.notifModal.repeatEnabled; render(); });
  on('notifSaveBtn','click', saveNotifSettings);
  onAll('.notif-day-btn','click',e=>{
    const d=parseInt(e.currentTarget.dataset.day);
    if(!state.notifModal) return;
    const s=state.notifModal.selectedDays;
    const idx=s.indexOf(d);
    if(idx>=0) s.splice(idx,1); else s.push(d);
    render();
  });
  onAll('.notif-ret-btn','click',e=>{
    const d=parseInt(e.currentTarget.dataset.day);
    if(!state.notifModal) return;
    const s=state.notifModal.returnSelectedDays;
    const idx=s.indexOf(d);
    if(idx>=0) s.splice(idx,1); else s.push(d);
    render();
  });
  on('adminPanelBtn','click',()=>{state.view='admin-stats';startViewWatchdog('admin-stats');loadAdminStats();});
  on('helpContactBtn','click',()=>{
    state.contactSent=false; state.contactError=''; state.contactDraft='';
    state.view='contact'; render();
  });
  on('contactBackBtn','click',()=>{ state.view='settings'; render(); });
  on('contactBackBtn2','click',()=>{ state.view='settings'; render(); });
  on('contactSendBtn','click', sendContactMessage);
  on('appDialogOkBtn','click',()=>{ state.appDialog=null; render(); });
  on('appDialogSupportBtn','click',openSupportFromDialog);
  on('adminBackBtn','click',()=>{state.view='settings';render();});
  onAll('[data-action="togglePremium"]','click', async e=>{
    const uid = e.currentTarget.dataset.uid;
    const user = state.adminUsers?.find(u=>u.uid===uid);
    if(!user) return;
    const newPlan = user.plan==='premium' ? 'free' : 'premium';
    if(!confirm(`${newPlan==='premium'?'Suteikti Premium planą':'Atimti Premium planą'} vartotojui ${user.email}?`)) return;
    try{
      await updateDoc(doc(db,'users',uid), { plan: newPlan });
      user.plan = newPlan;
      toast(newPlan==='premium' ? `✓ ${user.email} dabar Premium` : `✓ ${user.email} grąžintas į nemokamą planą`);
      render();
    }catch(err){ toast('Nepavyko — ' + (err.message||'klaida'), 9000); }
  });
  onAll('[data-action="toggleTester"]','click', async e=>{
    const uid = e.currentTarget.dataset.uid;
    const user = state.adminUsers?.find(u=>u.uid===uid);
    if(!user) return;
    const newPlan = user.plan==='tester' ? 'free' : 'tester';
    if(!confirm(`${newPlan==='tester'?'Suteikti testerio planą':'Atimti testerio planą'} vartotojui ${user.email}?`)) return;
    try{
      await updateDoc(doc(db,'users',uid), { plan: newPlan });
      user.plan = newPlan;
      toast(newPlan==='tester' ? `✓ ${user.email} dabar testeris` : `✓ ${user.email} grąžintas į nemokamą planą`);
      render();
    }catch(err){ toast('Nepavyko — ' + (err.message||'klaida')); }
  });
  onAll('[data-action="toggleFriend"]','click', async e=>{
    const uid = e.currentTarget.dataset.uid;
    const user = state.adminUsers?.find(u=>u.uid===uid);
    if(!user) return;
    const newPlan = user.plan==='friend' ? 'free' : 'friend';
    if(!confirm(`${newPlan==='friend'?'Suteikti draugo planą':'Atimti draugo planą'} vartotojui ${user.email}?`)) return;
    try{
      await updateDoc(doc(db,'users',uid), { plan: newPlan });
      user.plan = newPlan;
      toast(newPlan==='friend' ? `✓ ${user.email} dabar draugas` : `✓ ${user.email} grąžintas į nemokamą planą`);
      render();
    }catch(err){ toast('Nepavyko — ' + (err.message||'klaida')); }
  });
}

async function sendContactMessage(){
  const emailEl = document.getElementById('contactEmail');
  const msgEl   = document.getElementById('contactMsg');
  const email   = (emailEl?.value||'').trim();
  const message = (msgEl?.value||'').trim();

  if(!email || !message){
    state.contactError = 'Prašome užpildyti el. paštą ir žinutę.';
    render(); return;
  }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    state.contactError = 'Neteisingas el. pašto formatas.';
    render(); return;
  }

  // Preserve draft in case of error
  state.contactDraft  = message;
  state.contactBusy   = true;
  state.contactError  = '';
  render();

  const u    = state.user;
  const plan = state.userDoc?.plan || 'free';
  const mode = state.storageMode  || 'local';
  const diag = `El. paštas: ${u?.email||'—'} | UID: ${u?.uid||'—'} | Planas: ${plan} | Saugojimas: ${mode} | Patvirtintas: ${u?.emailVerified?'taip':'ne'} | v1.0`;

  try {
    const res = await fetch(WORKER_URL + '/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, message, diag }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Klaida');
    state.contactSent  = true;
    state.contactDraft = '';
  } catch(e){
    state.contactError = e.message || 'Nepavyko išsiųsti. Bandykite vėliau.';
  } finally {
    state.contactBusy = false;
    render();
  }
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
        const usedByOtherItem = state.items.some(i=>i.id!==id && i.docStoragePath===item.docStoragePath);
        if(!usedByOtherItem){
          try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){console.warn('Storage delete failed:',e);}
        }
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

async function saveNotifSettings(skip=false){
  const m = state.notifModal;
  if(!m) return;

  const selectedDays = skip ? [] : [...m.selectedDays];
  const returnDays = skip ? [] : [...m.returnSelectedDays];
  const enabled = !skip && (selectedDays.length>0 || returnDays.length>0 || m.repeatEnabled);

  // Išsaugoti kaip naujus defaults, kad kitas įrašas siūlytų tą patį.
  state._lastNotifDays = selectedDays;
  state._lastReturnNotifDays = returnDays;
  localStorage.setItem('galio_notif_prefs', JSON.stringify({ warranty: selectedDays, return: returnDays }));

  const notifData = {
    notifyEnabled: enabled,
    notifyDays: selectedDays,
    notifyReturnDays: returnDays,
    notifyRepeatDays: enabled && m.repeatEnabled ? { interval: m.repeatInterval, startDay: 30 } : null,
  };

  try{
    if(enabled){
      const perm = await requestPushPermission();
      if(perm){
        notifData.fcmTokenUpdated = true;
      }
    }

    // Išsaugoti į Firestore arba IndexedDB
    if(state.storageMode==='cloud'){
      await updateDoc(doc(db,'users',state.user.uid,'warranties',m.itemId), notifData);
    }else{
      const item = state.items.find(i=>i.id===m.itemId);
      if(item){
        Object.assign(item, notifData);
        await localPut(state.user.uid, item);
      }
    }
    toast(enabled ? 'Priminimai išsaugoti ✓' : 'Priminimai išjungti');
  }catch(e){
    console.warn('Notif save error:', e);
    toast('Nepavyko išsaugoti priminimų');
  }

  state.notifModal = null;
  render();
}

async function requestPushPermission(){
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted') return false;

    const { getMessaging, getToken } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');
    const { firebaseApp, VAPID_KEY } = await import('./firebase-config.js');
    const fcmMessaging = getMessaging(firebaseApp);
    const token = await getToken(fcmMessaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.ready,
    });
    if(!token) return false;

    await updateDoc(doc(db,'users',state.user.uid), { fcmToken: token, notifyEnabled: true });
    return true;
  }catch(e){
    console.warn('Push permission error:', e);
    return false;
  }
}

async function chargeAiUsageNow(){
  if(!state.user) return;
  const isPremium = isPremiumUser();
  try{
    if(!isPremium){
      await updateDoc(doc(db,'users',state.user.uid), { aiUsesRemaining: increment(-1) });
      if(state.userDoc) state.userDoc.aiUsesRemaining = Math.max(0, (state.userDoc.aiUsesRemaining ?? AI_FREE_USES) - 1);
    }else{
      const today = new Date().toISOString().slice(0,10);
      const month = today.slice(0,7);
      const dayKey = state.userDoc?.aiDayKey;
      const monthKey = state.userDoc?.aiMonthKey;
      const newDayCount = dayKey===today ? (state.userDoc?.aiDayCount||0)+1 : 1;
      const newMonthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0)+1 : 1;
      await updateDoc(doc(db,'users',state.user.uid), {
        aiDayKey: today,
        aiDayCount: dayKey===today ? increment(1) : 1,
        aiMonthKey: month,
        aiMonthCount: monthKey===month ? increment(1) : 1,
      });
      if(state.userDoc){
        state.userDoc.aiDayKey=today; state.userDoc.aiDayCount=newDayCount;
        state.userDoc.aiMonthKey=month; state.userDoc.aiMonthCount=newMonthCount;
      }
    }
  }catch(e){
    console.warn('Failed to charge AI usage:', e);
  }
}

async function updateItem(){
  if(!state.editItemId||!state.form.name.trim()) return;
  const f = state.form;
  if(!f.warrantyEnd){
    showAppDialog('Trūksta garantijos datos', 'Nurodykite, iki kada galioja garantija. Prekės be garantijos datos neišsaugomos, kad sąraše neliktų neaiškių įrašų.');
    return;
  }
  if(!confirmExpiredWarranty(f.warrantyEnd, 'Šios prekės')) return;
  const isCloud = state.storageMode==='cloud';
  const payload = {
    name: f.name.trim().slice(0,200),
    category: f.category||'Kita',
    shop: f.shop.slice(0,100),
    purchaseDate: f.purchaseDate||'',
    warrantyEnd: f.warrantyEnd||'',
    warrantyMonths: f.warrantyMonths??null,
    docType: f.docType||'Kvitas / čekis',
    docNumber: f.docNumber.slice(0,100),
    notes: f.notes.slice(0,1000),
    notifyEnabled: f.notifyEnabled!==false,
    returnDeadline: f.purchaseDate ? addDays(f.purchaseDate,14) : null,
    ...(f.docData ? {docUrl:f.docData, docMime:f.docMime, docFileName:f.docFileName} : {}),
  };

  try{
    if(isCloud){
      await updateDoc(doc(db,'users',state.user.uid,'warranties',state.editItemId), payload);
    }else{
      const existing = state.items.find(i=>i.id===state.editItemId);
      const updated = {...existing, ...payload};
      await localPut(state.user.uid, updated);
      const idx = state.items.findIndex(i=>i.id===state.editItemId);
      if(idx>=0) state.items[idx]=updated;
    }
    toast('Išsaugota ✓');
    state.editItemId=null; state.addMode=null; state.view='detail';
    render();
  }catch(e){
    toast('Klaida išsaugant: '+(e.message||''));
  }
}

async function saveItem(){
  if(!state.form.name.trim())return;
  const f=state.form;
  if(!f.warrantyEnd){
    showAppDialog('Trūksta garantijos datos', 'Nurodykite, iki kada galioja garantija. Prekės be garantijos datos neišsaugomos, kad sąraše neliktų neaiškių įrašų.');
    return;
  }
  if(!confirmExpiredWarranty(f.warrantyEnd, 'Šios prekės')) return;
  const isCloud = state.storageMode==='cloud';

  // Charge AI quota now, only if this save includes AI-assisted data the
  // user is actually keeping. Scans that were retried/discarded never
  // reach this point, so they never cost quota — only a kept result does.
  if(state.pendingAiCharge){
    const isPremium = isPremiumUser();
    try{
      if(!isPremium){
        await updateDoc(doc(db,'users',state.user.uid), { aiUsesRemaining: increment(-1) });
        // Atnaujinti lokaliai iš karto — onSnapshot gali vėluoti dėl cache
        if(state.userDoc) state.userDoc.aiUsesRemaining = Math.max(0, (state.userDoc.aiUsesRemaining ?? AI_FREE_USES) - 1);
      }else{
        const today = new Date().toISOString().slice(0,10);
        const month = today.slice(0,7);
        const dayKey = state.userDoc?.aiDayKey;
        const monthKey = state.userDoc?.aiMonthKey;
        const newDayCount = dayKey===today ? (state.userDoc?.aiDayCount||0)+1 : 1;
        const newMonthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0)+1 : 1;
        await updateDoc(doc(db,'users',state.user.uid), {
          aiDayKey: today,
          aiDayCount: dayKey===today ? increment(1) : 1,
          aiMonthKey: month,
          aiMonthCount: monthKey===month ? increment(1) : 1,
        });
        if(state.userDoc){
          state.userDoc.aiDayKey=today; state.userDoc.aiDayCount=newDayCount;
          state.userDoc.aiMonthKey=month; state.userDoc.aiMonthCount=newMonthCount;
        }
      }
    }catch(e){ console.warn('Failed to charge AI quota on save:', e); }
    state.pendingAiCharge=false;
  }

  const payload={
    name:f.name.trim().slice(0,200), category:f.category, shop:(f.shop||'').slice(0,100),
    purchaseDate:f.purchaseDate, warrantyEnd:f.warrantyEnd, warrantyMonths:f.warrantyMonths,
    docType:f.docType, docNumber:(f.docNumber||'').slice(0,100), notes:(f.notes||'').slice(0,1000),
    notifyEnabled:true, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
    returnDeadline: f.purchaseDate ? addDays(f.purchaseDate,14) : null,
    createdAtMs: Date.now(),
  };

  try{
    if(isCloud){
      const fullPayload = { ...payload, createdAt: serverTimestamp() };
      const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'), fullPayload);
      state._lastSavedId = docRef.id;
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
        docUrl: f.docData || null,
        docMime: f.docMime || null,
        docFileName: f.docFileName || null,
      };
      await localPut(state.user.uid, localItem);
      state.items.unshift(localItem);
      state._lastSavedId = localItem.id;
    }

    toast('Išsaugota ✓');
  }catch(e){
    toast('Klaida saugant: '+(e.message||''));
  }

  state.uploadPct=null;
  const savedForm = {...state.form};
  state.form=emptyForm();state.docError='';state.addMode=null;

  // Rodyti priminimų modalą tik jei yra ką priminti (garantija arba grąžinimas)
  if(state._lastSavedId && (savedForm.warrantyEnd || savedForm.purchaseDate)){
    showNotifModal(state._lastSavedId, {
      warrantyMonths: savedForm.warrantyMonths,
      warrantyEnd: savedForm.warrantyEnd,
      returnDeadline: savedForm.purchaseDate ? addDays(savedForm.purchaseDate,14) : null,
    });
  }else{
    state.view='list'; render();
  }
  state._lastSavedId = null;
}

async function saveMultiItems(){
  const r = state.multiItemReceipt;
  if(!r) return;
  const selected = r.items.filter(i=>i.selected);
  if(selected.length===0) return;
  if(selected.some(i=>!String(i.name||'').trim())){
    toast('Įrašykite pavadinimą kiekvienai pasirinktai prekei');
    return;
  }
  const noWarrantyDate = selected.find(i=>!multiWarrantyEnd(i,r));
  if(noWarrantyDate){
    showAppDialog('Trūksta garantijos datos', `Prekei „${noWarrantyDate.name||'be pavadinimo'}“ nėra aiškios garantijos pabaigos datos. Atžymėkite šią prekę arba redaguokite ją ir nurodykite garantiją.`);
    return;
  }
  const expired = selected.find(i=>isExpiredDate(multiWarrantyEnd(i,r)));
  if(expired && !confirmExpiredWarranty(multiWarrantyEnd(expired,r), `Prekės „${expired.name||'be pavadinimo'}“`)) return;

  const isCloud = state.storageMode==='cloud';
  let saved=0, failed=0;
  const defaultWarrantyNotifDays = Array.isArray(state._lastNotifDays) ? state._lastNotifDays : null;
  const defaultReturnNotifDays = Array.isArray(state._lastReturnNotifDays) ? state._lastReturnNotifDays : null;
  let sharedDocMeta = null;

  // Charge one AI scan for the whole receipt (already scanned once)
  // pendingAiCharge was set true during analyzeDoc — charge it now
  if(state.pendingAiCharge){
    const isPremium = isPremiumUser();
    try{
      if(!isPremium){
        await updateDoc(doc(db,'users',state.user.uid),{aiUsesRemaining:increment(-1)});
        if(state.userDoc) state.userDoc.aiUsesRemaining=Math.max(0,(state.userDoc.aiUsesRemaining??AI_FREE_USES)-1);
      }else{
        const today = new Date().toISOString().slice(0,10);
        const month = today.slice(0,7);
        const dayKey = state.userDoc?.aiDayKey;
        const monthKey = state.userDoc?.aiMonthKey;
        const newDayCount = dayKey===today ? (state.userDoc?.aiDayCount||0)+1 : 1;
        const newMonthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0)+1 : 1;
        await updateDoc(doc(db,'users',state.user.uid),{
          aiDayKey: today,
          aiDayCount: dayKey===today ? increment(1) : 1,
          aiMonthKey: month,
          aiMonthCount: monthKey===month ? increment(1) : 1,
        });
        if(state.userDoc){
          state.userDoc.aiDayKey=today; state.userDoc.aiDayCount=newDayCount;
          state.userDoc.aiMonthKey=month; state.userDoc.aiMonthCount=newMonthCount;
        }
      }
    }catch(e){ console.warn('AI quota charge failed:',e); }
    state.pendingAiCharge=false;
  }

  toast(`Saugoma ${selected.length} prekių...`);

  if(isCloud && r.docData && r.docMime){
    try{
      const ext=r.docMime==='application/pdf'?'pdf':(r.docMime.split('/')[1]||'jpg');
      const receiptId = `receipt-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const path=`users/${state.user.uid}/documents/${receiptId}.${ext}`;
      const blob=base64ToBlob(r.docMime==='application/pdf'?r.docData:r.docData.split(',')[1],r.docMime);
      await uploadBytes(ref(storage,path),blob,{contentType:r.docMime});
      const url=await getDownloadURL(ref(storage,path));
      sharedDocMeta = {docUrl:url, docMime:r.docMime, docFileName:r.docFileName||null, docStoragePath:path};
    }catch(e){
      console.warn('Shared document upload failed:',e);
      toast('Dokumento nepavyko prisegti, bet prekes dar bandome išsaugoti');
    }
  }

  for(const item of selected){
    try{
      const warrantyNotifDays = defaultWarrantyNotifDays ?? suggestNotifDays(item.warrantyMonths||24, !!r.purchaseDate);
      const returnNotifDays = r.purchaseDate ? (defaultReturnNotifDays ?? [3]) : [];
      const payload={
        name:item.name.trim().slice(0,200),
        category:item.category||'Kita',
        shop:(r.shop||'').slice(0,100),
        purchaseDate:r.purchaseDate||'',
        warrantyEnd: multiWarrantyEnd(item,r),
        warrantyMonths: item.warrantyApplies===false ? null : (item.warrantyMonths||null),
        docType:r.docType||'Kvitas / čekis',
        docNumber:(r.docNumber||'').slice(0,100),
        notes:item.price?`Kaina: ${String(item.price).slice(0,50)}`:'',
        docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
        returnDeadline: r.purchaseDate ? addDays(r.purchaseDate,14) : null,
        notifyEnabled: warrantyNotifDays.length>0 || returnNotifDays.length>0,
        notifyDays: warrantyNotifDays,
        notifyReturnDays: returnNotifDays,
        createdAtMs: Date.now(),
      };

      if(isCloud){
        const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'),{...payload,...(sharedDocMeta||{}),createdAt:serverTimestamp()});
        await updateDoc(doc(db,'users',state.user.uid),{itemCount:increment(1)});
      }else{
        const localItem={
          ...payload, id:genLocalId(),
          docUrl: r.docData||null,
          docMime: r.docMime||null,
          docFileName: r.docFileName||null,
        };
        await localPut(state.user.uid,localItem);
        state.items.unshift(localItem);
      }
      saved++;
    }catch(e){
      console.warn('Failed to save item:',e);
      failed++;
    }
  }

  state.multiItemReceipt=null;
  state.pendingAiCharge=false;
  state.view='list';
  render();
  if(failed>0) toast(`Išsaugota ${saved}, nepavyko ${failed}`);
  else toast(`Išsaugota ${saved} prekių ✓`);
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
      <div class="qr-scanning-badge"><span class="qr-pulse-dot"></span>Skenuojama</div>
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

// Detects HEIC/HEIF files by their actual file signature (magic bytes),
// not just the reported MIME type — many browsers report HEIC files with
// an empty or generic MIME type, especially on Android. This matters
// because almost no browser except Safari 17+ can decode HEIC through the
// Image/Canvas APIs we use for compression: Chrome, Firefox, Edge, Opera,
// and Samsung Internet all fail silently (img.onerror fires) for HEIC,
// which previously surfaced as a generic "couldn't process this photo"
// message that gave the user no idea what was actually wrong or how to
// fix it. iPhones default to shooting HEIC, so this is a very common case.
async function looksLikeHeic(file){
  if(file.type==='image/heic'||file.type==='image/heif') return true;
  try{
    const buf = await file.slice(0,12).arrayBuffer();
    const bytes = new Uint8Array(buf);
    // ISOBMFF 'ftyp' box: bytes 4-7 spell "ftyp", brand follows at 8-11
    if(bytes[4]===0x66&&bytes[5]===0x74&&bytes[6]===0x79&&bytes[7]===0x70){
      const brand = String.fromCharCode(bytes[8],bytes[9],bytes[10],bytes[11]);
      return ['heic','heix','hevc','hevx','mif1','msf1'].includes(brand);
    }
  }catch(e){ /* fall through */ }
  return false;
}

function handleDoc(e){
  const file=e.target.files[0];if(!file)return;
  const isPdf=file.type==='application/pdf';
  const isImg=ALLOWED_IMG.includes(file.type);
  if(!isPdf&&!isImg){state.docError='Leidžiami formatai: JPG, PNG, WebP, HEIC, PDF';render();return;}
  if(isPdf&&file.size>MAX_PDF){state.docError=`PDF per didelis (max 5MB, jūsų: ${fmtSize(file.size)})`;render();return;}
  // NOTE: for images we deliberately do NOT reject based on the original
  // file size here. Modern phone cameras routinely produce 10-20MB photos
  // (especially HEIC/4K), but compressImage() below brings any of them
  // down to ~150-400KB before we ever touch Storage or the AI call. The
  // previous version rejected large originals BEFORE compression, which
  // meant many real phone photos were silently refused even though the
  // compressed result would have been tiny — this was one root cause of
  // "photos won't upload" reports. We still cap originals at a generous
  // 20MB just to avoid the browser choking on something absurd, but the
  // real, user-facing limit is enforced post-compression instead.
  const MAX_ORIGINAL_IMG = 20*1024*1024;
  if(isImg&&file.size>MAX_ORIGINAL_IMG){state.docError=`Failas per didelis (max 20MB, jūsų: ${fmtSize(file.size)})`;render();return;}
  state.docError='';

  (async()=>{
    if(isImg && await looksLikeHeic(file)){
      // Most browsers (everything except Safari 17+) cannot decode HEIC
      // through the canvas pipeline we use for compression — this is a
      // hard browser limitation, not a bug we can silently work around.
      // Tell the user exactly what's happening and how to fix it, rather
      // than a generic "failed to process" message.
      state.docError='HEIC formato nuotraukos šioje naršyklėje nepalaikomos. Telefono Nustatymuose → Kamera → Formatai pasirinkite "Suderinamas" (JPEG), arba naudokite Safari naršyklę (jei iPhone su naujausia iOS).';
      render();
      return;
    }
    proceedWithFile(file, isPdf);
  })();
}

function proceedWithFile(file, isPdf){
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
        // Sanity-check the compressed result actually came out reasonably
        // sized — if compression somehow failed to shrink a huge image,
        // surface that clearly instead of silently uploading something
        // oversized.
        const compressedBytes = Math.ceil(compB64.length * 0.75);
        if(compressedBytes > MAX_IMG){
          state.docError=`Nuotrauka per didelė net po suspaudimo (${fmtSize(compressedBytes)}). Pabandykite kitą nuotrauką.`;
          render();
          return;
        }
        state.form.docData=compressed; state.form.docMime='image/jpeg'; state.form.docFileName=file.name.replace(/\.[^.]+$/,'.jpg');
        if(state.addMode==='photo'){state.analyzing=true;startAnalyzeWatchdog();render();await analyzeDoc(compB64,'image/jpeg');clearAnalyzeWatchdog();state.analyzing=false;}
        render();
      }catch(err){
        console.warn('Image processing failed:', err);
        state.docError='Nepavyko apdoroti nuotraukos — pabandykite dar kartą arba kitą failą (jei tai HEIC formatas, pakeiskite kameros nustatymus į JPEG)';render();
      }
    }
  };
  reader.onerror=()=>{
    state.docError='Nepavyko nuskaityti failo';render();
  };
  reader.readAsDataURL(file);
}

async function checkPolicy(item){
  // Naudoja tą pačią Premium dienos kvotą kaip nuskaitymas
  if(!isPremiumUser()){ toast('Ši funkcija prieinama tik Premium vartotojams'); return; }

  const today = new Date().toISOString().slice(0,10);
  const month = today.slice(0,7);
  const dayKey = state.userDoc?.aiDayKey;
  const dayCount = dayKey===today ? (state.userDoc?.aiDayCount||0) : 0;
  const monthKey = state.userDoc?.aiMonthKey;
  const monthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0) : 0;
  if(dayCount >= PREMIUM_DAILY_LIMIT){
    toast(`Pasiektas dienos limitas (${PREMIUM_DAILY_LIMIT} AI analizių). Pabandykite rytoj.`);
    return;
  }
  if(monthCount >= PREMIUM_MONTHLY_LIMIT){
    toast(`Pasiektas mėnesio limitas (${PREMIUM_MONTHLY_LIMIT} AI analizių).`);
    return;
  }

  state.policyChecking = true; state.policyResult=null; render();
  try{
    const idToken = await state.user.getIdToken();

    // Atnaujinti dienos/mėnesio skaitiklius Firestore'e (tas pats mechanizmas kaip analyzeDoc)
    const newDayCount = dayKey===today ? dayCount+1 : 1;
    const newMonthCount = monthKey===month ? monthCount+1 : 1;
    await updateDoc(doc(db,'users',state.user.uid),{
      aiDayKey:today, aiDayCount:newDayCount,
      aiMonthKey:month, aiMonthCount:newMonthCount
    });
    if(state.userDoc){ state.userDoc.aiDayKey=today; state.userDoc.aiDayCount=newDayCount; state.userDoc.aiMonthKey=month; state.userDoc.aiMonthCount=newMonthCount; }

    const res = await fetch(WORKER_URL, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body: JSON.stringify({
        model:'claude-sonnet-4-6', max_tokens:300, use_search:true,
        messages:[{role:'user', content:[{type:'text', text:
          `Kiek laiko gamintojas paprastai suteikia garantiją šiam produktui: "${item.name}"${item.shop?` (pirkta iš ${item.shop})`:''}? `+
          `Atsakyk lietuviškai, TRUMPAI (2-3 sakiniai). Nurodyk tipinį terminą ir paminėk kad reikia patikrinti gamintojo svetainėje.`
        }]}]
      })
    });
    if(!res.ok) throw new Error('request failed');
    const data = await res.json();
    const text = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join(' ').trim()
      .replace(/\*\*/g,'').replace(/\*/g,'');
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
  if(state.storageMode!=='cloud'){
    showAppDialog('Priminimai neveiks', 'Automatiniai pranešimai veikia tik tada, kai įrašai saugomi atsarginėje kopijoje. Įrašams, laikomiems tik telefone, priminimų serveris nemato.');
    return;
  }
  const current = state.userDoc?.notifyEnabled !== false;
  try{
    await updateDoc(doc(db,'users',state.user.uid), { notifyEnabled: !current });
  }catch(e){
    toast('Nepavyko išsaugoti nustatymo');
  }
}

async function toggleStorageModeOld(){
  if(!state.user)return;
  const isPremium = isPremiumUser();
  const wantsCloud = state.storageMode !== 'cloud';

  if(wantsCloud && !isPremium){
    toast('Paskyros sinchronizacija prieinama tik Premium nariams');
    return;
  }

  const confirmMsg = wantsCloud
    ? `Perkelti įrašus į paskyros saugyklą?\n\nJie bus susieti su jūsų paskyra ir pasiekiami iš bet kurio įrenginio.`
    : `Perjungti į įrenginio saugyklą?\n\nJūsų ${state.items.length} įrašai bus perkelti į šį telefoną ir pašalinti iš paskyros. Kituose įrenginiuose jų nebebus — ir jei telefonas bus prarastas ar sugadintas, duomenys dingsta kartu su juo.`;
  if(!confirm(confirmMsg)) return;

  // Antras patvirtinimas local atveju
  if(!wantsCloud){
    if(!confirm('Patvirtinkite: pašalinti iš paskyros ir saugoti tik šiame telefone.')) return;
  }

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

async function toggleStorageMode(){
  if(!state.user) return;
  state.storageError = '';

  const isPremium = isPremiumUser();
  const wantsCloud = state.storageMode !== 'cloud';

  if(wantsCloud && !isPremium){
    showAppDialog(
      'Atsarginė kopija neprieinama',
      'Ši funkcija prieinama Premium, Tester arba Draugas paskyroms.',
      'Nepavyksta įjungti atsarginės kopijos. Mano paskyra: ' + (state.user?.email || '')
    );
    return;
  }

  const confirmMsg = wantsCloud
    ? `Įjungti atsarginę kopiją?\n\nJūsų įrašai bus saugomi saugiai ir matomi kituose jūsų įrenginiuose prisijungus tuo pačiu el. paštu.`
    : `Išjungti atsarginę kopiją?\n\nJūsų ${state.items.length} įrašai liks tik šiame telefone. Kituose įrenginiuose jų nebematysite, o praradus telefoną galite prarasti ir šiuos įrašus.`;
  if(!confirm(confirmMsg)) return;

  if(!wantsCloud && !confirm('Patvirtinkite: išjungti atsarginę kopiją ir laikyti įrašus tik šiame telefone.')) return;

  const itemsToMigrate = state.items.slice();
  toast(wantsCloud ? 'Įjungiama atsarginė kopija...' : 'Išjungiama atsarginė kopija...', 8000);
  state.migratingStorage = true;

  try{
    if(wantsCloud){
      await updateDoc(doc(db,'users',state.user.uid), {
        itemCount: itemsToMigrate.length,
        storageMode: 'cloud',
      });

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
    state.storageError = '';
    showAppDialog(
      'Pakeista',
      wantsCloud ? 'Atsarginė kopija įjungta.' : 'Atsarginė kopija išjungta. Įrašai saugomi tik šiame telefone.'
    );
  }catch(e){
    console.warn('Storage mode migration error:', e);
    state.storageError = '';
    showAppDialog(
      'Nepavyko pakeisti nustatymo',
      'Nepavyko pakeisti, kur saugomi įrašai. Patikrinkite, ar matote visus savo įrašus, ir susisiekite su pagalba.',
      `Nepavyko pakeisti įrašų saugojimo nustatymo.\nPaskyra: ${state.user?.email || ''}\nVeiksmas: ${wantsCloud ? 'įjungti atsarginę kopiją' : 'išjungti atsarginę kopiją'}`
    );
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
  const isPremium = isPremiumUser();
  const usesLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;

  const MAX_RETRIES_PER_ITEM = 2;
  if(state.aiRetriesUsedThisItem >= MAX_RETRIES_PER_ITEM){
    toast(`Pasiektas bandymų limitas (${MAX_RETRIES_PER_ITEM}) šiam įrašui. Įveskite duomenis rankiniu būdu arba pradėkite naują įrašą.`);
    return;
  }
  if(!isPremium && usesLeft<=0){
    toast(`Išnaudojote ${AI_FREE_USES} nemokamas AI analizes. Atsinaujinkite į Premium.`);
    return;
  }

  if(isPremium){
    const today = new Date().toISOString().slice(0,10);
    const month = today.slice(0,7);
    const dayKey = state.userDoc?.aiDayKey;
    const monthKey = state.userDoc?.aiMonthKey;
    const dayCount = dayKey===today ? (state.userDoc?.aiDayCount||0) : 0;
    const monthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0) : 0;
    if(dayCount >= PREMIUM_DAILY_LIMIT){
      toast(`Pasiektas dienos limitas (${PREMIUM_DAILY_LIMIT} analizių). Pabandykite rytoj.`);
      return;
    }
    if(monthCount >= PREMIUM_MONTHLY_LIMIT){
      toast(`Pasiektas mėnesio limitas (${PREMIUM_MONTHLY_LIMIT}/mėn.).`);
      return;
    }
  }

  state.aiRetriesUsedThisItem++;

  try{
    const idToken = await state.user.getIdToken();
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:mime,data:b64}},
        {type:'text',text:`Tai pirkimo dokumentas (čekis, sąskaita-faktūra ar banko išrašas). Atidžiai išanalizuok TIK tai, kas faktiškai matoma dokumente.

GRIEŽTOS TAISYKLĖS (svarbiausia):
1. NIEKADA negalvok/nespėliok informacijos, kurios nematai dokumente. Jei laukas neaiškus ar nematomas – grąžink null, NE spėjimą.
2. Pavadinimą imk TIK iš dokumento teksto (prekės eilutės), niekada negalvok pavadinimo iš konteksto ar nuojautos.
3. Jei dokumente NĖRA pardavėjo pavadinimo/rekvizitų (pvz. nufotografuota tik dalis čekio) – shop lauke grąžink null, neišgalvok parduotuvės pavadinimo.
4. Jei dokumentas neryškus, apkarpytas, ar dalis teksto neįskaitoma – privalai tai nurodyti quality lauke, nepaisant to stenkis ištraukti ką gali.
5. Jei čekyje/sąskaitoje YRA KELIOS atskiros prekės (ne paslaugos) – grąžink KIEKVIENĄ atskirai items masyve. Paslaugos (pristatymas, montavimas, garantijos pratęsimas ir pan.) NĖRA prekės – jų neįtrauk į items, bet gali paminėti notes lauke.
6. Kiekvienai prekei nurodyk, ar jai paprastai taikoma vartotojo garantija pagal ES/LT teisę (warrantyApplies). Drabužiai, avalynė, baldai, elektronika, technika – paprastai TAIP. Greitai gendantys maisto produktai, vienkartinio naudojimo higienos priemonės, paslaugos – paprastai NE.

Grąžink TIK JSON be markdown, šios struktūros:
{
  "shop": "parduotuvės/pardavėjo pavadinimas arba null jei nematomas dokumente",
  "purchaseDate": "YYYY-MM-DD arba null",
  "docNumber": "dokumento/kvito numeris arba null",
  "docType": "Kvitas / čekis|Sąskaita-faktūra (SF)|Banko išrašas|Kita",
  "quality": "good|blurry|partial|unclear",
  "qualityNote": "trumpas paaiškinimas jei quality nėra 'good', pvz. 'Trūksta apatinės čekio dalies' arba null",
  "items": [
    {"name":"tikslus prekės pavadinimas iš dokumento","price":"kaina arba null","warrantyMonths":24,"warrantyApplies":true,"category":"Elektronika|Buitinė technika|Avalynė / drabužiai|Baldai|Automobiliai|Kita"}
  ]
}
warrantyMonths kiekvienai prekei: 6/12/24/36/60 mėn. pagal produkto tipą, jei warrantyApplies=true. Jei warrantyApplies=false, warrantyMonths=null.
category kiekvienai prekei: viena iš: Elektronika, Buitinė technika, Avalynė / drabužiai, Baldai, Automobiliai, Kita.
Jei items sąraše nieko neradai (pvz. visiškai neįskaitoma), grąžink tuščią masyvą [].`}
      ]}]})
    });
    if(res.status===401){toast('Sesija pasibaigė, prisijunkite iš naujo');return;}
    if(res.status===403){toast('Patvirtinkite el. paštą, kad naudotumėte AI analizę');return;}
    if(res.status===429){toast('Pasiektas AI analizių limitas');return;}
    if(!res.ok)return;

    await chargeAiUsageNow();
    state.pendingAiCharge = false;

    const data=await res.json();
    const p=JSON.parse((data.content||[]).map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());

    // Quality warning — surfaced to the user, not silently swallowed.
    if(p.quality && p.quality!=='good'){
      const qualityLabels = {blurry:'Nuotrauka neryški',partial:'Matomas ne visas dokumentas',unclear:'Tekstas sunkiai įskaitomas'};
      state.form.qualityWarning = `${qualityLabels[p.quality]||'Dokumento kokybė nepakankama'}${p.qualityNote?': '+p.qualityNote:''}`;
    }

    const items = Array.isArray(p.items) ? p.items.filter(it=>it && typeof it.name==='string' && it.name.trim()) : [];

    if(items.length===0){
      // Nothing usable was recognized — don't silently fabricate a name.
      toast('AI nerado atpažįstamos prekės šiame dokumente. Įveskite duomenis rankiniu būdu.');
      if(typeof p.shop==='string')state.form.shop=p.shop.slice(0,100);
      if(typeof p.purchaseDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.purchaseDate))state.form.purchaseDate=p.purchaseDate;
      if(DOC_TYPES.includes(p.docType))state.form.docType=p.docType;
      return;
    }

    if(items.length===1){
      applyAiItemToForm(items[0], p);
      state.aiNameReview = true;
      // Dublikato patikrinimas: dok. numeris (patikimiausia) arba pavadinimas + data
      const dup = state.items.find(i=>
        (p.docNumber && i.docNumber && i.docNumber===p.docNumber && i.name?.toLowerCase()===items[0].name?.toLowerCase()) ||
        (i.name?.toLowerCase()===items[0].name?.toLowerCase() && i.purchaseDate && i.purchaseDate===p.purchaseDate));
      if(dup) toast('Panašus įrašas jau yra — patikrinkite ar ne dublikatas');
    }else{
      state.aiNameReview = false;
      const warrantyCount = items.filter(i=>i.warrantyApplies!==false).length;
      state.multiItemReceipt = {
        items: items.map(it=>({...it, _shop:p.shop, _purchaseDate:p.purchaseDate, _docType:p.docType, _docNumber:p.docNumber, selected:it.warrantyApplies!==false})),
        shop: p.shop, purchaseDate: p.purchaseDate, docType: p.docType, docNumber: p.docNumber,
        docData: state.form.docData, docMime: state.form.docMime, docFileName: state.form.docFileName,
        warrantyCount,
        confirmed: false,
      };
      state.view='multi-select';
    }
  }catch(err){console.warn('AI:',err);}
}

// Applies one recognized line-item (plus shared receipt-level fields) to
// the current form. Used both for single-item scans and for stepping
// through a multi-item receipt one product at a time.
function applyAiItemToForm(item, receiptMeta){
  if(typeof item.name==='string') state.form.name=item.name.slice(0,200);
  if(typeof receiptMeta.shop==='string') state.form.shop=receiptMeta.shop.slice(0,100);
  if(typeof receiptMeta.purchaseDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(receiptMeta.purchaseDate)) state.form.purchaseDate=receiptMeta.purchaseDate;
  if(typeof receiptMeta.docNumber==='string') state.form.docNumber=receiptMeta.docNumber.slice(0,100);
  if(DOC_TYPES.includes(receiptMeta.docType)) state.form.docType=receiptMeta.docType;

  // Kategorija iš AI
  if(CATEGORIES.includes(item.category)) state.form.category=item.category;

  // Garantija
  if(item.warrantyApplies===false){
    state.form.warrantyMonths=null;
    state.form.warrantyEnd='';
    state.form.warrantyAppliesWarning=true;
  }else{
    const wm=WARRANTY_OPTS.find(o=>o.m===item.warrantyMonths);
    if(wm){ state.form.warrantyMonths=item.warrantyMonths; if(state.form.purchaseDate) state.form.warrantyEnd=addMonths(state.form.purchaseDate,item.warrantyMonths); }
  }

  // Kaina į notes (tik jei yra)
  if(item.price) state.form.notes=[state.form.notes,`Kaina: ${String(item.price).slice(0,50)}`].filter(Boolean).join('\n');
}

render();
