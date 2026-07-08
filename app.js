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
const CATEGORIES    = ['Elektronika','BuitinÄ— technika','AvalynÄ— / drabuÅ¾iai','Baldai','Automobiliai','Kita'];
const DOC_TYPES     = ['Kvitas / Äekis','SÄ…skaita-faktÅ«ra (SF)','Banko iÅ¡raÅ¡as','Kita'];
const WARRANTY_OPTS = [{l:'6 mÄ—nesiai',m:6},{l:'1 metai',m:12},{l:'2 metai',m:24},{l:'3 metai',m:36},{l:'5 metai',m:60},{l:'Kita data',m:null}];
const ALLOWED_IMG   = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const MAX_IMG       = 10*1024*1024; // phone cameras often produce 6-12MB photos; compression brings this down before upload
const MAX_PDF       = 5*1024*1024;
const AI_FREE_USES  = 5; // lifetime AI document-analysis uses before Premium is required
const PREMIUM_DAILY_LIMIT   = 30;  // Premium is capped, not unlimited â€” bounds our Anthropic billing exposure
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
  pendingAiCharge: false, // true once a scan succeeds â€” saveItem() consumes one quota unit if this is set
  aiMultiItems: [],
  multiItemReceipt: null,
  multiEditIdx: null,
  editItemId: null,
  notifModal: null,
  _lastNotifDays: null,
  _lastReturnNotifDays: null,
  _lastSavedId: null,
  adminStats: null,
  storageMode: 'local', // 'local' | 'cloud' â€” driven by userDoc.storageMode once loaded
  migratingStorage: false, // true while toggleStorageMode() is mid-flight; suppresses auto-reattach
  storageError: '',
  policyChecking: false, policyResult: null, policyResultFor: null,
  contactBusy: false, contactSent: false, contactError: '', contactDraft: '',
  adminUsers: [],
  theme: localStorage.getItem('galio_theme') || 'auto',
};

function applyTheme(){
  const root = document.documentElement;
  root.classList.remove('theme-light','theme-dark');
  if(state.theme==='light') root.classList.add('theme-light');
  else if(state.theme==='dark') root.classList.add('theme-dark');
  // 'auto' = no override class, falls back to prefers-color-scheme in CSS
}
applyTheme();

function emptyForm(){return{name:'',category:'',shop:'',purchaseDate:'',warrantyEnd:'',warrantyMonths:24,docType:'Kvitas / Äekis',docNumber:'',notes:'',docData:null,docMime:null,docFileName:null,docStoragePath:null,notifyEnabled:true,warrantyAppliesWarning:false,qualityWarning:null};}

// Admin, tester ir friend vartotojai automatiÅ¡kai gauna premium teises
function isPremiumUser(){ return ['premium','tester','friend'].includes(state.userDoc?.plan) || state.userDoc?.role==='admin'; }

// Resets everything tied to "adding one new item" â€” the form fields plus
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
}
function today(){return new Date().toISOString().slice(0,10);}
function addMonths(d,m){if(!d)return '';const r=new Date(d);r.setMonth(r.getMonth()+m);return r.toISOString().slice(0,10);}
function addDays(d,n){if(!d)return '';const r=new Date(d);r.setDate(r.getDate()+n);return r.toISOString().slice(0,10);}

// â”€â”€ Network status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.addEventListener('online',()=>{state.online=true;render();});
window.addEventListener('offline',()=>{state.online=false;render();});

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function daysLeft(d){if(!d)return null;return Math.ceil((new Date(d)-new Date())/86400000);}
function fmtDate(d){if(!d)return 'â€”';return new Date(d).toLocaleDateString('lt-LT');}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function fmtSize(b){return b<1024*1024?(b/1024).toFixed(0)+'KB':(b/1024/1024).toFixed(1)+'MB';}
function badgeHtml(days){
  if(days===null)return '';
  if(days<0)return`<span class="badge badge-exp">BaigÄ—si</span>`;
  if(days<=30)return`<span class="badge badge-warn">${days}d.</span>`;
  return`<span class="badge badge-ok">${days}d.</span>`;
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
function friendlyAuthError(code){
  const map={
    'auth/email-already-in-use':'Å is el. paÅ¡tas jau uÅ¾registruotas',
    'auth/invalid-email':'Neteisingas el. paÅ¡to formatas',
    'auth/weak-password':'SlaptaÅ¾odis per silpnas (min. 6 simboliai)',
    'auth/user-not-found':'Vartotojas nerastas',
    'auth/wrong-password':'Neteisingas slaptaÅ¾odis',
    'auth/invalid-credential':'Neteisingas el. paÅ¡tas arba slaptaÅ¾odis',
    'auth/too-many-requests':'Per daug bandymÅ³. Pabandykite vÄ—liau',
    'auth/network-request-failed':'NÄ—ra interneto ryÅ¡io',
  };
  return map[code]||'Ä®vyko klaida. Bandykite dar kartÄ…';
}

// â”€â”€ Watchdog: savigelbÄ—jimo mechanizmai â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// 1. Boot watchdog â€” jei per 10s nepasikrovÄ—, rodo "Bandyti iÅ¡ naujo"
// PaleidÅ¾iamas tik po DOMContentLoaded, kad Firebase spÄ—tÅ³ inicializuotis
let _bootWatchdog = null;
document.addEventListener('DOMContentLoaded', ()=>{
  _bootWatchdog = setTimeout(()=>{
    if(!state.booted){
      const scr = document.getElementById('screen');
      if(scr) scr.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:32px;text-align:center">
          <i class="ti ti-wifi-off" style="font-size:48px;color:var(--text3)"></i>
          <p style="font-size:16px;font-weight:600;color:var(--text1)">Nepavyko prisijungti</p>
          <p style="font-size:14px;color:var(--text2)">Patikrinkite interneto ryÅ¡Ä¯ ir bandykite iÅ¡ naujo</p>
          <button onclick="location.reload()" style="background:var(--accent);color:#fff;border:none;border-radius:12px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer">Bandyti iÅ¡ naujo</button>
        </div>`;
    }
  }, 10000);
});

// 2. Analyzing watchdog â€” jei AI analizÄ— uÅ¾trunka >35s, automatiÅ¡kai atÅ¡aukia
let _analyzeWatchdog = null;
function startAnalyzeWatchdog(){
  clearAnalyzeWatchdog();
  _analyzeWatchdog = setTimeout(()=>{
    if(state.analyzing){
      state.analyzing = false;
      state.uploadPct = null;
      render();
      // toast importuojamas vÄ—liau, naudojam tiesioginÄ¯ DOM
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = 'AI analizÄ— uÅ¾truko per ilgai â€” bandykite dar kartÄ…';
      document.body.appendChild(t);
      setTimeout(()=>t.remove(), 4000);
    }
  }, 35000);
}
function clearAnalyzeWatchdog(){ if(_analyzeWatchdog){ clearTimeout(_analyzeWatchdog); _analyzeWatchdog=null; } }

// 3. View stuck watchdog â€” jei per 15s nepavyko Ä¯krauti admin stats, grÄ¯Å¾ta atgal
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
    // (it revokes existing sessions as a security measure) â€” without this
    // message, the user just sees a blank login screen and can easily
    // mistake it for "my data is gone", when really nothing was deleted;
    // they just need to log back in with the new password.
    if(wasLoggedIn && !state._intentionalLogout){
      state.authInfo='Prisijunkite iÅ¡ naujo â€” jÅ«sÅ³ duomenys saugÅ«s ir niekur nedingo.';
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
        toast('El. paÅ¡tas patvirtintas âœ“');
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
    // Atnaujinti emailVerified jei pasikeitÄ— (pvz. vartotojas patvirtino paÅ¡tÄ…)
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
      // the items listener pointed at the correct source â€” but not while
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

// â”€â”€ Items listener abstraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// In 'cloud' mode, items live in Firestore and sync in real time.
// In 'local' mode, items live only in this browser's IndexedDB â€” nothing
// is ever sent to Firestore/Storage for the warranty content itself.
function attachItemsListener(uid, retryCount=0){
  if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }
  state.loadingItems = true;

  if(state.storageMode === 'cloud'){
    // IMPORTANT: we intentionally do NOT use orderBy('createdAtMs') in the
    // query itself. Per Firestore's documented behavior, an orderBy()
    // clause also filters for existence of that field â€” any document
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
    // it has a chance to reconcile with the server â€” this was the second
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
      // Non-fatal â€” the onSnapshot listener below will still populate the
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
      // once automatically before bothering the user with an error â€” if
      // it still fails after that, something is actually wrong and we
      // show it instead of silently leaving an empty list on screen.
      if(err.code==='permission-denied' && retryCount<2){
        setTimeout(()=>attachItemsListener(uid, retryCount+1), 800);
        return;
      }
      state.loadingItems = false;
      toast('Nepavyko Ä¯kelti garantijÅ³ sÄ…raÅ¡o â€” patikrinkite interneto ryÅ¡Ä¯ arba pabandykite atsijungti ir prisijungti iÅ¡ naujo');
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
  if(!email||!pwd){state.authError='UÅ¾pildykite visus laukus';state.authPwd='';state.authPwd2='';render();return;}
  if(pwd.length<6){state.authError='SlaptaÅ¾odis turi bÅ«ti bent 6 simboliÅ³';state.authPwd='';state.authPwd2='';render();return;}
  if(pwd!==pwd2){state.authError='SlaptaÅ¾odÅ¾iai nesutampa';state.authPwd='';state.authPwd2='';render();return;}
  state.authBusy=true;render();
  try{
    const cred = await createUserWithEmailAndPassword(auth,email,pwd);
    await sendEmailVerification(cred.user);
    state.authInfo='Paskyra sukurta! Patikrinkite el. paÅ¡tÄ… patvirtinimui.';
    state.authEmail='';
  }catch(e){
    state.authError=friendlyAuthError(e.code);
  }
  state.authBusy=false;render();
}
async function doLogin(email,pwd){
  state.authError='';state.authInfo='';
  if(!email||!pwd){state.authError='UÅ¾pildykite visus laukus';render();return;}
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
  if(!email){state.authError='Ä®veskite el. paÅ¡tÄ…';render();return;}
  state.authBusy=true;render();
  try{ await sendPasswordResetEmail(auth,email); state.authInfo='SlaptaÅ¾odÅ¾io atstatymo nuoroda iÅ¡siÅ³sta Ä¯ el. paÅ¡tÄ…'; }
  catch(e){ state.authError=friendlyAuthError(e.code); }
  state.authBusy=false;render();
}
async function resendVerification(){
  if(!state.user||state.authBusy)return;
  state.authBusy=true;render();
  try{
    await sendEmailVerification(state.user);
    state.authInfo='LaiÅ¡kas iÅ¡siÅ³stas dar kartÄ…. Patikrinkite Spam aplankÄ….';
    toast('Patvirtinimo laiÅ¡kas iÅ¡siÅ³stas âœ“');
  }catch(e){
    toast('Klaida siunÄiant laiÅ¡kÄ…, bandykite vÄ—liau');
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
  state.items=[]; state.userDoc=null; state.storageMode='local';
  state.form=emptyForm(); state.docError='';
  state.policyResult=null; state.policyResultFor=null; state.policyChecking=false;
  state.search=''; state.lightbox=null;
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€ PWA back-button handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Without this, pressing the phone's back button/gesture has nothing in
// browser history to "go back" to (since this is a single-page app that
// never changes the URL), so Android closes the whole PWA on the very
// first back-press from the list screen â€” which feels like a crash.
// We push a history entry every time the visible "screen" changes, and on
// popstate we navigate within the app (back to list) instead of letting
// the browser/OS unload the page.
let lastHistoryView = null;
function pushHistoryIfNeeded(currentViewKey){
  if(currentViewKey === lastHistoryView) return;
  if(lastHistoryView !== null){
    // Only push once we've rendered at least one screen â€” the very first
    // render shouldn't add an extra history entry before the user has done
    // anything.
    history.pushState({ view: currentViewKey }, '', location.href);
  }
  lastHistoryView = currentViewKey;
}
window.addEventListener('popstate', () => {
  // Any back navigation while inside the app (lightbox, qr scanner, add
  // form, detail, settings, search) returns to the main list rather than
  // exiting â€” matches the in-app back button's behavior.
  if(state.lightbox){ state.lightbox=null; render(); return; }
  if(state.qrScanning){ stopQrScanner(); return; }
  if(state.view==='add'&&state.addMode){ state.addMode=null; render(); return; }
  if(state.view!=='list'){ state.view='list'; render(); return; }
  // Already at the list screen with nothing else open â€” let the OS handle
  // it from here (this will actually exit/background the app, same as a
  // native app's root screen would).
});

// Nav handler â€” vienkartinis, iÅ¡ index.html
window._appNav = (tab) => { state.view=tab; render(); };
window._appStartNewItem = (mode) => {
  startNewItem(mode);
  if(mode==='photo'){ renderSync(); requestAnimationFrame(()=>document.getElementById('docInput')?.click()); }
  else render();
};

// navAdd â€” vienkartinis init (long-press = kamera, tap = picker)
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

  const syncPill = `<div class="sync-pill${state.online?'':' offline'}"><span class="dot"></span>${state.online?'Sinchronizuota':'Be interneto Â· veikia lokaliai'}</div>`;
  scr.innerHTML = (state.online?'':syncPill) + html + (state.notifModal ? renderNotifModal() : '');

  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===state.view));
  const addCircle = document.querySelector('.nav-add-circle');
  if(addCircle){
    addCircle.classList.toggle('pulse', state.addPulse && state.view==='list');
    addCircle.style.background = 'var(--accent)';
    addCircle.querySelector('i').style.color = '#fff';
  }
  attachEvents();
}

// â”€â”€ Onboarding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ONBOARD_SLIDES = [
  { icon:'ti-camera', bg:'var(--accent-bg)', color:'var(--accent)', title:'Nufotografuok ÄekÄ¯', text:'AI automatiÅ¡kai atpaÅ¾Ä¯sta produktÄ…, parduotuvÄ™ ir datas iÅ¡ nuotraukos ar PDF per kelias sekundes.' },
  { icon:'ti-device-laptop', bg:'var(--orange-bg)', color:'var(--orange)', title:'SÄ…skaita kompiuteryje?', text:'Ne bÄ—da â€” atidaryk jÄ… ekrane ir nufotografuok telefonu. AI perskaito net ir ekrano nuotraukÄ….' },
  { icon:'ti-bell-ringing', bg:'var(--red-bg)', color:'var(--red)', title:'Niekada nepraleisk garantijos', text:'Matykite iÅ¡ karto, kuriÅ³ daiktÅ³ garantija baigiasi greitai, ir nepraraskite teisÄ—s Ä¯ nemokamÄ… remontÄ….' },
  { icon:'ti-cloud-lock', bg:'var(--green-bg)', color:'var(--green)', title:'Saugu ir visada po ranka', text:'Duomenys saugomi jÅ«sÅ³ paskyroje ir pasiekiami iÅ¡ bet kurio Ä¯renginio, net be interneto.' },
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
      <button class="login-btn" id="onboardNext">${isLast?'PradÄ—ti':'Toliau'}</button>
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

// â”€â”€ Lightbox â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderLightbox(){return`<div class="lightbox" id="lbOverlay"><div class="lightbox-bar"><button class="lightbox-close" id="lbClose"><i class="ti ti-x"></i></button></div><div class="lightbox-img"><img src="${esc(state.lightbox)}" /></div></div>`;}
function attachLightboxEvents(){
  document.getElementById('lbClose')?.addEventListener('click',()=>{state.lightbox=null;render();});
  document.getElementById('lbOverlay')?.addEventListener('click',e=>{if(e.target.id==='lbOverlay'){state.lightbox=null;render();}});
}

// â”€â”€ Auth screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderAuth(){
  const m=state.authMode;
  return`<div class="login-wrap"><div class="login-card">
    <div class="login-logo"><span class="shield">ðŸ›¡ï¸</span><h1>Galio</h1><p>${m==='register'?'Susikurkite paskyrÄ…':m==='reset'?'Atstatykite slaptaÅ¾odÄ¯':'Prisijunkite'}</p></div>

    ${m!=='reset'?`<button id="googleBtn" class="login-btn" style="background:var(--bg3);color:var(--text);display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:8px" ${state.authBusy?'disabled':''}>
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.84 2.07-1.79 2.71v2.26h2.9c1.7-1.56 2.68-3.87 2.68-6.61z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33C2.44 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.95 10.7c-.18-.54-.28-1.11-.28-1.7s.1-1.16.28-1.7V4.97H.96A8.99 8.99 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      TÄ™sti su Google
    </button>
    ${m!=='login'?`<p style="font-size:15px;color:var(--text3);text-align:center;margin-bottom:14px">TÄ™sdami sutinkate su <a href="terms.html" target="_blank" style="color:var(--accent)">Naudojimo sÄ…lygomis</a> ir <a href="privacy.html" target="_blank" style="color:var(--accent)">Privatumo politika</a></p>`:''}
    <div class="login-divider">arba</div>`:''}

    <input type="email" id="authEmail" class="login-input" placeholder="El. paÅ¡tas" autocomplete="email" value="${state.authEmail||''}" />
    ${m!=='reset'?`<input type="password" id="authPwd" class="login-input" placeholder="SlaptaÅ¾odis" autocomplete="${m==='register'?'new-password':'current-password'}" value="${state.authPwd||''}" />`:''}
    ${m==='register'?`<input type="password" id="authPwd2" class="login-input" placeholder="Pakartokite slaptaÅ¾odÄ¯" autocomplete="new-password" value="${state.authPwd2||''}" />`:''}

    ${m==='register'?`<label class="consent-row">
      <input type="checkbox" id="consentCheck" />
      <span>Sutinku su <a href="terms.html" target="_blank">Naudojimo sÄ…lygomis</a> ir <a href="privacy.html" target="_blank">Privatumo politika</a></span>
    </label>`:''}

    ${state.authError?`<p class="login-error">${esc(state.authError)}</p>`:''}
    ${state.authInfo?`<p class="login-info">${esc(state.authInfo)}</p>`:''}

    <button id="authSubmit" class="login-btn" ${state.authBusy?'disabled':''}>
      ${state.authBusy?'PraÅ¡ome palaukti...':m==='register'?'Sukurti paskyrÄ…':m==='reset'?'SiÅ³sti nuorodÄ…':'Prisijungti'}
    </button>

    ${m==='login'?`<div class="login-switch"><button id="toReset">PamirÅ¡ote slaptaÅ¾odÄ¯?</button></div>`:''}
    <div class="login-switch">
      ${m==='login'?`Neturite paskyros? <button id="toRegister">Registruotis</button>`
        :m==='register'?`Jau turite paskyrÄ…? <button id="toLogin">Prisijungti</button>`
        :`<button id="toLogin">GrÄ¯Å¾ti Ä¯ prisijungimÄ…</button>`}
    </div>
  </div></div>`;
}
function attachAuthEvents(){
  // { once: true } â€” listener automatiÅ¡kai paÅ¡alinamas po pirmo iÅ¡Å¡aukimo,
  // taip iÅ¡vengiama kaupimosi per kelis render() iÅ¡kvietimus
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
        state.authError='Turite sutikti su Naudojimo sÄ…lygomis ir Privatumo politika';
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

// â”€â”€ List â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    <div class="stat-tile"><div class="n" style="color:var(--red)">${expired}</div><div class="l">BaigÄ—si</div></div>
  </div>`:'';

  const aiLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;
  const planBanner = !isPremium ? `<div class="plan-banner">
    <i class="ti ti-sparkles"></i>
    <div class="pb-text">${aiLeft>0?`<b>${aiLeft}</b> nemokam${aiLeft===1?'a':'os'} AI analiz${aiLeft===1?'Ä—':'Ä—s'} liko`:'AI analizÄ—s iÅ¡naudotos'} Â· ${state.storageMode==='cloud'?'Cloud saugojimas':'Saugoma Å¡iame Ä¯renginyje'}</div>
    <button id="upgradeBtn">Premium</button>
  </div>`:'';

  const verifyBanner = !state.user.emailVerified ? `<div class="plan-banner" style="background:var(--accent-bg)">
    <i class="ti ti-mail-exclamation" style="color:var(--accent)"></i>
    <div class="pb-text" style="color:var(--accent)">Patvirtinkite el. paÅ¡tÄ…, kad galÄ—tumÄ—te naudoti AI analizÄ™. ${state.authInfo&&state.authInfo.includes('iÅ¡ naujo')?esc(state.authInfo):'Patikrinkite Spam aplankÄ….'}</div>
    <button id="resendVerifyBtn" style="background:var(--accent)" ${state.authBusy?'disabled':''}>${state.authBusy?'...':'SiÅ³sti dar kartÄ…'}</button>
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
          ${item.warrantyEnd?`<div class="card-date"><i class="ti ti-calendar" style="font-size:14px"></i>Iki ${fmtDate(item.warrantyEnd)}</div>`:''}
        </div>
      </button>
    </div>`;
  }).join('');

  const skeletonHtml = `<div class="skeleton-card"><div class="skeleton-box skel-thumb"></div><div class="skel-lines"><div class="skeleton-box skel-line" style="width:60%"></div><div class="skeleton-box skel-line" style="width:40%"></div></div></div>`.repeat(3);

  const emptyHtml=state.loadingItems ? skeletonHtml : items.length===0?`<div class="empty-state">
    <div class="empty-icon"><i class="ti ti-shield-check"></i></div>
    <h3>Dar nÄ—ra garantijÅ³</h3>
    <p>PridÄ—kite pirmÄ… daiktÄ… paspausdami + mygtukÄ… apaÄioje</p>
  </div>`:filtered.length===0?`<div class="empty-state"><div class="empty-icon"><i class="ti ti-filter-off"></i></div><h3>Nieko nerasta</h3><p>Pabandykite kitÄ… kategorijÄ…</p></div>`:'';

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
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sortBy==='newest'?'Naujausi':sortBy==='expiring'?'Baigiasi':'Aâ€“Z'}</span>
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
      <button class="sort-drop-item${sortBy==='name'?' active':''}" data-sort="name"><i class="ti ti-sort-a-z" style="font-size:14px"></i>Aâ€“Z</button>
    </div>` : ''}
    <div class="cards">${emptyHtml}${cardsHtml}</div>
    <div style="height:8px"></div>
  </div>`;
}

// â”€â”€ Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        ${item.docNumber?`<div class="card-date"><i class="ti ti-hash" style="font-size:14px"></i>${esc(item.docNumber)}</div>`:''}
      </div>
    </button>`;
  }).join('');

  return`<div>
    <div class="page-header" style="padding-bottom:14px"><span class="page-title">IeÅ¡koti</span></div>
    <div style="padding:12px 16px 4px">
      <div class="search-bar" style="margin:0"><i class="ti ti-search"></i><input type="search" id="searchInput" placeholder="Pavadinimas, dok. numeris..." value="${esc(q)}" autofocus /></div>
    </div>
    <div class="cards" style="margin-top:12px">
      ${!q?`<div class="empty-state" style="padding:40px 32px"><div class="empty-icon"><i class="ti ti-search"></i></div><p>Ä®veskite paieÅ¡kos Å¾odÄ¯</p></div>`:results.length===0?`<div class="empty-state" style="padding:40px 32px"><div class="empty-icon"><i class="ti ti-mood-sad"></i></div><h3>Nieko nerasta</h3></div>`:cardsHtml}
    </div>
  </div>`;
}

// â”€â”€ Add picker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderPicker(){
  const isPremium = isPremiumUser();
  const aiLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;
  const aiExhausted = !isPremium && aiLeft<=0;

  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-x"></i></button><h2>PridÄ—ti garantijÄ…</h2></div>
    <div class="picker-cards">
      <button class="picker-card" id="modePhoto">
        <div class="picker-icon" style="background:var(--accent-bg)"><i class="ti ti-camera" style="color:var(--accent)"></i></div>
        <div><h3>Su dokumentu${aiExhausted?'':' + AI'}</h3><p>${aiExhausted?'AI analizÄ—s iÅ¡naudotos â€“ galite vis tiek prisegti dokumentÄ… be automatinio atpaÅ¾inimo':`Nufotografuok arba Ä¯kelk â€“ AI iÅ¡trauks informacijÄ… automatiÅ¡kai${!isPremium?` (liko ${aiLeft})`:''}`}</p></div>
      </button>
      <button class="picker-card" id="modeManual">
        <div class="picker-icon" style="background:var(--green-bg)"><i class="ti ti-pencil" style="color:var(--green)"></i></div>
        <div><h3>Rankiniu bÅ«du</h3><p>Suveskite informacijÄ… patys â€“ visada nemokama. DokumentÄ… galima prisegti be AI</p></div>
      </button>
    </div>
    ${aiExhausted?`<div class="plan-banner" style="margin:0 16px 16px"><i class="ti ti-sparkles"></i><div class="pb-text">IÅ¡naudojote ${AI_FREE_USES} nemokamas AI analizes. Atsinaujinkite Ä¯ Premium.</div><button id="upgradeBtn3">Premium</button></div>`:''}
  </div>`;
}

// â”€â”€ Add form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderAdd(){
  const f=state.form;
  const isPhoto=state.addMode==='photo';
  const selOpt=WARRANTY_OPTS.find(o=>o.m===f.warrantyMonths)||WARRANTY_OPTS[WARRANTY_OPTS.length-1];
  const hasPdf=f.docData&&f.docMime==='application/pdf';
  const hasImg=f.docData&&f.docMime!=='application/pdf';

  let docAreaHtml='';
  const qrButtonHtml = !f.docData ? `<button type="button" class="qr-link-btn" disabled style="opacity:0.5;cursor:default"><i class="ti ti-qrcode"></i>QR skanavimas â€” netrukus</button>` : '';
  if(hasPdf){
    docAreaHtml=`<div class="doc-preview-pdf"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(f.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">PDF pridÄ—tas</div></div></div>`;
  }else if(hasImg){
    docAreaHtml=`<div style="position:relative"><img class="doc-preview-img" id="docThumb" src="${esc(f.docData)}" alt="" /><div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.55);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ti ti-zoom-in" style="font-size:14px;color:#fff"></i></div></div>`;
  }else{
    docAreaHtml=`${qrButtonHtml}<label class="doc-drop-zone" for="docInput">
      <i class="ti ti-${isPhoto?'camera':'paperclip'}"></i>
      <p>${isPhoto?'Fotografuoti arba Ä¯kelti':'Prisegti dokumentÄ… (neprivaloma)'}</p>
      <small>JPG, PNG, PDF Â· max 10MB / 5MB PDF</small>
    </label>`;
  }

  const multiItemBanner = state.aiMultiItems.length>0 ? `<div class="plan-banner" style="background:var(--accent-bg);margin-bottom:14px">
    <i class="ti ti-list-details" style="color:var(--accent)"></i>
    <div class="pb-text" style="color:var(--text)">Å iame Äekyje rasta dar <b style="color:var(--accent)">${state.aiMultiItems.length}</b> prekÄ—(-iÅ³). IÅ¡saugokite Å¡iÄ…, tada pridÄ—kite kitas be pakartotinio skenavimo.</div>
    <button id="nextMultiItemBtn">Kita prekÄ—</button>
  </div>` : '';

  const warrantySheet=state.showWarranty?`<div class="warranty-sheet" id="warrantySheet">
    <div class="warranty-overlay" id="warrantyOverlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title">Garantijos trukmÄ—</div>
      ${WARRANTY_OPTS.map(o=>`<button class="warranty-opt${f.warrantyMonths===o.m?' selected':''}" data-wm="${o.m??'x'}">${esc(o.l)}${f.warrantyMonths===o.m?`<i class="ti ti-check"></i>`:''}</button>`).join('')}
    </div>
  </div>`:'';

  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button><h2>${isPhoto?'PridÄ—ti su dokumentu':'Ä®vesti rankiniu bÅ«du'}</h2></div>
    <div class="form-body">
      ${!state.user.emailVerified&&isPhoto?`<div class="plan-banner" style="margin-bottom:14px"><i class="ti ti-mail-exclamation"></i><div class="pb-text">Patvirtinkite el. paÅ¡tÄ…, kad galÄ—tumÄ—te naudoti AI analizÄ™</div></div>`:''}
      ${multiItemBanner}
      <div class="doc-upload-area">
        ${docAreaHtml}
        <input type="file" id="docInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" ${isPhoto?'capture="environment"':''} style="display:none" />
        ${f.docData?`<button class="doc-remove-btn" id="removeDoc"><i class="ti ti-trash" style="font-size:14px"></i>PaÅ¡alinti dokumentÄ…</button>`:''}
        ${state.docError?`<p class="doc-error">${esc(state.docError)}</p>`:''}
        ${state.analyzing?`<div class="analyzing-row"><div class="spinner"></div><span style="font-size:15px;color:var(--text2)">AI analizuoja dokumentÄ…...</span></div>`:''}
      </div>

      <p class="form-label-section">PagrindinÄ— informacija</p>
      ${f.qualityWarning ? `<div style="background:var(--orange-bg);border-radius:var(--radius);margin:0 0 16px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start">
        <i class="ti ti-alert-triangle" style="font-size:20px;color:var(--orange);flex-shrink:0;margin-top:1px"></i>
        <div style="min-width:0">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px">${esc(f.qualityWarning)}</div>
          <div style="font-size:13px;color:var(--text2);margin-bottom:10px">Rekomenduojame nufotografuoti iÅ¡ naujo.</div>
          <button id="rescanBtn" style="background:var(--orange);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
            <i class="ti ti-camera"></i> Fotografuoti iÅ¡ naujo
          </button>
        </div>
      </div>` : ''}
      <div class="form-section">
        <div class="form-field">
          <label>PrekÄ—s pavadinimas</label>
          <input type="text" id="f_name" placeholder="pvz. Samsung TV 55&quot;" value="${esc(f.name)}" />
        </div>
        <div class="form-field">
          <label>ParduotuvÄ—</label>
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
        <div class="pb-text" style="color:var(--text);font-size:14px">AI: Å¡iai prekei garantija paprastai netaikoma â€” patikrinkite patys ir koreguokite jei reikia.</div>
      </div>` : ''}
        ${f.warrantyMonths===null?`<div class="form-field"><label>Galioja iki</label><input type="date" id="f_warrantyEnd" value="${esc(f.warrantyEnd)}" /></div>`:''}
        ${f.purchaseDate?`<div class="form-field"><label>14 d. grÄ…Å¾inimas iki</label><span style="font-size:16px;color:var(--text2)">${fmtDate(addDays(f.purchaseDate,14))}</span></div>`:''}
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
    <div style="position:fixed;bottom:65px;left:0;right:0;padding:10px 16px;background:var(--bg);border-top:0.5px solid var(--border);z-index:50">
      <button class="save-btn" id="saveBtn" ${f.name.trim()&&state.uploadPct===null?'':'disabled'}>${state.uploadPct!==null?'Saugoma...':'IÅ¡saugoti'}</button>
    </div>
  </div>`;
}

// â”€â”€ Detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderDetail(){
  const item=state.items.find(i=>i.id===state.selected);
  if(!item){state.view='list';render();return '';}
  const days=daysLeft(item.warrantyEnd);
  let sc,si,sv;
  if(days===null){sc='var(--bg2)';si='ti-shield';sv='Nenurodyta';}
  else if(days<0){sc='var(--red-bg)';si='ti-shield-x';sv='Garantija baigÄ—si';}
  else if(days<=30){sc='var(--orange-bg)';si='ti-shield-exclamation';sv=`Liko ${days} d.`;}
  else{sc='var(--green-bg)';si='ti-shield-check';sv=`Liko ${days} d.`;}
  const textColor=days===null?'var(--text2)':days<0?'var(--red)':days<=30?'var(--orange)':'var(--green)';
  const isPremium = isPremiumUser();

  let docHtml='';
  if(item.docUrl&&item.docMime==='application/pdf'){
    docHtml=`<div class="detail-section"><a class="doc-preview-pdf" href="${esc(item.docUrl)}" target="_blank"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(item.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">Spustelkite perÅ¾iÅ«rÄ—ti</div></div><i class="ti ti-external-link" style="font-size:18px;color:var(--red);flex-shrink:0"></i></a></div>`;
  }else if(item.docUrl){
    docHtml=`<div class="detail-section"><img src="${esc(item.docUrl)}" id="docImg" style="width:100%;border-radius:var(--radius);max-height:200px;object-fit:cover;cursor:pointer;display:block" /></div>`;
  }

  const rows=[
    {i:'ti-tag',l:'PrekÄ—s pavadinimas',v:item.name},
    {i:'ti-building-store',l:'ParduotuvÄ—',v:item.shop||'â€”'},
    {i:'ti-category',l:'Kategorija',v:item.category},
    {i:'ti-file-description',l:'Dok. tipas',v:item.docType||'â€”'},
    {i:'ti-hash',l:'Dok. numeris',v:item.docNumber||'â€”'},
    {i:'ti-calendar',l:'Pirkimo data',v:fmtDate(item.purchaseDate)},
    {i:'ti-calendar-due',l:'Garantija iki',v:fmtDate(item.warrantyEnd)},
    ...(item.returnDeadline ? [{i:'ti-rotate-2',l:'14 d. grÄ…Å¾inimas iki',v:fmtDate(item.returnDeadline)}] : []),
  ].map(r=>`<div class="detail-row"><i class="ti ${r.i}"></i><span class="dr-label">${esc(r.l)}</span><span class="dr-val">${esc(r.v)}</span></div>`).join('');

  const policySection = isPremium ? `<div class="detail-section">
    ${state.policyChecking ? `<div class="analyzing-row" style="justify-content:center"><div class="spinner"></div><span style="font-size:15px;color:var(--text2)">AI tikrina garantijos politikÄ…...</span></div>`
      : state.policyResult && state.policyResultFor===item.id ? `<div class="plan-banner" style="background:var(--accent-bg);align-items:flex-start">
          <i class="ti ti-info-circle" style="color:var(--accent);margin-top:2px;flex-shrink:0"></i>
          <div class="pb-text" style="color:var(--text);font-size:14px;line-height:1.5"><b style="color:var(--accent)">AI pasiÅ«lymas (patikrinkite patys):</b><br/>${esc(state.policyResult.replace(/\*\*/g,'').replace(/\*/g,''))}</div>
        </div>`
      : `<button class="qr-link-btn" id="checkPolicyBtn"><i class="ti ti-sparkles"></i>Patikrinti gamintojo garantijÄ… su AI</button>`}
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
    <div class="detail-section"><button class="delete-btn" id="deleteBtn2"><i class="ti ti-trash"></i>IÅ¡trinti Ä¯raÅ¡Ä…</button></div>
    <div style="height:8px"></div>
  </div>`;
}

// â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  const accountEmail = state.userDoc?.email || u.email || 'El. paÅ¡tas nerastas';
  const accountName = u.displayName || accountEmail;
  const providers = (u.providerData||[]).map(p=>p.providerId);
  const providerLabel = providers.includes('google.com') ? 'Google' : 'El. paÅ¡tas';
  const uidShort = u.uid ? u.uid.slice(0,8) : 'â€”';
  const planLabel = state.userDoc?.role==='admin'
    ? '<i class="ti ti-shield-check" style="font-size:15px"></i> Administratorius'
    : state.userDoc?.plan==='tester'
      ? '<i class="ti ti-flask" style="font-size:15px"></i> Testeris Â· Premium teisÄ—s'
      : state.userDoc?.plan==='friend'
        ? '<i class="ti ti-heart" style="font-size:15px"></i> Draugas Â· Premium teisÄ—s'
        : isPremium
          ? '<i class="ti ti-crown" style="font-size:15px"></i> Premium narys'
          : `Nemokamas planas Â· ${state.items.length} Ä¯raÅ¡Å³`;

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
        <div style="font-size:12px;color:var(--text3);margin-top:2px">${providerLabel} Â· ID ${esc(uidShort)}</div>
      </div>
    </div>

    ${!isPremium ? `<div class="plan-banner" style="margin:0 16px 16px">
      <i class="ti ti-crown"></i>
      <div class="pb-text">Atsinaujinkite Ä¯ Premium â€“ paskyros sinchronizacija ir iki ${PREMIUM_DAILY_LIMIT} AI analiziÅ³ per dienÄ…</div>
      <button id="upgradeBtnSettings">Premium</button>
    </div>` : ''}

    <p class="form-label-section" style="margin:0 16px 8px">DuomenÅ³ vieta</p>
    <div class="form-section" style="margin:0 16px 8px">
      <button class="settings-row tappable" id="storageModeToggle" style="width:100%;background:none;border:none;text-align:left;${(!isPremium && !isCloud)?'opacity:0.65':''}" ${(!isPremium && !isCloud)?'disabled':''}>
        <i class="ti ti-${isCloud?'cloud':'device-mobile'} row-icon"></i>
        <div class="settings-row-label">${isCloud?'Paskyroje':'Tik Å¡iame telefone'}<small>${isCloud?'Ä®raÅ¡ai saugomi paskyroje ir pasiekiami iÅ¡ kitÅ³ Ä¯renginiÅ³':'Privatumo reÅ¾imas: Ä¯raÅ¡ai lieka tik Å¡iame telefone'}</small></div>
        ${isPremium || isCloud ? `<span style="font-size:14px;color:var(--accent);font-weight:600">${isCloud?'Saugoti tik telefone':'Perkelti Ä¯ paskyrÄ…'}</span>` : '<i class="ti ti-lock" style="color:var(--text3);font-size:16px"></i>'}
      </button>
    </div>
    ${state.storageError ? `<div style="margin:0 16px 12px;padding:12px 14px;border-radius:12px;background:var(--red-bg);color:var(--red);font-size:14px;line-height:1.45">${esc(state.storageError)}</div>` : ''}
    <p style="font-size:13px;color:var(--text3);padding:0 16px 20px;line-height:1.5">
      ${isCloud?'Tai rekomenduojamas Premium reÅ¾imas: duomenys nepririÅ¡ti prie vieno telefono. Jei labiau rÅ«pi privatumas, galite perkelti Ä¯raÅ¡us tik Ä¯ Å¡Ä¯ telefonÄ….':isPremium?'Dabar naudojate privatumo reÅ¾imÄ…: Ä¯raÅ¡ai saugomi tik Å¡iame telefone. Premium leidÅ¾ia juos perkelti Ä¯ paskyrÄ…, kad nepradingtÅ³ pakeitus ar praradus telefonÄ….':'Paskyros saugykla prieinama Premium / Tester / Draugas paskyroms. Nemokamame plane Ä¯raÅ¡ai saugomi tik telefone.'}
    </p>

    <p class="form-label-section" style="margin:0 16px 8px">AI analizÄ—</p>
    <div class="form-section" style="margin:0 16px 20px">
      ${isPremium ? `
      <div class="detail-row" style="padding:13px 16px">
        <i class="ti ti-sparkles" style="font-size:18px;color:var(--text3);width:20px"></i>
        <span class="dr-label">Å iandien</span>
        <span class="dr-val">${state.userDoc?.aiDayKey===new Date().toISOString().slice(0,10)?(state.userDoc?.aiDayCount||0):0}/${PREMIUM_DAILY_LIMIT}</span>
      </div>
      <div class="detail-row" style="padding:13px 16px">
        <i class="ti ti-calendar" style="font-size:18px;color:var(--text3);width:20px"></i>
        <span class="dr-label">Å Ä¯ mÄ—nesÄ¯</span>
        <span class="dr-val">${state.userDoc?.aiMonthKey===new Date().toISOString().slice(0,7)?(state.userDoc?.aiMonthCount||0):0}/${PREMIUM_MONTHLY_LIMIT}</span>
      </div>` : `
      <div class="detail-row" style="padding:13px 16px">
        <i class="ti ti-sparkles" style="font-size:18px;color:var(--text3);width:20px"></i>
        <span class="dr-label">Liko nemokamÅ³ analiziÅ³</span>
        <span class="dr-val">${aiLeft}/${AI_FREE_USES}</span>
      </div>`}
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">IÅ¡vaizda</p>
    <div class="form-section" style="margin:0 16px 20px;padding:14px 16px">
      <div class="theme-picker">
        <button class="theme-opt${state.theme==='auto'?' active':''}" data-theme="auto"><i class="ti ti-device-mobile"></i><span>Auto</span></button>
        <button class="theme-opt${state.theme==='light'?' active':''}" data-theme="light"><i class="ti ti-sun"></i><span>Å viesi</span></button>
        <button class="theme-opt${state.theme==='dark'?' active':''}" data-theme="dark"><i class="ti ti-moon"></i><span>Tamsi</span></button>
      </div>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">PraneÅ¡imai</p>
    <div class="form-section" style="margin:0 16px 20px">
      <div class="settings-row">
        <i class="ti ti-bell row-icon"></i>
        <div class="settings-row-label">Garantijos baigiasi<small>Priminimas likus 30 dienÅ³</small></div>
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
        <i class="ti ti-lock row-icon"></i><span class="settings-row-label">Pakeisti slaptaÅ¾odÄ¯</span><i class="ti ti-chevron-right" style="color:var(--text3)"></i>
      </button>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Pagalba</p>
    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable" id="helpContactBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-help-circle row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Susisiekti su pagalba<small>RaÅ¡ykite mums tiesiogiai</small></span>
      </button>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">TeisinÄ— informacija</p>
    <div class="form-section" style="margin:0 16px 20px">
      <a class="settings-row tappable" href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-shield-lock row-icon"></i><span class="settings-row-label">Privatumo politika</span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
      <a class="settings-row tappable" href="terms.html" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:flex">
        <i class="ti ti-file-text row-icon"></i><span class="settings-row-label">Naudojimo sÄ…lygos</span><i class="ti ti-external-link" style="color:var(--text3);font-size:14px"></i>
      </a>
    </div>

    <div class="form-section" style="margin:0 16px 20px">
      <button class="settings-row tappable danger" id="deleteAccountBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-trash row-icon"></i><span class="settings-row-label">IÅ¡trinti paskyrÄ…</span>
      </button>
    </div>

    <p style="text-align:center;font-size:15px;color:var(--text3);padding:0 16px 24px">Galio v1.0 Â· Duomenys saugomi debesyje</p>
  </div>`;
}

// â”€â”€ Notification modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// SiÅ«lomi priminimai pagal garantijos ilgÄ¯
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

  const suggested = suggestNotifDays(item?.warrantyMonths, !!item?.returnDeadline);
  // Naudoti paskutinius nustatymus jei yra, kitaip siÅ«lomus
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
      <h3 style="font-size:18px;font-weight:700;margin:0 0 6px">Priminimai</h3>
      <p style="font-size:14px;color:var(--text3);margin:0 0 20px">Priminsime prieÅ¡ garantijos pabaigÄ….</p>

      ${m.item?.warrantyEnd ? `
      <p style="font-size:13px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">PrieÅ¡ garantijos pabaigÄ…</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
        ${DAY_OPTS.map(d=>`
          <button class="notif-day-btn${sel.has(d)?' active':''}" data-day="${d}" style="padding:8px 14px;border-radius:20px;border:1.5px solid ${sel.has(d)?'var(--accent)':'var(--border2)'};background:${sel.has(d)?'var(--accent)':'transparent'};color:${sel.has(d)?'#fff':'var(--text2)'};font-size:14px;font-weight:500;cursor:pointer">
            ${d===1?'1 dienÄ…':d===7?'1 savaitÄ™':d===30?'1 mÄ—nesÄ¯':d===60?'2 mÄ—nesius':d+' d.'}
          </button>`).join('')}
      </div>` : ''}

      ${m.hasReturn ? `
      <p style="font-size:13px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px">PrieÅ¡ grÄ…Å¾inimo terminÄ…</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">
        ${[1,2,3,5,7].map(d=>`
          <button class="notif-ret-btn${retSel.has(d)?' active':''}" data-day="${d}" style="padding:8px 14px;border-radius:20px;border:1.5px solid ${retSel.has(d)?'var(--accent)':'var(--border2)'};background:${retSel.has(d)?'var(--accent)':'transparent'};color:${retSel.has(d)?'#fff':'var(--text2)'};font-size:14px;font-weight:500;cursor:pointer">
            ${d===1?'1 dienÄ…':d===7?'1 savaitÄ™':d+' d.'}
          </button>`).join('')}
      </div>` : ''}

      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-top:0.5px solid var(--border);margin-bottom:20px">
        <div>
          <div style="font-size:15px;font-weight:500">Kartoti kas savaitÄ™</div>
          <div style="font-size:13px;color:var(--text3)">Nuo 30 dienÅ³ iki pabaigos</div>
        </div>
        <button class="toggle-switch${m.repeatEnabled?' on':''}" id="notifRepeatToggle"><div class="knob"></div></button>
      </div>

      <button id="notifSaveBtn" class="save-btn" style="margin-bottom:10px">Ä®jungti priminimus</button>
      <button id="notifSkipBtn" style="background:none;border:none;color:var(--text3);font-size:14px;width:100%;padding:10px;cursor:pointer">Praleisti</button>
    </div>
  </div>`;
}

// â”€â”€ Contact form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      <p style="font-size:16px;font-weight:600;margin:16px 0 8px">Å½inutÄ— iÅ¡siÅ³sta!</p>
      <p style="font-size:14px;color:var(--text2);margin:0 0 24px">Atsakysime Ä¯ <strong>${state.user?.email||''}</strong> kuo greiÄiau.</p>
      <button class="btn-primary" id="contactBackBtn2" style="width:auto;padding:10px 28px">GrÄ¯Å¾ti</button>
    </div>
    ` : `
    <div style="padding:16px">
      <p style="font-size:14px;color:var(--text2);margin:0 0 20px">Turite klausimÄ… ar problemÄ…? ParaÅ¡ykite mums â€” atsakysime el. paÅ¡tu.</p>
      <p class="form-label-section" style="margin:0 0 6px">El. paÅ¡tas</p>
      <div class="form-section" style="margin:0 0 12px;padding:12px 14px">
        <input id="contactEmail" type="email" placeholder="jusu@pastas.lt" style="width:100%;background:none;border:none;outline:none;font-size:15px;color:var(--text1);box-sizing:border-box"
          value="${(state.user?.email||'').replace(/"/g,'&quot;')}">
      </div>
      <p class="form-label-section" style="margin:0 0 6px">Å½inutÄ—</p>
      <div class="form-section" style="margin:0 0 20px;padding:12px 14px">
        <textarea id="contactMsg" rows="5" placeholder="ApraÅ¡ykite problemÄ… arba klausimÄ…..." style="width:100%;background:none;border:none;outline:none;font-size:15px;color:var(--text1);resize:none;box-sizing:border-box">${state.contactDraft||''}</textarea>
      </div>
      ${state.contactError ? `<p style="color:var(--red);font-size:15px;margin:0 0 12px">${state.contactError}</p>` : ''}
      <button id="contactSendBtn" class="btn-primary" style="width:100%" ${busy?'disabled':''}>
        ${busy ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;margin:0 auto"></span>' : '<i class="ti ti-send"></i> SiÅ³sti'}
      </button>
    </div>
    `}
  </div>`;
}

// â”€â”€ Multi-item select â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderMultiSelect(){
  const r = state.multiItemReceipt;
  if(!r){ state.view='list'; return ''; }
  const selectedCount = r.items.filter(i=>i.selected).length;

  const rows = r.items.map((item,idx)=>{
    const noWarranty = item.warrantyApplies===false;
    const dimmed = noWarranty && !item.selected;
    return `<div style="display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:0.5px solid var(--border)" class="multi-row" data-midx="${idx}">
      <div style="width:24px;height:24px;border-radius:6px;border:2px solid ${item.selected?'var(--accent)':'var(--border2)'};background:${item.selected?'var(--accent)':'transparent'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s">
        ${item.selected?`<i class="ti ti-check" style="font-size:13px;color:#fff"></i>`:''}
      </div>
      <div style="flex:1;min-width:0">
        <div data-mname style="font-size:15px;font-weight:600;color:${dimmed?'var(--text3)':'var(--text)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</div>
        <div style="font-size:13px;color:var(--text3);margin-top:2px;display:flex;align-items:center;gap:6px">
          ${item.category?`<span>${esc(item.category)}</span>`:''}
          ${!noWarranty?`<span style="color:var(--green)">${item.warrantyMonths||24} mÄ—n.</span>`:''}
          ${item.price?`<span>${esc(String(item.price))} â‚¬</span>`:''}
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
      <div style="font-size:12px;color:var(--text3);margin-top:2px">${r.purchaseDate?fmtDate(r.purchaseDate):''} Â· Pasirinkite kÄ… iÅ¡saugoti</div>
    </div>
    <div style="flex:1;overflow-y:auto;padding-bottom:80px">
      <div style="background:var(--card);border-radius:var(--radius);margin:12px 16px;overflow:hidden">
        ${rows}
      </div>
    </div>
    <div style="position:fixed;bottom:65px;left:0;right:0;padding:10px 16px;background:var(--bg);border-top:0.5px solid var(--border);z-index:50;display:flex;gap:10px;align-items:center">
      <button id="multiCancelBtn" style="background:none;border:1px solid var(--border2);color:var(--text3);font-size:14px;padding:10px 16px;border-radius:12px;cursor:pointer;flex-shrink:0">AtÅ¡aukti</button>
      <button id="multiSaveBtn" ${selectedCount===0?'disabled':''} class="save-btn" style="flex:1;opacity:${selectedCount===0?'0.4':'1'}">
        IÅ¡saugoti${selectedCount>0?` (${selectedCount})`:''}
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
      <div class="stat-tile"><div class="n">${s.totalUsers}</div><div class="l">VartotojÅ³</div></div>
      <div class="stat-tile"><div class="n" style="color:var(--gold)">${s.premiumUsers}</div><div class="l">Premium</div></div>
      <div class="stat-tile"><div class="n" style="color:var(--accent)">${s.testerUsers}</div><div class="l">TesteriÅ³</div></div>
    </div>
    <div class="detail-section" style="margin:0 16px 16px">
      <div class="detail-rows">
        <div class="detail-row"><i class="ti ti-receipt"></i><span class="dr-label">Viso garantijÅ³ Ä¯raÅ¡Å³</span><span class="dr-val">${s.totalItems}</span></div>
        <div class="detail-row"><i class="ti ti-mail-check"></i><span class="dr-label">PatvirtintÅ³ el. paÅ¡tÅ³</span><span class="dr-val">${s.verifiedUsers}/${s.totalUsers}</span></div>
        <div class="detail-row"><i class="ti ti-calendar-plus"></i><span class="dr-label">NaujÅ³ per 7 d.</span><span class="dr-val">${s.newLast7Days}</span></div>
      </div>
    </div>

    <p class="form-label-section" style="margin:0 16px 8px">Vartotojai</p>
    <div class="form-section" style="margin:0 16px 16px;padding:0">
      ${users.length===0 ? `<div style="padding:16px;text-align:center;color:var(--text3);font-size:14px">NÄ—ra vartotojÅ³</div>` :
        users.map(u => {
          const planLabel = u.plan==='premium' ? 'ðŸ‘‘ Premium' : u.plan==='tester' ? 'ðŸ§ª Testeris' : u.plan==='friend' ? 'â¤ï¸ Draugas' : 'Nemokamas';
          const planColor = u.plan==='premium' ? 'var(--gold)' : u.plan==='tester' ? 'var(--accent)' : u.plan==='friend' ? 'var(--red)' : 'var(--text3)';
          const isTester = u.plan==='tester';
          const isFriend = u.plan==='friend';
          const isPremiumPlan = u.plan==='premium';
          const isAdminUser = u.role==='admin';
          return `<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px;padding:12px 14px">
            <div style="display:flex;width:100%;align-items:center;gap:6px;flex-wrap:wrap">
              <div style="flex:1 1 100%;min-width:0">
                <div style="font-size:15px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.email}</div>
                <div style="font-size:15px;color:${planColor};margin-top:2px">${planLabel}${isAdminUser?' Â· Admin':''}${u.emailVerified?' Â· âœ“':''} Â· ${u.itemCount||0} Ä¯raÅ¡Å³</div>
              </div>
              ${!isAdminUser ? `<button class="chip${isPremiumPlan?' active':''}" data-uid="${u.uid}" data-action="togglePremium" style="font-size:15px;padding:3px 8px;flex-shrink:0">${isPremiumPlan?'✓ Premium':'Premium'}</button>` : ''}
              ${!isAdminUser ? `<button class="chip${isTester?' active':''}" data-uid="${u.uid}" data-action="toggleTester" style="font-size:15px;padding:3px 8px;flex-shrink:0">${isTester?'âœ“ Testeris':'Testeris'}</button>
              <button class="chip${isFriend?' active':''}" data-uid="${u.uid}" data-action="toggleFriend" style="font-size:15px;padding:3px 8px;flex-shrink:0">${isFriend?'âœ“ Draugas':'Draugas'}</button>` : ''}
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

    // SkaiÄiuojam tikrÄ… warranties kiekÄ¯ iÅ¡ subkolekcijos kiekvienam vartotojui
    await Promise.all(snap.docs.map(async d=>{
      const u = d.data();
      totalUsers++;
      if(u.plan==='premium') premiumUsers++;
      if(u.plan==='tester') testerUsers++;
      if(u.emailVerified) verifiedUsers++;
      if(u.createdAt?.toMillis && u.createdAt.toMillis() > weekAgoMs) newLast7Days++;

      // Tikras Ä¯raÅ¡Å³ skaiÄius iÅ¡ warranties subkolekcijos
      let realCount = 0;
      try{
        const wSnap = await getDocs(collection(db,'users',d.id,'warranties'));
        realCount = wSnap.size;
      }catch(e){ realCount = u.itemCount||0; } // fallback Ä¯ cached jei nepavyksta

      if(realCount > 0) activeUsers++;
      totalItems += realCount;
      usersList.push({ uid: d.id, email: u.email||'â€”', plan: u.plan||'free', role: u.role||'', itemCount: realCount, emailVerified: !!u.emailVerified });
    }));

    usersList.sort((a,b)=>a.email.localeCompare(b.email));
    state.adminStats = { totalUsers, premiumUsers, testerUsers, activeUsers, totalItems, verifiedUsers, newLast7Days };
    state.adminUsers = usersList;
  }catch(e){
    toast('Nepavyko Ä¯kelti statistikos');
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
  on('upgradeBtn','click',()=>toast('Premium netrukus! ðŸš€'));
  on('upgradeBtn3','click',()=>toast('Premium netrukus! ðŸš€'));
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
    state.addMode='photo';state.aiRetriesUsedThisItem=0;state.pendingAiCharge=false;state.aiMultiItems=[];
    renderSync();
    requestAnimationFrame(()=>{ document.getElementById('docInput')?.click(); });
  });
  on('modeManual','click',()=>{state.addMode='manual';render();});

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

  on('docInput','change',handleDoc);
  on('qrScanBtn','click',startQrScanner);
  on('removeDoc','click',()=>{state.form.docData=null;state.form.docMime=null;state.form.docFileName=null;state.docError='';render();});
  on('docThumb','click',()=>{if(state.form.docData)state.lightbox=state.form.docData;render();});
  on('docImg','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it?.docUrl)state.lightbox=it.docUrl;render();});

  on('saveBtn','click',()=>{
    if(state.multiEditIdx!=null){
      // Atnaujiname prekÄ™ multi sÄ…raÅ¡e
      const idx=state.multiEditIdx;
      const r=state.multiItemReceipt;
      const f=state.form;
      if(r&&r.items[idx]){
        r.items[idx].name=f.name;
        r.items[idx].category=f.category;
        r.items[idx].warrantyMonths=f.warrantyMonths;
        r.items[idx].warrantyApplies=f.warrantyMonths!==null;
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
    // No new AI call/charge here â€” this item's data already came from the
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
      docType: item.docType||'Kvitas / Äekis',
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
  on('upgradeBtnSettings','click',()=>toast('Premium netrukus! ðŸš€'));
  onAll('.theme-opt','click',e=>{
    const t=e.currentTarget.dataset.theme;
    state.theme=t; localStorage.setItem('galio_theme',t); applyTheme(); render();
  });
  on('notifyToggle','click',toggleNotify);
  on('storageModeToggle','click',toggleStorageMode);
  on('changePwdBtn','click',()=>{
    if(!state.user.email){toast('Google paskyroms slaptaÅ¾odÅ¾io keisti nereikia');return;}
    sendPasswordResetEmail(auth,state.user.email)
      .then(()=>toast('Nuoroda slaptaÅ¾odÅ¾iui keisti iÅ¡siÅ³sta Ä¯ el. paÅ¡tÄ…'))
      .catch(()=>toast('Klaida siunÄiant laiÅ¡kÄ…'));
  });
  on('settingsLogoutBtn2','click',()=>{if(confirm('Atsijungti?'))doLogout();});
  on('deleteAccountBtn','click',confirmDeleteAccount);
  on('multiBackBtn','click',()=>{ state.multiItemReceipt=null; state.view='list'; render(); });
  on('multiCancelBtn','click',()=>{ state.multiItemReceipt=null; state.view='list'; render(); });
  onAll('.multi-row','click',e=>{
    if(e.target.closest('.multi-edit-btn')) return;
    const idx=parseInt(e.currentTarget.dataset.midx);
    const r=state.multiItemReceipt;
    if(!r) return;
    const item=r.items[idx];
    item.selected=!item.selected;

    // Atnaujinti tik Å¡iÄ… eilutÄ™ ir mygtukÄ… â€” be pilno re-render (greitis su ilgais Äekiais)
    const row=e.currentTarget;
    const box=row.querySelector('div');
    if(box){
      box.style.border=`2px solid ${item.selected?'var(--accent)':'var(--border2)'}`;
      box.style.background=item.selected?'var(--accent)':'transparent';
      box.innerHTML=item.selected?'<i class="ti ti-check" style="font-size:13px;color:#fff"></i>':'';
    }
    const nameEl=row.querySelector('[data-mname]');
    if(nameEl){
      const noWarranty=item.warrantyApplies===false;
      nameEl.style.color=(noWarranty&&!item.selected)?'var(--text3)':'var(--text)';
    }
    const btn=document.getElementById('multiSaveBtn');
    if(btn){
      const n=r.items.filter(i=>i.selected).length;
      btn.disabled=n===0;
      btn.style.opacity=n===0?'0.4':'1';
      btn.textContent=`IÅ¡saugoti${n>0?` (${n})`:''}`;
    }
  });
  onAll('.multi-edit-btn','click',e=>{
    e.stopPropagation();
    const idx=parseInt(e.currentTarget.dataset.midx);
    const r=state.multiItemReceipt;
    if(!r) return;
    const item=r.items[idx];
    // UÅ¾pildome formÄ… Å¡ios prekÄ—s duomenimis
    state.form=emptyForm();
    state.form.name=item.name||'';
    state.form.category=item.category||'';
    state.form.shop=r.shop||'';
    state.form.purchaseDate=r.purchaseDate||'';
    state.form.warrantyMonths=item.warrantyApplies===false?null:(item.warrantyMonths||24);
    state.form.warrantyEnd=item.warrantyApplies===false?'':(r.purchaseDate&&item.warrantyMonths?addMonths(r.purchaseDate,item.warrantyMonths):'');
    state.form.docType=r.docType||'Kvitas / Äekis';
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
  on('notifSkipBtn','click',()=>{ state.notifModal=null; render(); });
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
    if(!confirm(`${newPlan==='tester'?'Suteikti testerio planÄ…':'Atimti testerio planÄ…'} vartotojui ${user.email}?`)) return;
    try{
      await updateDoc(doc(db,'users',uid), { plan: newPlan });
      user.plan = newPlan;
      toast(newPlan==='tester' ? `âœ“ ${user.email} dabar testeris` : `âœ“ ${user.email} grÄ…Å¾intas Ä¯ nemokamÄ… planÄ…`);
      render();
    }catch(err){ toast('Nepavyko â€” ' + (err.message||'klaida')); }
  });
  onAll('[data-action="toggleFriend"]','click', async e=>{
    const uid = e.currentTarget.dataset.uid;
    const user = state.adminUsers?.find(u=>u.uid===uid);
    if(!user) return;
    const newPlan = user.plan==='friend' ? 'free' : 'friend';
    if(!confirm(`${newPlan==='friend'?'Suteikti draugo planÄ…':'Atimti draugo planÄ…'} vartotojui ${user.email}?`)) return;
    try{
      await updateDoc(doc(db,'users',uid), { plan: newPlan });
      user.plan = newPlan;
      toast(newPlan==='friend' ? `âœ“ ${user.email} dabar draugas` : `âœ“ ${user.email} grÄ…Å¾intas Ä¯ nemokamÄ… planÄ…`);
      render();
    }catch(err){ toast('Nepavyko â€” ' + (err.message||'klaida')); }
  });
}

async function sendContactMessage(){
  const emailEl = document.getElementById('contactEmail');
  const msgEl   = document.getElementById('contactMsg');
  const email   = (emailEl?.value||'').trim();
  const message = (msgEl?.value||'').trim();

  if(!email || !message){
    state.contactError = 'PraÅ¡ome uÅ¾pildyti el. paÅ¡tÄ… ir Å¾inutÄ™.';
    render(); return;
  }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    state.contactError = 'Neteisingas el. paÅ¡to formatas.';
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
  const diag = `El. paÅ¡tas: ${u?.email||'â€”'} | UID: ${u?.uid||'â€”'} | Planas: ${plan} | Saugojimas: ${mode} | Patvirtintas: ${u?.emailVerified?'taip':'ne'} | v1.0`;

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
    state.contactError = e.message || 'Nepavyko iÅ¡siÅ³sti. Bandykite vÄ—liau.';
  } finally {
    state.contactBusy = false;
    render();
  }
}

function syncSave(){const b=document.getElementById('saveBtn');if(b)b.disabled=!state.form.name.trim();}

async function deleteItem(id){
  if(!confirm('IÅ¡trinti Å¡Ä¯ Ä¯raÅ¡Ä…?'))return;
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
    toast('IÅ¡trinta');
  }catch(e){ toast('Klaida trinant: '+(e.message||'')); }
  state.view='list';render();
}

async function saveNotifSettings(){
  const m = state.notifModal;
  if(!m) return;

  // IÅ¡saugoti kaip naujus defaults
  state._lastNotifDays = [...m.selectedDays];
  state._lastReturnNotifDays = [...m.returnSelectedDays];

  const notifData = {
    notifyEnabled: true,
    notifyDays: m.selectedDays,
    notifyReturnDays: m.returnSelectedDays,
    notifyRepeatDays: m.repeatEnabled ? { interval: m.repeatInterval, startDay: 30 } : null,
  };

  try{
    // PraÅ¡yti push leidimo
    const perm = await requestPushPermission();
    if(perm){
      notifData.fcmTokenUpdated = true;
    }

    // IÅ¡saugoti Ä¯ Firestore arba IndexedDB
    if(state.storageMode==='cloud'){
      await updateDoc(doc(db,'users',state.user.uid,'warranties',m.itemId), notifData);
    }else{
      const item = state.items.find(i=>i.id===m.itemId);
      if(item){
        Object.assign(item, notifData);
        await localPut(state.user.uid, item);
      }
    }
    toast('Priminimai Ä¯jungti âœ“');
  }catch(e){
    console.warn('Notif save error:', e);
    toast('Nepavyko Ä¯jungti priminimÅ³');
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

async function updateItem(){
  if(!state.editItemId||!state.form.name.trim()) return;
  const f = state.form;
  const isCloud = state.storageMode==='cloud';
  const payload = {
    name: f.name.trim().slice(0,200),
    category: f.category||'Kita',
    shop: f.shop.slice(0,100),
    purchaseDate: f.purchaseDate||'',
    warrantyEnd: f.warrantyEnd||'',
    warrantyMonths: f.warrantyMonths??null,
    docType: f.docType||'Kvitas / Äekis',
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
    toast('IÅ¡saugota âœ“');
    state.editItemId=null; state.addMode=null; state.view='detail';
    render();
  }catch(e){
    toast('Klaida iÅ¡saugant: '+(e.message||''));
  }
}

async function saveItem(){
  if(!state.form.name.trim())return;
  const f=state.form;
  const isCloud = state.storageMode==='cloud';

  // Charge AI quota now, only if this save includes AI-assisted data the
  // user is actually keeping. Scans that were retried/discarded never
  // reach this point, so they never cost quota â€” only a kept result does.
  if(state.pendingAiCharge){
    const isPremium = isPremiumUser();
    try{
      if(!isPremium){
        await updateDoc(doc(db,'users',state.user.uid), { aiUsesRemaining: increment(-1) });
        // Atnaujinti lokaliai iÅ¡ karto â€” onSnapshot gali vÄ—luoti dÄ—l cache
        if(state.userDoc) state.userDoc.aiUsesRemaining = Math.max(0, (state.userDoc.aiUsesRemaining ?? AI_FREE_USES) - 1);
      }else{
        const today = new Date().toISOString().slice(0,10);
        const month = today.slice(0,7);
        const dayKey = state.userDoc?.aiDayKey;
        const monthKey = state.userDoc?.aiMonthKey;
        await updateDoc(doc(db,'users',state.user.uid), {
          aiDayKey: today,
          aiDayCount: dayKey===today ? increment(1) : 1,
          aiMonthKey: month,
          aiMonthCount: monthKey===month ? increment(1) : 1,
        });
      }
    }catch(e){ console.warn('Failed to charge AI quota on save:', e); }
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
          toast('Dokumentas neiÅ¡saugotas (klaida Ä¯keliant failÄ…)');
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

    toast('IÅ¡saugota âœ“');
  }catch(e){
    toast('Klaida saugant: '+(e.message||''));
  }

  state.uploadPct=null;
  const savedForm = {...state.form};
  state.form=emptyForm();state.docError='';state.addMode=null;

  // Rodyti priminimÅ³ modalÄ… tik jei yra kÄ… priminti (garantija arba grÄ…Å¾inimas)
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

  const isCloud = state.storageMode==='cloud';
  let saved=0, failed=0;

  // Charge one AI scan for the whole receipt (already scanned once)
  // pendingAiCharge was set true during analyzeDoc â€” charge it now
  if(state.pendingAiCharge){
    const isPremium = isPremiumUser();
    try{
      if(!isPremium){
        await updateDoc(doc(db,'users',state.user.uid),{aiUsesRemaining:increment(-1)});
        if(state.userDoc) state.userDoc.aiUsesRemaining=Math.max(0,(state.userDoc.aiUsesRemaining??AI_FREE_USES)-1);
      }
    }catch(e){ console.warn('AI quota charge failed:',e); }
    state.pendingAiCharge=false;
  }

  toast(`Saugoma ${selected.length} prekiÅ³...`);

  for(const item of selected){
    try{
      const payload={
        name:item.name.trim().slice(0,200),
        category:item.category||'Kita',
        shop:(r.shop||'').slice(0,100),
        purchaseDate:r.purchaseDate||'',
        warrantyEnd: item.warrantyApplies===false ? '' : (r.purchaseDate&&item.warrantyMonths ? addMonths(r.purchaseDate,item.warrantyMonths) : ''),
        warrantyMonths: item.warrantyApplies===false ? null : (item.warrantyMonths||null),
        docType:r.docType||'Kvitas / Äekis',
        docNumber:(r.docNumber||'').slice(0,100),
        notes:item.price?`Kaina: ${String(item.price).slice(0,50)}`:'',
        notifyEnabled:true, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
        returnDeadline: r.purchaseDate ? addDays(r.purchaseDate,14) : null,
        // Numatytieji priminimai pagal garantijos ilgÄ¯ (vartotojas gali keisti redaguodamas)
        notifyDays: item.warrantyApplies===false ? [] : suggestNotifDays(item.warrantyMonths||24),
        notifyReturnDays: r.purchaseDate ? [3] : [],
        createdAtMs: Date.now(),
      };

      if(isCloud){
        const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'),{...payload,createdAt:serverTimestamp()});
        await updateDoc(doc(db,'users',state.user.uid),{itemCount:increment(1)});
        // DokumentÄ… pridedame tik prie pirmos prekÄ—s
        if(saved===0 && r.docData && r.docMime){
          try{
            const ext=r.docMime==='application/pdf'?'pdf':(r.docMime.split('/')[1]||'jpg');
            const path=`users/${state.user.uid}/documents/${docRef.id}.${ext}`;
            const blob=base64ToBlob(r.docMime==='application/pdf'?r.docData:r.docData.split(',')[1],r.docMime);
            await uploadBytes(ref(storage,path),blob,{contentType:r.docMime});
            const url=await getDownloadURL(ref(storage,path));
            await updateDoc(docRef,{docUrl:url,docMime:r.docMime,docFileName:r.docFileName||null,docStoragePath:path});
          }catch(e){ console.warn('Doc upload failed:',e); }
        }
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
  if(failed>0) toast(`IÅ¡saugota ${saved}, nepavyko ${failed}`);
  else toast(`IÅ¡saugota ${saved} prekiÅ³ âœ“`);
}

function base64ToBlob(b64,mime){
  const s=atob(b64),a=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);
  return new Blob([a],{type:mime});
}

// â”€â”€ Document picking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€ QR scanner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    <div class="qr-scanner-hint" id="qrHint">Nukreipkite kamerÄ… Ä¯ QR kodÄ… ant Äekio</div>
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
        if(hint) hint.textContent = 'IeÅ¡koma QR kodo...';
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
  const amountMatch = text.match(/(\d+[.,]\d{2})\s*(EUR|â‚¬)?/i);
  if(amountMatch) foundAmount = amountMatch[1].replace(',', '.');

  if(foundDate){
    state.form.purchaseDate = foundDate;
    if(state.form.warrantyMonths) state.form.warrantyEnd = addMonths(foundDate, state.form.warrantyMonths);
  }
  if(foundAmount){
    state.form.notes = [state.form.notes, `Kaina (iÅ¡ QR): ${foundAmount} â‚¬`].filter(Boolean).join('\n');
  }
  if(!foundDate && !foundAmount){
    state.form.docNumber = text.slice(0,100);
    toast('QR nuskaitytas, bet datos neatpaÅ¾inau â€“ patikrinkite duomenis rankiniu bÅ«du');
  } else {
    toast('QR duomenys Ä¯kelti âœ“');
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
// not just the reported MIME type â€” many browsers report HEIC files with
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
  if(!isPdf&&!isImg){state.docError='LeidÅ¾iami formatai: JPG, PNG, WebP, HEIC, PDF';render();return;}
  if(isPdf&&file.size>MAX_PDF){state.docError=`PDF per didelis (max 5MB, jÅ«sÅ³: ${fmtSize(file.size)})`;render();return;}
  // NOTE: for images we deliberately do NOT reject based on the original
  // file size here. Modern phone cameras routinely produce 10-20MB photos
  // (especially HEIC/4K), but compressImage() below brings any of them
  // down to ~150-400KB before we ever touch Storage or the AI call. The
  // previous version rejected large originals BEFORE compression, which
  // meant many real phone photos were silently refused even though the
  // compressed result would have been tiny â€” this was one root cause of
  // "photos won't upload" reports. We still cap originals at a generous
  // 20MB just to avoid the browser choking on something absurd, but the
  // real, user-facing limit is enforced post-compression instead.
  const MAX_ORIGINAL_IMG = 20*1024*1024;
  if(isImg&&file.size>MAX_ORIGINAL_IMG){state.docError=`Failas per didelis (max 20MB, jÅ«sÅ³: ${fmtSize(file.size)})`;render();return;}
  state.docError='';

  (async()=>{
    if(isImg && await looksLikeHeic(file)){
      // Most browsers (everything except Safari 17+) cannot decode HEIC
      // through the canvas pipeline we use for compression â€” this is a
      // hard browser limitation, not a bug we can silently work around.
      // Tell the user exactly what's happening and how to fix it, rather
      // than a generic "failed to process" message.
      state.docError='HEIC formato nuotraukos Å¡ioje narÅ¡yklÄ—je nepalaikomos. Telefono Nustatymuose â†’ Kamera â†’ Formatai pasirinkite "Suderinamas" (JPEG), arba naudokite Safari narÅ¡yklÄ™ (jei iPhone su naujausia iOS).';
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
        // sized â€” if compression somehow failed to shrink a huge image,
        // surface that clearly instead of silently uploading something
        // oversized.
        const compressedBytes = Math.ceil(compB64.length * 0.75);
        if(compressedBytes > MAX_IMG){
          state.docError=`Nuotrauka per didelÄ— net po suspaudimo (${fmtSize(compressedBytes)}). Pabandykite kitÄ… nuotraukÄ….`;
          render();
          return;
        }
        state.form.docData=compressed; state.form.docMime='image/jpeg'; state.form.docFileName=file.name.replace(/\.[^.]+$/,'.jpg');
        if(state.addMode==='photo'){state.analyzing=true;startAnalyzeWatchdog();render();await analyzeDoc(compB64,'image/jpeg');clearAnalyzeWatchdog();state.analyzing=false;}
        render();
      }catch(err){
        console.warn('Image processing failed:', err);
        state.docError='Nepavyko apdoroti nuotraukos â€” pabandykite dar kartÄ… arba kitÄ… failÄ… (jei tai HEIC formatas, pakeiskite kameros nustatymus Ä¯ JPEG)';render();
      }
    }
  };
  reader.onerror=()=>{
    state.docError='Nepavyko nuskaityti failo';render();
  };
  reader.readAsDataURL(file);
}

async function checkPolicy(item){
  // Naudoja tÄ… paÄiÄ… Premium dienos kvotÄ… kaip nuskaitymas
  if(!isPremiumUser()){ toast('Å i funkcija prieinama tik Premium vartotojams'); return; }

  const today = new Date().toISOString().slice(0,10);
  const month = today.slice(0,7);
  const dayKey = state.userDoc?.aiDayKey;
  const dayCount = dayKey===today ? (state.userDoc?.aiDayCount||0) : 0;
  const monthKey = state.userDoc?.aiMonthKey;
  const monthCount = monthKey===month ? (state.userDoc?.aiMonthCount||0) : 0;
  if(dayCount >= PREMIUM_DAILY_LIMIT){
    toast(`Pasiektas dienos limitas (${PREMIUM_DAILY_LIMIT} AI analiziÅ³). Pabandykite rytoj.`);
    return;
  }
  if(monthCount >= PREMIUM_MONTHLY_LIMIT){
    toast(`Pasiektas mÄ—nesio limitas (${PREMIUM_MONTHLY_LIMIT} AI analiziÅ³).`);
    return;
  }

  state.policyChecking = true; state.policyResult=null; render();
  try{
    const idToken = await state.user.getIdToken();

    // Atnaujinti dienos/mÄ—nesio skaitiklius Firestore'e (tas pats mechanizmas kaip analyzeDoc)
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
          `Kiek laiko gamintojas paprastai suteikia garantijÄ… Å¡iam produktui: "${item.name}"${item.shop?` (pirkta iÅ¡ ${item.shop})`:''}? `+
          `Atsakyk lietuviÅ¡kai, TRUMPAI (2-3 sakiniai). Nurodyk tipinÄ¯ terminÄ… ir paminÄ—k kad reikia patikrinti gamintojo svetainÄ—je.`
        }]}]
      })
    });
    if(!res.ok) throw new Error('request failed');
    const data = await res.json();
    const text = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join(' ').trim()
      .replace(/\*\*/g,'').replace(/\*/g,'');
    state.policyResult = text || 'Nepavyko gauti atsakymo. Patikrinkite gamintojo svetainÄ™.';
    state.policyResultFor = item.id;
  }catch(e){
    toast('Nepavyko patikrinti â€“ bandykite vÄ—liau');
  }
  state.policyChecking = false;
  render();
}

// â”€â”€ Settings actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function toggleNotify(){
  if(!state.user)return;
  const current = state.userDoc?.notifyEnabled !== false;
  try{
    await updateDoc(doc(db,'users',state.user.uid), { notifyEnabled: !current });
  }catch(e){
    toast('Nepavyko iÅ¡saugoti nustatymo');
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
    ? `Perkelti Ä¯raÅ¡us Ä¯ paskyros saugyklÄ…?\n\nJie bus susieti su jÅ«sÅ³ paskyra ir pasiekiami iÅ¡ bet kurio Ä¯renginio.`
    : `Perjungti Ä¯ Ä¯renginio saugyklÄ…?\n\nJÅ«sÅ³ ${state.items.length} Ä¯raÅ¡ai bus perkelti Ä¯ Å¡Ä¯ telefonÄ… ir paÅ¡alinti iÅ¡ paskyros. Kituose Ä¯renginiuose jÅ³ nebebus â€” ir jei telefonas bus prarastas ar sugadintas, duomenys dingsta kartu su juo.`;
  if(!confirm(confirmMsg)) return;

  // Antras patvirtinimas local atveju
  if(!wantsCloud){
    if(!confirm('Patvirtinkite: paÅ¡alinti iÅ¡ paskyros ir saugoti tik Å¡iame telefone.')) return;
  }

  const itemsToMigrate = state.items.slice();
  toast('Perkeliama...');
  state.migratingStorage = true;

  try{
    if(wantsCloud){
      // IMPORTANT ORDERING: Firestore security rules only allow creating
      // warranty documents when the user's profile already has
      // storageMode == 'cloud' (requiresCloudPlan() check) â€” this stops a
      // Free/local account from writing to the cloud subcollection by
      // mistake or tampering. That means we must flip storageMode (and set
      // the FINAL itemCount we expect to end up with) on the profile FIRST,
      // in one atomic update matching rule variant D, before creating any
      // warranty docs â€” otherwise every create in the loop below would be
      // rejected by requiresCloudPlan().
      await updateDoc(doc(db,'users',state.user.uid), {
        itemCount: itemsToMigrate.length,
        storageMode: 'cloud',
      });

      // Stop the items listener during migration so the live onSnapshot
      // triggered by the storageMode flip above doesn't race with us
      // rewriting state.items mid-loop â€” we'll re-attach it once done.
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
      // Stop the live Firestore listener first â€” otherwise each deleteDoc
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
    toast('Perkelta âœ“');
  }catch(e){
    console.warn('Storage mode migration error:', e);
    toast('Klaida perkeliant duomenis â€“ patikrinkite sÄ…raÅ¡Ä…, kai kurie Ä¯raÅ¡ai gali bÅ«ti nepilnai perkelti');
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
    state.storageError = 'Cloud sinchronizacija prieinama tik Premium, Tester arba Draugas paskyroms. Dabar Å¡i paskyra neturi cloud teisiÅ³.';
    toast(state.storageError, 8000);
    render();
    return;
  }

  const confirmMsg = wantsCloud
    ? `Perkelti Ä¯raÅ¡us Ä¯ paskyrÄ… (cloud)?\n\nJie bus susieti su Å¡ia paskyra ir pasiekiami iÅ¡ kitÅ³ Ä¯renginiÅ³ prisijungus tuo paÄiu el. paÅ¡tu.`
    : `Perkelti Ä¯raÅ¡us tik Ä¯ Å¡Ä¯ telefonÄ…?\n\nJÅ«sÅ³ ${state.items.length} Ä¯raÅ¡ai bus paÅ¡alinti iÅ¡ paskyros saugyklos. Kituose Ä¯renginiuose jÅ³ nebematysite, o praradus telefonÄ… galima prarasti ir duomenis.`;
  if(!confirm(confirmMsg)) return;

  if(!wantsCloud && !confirm('Patvirtinkite: paÅ¡alinti iÅ¡ paskyros saugyklos ir saugoti tik Å¡iame telefone.')) return;

  const itemsToMigrate = state.items.slice();
  toast(wantsCloud ? 'Perkeliama Ä¯ paskyrÄ…...' : 'Perkeliama Ä¯ telefonÄ…...', 8000);
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
    toast('Saugyklos reÅ¾imas pakeistas âœ“', 6000);
  }catch(e){
    console.warn('Storage mode migration error:', e);
    const code = e?.code ? ` (${e.code})` : '';
    state.storageError = `Nepavyko pakeisti saugyklos reÅ¾imo${code}. DaÅ¾niausiai taip nutinka dÄ—l paskyros teisiÅ³ arba Firestore taisykliÅ³. DuomenÅ³ sÄ…raÅ¡Ä… patikrinkite prieÅ¡ bandydami dar kartÄ….`;
    toast(state.storageError, 10000);
    render();
  }finally{
    state.migratingStorage = false;
  }
}

async function confirmDeleteAccount(){
  if(!confirm('Ar tikrai norite iÅ¡trinti paskyrÄ…? Visi jÅ«sÅ³ duomenys (garantijos, nuotraukos) bus negrÄ¯Å¾tamai iÅ¡trinti.'))return;
  if(!confirm('Å is veiksmas negrÄ¯Å¾tamas. Tikrai tÄ™sti?'))return;

  const uid = state.user.uid;
  const items = state.items.slice();
  const wasCloud = state.storageMode === 'cloud';

  // Firestore/Storage security rules require request.auth.uid to match â€”
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
    toast('Nepavyko pilnai iÅ¡trinti duomenÅ³ â€“ bandykite vÄ—liau dar kartÄ…');
    return; // don't delete the Auth account if cleanup was incomplete,
            // otherwise any leftover docs become permanently unreachable
  }

  // Local-mode (or already-migrated) IndexedDB data belongs to this device,
  // not Firestore â€” clean it up regardless of which mode was active, since
  // a user might have switched modes earlier and left orphaned local data.
  try{ await localDeleteDatabase(uid); }catch(e){ /* best-effort */ }

  try{
    await state.user.delete();
    toast('Paskyra iÅ¡trinta');
  }catch(e){
    if(e.code==='auth/requires-recent-login'){
      toast('Duomenys iÅ¡trinti. DÄ—l saugumo prisijunkite iÅ¡ naujo, kad pabaigtumÄ—te paskyros trynimÄ….');
      await doLogout();
    }else{
      toast('Duomenys iÅ¡trinti, bet paskyros paÅ¡alinti nepavyko â€“ susisiekite su mumis');
    }
  }
}

// Premium isn't truly "unlimited" â€” that would mean unbounded exposure on
// our own Anthropic billing if a Premium account is compromised, scripted,
// or simply misused. Premium gets a generous but hard cap instead.
async function analyzeDoc(b64,mime){
  const isPremium = isPremiumUser();
  const usesLeft = state.userDoc?.aiUsesRemaining ?? AI_FREE_USES;

  const MAX_RETRIES_PER_ITEM = 2;
  if(state.aiRetriesUsedThisItem >= MAX_RETRIES_PER_ITEM){
    toast(`Pasiektas bandymÅ³ limitas (${MAX_RETRIES_PER_ITEM}) Å¡iam Ä¯raÅ¡ui. Ä®veskite duomenis rankiniu bÅ«du arba pradÄ—kite naujÄ… Ä¯raÅ¡Ä….`);
    return;
  }
  if(!isPremium && usesLeft<=0){
    toast(`IÅ¡naudojote ${AI_FREE_USES} nemokamas AI analizes. Atsinaujinkite Ä¯ Premium.`);
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
      toast(`Pasiektas dienos limitas (${PREMIUM_DAILY_LIMIT} analiziÅ³). Pabandykite rytoj.`);
      return;
    }
    if(monthCount >= PREMIUM_MONTHLY_LIMIT){
      toast(`Pasiektas mÄ—nesio limitas (${PREMIUM_MONTHLY_LIMIT}/mÄ—n.).`);
      return;
    }
  }

  state.aiRetriesUsedThisItem++;

  try{
    const idToken = await state.user.getIdToken();
    const res=await fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,messages:[{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:mime,data:b64}},
        {type:'text',text:`Tai pirkimo dokumentas (Äekis, sÄ…skaita-faktÅ«ra ar banko iÅ¡raÅ¡as). AtidÅ¾iai iÅ¡analizuok TIK tai, kas faktiÅ¡kai matoma dokumente.

GRIEÅ½TOS TAISYKLï¿½Ä–S (svarbiausia):
1. NIEKADA negalvok/nespÄ—liok informacijos, kurios nematai dokumente. Jei laukas neaiÅ¡kus ar nematomas â€“ grÄ…Å¾ink null, NE spÄ—jimÄ….
2. PavadinimÄ… imk TIK iÅ¡ dokumento teksto (prekÄ—s eilutÄ—s), niekada negalvok pavadinimo iÅ¡ konteksto ar nuojautos.
3. Jei dokumente NÄ–RA pardavÄ—jo pavadinimo/rekvizitÅ³ (pvz. nufotografuota tik dalis Äekio) â€“ shop lauke grÄ…Å¾ink null, neiÅ¡galvok parduotuvÄ—s pavadinimo.
4. Jei dokumentas neryÅ¡kus, apkarpytas, ar dalis teksto neÄ¯skaitoma â€“ privalai tai nurodyti quality lauke, nepaisant to stenkis iÅ¡traukti kÄ… gali.
5. Jei Äekyje/sÄ…skaitoje YRA KELIOS atskiros prekÄ—s (ne paslaugos) â€“ grÄ…Å¾ink KIEKVIENÄ„ atskirai items masyve. Paslaugos (pristatymas, montavimas, garantijos pratÄ™simas ir pan.) NÄ–RA prekÄ—s â€“ jÅ³ neÄ¯trauk Ä¯ items, bet gali paminÄ—ti notes lauke.
6. Kiekvienai prekei nurodyk, ar jai paprastai taikoma vartotojo garantija pagal ES/LT teisÄ™ (warrantyApplies). DrabuÅ¾iai, avalynÄ—, baldai, elektronika, technika â€“ paprastai TAIP. Greitai gendantys maisto produktai, vienkartinio naudojimo higienos priemonÄ—s, paslaugos â€“ paprastai NE.

GrÄ…Å¾ink TIK JSON be markdown, Å¡ios struktÅ«ros:
{
  "shop": "parduotuvÄ—s/pardavÄ—jo pavadinimas arba null jei nematomas dokumente",
  "purchaseDate": "YYYY-MM-DD arba null",
  "docNumber": "dokumento/kvito numeris arba null",
  "docType": "Kvitas / Äekis|SÄ…skaita-faktÅ«ra (SF)|Banko iÅ¡raÅ¡as|Kita",
  "quality": "good|blurry|partial|unclear",
  "qualityNote": "trumpas paaiÅ¡kinimas jei quality nÄ—ra 'good', pvz. 'TrÅ«ksta apatinÄ—s Äekio dalies' arba null",
  "items": [
    {"name":"tikslus prekÄ—s pavadinimas iÅ¡ dokumento","price":"kaina arba null","warrantyMonths":24,"warrantyApplies":true,"category":"Elektronika|BuitinÄ— technika|AvalynÄ— / drabuÅ¾iai|Baldai|Automobiliai|Kita"}
  ]
}
warrantyMonths kiekvienai prekei: 6/12/24/36/60 mÄ—n. pagal produkto tipÄ…, jei warrantyApplies=true. Jei warrantyApplies=false, warrantyMonths=null.
category kiekvienai prekei: viena iÅ¡: Elektronika, BuitinÄ— technika, AvalynÄ— / drabuÅ¾iai, Baldai, Automobiliai, Kita.
Jei items sÄ…raÅ¡e nieko neradai (pvz. visiÅ¡kai neÄ¯skaitoma), grÄ…Å¾ink tuÅ¡ÄiÄ… masyvÄ… [].`}
      ]}]})
    });
    if(res.status===401){toast('Sesija pasibaigÄ—, prisijunkite iÅ¡ naujo');return;}
    if(res.status===403){toast('Patvirtinkite el. paÅ¡tÄ…, kad naudotumÄ—te AI analizÄ™');return;}
    if(res.status===429){toast('Pasiektas AI analiziÅ³ limitas');return;}
    if(!res.ok)return;

    state.pendingAiCharge = true;

    const data=await res.json();
    const p=JSON.parse((data.content||[]).map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());

    // Quality warning â€” surfaced to the user, not silently swallowed.
    if(p.quality && p.quality!=='good'){
      const qualityLabels = {blurry:'Nuotrauka neryÅ¡ki',partial:'Matomas ne visas dokumentas',unclear:'Tekstas sunkiai Ä¯skaitomas'};
      state.form.qualityWarning = `${qualityLabels[p.quality]||'Dokumento kokybÄ— nepakankama'}${p.qualityNote?': '+p.qualityNote:''}`;
    }

    const items = Array.isArray(p.items) ? p.items.filter(it=>it && typeof it.name==='string' && it.name.trim()) : [];

    if(items.length===0){
      // Nothing usable was recognized â€” don't silently fabricate a name.
      toast('AI nerado atpaÅ¾Ä¯stamos prekÄ—s Å¡iame dokumente. Ä®veskite duomenis rankiniu bÅ«du.');
      if(typeof p.shop==='string')state.form.shop=p.shop.slice(0,100);
      if(typeof p.purchaseDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.purchaseDate))state.form.purchaseDate=p.purchaseDate;
      if(DOC_TYPES.includes(p.docType))state.form.docType=p.docType;
      return;
    }

    if(items.length===1){
      applyAiItemToForm(items[0], p);
      // Dublikato patikrinimas: dok. numeris (patikimiausia) arba pavadinimas + data
      const dup = state.items.find(i=>
        (p.docNumber && i.docNumber && i.docNumber===p.docNumber && i.name?.toLowerCase()===items[0].name?.toLowerCase()) ||
        (i.name?.toLowerCase()===items[0].name?.toLowerCase() && i.purchaseDate && i.purchaseDate===p.purchaseDate));
      if(dup) toast('PanaÅ¡us Ä¯raÅ¡as jau yra â€” patikrinkite ar ne dublikatas');
    }else{
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

  // Kategorija iÅ¡ AI
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

  // Kaina Ä¯ notes (tik jei yra)
  if(item.price) state.form.notes=[state.form.notes,`Kaina: ${String(item.price).slice(0,50)}`].filter(Boolean).join('\n');
}

render();
