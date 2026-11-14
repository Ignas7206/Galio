'use strict';
import { auth, db, storage } from './firebase-config.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, sendPasswordResetEmail, sendEmailVerification,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  setDoc, getDoc, getDocFromCache, getDocs, getDocsFromServer, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
  localGetAll, localPut, localDelete, localClear, localDeleteDatabase, genLocalId
} from './local-db.js';

const WORKER_URL    = 'https://long-moon-d252.ltdigitaltools.workers.dev';
const CATEGORIES    = ['Elektronika','Buitinė technika','Įrankiai ir sodas','Avalynė / drabužiai','Baldai','Sportas ir laisvalaikis','Auto prekės','Kita'];
// Older records used "Automobiliai"; show them under the new name.
const LEGACY_CATEGORY = { 'Automobiliai': 'Auto prekės' };
const withCurrentCategory = it => (it && LEGACY_CATEGORY[it.category]) ? { ...it, category: LEGACY_CATEGORY[it.category] } : it;
const DOC_TYPES     = ['Kvitas / čekis','Sąskaita-faktūra (SF)','Banko išrašas','Kita'];
const WARRANTY_OPTS = [{l:'6 mėnesiai',m:6},{l:'1 metai',m:12},{l:'2 metai',m:24},{l:'3 metai',m:36},{l:'5 metai',m:60},{l:'Kita data',m:null}];
const RETURN_DAY_OPTS = [7,14,30,45,60,90];
const ALLOWED_IMG   = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
const MAX_IMG       = 10*1024*1024; // phone cameras often produce 6-12MB photos; compression brings this down before upload
const MAX_PDF       = 5*1024*1024;
const MAX_PDF_AI_B64 = 4_700_000; // AI server body limit is 5 MB
// Must equal the value Firestore rules require on user creation (users/{id} create: aiUsesRemaining == 5),
// otherwise sign-up is rejected with "Missing or insufficient permissions".
const AI_FREE_USES  = 5; // lifetime AI document-analysis uses before Premium is required
const FREE_DOC_LIMIT = 3; // non-Premium users can view/attach up to 3 document photos/files
// Premium is capped, not unlimited. Sized so a user at the cap still costs less than the
// ~€1.40/month we keep from €1.99 (after VAT and Google's 15%). The worker enforces the same caps.
const PREMIUM_DAILY_LIMIT   = 20;
const PREMIUM_MONTHLY_LIMIT = 60;
const PREMIUM_SEARCH_MONTHLY_LIMIT = 5;  // web warranty checks cost ~5x a scan

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
  docError:'', showWarranty:false, showReturnDays:false,
  online: navigator.onLine,
  onboardSlide: 0,
  showOnboarding: !localStorage.getItem('galio_onboarded') && !localStorage.getItem('garantijos_onboarded'),
  swipe: { id:null, startX:0, currentX:0, dragging:false },
  addPulse: false,
  qrScanning: false, qrStream: null,
  analysisRunId: 0,
  pendingAnalysisExit: null,
  pendingUnsavedExit: null,
  aiRetriesUsedThisItem: 0, // resets each time the add-form is freshly opened; max 2 scan attempts before quota is charged on save
  pendingAiCharge: false, // true once a scan succeeds — saveItem() consumes one quota unit if this is set
  aiMultiItems: [],
  multiItemReceipt: null,
  multiEditIdx: null,
  multiSaving: false,
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
  adminSearch: '',
  adminPlanFilter: 'all',
  adminSort: 'active',
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

function emptyForm(){return{name:'',category:'',shop:'',purchaseDate:'',warrantyEnd:'',warrantyMonths:24,returnDays:14,returnDeadline:'',docType:'Kvitas / čekis',docNumber:'',notes:'',docData:null,docMime:null,docFileName:null,docStoragePath:null,docThumb:null,itemPhotoData:null,itemPhotoMime:null,itemPhotoFileName:null,itemPhotoStoragePath:null,notifyEnabled:true,warrantyAppliesWarning:false,qualityWarning:null};}

// Admin and active Premium users get Premium rights.
function isPremiumUser(){ return state.userDoc?.plan==='premium' || state.userDoc?.role==='admin'; }
function premiumKind(user){
  if(user?.role==='admin') return 'admin';
  if(user?.plan!=='premium') return 'free';
  if(user?.planSource==='purchase' || user?.subscriptionStatus==='active') return 'purchased';
  if(user?.planSource==='promo') return 'promo';
  return 'manual';
}
function needsCloudDowngrade(){
  return !!state.user && !isPremiumUser() && state.storageMode==='cloud';
}

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
  state.multiItemReceipt=null;
  state.multiEditIdx=null;
  state.multiSaving=false;
  state.aiNameReview=false;
  state.editItemId=null;
}
function discardPendingAdd(){
  state.form=emptyForm();
  state.docError='';
  state.addMode=null;
  state.aiRetriesUsedThisItem=0;
  state.pendingAiCharge=false;
  state.aiMultiItems=[];
  state.multiItemReceipt=null;
  state.multiEditIdx=null;
  state.aiNameReview=false;
  state.editItemId=null;
}
function hasUnsavedAddWork(){
  if(state.view!=='add' || !state.addMode || state.editItemId || state.multiEditIdx!=null) return false;
  const f = state.form || {};
  const empty = emptyForm();
  const fields = ['name','category','shop','purchaseDate','warrantyEnd','returnDeadline','docType','docNumber','notes','docData','itemPhotoData'];
  return fields.some(k => (f[k] || '') !== (empty[k] || ''))
    || f.warrantyMonths !== empty.warrantyMonths
    || f.returnDays !== empty.returnDays
    || !!state.aiMultiItems?.length
    || !!state.multiItemReceipt;
}
function requestUnsavedAddExit(targetView='list'){
  if(state.analyzing) return requestAnalysisExit(targetView);
  if(!hasUnsavedAddWork()) return false;
  state.pendingUnsavedExit = { targetView };
  showAppDialog(
    'Išeiti neišsaugojus?',
    'Šis įrašas dar neišsaugotas. Išeinant įvesti duomenys ir dokumentas bus prarasti.',
    '',
    {hideSupport:false, supportText:'Išeiti neišsaugojus', okText:'Likti', supportAction:'discardAdd', align:'center'}
  );
  return true;
}
function discardAddAndLeave(){
  const target = state.pendingUnsavedExit?.targetView || 'list';
  state.pendingUnsavedExit=null;
  state.appDialog=null;
  discardPendingAdd();
  state.view=target;
  render();
}
function requestAnalysisExit(targetView='list'){
  if(!state.analyzing) return false;
  state.pendingAnalysisExit = { targetView };
  showAppDialog(
    'Dokumentas skaitomas',
    'Galio dar skaito dokumentą ir pildo informaciją. Palaukite kelias sekundes arba nutraukite skaitymą ir išeikite.',
    '',
    {hideSupport:false, supportText:'Nutraukti', okText:'Palaukti', supportAction:'cancelAnalysis', align:'center'}
  );
  return true;
}
function cancelAnalysisAndLeave(){
  const target = state.pendingAnalysisExit?.targetView || 'list';
  state.analysisRunId++;
  clearAnalyzeWatchdog();
  state.analyzing=false;
  state.uploadPct=null;
  state.pendingAnalysisExit=null;
  state.appDialog=null;
  discardPendingAdd();
  state.view=target;
  render();
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
function offlineDialog(title, message){
  showAppDialog(
    title || 'Nėra interneto ryšio',
    message || 'Galite peržiūrėti šiame įrenginyje esančius įrašus. AI nuskaitymui, Galio saugyklai ir priminimų nustatymams reikės interneto.',
    '',
    {hideSupport:true, align:'center'}
  );
}
function requireOnline(title, message){
  if(state.online) return true;
  offlineDialog(title, message);
  return false;
}
function normalizeSearchText(value){
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/ą/g,'a').replace(/č/g,'c').replace(/ę/g,'e').replace(/ė/g,'e')
    .replace(/į/g,'i').replace(/š/g,'s').replace(/ų/g,'u').replace(/ū/g,'u').replace(/ž/g,'z')
    .trim();
}
function normalizeKey(value){
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g,' ').trim();
}
function sameLoose(a,b){
  const x = normalizeKey(a);
  const y = normalizeKey(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
function findDuplicateItem(candidate, ignoreId=null){
  const docNo = normalizeKey(candidate.docNumber);
  const shop = normalizeKey(candidate.shop);
  const name = normalizeKey(candidate.name);
  const purchaseDate = candidate.purchaseDate || '';
  return state.items.find(existing=>{
    if(ignoreId && existing.id===ignoreId) return false;
    const sameReceipt =
      (docNo && normalizeKey(existing.docNumber)===docNo) ||
      (purchaseDate && existing.purchaseDate===purchaseDate && (!shop || !existing.shop || normalizeKey(existing.shop)===shop));
    if(!sameReceipt) return false;
    return sameLoose(existing.name, name);
  }) || null;
}
function inferReturnDays(shop=''){
  const s = normalizeSearchText(shop);
  if(s.includes('regatta')) return 30;
  return 14;
}
function normalizeReturnDays(value, shop=''){
  const n = Number.parseInt(value,10);
  if(Number.isFinite(n) && n > 0 && n <= 365) return n;
  return inferReturnDays(shop);
}
function calcReturnDeadline(purchaseDate, returnDays, shop=''){
  if(!purchaseDate) return null;
  return addDays(purchaseDate, normalizeReturnDays(returnDays, shop));
}
function formReturnDaysForSave(form){
  return form.returnDays === null ? null : normalizeReturnDays(form.returnDays, form.shop);
}
function formReturnDeadline(form){
  if(form.returnDays === null) return form.returnDeadline || null;
  return calcReturnDeadline(form.purchaseDate, form.returnDays, form.shop);
}
function receiptReturnDeadline(receipt){
  if(!receipt) return null;
  if(receipt.returnDays === null) return receipt.returnDeadline || null;
  return calcReturnDeadline(receipt.purchaseDate, receipt.returnDays, receipt.shop);
}
function effectiveReturnDays(item){
  if(!item) return 14;
  const explicit = Number.parseInt(item.returnDays,10);
  if(Number.isFinite(explicit) && explicit > 0 && explicit <= 365) return explicit;
  if(item.purchaseDate && item.returnDeadline){
    const diff = Math.round((new Date(item.returnDeadline) - new Date(item.purchaseDate)) / 86400000);
    if(Number.isFinite(diff) && diff > 0 && diff <= 365) return diff;
  }
  const inferred = inferReturnDays(item.shop);
  if(inferred !== 14) return inferred;
  return 14;
}
function effectiveReturnDeadline(item){
  if(!item) return null;
  if((item.returnDays === null || item.returnDays === 'custom') && item.returnDeadline) return item.returnDeadline;
  if(item.purchaseDate) return calcReturnDeadline(item.purchaseDate, effectiveReturnDays(item), item.shop);
  return item.returnDeadline || null;
}
function fmtSize(b){return b<1024*1024?(b/1024).toFixed(0)+'KB':(b/1024/1024).toFixed(1)+'MB';}
function ltCount(n, one, few, many){
  const abs = Math.abs(Number(n) || 0);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if(mod10 === 1 && mod100 !== 11) return one;
  if(mod10 >= 2 && mod10 <= 9 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
function ltProductNominative(n){
  return ltCount(n, 'prekė', 'prekės', 'prekių');
}
function ltSavingProducts(n){
  return Number(n) === 1 ? 'Saugoma 1 prekė...' : `Saugomos ${n} ${ltProductNominative(n)}...`;
}
function ltSavedProducts(n){
  return Number(n) === 1 ? 'Išsaugota 1 prekė ✓' : `Išsaugotos ${n} ${ltProductNominative(n)} ✓`;
}
function extractPriceFromNotes(notes=''){
  const m = String(notes || '').match(/(?:^|\n)Kaina:\s*([^\n]+)/i);
  return m ? m[1].trim() : '';
}
function notesWithoutPrice(notes=''){
  return String(notes || '').replace(/(?:^|\n)Kaina:\s*[^\n]+/i,'').trim();
}
function warrantyTimeLeftText(days){
  if(days===null) return '';
  if(days<0) return 'Baigėsi';
  if(days===0) return 'Šiandien';
  if(days<60) return `${days}d.`;
  const months = Math.max(1, Math.round(days / 30.4375));
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if(years <= 0) return `${months} mėn.`;
  if(remMonths === 0) return `${years} m.`;
  return `${years} m. ${remMonths} mėn.`;
}
function badgeHtml(days){
  if(days===null)return '';
  if(days<0)return`<span class="badge badge-exp">Baigėsi</span>`;
  if(days<=30)return`<span class="badge badge-warn">${days}d.</span>`;
  return`<span class="badge badge-ok">${warrantyTimeLeftText(days)}</span>`;
}
function returnBadgeHtml(deadline){
  const d = daysLeft(deadline);
  if(d===null)return '';
  if(d<0)return '';
  const label = d===0 ? 'Grąžinti šiandien' : d<=3 ? `Grąžinti liko ${d}d.` : `Grąžinti ${d}d.`;
  return `<span class="badge" style="background:rgba(59,130,246,.16);color:#60a5fa">${label}</span>`;
}
function returnLineHtml(deadline){
  const d = daysLeft(deadline);
  if(d===null || d<0) return '';
  const left = d===0 ? 'šiandien' : `liko ${d} d.`;
  return `<div class="card-date" style="color:#60a5fa;font-weight:600"><i class="ti ti-rotate-2" style="font-size:14px"></i>Grąžinti iki ${fmtDate(deadline)} (${left})</div>`;
}
function isExpiredDate(dateStr){
  if(!dateStr)return false;
  const d = new Date(dateStr + 'T23:59:59');
  return Number.isFinite(d.getTime()) && d < new Date();
}
// Runs onProceed immediately unless the warranty is expired, in which case
// it asks for confirmation via the app's own dialog first (never the
// browser's native confirm()). An expired return deadline alone is just
// informational — it never blocks proceeding.
function confirmExpiredTerms({warrantyEnd, returnDeadline, label='Šios prekės'}, onProceed){
  if(isExpiredDate(warrantyEnd)){
    const returnInfo = isExpiredDate(returnDeadline)
      ? `\n\nNemokamo grąžinimo laikas taip pat pasibaigęs (${fmtDate(returnDeadline)}).`
      : '';
    showConfirmDialog(
      'Garantija jau pasibaigusi',
      `${label} garantija jau pasibaigusi (${fmtDate(warrantyEnd)}).${returnInfo}\n\nAr tikrai norite išsaugoti šį įrašą?`,
      onProceed,
      {okText:'Išsaugoti', align:'center'}
    );
    return;
  }
  if(isExpiredDate(returnDeadline)){
    showAppDialog(
      'Garantija dar galioja ✓',
      `Grąžinti prekės nebegalima (terminas baigėsi ${fmtDate(returnDeadline)}), bet garantija dar galioja. Įrašą išsaugosime ir priminsime, kol ji nesibaigė.`,
      '',
      {hideSupport:true, align:'center', onOk:onProceed}
    );
    return;
  }
  onProceed();
}
function multiWarrantyEnd(item, receipt){
  if(item?.warrantyEnd) return item.warrantyEnd;
  if(receipt?.purchaseDate && item?.warrantyMonths) return addMonths(receipt.purchaseDate, item.warrantyMonths);
  return '';
}
function findSharedDocument(item){
  if(!item) return null;
  if(item.docUrl) return item;
  const keyNumber = item.docNumber || '';
  const keyShop = item.shop || '';
  const keyDate = item.purchaseDate || '';
  return state.items.find(other=>
    other.id!==item.id &&
    other.docUrl &&
    (keyNumber ? other.docNumber===keyNumber : true) &&
    (keyShop ? other.shop===keyShop : true) &&
    (keyDate ? other.purchaseDate===keyDate : true)
  ) || null;
}
function effectiveDoc(item){
  const docItem = findSharedDocument(item);
  return docItem ? {
    docUrl: docItem.docUrl,
    docMime: docItem.docMime,
    docFileName: docItem.docFileName,
    docStoragePath: docItem.docStoragePath,
  } : { docUrl:null, docMime:null, docFileName:null, docStoragePath:null };
}
function effectiveItemPhoto(item){
  return item?.itemPhotoUrl ? {
    itemPhotoUrl: item.itemPhotoUrl,
    itemPhotoMime: item.itemPhotoMime || 'image/jpeg',
    itemPhotoFileName: item.itemPhotoFileName || null,
    itemPhotoStoragePath: item.itemPhotoStoragePath || null,
  } : { itemPhotoUrl:null, itemPhotoMime:null, itemPhotoFileName:null, itemPhotoStoragePath:null };
}
function cardThumbHtml(item){
  const photo = effectiveItemPhoto(item);
  if(photo.itemPhotoUrl) return `<img class="card-thumb" src="${esc(photo.itemPhotoUrl)}" alt="" loading="lazy" />`;
  const doc = effectiveDoc(item);
  if(doc.docUrl && !canViewDoc(item)) return lockedDocHtml(true);
  const pdfThumb = item?.docThumb || findSharedDocument(item)?.docThumb;
  if(doc.docMime==='application/pdf' && pdfThumb && /^data:image\/jpeg;base64,/.test(pdfThumb)) return `<img class="card-thumb" src="${pdfThumb}" alt="" loading="lazy" />`;
  if(doc.docMime==='application/pdf') return `<div class="card-icon" style="background:var(--red-bg)"><i class="ti ti-file-type-pdf" style="color:var(--red)"></i></div>`;
  if(doc.docUrl && canViewDoc(item)) return `<img class="card-thumb" src="${esc(doc.docUrl)}" alt="" loading="lazy" />`;
  return `<div class="card-icon"><i class="ti ti-receipt"></i></div>`;
}
function docIdentity(item){
  const doc = effectiveDoc(item);
  return doc.docStoragePath || doc.docUrl || item?.docFileName || item?.id || '';
}
function freeDocIndex(item){
  const seen = [];
  for(const it of state.items){
    const doc = effectiveDoc(it);
    if(!doc.docUrl) continue;
    const key = docIdentity(it);
    if(key && !seen.includes(key)) seen.push(key);
  }
  const key = docIdentity(item);
  const idx = seen.indexOf(key);
  return idx < 0 ? seen.length : idx;
}
function visibleDocCount(){
  const seen = new Set();
  for(const it of state.items){
    const doc = effectiveDoc(it);
    if(doc.docUrl) seen.add(docIdentity(it));
  }
  return seen.size;
}
function canViewDoc(item){
  if(isPremiumUser()) return true;
  return freeDocIndex(item) < FREE_DOC_LIMIT;
}
function canAttachNewDoc(){
  return isPremiumUser() || visibleDocCount() < FREE_DOC_LIMIT;
}
function lockedDocHtml(compact=false){
  return `<div class="${compact?'card-icon':'detail-section'}" style="${compact?'':'padding:16px;text-align:center'};background:var(--bg2)">
    <i class="ti ti-lock" style="font-size:${compact?'24px':'34px'};color:var(--text3)"></i>
    ${compact?'':`<div style="font-size:15px;font-weight:700;color:var(--text);margin-top:10px">Dokumentas užrakintas</div>
    <div style="font-size:13px;color:var(--text2);line-height:1.4;margin-top:4px">Nemokamame plane matomi ${FREE_DOC_LIMIT} dokumentai. Su Premium matysite visus čekius ir nuotraukas.</div>
    <button class="save-btn" id="upgradeBtnDoc" style="margin-top:14px">Premium</button>`}
  </div>`;
}
// Errors must not vanish in 5 s: anything that reads like a failure opens a dialog that
// stays until dismissed, and the text is e-mailed to the Galio admin automatically.
const ERROR_TOAST_RE = /^(nepavyko|klaida)|permission|insufficient|unauthorized/i;
const _reportedErrors = new Set();
function sendErrorReport(message, source='app'){
  const key = String(message).slice(0, 200);
  if(_reportedErrors.has(key) || _reportedErrors.size > 10) return; // once per message, max 10 per session
  _reportedErrors.add(key);
  const v = (document.querySelector('script[src*="app.js"]')?.src.split('v=')[1]) || '?';
  const diag = [
    `šaltinis: ${source}`, `versija: ${v}`, `ekranas: ${state.view||'-'}`,
    `vartotojas: ${state.user?.email||'neprisijungęs'} (${state.user?.uid||'-'})`,
    `saugojimas: ${state.storageMode||'-'}`, `planas: ${state.userDoc?.plan||'-'}`,
    `žingsnis: ${window.__galioBootStep||'-'}`, `naršyklė: ${navigator.userAgent}`,
  ].join(' | ');
  fetch(WORKER_URL + '/contact', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      name: 'Galio klaidų pranešimas',
      email: state.user?.email || 'noreply@galio.app',
      message: `Automatinis klaidos pranešimas:

${String(message).slice(0, 1500)}`,
      diag,
    }),
  }).catch(()=>{});
}
function reportProblem(message){
  sendErrorReport(message, 'pranešimas vartotojui');
  showAppDialog('Kažkas nepavyko', `${message}

Apie šią klaidą automatiškai pranešėme Galio komandai.`, '', {hideSupport:true, align:'center'});
}
window.addEventListener('error', e => { if(e?.message) sendErrorReport(`${e.message} @${(e.filename||'').split('/').pop()}:${e.lineno||''}`, 'window.onerror'); });
window.addEventListener('unhandledrejection', e => { const r=e?.reason; sendErrorReport(`promise: ${r?.code||''} ${r?.message||r}`, 'unhandledrejection'); });

function toast(msg, ms=5200){
  if(ERROR_TOAST_RE.test(String(msg))){ reportProblem(String(msg)); return; }
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
function showAppDialog(title, message, supportDraft='', options={}){
  state.appDialog = {
    title,
    message,
    supportDraft,
    hideSupport: !!options.hideSupport,
    variant: options.variant || 'default',
    align: options.align || 'left',
    okText: options.okText || '',
    supportText: options.supportText || '',
    supportAction: options.supportAction || '',
    onOk: options.onOk || null,
    onCancel: options.onCancel || null,
  };
  render();
}
// Replaces the browser's native confirm() with the app's own bottom-sheet
// dialog, so every yes/no prompt in the app looks and behaves the same way.
// onConfirm runs only if the user taps the confirm (okText) button.
function showConfirmDialog(title, message, onConfirm, options={}){
  showAppDialog(title, message, '', {
    hideSupport: false,
    align: options.align || 'left',
    okText: options.okText || 'Taip',
    supportText: options.cancelText || 'Atšaukti',
    supportAction: 'cancel',
    onOk: onConfirm,
    onCancel: options.onCancel || null,
  });
}
// The Play app 1.5+ (build 6) opens Galio with ?app=6 and is in the phone's share menu.
// Tips about sharing are shown only there: a browser tab or an older app cannot receive shares.
(function rememberAppBuild(){
  try{
    const p = new URLSearchParams(location.search);
    const b = parseInt(p.get('app') || '', 10);
    if(b){
      localStorage.setItem('galio_app_build', String(b));
      p.delete('app');
      history.replaceState(history.state, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
    }
  }catch(e){}
})();
function canShareToGalio(){
  try{ return (parseInt(localStorage.getItem('galio_app_build') || '0', 10) || 0) >= 6; }catch(e){ return false; }
}
function shareUsed(){ try{ return localStorage.getItem('galio_share_used') === '1'; }catch(e){ return false; } }
// Shown once after the admin grants Premium (the server stamps premiumGrantedAt).
function maybeShowPremiumWelcome(){
  const d = state.userDoc;
  if(!d || !state.user || d.plan!=='premium' || d.planSource!=='manual' || !d.premiumGrantedAt) return;
  const ms = d.premiumGrantedAt.toMillis ? d.premiumGrantedAt.toMillis() : 0;
  if(!ms || state.appDialog) return;
  const key = 'galio_premium_welcome_' + state.user.uid;
  try{
    if(Number(localStorage.getItem(key) || 0) >= ms) return;
    localStorage.setItem(key, String(ms));
  }catch(e){ return; }
  state.appDialog = {
    title: 'Jums suteiktas Galio Premium',
    message: 'Galio saugykla, automatiniai priminimai ir daugiau AI analizių jau įjungti jūsų paskyroje.',
    supportDraft: '',
    hideSupport: true,
    align: 'center',
  };
}
function maybeShowShareIntro(existingUserDoc=false){
  const seenKey = 'galio_share_intro_v1';
  try{
    if(!existingUserDoc || !canShareToGalio() || state.appDialog || localStorage.getItem(seenKey)==='1') return;
    if(!(localStorage.getItem('galio_onboarded') || localStorage.getItem('garantijos_onboarded'))) return;
    localStorage.setItem(seenKey,'1');
  }catch(e){ return; }
  state.appDialog = {
    title: 'Dokumentų bendrinimas',
    message: 'Sąskaitas iš el. pašto, PDF failus ir nuotraukas galite perduoti į Galio per „Bendrinti“. Įrašas bus užpildytas automatiškai.',
    supportDraft: '',
    hideSupport: true,
    align: 'center',
  };
}
function maybeShareTip(){
  // After a camera scan, now and then remind that a PDF or email receipt can simply be shared.
  try{
    if(!canShareToGalio() || shareUsed()) return;
    const shown = parseInt(localStorage.getItem('galio_share_tips') || '0', 10) || 0;
    const scans = (parseInt(localStorage.getItem('galio_scan_count') || '0', 10) || 0) + 1;
    localStorage.setItem('galio_scan_count', String(scans));
    if(shown >= 3 || scans % 3 !== 1) return;
    localStorage.setItem('galio_share_tips', String(shown + 1));
    setTimeout(()=>toast('Sąskaitas iš el. pašto ir PDF galite perduoti per „Bendrinti“ → Galio', 7000), 1500);
  }catch(e){}
}
function maybeShowReturnFeatureIntro(existingUserDoc=false){
  const seenKey = 'galio_return_deadline_intro_v2';
  const onboarded = localStorage.getItem('galio_onboarded') || localStorage.getItem('garantijos_onboarded');
  if(!existingUserDoc || !onboarded || localStorage.getItem(seenKey)==='1') return;
  localStorage.setItem(seenKey,'1');
  state.appDialog = {
    title: 'Nauja: grąžinimo terminai',
    message: 'Pirk internetu ramiau. Nuskenuok dokumentą, o Galio parodys konkrečią datą iki kada dar gali grąžinti prekę ir leis pasirinkti priminimą prieš terminą.',
    supportDraft: '',
    hideSupport: true,
  };
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
window.__galioAppStarted = true;
document.addEventListener('DOMContentLoaded', ()=>{
  window.__galioBootStep = 'prisijungimo patikra (auth)';
  _bootWatchdog = setTimeout(()=>{
    if(!state.booted || (state.user && !state.userDoc)){
      const scr = document.getElementById('screen');
      if(scr) scr.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;padding:32px;text-align:center">
          <i class="ti ti-wifi-off" style="font-size:48px;color:var(--text3)"></i>
          <p style="font-size:16px;font-weight:600;color:var(--text1)">Nepavyko prisijungti</p>
          <p style="font-size:14px;color:var(--text2)">Patikrinkite interneto ryšį ir bandykite iš naujo</p>
          <button onclick="location.reload()" style="background:var(--accent);color:#fff;border:none;border-radius:12px;padding:12px 28px;font-size:15px;font-weight:600;cursor:pointer">Bandyti iš naujo</button>
          <button onclick="window.__galioResetCache && window.__galioResetCache()" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer">Išvalyti talpyklą ir perkrauti</button>
          <p style="font-size:11px;color:var(--text3);word-break:break-word;max-width:320px">Užstrigo: ${esc(window.__galioBootStep||'?')}${(window.__galioErrors||[]).length ? '<br>'+(window.__galioErrors||[]).slice(-3).map(esc).join('<br>') : ''}</p>
        </div>`;
    }
  }, 20000);
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

// 3. View stuck watchdog — jei per 95s nepavyko įkrauti admin stats, grįžta atgal
let _viewWatchdog = null;
function startViewWatchdog(view){
  clearViewWatchdog();
  _viewWatchdog = setTimeout(()=>{
    if(state.view===view && !state.adminStats && view==='admin-stats'){
      state.view='settings';
      render();
    }
  }, 95000);
}
function clearViewWatchdog(){ if(_viewWatchdog){ clearTimeout(_viewWatchdog); _viewWatchdog=null; } }
onAuthStateChanged(auth, async (user)=>{
  state.booted=true;
  if(!user) clearTimeout(_bootWatchdog); // logged in: keep watching until the user doc loads
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
  if(user){ clearTimeout(_bootWatchdog); window.__galioBootStep = 'paruošta'; }
  render();
  if(user) render();
  if(user) consumeSharedFile();
});

// A photo or PDF shared from another app ("Bendrinti → Galio") is kept by the service
// worker; here it becomes a new entry exactly as if it was picked with "Nuskenuoti".
async function consumeSharedFile(){
  const params = new URLSearchParams(location.search);
  if(!params.has('shared')) return;
  params.delete('shared');
  history.replaceState(history.state, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
  let file = null;
  try{
    const cache = await caches.open('galio-share');
    const res = await cache.match('/Galio/__shared');
    if(res){
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'dokumentas');
      file = new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || '' });
      await cache.delete('/Galio/__shared');
      localStorage.setItem('galio_share_used', '1');
      if(!canShareToGalio()) localStorage.setItem('galio_app_build', '6');
    }
  }catch(e){}
  if(!file){ toast('Galio gali priimti čekio nuotrauką arba PDF', 5000); return; }
  if(state.analyzing){ toast('Palaukite, ankstesnis failas dar apdorojamas'); return; }
  if(!state.online){
    offlineDialog('Nuskaitymui reikia interneto', 'Dokumento nuskaitymas veikia su AI, todėl jam reikia interneto. Pasidalinkite dar kartą, kai būsite prisijungę.');
    return;
  }
  if(!canAttachNewDoc()){
    showAppDialog('Dokumentų limitas pasiektas', `Nemokamame plane galima turėti iki ${FREE_DOC_LIMIT} dokumentų. Su Premium galėsite prisegti ir matyti visus čekius.`, '', {hideSupport:true});
    return;
  }
  startNewItem('photo');
  renderSync();
  state._fromShare = true;
  handleDoc({ target: { files: [file], value: '' } });
}

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

// A slow connection can keep getDoc waiting for a long time. After 5 s use the copy
// saved on this device (the live listener below brings fresh data once online).
// No saved copy (first sign-in on this device) -> keep waiting for the server.
async function getDocFast(ref_){
  const server = getDoc(ref_);
  let t;
  const timer = new Promise(r => { t = setTimeout(() => r('slow'), 5000); });
  const first = await Promise.race([server, timer]).catch(e => e);
  clearTimeout(t);
  if(first !== 'slow' && !(first instanceof Error)) return first;
  window.__galioBootStep = 'paskyros duomenys (lėtas ryšys)';
  try{
    const cached = await getDocFromCache(ref_);
    if(cached.exists()){ server.catch(()=>{}); return cached; }
  }catch(e){}
  return server;
}

async function ensureUserDoc(user){
  state.storageError = '';
  state.appDialog = null;
  const ref_ = doc(db,'users',user.uid);
  window.__galioBootStep = 'paskyros duomenys (getDoc)';
  const snap = await getDocFast(ref_);
  window.__galioBootStep = 'paskyros duomenys gauti';
  const existingUserDoc = snap.exists();
  // Data from the on-device copy may be old: show it, but change nothing until the server answers.
  const stale = !!snap.metadata?.fromCache;
  if(!snap.exists()){
    const initial = {
      email:user.email, plan:'free', itemCount:0, notifyEnabled:true,
      storageMode:'local', aiUsesRemaining: AI_FREE_USES,
      emailVerified: user.emailVerified || false,
      createdAt: serverTimestamp(),
      // Proof of consent: sign-up (checkbox) and Google sign-in both require accepting the Terms.
      termsAcceptedAt: serverTimestamp(), termsVersion: TERMS_VERSION,
    };
    window.__galioBootStep = 'naujos paskyros kūrimas (setDoc)';
    await setDoc(ref_, initial);
    state.userDoc = initial;
  }else{
    state.userDoc = snap.data();
    // Backfill fields for accounts created before this field existed
    if(stale){ /* fresh data comes through onSnapshot below */ }
    else if(state.userDoc.aiUsesRemaining === undefined){
      updateDoc(ref_, { aiUsesRemaining: AI_FREE_USES }).catch(()=>{}); // background: don't block the first screen
      state.userDoc.aiUsesRemaining = AI_FREE_USES;
    }
    if(!stale && state.userDoc.storageMode === undefined){
      updateDoc(ref_, { storageMode: 'local' }).catch(()=>{});
      state.userDoc.storageMode = 'local';
    }
    // Atnaujinti emailVerified jei pasikeitė (pvz. vartotojas patvirtino paštą)
    if(!stale && state.userDoc.emailVerified !== user.emailVerified){
      updateDoc(ref_, { emailVerified: user.emailVerified || false }).catch(()=>{});
      state.userDoc.emailVerified = user.emailVerified || false;
    }
  }
  if(!stale){ maybeShowReturnFeatureIntro(existingUserDoc); maybeShowShareIntro(existingUserDoc); }
  state.storageMode = state.userDoc.storageMode || 'local';
  try{ if(typeof Notification!=='undefined' && Notification.permission==='granted' && (state.userDoc.fcmToken || state.userDoc.fcmTokens?.length)) setupForegroundPush(); }catch(e){}
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
      maybeShowPremiumWelcome();
      render();
      if(!s.metadata.fromCache) autoMoveToCloud();
    }
  });
  restorePlayPurchases();
  if(!stale) setTimeout(autoMoveToCloud, 1500);
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
        .map(d=>withCurrentCategory({id:d.id,...d.data()}))
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
        .map(d=>withCurrentCategory({id:d.id,...d.data()}))
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
      toast('Nepavyko įkelti sąrašo. Patikrinkite interneto ryšį.');
      render();
    });
  }else{
    // Local mode: just load once from IndexedDB. There's no live listener
    // concept needed since we're the only writer (single device).
    localGetAll(uid).then(items=>{
      items.sort((a,b)=>(b.createdAtMs||0)-(a.createdAtMs||0));
      const wasEmpty = state.loadingItems;
      state.items = items.map(withCurrentCategory);
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
    // Always show the account chooser, so switching Google accounts after logout works.
    provider.setCustomParameters({ prompt: 'select_account' });
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
  state.search=''; state.searchOpen=false; state.lightbox=null;
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
  if(state.settingsSheet && state.view==='settings'){ state.settingsSheet=null; history.pushState({view:'settings'},'',location.href); render(); return; }
  if(state.qrScanning){ stopQrScanner(); return; }
  if(state.analyzing && state.view==='add'){ requestAnalysisExit('list'); return; }
  if(requestUnsavedAddExit('list')) return;
  if(state.view==='multi-select'){ discardPendingAdd(); state.view='list'; render(); return; }
  if(state.view==='add'&&state.addMode){ discardPendingAdd(); state.view='list'; render(); return; }
  if(state.view==='admin-users' && state.adminUserSheet){ state.adminUserSheet=null; history.pushState({view:'admin-users'},'',location.href); render(); return; }
  if(state.view==='admin-promo' || state.view==='admin-users'){ state.view='admin-stats'; render(); return; }
  if(state.view==='contact' || state.view==='admin-stats'){ state.view='settings'; render(); return; }
  if(state.view==='premium'){ state.view=state._premiumReturnView||'list'; render(); return; }
  if(state.view!=='list'){ state.view='list'; render(); return; }
  // Already at the list screen with nothing else open — let the OS handle
  // it from here (this will actually exit/background the app, same as a
  // native app's root screen would).
});

// Nav handler — vienkartinis, iš index.html
// A new app version is ready: reload only when nothing is in progress, otherwise wait
// until the user is back on a main screen (checked on every render).
let _reloadPending = false;
function appIsIdle(){
  return !state.addMode && !state.analyzing && !state.multiReview && !state.editItemId
    && !state.notifModal && !state.appDialog && !document.getElementById('photoEditor')
    && document.visibilityState === 'visible'
    && ['list','settings','search'].includes(state.view);
}
window.__galioSafeReload = () => {
  if(appIsIdle()) location.reload();
  else _reloadPending = true;
};
setInterval(()=>{ if(_reloadPending && appIsIdle()) location.reload(); }, 3000);

window._appNav = (tab) => {
  if(state.analyzing && state.view==='add'){
    requestAnalysisExit(tab);
    return;
  }
  if(requestUnsavedAddExit(tab)) return;
  state.view=tab; render();
};
window._appStartNewItem = (mode) => {
  if(state.analyzing && state.view==='add'){
    requestAnalysisExit('list');
    return;
  }
  if(requestUnsavedAddExit('list')) return;
  if(mode==='photo' && !state.online){
    offlineDialog(
      'Nuskaitymui reikia interneto',
      'Dokumento nuskaitymas veikia su AI, todėl jam reikia interneto. Dabar galite įvesti prekę rankiniu būdu, o dokumentą pridėti vėliau.'
    );
    return;
  }
  if(mode==='photo' && !canAttachNewDoc()){
    showAppDialog('Dokumentų limitas pasiektas', `Nemokamame plane galima turėti iki ${FREE_DOC_LIMIT} dokumentų. Su Premium galėsite prisegti ir matyti visus čekius.`, '', {hideSupport:true});
    return;
  }
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
  // Chrome sometimes leaves stale pixels of the login screen after sign-in; force one full repaint
  if(state.user && state._wasAuth){ state._wasAuth=false; const ap=document.getElementById('app');
    if(ap){ ap.style.opacity='0.99'; requestAnimationFrame(()=>requestAnimationFrame(()=>{ ap.style.opacity=''; })); } }
  if(!state.user){
    state._wasAuth=true;
    if(state.showOnboarding){ scr.innerHTML=renderOnboarding(); nav.style.display='none'; attachOnboardingEvents(); return; }
    scr.innerHTML=renderAuth();nav.style.display='none';attachAuthEvents();return;
  }

  nav.style.display='flex';
  if(state.view!=='settings') state.settingsSheet=null;
  if(state.view!=='admin-users') state.adminUserSheet=null;
  let html='';
  let viewKey = state.view;
  if(state.view==='list')          html=renderList();
  else if(state.view==='search'){ state.view='list'; state.searchOpen=true; html=renderList(); }
  else if(state.view==='add'&&!state.addMode) { html=renderPicker(); viewKey='add-picker'; }
  else if(state.view==='add')      { html=renderAdd(); viewKey='add-form'; }
  else if(state.view==='detail')   html=renderDetail();
  else if(state.view==='settings') html=renderSettings();
  else if(state.view==='contact')  html=renderContact();
  else if(state.view==='premium')  html=renderPremium();
  else if(state.view==='multi-select') html=renderMultiSelect();
  else if(state.view==='admin-stats') html=renderAdminStats();
  else if(state.view==='admin-promo') html=renderAdminPromoPage();
  else if(state.view==='admin-users') html=renderAdminStats('users');

  pushHistoryIfNeeded(viewKey);

  const syncPill = `<div class="sync-pill${state.online?'':' offline'}"><span class="dot"></span>${state.online?'Sinchronizuota':'Be interneto · rodomi įrenginyje esantys įrašai'}</div>`;
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
function onboardSlides(){
  const ic = { bg:'var(--accent-bg)', color:'var(--accent)' };
  const share = canShareToGalio();
  return [
    { ...ic, icon:'ti-scan', title:'Nufotografuok čekį', text:'AI pats atpažįsta prekę, parduotuvę ir datas iš nuotraukos ar PDF – per kelias sekundes.' },
    share
      ? { ...ic, icon:'ti-share', title:'Sąskaitos iš el. pašto', text:'Laiške ar galerijoje pasirink „Bendrinti“ → Galio – įrašas bus užpildytas automatiškai.' }
      : { ...ic, icon:'ti-device-laptop', title:'Sąskaita kompiuteryje?', text:'Atidaryk ją ekrane ir nufotografuok telefonu – AI perskaito ir ekrano nuotrauką.' },
    { ...ic, icon:'ti-rotate-2', title:'Nepražiopsok grąžinimo', text:'Galio parodo tikslią datą, iki kada gali grąžinti prekę, ir primena prieš terminą.' },
    { ...ic, icon:'ti-shield-check', title:'Garantija po ranka', text:'Visi čekiai vienoje vietoje. Priminsime ir prieš baigiantis garantijai.' },
  ];
}
function renderOnboarding(){
  const list = onboardSlides();
  const slides = list.map(s=>`
    <div class="onboard-slide">
      <div class="onboard-icon" style="background:${s.bg}"><i class="ti ${s.icon}" style="color:${s.color}"></i></div>
      <h2>${esc(s.title)}</h2>
      <p>${esc(s.text)}</p>
    </div>`).join('');
  const dots = list.map((_,i)=>`<div class="onboard-dot${i===state.onboardSlide?' active':''}"></div>`).join('');
  const isLast = state.onboardSlide === list.length-1;
  return `<div class="onboard-wrap">
    <div class="onboard-slides" id="onboardSlides">${slides}</div>
    <div class="onboard-dots" id="onboardDots">${dots}</div>
    <div class="onboard-footer">
      <button class="login-btn" id="onboardNext">${isLast?'Pradėti':'Toliau'}</button>
      <button class="onboard-skip" id="onboardSkip" style="${isLast?'visibility:hidden':''}">Praleisti</button>
    </div>
  </div>`;
}
function attachOnboardingEvents(){
  const track = document.getElementById('onboardSlides');
  const count = onboardSlides().length;
  const finish = ()=>{ state.showOnboarding=false; localStorage.setItem('galio_onboarded','1'); render(); };
  // update dots/buttons in place – a full render would reset the scroll and replay every slide
  const sync = ()=>{
    document.querySelectorAll('#onboardDots .onboard-dot').forEach((d,i)=>d.classList.toggle('active', i===state.onboardSlide));
    const last = state.onboardSlide===count-1;
    const nb = document.getElementById('onboardNext'); if(nb) nb.textContent = last?'Pradėti':'Toliau';
    const sk = document.getElementById('onboardSkip'); if(sk) sk.style.visibility = last?'hidden':'';
  };
  if(track && state.onboardSlide) track.scrollLeft = track.clientWidth*state.onboardSlide;
  document.getElementById('onboardNext')?.addEventListener('click',()=>{
    if(state.onboardSlide < count-1){
      state.onboardSlide++; sync();
      track?.scrollTo({left: track.clientWidth*state.onboardSlide, behavior:'smooth'});
    } else { finish(); }
  });
  document.getElementById('onboardSkip')?.addEventListener('click', finish);
  if(track){
    let scrollTimeout;
    track.addEventListener('scroll',()=>{
      clearTimeout(scrollTimeout);
      scrollTimeout=setTimeout(()=>{
        const idx = Math.round(track.scrollLeft / track.clientWidth);
        if(idx!==state.onboardSlide){ state.onboardSlide=idx; sync(); }
      },80);
    });
  }
}

// ── Lightbox ───────────────────────────────────────────────────────────────
function renderLightbox(){return`<div class="lightbox" id="lbOverlay"><div class="lightbox-bar"><span class="lightbox-hint">${matchMedia('(pointer:fine)').matches?'Sukite pelės ratuką arba spustelėkite du kartus, kad priartintumėte':'Suimkite pirštais arba bakstelėkite du kartus, kad priartintumėte'}</span><button class="lightbox-close" id="lbClose"><i class="ti ti-x"></i></button></div><div class="lightbox-img" id="lbBox"><img src="${esc(state.lightbox)}" draggable="false" /></div></div>`;}
function attachLightboxEvents(){
  document.getElementById('lbClose')?.addEventListener('click',()=>{state.lightbox=null;render();});
  document.getElementById('lbOverlay')?.addEventListener('click',e=>{if(e.target.id==='lbOverlay'){state.lightbox=null;render();}});
  // Zoom: pinch, double tap / double click, mouse wheel; drag to move when zoomed
  const box=document.getElementById('lbBox'), img=box?.querySelector('img'); if(!img) return;
  const MAX=6; let s=1,x=0,y=0,start=null,moved=false,lastTap=0; const pts=new Map();
  const k=()=>(box.getBoundingClientRect().width/box.offsetWidth)||1; // desktop CSS zoom
  const rel=(cx,cy)=>{const r=box.getBoundingClientRect(),q=k();return{x:(cx-r.left)/q-box.clientWidth/2,y:(cy-r.top)/q-box.clientHeight/2};};
  const clamp=()=>{ if(s<=1.01){s=1;x=0;y=0;return;} s=Math.min(s,MAX);
    const mx=Math.max(0,(img.offsetWidth*s-box.clientWidth)/2), my=Math.max(0,(img.offsetHeight*s-box.clientHeight)/2);
    x=Math.max(-mx,Math.min(mx,x)); y=Math.max(-my,Math.min(my,y)); };
  const apply=anim=>{ img.style.transition=anim?'transform .2s ease':'none'; img.style.transform=`translate(${x}px,${y}px) scale(${s})`; box.classList.toggle('zoomed',s>1); };
  const zoomAt=(ns,p)=>{ ns=Math.max(1,Math.min(MAX,ns)); x=p.x-(p.x-x)*ns/s; y=p.y-(p.y-y)*ns/s; s=ns; };
  const two=()=>{const [a,b]=[...pts.values()];return{d:Math.hypot(a.x-b.x,a.y-b.y)||1,c:rel((a.x+b.x)/2,(a.y+b.y)/2)};};
  const begin=()=>{ if(pts.size>=2){const t=two();start={pinch:true,d:t.d,c:t.c,s,x,y};moved=true;}
    else if(pts.size===1){const p=[...pts.values()][0];start={px:p.x,py:p.y,x,y};} else start=null; };
  box.addEventListener('pointerdown',e=>{ box.setPointerCapture?.(e.pointerId); pts.set(e.pointerId,{x:e.clientX,y:e.clientY}); if(pts.size===1) moved=false; begin(); });
  box.addEventListener('pointermove',e=>{ if(!pts.has(e.pointerId)||!start) return; pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(start.pinch&&pts.size>=2){ const t=two(), ns=Math.max(0.8,Math.min(MAX,start.s*t.d/start.d));
      x=t.c.x-(start.c.x-start.x)*ns/start.s; y=t.c.y-(start.c.y-start.y)*ns/start.s; s=ns; apply(false); }
    else if(!start.pinch){ const dx=e.clientX-start.px, dy=e.clientY-start.py; if(Math.hypot(dx,dy)>6) moved=true;
      if(s>1&&moved){ const q=k(); x=start.x+dx/q; y=start.y+dy/q; apply(false); } } });
  const end=e=>{ if(!pts.has(e.pointerId)) return; const p=pts.get(e.pointerId); pts.delete(e.pointerId);
    if(pts.size===0){ if(!moved&&e.type==='pointerup'){ const now=Date.now();
        if(now-lastTap<320){ lastTap=0; if(s>1){s=1;x=0;y=0;} else zoomAt(2.5,rel(p.x,p.y)); } else lastTap=now; }
      clamp(); apply(true); start=null; } else begin(); };
  box.addEventListener('pointerup',end); box.addEventListener('pointercancel',end);
  box.addEventListener('wheel',e=>{ e.preventDefault(); zoomAt(s*Math.exp(-e.deltaY*0.0015),rel(e.clientX,e.clientY)); clamp(); apply(false); },{passive:false});
}

// ── Auth screen ────────────────────────────────────────────────────────────
function renderAuth(){
  const m=state.authMode;
  return`<div class="login-wrap"><div class="login-card">
    <div class="login-logo"><img src="icon-192.png" alt="" width="72" height="72" style="border-radius:18px;display:block;margin:0 auto 12px"><h1>Galio</h1><p>${m==='register'?'Susikurkite paskyrą':m==='reset'?'Atstatykite slaptažodį':'Prisijunkite'}</p></div>

    ${m!=='reset'?`<button id="googleBtn" class="login-btn" style="background:var(--bg3);color:var(--text);display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:8px" ${state.authBusy?'disabled':''}>
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.12-.84 2.07-1.79 2.71v2.26h2.9c1.7-1.56 2.68-3.87 2.68-6.61z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33C2.44 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.95 10.7c-.18-.54-.28-1.11-.28-1.7s.1-1.16.28-1.7V4.97H.96A8.99 8.99 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      Tęsti su Google
    </button>
    <p style="font-size:13px;color:var(--text3);text-align:center;margin-bottom:14px;line-height:1.4">Tęsdami su Google sutinkate su <a href="terms.html" target="_blank" style="color:var(--accent)">Naudojimo sąlygomis</a> ir <a href="privacy.html" target="_blank" style="color:var(--accent)">Privatumo politika</a> bei patvirtinate, kad jums yra bent 14 metų.</p>
    <div class="login-divider">arba</div>`:''}

    <input type="email" id="authEmail" class="login-input" placeholder="El. paštas" autocomplete="email" value="${state.authEmail||''}" />
    ${m!=='reset'?`<input type="password" id="authPwd" class="login-input" placeholder="Slaptažodis" autocomplete="${m==='register'?'new-password':'current-password'}" value="${state.authPwd||''}" />`:''}
    ${m==='register'?`<input type="password" id="authPwd2" class="login-input" placeholder="Pakartokite slaptažodį" autocomplete="new-password" value="${state.authPwd2||''}" />`:''}

    ${m==='register'?`<label class="consent-row">
      <input type="checkbox" id="consentCheck" />
      <span>Sutinku su <a href="terms.html" target="_blank">Naudojimo sąlygomis</a> ir <a href="privacy.html" target="_blank">Privatumo politika</a> ir patvirtinu, kad man yra bent 14 metų</span>
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
  setTimeout(maybeAutoCleanup, 0);
  setTimeout(refreshSearchTags, 1500);
  const{items,filterCat,sortBy,userDoc}=state;
  const expired =items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d<0;}).length;
  const expiring=items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d>=0&&d<=30;}).length;
  const valid   =items.filter(i=>{const d=daysLeft(i.warrantyEnd);return d!==null&&d>=0;}).length;
  const isPremium = isPremiumUser();

  const query = state.searchOpen ? searchTerms(state.search) : [];
  const filtered=items
    .filter(i=>filterCat==='Visos'||i.category===filterCat)
    .filter(i=>!query.length || itemMatches(i, query))
    .sort((a,b)=>{
      // Expired warranties always go to the end, whatever the chosen order.
      const ea=(daysLeft(a.warrantyEnd)??0)<0, eb=(daysLeft(b.warrantyEnd)??0)<0;
      if(ea!==eb) return ea?1:-1;
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
    <div class="pb-text">${aiLeft>0?`<b>${aiLeft}</b> AI analiz${aiLeft===1?'ė':'ės'} liko`:'AI analizės išnaudotos'} · Nemokamame plane matomi ${FREE_DOC_LIMIT} dokumentai</div>
    <button id="upgradeBtn">Premium</button>
  </div>`:'';

  // Subtilus priminimų kvietimas - tik jei yra artėjančių terminų ir ne premium
  const soonExpiring = !isPremium && items.some(i=>{
    const warranty = daysLeft(i.warrantyEnd);
    const returns = daysLeft(effectiveReturnDeadline(i));
    return (warranty!==null&&warranty>=0&&warranty<=60) || (returns!==null&&returns>=0&&returns<=14);
  });
  const notifPromo = soonExpiring ? `<div class="plan-banner" id="notifPromoBanner" style="background:var(--accent-bg);margin:0 16px 14px;cursor:pointer">
    <i class="ti ti-bell-ringing" style="color:var(--accent)"></i>
    <div class="pb-text" style="color:var(--text)">Norite priminimo prieš grąžinimo terminą ar garantijos pabaigą? <b style="color:var(--accent)">Sužinokite apie Premium</b></div>
    <i class="ti ti-chevron-right" style="color:var(--text3)"></i>
  </div>` : '';
  const downgradeBanner = needsCloudDowngrade() ? `<div class="plan-banner" style="background:var(--orange-bg);margin:0 16px 14px">
    <i class="ti ti-alert-circle" style="color:var(--orange)"></i>
    <div class="pb-text" style="color:var(--text)">Premium nepratęstas. Perkelkite įrašus į šį įrenginį arba atnaujinkite Premium, kad jie liktų Galio saugykloje ir veiktų priminimai.</div>
    <button id="downgradeStorageBtn" style="background:var(--orange)">Perkelti</button>
  </div>` : '';

  const verifyBanner = !state.user.emailVerified ? `<div class="plan-banner" style="background:var(--accent-bg)">
    <i class="ti ti-mail-exclamation" style="color:var(--accent)"></i>
    <div class="pb-text" style="color:var(--accent)">Patvirtinkite el. paštą, kad galėtumėte naudoti AI analizę. ${state.authInfo&&state.authInfo.includes('iš naujo')?esc(state.authInfo):'Patikrinkite Spam aplanką.'}</div>
    <button id="resendVerifyBtn" style="background:var(--accent)" ${state.authBusy?'disabled':''}>${state.authBusy?'...':'Siųsti dar kartą'}</button>
  </div>`:'';
  const offlineBanner = !state.online ? `<div class="plan-banner" style="background:var(--bg2);margin:0 16px 14px">
    <i class="ti ti-wifi-off" style="color:var(--text2)"></i>
    <div class="pb-text" style="color:var(--text2)">Nėra interneto ryšio. Galite peržiūrėti šiame įrenginyje esančius įrašus; AI nuskaitymas, Galio saugykla ir priminimų keitimas veiks prisijungus.</div>
  </div>` : '';

  const chips=['Visos',...CATEGORIES].map(c=>`<button class="chip${filterCat===c?' active':''}" data-filter="${esc(c)}">${esc(c)}</button>`).join('');

  const cardsHtml=filtered.map(item=>{
    const days=daysLeft(item.warrantyEnd);
    const returnDeadline = effectiveReturnDeadline(item);
    const returnLine = returnLineHtml(returnDeadline);
    const thumb = cardThumbHtml(item);
    const urgentClass = days!==null && days<0 ? ' urgent-exp' : days!==null && days<=30 ? ' urgent-warn' : '';
    return`<div class="swipe-wrap" data-swipe-id="${esc(item.id)}">
      <div class="swipe-delete-bg"><i class="ti ti-trash"></i></div>
      <button class="card${urgentClass}" data-id="${esc(item.id)}">
        ${thumb}
        <div class="card-body">
          <div class="card-top"><span class="card-name">${esc(item.name)}</span>${badgeHtml(days)}</div>
          <div class="card-sub">${esc(item.shop||item.category)}</div>
          ${item.warrantyEnd?`<div class="card-date"><i class="ti ti-calendar" style="font-size:14px"></i>Iki ${fmtDate(item.warrantyEnd)}</div>`:''}
          ${returnLine}
        </div>
      </button>
    </div>`;
  }).join('');

  const skeletonHtml = `<div class="skeleton-card"><div class="skeleton-box skel-thumb"></div><div class="skel-lines"><div class="skeleton-box skel-line" style="width:60%"></div><div class="skeleton-box skel-line" style="width:40%"></div></div></div>`.repeat(3);

  // Placeholders only while nothing is on screen yet; never stacked on top of real entries.
  const emptyHtml=(state.loadingItems && items.length===0) ? skeletonHtml : items.length===0?`<div class="empty-state">
    <div class="empty-icon"><i class="ti ti-shield-check"></i></div>
    <h3>Pridėkite pirmą pirkinį</h3>
    <p>Nuskenuokite dokumentą. Galio parodys garantijos pabaigą ir iki kada prekę dar galima grąžinti.</p>
  </div>`:filtered.length===0?`<div class="empty-state"><div class="empty-icon"><i class="ti ti-filter-off"></i></div><h3>Nieko nerasta</h3><p>${query.length?'Pabandykite kitą žodį':'Pabandykite kitą kategoriją'}</p></div>`:'';

  return`<div class="list-root">
    <div class="page-header">
      <span class="page-title">Garantijos</span>
      <img class="hdr-logo" src="logo-mark.png" alt="Galio" width="30" height="30" style="display:block;flex-shrink:0">
    </div>
    <div style="height:14px"></div>
    ${statsHtml}
    ${verifyBanner}
    ${downgradeBanner}
    ${offlineBanner}
    ${planBanner}
    ${notifPromo}
    ${state.searchOpen ? `<div style="padding:0 16px 10px;display:flex;align-items:center;gap:8px">
      <div class="search-bar" style="margin:0;flex:1"><i class="ti ti-search"></i><input type="text" enterkeyhint="search" autocomplete="off" id="searchInput" placeholder="Pavadinimas, parduotuvė, dok. nr." value="${esc(state.search)}" /></div>
      <button id="searchCloseBtn" aria-label="Uždaryti paiešką" style="width:38px;height:38px;flex-shrink:0;background:var(--bg2);border:none;border-radius:50%;color:var(--text2);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ti ti-x" style="font-size:18px"></i></button>
    </div>` : `<div style="padding:0 16px 10px;display:flex;align-items:center;gap:8px">
      <button id="searchOpenBtn" aria-label="Ieškoti" style="width:38px;height:38px;flex-shrink:0;background:none;border:1px solid var(--border2);border-radius:50%;color:var(--text2);display:flex;align-items:center;justify-content:center;cursor:pointer"><i class="ti ti-search" style="font-size:17px"></i></button>
      <button id="catDropBtn" style="flex:1;background:none;border:1px solid var(--border2);height:38px;box-sizing:border-box;border-radius:19px;padding:0 14px;font-size:14px;font-weight:500;color:var(--text2);display:flex;align-items:center;gap:5px;cursor:pointer;min-width:0">
        <i class="ti ti-filter" style="font-size:15px;flex-shrink:0"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${filterCat}</span>
        <i class="ti ti-chevron-down" style="font-size:15px;flex-shrink:0"></i>
      </button>
      <button id="sortDropBtn" style="flex:1;background:none;border:1px solid var(--border2);height:38px;box-sizing:border-box;border-radius:19px;padding:0 14px;font-size:14px;font-weight:500;color:var(--text2);display:flex;align-items:center;gap:5px;cursor:pointer;min-width:0">
        <i class="ti ti-arrows-sort" style="font-size:15px;flex-shrink:0"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sortBy==='newest'?'Naujausi':sortBy==='expiring'?'Baigiasi':'A–Z'}</span>
        <i class="ti ti-chevron-down" style="font-size:15px;flex-shrink:0"></i>
      </button>
    </div>`}
    ${state.catDropOpen ? `<div id="catDropOverlay" style="position:fixed;inset:0;z-index:99"></div>
    <div class="drop-menu" style="position:fixed;left:16px;top:auto;z-index:100;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:160px;overflow:hidden">
      ${['Visos',...CATEGORIES].map(c=>`<button class="sort-drop-item${filterCat===c?' active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>` : ''}
    ${state.sortDropOpen ? `<div id="sortDropOverlay" style="position:fixed;inset:0;z-index:99"></div>
    <div class="drop-menu" style="position:fixed;right:16px;top:auto;z-index:100;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:160px;overflow:hidden">
      <button class="sort-drop-item${sortBy==='newest'?' active':''}" data-sort="newest"><i class="ti ti-clock" style="font-size:14px"></i>Naujausi</button>
      <button class="sort-drop-item${sortBy==='expiring'?' active':''}" data-sort="expiring"><i class="ti ti-hourglass" style="font-size:14px"></i>Baigiasi pirmi</button>
      <button class="sort-drop-item${sortBy==='name'?' active':''}" data-sort="name"><i class="ti ti-sort-a-z" style="font-size:14px"></i>A–Z</button>
    </div>` : ''}
    <div class="cards">${emptyHtml}${cardsHtml}</div>
    <div style="height:8px"></div>
  </div>`;
}

// ── Search ─────────────────────────────────────────────────────────────────
function itemSearchText(i){
  return normalizeSearchText([i.name,i.shop,i.category,i.docType,i.docNumber,i.notes,
    i.purchaseDate,i.warrantyEnd,i.returnDeadline,i.searchTags].filter(Boolean).join(' '));
}
// "keptuvės" finds "keptuvė", "laikrodžio" finds "laikrodis": drop the ending and match
// word starts, so "laik" no longer hits the middle of "laisvalaikis".
function searchTerms(q){
  return normalizeSearchText(q).split(/[^a-z0-9]+/).filter(Boolean)
    .map(w => /\d/.test(w) || w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 2)));
}
function itemMatches(item, terms){
  const text = itemSearchText(item);
  const words = text.split(/[^a-z0-9]+/);
  return terms.every(t => /\d/.test(t) ? text.includes(t) : words.some(w => w.startsWith(t)));
}

// Search keywords (synonyms, related products) for entries that do not have them yet:
// old entries, manual ones, renamed ones. Runs quietly in the background.
const _tagsTried = new Set();
let _tagsRunning = false;
async function refreshSearchTags(){
  if(_tagsRunning || !state.user || !state.user.emailVerified || state.loadingItems || !navigator.onLine) return;
  const todo = state.items.filter(i => i.name && i.searchTagsFor !== i.name && !_tagsTried.has(i.id + '|' + i.name)).slice(0, 40);
  if(!todo.length) return;
  _tagsRunning = true;
  todo.forEach(i => _tagsTried.add(i.id + '|' + i.name));
  try{
    const idToken = await state.user.getIdToken();
    const res = await fetch(WORKER_URL + '/tags', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body: JSON.stringify({ names: todo.map(i => i.name) }),
    });
    if(!res.ok) return;
    const { tags } = await res.json();
    if(!Array.isArray(tags) || tags.length !== todo.length) return;
    for(let k = 0; k < todo.length; k++){
      const item = state.items.find(i => i.id === todo[k].id);
      if(!item || item.name !== todo[k].name) continue;
      const patch = { searchTags: String(tags[k] || '').slice(0, 400), searchTagsFor: item.name };
      if(state.storageMode === 'cloud'){
        await updateDoc(doc(db,'users',state.user.uid,'warranties',item.id), patch).catch(e => console.warn('tags save', e));
      }else{
        Object.assign(item, patch);
        await localPut(state.user.uid, item).catch(e => console.warn('tags save', e));
      }
    }
  }catch(e){ console.warn('Search tags failed:', e); }
  finally{ _tagsRunning = false; }
}
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
    const thumb=cardThumbHtml(item);
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
  const docLimitReached = !canAttachNewDoc();
  const offline = !state.online;

  return`<div class="picker-page">
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-x"></i></button><h2>Nauja garantija</h2></div>
    <div class="picker-cards">
      <button class="picker-card" id="modePhoto">
        <div class="picker-icon" style="background:var(--accent-bg)"><i class="ti ti-camera" style="color:var(--accent)"></i></div>
        <div><h3>Nuskaityti dokumentą</h3><p>${offline?'Reikia interneto. Dabar galite įvesti rankiniu būdu.':docLimitReached?`Pasiektas ${FREE_DOC_LIMIT} dokumentų limitas. Daugiau – su Premium.`:aiExhausted?'AI analizės išnaudotos. Toliau įveskite rankiniu būdu.':`AI ištrauks prekes, garantiją ir grąžinimo terminą${!isPremium?` (${aiLeft} liko)`:''}.`}</p></div>
      </button>
      <button class="picker-card" id="modeManual">
        <div class="picker-icon" style="background:var(--green-bg)"><i class="ti ti-pencil" style="color:var(--green)"></i></div>
        <div><h3>Įvesti rankiniu būdu</h3><p>Patys įrašykite prekę, garantijos pabaigą ir grąžinimo datą.</p></div>
      </button>
    </div>
    ${canShareToGalio() && !offline ? `<p class="picker-share-tip"><i class="ti ti-share"></i>Sąskaitas iš el. pašto ir PDF galite perduoti per <b>„Bendrinti“ → Galio</b></p>` : ''}
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
  const docLimitReached = !canAttachNewDoc() && !f.docData;

  let docAreaHtml='';
  const qrButtonHtml = !f.docData ? `<button type="button" class="qr-link-btn" disabled style="opacity:0.5;cursor:default"><i class="ti ti-qrcode"></i>QR skanavimas — netrukus</button>` : '';
  if(hasPdf){
    docAreaHtml=`<div class="doc-preview-pdf"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(f.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">PDF pridėtas</div></div></div>`;
  }else if(hasImg){
    docAreaHtml=`<div style="position:relative"><img class="doc-preview-img" id="docThumb" src="${esc(f.docData)}" alt="" /><div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.55);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;pointer-events:none"><i class="ti ti-zoom-in" style="font-size:14px;color:#fff"></i></div></div>`;
  }else if(docLimitReached){
    docAreaHtml=`<div class="doc-drop-zone" style="cursor:default">
      <i class="ti ti-lock"></i>
      <p>Dokumentų limitas pasiektas</p>
      <span>Nemokamame plane galima turėti iki ${FREE_DOC_LIMIT} dokumentų. Su Premium galėsite prisegti ir matyti visus čekius.</span>
    </div>`;
  }else{
    docAreaHtml=`${qrButtonHtml}<label class="doc-drop-zone" for="docInput">
      <i class="ti ti-${isPhoto?'camera':'paperclip'}"></i>
      <p>${isPhoto?'Fotografuoti arba įkelti':'Prisegti dokumentą (neprivaloma)'}</p>
      <small>JPG, PNG, PDF · max 10MB / 5MB PDF</small>
    </label>`;
  }
  const itemPhotoHtml = f.itemPhotoData ? `
    <div class="item-photo-preview">
      <img id="itemPhotoThumb" src="${esc(f.itemPhotoData)}" alt="" />
      <div class="item-photo-actions">
        <button type="button" class="photo-action-btn" id="changeItemPhoto"><i class="ti ti-photo-edit"></i>Keisti</button>
        <button type="button" class="photo-action-btn danger" id="removeItemPhoto"><i class="ti ti-trash"></i>Pašalinti</button>
      </div>
    </div>` : `
    <label class="item-photo-empty" for="itemPhotoInput">
      <i class="ti ti-shirt"></i>
      <span>
        <strong>Pridėti daikto nuotrauką</strong>
        <small>Ji bus rodoma pagrindiniame sąraše vietoje dokumento.</small>
      </span>
    </label>`;

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
      ${WARRANTY_OPTS.map(o=>`<button class="warranty-opt warranty-duration-opt${f.warrantyMonths===o.m?' selected':''}" data-wm="${o.m??'x'}">${esc(o.l)}${f.warrantyMonths===o.m?`<i class="ti ti-check"></i>`:''}</button>`).join('')}
    </div>
  </div>`:'';
  const isCustomReturnDate = f.returnDays === null;
  const currentReturnDays = isCustomReturnDate ? null : normalizeReturnDays(f.returnDays, f.shop);
  const currentReturnDeadline = formReturnDeadline(f);
  const canSaveForm = f.name.trim() && f.warrantyEnd && state.uploadPct===null && (!isCustomReturnDate || !!f.returnDeadline);
  const returnDaysSheet=state.showReturnDays?`<div class="warranty-sheet" id="returnDaysSheet">
    <div class="warranty-overlay" id="returnDaysOverlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title">Grąžinimo terminas</div>
      ${RETURN_DAY_OPTS.map(d=>`<button class="warranty-opt return-days-opt${currentReturnDays===d?' selected':''}" data-days="${d}">${d} d.${currentReturnDays===d?`<i class="ti ti-check"></i>`:''}</button>`).join('')}
      <button class="warranty-opt return-days-opt${isCustomReturnDate?' selected':''}" data-days="x">Kita data${isCustomReturnDate?`<i class="ti ti-check"></i>`:''}</button>
    </div>
  </div>`:'';

  const nameReviewModal=state.aiNameReview?`<div class="warranty-sheet" id="aiNameReviewSheet">
    <div class="warranty-overlay"></div>
    <div class="warranty-panel">
      <div class="warranty-handle"></div>
      <div class="warranty-title" style="font-size:17px;color:var(--text);margin-bottom:16px">Pavadinimas</div>
      <div style="padding:0 20px 20px">
        <div class="form-field" style="margin-bottom:14px">
          <label>Prekės pavadinimas</label>
          <input type="text" id="aiNameReviewInput" value="${esc(f.name)}" placeholder="Įrašykite pavadinimą" autofocus />
        </div>
        <button class="save-btn" id="aiNameReviewSave" ${f.name.trim()?'':'disabled'} style="margin:0">Patvirtinti</button>
      </div>
    </div>
  </div>`:'';

  return`<div>
    <div class="page-header-sm"><button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button><h2>${state.editItemId?'Redaguoti':'Nauja garantija'}</h2></div>
    <div class="form-body">
      ${!state.user.emailVerified&&isPhoto?`<div class="plan-banner" style="margin-bottom:14px"><i class="ti ti-mail-exclamation"></i><div class="pb-text">Patvirtinkite el. paštą, kad galėtumėte naudoti AI analizę</div></div>`:''}
      ${multiItemBanner}
      <div class="doc-upload-area">
        ${docAreaHtml}
        ${docLimitReached?'':`<input type="file" id="docInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" ${isPhoto?'capture="environment"':''} style="display:none" />`}
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

      <p class="form-label-section">Daikto nuotrauka</p>
      <div class="item-photo-area">
        ${itemPhotoHtml}
        <input type="file" id="itemPhotoInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" style="display:none" />
      </div>

      <p class="form-label-section">Datos</p>
      <div class="form-section">
        <div class="form-field">
          <label>Pirkimo data</label>
          <input type="date" id="f_purchaseDate" value="${esc(f.purchaseDate)}" />
        </div>
        <div class="form-field" id="warrantyBtn" style="cursor:pointer">
          <label>Garantija</label>
          <span style="font-size:16px;color:${!f.warrantyMonths&&f.warrantyMonths!==0?'var(--text3)':'var(--text)'};display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%">
            ${esc(selOpt.l)}
            <i class="ti ti-chevron-right" style="font-size:14px;color:var(--text3);flex-shrink:0"></i>
          </span>
        </div>
        ${f.warrantyMonths===null?`<div class="form-field"><label>Galioja iki</label><input type="date" id="f_warrantyEnd" value="${esc(f.warrantyEnd)}" /></div>`:''}
        <button type="button" class="form-field tappable" id="returnDaysBtn" style="background:none;border:none;text-align:left;width:100%">
          <label>Grąžinimas</label>
          <div class="form-field-row">
            <div class="fv">${isCustomReturnDate ? 'Kita data' : `${currentReturnDays} d.`}</div>
            <i class="ti ti-chevron-right form-row-chevron"></i>
          </div>
          ${currentReturnDeadline?`<div style="font-size:13px;color:var(--text2);margin-top:6px;line-height:1.35">Grąžinti iki ${fmtDate(currentReturnDeadline)}</div>`:''}
        </button>
        ${isCustomReturnDate?`<div class="form-field"><label>Grąžinti iki</label><input type="date" id="f_returnDeadline" value="${esc(f.returnDeadline||'')}" /></div>${!f.returnDeadline?`<div style="font-size:13px;color:var(--orange);padding:0 2px 10px">Nurodykite grąžinimo pabaigos datą.</div>`:''}`:''}
      </div>
      ${f.warrantyAppliesWarning ? `<div class="plan-banner" style="margin-bottom:16px;background:var(--orange-bg)">
        <i class="ti ti-info-circle" style="color:var(--orange);flex-shrink:0"></i>
        <div class="pb-text" style="color:var(--text);font-size:14px">AI: šiai prekei garantija paprastai netaikoma. Jei vis tiek norite saugoti, nurodykite garantijos pabaigos datą rankiniu būdu.</div>
      </div>` : ''}
        ${!f.warrantyEnd?`<div style="font-size:13px;color:var(--orange);padding:10px 2px 0">Nurodykite garantijos pabaigos datą, kad galėtumėte išsaugoti.</div>`:''}

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

      <p class="form-label-section">Kaina</p>
      <div class="form-section">
        <div class="form-field">
          <input type="text" id="f_price" inputmode="decimal" placeholder="pvz. 39,99" value="${esc(extractPriceFromNotes(f.notes).replace(/\s*€\s*$/,''))}" />
        </div>
      </div>

      <p class="form-label-section">Pastabos</p>
      <div class="form-section">
        <div class="form-field">
          <textarea id="f_notes" rows="3" placeholder="Papildoma informacija...">${esc(notesWithoutPrice(f.notes))}</textarea>
        </div>
      </div>

      ${state.uploadPct!==null?`<div class="upload-progress-row"><div class="upload-progress-bar"><div class="upload-progress-fill" style="width:${state.uploadPct}%"></div></div><span style="font-size:14px;color:var(--text2)">${state.uploadPct}%</span></div>`:''}

      <div style="height:80px"></div>
    </div>
    ${warrantySheet}
    ${returnDaysSheet}
    ${nameReviewModal}
    <div class="fixed-bar" style="position:fixed;bottom:65px;left:0;right:0;padding:10px 16px;background:var(--bg);border-top:0.5px solid var(--border);z-index:50">
      <button class="save-btn" id="saveBtn" ${canSaveForm?'':'disabled'}>${state.uploadPct!==null?'Saugoma...':'Išsaugoti'}</button>
    </div>
  </div>`;
}

// ── Detail ─────────────────────────────────────────────────────────────────
function renderDetail(){
  const item=state.items.find(i=>i.id===state.selected);
  if(!item){state.view='list';render();return '';}
  const days=daysLeft(item.warrantyEnd);
  const doc=effectiveDoc(item);
  const itemPhoto=effectiveItemPhoto(item);
  let sc,si,sv;
  if(days===null){sc='var(--bg2)';si='ti-shield';sv='Nenurodyta';}
  else if(days<0){sc='var(--red-bg)';si='ti-shield-x';sv='Garantija baigėsi';}
  else if(days<=30){sc='var(--orange-bg)';si='ti-shield-exclamation';sv=`Liko ${days} d.`;}
  else{sc='var(--green-bg)';si='ti-shield-check';sv=`Liko ${warrantyTimeLeftText(days)}`;}
  const textColor=days===null?'var(--text2)':days<0?'var(--red)':days<=30?'var(--orange)':'var(--green)';
  const isPremium = isPremiumUser();

  const returnDeadline = effectiveReturnDeadline(item);
  const returnDays = daysLeft(returnDeadline);
  let rsc,rsi,rsv,rTextColor;
  if(returnDeadline!==null){
    if(returnDays<0){ rsc='var(--bg2)'; rsi='ti-rotate-2'; rsv='Baigėsi'; rTextColor='var(--text2)'; }
    else if(returnDays<=3){ rsc='var(--orange-bg)'; rsi='ti-rotate-2'; rsv=returnDays===0?'Šiandien':`Liko ${returnDays} d.`; rTextColor='var(--orange)'; }
    else{ rsc='rgba(59,130,246,.14)'; rsi='ti-rotate-2'; rsv=`Liko ${returnDays} d.`; rTextColor='#60a5fa'; }
  }
  const statusHtml = returnDeadline!==null ? `<div style="display:flex;gap:10px;margin:16px 16px 0">
    <div class="detail-status" style="flex:1;margin:0;background:${sc}">
      <i class="ti ${si}" style="font-size:28px;color:${textColor}"></i>
      <div><div class="ds-label" style="color:${textColor}">Garantija</div><div class="ds-val" style="color:${textColor};font-size:17px">${days===null?'Nenurodyta':days<0?'Baigėsi':`Liko ${warrantyTimeLeftText(days)}`}</div></div>
    </div>
    <div class="detail-status" style="flex:1;margin:0;background:${rsc}">
      <i class="ti ${rsi}" style="font-size:28px;color:${rTextColor}"></i>
      <div><div class="ds-label" style="color:${rTextColor}">Grąžinimas</div><div class="ds-val" style="color:${rTextColor};font-size:17px">${rsv}</div></div>
    </div>
  </div>` : `<div class="detail-status" style="background:${sc}">
    <i class="ti ${si}" style="font-size:36px;color:${textColor}"></i>
    <div><div class="ds-label" style="color:${textColor}">Garantijos statusas</div><div class="ds-val" style="color:${textColor}">${sv}</div></div>
  </div>`;

  let docHtml='';
  if(doc.docUrl&&!canViewDoc(item)){
    docHtml=`<div class="detail-section"><div class="media-label">Dokumentas</div>${lockedDocHtml(false)}</div>`;
  }else if(doc.docUrl&&doc.docMime==='application/pdf'){
    docHtml=`<div class="detail-section"><div class="media-label">Dokumentas</div><a class="doc-preview-pdf" href="${esc(doc.docUrl)}" target="_blank"><i class="ti ti-file-type-pdf"></i><div><div class="pdf-name">${esc(doc.docFileName||'dokumentas.pdf')}</div><div class="pdf-hint">Spustelkite peržiūrėti</div></div><i class="ti ti-external-link" style="font-size:18px;color:var(--red);flex-shrink:0"></i></a></div>`;
  }else if(doc.docUrl){
    docHtml=`<div class="detail-section"><div class="media-label">Dokumentas</div><img src="${esc(doc.docUrl)}" id="docImg" class="detail-media-img" /></div>`;
  }
  const itemPhotoHtml = itemPhoto.itemPhotoUrl
    ? `<div class="detail-section" style="margin-top:14px"><div class="media-label">Daikto nuotrauka</div><img src="${esc(itemPhoto.itemPhotoUrl)}" id="itemPhotoImg" class="detail-media-img item-photo-main" /></div>`
    : `<div class="detail-section" style="margin-top:14px">
        <button type="button" class="item-photo-empty" id="detailAddPhotoBtn" style="width:100%;border:1.5px dashed var(--border2);text-align:left">
          <i class="ti ti-shirt"></i>
          <span>
            <strong>Pridėti daikto nuotrauką</strong>
            <small>Ji bus rodoma pagrindiniame sąraše vietoje dokumento.</small>
          </span>
        </button>
        <input type="file" id="detailItemPhotoInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" style="display:none" />
      </div>`;

  const itemPrice = extractPriceFromNotes(item.notes);
  const visibleNotes = notesWithoutPrice(item.notes);
  const rows=[
    {i:'ti-tag',l:'Prekės pavadinimas',v:item.name},
    ...(itemPrice ? [{i:'ti-cash',l:'Kaina',v:itemPrice}] : []),
    {i:'ti-building-store',l:'Parduotuvė',v:item.shop||'—'},
    {i:'ti-category',l:'Kategorija',v:item.category},
    {i:'ti-file-description',l:'Dok. tipas',v:item.docType||'—'},
    {i:'ti-hash',l:'Dok. numeris',v:item.docNumber||'—'},
    {i:'ti-calendar',l:'Pirkimo data',v:fmtDate(item.purchaseDate)},
    {i:'ti-calendar-due',l:'Garantija iki',v:fmtDate(item.warrantyEnd)},
    ...(effectiveReturnDeadline(item)!==null ? [{i:'ti-rotate-2',l:`${effectiveReturnDays(item)} d. grąžinimas iki`,v:fmtDate(effectiveReturnDeadline(item))}] : []),
  ].map(r=>`<div class="detail-row"><i class="ti ${r.i}"></i><span class="dr-label">${esc(r.l)}</span><span class="dr-val">${esc(r.v)}</span></div>`).join('');
  const warrantyNotifs = Array.isArray(item.notifyDays) ? [...item.notifyDays].sort((a,b)=>a-b) : [];
  const returnNotifs = Array.isArray(item.notifyReturnDays) ? [...item.notifyReturnDays].sort((a,b)=>a-b) : [];
  const hasActiveWarrantyDeadline = daysLeft(item.warrantyEnd) !== null && daysLeft(item.warrantyEnd) >= 0;
  const hasActiveReturnDeadline = daysLeft(effectiveReturnDeadline(item)) !== null && daysLeft(effectiveReturnDeadline(item)) >= 0;
  const hasReminderTarget = hasActiveWarrantyDeadline || hasActiveReturnDeadline;
  const globalNotifyOff = state.userDoc?.notifyEnabled === false;
  const itemHasNotifDays = warrantyNotifs.length || returnNotifs.length || item.notifyRepeatDays;
  const remindersOn = !globalNotifyOff && item.notifyEnabled !== false && itemHasNotifDays;
  const reminderText = !hasReminderTarget
    ? 'Aktyvių terminų nėra'
    : globalNotifyOff && item.notifyEnabled !== false && itemHasNotifDays
    ? 'Pranešimai išjungti — įjunkite Nustatymuose'
    : remindersOn
    ? [
        warrantyNotifs.length ? `Garantija: ${warrantyNotifs.map(d=>d===1?'1 d.':d===7?'1 sav.':d===30?'1 mėn.':d+' d.').join(', ')}` : '',
        returnNotifs.length ? `Grąžinimas: ${returnNotifs.map(d=>d===1?'1 d.':d===7?'1 sav.':d+' d.').join(', ')}` : '',
      ].filter(Boolean).join(' · ')
    : 'Priminimai šiam įrašui išjungti';
  const remindersSection = state.storageMode==='cloud' ? `<div class="detail-section">
    <button class="settings-row ${hasReminderTarget?'tappable':''}" ${hasReminderTarget?'id="editRemindersBtn"':''} style="width:100%;background:var(--bg2);border:none;text-align:left;border-radius:var(--radius);padding:14px 16px;${hasReminderTarget?'':'cursor:default'}">
      <i class="ti ti-bell row-icon" style="color:${remindersOn?'var(--accent)':'var(--text3)'}"></i>
      <span class="settings-row-label">Priminimai<small>${esc(reminderText)}</small></span>
      ${hasReminderTarget ? `<span style="color:var(--accent);font-weight:700;font-size:15px;white-space:nowrap">Keisti</span>` : ''}
    </button>
  </div>` : '';

  const policySection = isPremium ? `<div class="detail-section">
    ${state.policyChecking ? `<div class="analyzing-row" style="justify-content:center"><div class="spinner"></div><span style="font-size:15px;color:var(--text2)">Galio tikrina papildomas sąlygas…</span></div>`
      : state.policyResult && state.policyResultFor===item.id ? `<div class="plan-banner" style="background:var(--accent-bg);align-items:flex-start">
          <i class="ti ti-info-circle" style="color:var(--accent);margin-top:2px;flex-shrink:0"></i>
          <div class="pb-text" style="color:var(--text);font-size:14px;line-height:1.5"><b style="color:var(--accent)">Papildoma informacija:</b><br/>${esc(state.policyResult.replace(/\*\*/g,'').replace(/\*/g,''))}</div>
        </div>`
      : `<button class="qr-link-btn" id="checkPolicyBtn"><i class="ti ti-sparkles"></i>Patikrinti papildomas sąlygas</button>`}
  </div>` : '';

  return`<div>
    <div class="page-header-sm">
      <button class="back-btn" id="backBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>${esc(item.name)}</h2>
      <button class="icon-btn" id="editItemBtn" style="color:var(--accent)"><i class="ti ti-pencil" style="font-size:18px"></i></button>
    </div>
    ${statusHtml}
    ${itemPhotoHtml}
    ${docHtml}
    <div class="detail-section"><div class="detail-rows">${rows}</div></div>
    ${remindersSection}
    ${visibleNotes?`<div class="detail-section"><div class="notes-card"><div class="nc-label">Pastabos</div><p>${esc(visibleNotes)}</p></div></div>`:''}
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
  const canChangePassword = providers.includes('password') && !providers.includes('google.com');
  const uidShort = u.uid ? u.uid.slice(0,8) : '—';
  const planLabel = state.userDoc?.role==='admin'
    ? '<i class="ti ti-shield-check" style="font-size:15px"></i> Administratorius'
    : isPremium
      ? '<i class="ti ti-crown" style="font-size:15px"></i> Premium narys'
      : `Nemokamas planas · ${state.items.length} įrašų`;

  const keepM = keepExpiredMonths();
  const keepLabel = (EXPIRED_KEEP_OPTIONS.find(o=>o[0]===keepM)||[])[1] || '';
  const themeOpts = [['auto','Auto','device-mobile'],['light','Šviesi','sun'],['dark','Tamsi','moon']];
  const themeLabel = (themeOpts.find(o=>o[0]===state.theme)||themeOpts[0])[1];
  const aiMonthUsed = state.userDoc?.aiMonthKey===new Date().toISOString().slice(0,7)?(state.userDoc?.aiMonthCount||0):0;
  const aiDayUsed = state.userDoc?.aiDayKey===new Date().toISOString().slice(0,10)?(state.userDoc?.aiDayCount||0):0;
  const aiVal = isPremium ? `liko ${Math.max(0,PREMIUM_MONTHLY_LIMIT-aiMonthUsed)}` : `liko ${aiLeft}`;
  const rowBtn = 'width:100%;background:none;border:none;text-align:left;color:inherit';
  const chev = '<i class="ti ti-chevron-right" style="color:var(--text3);font-size:16px"></i>';
  const appVersion = esc((document.querySelector('script[src*="app.js"]')?.src.split('v=')[1])||'?');

  return `<div>
    <div class="page-header">
      <span class="page-title">Nustatymai</span>
      <img class="hdr-logo" src="logo-mark.png" alt="Galio" width="30" height="30" style="display:block;flex-shrink:0">
    </div>

    <button class="settings-profile tappable" id="settingsAccountBtn" style="width:calc(100% - 32px);border:none;text-align:left;color:inherit;padding:14px 16px">
      <div class="settings-avatar" style="width:44px;height:44px;font-size:18px">${avatarHtml}</div>
      <div class="settings-profile-info">
        <div class="settings-profile-email">${esc(accountName)}</div>
        <div class="settings-profile-plan${isPremium?' premium':''}">${planLabel}</div>
      </div>
      ${chev}
    </button>

    ${needsCloudDowngrade() ? `<div class="plan-banner" style="background:var(--orange-bg);margin:0 16px 14px">
      <i class="ti ti-alert-circle" style="color:var(--orange)"></i>
      <div class="pb-text" style="color:var(--text)">Premium nepratęstas. Perkelkite įrašus į šį įrenginį.</div>
      <button id="downgradeStorageBtn2" style="background:var(--orange)">Perkelti</button>
    </div>` : !isPremium ? `<div class="plan-banner" style="margin:0 16px 14px">
      <i class="ti ti-crown"></i>
      <div class="pb-text">Premium: Galio saugykla, priminimai ir ${PREMIUM_MONTHLY_LIMIT} AI analizių per mėnesį</div>
      <button id="upgradeBtnSettings">Premium</button>
    </div>` : ''}
    ${!state.online ? `<div class="plan-banner" style="background:var(--bg2);margin:0 16px 14px">
      <i class="ti ti-wifi-off" style="color:var(--text2)"></i>
      <div class="pb-text" style="color:var(--text2)">Nėra interneto. Saugojimo ir priminimų nustatymus pakeisite prisijungę.</div>
    </div>` : ''}

    <div class="form-section" style="margin:0 16px 14px">
      <button class="settings-row tappable" id="settingsStorageBtn" style="${rowBtn}">
        <i class="ti ti-${isCloud?'cloud':'device-mobile'} row-icon"></i><span class="settings-row-label">Įrašų saugojimas</span>
        <span class="settings-row-val">${isCloud?'Galio saugykla':'Įrenginyje'}</span>${chev}
      </button>
      <button class="settings-row tappable" id="settingsAiBtn" style="${rowBtn}">
        <i class="ti ti-sparkles row-icon"></i><span class="settings-row-label">AI analizių limitai</span>
        <span class="settings-row-val">${aiVal}</span>${chev}
      </button>
      <div class="settings-row" style="border-bottom:none;${!isCloud?'opacity:0.65':''}">
        <i class="ti ti-bell row-icon"></i>
        <div class="settings-row-label">Pranešimai${!isCloud?'<small>Tik su Galio saugykla</small>':''}</div>
        <button class="toggle-switch${notifyOn&&isCloud?' on':''}" id="notifyToggle" ${!isCloud?'disabled':''}><div class="knob"></div></button>
      </div>
      <button class="settings-row tappable" id="settingsExpiredBtn" style="${rowBtn}">
        <i class="ti ti-archive row-icon"></i><span class="settings-row-label">Seni įrašai</span>
        <span class="settings-row-val">${keepM?`trinti po ${esc(keepLabel)}`:'saugoti visada'}</span>${chev}
      </button>
      <button class="settings-row tappable" id="settingsThemeBtn" style="${rowBtn}">
        <i class="ti ti-palette row-icon"></i><span class="settings-row-label">Išvaizda</span>
        <span class="settings-row-val">${themeLabel}</span>${chev}
      </button>
    </div>

    <div class="form-section" style="margin:0 16px 10px">
      ${isAdmin ? `<button class="settings-row tappable" id="adminPanelBtn" style="${rowBtn}">
        <i class="ti ti-chart-bar row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Admin valdymas</span>${chev}
      </button>` : ''}
      <button class="settings-row tappable" id="helpContactBtn" style="${rowBtn}">
        <i class="ti ti-help-circle row-icon"></i><span class="settings-row-label">Susisiekti su pagalba</span>${chev}
      </button>
      <button class="settings-row tappable" id="settingsLegalBtn" style="${rowBtn}">
        <i class="ti ti-file-text row-icon"></i><span class="settings-row-label">Teisinė informacija</span>${chev}
      </button>
    </div>
    <p style="text-align:center;font-size:11px;color:var(--text3);margin:0 0 12px">Galio ${APP_VERSION_NAME}</p>
    ${renderSettingsSheet({isPremium, isCloud, canChangePassword, accountEmail, providerLabel, uidShort, keepM, themeOpts, appVersion, aiLeft, aiMonthUsed, aiDayUsed})}
  </div>`;
}

// Bottom sheets opened from the settings rows. Anything marked data-close shuts the
// sheet before its own action runs (see attach code).
const APP_VERSION_NAME = canShareToGalio() ? '1.5' : '1.4';
function renderSettingsSheet(o){
  const k = state.settingsSheet;
  if(!k) return '';
  const opt = (attrs, label, selected, cls='') =>
    `<button class="warranty-opt ${cls}${selected?' selected':''}" data-close ${attrs}>${label}${selected?'<i class="ti ti-check"></i>':''}</button>`;
  const note = t => `<p style="font-size:14px;color:var(--text2);line-height:1.45;margin:0 20px 14px">${t}</p>`;
  let title = '', body = '';
  if(k==='account'){
    title = 'Paskyra';
    body = note(`${esc(o.accountEmail)}<br><span style="font-size:12px;color:var(--text3)">${o.providerLabel} · ID ${esc(o.uidShort)}</span>`)
      + (o.canChangePassword ? `<button class="warranty-opt" data-close id="changePwdBtn">Pakeisti slaptažodį<i class="ti ti-lock" style="color:var(--text3)"></i></button>` : '')
      + `<button class="warranty-opt" data-close id="settingsLogoutRow">Atsijungti<i class="ti ti-logout" style="color:var(--text3)"></i></button>`
      + `<button class="warranty-opt" data-close id="deleteAccountBtn" style="color:var(--red)">Ištrinti paskyrą<i class="ti ti-trash" style="color:var(--red)"></i></button>`;
  }else if(k==='storage'){
    title = 'Įrašų saugojimas';
    body = note(o.isCloud
        ? 'Įrašai, dokumentai ir nuotraukos laikomi Galio saugykloje ir pasiekiami kituose įrenginiuose prisijungus prie savo paskyros.'
        : o.isPremium
          ? 'Įrašai, dokumentai ir nuotraukos dabar laikomi tik šiame įrenginyje. Perkelkite į Galio saugyklą, jei norite juos pasiekti kituose įrenginiuose.'
          : 'Nemokamame plane įrašai, dokumentai ir nuotraukos laikomi tik šiame įrenginyje. Galio saugykla įeina į Premium.')
      + ((o.isPremium || o.isCloud)
        ? `<div style="padding:0 20px 8px"><button class="save-btn" data-close id="storageModeToggle" style="margin:0" ${state.migratingStorage?'disabled':''}>${state.migratingStorage?'Perkeliama...':(o.isCloud?'Laikyti tik įrenginyje':'Perkelti į Galio saugyklą')}</button></div>`
        : `<div style="padding:0 20px 8px"><button class="save-btn" data-close id="upgradeBtnSettings" style="margin:0">Premium</button></div>`);
  }else if(k==='expired'){
    title = 'Seni įrašai';
    body = note('Kai baigiasi ir garantija, ir grąžinimo terminas, Galio po pasirinkto laiko pasiūlys tokius įrašus ištrinti. Be jūsų patvirtinimo niekas netrinama.')
      + EXPIRED_KEEP_OPTIONS.map(([m,l]) => opt(`data-keep="${m}"`, m ? `Trinti po ${esc(l)}` : 'Saugoti visada', o.keepM===m, 'keep-opt')).join('');
  }else if(k==='theme'){
    title = 'Išvaizda';
    body = o.themeOpts.map(([t,l,ic]) => opt(`data-theme="${t}"`, `<span style="display:flex;align-items:center;gap:12px"><i class="ti ti-${ic}" style="color:var(--text2)"></i>${l}</span>`, state.theme===t, 'theme-row')).join('');
  }else if(k==='ai'){
    title = 'AI analizių limitai';
    const meter = (label, used, limit) => `<div style="margin:0 20px 14px">
      <div style="display:flex;justify-content:space-between;font-size:15px;margin-bottom:6px"><span>${label}</span><span style="color:var(--text2)"><b style="color:var(--text)">${used}</b> iš ${limit}</span></div>
      <div style="height:8px;border-radius:4px;background:var(--bg3);overflow:hidden"><div style="height:100%;width:${Math.min(100, used*100/Math.max(1,limit))}%;background:var(--accent);border-radius:4px"></div></div>
    </div>`;
    body = o.isPremium
      ? meter('Šiandien panaudota', o.aiDayUsed, PREMIUM_DAILY_LIMIT) + meter('Šį mėnesį panaudota', o.aiMonthUsed, PREMIUM_MONTHLY_LIMIT)
        + note('Dienos limitas atsinaujina kas parą, mėnesio – mėnesio pradžioje.')
      : meter('Panaudota nemokamų', AI_FREE_USES - o.aiLeft, AI_FREE_USES)
        + note(`AI nuskaito čekį ir pats užpildo prekę, garantiją ir grąžinimo terminą. Nemokamai – ${AI_FREE_USES} kartai. Su Premium – iki ${PREMIUM_MONTHLY_LIMIT} per mėnesį.`)
        + `<div style="padding:0 20px 8px"><button class="save-btn" data-close id="upgradeBtnSettings" style="margin:0">Premium</button></div>`;
  }else if(k==='legal'){
    title = 'Teisinė informacija';
    body = `<a class="warranty-opt" data-close href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none">Privatumo politika<i class="ti ti-external-link" style="color:var(--text3)"></i></a>`
      + `<a class="warranty-opt" data-close href="terms.html" target="_blank" rel="noopener" style="text-decoration:none">Naudojimo sąlygos<i class="ti ti-external-link" style="color:var(--text3)"></i></a>`;
  }
  return `<div class="warranty-sheet center-sheet" id="settingsSheet">
    <div class="warranty-overlay" id="settingsSheetOverlay"></div>
    <div class="warranty-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 12px 10px 20px">
        <div style="font-size:17px;font-weight:700;color:var(--text)">${title}</div>
        <button class="back-btn" data-close id="settingsSheetClose" aria-label="Uždaryti"><i class="ti ti-x"></i></button>
      </div>
      ${body}
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

function showNotifModal(itemId, itemData, savedNote=''){
  if(!itemId){ state.view='list'; render(); return; }
  const firstItemId = Array.isArray(itemId) ? itemId[0] : itemId;
  const item = itemData || state.items.find(i=>i.id===firstItemId);
  if(!item){ state.view='list'; render(); return; }

  if(state.storageMode !== 'cloud'){
    state._premiumReturnView='list';
    state.view='premium';
    render();
    return;
  }

  const warrantyDaysLeft = daysLeft(item.warrantyEnd);
  const hasWarrantyDate = !!item.warrantyEnd;
  const warrantyActive = warrantyDaysLeft !== null && warrantyDaysLeft >= 0;
  const warrantyExpired = hasWarrantyDate && warrantyDaysLeft !== null && warrantyDaysLeft < 0;
  const returnDeadline = effectiveReturnDeadline(item);
  const returnDaysLeft = daysLeft(returnDeadline);
  const hasReturnDate = !!returnDeadline;
  const returnActive = returnDaysLeft !== null && returnDaysLeft >= 0;
  const returnExpired = hasReturnDate && returnDaysLeft !== null && returnDaysLeft < 0;
  if(!hasWarrantyDate && !hasReturnDate){
    showAppDialog('Nėra termino', 'Šiam įrašui nėra datos, pagal kurią būtų galima siųsti priminimą.', '', {hideSupport:true, align:'center'});
    return;
  }

  // Opened from an item's page: show exactly what is saved (nothing saved = no rows).
  // Opened right after saving a new item: pre-fill suggested reminders.
  const editingExisting = state.view === 'detail';
  const suggested = warrantyActive ? suggestNotifDays(item?.warrantyMonths, returnActive) : [];
  // Editing an existing item should show its saved choices. New items use the last preference.
  const savedWarrantyDays = Array.isArray(item.notifyDays) ? item.notifyDays : null;
  const savedReturnDays = Array.isArray(item.notifyReturnDays) ? item.notifyReturnDays : null;
  const defaults = savedWarrantyDays || state._lastNotifDays || suggested;
  // Only offer reminders that can still fire (fewer days than are left); if none
  // survive, fall back to a sensible default instead of an empty or useless list.
  const fitDays = (arr, left, fallback) => {
    const ok = (arr||[]).filter(d => Number.isFinite(d) && d > 0 && d < left);
    if(editingExisting) return ok;
    return ok.length ? ok : (left > fallback ? [fallback] : (left > 1 ? [1] : []));
  };
  const savedOff = editingExisting && item.notifyEnabled === false;

  state.notifModal = {
    savedNote,
    itemId: firstItemId,
    itemIds: Array.isArray(itemId) ? itemId : [firstItemId],
    enabled: true,
    selectedDays: warrantyActive && !savedOff ? fitDays(editingExisting ? savedWarrantyDays : defaults, warrantyDaysLeft, 30) : [],
    returnSelectedDays: returnActive && !savedOff ? fitDays(editingExisting ? savedReturnDays : (savedReturnDays || state._lastReturnNotifDays || [3]), returnDaysLeft, 3) : [],
    hasWarranty: hasWarrantyDate,
    hasReturn: hasReturnDate,
    warrantyActive,
    returnActive,
    warrantyExpired,
    returnExpired,
    item,
  };
  if(!editingExisting) state.view='list';
  render();
}

function renderNotifModal(){
  const m = state.notifModal;
  if(!m) return '';
  const warrantyDays = Array.isArray(m.selectedDays) ? [...m.selectedDays].sort((a,b)=>b-a) : [];
  const returnDays = Array.isArray(m.returnSelectedDays) ? [...m.returnSelectedDays].sort((a,b)=>b-a) : [];
  const unitFor = d => d % 30 === 0 ? '30' : d % 7 === 0 ? '7' : '1';
  const amountFor = d => Math.max(1, Math.round(d / parseInt(unitFor(d), 10)));
  const rowHtml = (kind, days)=>days.map(day=>{
    const unit = unitFor(day);
    const amount = amountFor(day);
    return `<div class="notif-row" data-kind="${kind}" data-day="${day}" style="display:grid;grid-template-columns:76px 1fr 38px;gap:8px;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:10px;margin-bottom:8px">
      <input class="notif-amount" data-kind="${kind}" data-day="${day}" type="number" min="1" max="99" value="${amount}" inputmode="numeric" style="width:100%;height:40px;border:none;background:var(--bg);border-radius:10px;color:var(--text);font-size:16px;font-weight:700;text-align:center;padding:0 8px">
      <select class="notif-unit" data-kind="${kind}" data-day="${day}" style="width:100%;height:40px;border:none;background:var(--bg);border-radius:10px;color:var(--text);font-size:14px;font-weight:650;padding:0 10px">
        <option value="1" ${unit==='1'?'selected':''}>d. prieš</option>
        <option value="7" ${unit==='7'?'selected':''}>sav. prieš</option>
        <option value="30" ${unit==='30'?'selected':''}>mėn. prieš</option>
      </select>
      <button class="notif-remove" data-kind="${kind}" data-day="${day}" aria-label="Pašalinti priminimą" style="width:38px;height:38px;border:none;background:transparent;color:var(--text3);display:flex;align-items:center;justify-content:center"><i class="ti ti-x" style="font-size:20px"></i></button>
    </div>`;
  }).join('');
  const sectionHtml = ({kind, title, active, expired, days})=>{
    if(!active){
      return `<div style="margin-bottom:18px;opacity:.55">
        <div style="font-size:13px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">${title}</div>
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:14px;color:var(--text2);font-size:14px;line-height:1.35">
          ${expired ? 'Terminas jau pasibaigęs, todėl priminimų pridėti negalima.' : 'Šiam terminui data nenurodyta.'}
        </div>
        <button disabled style="width:100%;height:44px;border:1px solid var(--border2);background:transparent;color:var(--text3);border-radius:14px;font-size:15px;font-weight:750;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;opacity:.65">
          <i class="ti ti-plus"></i>Pridėti priminimą
        </button>
      </div>`;
    }
    return `<div style="margin-bottom:18px">
      <div style="font-size:13px;font-weight:800;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">${title}</div>
      ${rowHtml(kind, days)}
      <button id="${kind==='warranty'?'notifAddWarrantyBtn':'notifAddReturnBtn'}" style="width:100%;height:44px;border:1px solid var(--border2);background:transparent;color:var(--accent);border-radius:14px;font-size:15px;font-weight:750;display:flex;align-items:center;justify-content:center;gap:8px">
        <i class="ti ti-plus"></i>Pridėti priminimą
      </button>
    </div>`;
  };

  return `<div id="notifBackdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;display:flex;align-items:flex-end">
    <div id="notifSheet" style="background:var(--bg);border-radius:20px 20px 0 0;width:100%;padding:20px 20px 34px;max-height:85vh;overflow-y:auto;transition:transform .2s ease">
      <div id="notifGrab" style="padding:4px 0 16px;margin:-4px 0 4px;cursor:grab"><div style="width:36px;height:4px;background:var(--border2);border-radius:2px;margin:0 auto"></div></div>
      ${state.notifModal?.savedNote?`<div style="text-align:center;font-size:13px;font-weight:600;color:var(--green);margin:0 0 6px"><i class="ti ti-circle-check"></i> ${esc(state.notifModal.savedNote)}</div>`:''}
      <h3 style="font-size:19px;font-weight:750;margin:0 0 18px;text-align:center">Kada priminti?</h3>
      ${m.hasWarranty ? sectionHtml({kind:'warranty', title:'Garantija', active:m.warrantyActive, expired:m.warrantyExpired, days:warrantyDays}) : ''}
      ${m.hasReturn ? sectionHtml({kind:'return', title:'Grąžinimas', active:m.returnActive, expired:m.returnExpired, days:returnDays}) : ''}
      <button id="notifSaveBtn" class="save-btn">Išsaugoti</button>
    </div>
  </div>`;
}

// ── Contact form ────────────────────────────────────────────────────────────
// -- Premium privalumu ekranas ----------------------------------------------
function notifArray(kind){
  if(!state.notifModal) return [];
  return kind === 'return' ? state.notifModal.returnSelectedDays : state.notifModal.selectedDays;
}
function cleanNotifArray(arr){
  return [...new Set((arr||[])
    .map(n=>parseInt(n,10))
    .filter(n=>Number.isFinite(n) && n > 0 && n <= 365))]
    .sort((a,b)=>b-a);
}
function setNotifArray(kind, arr){
  if(!state.notifModal) return;
  if(kind === 'return') state.notifModal.returnSelectedDays = cleanNotifArray(arr);
  else state.notifModal.selectedDays = cleanNotifArray(arr);
}
function addNotifReminder(kind){
  const m = state.notifModal;
  if(!m) return;
  if(kind === 'warranty' && !m.warrantyActive) return;
  if(kind === 'return' && !m.returnActive) return;
  const presets = kind === 'warranty' ? [7,14,30,60,1,3] : [3,2,1,5,7];
  const arr = notifArray(kind);
  const next = presets.find(d=>!arr.includes(d)) || 1;
  setNotifArray(kind, [...arr, next]);
  render();
}
function removeNotifReminder(kind, day){
  const arr = [...notifArray(kind)];
  const idx = arr.indexOf(day);
  if(idx >= 0) arr.splice(idx, 1);
  setNotifArray(kind, arr);
  render();
}
function updateNotifReminder(kind, day, newDay){
  const arr = [...notifArray(kind)];
  const idx = arr.indexOf(day);
  if(idx >= 0) arr[idx] = newDay;
  setNotifArray(kind, arr);
  render();
}
function moveNotifReminder(kind, day, nextKind){
  if(kind === nextKind) return;
  const from = [...notifArray(kind)];
  const idx = from.indexOf(day);
  if(idx >= 0) from.splice(idx, 1);
  setNotifArray(kind, from);
  setNotifArray(nextKind, [...notifArray(nextKind), day]);
  render();
}

function renderPremium(){
  const feats = [
    { icon:'ti-bell-ringing', color:'var(--accent)', title:'Automatiniai priminimai',
      text:'Priminimai prieš garantijos pabaigą ir grąžinimo terminą — net kai programėlė uždaryta.' },
    { icon:'ti-cloud', color:'#3b9eff', title:'Galio saugykla',
      text:'Įrašai nepririšti prie vieno įrenginio ir gali veikti automatiniai priminimai.' },
    { icon:'ti-sparkles', color:'#f5a623', title:`${PREMIUM_MONTHLY_LIMIT} čekių atpažinimų per mėnesį`,
      text:`Nufotografuokite čekį – Galio pats užpildys prekes ir terminus. Iki ${PREMIUM_MONTHLY_LIMIT} atpažinimų ir ${PREMIUM_SEARCH_MONTHLY_LIMIT} gamintojo garantijos patikrinimų per mėnesį (nemokamai – ${AI_FREE_USES}).` },
    { icon:'ti-device-mobile', color:'#34c759', title:'Prieiga iš visų įrenginių',
      text:'Prarastas ar pakeistas įrenginys — jūsų garantijos nedingsta kartu su juo.' },
  ];
  return `<div>
    <div class="page-header-sm">
      <button class="back-btn" id="premiumBackBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>Galio Premium</h2>
      <div style="width:36px"></div>
    </div>
    <div style="padding:24px 20px;text-align:center">
      <div style="width:72px;height:72px;margin:0 auto 16px;background:var(--accent-bg);border-radius:20px;display:flex;align-items:center;justify-content:center">
        <i class="ti ti-crown" style="font-size:38px;color:var(--accent)"></i>
      </div>
      <h3 style="font-size:22px;font-weight:700;margin:0 0 8px">Priminimai ir dokumentai vienoje vietoje</h3>
      <p style="font-size:15px;color:var(--text2);margin:0;line-height:1.5">Premium atrakina Galio saugyklą, automatinius priminimus ir daugiau AI analizių.</p>
    </div>
    <div style="padding:0 16px">
      ${feats.map(f=>`
        <div style="display:flex;gap:14px;padding:16px;background:var(--bg2);border-radius:var(--radius);margin-bottom:12px">
          <div style="width:44px;height:44px;flex-shrink:0;background:var(--bg3);border-radius:12px;display:flex;align-items:center;justify-content:center">
            <i class="ti ${f.icon}" style="font-size:22px;color:${f.color}"></i>
          </div>
          <div>
            <div style="font-size:16px;font-weight:600;margin-bottom:3px">${f.title}</div>
            <div style="font-size:14px;color:var(--text2);line-height:1.4">${f.text}</div>
          </div>
        </div>`).join('')}
    </div>
    <div style="height:16px"></div>
    <div style="position:sticky;bottom:0;z-index:5;padding:14px 16px 16px;background:var(--bg);border-top:0.5px solid var(--border);box-shadow:0 -8px 16px rgba(0,0,0,.18)">
      ${renderPremiumBuy()}
    </div>
  </div>`;
}

// -- Google Play Billing (Digital Goods API, works inside the Android app) ----
const PLAY_BILLING_METHOD = 'https://play.google.com/billing';
const PLAY_PRODUCTS = ['galio_premium_monthly','galio_premium_yearly'];
const VERIFY_PURCHASE_URL = 'https://europe-west1-garantijos-4f397.cloudfunctions.net/verifyPlayPurchase';
const PLAY_SUBS_URL = 'https://play.google.com/store/account/subscriptions?package=com.galio.app';

async function getPlayBillingService(){
  if(!('getDigitalGoodsService' in window)) return null;
  try{ return await window.getDigitalGoodsService(PLAY_BILLING_METHOD); }catch(e){ return null; }
}
function formatPlayPrice(p){
  try{ return new Intl.NumberFormat('lt-LT',{style:'currency',currency:p.currency}).format(Number(p.value)); }
  catch(e){ return `${p.value} ${p.currency}`; }
}
function playPeriodLabel(iso){ return iso==='P1Y' ? 'per metus' : iso==='P1M' ? 'per mėnesį' : ''; }

async function loadPlayProducts(){
  if(state.play?.loading || state.play?.loaded) return;
  state.play = {loading:true};
  const svc = await getPlayBillingService();
  let products = [], diag = '';
  if(svc){
    try{
      const details = await svc.getDetails(PLAY_PRODUCTS);
      diag = `getDetails: ${details.length} (${details.map(d=>d.itemId).join(',')||'-'})`;
      products = details
        .map(d=>({sku:d.itemId, price:formatPlayPrice(d.price), period:d.subscriptionPeriod||''}))
        .sort((a,b)=>PLAY_PRODUCTS.indexOf(a.sku)-PLAY_PRODUCTS.indexOf(b.sku));
    }catch(e){ console.warn('Play getDetails failed', e); diag = `getDetails klaida: ${e?.name||''} ${e?.message||e}`; }
  }
  state.play = {loading:false, loaded:true, available:!!svc, products, busy:false, diag};
  if(state.view==='premium') render();
}

function renderPremiumBuy(){
  if(isPremiumUser() && state.userDoc?.planSource==='promo'){
    const exp = state.userDoc?.premiumExpiresAt?.toDate?.();
    if(!exp) return `<button class="save-btn" disabled><i class="ti ti-crown"></i> Premium neribotai</button>
      <p style="font-size:12px;color:var(--text3);text-align:center;margin:10px 0 0">Premium suteiktas kodu ir nesibaigia.</p>`;
    return `<button class="save-btn" disabled><i class="ti ti-crown"></i> Premium iki ${exp.toLocaleDateString('lt-LT')}</button>
      <p style="font-size:12px;color:var(--text3);text-align:center;margin:10px 0 0">Premium suteiktas kodu. Turite dar vieną kodą? Jis pratęs laiką.</p>${renderPromoRedeem()}`;
  }
  if(isPremiumUser()){
    const purchased = state.userDoc?.planSource==='purchase';
    return `<button class="save-btn" disabled><i class="ti ti-crown"></i> Jūs jau Premium narys</button>
      ${purchased?`<p style="font-size:13px;text-align:center;margin:10px 0 0"><a href="${PLAY_SUBS_URL}" target="_blank" rel="noopener" style="color:var(--accent)">Valdyti prenumeratą Google Play</a></p>`:''}`;
  }
  const play = state.play;
  if(!play || play.loading){
    if(!play) setTimeout(loadPlayProducts, 0);
    return `<button class="save-btn" disabled>Kraunama...</button>`;
  }
  if(!play.available){
    return `<button class="save-btn" disabled>Premium – Android programėlėje</button>
      <p style="font-size:12px;color:var(--text3);text-align:center;margin:10px 0 0">Premium prenumeratą galima įsigyti Galio programėlėje iš Google Play. Ją įsigijus, Premium veiks ir čia, prisijungus ta pačia paskyra.</p>${renderPromoRedeem()}`;
  }
  if(!play.products.length){
    return `<button class="save-btn" disabled>Premium šiuo metu nepasiekiamas</button>
      <p style="font-size:12px;color:var(--text3);text-align:center;margin:10px 0 0">Nepavyko gauti kainų iš Google Play. Patikrinkite ryšį ir bandykite vėliau.</p>
      <p style="font-size:10px;color:var(--text3);text-align:center;margin:4px 0 0;opacity:.7">${esc(play.diag||'')}</p>${renderPromoRedeem()}`;
  }
  const busy = play.busy;
  return play.products.map((p,i)=>`
      <button class="save-btn play-buy-btn" data-sku="${p.sku}" ${busy?'disabled':''} style="${i>0?'margin-top:10px;background:var(--bg2);color:var(--text)':''}">
        ${busy?'Vykdoma...':`${p.price} ${playPeriodLabel(p.period)}`}
      </button>`).join('')+`
      <p style="font-size:12px;color:var(--text3);text-align:center;margin:10px 0 0">Prenumerata atsinaujina automatiškai. Atšaukti galite bet kada Google Play nustatymuose.</p>
      <p style="font-size:13px;text-align:center;margin:6px 0 0"><button id="playRestoreBtn" style="background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer">Atkurti pirkimą</button></p>${renderPromoRedeem()}`;
}

async function verifyPurchaseToken(purchaseToken){
  if(!purchaseToken) return {ok:false, error:'Negautas pirkimo patvirtinimas'};
  const {ok, data} = await callFunction('verifyPlayPurchase', {purchaseToken});
  return {ok: ok && !!data.ok, error: data.error || 'Nepavyko patikrinti pirkimo'};
}

async function buyPremium(sku){
  if(!state.user || state.play?.busy) return;
  if(!state.online){
    offlineDialog('Pirkimui reikia interneto','Prenumeratą galėsite įsigyti, kai bus interneto ryšys.');
    return;
  }
  state.play.busy = true; render();
  try{
    const request = new PaymentRequest(
      [{supportedMethods: PLAY_BILLING_METHOD, data: {sku}}],
      {total: {label: 'Galio Premium', amount: {currency: 'EUR', value: '0'}}}
    );
    const response = await request.show();
    const result = await verifyPurchaseToken(response.details?.purchaseToken);
    await response.complete(result.ok ? 'success' : 'fail');
    if(result.ok){
      toast('✓ Premium įjungtas. Ačiū!', 5000);
    }else{
      showAppDialog('Pirkimas nepatvirtintas', `${result.error}. Jei pinigai nuskaičiuoti, paspauskite „Atkurti pirkimą“ arba parašykite mums.`, '', {});
    }
  }catch(e){
    if(e?.name !== 'AbortError'){ console.warn('Purchase failed', e); toast('Pirkimas nepavyko – bandykite dar kartą'); }
  }
  state.play.busy = false; render();
}

// Re-links a Play subscription to this account (new phone, reinstall, or a purchase
// whose confirmation was interrupted). Silent unless something is restored.
async function restorePlayPurchases(manual=false){
  if(!state.user || (!manual && isPremiumUser())) return;
  const svc = await getPlayBillingService();
  if(!svc){ if(manual) toast('Atkurti galima tik Android programėlėje'); return; }
  try{
    const purchases = await svc.listPurchases();
    for(const p of purchases){
      if(!PLAY_PRODUCTS.includes(p.itemId)) continue;
      const r = await verifyPurchaseToken(p.purchaseToken);
      if(r.ok){ toast('✓ Premium atkurtas'); return; }
      if(manual){ showAppDialog('Nepavyko atkurti', r.error, '', {}); return; }
    }
    if(manual) toast('Aktyvios prenumeratos nerasta');
  }catch(e){
    console.warn('Restore failed', e);
    if(manual) toast('Nepavyko atkurti – bandykite vėliau');
  }
}

function renderContact(){
  const busy = state.contactBusy;
  const sent = state.contactSent;
  return `<div>
    <div class="page-header-sm"><button class="back-btn" id="contactBackBtn"><i class="ti ti-arrow-left"></i></button><h2>Susisiekti su pagalba</h2></div>
    ${sent ? `
    <div style="padding:48px 24px;text-align:center">
      <i class="ti ti-circle-check" style="font-size:48px;color:var(--green)"></i>
      <p style="font-size:16px;font-weight:600;margin:16px 0 8px">Žinutė išsiųsta!</p>
      <p style="font-size:14px;color:var(--text2);margin:0 0 24px">Atsakysime į <strong>${state.user?.email||''}</strong> kuo greičiau.</p>
      <div style="display:flex;justify-content:center">
        <button class="save-btn" id="contactBackBtn2" style="width:auto;max-width:260px;padding:16px 32px;margin:0">Grįžti</button>
      </div>
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
      <button id="contactSendBtn" class="save-btn" style="margin:0" ${busy?'disabled':''}>
        ${busy ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;margin:0 auto"></span>' : '<i class="ti ti-send"></i> Siųsti'}
      </button>
    </div>
    `}
  </div>`;
}

function renderAppDialog(){
  const d = state.appDialog;
  if(!d) return '';
  const isSingleAction = d.hideSupport;
  const textAlign = d.align === 'center' ? 'center' : 'left';
  const actionWrapStyle = isSingleAction
    ? 'display:flex;justify-content:center'
    : 'display:grid;grid-template-columns:1fr 1fr;gap:10px';
  const buttonBase = 'height:48px;min-height:48px;border-radius:12px;padding:0 14px;font-size:15px;font-weight:700;box-sizing:border-box;display:flex;align-items:center;justify-content:center;margin:0;line-height:1';
  const supportBtn = d.hideSupport ? '' : `<button id="appDialogSupportBtn" style="${buttonBase};width:100%;background:none;border:1px solid var(--border2);color:var(--text)">${esc(d.supportText || 'Susisiekti')}</button>`;
  const okBtnStyle = isSingleAction
    ? `${buttonBase};width:100%;max-width:260px`
    : `${buttonBase};width:100%`;
  return `<div class="warranty-sheet" id="appDialog">
    <div class="warranty-overlay"></div>
    <div class="warranty-panel" style="box-sizing:border-box;padding-left:20px;padding-right:20px">
      <div class="warranty-handle"></div>
      <div class="warranty-title">${esc(d.title||'Pranešimas')}</div>
      <p style="font-size:14px;color:var(--text2);line-height:1.45;margin:0 0 18px;text-align:${textAlign};white-space:pre-line;word-break:break-word">${esc(d.message||'')}</p>
      <div style="${actionWrapStyle}">
        ${supportBtn}
        <button id="appDialogOkBtn" class="save-btn" style="${okBtnStyle}">${d.okText || 'Gerai'}</button>
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
      <div style="display:flex;gap:12px;align-items:flex-start;margin:4px 16px 0;padding:12px 14px;border-radius:var(--radius);background:var(--bg2)">
        <i class="ti ti-camera" style="font-size:20px;color:var(--accent);flex-shrink:0;margin-top:1px"></i>
        <div style="font-size:13px;color:var(--text2);line-height:1.4">Išsaugoję atidarykite daiktą ir paspauskite <b style="color:var(--text)">„Pridėti daikto nuotrauką“</b> – ji bus rodoma sąraše, kad daiktą atpažintumėte iš karto.</div>
      </div>
    </div>
    <div class="fixed-bar" style="position:fixed;bottom:65px;left:0;right:0;padding:10px 16px;background:var(--bg);border-top:0.5px solid var(--border);z-index:50;display:flex;gap:10px;align-items:center">
      <button id="multiCancelBtn" style="background:none;border:1px solid var(--border2);color:var(--text3);font-size:14px;padding:10px 16px;border-radius:12px;cursor:pointer;flex-shrink:0">Atšaukti</button>
      <button id="multiSaveBtn" ${selectedCount===0||state.multiSaving?'disabled':''} class="save-btn" style="flex:1;opacity:${selectedCount===0?'0.4':'1'}">
        ${state.multiSaving?'Saugoma...':`Išsaugoti${selectedCount>0?` (${selectedCount})`:''}`}
      </button>
    </div>
  </div>`;
}


// ── Admin statistics ──────────────────────────────────────────────────────
const ADMIN_DAY = 86400000;
function adminAgo(t){
  if(!t) return 'niekada';
  const d = (Date.now()-t)/ADMIN_DAY;
  if(d < 1/24) return 'ką tik';
  if(d < 1) return `prieš ${Math.floor(d*24)} val.`;
  if(d < 45) return `prieš ${Math.floor(d)} d.`;
  return new Date(t).toLocaleDateString('lt-LT');
}
const adminPct = (a,b) => b ? Math.round(a*100/b) : 0;
const adminDayKey = t => { const d=new Date(t); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

// Every number on the admin screen comes from here. Admin accounts are left out so our
// own testing does not inflate the figures.
function adminSlices(all, rangeDays){
  const now = Date.now();
  const users = all.filter(u => u.role !== 'admin');
  const n = users.length;
  const within = (t, days) => t && now - t <= days*ADMIN_DAY;
  const kind = u => premiumKind(u);
  const paying = users.filter(u => kind(u)==='purchased');
  const monthKey = new Date().toISOString().slice(0,7);

  // sign-ups per day for the chosen range
  const days = [];
  for(let i = rangeDays-1; i >= 0; i--){ const t = now - i*ADMIN_DAY; days.push({key: adminDayKey(t), t, n: 0}); }
  const byKey = new Map(days.map(d => [d.key, d]));
  users.forEach(u => { const d = u.createdMs && byKey.get(adminDayKey(u.createdMs)); if(d) d.n++; });

  // weekly cohorts (Monday start), newest first
  const monday = t => { const d = new Date(t); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay()+6)%7)); return d.getTime(); };
  const thisMonday = monday(now);
  const cohorts = [];
  for(let w = 0; w < 6; w++){
    const from = thisMonday - w*7*ADMIN_DAY, to = from + 7*ADMIN_DAY;
    const c = users.filter(u => u.createdMs >= from && u.createdMs < to);
    cohorts.push({ from, n: c.length,
      withItems: c.filter(u => u.itemCount > 0).length,
      active7: c.filter(u => within(u.lastActiveMs, 7)).length,
      premium: c.filter(u => kind(u) !== 'free').length });
  }

  const items = users.map(u => u.itemCount||0);
  const withItems = items.filter(x => x > 0).sort((a,b)=>a-b);
  return {
    n,
    active1: users.filter(u => within(u.lastActiveMs, 1)).length,
    active7: users.filter(u => within(u.lastActiveMs, 7)).length,
    active30: users.filter(u => within(u.lastActiveMs, 30)).length,
    newRange: users.filter(u => within(u.createdMs, rangeDays)).length,
    paying: paying.length,
    payingMonthly: paying.filter(u => u.playProductId==='galio_premium_monthly').length,
    payingYearly: paying.filter(u => u.playProductId==='galio_premium_yearly').length,
    premiumAll: users.filter(u => kind(u) !== 'free').length,
    promo: users.filter(u => kind(u)==='promo').length,
    manual: users.filter(u => kind(u)==='manual').length,
    lapsed: users.filter(u => u.plan!=='premium' && u.premiumDowngradeRequired).length,
    days, cohorts,
    buckets: [
      ['Šiandien (24 val.)', users.filter(u => within(u.lastActiveMs, 1)).length],
      ['Per 2–7 d.', users.filter(u => u.lastActiveMs && !within(u.lastActiveMs, 1) && within(u.lastActiveMs, 7)).length],
      ['Per 8–30 d.', users.filter(u => u.lastActiveMs && !within(u.lastActiveMs, 7) && within(u.lastActiveMs, 30)).length],
      ['Seniau nei 30 d.', users.filter(u => u.lastActiveMs && !within(u.lastActiveMs, 30)).length],
      ['Nežinoma', users.filter(u => !u.lastActiveMs).length],
    ],
    funnel: [
      ['Užsiregistravo', n],
      ['Patvirtino el. paštą', users.filter(u => u.emailVerified).length],
      ['Pridėjo bent 1 įrašą', withItems.length],
      ['Turi 5+ įrašų', users.filter(u => u.itemCount >= 5).length],
      ['Turi Premium', users.filter(u => kind(u) !== 'free').length],
      ['Moka', paying.length],
    ],
    splits: [
      ['Prisijungia per Google', users.filter(u => (u.providers||[]).includes('google.com')).length],
      ['Saugo Galio saugykloje', users.filter(u => u.storageMode==='cloud').length],
      ['Įjungti push pranešimai', users.filter(u => u.hasPush).length],
      ['Išnaudojo nemokamas AI', users.filter(u => kind(u)==='free' && u.aiUsesRemaining===0).length],
      ['Nė karto nenaudojo AI', users.filter(u => kind(u)==='free' && u.aiUsesRemaining===AI_FREE_USES).length],
      ['Įjungtas senų įrašų trynimas', users.filter(u => u.keepExpiredMonths > 0).length],
    ],
    totalItems: items.reduce((a,b)=>a+b, 0),
    medianItems: withItems.length ? withItems[Math.floor(withItems.length/2)] : 0,
    maxItems: withItems.length ? withItems[withItems.length-1] : 0,
    aiPremiumMonth: users.filter(u => u.aiMonthKey===monthKey).reduce((a,u)=>a+(u.aiMonthCount||0), 0),
  };
}

function adminTile(n, label, sub='', color=''){
  return `<div class="stat-tile" style="text-align:left;padding:12px 14px">
    <div class="n"${color?` style="color:${color}"`:''}>${n}</div>
    <div class="l">${label}</div>
    ${sub?`<div style="font-size:12px;color:var(--text3);margin-top:2px">${sub}</div>`:''}
  </div>`;
}
// Horizontal bars, one hue: the label and number are text, the bar only shows the size.
function adminBars(rows, total){
  const max = Math.max(1, ...rows.map(r => r[1]));
  return rows.map(([label, v]) => `<div style="padding:9px 14px">
    <div style="display:flex;justify-content:space-between;gap:10px;font-size:14px;margin-bottom:5px">
      <span style="color:var(--text)">${label}</span>
      <span style="color:var(--text2);font-variant-numeric:tabular-nums;white-space:nowrap"><b style="color:var(--text)">${v}</b>${total?` · ${adminPct(v,total)}%`:''}</span>
    </div>
    <div style="height:8px;border-radius:4px;background:var(--bg3);overflow:hidden">
      <div style="height:100%;width:${Math.max(v?2:0, v*100/max)}%;background:var(--accent);border-radius:4px"></div>
    </div>
  </div>`).join('');
}
// Sign-ups per day as columns; tapping a column shows its date and count.
function adminColumns(days){
  const max = Math.max(1, ...days.map(d => d.n));
  const fmt = t => new Date(t).toLocaleDateString('lt-LT', {month:'2-digit', day:'2-digit'});
  const gap = days.length > 45 ? 1 : 2;
  return `<div style="padding:14px 14px 10px">
    <div style="display:flex;align-items:flex-end;gap:${gap}px;height:120px;border-bottom:1px solid var(--border)">
      ${days.map(d => `<button class="admin-col" data-tip="${fmt(d.t)}: ${d.n} registr." title="${fmt(d.t)}: ${d.n}" style="flex:1;min-width:0;height:100%;padding:0;border:none;background:none;display:flex;align-items:flex-end;cursor:pointer">
        <span style="display:block;width:100%;height:${d.n ? Math.max(4, d.n*100/max) : 0}%;background:var(--accent);border-radius:3px 3px 0 0"></span>
      </button>`).join('')}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-top:6px">
      <span>${fmt(days[0].t)}</span><span>daugiausia per dieną: ${max}</span><span>${fmt(days[days.length-1].t)}</span>
    </div>
  </div>`;
}

function renderAdminStats(mode='stats'){
  const s = state.adminStats;
  const users = state.adminUsers || [];
  const range = state.adminRange || 30;
  const adminSearch = (state.adminSearch || '').trim().toLowerCase();
  const adminPlanFilter = state.adminPlanFilter || 'all';
  const adminSort = state.adminSort || 'active';
  const now = Date.now();
  const byEmail = (a,b) => String(a.email||'').localeCompare(String(b.email||''), 'lt');
  const filteredUsers = users
    .filter(u => {
      const kind = premiumKind(u);
      const haystack = `${u.email||''} ${u.uid||''} ${u.plan||''} ${u.planSource||''} ${u.role||''} ${u.storageMode||''}`.toLowerCase();
      const matchesSearch = !adminSearch || haystack.includes(adminSearch);
      const matchesFilter =
        adminPlanFilter === 'all' ||
        (adminPlanFilter === 'active7' && u.lastActiveMs && now-u.lastActiveMs <= 7*ADMIN_DAY) ||
        (adminPlanFilter === 'inactive30' && (!u.lastActiveMs || now-u.lastActiveMs > 30*ADMIN_DAY)) ||
        (adminPlanFilter === 'new7' && u.createdMs && now-u.createdMs <= 7*ADMIN_DAY) ||
        (adminPlanFilter === 'premium' && kind !== 'free' && kind !== 'admin') ||
        (adminPlanFilter === 'purchased' && kind === 'purchased') ||
        (adminPlanFilter === 'manual' && (kind === 'manual' || kind === 'promo')) ||
        (adminPlanFilter === 'free' && kind === 'free') ||
        (adminPlanFilter === 'noitems' && !u.itemCount) ||
        (adminPlanFilter === 'admin' && kind === 'admin') ||
        (adminPlanFilter === 'cloud' && u.storageMode === 'cloud');
      return matchesSearch && matchesFilter;
    })
    .sort((a,b) => {
      if(adminSort === 'active') return (b.lastActiveMs||0) - (a.lastActiveMs||0) || byEmail(a,b);
      if(adminSort === 'new') return (b.createdMs||0) - (a.createdMs||0) || byEmail(a,b);
      if(adminSort === 'items') return (b.itemCount||0) - (a.itemCount||0) || byEmail(a,b);
      if(adminSort === 'plan') return premiumKind(a).localeCompare(premiumKind(b), 'lt') || byEmail(a,b);
      return byEmail(a,b);
    });
  const filterOptions = [
    ['all','Visi'], ['active7','Aktyvūs 7 d.'], ['new7','Nauji 7 d.'], ['inactive30','Neaktyvūs 30+ d.'],
    ['purchased','Moka'], ['premium','Premium'], ['manual','Suteikti'], ['free','Nemokami'],
    ['noitems','Be įrašų'], ['cloud','Debesyje'], ['admin','Admin'],
  ];
  const sortOptions = [
    ['active','Paskutinis aktyvumas'], ['new','Naujausi'], ['items','Įrašų kiekis'], ['plan','Planas'], ['email','El. paštas'],
  ];
  const head = `<div class="page-header-sm">
      <button class="back-btn" id="adminBackBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>Admin valdymas</h2>
      <button class="back-btn" id="adminRefreshBtn" title="Atnaujinti"><i class="ti ti-refresh"></i></button>
    </div>`;
  if(!s) return `<div>${head}<div class="empty-state"><div class="spinner" style="margin:0 auto"></div><p style="margin-top:16px">Kraunama...</p></div></div>`;
  const fmtDate = t => t ? new Date(t).toLocaleDateString('lt-LT') : '—';
  if(mode==='users') return `<div>
    <div class="page-header-sm">
      <button class="back-btn" id="adminUsersBackBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>Vartotojai</h2>
      <div style="width:36px"></div>
    </div>
    <div style="height:12px"></div>
    <div class="form-section" style="margin:0 16px 12px;padding:12px">
      <div style="display:flex;align-items:center;gap:10px;background:var(--bg);border-radius:12px;padding:10px 12px;margin-bottom:10px">
        <i class="ti ti-search" style="font-size:18px;color:var(--text3);flex-shrink:0"></i>
        <input id="adminUserSearch" value="${esc(state.adminSearch||'')}" placeholder="Ieškoti pagal el. paštą, UID, planą" style="width:100%;background:none;border:none;outline:none;color:var(--text);font-size:15px;min-width:0" />
      </div>
      <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;margin-bottom:10px">
        ${filterOptions.map(([value,label])=>`<button class="chip${adminPlanFilter===value?' active':''}" data-admin-filter="${value}" style="flex-shrink:0">${label}</button>`).join('')}
      </div>
      <select id="adminSortSelect" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:12px;color:var(--text);font-size:15px;padding:10px 12px;outline:none">
        ${sortOptions.map(([value,label])=>`<option value="${value}" ${adminSort===value?'selected':''}>Rikiuoti: ${label}</option>`).join('')}
      </select>
      <div style="font-size:13px;color:var(--text3);margin-top:10px">${filteredUsers.length} iš ${users.length} paskyrų</div>
    </div>
    <div class="form-section" style="margin:0 16px 16px;padding:0">
      ${filteredUsers.length===0 ? `<div style="padding:18px;text-align:center;color:var(--text3);font-size:14px">Nieko nerasta</div>` :
        filteredUsers.map(u => {
          const kind = premiumKind(u);
          const planLabel = kind==='purchased' ? `Moka · ${u.playProductId==='galio_premium_yearly'?'metinis':'mėnesinis'}` : kind==='promo' ? 'Premium · kodas' : kind==='manual' ? 'Premium · suteiktas' : kind==='admin' ? 'Admin' : 'Nemokamas';
          const planColor = kind==='purchased' ? 'var(--gold)' : (kind==='promo' || kind==='manual') ? 'var(--accent)' : kind==='admin' ? 'var(--green)' : 'var(--text3)';
          const isPremiumPlan = kind==='purchased' || kind==='manual' || kind==='promo';
          const isAdminUser = u.role==='admin';
          const how = (u.providers||[]).includes('google.com') ? 'Google' : 'el. paštas';
          const aiInfo = kind==='free' && u.aiUsesRemaining!==null ? ` · AI liko ${u.aiUsesRemaining}/${AI_FREE_USES}` : '';
          return `<div class="settings-row tappable admin-user" data-uid="${esc(u.uid)}" style="flex-direction:column;align-items:stretch;gap:10px;padding:14px 14px;cursor:pointer">
            <div style="display:flex;width:100%;align-items:flex-start;gap:10px">
              <div style="flex:1;min-width:0">
                <div style="font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.email)}</div>
                <div style="font-size:14px;color:${planColor};margin-top:3px;font-weight:600">${planLabel}${isAdminUser && kind!=='admin'?' · Administratorius':''}${u.premiumExpiresMs&&isPremiumPlan?` <span style="color:var(--text3);font-weight:400">iki ${fmtDate(u.premiumExpiresMs)}</span>`:''}</div>
                <div style="font-size:13px;color:var(--text2);margin-top:4px">Aktyvus ${adminAgo(u.lastActiveMs)} · registr. ${fmtDate(u.createdMs)}</div>
                <div style="font-size:12px;color:var(--text3);margin-top:3px;line-height:1.35">${u.itemCount||0} įrašų · ${u.storageMode==='cloud'?'saugykloje':'įrenginyje'} · ${how}${u.emailVerified?'':' · nepatvirtintas'}${u.hasPush?' · push':''}${aiInfo} · ID ${esc((u.uid||'').slice(0,8))}</div>
              </div>
              <i class="ti ti-chevron-right" style="color:var(--text3);font-size:16px;margin-top:2px"></i>
            </div>
          </div>`;
        }).join('')
      }
    </div>
    ${renderAdminUserSheet()}
  </div>`;
  const x = adminSlices(users, range);
  const section = (t, sub='') => `<p class="form-label-section" style="margin:4px 16px 8px">${t}${sub?` <span style="text-transform:none;letter-spacing:0;font-weight:400;color:var(--text3)">· ${sub}</span>`:''}</p>`;

  return `<div>
    ${head}
    <div style="font-size:12px;color:var(--text3);margin:10px 16px 0">Be administratorių paskyrų · atnaujinta ${new Date(s.generatedAt).toLocaleTimeString('lt-LT',{hour:'2-digit',minute:'2-digit'})}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px 16px 16px">
      ${adminTile(x.n, 'Vartotojų', `+${x.newRange} per ${range} d.`)}
      ${adminTile(x.active7, 'Aktyvūs per 7 d.', `${adminPct(x.active7,x.n)}% visų`, 'var(--accent)')}
      ${adminTile(x.active1, 'Aktyvūs šiandien', `per 30 d.: ${x.active30}`)}
      ${adminTile(x.paying, 'Moka', `${x.payingMonthly} mėn. · ${x.payingYearly} metų · ${adminPct(x.paying,x.n)}%`, 'var(--gold)')}
      ${adminTile(x.premiumAll, 'Premium iš viso', `kodu ${x.promo} · suteikta ${x.manual}`)}
      ${adminTile(x.totalItems, 'Įrašų', `mediana ${x.medianItems} · daugiausia ${x.maxItems}`)}
    </div>

    ${section('Registracijos', 'palieskite stulpelį')}
    <div style="display:flex;gap:8px;margin:0 16px 8px">
      ${[7,30,90].map(d => `<button class="chip${range===d?' active':''}" data-admin-range="${d}">${d} d.</button>`).join('')}
    </div>
    <div class="form-section" style="margin:0 16px 16px">${adminColumns(x.days)}</div>

    ${section('Kada paskutinį kartą naudojo')}
    <div class="form-section" style="margin:0 16px 16px;padding:4px 0">${adminBars(x.buckets, x.n)}</div>

    ${section('Kelias iki mokėjimo', '% nuo visų')}
    <div class="form-section" style="margin:0 16px 16px;padding:4px 0">${adminBars(x.funnel, x.n)}</div>

    ${section('Savaitinės grupės', 'pagal registracijos savaitę')}
    <div class="form-section" style="margin:0 16px 16px;overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums">
        <thead><tr style="color:var(--text3);text-align:right">
          <th style="text-align:left;padding:10px 14px 6px;font-weight:600">Savaitė nuo</th><th style="padding:10px 6px 6px;font-weight:600">Nauji</th><th style="padding:10px 6px 6px;font-weight:600">Su įrašais</th><th style="padding:10px 6px 6px;font-weight:600">Aktyvūs 7 d.</th><th style="padding:10px 14px 6px 6px;font-weight:600">Premium</th>
        </tr></thead>
        <tbody>${x.cohorts.map(c => `<tr style="border-top:0.5px solid var(--border);text-align:right">
          <td style="text-align:left;padding:9px 14px">${new Date(c.from).toLocaleDateString('lt-LT',{month:'2-digit',day:'2-digit'})}</td>
          <td style="padding:9px 6px;font-weight:600">${c.n}</td>
          <td style="padding:9px 6px">${c.n?`${adminPct(c.withItems,c.n)}%`:'—'}</td>
          <td style="padding:9px 6px">${c.n?`${adminPct(c.active7,c.n)}%`:'—'}</td>
          <td style="padding:9px 14px 9px 6px">${c.n?`${adminPct(c.premium,c.n)}%`:'—'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>

    ${section('Įpročiai')}
    <div class="form-section" style="margin:0 16px 8px;padding:4px 0">${adminBars(x.splits, x.n)}</div>
    <div style="font-size:12px;color:var(--text3);margin:0 20px 16px;line-height:1.4">Premium AI analizių šį mėnesį: ${x.aiPremiumMonth}. Premium kodų: ${s.promo?.used||0} panaudota iš ${s.promo?.total||0}${s.promo?.revoked?`, atšaukta ${s.promo.revoked}`:''}. Premium nepratęsė: ${x.lapsed}.</div>

    ${section('Įrankiai')}
    <div class="form-section" style="margin:0 16px 10px;padding:0">
      <button class="settings-row tappable" id="adminUsersBtn" style="width:100%;background:none;border:none;text-align:left;color:inherit">
        <i class="ti ti-users row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Vartotojai<small>${users.length} paskyros · paieška, filtrai, kortelės</small></span><i class="ti ti-chevron-right" style="color:var(--text3)"></i>
      </button>
      <button class="settings-row tappable" id="adminPromoBtn" style="width:100%;background:none;border:none;text-align:left;color:inherit">
        <i class="ti ti-ticket row-icon" style="color:var(--gold)"></i><span class="settings-row-label">Premium kodai<small>${state.promoCodes ? `${state.promoCodes.filter(c=>!c.usedBy&&!c.revokedAt).length} laisvi · ${state.promoCodes.filter(c=>c.usedBy).length} panaudoti` : 'Kurti ir valdyti kodus'}</small></span><i class="ti ti-chevron-right" style="color:var(--text3)"></i>
      </button>
    </div>
    <div class="form-section" style="margin:0 16px 16px;padding:0">
      <button class="settings-row tappable" id="adminTestNotifBtn" style="width:100%;background:none;border:none;text-align:left">
        <i class="ti ti-bell-ringing row-icon" style="color:var(--accent)"></i><span class="settings-row-label">Testuoti garantijos priminimą<small>Sukuria laikiną įrašą (terminas rytoj) ir patikrina visą grandinę</small></span>
      </button>
    </div>

  </div>`;
}

function renderAdminUserSheet(){
  const u = (state.adminUsers||[]).find(x => x.uid === state.adminUserSheet);
  if(!u) return '';
  const kind = premiumKind(u);
  const fmtDT = t => t ? new Date(t).toLocaleString('lt-LT', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
  const plan = kind==='purchased' ? `Moka · ${u.playProductId==='galio_premium_yearly'?'metinis':'mėnesinis'}` : kind==='promo' ? 'Premium · kodas' : kind==='manual' ? 'Premium · suteiktas' : kind==='admin' ? 'Administratorius' : 'Nemokamas';
  const rows = [
    ['Planas', plan + (u.premiumExpiresMs && kind==='promo' ? ` (iki ${new Date(u.premiumExpiresMs).toLocaleDateString('lt-LT')})` : '')],
    ['Paskutinį kartą aktyvus', `${adminAgo(u.lastActiveMs)}`],
    ['Paskutinis prisijungimas', fmtDT(u.lastSignInMs)],
    ['Užsiregistravo', fmtDT(u.createdMs)],
    ['Įrašų', String(u.itemCount||0)],
    ['Saugojimas', u.storageMode==='cloud' ? 'Galio saugykla' : 'Įrenginyje'],
    ['Prisijungimo būdas', (u.providers||[]).includes('google.com') ? 'Google' : 'El. paštas'],
    ['El. paštas patvirtintas', u.emailVerified ? 'Taip' : 'Ne'],
    ['Push pranešimai', u.hasPush ? 'Įjungti' : 'Ne'],
    ['AI', kind==='free' ? (u.aiUsesRemaining===null ? '—' : `liko ${u.aiUsesRemaining}/${AI_FREE_USES}`) : `šį mėn. ${u.aiMonthKey===new Date().toISOString().slice(0,7)?u.aiMonthCount:0}`],
    ['ID', u.uid],
  ];
  const action = kind==='admin' || u.role==='admin' ? ''
    : kind==='purchased' ? `<p style="font-size:13px;color:var(--text3);margin:4px 20px 8px">Mokamą Premium valdo Google Play.</p>`
    : `<div style="padding:8px 20px 4px"><button class="save-btn" data-uid="${esc(u.uid)}" data-action="togglePremium" style="margin:0;${kind==='free'?'':'background:none;border:1px solid var(--red);color:var(--red)'}">${kind==='free' ? 'Suteikti Premium' : 'Nuimti Premium'}</button></div>`;
  return `<div class="warranty-sheet center-sheet" id="adminUserSheet">
    <div class="warranty-overlay" id="adminUserOverlay"></div>
    <div class="warranty-panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 12px 8px 20px">
        <div style="font-size:16px;font-weight:700;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.email)}</div>
        <button class="back-btn" id="adminUserClose" aria-label="Uždaryti"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:0 20px 6px">
        ${rows.map(([l,v]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:0.5px solid var(--border);font-size:14px">
          <span style="color:var(--text2);flex-shrink:0">${l}</span><span style="color:var(--text);text-align:right;word-break:break-all">${esc(v)}</span></div>`).join('')}
      </div>
      ${action}
    </div>
  </div>`;
}

// One server call: Firebase Auth sign-in times + plan/usage fields + entry counts.
async function loadAdminStats(){
  state.adminStats = null;
  state.adminUsers = [];
  render();
  try{
    const {ok, data} = await callFunction('adminStats', {}, 90000);
    if(!ok) throw new Error(data?.error || 'klaida');
    state.adminUsers = data.users || [];
    state.adminStats = { generatedAt: data.generatedAt || Date.now(), promo: data.promo || null };
  }catch(e){
    toast(`Nepavyko įkelti statistikos (${e?.message||'klaida'})`);
    state.view='settings';
  }
  render();
  loadPromoCodes();
}

// ── One-time Premium codes (admin creates, a friend/tester redeems once) ──────
const FUNCTIONS_BASE = 'https://europe-west1-garantijos-4f397.cloudfunctions.net';
const PROMO_MONTH_OPTIONS = [1,3,6,12,0]; // 0 = unlimited
const promoMonthsLabel = m => m===0 ? 'Neribotai' : `${m} mėn.`;

// Server calls never hang silently: after 25 s the caller gets a clear "took too long" error.
async function callFunction(name, payload, timeoutMs=25000){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const idToken = await state.user.getIdToken();
    const r = await fetch(`${FUNCTIONS_BASE}/${name}`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
      body:JSON.stringify(payload||{}),
      signal: ctrl.signal,
    });
    let data = {};
    try{ data = await r.json(); }catch(e){}
    return {ok:r.ok, data};
  }catch(e){
    if(e?.name==='AbortError') return {ok:false, data:{error:`Serveris neatsakė per ${Math.round(timeoutMs/1000)} s. Patikrinkite ryšį ir bandykite dar kartą.`}};
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function loadPromoCodes(){
  try{
    const {ok, data} = await callFunction('listPromoCodes');
    // Timestamps arrive as ms; wrap them so renderAdminPromo can treat them like Firestore ones.
    const ts = ms => ms ? {toDate:()=>new Date(ms)} : null;
    state.promoCodes = ok ? (data.codes||[]).map(c=>({...c, createdAt:ts(c.createdAt), usedAt:ts(c.usedAt), revokedAt:ts(c.revokedAt)})) : [];
  }catch(e){
    console.warn('promo codes load failed', e);
    state.promoCodes = [];
  }
  if(state.view==='admin-stats' || state.view==='admin-promo') render();
}

function renderAdminPromoPage(){
  return `<div>
    <div class="page-header-sm">
      <button class="back-btn" id="adminPromoBackBtn"><i class="ti ti-arrow-left"></i></button>
      <h2>Premium kodai</h2>
      <div style="width:36px"></div>
    </div>
    <div style="height:12px"></div>
    ${renderAdminPromo()}
  </div>`;
}
function renderAdminPromo(){
  const codes = state.promoCodes || [];
  const last = state.promoLastCode;
  const fmt = ts => ts?.toDate ? ts.toDate().toLocaleDateString('lt-LT') : '';
  return `<div style="margin:0 16px 16px;padding:14px;background:var(--bg2);border-radius:var(--radius)">
    <div style="font-size:16px;font-weight:600">Premium kodai</div>
    <div style="font-size:13px;color:var(--text2);margin-top:4px;line-height:1.4">Vienkartinis kodas suteikia nemokamą Premium pasirinktam laikui. Panaudoti gali tik vienas žmogus.</div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <select id="promoMonths" style="padding:10px;border-radius:10px;border:0.5px solid var(--border);background:var(--bg);color:var(--text)">
        ${PROMO_MONTH_OPTIONS.map(m=>`<option value="${m}" ${m===3?'selected':''}>${promoMonthsLabel(m)}</option>`).join('')}
      </select>
      <input id="promoNote" maxlength="80" placeholder="Kam (neprivaloma)" style="flex:1;min-width:120px;padding:10px;border-radius:10px;border:0.5px solid var(--border);background:var(--bg);color:var(--text)">
      <button id="promoCreateBtn" class="save-btn" style="width:auto;margin:0;padding:10px 16px" ${state.promoBusy?'disabled':''}>${state.promoBusy?'...':'Sukurti'}</button>
    </div>
    ${last?`<div style="margin-top:12px;padding:12px;border-radius:10px;background:var(--accent-bg);display:flex;align-items:center;gap:10px">
      <div style="flex:1;font-family:monospace;font-size:17px;font-weight:700;letter-spacing:1px">${last}</div>
      <button id="promoCopyBtn" style="background:none;border:none;color:var(--accent);font-size:14px;font-weight:600;cursor:pointer">Kopijuoti</button>
    </div>`:''}
    ${codes.length?`<div style="margin-top:12px;border-top:0.5px solid var(--border)">
      ${codes.map(c=>{
        const st = c.revokedAt ? ['Deaktyvuotas','var(--red)','var(--red-bg, rgba(255,69,58,.12))']
          : c.usedBy ? ['Panaudotas','var(--text2)','var(--bg3)'] : ['Laisvas','var(--green)','var(--green-bg)'];
        return `<div style="padding:11px 0;border-bottom:0.5px solid var(--border)">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <button class="promo-copy" data-code="${esc(c.code)}" title="Kopijuoti" style="background:none;border:none;padding:0;color:var(--text);font-family:monospace;font-size:15px;font-weight:700;white-space:nowrap;cursor:pointer">${esc(c.code)}</button>
            <span style="font-size:12px;font-weight:600;color:${st[1]};background:${st[2]};padding:3px 9px;border-radius:10px;white-space:nowrap">${st[0]}</span>
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${promoMonthsLabel(c.months)} · sukurtas ${fmt(c.createdAt)}${c.note?` · ${esc(c.note)}`:''}</div>
          ${c.usedBy||c.usedByEmail?`<div style="font-size:12px;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.usedByEmail||'')} · ${fmt(c.usedAt)}</div>`:''}
          ${c.revokedAt?'':`<div style="text-align:right;margin-top:2px"><button class="promo-revoke" data-code="${esc(c.code)}" style="background:none;border:none;padding:4px 0;color:var(--red);font-size:13px;font-weight:600;cursor:pointer">Deaktyvuoti</button></div>`}
        </div>`;
      }).join('')}
    </div>`:''}
  </div>`;
}

function revokePromoCode(code){
  const c = (state.promoCodes||[]).find(x=>x.code===code);
  const msg = c?.usedBy
    ? `${c.usedByEmail||'Vartotojas'} neteks šiuo kodu suteikto Premium iškart. Apmokėtos prenumeratos tai neliečia.`
    : 'Kodo nebebus galima panaudoti.';
  showConfirmDialog('Deaktyvuoti kodą?', msg, async ()=>{
    try{
      const {ok, data} = await callFunction('revokePromoCode', {code});
      if(ok){ toast(data.endsPremium ? 'Kodas deaktyvuotas, Premium atimtas' : 'Kodas deaktyvuotas'); await loadPromoCodes(); }
      else toast(data.error||'Nepavyko deaktyvuoti');
    }catch(e){ toast('Nepavyko deaktyvuoti'); }
  }, {okText:'Deaktyvuoti', align:'center'});
}

async function createPromoCode(){
  if(state.promoBusy) return;
  const months = parseInt(document.getElementById('promoMonths')?.value??'3',10);
  const note = document.getElementById('promoNote')?.value||'';
  state.promoBusy = true; render();
  try{
    const {ok, data} = await callFunction('createPromoCode', {months, note});
    if(ok && data.code){ state.promoLastCode = data.code; await loadPromoCodes(); }
    else toast(data.error||'Nepavyko sukurti kodo');
  }catch(e){ toast('Nepavyko sukurti kodo'); }
  state.promoBusy = false; render();
}

async function redeemPromoCode(){
  const input = document.getElementById('promoRedeemInput');
  const code = (input?.value||'').trim();
  if(!code){ toast('Įveskite kodą'); return; }
  if(!state.online){ offlineDialog('Kodui reikia interneto','Kodą galėsite panaudoti, kai bus interneto ryšys.'); return; }
  state.promoRedeemBusy = true; render();
  toast('Tikrinamas kodas…', 25000);
  try{
    const {ok, data} = await callFunction('redeemPromoCode', {code});
    document.querySelectorAll('.toast').forEach(t=>t.remove());
    if(ok && data.ok){
      const msg = data.expiresAt ? `Kodas panaudotas. Premium galioja iki ${new Date(data.expiresAt).toLocaleDateString('lt-LT')}.` : 'Kodas panaudotas. Premium galioja neribotai.';
      showAppDialog('Premium įjungtas ✓', msg, '', {hideSupport:true});
    }else{
      toast(data.error||'Nepavyko panaudoti kodo', 6000);
    }
  }catch(e){ toast('Nepavyko panaudoti kodo – bandykite vėliau'); }
  state.promoRedeemBusy = false; render();
}

function renderPromoRedeem(){
  if(state.userDoc?.planSource==='purchase' && isPremiumUser()) return '';
  if(state.userDoc?.role==='admin') return '';
  const busy = state.promoRedeemBusy;
  return `<div style="display:flex;gap:8px;margin-top:14px">
      <input id="promoRedeemInput" maxlength="32" autocapitalize="characters" placeholder="Turite kodą?" style="flex:1;padding:12px;border-radius:12px;border:0.5px solid var(--border);background:var(--bg2);color:var(--text);font-size:15px;text-transform:uppercase">
      <button id="promoRedeemBtn" style="padding:12px 16px;border-radius:12px;border:none;background:var(--bg3);color:var(--accent);font-weight:600;font-size:15px;cursor:pointer" ${busy?'disabled':''}>${busy?'Tikrinama…':'Panaudoti'}</button>
    </div>`;
}


function attachEvents(){
  const on=(id,ev,fn)=>{const el=document.getElementById(id);if(el)el.addEventListener(ev,fn);};
  const onAll=(sel,ev,fn)=>document.querySelectorAll(sel).forEach(el=>el.addEventListener(ev,fn));

  // Swipe-to-delete on list cards. Only a clearly sideways swipe counts (a scroll that
  // drifts sideways is ignored), and it must cover ~45% of the card to ask about deleting.
  onAll('.swipe-wrap','touchstart',e=>{
    const id=e.currentTarget.dataset.swipeId;
    state.swipe={id,startX:e.touches[0].clientX,startY:e.touches[0].clientY,currentX:0,dragging:true,dir:null};
  });
  onAll('.swipe-wrap','touchmove',e=>{
    const sw=state.swipe;
    if(!sw.dragging||sw.id!==e.currentTarget.dataset.swipeId)return;
    const dx=e.touches[0].clientX-sw.startX, dy=e.touches[0].clientY-sw.startY;
    if(!sw.dir){
      if(Math.abs(dx)<14 && Math.abs(dy)<14) return;           // not decided yet
      sw.dir = (dx<0 && Math.abs(dx) > Math.abs(dy)*2) ? 'x' : 'y';
      if(sw.dir==='y'){ sw.dragging=false; return; }             // a scroll: leave the card alone
    }
    const card=e.currentTarget.querySelector('.card');
    const w=card?card.offsetWidth:320;
    sw.currentX=Math.max(Math.min(dx,0),-w*0.6);
    if(Math.abs(sw.currentX)>8) sw.justSwiped=true;
    if(card){ card.style.transition='none'; card.style.transform=`translateX(${sw.currentX}px)`; }
  });
  const endSwipe=e=>{
    const sw=state.swipe;
    if(sw.id!==e.currentTarget.dataset.swipeId)return;
    const card=e.currentTarget.querySelector('.card');
    const id=sw.id;
    const w=card?card.offsetWidth:320;
    if(card) card.style.transition='';
    if(sw.dir==='x' && sw.currentX < -Math.max(120, w*0.45)){
      setTimeout(()=>{ if(card)card.style.transform=''; deleteItem(id); },80);
    } else if(card) card.style.transform='';
    state.swipe={id:null,startX:0,startY:0,currentX:0,dragging:false,dir:null,justSwiped:!!sw.justSwiped};
    // Swallow only the click that may follow this swipe, not the next real tap.
    if(sw.justSwiped) setTimeout(()=>{ state.swipe.justSwiped=false; },350);
  };
  onAll('.swipe-wrap','touchend',endSwipe);
  onAll('.swipe-wrap','touchcancel',endSwipe);

  on('resendVerifyBtn','click',resendVerification);
  on('notifPromoBanner','click',()=>{state._premiumReturnView='list';state.view='premium';render();});
  on('upgradeBtn','click',()=>{state._premiumReturnView='list';state.view='premium';render();});
  on('upgradeBtn3','click',()=>{state._premiumReturnView='list';state.view='premium';render();});
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

  on('searchOpenBtn','click',()=>{
    state.searchOpen=true; state.catDropOpen=false; state.sortDropOpen=false; render();
    document.getElementById('searchInput')?.focus();
  });
  on('searchCloseBtn','click',()=>{ state.searchOpen=false; state.search=''; render(); });
  on('searchInput','input',e=>{
    state.search=e.target.value;
    clearTimeout(state._searchDebounce);
    state._searchDebounce=setTimeout(()=>{
      render();
      const inp=document.getElementById('searchInput');
      if(inp){ inp.focus(); inp.setSelectionRange(inp.value.length,inp.value.length); }
    },200);
  });

  on('rescanBtn','click',()=>{
    if(!canAttachNewDoc()){
      showAppDialog('Dokumentų limitas pasiektas', `Nemokamame plane galima turėti iki ${FREE_DOC_LIMIT} dokumentų. Su Premium galėsite prisegti ir matyti visus čekius.`, '', {hideSupport:true});
      return;
    }
    state.form.qualityWarning=null; state.form.docData=null; state.form.docMime=null; state.form.docFileName=null; renderSync(); document.getElementById('docInput')?.click();
  });
  on('modePhoto','click',()=>{
    if(document.getElementById('modePhoto')?.disabled)return;
    if(!canAttachNewDoc()){
      showAppDialog('Dokumentų limitas pasiektas', `Nemokamame plane galima turėti iki ${FREE_DOC_LIMIT} dokumentų. Su Premium galėsite prisegti ir matyti visus čekius.`, '', {hideSupport:true});
      return;
    }
    state.addMode='photo';state.aiRetriesUsedThisItem=0;state.pendingAiCharge=false;state.aiMultiItems=[];state.aiNameReview=false;
    renderSync();
    requestAnimationFrame(()=>{ document.getElementById('docInput')?.click(); });
  });
  on('modeManual','click',()=>{state.addMode='manual';state.aiNameReview=false;render();});

  on('backBtn','click',()=>{
    if(state.view==='add' && state.analyzing){
      requestAnalysisExit('list');
      return;
    }
    if(requestUnsavedAddExit('list')) return;
    if(state.view==='add' && state.multiEditIdx!=null){
      state.view='multi-select'; state.addMode=null; state.multiEditIdx=null; render();
    } else if(state.view==='add' && state.editItemId){
      state.editItemId=null; state.addMode=null; state.view='detail'; render();
    } else if(state.view==='add'&&state.addMode){
      discardPendingAdd(); state.view='list'; render();
    } else {
      state.view='list';render();
    }
  });

  on('warrantyBtn','click',()=>{state.showWarranty=true;render();});
  on('warrantyOverlay','click',()=>{state.showWarranty=false;render();});
  onAll('.warranty-duration-opt','click',e=>{
    const v=e.currentTarget.dataset.wm;
    if(v==='x'){state.form.warrantyMonths=null;state.form.warrantyEnd='';}
    else{const m=parseInt(v);state.form.warrantyMonths=m;if(state.form.purchaseDate)state.form.warrantyEnd=addMonths(state.form.purchaseDate,m);}
    state.showWarranty=false;render();
  });
  on('returnDaysBtn','click',()=>{state.showReturnDays=true;render();});
  on('returnDaysOverlay','click',()=>{state.showReturnDays=false;render();});
  onAll('.return-days-opt','click',e=>{
    const v = e.currentTarget.dataset.days;
    if(v === 'x'){
      state.form.returnDays = null;
      if(!state.form.returnDeadline && state.form.purchaseDate) state.form.returnDeadline = calcReturnDeadline(state.form.purchaseDate, 14, state.form.shop);
    }else{
      state.form.returnDays = normalizeReturnDays(v, state.form.shop);
      state.form.returnDeadline = '';
    }
    state.showReturnDays=false;
    syncSave();
    render();
  });
  on('f_warrantyEnd','change',e=>{state.form.warrantyEnd=e.target.value;});
  on('f_returnDeadline','change',e=>{state.form.returnDeadline=e.target.value;syncSave();});

  // Price has no field of its own in the database: it lives in notes as a "Kaina: X" line.
  // The form edits them separately and joins them back here.
  const syncPriceNotes=()=>{
    const price=(document.getElementById('f_price')?.value||'').trim().slice(0,50);
    const notes=(document.getElementById('f_notes')?.value||'').trim();
    state.form.notes=[notes, price?`Kaina: ${price}`:''].filter(Boolean).join('\n');
    syncSave();
  };
  on('f_price','input',syncPriceNotes);
  on('f_notes','input',syncPriceNotes);
  ['name','shop','purchaseDate','docType','docNumber','category'].forEach(k=>{
    const updateField=e=>{
      state.form[k]=e.target.value;
      if(k==='purchaseDate'&&state.form.warrantyMonths)state.form.warrantyEnd=addMonths(e.target.value,state.form.warrantyMonths);
      syncSave();
    };
    on(`f_${k}`,'input',updateField);
    on(`f_${k}`,'change',updateField);
  });

  on('aiNameReviewInput','input',e=>{state.form.name=e.target.value;const b=document.getElementById('aiNameReviewSave');if(b)b.disabled=!state.form.name.trim();syncSave();});
  on('aiNameReviewSave','click',()=>{if(!state.form.name.trim())return;state.aiNameReview=false;render();});

  on('docInput','change',e=>{ state._fromShare=false; handleDoc(e); });
  on('itemPhotoInput','change',handleItemPhoto);
  on('qrScanBtn','click',startQrScanner);
  on('removeDoc','click',()=>{state.form.docData=null;state.form.docMime=null;state.form.docFileName=null;state.docError='';render();});
  on('changeItemPhoto','click',()=>document.getElementById('itemPhotoInput')?.click());
  on('removeItemPhoto','click',()=>{state.form.itemPhotoData=null;state.form.itemPhotoMime=null;state.form.itemPhotoFileName=null;state.form.itemPhotoStoragePath=null;render();});
  on('docThumb','click',()=>{if(state.form.docData)state.lightbox=state.form.docData;render();});
  on('itemPhotoThumb','click',()=>{if(state.form.itemPhotoData)state.lightbox=state.form.itemPhotoData;render();});
  on('docImg','click',()=>{const it=state.items.find(i=>i.id===state.selected);const doc=effectiveDoc(it);if(doc.docUrl&&canViewDoc(it))state.lightbox=doc.docUrl;render();});
  on('itemPhotoImg','click',()=>{const it=state.items.find(i=>i.id===state.selected);const photo=effectiveItemPhoto(it);if(photo.itemPhotoUrl)state.lightbox=photo.itemPhotoUrl;render();});
  on('upgradeBtnDoc','click',()=>{state._premiumReturnView='add';state.view='premium';render();});

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
        r.returnDays=formReturnDaysForSave(f);
        r.returnDeadline=formReturnDeadline(f);
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
    applyAiItemToForm(next, {shop: next._shop, purchaseDate: next._purchaseDate, returnDays: next._returnDays, docType: next._docType, docNumber: next._docNumber});
    render();
  });
  on('editItemBtn','click',()=>{
    const item = state.items.find(i=>i.id===state.selected);
    if(!item) return;
    const editableDoc = canViewDoc(item) ? effectiveDoc(item) : {docUrl:null,docMime:null,docFileName:null,docStoragePath:null};
    state.form = {
      name: item.name||'',
      category: item.category||'',
      shop: item.shop||'',
      purchaseDate: item.purchaseDate||'',
      warrantyEnd: item.warrantyEnd||'',
      warrantyMonths: item.warrantyMonths??24,
      returnDays: item.returnDays === null || item.returnDays === 'custom' ? null : effectiveReturnDays(item),
      returnDeadline: item.returnDeadline||'',
      docType: item.docType||'Kvitas / čekis',
      docNumber: item.docNumber||'',
      notes: item.notes||'',
      docData: editableDoc.docUrl||null,
      docMime: editableDoc.docMime||null,
      docFileName: editableDoc.docFileName||null,
      docStoragePath: editableDoc.docStoragePath||null,
      itemPhotoData: item.itemPhotoUrl||null,
      itemPhotoMime: item.itemPhotoMime||null,
      itemPhotoFileName: item.itemPhotoFileName||null,
      itemPhotoStoragePath: item.itemPhotoStoragePath||null,
      notifyEnabled: item.notifyEnabled!==false,
      warrantyAppliesWarning: false,
      qualityWarning: null,
    };
    state.editItemId = item.id;
    state.addMode = 'manual';
    state.view = 'add';
    render();
  });
  on('detailAddPhotoBtn','click',()=>{
    state._photoTargetItemId = state.selected;
    document.getElementById('detailItemPhotoInput')?.click();
  });
  on('detailItemPhotoInput','change',handleItemPhoto);
  on('deleteBtn2','click',()=>deleteItem(state.selected));
  on('checkPolicyBtn','click',()=>{const it=state.items.find(i=>i.id===state.selected);if(it)checkPolicy(it);});

  // Settings
  on('upgradeBtnSettings','click',()=>{state._premiumReturnView='settings';state.view='premium';render();});
  on('premiumBackBtn','click',()=>{state.view=state._premiumReturnView||'list';render();});
  document.querySelectorAll('.play-buy-btn').forEach(b=>b.addEventListener('click',()=>buyPremium(b.dataset.sku)));
  on('playRestoreBtn','click',()=>restorePlayPurchases(true));
  on('promoRedeemBtn','click',redeemPromoCode);
  on('promoCreateBtn','click',createPromoCode);
  document.querySelectorAll('.promo-revoke').forEach(b=>b.addEventListener('click',()=>revokePromoCode(b.dataset.code)));
  on('promoCopyBtn','click',()=>{
    const c = state.promoLastCode; if(!c) return;
    (navigator.clipboard?.writeText(c)||Promise.reject()).then(()=>toast('Nukopijuota')).catch(()=>toast(c, 8000));
  });
  onAll('.theme-row','click',e=>{
    const t=e.currentTarget.dataset.theme;
    state.theme=t; localStorage.setItem('galio_theme',t); applyTheme(); render();
  });
  on('notifyToggle','click',toggleNotify);
  on('storageModeToggle','click',toggleStorageMode);
  on('downgradeStorageBtn','click',toggleStorageMode);
  on('downgradeStorageBtn2','click',toggleStorageMode);
  on('changePwdBtn','click',()=>{
    if(!state.user.email)return;
    sendPasswordResetEmail(auth,state.user.email)
      .then(()=>toast('Nuoroda slaptažodžiui keisti išsiųsta į el. paštą'))
      .catch(()=>toast('Klaida siunčiant laišką'));
  });
  on('settingsLogoutBtn2','click',()=>{showConfirmDialog('Atsijungti?', '', doLogout, {okText:'Atsijungti', align:'center'});});
  [['settingsAccountBtn','account'],['settingsStorageBtn','storage'],['settingsExpiredBtn','expired'],
   ['settingsThemeBtn','theme'],['settingsLegalBtn','legal'],['settingsAiBtn','ai']].forEach(([id,k])=>on(id,'click',()=>{state.settingsSheet=k;render();}));
  on('settingsSheetOverlay','click',()=>{state.settingsSheet=null;render();});
  const ss=document.getElementById('settingsSheet');
  if(ss){
    // close first, so dialogs opened by the row's own handler are not hidden behind the sheet
    ss.addEventListener('click',e=>{ if(e.target.closest('[data-close]')) state.settingsSheet=null; },true);
    ss.addEventListener('click',e=>{ if(e.target.closest('[data-close]') && !state.settingsSheet && document.getElementById('settingsSheet')) render(); });
  }
  onAll('.keep-opt','click',e=>{ const m=parseInt(e.currentTarget.dataset.keep,10)||0; if(m!==keepExpiredMonths()) changeKeepExpired(m); });
  on('settingsLogoutRow','click',()=>{showConfirmDialog('Atsijungti?', '', doLogout, {okText:'Atsijungti', align:'center'});});
  on('deleteAccountBtn','click',confirmDeleteAccount);
  on('multiCancelBtn','click',()=>{ discardPendingAdd(); state.view='list'; render(); });
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
      btn.disabled=n===0 || state.multiSaving;
      btn.style.opacity=n===0?'0.4':'1';
      btn.textContent=state.multiSaving ? 'Saugoma...' : `Išsaugoti${n>0?` (${n})`:''}`;
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
    state.form.returnDays=r.returnDays === null ? null : normalizeReturnDays(r.returnDays, r.shop);
    state.form.returnDeadline=r.returnDeadline||'';
    state.form.warrantyMonths=item.warrantyApplies===false?null:(item.warrantyMonths||24);
    state.form.warrantyEnd=multiWarrantyEnd(item,r);
    state.form.docType=r.docType||'Kvitas / čekis';
    state.form.docNumber=r.docNumber||'';
    state.form.notes=item.price?`Kaina: ${item.price}`:'';
    state.form.docData=r.docData||null;
    state.form.docMime=r.docMime||null;
    state.form.docFileName=r.docFileName||null;
    state.form.docThumb=r.docThumb||null;
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
  on('editRemindersBtn','click',()=>{
    const item = state.items.find(i=>i.id===state.selected);
    if(item) showNotifModal(item.id, item);
  });
  on('notifSaveBtn','click',()=>saveNotifSettings(false));
  on('notifAddWarrantyBtn','click',()=>addNotifReminder('warranty'));
  // Close the reminder sheet without saving: tap the dimmed area or swipe the sheet down.
  (()=>{
    const backdrop = document.getElementById('notifBackdrop');
    const sheet = document.getElementById('notifSheet');
    if(!backdrop || !sheet) return;
    const closeSheet = ()=>{ state.notifModal = null; if(state.view!=='detail') state.view='list'; render(); };
    backdrop.addEventListener('click', e=>{ if(e.target===backdrop) closeSheet(); });
    let startY = null, dy = 0;
    sheet.addEventListener('touchstart', e=>{
      if(sheet.scrollTop > 0) { startY = null; return; }   // let the sheet scroll first
      startY = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none';
    }, {passive:true});
    sheet.addEventListener('touchmove', e=>{
      if(startY===null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, {passive:true});
    sheet.addEventListener('touchend', ()=>{
      if(startY===null) return;
      sheet.style.transition = 'transform .2s ease';
      if(dy > 90){ sheet.style.transform = 'translateY(100%)'; setTimeout(closeSheet, 180); }
      else sheet.style.transform = '';
      startY = null;
    });
  })();
  on('notifAddReturnBtn','click',()=>addNotifReminder('return'));
  onAll('.notif-remove','click',e=>{
    removeNotifReminder(e.currentTarget.dataset.kind, parseInt(e.currentTarget.dataset.day,10));
  });
  onAll('.notif-amount','change',e=>{
    const kind = e.currentTarget.dataset.kind;
    const oldDay = parseInt(e.currentTarget.dataset.day,10);
    const unitEl = e.currentTarget.closest('.notif-row')?.querySelector('.notif-unit');
    const amount = Math.max(1, Math.min(99, parseInt(e.currentTarget.value,10) || 1));
    const unit = parseInt(unitEl?.value || '1', 10);
    updateNotifReminder(kind, oldDay, amount * unit);
  });
  onAll('.notif-unit','change',e=>{
    const row = e.currentTarget.closest('.notif-row');
    const amountEl = row?.querySelector('.notif-amount');
    const kind = e.currentTarget.dataset.kind;
    const oldDay = parseInt(e.currentTarget.dataset.day,10);
    const amount = Math.max(1, Math.min(99, parseInt(amountEl?.value,10) || 1));
    const unit = parseInt(e.currentTarget.value || '1', 10);
    updateNotifReminder(kind, oldDay, amount * unit);
  });
  onAll('.notif-kind','change',e=>{
    moveNotifReminder(e.currentTarget.dataset.kind, parseInt(e.currentTarget.dataset.day,10), e.currentTarget.value);
  });
  on('adminPanelBtn','click',()=>{state.view='admin-stats';startViewWatchdog('admin-stats');loadAdminStats();});
  on('helpContactBtn','click',()=>{
    state.contactSent=false; state.contactError=''; state.contactDraft='';
    state.view='contact'; render();
  });
  on('contactBackBtn','click',()=>{ state.view='settings'; render(); });
  on('contactBackBtn2','click',()=>{ state.view='settings'; render(); });
  on('contactSendBtn','click', sendContactMessage);
  on('appDialogOkBtn','click',()=>{
    if(state.appDialog?.supportAction==='cancelAnalysis') state.pendingAnalysisExit=null;
    if(state.appDialog?.supportAction==='discardAdd') state.pendingUnsavedExit=null;
    const onOk = state.appDialog?.onOk;
    state.appDialog=null;
    if(onOk) onOk();
    render();
  });
  on('appDialogSupportBtn','click',()=>{
    if(state.appDialog?.supportAction==='cancelAnalysis'){
      cancelAnalysisAndLeave();
      return;
    }
    if(state.appDialog?.supportAction==='discardAdd'){
      discardAddAndLeave();
      return;
    }
    if(state.appDialog?.supportAction==='cancel'){
      const onCancel = state.appDialog.onCancel;
      state.appDialog=null;
      if(onCancel) onCancel();
      render();
      return;
    }
    openSupportFromDialog();
  });
  on('adminBackBtn','click',()=>{state.view='settings';render();});
  on('adminPromoBtn','click',()=>{state.view='admin-promo';render();});
  on('adminUsersBtn','click',()=>{state.view='admin-users';render();});
  on('adminUsersBackBtn','click',()=>{state.view='admin-stats';render();});
  on('adminPromoBackBtn','click',()=>{state.view='admin-stats';render();});
  on('adminTestNotifBtn','click', testNotification);
  on('adminUserSearch','input',e=>{
    state.adminSearch = e.currentTarget.value || '';
    const input = e.currentTarget;
    clearTimeout(state._adminSearchTimer);
    state._adminSearchTimer = setTimeout(()=>{
      render();
      requestAnimationFrame(()=>{
        const next = document.getElementById('adminUserSearch');
        if(next){
          next.focus();
          const len = next.value.length;
          try{ next.setSelectionRange(len, len); }catch(_){}
        }
      });
    }, 180);
  });
  onAll('[data-admin-filter]','click',e=>{
    state.adminPlanFilter = e.currentTarget.dataset.adminFilter || 'all';
    render();
  });
  on('adminSortSelect','change',e=>{
    state.adminSort = e.currentTarget.value || 'active';
    render();
  });
  on('adminRefreshBtn','click',loadAdminStats);
  onAll('[data-admin-range]','click',e=>{ state.adminRange = parseInt(e.currentTarget.dataset.adminRange,10)||30; render(); });
  onAll('.admin-col','click',e=>toast(e.currentTarget.dataset.tip));
  onAll('.admin-user','click',e=>{ state.adminUserSheet = e.currentTarget.dataset.uid; render(); });
  on('adminUserOverlay','click',()=>{ state.adminUserSheet=null; render(); });
  on('adminUserClose','click',()=>{ state.adminUserSheet=null; render(); });
  onAll('.promo-copy','click',e=>{
    const c = e.currentTarget.dataset.code;
    (navigator.clipboard?.writeText(c)||Promise.reject()).then(()=>toast('Nukopijuota')).catch(()=>toast(c, 8000));
  });
  onAll('[data-action="togglePremium"]','click', e=>{
    const uid = e.currentTarget.dataset.uid;
    const reopen = state.adminUserSheet;
    state.adminUserSheet = null; // the card would cover the confirm window
    const user = state.adminUsers?.find(u=>u.uid===uid);
    if(!user) return;
    const kind = premiumKind(user);
    if(kind==='purchased'){ toast('Pirktas Premium bus valdomas per mokėjimų sistemą'); return; }
    const newPlan = (kind==='manual' || kind==='promo') ? 'free' : 'premium';
    showConfirmDialog(
      newPlan==='premium' ? 'Suteikti Premium?' : 'Nuimti Premium?',
      `${newPlan==='premium'?'Suteikti Premium planą':'Nuimti suteiktą Premium'} vartotojui ${user.email}?`,
      async ()=>{ await applyAdminPremiumToggle(uid, newPlan); if(reopen && state.view==='admin-users'){ state.adminUserSheet = reopen; render(); } },
      {align:'center', onCancel: ()=>{ if(reopen) state.adminUserSheet = reopen; }}
    );
  });
}
async function applyAdminPremiumToggle(uid, newPlan){
  const user = state.adminUsers?.find(u=>u.uid===uid);
  if(!user) return;
  try{
    await updateDoc(doc(db,'users',uid), {
      plan: newPlan,
      planSource: newPlan==='premium'?'manual':'',
      subscriptionStatus: '',
      premiumDowngradeRequired: newPlan==='free',
      premiumRevokedAt: newPlan==='free' ? serverTimestamp() : null,
    });
    user.plan = newPlan;
    user.planSource = newPlan==='premium' ? 'manual' : '';
    user.premiumExpiresMs = 0;
    user.subscriptionStatus = '';
    user.premiumDowngradeRequired = newPlan==='free';
    toast(newPlan==='premium' ? `✓ ${user.email} dabar Premium` : `✓ ${user.email} grąžintas į nemokamą planą`);
    render();
  }catch(err){ toast('Nepavyko — ' + (err.message||'klaida'), 9000); }
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

function deleteItem(id){
  showConfirmDialog('Ištrinti įrašą?', 'Šis įrašas bus visam laikui pašalintas.', ()=>performDeleteItem(id), {okText:'Ištrinti', align:'center'});
}
async function performDeleteItem(id, opts={}){
  const silent = !!opts.silent;
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
      if(item?.itemPhotoStoragePath){
        try{ await deleteObject(ref(storage,item.itemPhotoStoragePath)); }catch(e){console.warn('Item photo delete failed:',e);}
      }
      // Cloud mode re-syncs via onSnapshot automatically.
    }else{
      await localDelete(state.user.uid, id);
      state.items = state.items.filter(i=>i.id!==id);
    }
    if(silent) return true;
    toast('Ištrinta ✓');
  }catch(e){
    if(silent){ console.warn('Auto-cleanup delete failed:', e); return false; }
    toast('Nepavyko ištrinti. '+(e.message||''));
  }
  state.view='list';render();
}

// ── Automatic cleanup of long-expired entries (user setting, per device) ─────
const EXPIRED_KEEP_OPTIONS = [[0,'Visada'],[3,'3 mėn.'],[6,'6 mėn.'],[12,'1 metus']];
function keepExpiredKey(){ return 'galio_keep_expired_' + (state.user?.uid||''); }
// Stored on the account (users/{uid}.keepExpiredMonths) so every device uses the same
// choice; an older per-device choice is used until the account has one.
function keepExpiredMonths(){
  const v = state.userDoc?.keepExpiredMonths;
  if(Number.isFinite(v)) return v;
  try{ return parseInt(localStorage.getItem(keepExpiredKey())||'0',10) || 0; }catch(e){ return 0; }
}
// Entries whose warranty ended more than `months` ago and whose return deadline has also passed.
function itemsPastRetention(months){
  if(!months) return [];
  const cutoff = addMonths(today(), -months);
  return state.items.filter(i=>{
    if(!i.warrantyEnd || i.warrantyEnd >= cutoff) return false;
    const ret = effectiveReturnDeadline(i);
    return !ret || ret < today();
  });
}
let _cleanupRunning = false;
async function runExpiredCleanup(months){
  if(_cleanupRunning || !state.user || state.loadingItems) return;
  const old = itemsPastRetention(months);
  if(!old.length) return;
  _cleanupRunning = true;
  let n = 0;
  for(const it of old){ if(await performDeleteItem(it.id, {silent:true})) n++; }
  _cleanupRunning = false;
  if(n){ toast(`Ištrinta senų įrašų: ${n}`); render(); }
}
let _cleanupDoneThisSession = false;
// Never deletes quietly: shows which entries are due and lets the user keep them.
// "Ne dabar" asks again in 30 days (per device).
const CLEANUP_SNOOZE_DAYS = 30;
function cleanupSnoozeKey(){ return 'galio_cleanup_snooze_' + (state.user?.uid||''); }
function maybeAutoCleanup(){
  if(_cleanupDoneThisSession || state.loadingItems || !state.user) return;
  if(state.appDialog || state.view !== 'list') return;   // try again on a later render
  _cleanupDoneThisSession = true;
  const months = keepExpiredMonths();
  if(!months) return;
  try{ if(Date.now() < (parseInt(localStorage.getItem(cleanupSnoozeKey())||'0',10)||0)) return; }catch(e){}
  const old = itemsPastRetention(months);
  if(!old.length) return;
  const label = (EXPIRED_KEEP_OPTIONS.find(o=>o[0]===months)||[])[1] || '';
  const names = old.slice(0, 6).map(i=>'• '+i.name).join('\n') + (old.length > 6 ? `\n… ir dar ${old.length-6}` : '');
  showAppDialog('Ištrinti senus įrašus?',
    `Šių įrašų garantija baigėsi seniau nei prieš ${label}:\n${names}\n\nJie bus ištrinti visam laikui kartu su dokumentais. Nustatymą galite pakeisti skiltyje „Nustatymai“.`,
    '', {
      align:'left', okText:'Ištrinti', supportText:'Ne dabar', supportAction:'cancel',
      onOk: ()=>runExpiredCleanup(months),
    });
  // Whatever the answer, do not ask again for a while unless they delete now.
  try{ localStorage.setItem(cleanupSnoozeKey(), String(Date.now() + CLEANUP_SNOOZE_DAYS*86400000)); }catch(e){}
}
function changeKeepExpired(months){
  const label = (EXPIRED_KEEP_OPTIONS.find(o=>o[0]===months)||[])[1] || '';
  const toDelete = itemsPastRetention(months);
  const apply = async ()=>{
    try{ localStorage.setItem(keepExpiredKey(), String(months)); }catch(e){}
    if(state.userDoc) state.userDoc.keepExpiredMonths = months;
    render();
    try{ await updateDoc(doc(db,'users',state.user.uid), { keepExpiredMonths: months }); }
    catch(e){ toast(`Nepavyko išsaugoti nustatymo (${e?.code||e?.message||'klaida'})`); }
    if(months) runExpiredCleanup(months);
  };
  if(toDelete.length){
    showConfirmDialog('Ištrinti senus įrašus?',
      `Įrašų, kurių garantija baigėsi seniau nei prieš ${label}: ${toDelete.length}. Jie bus ištrinti visam laikui kartu su dokumentais.`,
      apply, {okText:'Ištrinti', align:'center'});
  }else apply();
}

async function saveNotifSettings(skip=false){
  const m = state.notifModal;
  if(!m) return;

  const enabledByUser = m.enabled !== false;
  const warrantyActive = daysLeft(m.item?.warrantyEnd) !== null && daysLeft(m.item?.warrantyEnd) >= 0;
  const returnActive = daysLeft(effectiveReturnDeadline(m.item)) !== null && daysLeft(effectiveReturnDeadline(m.item)) >= 0;
  const selectedDays = skip || !enabledByUser || !warrantyActive ? [] : [...m.selectedDays];
  const returnDays = skip || !enabledByUser || !returnActive ? [] : [...m.returnSelectedDays];
  const enabled = !skip && enabledByUser && (selectedDays.length>0 || returnDays.length>0);

  // Išsaugoti kaip naujus defaults, kad kitas įrašas siūlytų tą patį.
  state._lastNotifDays = selectedDays;
  state._lastReturnNotifDays = returnDays;
  localStorage.setItem('galio_notif_prefs', JSON.stringify({ warranty: selectedDays, return: returnDays }));

  const notifData = {
    notifyEnabled: enabled,
    notifyDays: selectedDays,
    notifyReturnDays: returnDays,
    returnDays: effectiveReturnDays(m.item),
    returnDeadline: effectiveReturnDeadline(m.item),
    notifyRepeatDays: null,
  };

  let pushBlockedReason = null;
  try{
    if(enabled){
      const pushResult = await requestPushPermission();
      if(!pushResult.ok) pushBlockedReason = pushResult.reason;
    }

    const targetIds = Array.isArray(m.itemIds) && m.itemIds.length ? m.itemIds : [m.itemId];
    // Išsaugoti į Firestore arba IndexedDB
    if(state.storageMode==='cloud'){
      await Promise.all(targetIds.map(id=>updateDoc(doc(db,'users',state.user.uid,'warranties',id), notifData)));
    }else{
      for(const id of targetIds){
        const item = state.items.find(i=>i.id===id);
        if(item){
          Object.assign(item, notifData);
          await localPut(state.user.uid, item);
        }
      }
    }

    if(enabled && pushBlockedReason){
      // The chosen days/dates ARE saved — only the push delivery itself
      // isn't set up — so this must not read like a plain success toast.
      const reasonText = pushBlockedReason==='denied'
        ? 'Pranešimai šiam įrenginiui užblokuoti. Įjunkite juos telefono/naršyklės nustatymuose, kad priminimai pasiektų.'
        : pushBlockedReason==='unsupported'
        ? 'Šis naršyklė ar įrenginys nepalaiko pranešimų. Terminus matysite programėlėje, bet priminimo negausite.'
        : pushBlockedReason==='offline'
        ? 'Nėra interneto ryšio, todėl pranešimai kol kas neįjungti. Prisijungę iš naujo atidarykite priminimus.'
        : 'Nepavyko įjungti pranešimų šiame įrenginyje. Laikai išsaugoti, bet priminimo galite negauti.';
      showAppDialog('Laikai išsaugoti, bet pranešimai neįjungti', reasonText, '', {hideSupport:true, align:'center'});
    }else{
      toast(enabled ? 'Priminimai išsaugoti ✓' : 'Priminimai išjungti');
    }
  }catch(e){
    console.warn('Notif save error:', e);
    toast(`Nepavyko išsaugoti priminimų (${e?.code||e?.message||'klaida'})`);
  }

  state.notifModal = null;
  render();
}

async function testNotification(){
  if(state.userDoc?.role!=='admin'){ toast('Tik administratoriui'); return; }
  if(!state.online){
    offlineDialog(
      'Priminimų testui reikia interneto',
      'Testas siunčia tikrą pranešimą iš serverio, todėl jį galima paleisti tik prisijungus prie interneto.'
    );
    return;
  }

  toast('1/4 Ruošiamas testas...');
  let tempId=null;
  try{
    // 1. Gauti push leidimą + FCM token
    const pushResult = await requestPushPermission();
    if(!pushResult.ok){
      const reasonText = pushResult.reason==='denied'
        ? 'Pranešimai užblokuoti šiam įrenginiui. Įjunkite juos naršyklės/telefono nustatymuose šiai svetainei.'
        : pushResult.reason==='unsupported'
        ? 'Šis naršyklė ar įrenginys nepalaiko push pranešimų.'
        : 'Nepavyko gauti leidimo. Įjunkite pranešimus naršyklės nustatymuose šiai svetainei.';
      showAppDialog('Nepavyko',reasonText,'',{hideSupport:true});
      return;
    }

    if(state.storageMode!=='cloud'){
      toast('2/2 Siunčiamas tiesioginis testas...');
      const directUrl = `https://europe-west1-garantijos-4f397.cloudfunctions.net/testWarrantyNotification?uid=${state.user.uid}&date=${today()}&direct=1`;
      const resp = await fetch(directUrl, { headers: { Authorization: 'Bearer ' + await state.user.getIdToken() } });
      const data = await resp.json();
      if(data.sent>0){
        showAppDialog(
          'Push testas pavyko ✓',
          'Testinis priminimas išsiųstas. Tikri priminimai veiks, kai įrašai bus Galio saugykloje.',
          '',
          {hideSupport:true}
        );
      }else{
        const reason = data.reason || data.error || 'nežinoma priežastis';
        showAppDialog('Testas neišsiuntė',`Pranešimas neišsiųstas. Priežastis: ${reason}. Nuotraukos tam įtakos neturi.`,'',{hideSupport:true});
      }
      return;
    }

    // 2. Sukurti laikiną įrašą su terminu RYTOJ ir notifyDays=[1]
    toast('2/4 Kuriamas testinis įrašas...');
    const tomorrow = addDays(today(), 1);
    const tempPayload = {
      name: '🔔 TESTAS (galima trinti)', category:'Kita', shop:'Galio testas',
      purchaseDate: today(), warrantyEnd: tomorrow, warrantyMonths: 0,
      docType:'Kvitas / čekis', docNumber:'', notes:'Automatinis notifikacijų testas',
      notifyEnabled:true, notifyDays:[1], notifyReturnDays:[], notifyRepeatDays:null,
      returnDeadline:null, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
      createdAt: serverTimestamp(),
    };
    const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'), tempPayload);
    tempId = docRef.id;

    // 3. Iškviesti Cloud Function (patikrina daysLeft, siunčia tikrą push)
    toast('3/4 Kviečiamas serveris...');
    const fnUrl = `https://europe-west1-garantijos-4f397.cloudfunctions.net/testWarrantyNotification?uid=${state.user.uid}&date=${today()}`;
    const resp = await fetch(fnUrl, { headers: { Authorization: 'Bearer ' + await state.user.getIdToken() } });
    const data = await resp.json();

    // 4. Ištrinti laikiną įrašą
    toast('4/4 Valoma...');
    await deleteDoc(doc(db,'users',state.user.uid,'warranties',tempId));
    tempId=null;

    // Rezultatas
    if(data.sent>0){
      showAppDialog('Testas pavyko ✓',`Serveris išsiuntė ${data.sent} pranešimą. Patikrinkite notifikacijų juostą — turėtų pasirodyti "Garantija baigiasi — rytoj". Jei matote — visa grandinė veikia.`,'',{hideSupport:true});
    }else{
      const reason = data.details?.[0]?.reason || data.reason || 'nežinoma priežastis';
      showAppDialog('Testas neišsiuntė',`Serveris nesiuntė pranešimo. Priežastis: ${reason}. Jei rašo "no fcmToken" — pirma įjunkite pranešimus (bandykite testą dar kartą).`,'',{hideSupport:true});
    }
  }catch(e){
    console.warn('Test error:', e);
    // Išvalyti jei liko
    if(tempId){ try{ await deleteDoc(doc(db,'users',state.user.uid,'warranties',tempId)); }catch(_){} }
    showAppDialog('Testas nepavyko','Nepavyko patikrinti pranešimų. Patikrinkite, ar pranešimų serveris paruoštas.','',{hideSupport:true});
  }
}

// While the app is open, FCM hands the message to the page instead of showing it,
// so without this a reminder arriving with the app on screen was silently lost.
let _fgPushReady = false;
async function setupForegroundPush(){
  if(_fgPushReady) return;
  _fgPushReady = true;
  try{
    const { getMessaging, onMessage } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');
    const { firebaseApp } = await import('./firebase-config.js');
    onMessage(getMessaging(firebaseApp), async payload=>{
      const n = payload.notification || {};
      const title = n.title || 'Galio', body = n.body || '';
      try{
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, {
          body, icon: 'icon-192.png', badge: 'badge-96.png',
          tag: payload.data?.tag || 'galio-notif',
          data: { url: 'https://ignas7206.github.io/Galio/' },
        });
      }catch(e){ toast(`${title}${body?' — '+body:''}`, 6000); }
    });
  }catch(e){ _fgPushReady = false; console.warn('Foreground push setup failed:', e); }
}

// Returns {ok:true} on success, or {ok:false, reason} so callers can tell the
// user WHY push wasn't set up instead of silently claiming success — reason
// is one of: 'offline' | 'unsupported' | 'denied' | 'no-token' | 'error'.
async function requestPushPermission(){
  try{
    if(!state.online) return {ok:false, reason:'offline'};
    if(typeof Notification === 'undefined') return {ok:false, reason:'unsupported'};
    // Browsers never re-prompt once denied — calling requestPermission()
    // again just silently resolves to 'denied' with no dialog at all, which
    // is indistinguishable from a first-time refusal unless we check first.
    if(Notification.permission === 'denied') return {ok:false, reason:'denied'};
    const perm = await Notification.requestPermission();
    if(perm !== 'granted') return {ok:false, reason:'denied'};

    const { getMessaging, getToken } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');
    const { firebaseApp, VAPID_KEY } = await import('./firebase-config.js');
    const fcmMessaging = getMessaging(firebaseApp);
    const token = await getToken(fcmMessaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.ready,
    });
    if(!token) return {ok:false, reason:'no-token'};
    setupForegroundPush();

    // Every device the user enabled reminders on gets them (the 5 most recent), not just the last one.
    const fcmTokens = [...(state.userDoc?.fcmTokens||[]).filter(t=>t && t!==token), token].slice(-5);
    await updateDoc(doc(db,'users',state.user.uid), { fcmToken: token, fcmTokens, notifyEnabled: true });
    if(state.userDoc){ state.userDoc.fcmToken = token; state.userDoc.fcmTokens = fcmTokens; }
    return {ok:true};
  }catch(e){
    console.warn('Push permission error:', e);
    return {ok:false, reason:'error'};
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

function updateItem(){
  if(!state.editItemId||!state.form.name.trim()) return;
  const f = state.form;
  if(!f.warrantyEnd){
    showAppDialog('Trūksta garantijos datos', 'Nurodykite, iki kada galioja garantija. Prekės be garantijos datos neišsaugomos, kad sąraše neliktų neaiškių įrašų.');
    return;
  }
  confirmExpiredTerms({
    warrantyEnd: f.warrantyEnd,
    returnDeadline: formReturnDeadline(f),
    label: 'Šios prekės'
  }, finishUpdateItem);
}
async function finishUpdateItem(){
  const f = state.form;
  const isCloud = state.storageMode==='cloud';
  const existing = state.items.find(i=>i.id===state.editItemId);
  if(isCloud && !state.online){
    offlineDialog(
      'Įrašui išsaugoti reikia interneto',
      'Šis įrašas laikomas Galio saugykloje. Pakeitimus galėsime išsaugoti, kai vėl bus interneto ryšys.'
    );
    return;
  }
  if(isCloud && !isPremiumUser()){
    showAppDialog('Reikia Premium', 'Prieš redaguojant Galio saugykloje saugomus įrašus atnaujinkite Premium arba perkelkite įrašus į šį įrenginį.', '');
    return;
  }
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
    returnDays: formReturnDaysForSave(f),
    returnDeadline: formReturnDeadline(f),
    ...(f.docData ? {docUrl:f.docData, docMime:f.docMime, docFileName:f.docFileName} : {}),
    itemPhotoUrl: null,
    itemPhotoMime: null,
    itemPhotoFileName: null,
    itemPhotoStoragePath: null,
  };

  try{
    if(f.itemPhotoData && f.itemPhotoMime){
      if(isCloud && isDataUrl(f.itemPhotoData)){
        const path = `users/${state.user.uid}/item-photos/${state.editItemId}.jpg`;
        const url = await uploadDataUrlToStorage(path, f.itemPhotoData, f.itemPhotoMime);
        payload.itemPhotoUrl = url;
        payload.itemPhotoMime = f.itemPhotoMime;
        payload.itemPhotoFileName = f.itemPhotoFileName;
        payload.itemPhotoStoragePath = path;
      }else{
        payload.itemPhotoUrl = f.itemPhotoData;
        payload.itemPhotoMime = f.itemPhotoMime;
        payload.itemPhotoFileName = f.itemPhotoFileName;
        payload.itemPhotoStoragePath = f.itemPhotoStoragePath || null;
      }
    }
    if(isCloud){
      await updateDoc(doc(db,'users',state.user.uid,'warranties',state.editItemId), payload);
      if(existing?.itemPhotoStoragePath && (!payload.itemPhotoStoragePath || payload.itemPhotoStoragePath!==existing.itemPhotoStoragePath)){
        try{ await deleteObject(ref(storage, existing.itemPhotoStoragePath)); }catch(e){ console.warn('Old item photo delete failed:', e); }
      }
    }else{
      const updated = {...existing, ...payload};
      await localPut(state.user.uid, updated);
      const idx = state.items.findIndex(i=>i.id===state.editItemId);
      if(idx>=0) state.items[idx]=updated;
    }
    toast('Išsaugota ✓');
    state.editItemId=null; state.addMode=null; state.view='detail';
    render();
  }catch(e){
    toast('Nepavyko išsaugoti. '+(e.message||''));
  }
}

function saveItem(){
  if(!state.form.name.trim())return;
  const f=state.form;
  if(!f.warrantyEnd){
    showAppDialog('Trūksta garantijos datos', 'Nurodykite, iki kada galioja garantija. Prekės be garantijos datos neišsaugomos, kad sąraše neliktų neaiškių įrašų.');
    return;
  }
  confirmExpiredTerms({
    warrantyEnd: f.warrantyEnd,
    returnDeadline: formReturnDeadline(f),
    label: 'Šios prekės'
  }, finishSaveItem);
}
async function finishSaveItem(){
  const f=state.form;
  const isCloud = state.storageMode==='cloud';
  if(isCloud && !state.online){
    offlineDialog(
      'Įrašui išsaugoti reikia interneto',
      'Dabar nėra interneto ryšio, todėl negalime išsaugoti į Galio saugyklą. Prisijunkite prie interneto arba nustatymuose pasirinkite „Tik šiame įrenginyje“.'
    );
    return;
  }
  if(isCloud && !isPremiumUser()){
    showAppDialog('Reikia Premium', 'Prieš pridėdami naujus įrašus atnaujinkite Premium arba perkelkite esamus įrašus į šį įrenginį.', '');
    return;
  }
  const duplicate = findDuplicateItem({
    name: f.name,
    shop: f.shop,
    purchaseDate: f.purchaseDate,
    docNumber: f.docNumber,
  });
  if(duplicate){
    showAppDialog('Įrašas jau išsaugotas', `Ši prekė jau yra jūsų garantijų sąraše: „${duplicate.name || 'be pavadinimo'}“. Norėdami pakeisti informaciją, atidarykite esamą įrašą ir pasirinkite redagavimą.`, '', {hideSupport:true});
    return;
  }

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
    itemPhotoUrl:null, itemPhotoMime:null, itemPhotoFileName:null, itemPhotoStoragePath:null,
    ...(f.docMime==='application/pdf' && f.docThumb ? {docThumb:f.docThumb} : {}),
    returnDays: formReturnDaysForSave(f),
    returnDeadline: formReturnDeadline(f),
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
      if(f.itemPhotoData && f.itemPhotoMime){
        try{
          const path = `users/${state.user.uid}/item-photos/${docRef.id}.jpg`;
          const url = await uploadDataUrlToStorage(path, f.itemPhotoData, f.itemPhotoMime);
          await updateDoc(docRef, { itemPhotoUrl:url, itemPhotoMime:f.itemPhotoMime, itemPhotoFileName:f.itemPhotoFileName, itemPhotoStoragePath:path });
        }catch(e){
          console.warn('Item photo upload failed:',e);
          toast('Daikto nuotraukos nepavyko įkelti');
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
        itemPhotoUrl: f.itemPhotoData || null,
        itemPhotoMime: f.itemPhotoMime || null,
        itemPhotoFileName: f.itemPhotoFileName || null,
      };
      await localPut(state.user.uid, localItem);
      state.items.unshift(localItem);
      state._lastSavedId = localItem.id;
    }

    state._savedOk = true;
  }catch(e){
    toast('Nepavyko išsaugoti. '+(e.message||''));
  }

  state.uploadPct=null;
  const savedForm = {...state.form};
  state.form=emptyForm();state.docError='';state.addMode=null;

  // Rodyti priminimų modalą tik jei yra ką priminti (garantija arba grąžinimas)
  const savedOk = state._savedOk; state._savedOk = false;
  if(state._lastSavedId && (savedForm.warrantyEnd || savedForm.purchaseDate)){
    showNotifModal(state._lastSavedId, {
      warrantyMonths: savedForm.warrantyMonths,
      warrantyEnd: savedForm.warrantyEnd,
      purchaseDate: savedForm.purchaseDate,
      shop: savedForm.shop,
      returnDays: formReturnDaysForSave(savedForm),
      returnDeadline: formReturnDeadline(savedForm),
    }, savedOk ? 'Įrašas išsaugotas' : '');
  }else{
    if(savedOk) toast('Išsaugota ✓');
    state.view='list'; render();
  }
  state._lastSavedId = null;
}

async function saveMultiItems(){
  const r = state.multiItemReceipt;
  if(!r || state.multiSaving) return;
  let selected = r.items.filter(i=>i.selected);
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
  const returnDeadlineForReceipt = receiptReturnDeadline(r);
  const expiredWarranty = selected.filter(i=>isExpiredDate(multiWarrantyEnd(i,r)));
  const expiredReturn = isExpiredDate(returnDeadlineForReceipt) ? selected : [];
  if(expiredWarranty.length){
    const list = expiredWarranty
      .slice(0, 6)
      .map(i=>`• ${i.name || 'Be pavadinimo'} (garantija iki ${fmtDate(multiWarrantyEnd(i,r))})`)
      .join('\n');
    const more = expiredWarranty.length > 6 ? `\n… ir dar ${expiredWarranty.length - 6}` : '';
    const heading = expiredWarranty.length === 1 ? '1 prekės garantija pasibaigusi' : `${expiredWarranty.length} prekių garantijos pasibaigusios`;
    const returnInfo = expiredReturn.length ? `\n\nNemokamo grąžinimo laikas taip pat pasibaigęs (${fmtDate(returnDeadlineForReceipt)}).` : '';
    showConfirmDialog(
      heading,
      `${list}${more}${returnInfo}\n\nAr tikrai norite išsaugoti šiuos įrašus?`,
      finishSaveMultiItems,
      {okText:'Išsaugoti', align:'center'}
    );
    return;
  }else if(expiredReturn.length){
    showAppDialog(
      'Garantijos dar galioja ✓',
      `Grąžinti prekių nebegalima (terminas baigėsi ${fmtDate(returnDeadlineForReceipt)}), bet garantijos dar galioja. Įrašus išsaugosime ir priminsime, kol jos nesibaigė.`,
      '',
      {hideSupport:true, align:'center', onOk: finishSaveMultiItems}
    );
    return;
  }
  finishSaveMultiItems();
}
async function finishSaveMultiItems(){
  const r = state.multiItemReceipt;
  if(!r || state.multiSaving) return;
  let selected = r.items.filter(i=>i.selected);
  if(selected.length===0) return;

  const isCloud = state.storageMode==='cloud';
  if(isCloud && !state.online){
    offlineDialog(
      'Įrašams išsaugoti reikia interneto',
      'Šie įrašai būtų saugomi Galio saugykloje. Juos galėsime išsaugoti, kai vėl bus interneto ryšys.'
    );
    return;
  }
  if(isCloud && !isPremiumUser()){
    showAppDialog('Reikia Premium', 'Prieš pridėdami naujus įrašus atnaujinkite Premium arba perkelkite esamus įrašus į šį įrenginį.', '');
    return;
  }
  const duplicates = selected
    .map(item=>({
      item,
      existing: findDuplicateItem({
        name: item.name,
        shop: r.shop,
        purchaseDate: r.purchaseDate,
        docNumber: r.docNumber,
      })
    }))
    .filter(x=>x.existing);
  if(duplicates.length){
    const duplicateItems = new Set(duplicates.map(x=>x.item));
    selected = selected.filter(item=>!duplicateItems.has(item));
    if(selected.length===0){
      const names = duplicates.slice(0,3).map(x=>`„${x.item.name || x.existing.name || 'be pavadinimo'}“`).join(', ');
      showAppDialog(
        'Prekės jau išsaugotos',
        `Visos pasirinktos prekės jau yra garantijų sąraše: ${names}${duplicates.length>3?' ir kt.' : ''}. Norėdami pakeisti informaciją, redaguokite esamus įrašus.`,
        '',
        {hideSupport:true}
      );
      return;
    }
    toast(`Praleista ${duplicates.length} jau išsaugota ${duplicates.length===1?'prekė':'prekės'}`);
  }
  state.multiSaving = true;
  render();
  let saved=0, failed=0;
  const savedIds = [];
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

  toast(ltSavingProducts(selected.length));

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
        itemPhotoUrl:null, itemPhotoMime:null, itemPhotoFileName:null, itemPhotoStoragePath:null,
        ...(r.docMime==='application/pdf' && r.docThumb ? {docThumb:r.docThumb} : {}),
        returnDays: r.returnDays === null ? null : normalizeReturnDays(r.returnDays, r.shop),
        returnDeadline: receiptReturnDeadline(r),
        notifyEnabled: false,
        notifyDays: [],
        notifyReturnDays: [],
        createdAtMs: Date.now(),
      };

      if(isCloud){
        const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'),{...payload,...(sharedDocMeta||{}),createdAt:serverTimestamp()});
        savedIds.push(docRef.id);
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
        savedIds.push(localItem.id);
      }
      saved++;
    }catch(e){
      console.warn('Failed to save item:',e);
      failed++;
    }
  }

  state.multiSaving=false;
  state.multiItemReceipt=null;
  state.pendingAiCharge=false;
  if(isCloud) state.loadingItems = true;
  if(failed>0) toast(`${ltSavedProducts(saved).replace(' ✓','')}, nepavyko ${failed}`);
  const savedNote = failed>0 ? '' : ltSavedProducts(saved).replace(' ✓','');
  if(savedIds.length>0){
    const reminderBase = selected.find(item=>{
      const warrantyActive = daysLeft(multiWarrantyEnd(item, r)) !== null && daysLeft(multiWarrantyEnd(item, r)) >= 0;
      const returnDeadline = receiptReturnDeadline(r);
      const returnActive = daysLeft(returnDeadline) !== null && daysLeft(returnDeadline) >= 0;
      return warrantyActive || returnActive;
    });
    if(!reminderBase){
      if(savedNote) toast(ltSavedProducts(saved));
      state.view='list';
      render();
      return;
    }
    showNotifModal(savedIds, {
      warrantyMonths: reminderBase?.warrantyMonths || 24,
      warrantyEnd: multiWarrantyEnd(reminderBase, r),
      purchaseDate: r.purchaseDate,
      shop: r.shop,
      returnDays: r.returnDays === null ? null : normalizeReturnDays(r.returnDays, r.shop),
      returnDeadline: receiptReturnDeadline(r),
    }, savedNote);
  }else{
    state.view='list';
    render();
  }
}

function base64ToBlob(b64,mime){
  const s=atob(b64),a=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);
  return new Blob([a],{type:mime});
}
function isDataUrl(value){
  return typeof value === 'string' && value.startsWith('data:');
}
async function uploadDataUrlToStorage(path, dataUrl, mime){
  const b64 = isDataUrl(dataUrl) ? dataUrl.split(',')[1] : dataUrl;
  const blob = base64ToBlob(b64, mime);
  await uploadBytes(ref(storage,path), blob, {contentType:mime});
  return getDownloadURL(ref(storage,path));
}
async function docBlobFromItem(item){
  if(!item?.docUrl || !item?.docMime) return null;
  if(String(item.docUrl).startsWith('data:')){
    const b64 = item.docUrl.split(',')[1];
    return base64ToBlob(b64, item.docMime);
  }
  if(item.docMime === 'application/pdf' && !String(item.docUrl).startsWith('http')){
    return base64ToBlob(item.docUrl, item.docMime);
  }
  const resp = await fetch(item.docUrl);
  if(!resp.ok) throw new Error('document-download-failed');
  return await resp.blob();
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
    <div class="qr-scanner-hint" id="qrHint">Nukreipkite kamerą į QR kodą ant dokumento</div>
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

function handleItemPhoto(e){
  const input = e.target;
  const file = input.files?.[0];
  if(input) input.value = '';
  if(!file) return;
  if(state.analyzing || state.uploadPct!==null){
    toast('Palaukite, ankstesnis failas dar apdorojamas');
    return;
  }
  if(!ALLOWED_IMG.includes(file.type)){
    showAppDialog('Netinkamas formatas', 'Daikto nuotraukai naudokite JPG, PNG, WebP arba HEIC formatą.', '', {hideSupport:true, align:'center'});
    return;
  }
  const MAX_ORIGINAL_ITEM_PHOTO = 20*1024*1024;
  if(file.size > MAX_ORIGINAL_ITEM_PHOTO){
    showAppDialog('Nuotrauka per didelė', `Pasirinkta nuotrauka per didelė (${fmtSize(file.size)}). Pabandykite kitą nuotrauką.`, '', {hideSupport:true, align:'center'});
    return;
  }

  (async()=>{
    if(await looksLikeHeic(file)){
      showAppDialog('HEIC nepalaikomas', 'Šioje naršyklėje HEIC nuotraukos nepalaikomos. Telefono kameros nustatymuose pasirinkite JPEG formatą arba įkelkite kitą nuotrauką.', '', {hideSupport:true, align:'center'});
      return;
    }
    const reader = new FileReader();
    reader.onload = async ev=>{
      try{
        const dataUrl = ev.target.result;
        await new Promise((res,rej)=>{ const t=new Image(); t.onload=res; t.onerror=rej; t.src=dataUrl; });
        const compressed = await compressImage(dataUrl, 1200, 0.78);
        const compB64 = compressed.split(',')[1];
        const compressedBytes = Math.ceil(compB64.length * 0.75);
        if(compressedBytes > MAX_IMG){
          showAppDialog('Nuotrauka per didelė', `Nuotrauka per didelė net po suspaudimo (${fmtSize(compressedBytes)}). Pabandykite kitą nuotrauką.`, '', {hideSupport:true, align:'center'});
          return;
        }
        const targetItemId = state._photoTargetItemId; state._photoTargetItemId = null;
        openPhotoEditor(compressed, edited => {
          if(targetItemId){ saveDetailItemPhoto(targetItemId, edited); return; }
          state.form.itemPhotoData = edited;
          state.form.itemPhotoMime = 'image/jpeg';
          state.form.itemPhotoFileName = file.name.replace(/\.[^.]+$/,'.jpg');
          state.form.itemPhotoStoragePath = null;
          render();
        });
      }catch(err){
        console.warn('Item photo processing failed:', err);
        showAppDialog('Nuotraukos nepavyko apdoroti', 'Pabandykite kitą nuotrauką arba pakeiskite kameros formatą į JPEG.', '', {hideSupport:true, align:'center'});
      }
    };
    reader.onerror = ()=>showAppDialog('Nuotraukos nepavyko nuskaityti', 'Pabandykite pasirinkti nuotrauką dar kartą.', '', {hideSupport:true, align:'center'});
    reader.readAsDataURL(file);
  })();
}

// ── Photo editor: square crop + rotate (Cropper.js, loaded on first use) ──────
const CROPPER_JS = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js';
const CROPPER_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css';
let _cropperLoad = null;
function loadCropper(){
  if(window.Cropper) return Promise.resolve();
  if(_cropperLoad) return _cropperLoad;
  _cropperLoad = new Promise((res, rej)=>{
    const css = document.createElement('link'); css.rel='stylesheet'; css.href=CROPPER_CSS; document.head.appendChild(css);
    const js = document.createElement('script'); js.src=CROPPER_JS; js.onload=res; js.onerror=()=>{ _cropperLoad=null; rej(new Error('cropper load failed')); };
    document.head.appendChild(js);
  });
  return _cropperLoad;
}

// Shows the photo full screen with crop/rotate; calls onDone(jpegDataUrl). Lives outside
// render() so app re-renders cannot destroy it mid-edit.
async function openPhotoEditor(dataUrl, onDone){
  try{ await loadCropper(); }catch(e){ onDone(dataUrl); return; } // offline: keep the photo as is
  const wrap = document.createElement('div');
  wrap.id = 'photoEditor';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column';
  wrap.innerHTML = `
    <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center"><img id="photoEditorImg" style="display:block;max-width:100%;max-height:100%"></div>
    <div style="display:flex;gap:10px;padding:14px 16px calc(14px + env(safe-area-inset-bottom));background:#111">
      <button id="peCancel" style="flex:1;padding:14px;border-radius:12px;border:1px solid #444;background:none;color:#ddd;font-size:15px">Atšaukti</button>
      <button id="peRotate" style="padding:14px 18px;border-radius:12px;border:none;background:#222;color:#fff;font-size:20px" aria-label="Pasukti"><i class="ti ti-rotate-clockwise"></i></button>
      <button id="peFit" style="padding:14px 18px;border-radius:12px;border:none;background:#222;color:#fff;font-size:20px" aria-label="Sutalpinti visą nuotrauką" title="Sutalpinti visą nuotrauką"><i class="ti ti-arrows-minimize"></i></button>
      <button id="peSave" style="flex:1;padding:14px;border-radius:12px;border:none;background:var(--accent,#2f6bff);color:#fff;font-size:15px;font-weight:600">Išsaugoti</button>
    </div>`;
  document.body.appendChild(wrap);
  const img = wrap.querySelector('#photoEditorImg');
  img.src = dataUrl;
  // viewMode 0: the photo can be made smaller than the square; empty edges are filled with the photo's background colour
  const cropper = new window.Cropper(img, { aspectRatio: 1, viewMode: 0, autoCropArea: 0.9, background: false, dragMode: 'move' });
  let fill = '#ffffff', fitted = false;
  img.addEventListener('load', ()=>{ try{
    const c=document.createElement('canvas'); c.width=c.height=24; const x=c.getContext('2d'); x.drawImage(img,0,0,24,24);
    const px=[[0,0],[23,0],[0,23],[23,23],[12,0],[12,23],[0,12],[23,12]].map(([a,b])=>x.getImageData(a,b,1,1).data);
    const avg=i=>Math.round(px.reduce((t,p)=>t+p[i],0)/px.length);
    fill=`rgb(${avg(0)},${avg(1)},${avg(2)})`;
  }catch(e){} }, { once:true });
  const fitWhole = ()=>{
    const cb=cropper.getCropBoxData(), cd=cropper.getCanvasData(); if(!cb.width||!cd.width) return;
    const r=cd.width/cd.height, w=r>=1?cb.width:cb.height*r, h=w/r;
    cropper.setCanvasData({ left: cb.left+(cb.width-w)/2, top: cb.top+(cb.height-h)/2, width: w, height: h });
    const vb=wrap.querySelector('.cropper-view-box'); if(vb) vb.style.background=fill; // preview the filled edges
  };
  const close = ()=>{ try{ cropper.destroy(); }catch(e){} wrap.remove(); };
  wrap.querySelector('#peCancel').onclick = close;
  wrap.querySelector('#peRotate').onclick = ()=>{ cropper.rotate(90); if(fitted) fitWhole(); };
  wrap.querySelector('#peFit').onclick = e=>{
    fitted=!fitted;
    if(fitted) fitWhole(); else { const rot=cropper.getData().rotate||0; cropper.reset(); if(rot) cropper.rotateTo(rot); }
    e.currentTarget.style.background = fitted ? 'var(--accent,#2f6bff)' : '#222';
  };
  wrap.querySelector('#peSave').onclick = ()=>{
    // 800 px square at JPEG 0.75 ≈ 60–120 KB: sharp enough for list and detail, light on storage.
    const canvas = cropper.getCroppedCanvas({ width: 800, height: 800, fillColor: fill, imageSmoothingQuality: 'high' });
    const out = canvas ? canvas.toDataURL('image/jpeg', 0.75) : dataUrl;
    close();
    onDone(out);
  };
}

// Saves an item photo straight onto an existing record (no edit form).
async function saveDetailItemPhoto(itemId, dataUrl){
  const item = state.items.find(i=>i.id===itemId);
  if(!item || !state.user) return;
  toast('Saugoma nuotrauka…', 20000);
  try{
    const fields = { itemPhotoMime:'image/jpeg', itemPhotoFileName:'daiktas.jpg' };
    if(state.storageMode==='cloud'){
      const path = `users/${state.user.uid}/item-photos/${itemId}.jpg`;
      const url = await uploadDataUrlToStorage(path, dataUrl, 'image/jpeg');
      Object.assign(fields, { itemPhotoUrl:url, itemPhotoStoragePath:path });
      await updateDoc(doc(db,'users',state.user.uid,'warranties',itemId), fields);
    }else{
      Object.assign(fields, { itemPhotoUrl:dataUrl, itemPhotoStoragePath:null });
      await localPut(state.user.uid, { ...item, ...fields });
    }
    const idx = state.items.findIndex(i=>i.id===itemId);
    if(idx>=0) state.items[idx] = { ...state.items[idx], ...fields };
    toast('Nuotrauka išsaugota ✓');
    render();
  }catch(e){
    console.warn('Item photo save failed:', e);
    toast('Nepavyko išsaugoti nuotraukos. '+(e.message||''), 7000);
  }
}

function handleDoc(e){
  const input = e.target;
  const file = input.files?.[0];
  if(input) input.value = '';
  if(!file)return;
  if(state.addMode==='photo' && !state.online){
    state.docError='Dokumento nuskaitymui reikia interneto. Įveskite duomenis rankiniu būdu arba bandykite dar kartą prisijungę.';
    render();
    return;
  }
  if(state.analyzing || state.uploadPct!==null){
    toast('Palaukite, ankstesnis failas dar apdorojamas');
    return;
  }
  if(!canAttachNewDoc() && !state.form.docData){
    state.docError=`Nemokamame plane galima turėti iki ${FREE_DOC_LIMIT} dokumentų. Atnaujinkite į Premium, kad galėtumėte prisegti daugiau čekių.`;
    render();
    return;
  }
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

// First page of a PDF as a small JPEG, made on the device so the list can show it.
let _pdfJs = null;
function loadPdfJs(){
  if(_pdfJs) return _pdfJs;
  _pdfJs = new Promise((res, rej)=>{
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    sc.onload = ()=>{ try{ window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); }catch(e){ rej(e); } };
    sc.onerror = ()=>{ _pdfJs = null; rej(new Error('pdf.js')); };
    document.head.appendChild(sc);
  });
  return _pdfJs;
}
async function makePdfThumb(b64){
  try{
    const lib = await loadPdfJs();
    const bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    const pdf = await lib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 240 / v1.width });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.min(Math.round(vp.height), 340);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pdf.destroy?.();
    const url = cv.toDataURL('image/jpeg', 0.7);
    return url.length < 60000 ? url : null;
  }catch(e){ console.warn('PDF thumb:', e); return null; }
}

function proceedWithFile(file, isPdf){
  const reader=new FileReader();
  reader.onload=async ev=>{
    const dataUrl=ev.target.result;
    if(isPdf){
      const b64=dataUrl.split(',')[1];
      state.form.docData=b64;state.form.docMime='application/pdf';state.form.docFileName=file.name;state.form.docThumb=null;
      const thumbP = makePdfThumb(b64).then(t=>{
        if(state.form.docData===b64) state.form.docThumb=t;
        if(state.multiItemReceipt && state.multiItemReceipt.docData===b64) state.multiItemReceipt.docThumb=t;
        return t;
      });
      // AI reads PDFs too; the AI server accepts up to 5 MB per request (base64 included)
      if(state.addMode==='photo' && b64.length <= MAX_PDF_AI_B64){
        state.analyzing=true;
        startAnalyzeWatchdog();
        render();
        try{
          const runId = ++state.analysisRunId;
          await analyzeDoc(b64,'application/pdf', runId);
        }finally{
          clearAnalyzeWatchdog();
          state.analyzing=false;
        }
      }else if(state.addMode==='photo'){
        toast('PDF prisegtas, bet per didelis automatiniam nuskaitymui – užpildykite laukus ranka', 6000);
      }
      await thumbP;
      render();
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
        if(state.addMode==='photo'){
          state.analyzing=true;
          startAnalyzeWatchdog();
          render();
          try{
            const runId = ++state.analysisRunId;
            await analyzeDoc(compB64,'image/jpeg', runId);
          }finally{
            clearAnalyzeWatchdog();
            state.analyzing=false;
          }
        }
        render();
      }catch(err){
        console.warn('Image processing failed:', err);
        clearAnalyzeWatchdog();
        state.analyzing=false;
        state.docError='Nepavyko apdoroti nuotraukos — pabandykite dar kartą arba kitą failą (jei tai HEIC formatas, pakeiskite kameros nustatymus į JPEG)';render();
      }
    }
  };
  reader.onerror=()=>{
    clearAnalyzeWatchdog();
    state.analyzing=false;
    state.docError='Nepavyko nuskaityti failo';render();
  };
  reader.readAsDataURL(file);
}

async function checkPolicy(item){
  // Naudoja tą pačią Premium dienos kvotą kaip nuskaitymas
  if(!isPremiumUser()){ toast('Ši funkcija prieinama tik Premium nariams'); return; }
  if(!state.online){
    offlineDialog(
      'Patikrinimui reikia interneto',
      'Gamintojo garantijos sąlygos ieškomos internete, todėl reikia ryšio.'
    );
    return;
  }

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
          `Produktas: "${item.name}"${item.shop?` (pardavėjas: ${item.shop})`:''}.\n\n`+
          `Atsakyk Lietuvos / ES vartotojo kontekste. Naujos vartojimo prekės iš profesionalaus pardavėjo paprastai turi 24 mėn. teisinę garantiją dėl prekės trūkumų. `+
          `Gamintojo ar parduotuvės komercinė garantija gali būti tik papildoma ir negali sutrumpinti šios teisės.\n\n`+
          `Patikrink, ar yra aiški papildoma gamintojo / parduotuvės sąlyga, naudinga vartotojui, pvz. ilgesnė komercinė garantija ar aiškus ribojimas. `+
          `Nesiremk vien užsienio rinkai skirtu .com puslapiu kaip galutine taisykle Lietuvos vartotojui. `+
          `Jei randi trumpesnį terminą nei 24 mėn. (pvz. 4 mėn.), aiškiai parašyk, kad jis nepakeičia LT/ES teisinės garantijos. `+
          `Atsakyk lietuviškai, trumpai, 2-3 sakiniais. Nevadink to pasiūlymu ir nesiūlyk automatiškai trumpinti garantijos.`
        }]}]
      })
    });
    if(res.status===429){
      let m=`Pasiektas mėnesio garantijos patikrinimų limitas (${PREMIUM_SEARCH_MONTHLY_LIMIT}).`;
      try{ m=(await res.json()).error||m; }catch(e){}
      toast(m,6000);
      state.policyChecking=false; render(); return;
    }
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
  if(!state.online){
    offlineDialog(
      'Pranešimams reikia interneto',
      'Pranešimų nustatymą galėsite pakeisti, kai vėl bus interneto ryšys.'
    );
    return;
  }
  if(state.storageMode!=='cloud'){
    showAppDialog('Pranešimai neįjungti', 'Automatiniai priminimai veikia tik su Galio saugykloje esančiais įrašais. Jei įrašai laikomi tik šiame įrenginyje, terminus matysite programėlėje, bet priminimų negausite.', '', {hideSupport:true});
    return;
  }
  const current = state.userDoc?.notifyEnabled !== false;
  try{
    await updateDoc(doc(db,'users',state.user.uid), { notifyEnabled: !current });
  }catch(e){
    toast('Nepavyko išsaugoti nustatymo');
  }
}

async function toggleStorageMode(){
  if(!state.user) return;
  if(state.migratingStorage) return;
  if(!state.online){
    offlineDialog(
      'Saugojimo keitimui reikia interneto',
      'Įrašų perkėlimui tarp įrenginio ir Galio saugyklos reikia interneto. Prisijunkite prie interneto ir bandykite dar kartą.'
    );
    return;
  }
  state.storageError = '';

  const isPremium = isPremiumUser();
  const wantsCloud = state.storageMode !== 'cloud';

  if(wantsCloud && !isPremium){
    showAppDialog(
      'Galio saugykla neprieinamas',
      'Ši funkcija prieinama Premium paskyroms.',
      'Nepavyksta perkelti įrašų į Galio saugyklą. Mano el. paštas: ' + (state.user?.email || '')
    );
    return;
  }

  const confirmMsg = wantsCloud
    ? `Perkelti įrašus į Galio saugyklą?\n\nTaip galės veikti automatiniai priminimai, o įrašus pasieksite bet kuriame įrenginyje prisijungę prie savo paskyros.`
    : `Palikti įrašus tik šiame telefone?\n\nJūsų ${state.items.length} įrašai nebebus matomi kituose įrenginiuose, o automatiniai priminimai neveiks.`;
  showConfirmDialog(
    wantsCloud ? 'Perkelti į Galio saugyklą?' : 'Laikyti tik įrenginyje?',
    confirmMsg,
    ()=>{
      if(wantsCloud){
        runStorageMigration(wantsCloud);
      }else{
        showConfirmDialog(
          'Patvirtinkite',
          'Įrašai bus pašalinti iš jūsų Galio paskyros ir liks tik šiame telefone.',
          ()=>{ rememberKeepLocal(); runStorageMigration(wantsCloud); },
          {okText:'Patvirtinti', align:'center'}
        );
      }
    },
    {okText: wantsCloud ? 'Perkelti' : 'Laikyti tik įrenginyje', align:'center'}
  );
}
// Premium means Galio cloud storage: move a Premium user's on-device records there
// automatically (no question). If a Premium user explicitly chose "keep on this device",
// respect that choice on this device.
function keepLocalKey(){ return 'galio_keep_local_' + (state.user?.uid||''); }
function rememberKeepLocal(){ try{ localStorage.setItem(keepLocalKey(), '1'); }catch(e){} }
let _autoCloudPending = false;
function autoMoveToCloud(){
  if(!state.user || state.migratingStorage || !state.online) return;
  if(!isPremiumUser() || state.storageMode !== 'local') return;
  try{ if(localStorage.getItem(keepLocalKey())) return; }catch(e){}
  // Never migrate before the on-device list has loaded, or records could be left behind.
  if(state.loadingItems){
    if(!_autoCloudPending){ _autoCloudPending = true; setTimeout(()=>{ _autoCloudPending = false; autoMoveToCloud(); }, 1000); }
    return;
  }
  runStorageMigration(true);
}

async function runStorageMigration(wantsCloud){
  const itemsToMigrate = state.items.slice();
  const hasDocumentsToMove = itemsToMigrate.some(item => !!(item.docUrl && item.docMime) || !!(item.itemPhotoUrl && item.itemPhotoMime));
  let migrationStep = wantsCloud ? 'Galio saugyklos įjungimas' : 'perkėlimas į telefoną';
  let docMoveFailures = 0;
  let retainedRemoteDocs = 0;
  toast(wantsCloud ? 'Įrašai perkeliami į Galio saugyklą...' : 'Įrašai perkeliami į telefoną...', 8000);
  state.migratingStorage = true;
  render();

  try{
    if(wantsCloud){
      migrationStep = 'Galio saugyklos įjungimas';
      const profilePatch = {
        itemCount: itemsToMigrate.length,
        storageMode: 'cloud',
      };
      await updateDoc(doc(db,'users',state.user.uid), profilePatch);
      try{
        await updateDoc(doc(db,'users',state.user.uid), { premiumDowngradeRequired: false });
      }catch(e){
        console.warn('Could not clear downgrade flag; continuing migration:', e);
      }

      if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }

      migrationStep = 'įrašų kūrimas Galio saugykloje';
      for(const item of itemsToMigrate){
        const payload = {
          name:item.name, category:item.category, shop:item.shop||'',
          purchaseDate:item.purchaseDate, warrantyEnd:item.warrantyEnd, warrantyMonths:item.warrantyMonths,
          docType:item.docType, docNumber:item.docNumber||'', notes:item.notes||'',
          notifyEnabled:true, docUrl:null, docMime:null, docFileName:null, docStoragePath:null,
          itemPhotoUrl:null, itemPhotoMime:null, itemPhotoFileName:null, itemPhotoStoragePath:null,
          createdAtMs:item.createdAtMs||Date.now(), createdAt:serverTimestamp(),
        };
        const docRef = await addDoc(collection(db,'users',state.user.uid,'warranties'), payload);
        if(item.docUrl && item.docMime){
          migrationStep = 'nuotraukų ir dokumentų perkėlimas';
          try{
            const ext = item.docMime==='application/pdf'?'pdf':(item.docMime.split('/')[1]||'jpg');
            const path = `users/${state.user.uid}/documents/${docRef.id}.${ext}`;
            const blob = await docBlobFromItem(item);
            await uploadBytes(ref(storage,path), blob, {contentType:item.docMime});
            const url = await getDownloadURL(ref(storage,path));
            await updateDoc(docRef, { docUrl:url, docMime:item.docMime, docFileName:item.docFileName, docStoragePath:path });
            if(item.docStoragePath && item.docStoragePath !== path){
              try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){}
            }
          }catch(e){
            docMoveFailures++;
            console.warn('Migration upload failed for item:', item.id, e);
          }
          migrationStep = 'įrašų kūrimas Galio saugykloje';
        }
        if(item.itemPhotoUrl && item.itemPhotoMime){
          migrationStep = 'nuotraukų ir dokumentų perkėlimas';
          try{
            const path = `users/${state.user.uid}/item-photos/${docRef.id}.jpg`;
            let url;
            if(isDataUrl(item.itemPhotoUrl)){
              url = await uploadDataUrlToStorage(path, item.itemPhotoUrl, item.itemPhotoMime);
            }else{
              const resp = await fetch(item.itemPhotoUrl);
              if(!resp.ok) throw new Error('item-photo-download-failed');
              const blob = await resp.blob();
              await uploadBytes(ref(storage,path), blob, {contentType:item.itemPhotoMime || blob.type || 'image/jpeg'});
              url = await getDownloadURL(ref(storage,path));
            }
            await updateDoc(docRef, { itemPhotoUrl:url, itemPhotoMime:item.itemPhotoMime||'image/jpeg', itemPhotoFileName:item.itemPhotoFileName||null, itemPhotoStoragePath:path });
            if(item.itemPhotoStoragePath && item.itemPhotoStoragePath !== path){
              try{ await deleteObject(ref(storage,item.itemPhotoStoragePath)); }catch(e){}
            }
          }catch(e){
            docMoveFailures++;
            console.warn('Migration item photo upload failed for item:', item.id, e);
          }
          migrationStep = 'įrašų kūrimas Galio saugykloje';
        }
      }
      migrationStep = 'vietinių įrašų užbaigimas';
      await localClear(state.user.uid);
      attachItemsListener(state.user.uid);
    }else{
      if(state.itemsUnsub){ state.itemsUnsub(); state.itemsUnsub=null; }

      migrationStep = 'įrašų perkėlimas į telefoną';
      for(const item of itemsToMigrate){
        let localDocUrl = null;
        let localDocMime = null;
        let localDocFileName = null;
        let localDocStoragePath = null;
        let localItemPhotoUrl = null;
        let localItemPhotoMime = null;
        let localItemPhotoFileName = null;
        let localItemPhotoStoragePath = null;
        if(item.docUrl){
          migrationStep = 'nuotraukų ir dokumentų perkėlimas';
          try{
            const resp = await fetch(item.docUrl);
            if(!resp.ok) throw new Error('document-download-failed');
            const blob = await resp.blob();
            localDocUrl = await new Promise((res,rej)=>{
              const r = new FileReader();
              r.onload = ()=>res(r.result);
              r.onerror = rej;
              r.readAsDataURL(blob);
            });
            localDocMime = item.docMime || blob.type || null;
            localDocFileName = item.docFileName || null;
          }catch(e){
            docMoveFailures++;
            retainedRemoteDocs++;
            localDocUrl = item.docUrl;
            localDocMime = item.docMime || null;
            localDocFileName = item.docFileName || null;
            localDocStoragePath = item.docStoragePath || null;
            console.warn('Migration download failed for item:', item.id, e);
          }
          migrationStep = 'įrašų perkėlimas į telefoną';
        }
        if(item.itemPhotoUrl){
          migrationStep = 'nuotraukų ir dokumentų perkėlimas';
          try{
            const resp = await fetch(item.itemPhotoUrl);
            if(!resp.ok) throw new Error('item-photo-download-failed');
            const blob = await resp.blob();
            localItemPhotoUrl = await new Promise((res,rej)=>{
              const r = new FileReader();
              r.onload = ()=>res(r.result);
              r.onerror = rej;
              r.readAsDataURL(blob);
            });
            localItemPhotoMime = item.itemPhotoMime || blob.type || 'image/jpeg';
            localItemPhotoFileName = item.itemPhotoFileName || null;
          }catch(e){
            docMoveFailures++;
            retainedRemoteDocs++;
            localItemPhotoUrl = item.itemPhotoUrl;
            localItemPhotoMime = item.itemPhotoMime || null;
            localItemPhotoFileName = item.itemPhotoFileName || null;
            localItemPhotoStoragePath = item.itemPhotoStoragePath || null;
            console.warn('Migration item photo download failed for item:', item.id, e);
          }
          migrationStep = 'įrašų perkėlimas į telefoną';
        }
        const localItem = {
          id: genLocalId(), name:item.name, category:item.category, shop:item.shop||'',
          purchaseDate:item.purchaseDate, warrantyEnd:item.warrantyEnd, warrantyMonths:item.warrantyMonths,
          docType:item.docType, docNumber:item.docNumber||'', notes:item.notes||'',
          notifyEnabled:true, createdAtMs:item.createdAtMs||Date.now(),
          docUrl: localDocUrl,
          docMime: localDocUrl ? localDocMime : null,
          docFileName: localDocUrl ? localDocFileName : null,
          docStoragePath: localDocStoragePath,
          itemPhotoUrl: localItemPhotoUrl,
          itemPhotoMime: localItemPhotoUrl ? localItemPhotoMime : null,
          itemPhotoFileName: localItemPhotoUrl ? localItemPhotoFileName : null,
          itemPhotoStoragePath: localItemPhotoStoragePath,
        };
        await localPut(state.user.uid, localItem);
        if(item.docStoragePath && localDocUrl && !localDocStoragePath){
          try{ await deleteObject(ref(storage,item.docStoragePath)); }catch(e){}
        }
        if(item.itemPhotoStoragePath && localItemPhotoUrl && !localItemPhotoStoragePath){
          try{ await deleteObject(ref(storage,item.itemPhotoStoragePath)); }catch(e){}
        }
        try{ await deleteDoc(doc(db,'users',state.user.uid,'warranties',item.id)); }catch(e){}
      }
      migrationStep = 'telefono režimo įjungimas';
      await updateDoc(doc(db,'users',state.user.uid), {
        itemCount: 0,
        storageMode: 'local',
      });
      try{
        await updateDoc(doc(db,'users',state.user.uid), { premiumDowngradeRequired: false });
      }catch(e){
        console.warn('Could not clear downgrade flag; continuing migration:', e);
      }
      attachItemsListener(state.user.uid);
    }
    state.storageError = '';
    const docWord = ltCount(docMoveFailures, 'dokumentą ar nuotrauką', 'dokumentus ar nuotraukas', 'dokumentų ar nuotraukų');
    const failureMessage = wantsCloud
      ? `Įrašai perkelti į Galio saugyklą, bet ${docMoveFailures} ${docWord} perkelti nepavyko. Patikrinkite įrašus.`
      : retainedRemoteDocs
        ? `Įrašai perkelti į įrenginį. ${retainedRemoteDocs} ${ltCount(retainedRemoteDocs, 'dokumentas ar nuotrauka liko', 'dokumentai ar nuotraukos liko', 'dokumentų ar nuotraukų liko')} Galio saugykloje, nes jų nepavyko saugiai atsisiųsti.`
        : `Įrašai perkelti į įrenginį, bet ${docMoveFailures} ${docWord} perkelti nepavyko. Patikrinkite įrašus.`;
    showAppDialog(
      wantsCloud ? 'Įrašai perkelti' : 'Saugojimas pakeistas',
      docMoveFailures
        ? failureMessage
        : (wantsCloud ? 'Įrašai perkelti į Galio saugyklą.' : 'Įrašai saugomi tik šiame įrenginyje.'),
      '',
      {hideSupport:true, variant:'success', align:'center', okText:'Gerai'}
    );
  }catch(e){
    console.warn('Storage mode migration error:', e);
    state.storageError = '';
    const code = e?.code || '';
    const permissionProblem = code.includes('permission-denied');
    const documentHint = hasDocumentsToMove
      ? 'Jei klaida kartosis, gali būti, kad nepavyksta perkelti dokumentų ar nuotraukų.'
      : 'Šiame perkėlime nėra dokumentų ar nuotraukų, todėl klaida ne dėl jų.';
    const message = permissionProblem
      ? `Trūksta leidimo atlikti veiksmą: ${migrationStep}. ${documentHint}`
      : `Nepavyko atlikti veiksmo: ${migrationStep}. ${documentHint}`;
    showAppDialog(
      'Nepavyko pakeisti nustatymo',
      message,
      `Nepavyko pakeisti įrašų saugojimo nustatymo.\nEl. paštas: ${state.user?.email || ''}\nVeiksmas: ${wantsCloud ? 'perkelti į Galio saugyklą' : 'laikyti tik telefone'}\nEtapas: ${migrationStep}\nKodas: ${code || 'nežinomas'}`
    );
  }finally{
    state.migratingStorage = false;
    render();
  }
}

function confirmDeleteAccount(){
  showConfirmDialog(
    'Ištrinti paskyrą?',
    'Visi jūsų duomenys (garantijos, nuotraukos) bus negrįžtamai ištrinti.',
    ()=>{
      showConfirmDialog(
        'Šis veiksmas negrįžtamas',
        'Tikrai tęsti paskyros trynimą?',
        performDeleteAccount,
        {okText:'Ištrinti negrįžtamai', align:'center'}
      );
    },
    {okText:'Tęsti', align:'center'}
  );
}
async function performDeleteAccount(){
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
      if(item.itemPhotoStoragePath){
        try{ await deleteObject(ref(storage,item.itemPhotoStoragePath)); }catch(e){ /* non-fatal */ }
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
    toast('Paskyra ištrinta ✓');
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
// Identical lines on one receipt (same product, warranty and category) become one record
// "Name × 2" with the summed price — same receipt, same dates, so separate records add nothing.
function mergeSameItems(items){
  const groups = new Map();
  for(const it of items){
    const key = [String(it.name).trim().toLowerCase(), it.warrantyMonths ?? '', it.category || ''].join('|');
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const out = [];
  for(const list of groups.values()){
    if(list.length === 1){ out.push(list[0]); continue; }
    const nums = list.map(it => parseFloat(String(it.price ?? '').replace(',', '.')));
    const usesComma = list.some(it => String(it.price ?? '').includes(','));
    let price = list[0].price;
    if(nums.every(n => Number.isFinite(n))){
      const total = nums.reduce((a, n) => a + n, 0).toFixed(2);
      price = usesComma ? total.replace('.', ',') : total;
    }
    out.push({ ...list[0], name: `${String(list[0].name).trim()} × ${list.length}`, price });
  }
  return out;
}

const TERMS_VERSION = '2026-11-08';
async function analyzeDoc(b64,mime, runId=state.analysisRunId){
  const stillCurrent = () => runId === state.analysisRunId;
  if(!state.online){
    state.docError='Dokumento nuskaitymui reikia interneto. Įveskite duomenis rankiniu būdu arba bandykite dar kartą prisijungę.';
    render();
    return;
  }
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
        mime==='application/pdf'
          ? {type:'document',source:{type:'base64',media_type:'application/pdf',data:b64}}
          : {type:'image',source:{type:'base64',media_type:mime,data:b64}},
        {type:'text',text:`Tai pirkimo dokumentas (čekis, sąskaita-faktūra ar banko išrašas). Atidžiai išanalizuok TIK tai, kas faktiškai matoma dokumente.

GRIEŽTOS TAISYKLĖS (svarbiausia):
0. Pirmiausia nuspręsk, ar nuotraukoje apskritai yra pirkimo dokumentas (čekis, sąskaita, užsakymo patvirtinimas, banko išrašas, garantinis talonas). Jei ne (pvz. žmonės, nuogumas, gyvūnai, peizažas, asmenukė, bet kuri kita nuotrauka) – isPurchaseDocument=false, items=[], visi kiti laukai null, nieko neaprašinėk.
1. NIEKADA negalvok/nespėliok informacijos, kurios nematai dokumente. Jei laukas neaiškus ar nematomas – grąžink null, NE spėjimą.
2. Pavadinimą imk TIK iš dokumento teksto (prekės eilutės), niekada negalvok pavadinimo iš konteksto ar nuojautos.
3. Jei dokumente NĖRA pardavėjo pavadinimo/rekvizitų (pvz. nufotografuota tik dalis čekio) – shop lauke grąžink null, neišgalvok parduotuvės pavadinimo.
4. Jei dokumentas neryškus, apkarpytas, ar dalis teksto neįskaitoma – privalai tai nurodyti quality lauke, nepaisant to stenkis ištraukti ką gali.
5. Jei čekyje/sąskaitoje YRA KELIOS atskiros prekės (ne paslaugos) – grąžink KIEKVIENĄ atskirai items masyve. Paslaugos (pristatymas, montavimas, garantijos pratęsimas ir pan.) NĖRA prekės – jų neįtrauk į items, bet gali paminėti notes lauke.
6. Kiekvienai prekei nurodyk, ar jai paprastai taikoma vartotojo teisinė garantija dėl prekės trūkumų pagal ES/LT teisę (warrantyApplies). Drabužiai, avalynė, aksesuarai, baldai, elektronika, technika – paprastai TAIP. Paslaugos, greitai gendantys produktai ir prekės, kurios nėra ilgalaikė vartojimo prekė, – paprastai NE.
8. Jei dokumentas yra kreditinė sąskaita-faktūra ar kitas pinigų grąžinimo pirkėjui dokumentas – prekių kainas grąžink su minuso ženklu, kaip dokumente.
7. Nepainiok garantijos su grąžinimu. Higienos, apatiniai, kosmetika ar panašios prekės gali turėti ribotą grąžinimą, bet tai savaime nepanaikina garantijos dėl broko.

Grąžink TIK JSON be markdown, šios struktūros:
{
  "isPurchaseDocument": true,
  "shop": "parduotuvės/pardavėjo pavadinimas arba null jei nematomas dokumente",
  "purchaseDate": "YYYY-MM-DD arba null",
  "returnDays": "grąžinimo terminas dienomis, pvz. 14 arba 30, arba null jei dokumente nematomas",
  "docNumber": "dokumento/kvito numeris arba null",
  "docType": "Kvitas / čekis|Sąskaita-faktūra (SF)|Banko išrašas|Kita",
  "quality": "good|blurry|partial|unclear",
  "qualityNote": "trumpas paaiškinimas jei quality nėra 'good', pvz. 'Trūksta apatinės dokumento dalies' arba null",
  "items": [
    {"name":"tikslus prekės pavadinimas iš dokumento","price":"galutinė už šią prekę sumokėta kaina po jai taikytų nuolaidų (pvz. 39,50 su nuolaida -3,95 → 35,55) arba null","warrantyMonths":24,"warrantyApplies":true,"category":"Elektronika|Buitinė technika|Įrankiai ir sodas|Avalynė / drabužiai|Baldai|Sportas ir laisvalaikis|Auto prekės|Kita"}
  ]
}
warrantyMonths kiekvienai prekei:
- jei warrantyApplies=true, įprastai grąžink 24 mėn. kaip ES/LT teisinę garantiją dėl prekės trūkumų;
- netrumpink garantijos pagal gamintojo ar parduotuvės komercinę garantiją, ypač jei informacija gali būti skirta ne Lietuvos rinkai;
- jei dokumente aiškiai matomas ilgesnis garantijos terminas, grąžink ilgesnį terminą;
- jei warrantyApplies=false, warrantyMonths=null.
price: jei po prekės eilute yra nuolaida (pvz. „Nuolaida -3,95“, „-30%“), atimk ją iš tos prekės kainos. Bendros čekio nuolaidos neskirstyk.
returnDays: jei dokumente matosi grąžinimo terminas (pvz. "30 dienų", "return within 30 days"), grąžink tą skaičių. Jei terminas nematomas, grąžink null.
category kiekvienai prekei: viena iš: Elektronika, Buitinė technika, Įrankiai ir sodas (įrankiai, sodo technika, statybos prekės), Avalynė / drabužiai, Baldai, Sportas ir laisvalaikis (sporto prekės, išmanieji laikrodžiai, dviračiai, žaislai), Auto prekės (padangos, auto priedai), Kita.
Jei items sąraše nieko neradai (pvz. visiškai neįskaitoma), grąžink tuščią masyvą [].`}
      ]}]})
    });
    if(!stillCurrent()) return;
    if(res.status===401){toast('Sesija pasibaigė, prisijunkite iš naujo');return;}
    if(res.status===403){toast('Patvirtinkite el. paštą, kad naudotumėte AI analizę');return;}
    if(res.status===429){let m='Pasiektas AI analizių limitas';try{m=(await res.json()).error||m;}catch(e){}toast(m,6000);return;}
    if(!res.ok)return;

    await chargeAiUsageNow();
    if(!stillCurrent()) return;
    state.pendingAiCharge = false;

    const data=await res.json();
    if(!stillCurrent()) return;
    const p=JSON.parse((data.content||[]).map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());

    // Not a purchase document (a selfie, a random or inappropriate photo): drop the image so it
    // is never attached to the entry or uploaded to Galio storage.
    if(p.isPurchaseDocument===false){
      state.form.docData=null; state.form.docMime=null; state.form.docFileName=null;
      state.form.qualityWarning=null;
      state.docError='Pirkimo dokumentas nerastas';
      return;
    }

    // Quality warning — surfaced to the user, not silently swallowed.
    if(p.quality && p.quality!=='good'){
      const qualityLabels = {blurry:'Nuotrauka neryški',partial:'Matomas ne visas dokumentas',unclear:'Tekstas sunkiai įskaitomas'};
      state.form.qualityWarning = `${qualityLabels[p.quality]||'Dokumento kokybė nepakankama'}${p.qualityNote?': '+p.qualityNote:''}`;
    }

    const items = mergeSameItems(Array.isArray(p.items) ? p.items.filter(it=>it && typeof it.name==='string' && it.name.trim()) : []);

    // A credit note (money back for a returned item) is not a purchase: no warranty entry for it.
    const priceNum = v => { const n = parseFloat(String(v??'').replace(/\s/g,'').replace(',', '.').replace(/[^0-9.\-]/g,'')); return isNaN(n) ? null : n; };
    const isCredit = items.length>0 && items.every(it => { const n = priceNum(it.price); return n!==null && n<0; });
    if(isCredit){
      state.form = emptyForm(); state.docError=''; state.addMode=null; state.view='list';
      state.multiItemReceipt = null;
      showAppDialog('Kreditinė sąskaita', 'Šis dokumentas – kreditinė sąskaita, t. y. pinigų grąžinimas už prekę. Garantijos įrašas jam nekuriamas. Jei prekę grąžinote, jos įrašą sąraše galite ištrinti.', '', {hideSupport:true});
      return;
    }

    if(items.length===0){
      // Nothing usable was recognized — don't silently fabricate a name.
      toast('AI nerado atpažįstamos prekės šiame dokumente. Įveskite duomenis rankiniu būdu.');
      if(typeof p.shop==='string')state.form.shop=p.shop.slice(0,100);
      if(typeof p.purchaseDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.purchaseDate))state.form.purchaseDate=p.purchaseDate;
      state.form.returnDays=normalizeReturnDays(p.returnDays, p.shop);
      if(DOC_TYPES.includes(p.docType))state.form.docType=p.docType;
      return;
    }

    if(!state._fromShare) maybeShareTip();
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
      const duplicateCount = items.filter(it=>findDuplicateItem({
        name: it.name,
        shop: p.shop,
        purchaseDate: p.purchaseDate,
        docNumber: p.docNumber,
      })).length;
      if(duplicateCount){
        showAppDialog(
          'Dokumentas jau išsaugotas',
          `Šio dokumento prekės jau yra garantijų sąraše. Norėdami pakeisti informaciją, redaguokite esamus įrašus.`,
          '',
          {hideSupport:true}
        );
      }
      state.multiItemReceipt = {
        items: items.map(it=>({...it, _shop:p.shop, _purchaseDate:p.purchaseDate, _returnDays:normalizeReturnDays(p.returnDays, p.shop), _docType:p.docType, _docNumber:p.docNumber, selected:it.warrantyApplies!==false})),
        shop: p.shop, purchaseDate: p.purchaseDate, returnDays: normalizeReturnDays(p.returnDays, p.shop), docType: p.docType, docNumber: p.docNumber,
        docData: state.form.docData, docMime: state.form.docMime, docFileName: state.form.docFileName, docThumb: state.form.docThumb||null,
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
  state.form.returnDays=normalizeReturnDays(receiptMeta.returnDays, receiptMeta.shop);
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
