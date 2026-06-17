'use strict';

const STORAGE_KEY    = 'garantijos_v1';
const AUTH_KEY       = 'garantijos_session';
const BRUTE_KEY      = 'garantijos_brute';
const WORKER_URL     = 'https://muddy-sea-0563.ignas7206.workers.dev';
const CATEGORIES     = ['Elektronika', 'Buitinė technika', 'Avalynė / drabužiai', 'Baldai', 'Automobiliai', 'Kita'];
const ALLOWED_MIME   = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_IMG_BYTES  = 4 * 1024 * 1024; // 4MB
const MAX_ATTEMPTS   = 5;
const LOCKOUT_MS     = 5 * 60 * 1000; // 5 min

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  view: 'list',
  items: [],
  selected: null,
  search: '',
  filterCat: 'Visos',
  sortBy: 'name',
  form: emptyForm(),
  imagePreview: null,
  analyzing: false,
  authenticated: false,
  pwdError: '',
  imgError: '',
};

function emptyForm() {
  return { name: '', category: 'Elektronika', purchaseDate: '', warrantyEnd: '', shop: '', notes: '', imageData: null };
}

// ── SHA-256 ────────────────────────────────────────────────────────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// Session token – random hex stored in sessionStorage (clears on tab close)
function genToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Brute-force protection ─────────────────────────────────────────────────
function getBrute() {
  try { return JSON.parse(localStorage.getItem(BRUTE_KEY)) || { attempts: 0, lockedUntil: 0 }; }
  catch { return { attempts: 0, lockedUntil: 0 }; }
}
function setBrute(b) { localStorage.setItem(BRUTE_KEY, JSON.stringify(b)); }
function resetBrute() { localStorage.removeItem(BRUTE_KEY); }

function bruteStatus() {
  const b = getBrute();
  const now = Date.now();
  if (b.lockedUntil > now) {
    const secs = Math.ceil((b.lockedUntil - now) / 1000);
    return { locked: true, secs };
  }
  return { locked: false, attempts: b.attempts };
}

// ── Auth ───────────────────────────────────────────────────────────────────
// Hardcoded password hash – only owner knows the password
const CORRECT_HASH = 'b9cf4364491e63cac7f0668fd4df6457ba29575537bcae6be2c265d05bb926dc';

async function checkAuth() {
  const token = sessionStorage.getItem(AUTH_KEY);
  const tokenHash = localStorage.getItem(AUTH_KEY + '_hash');
  if (token && tokenHash && await sha256(token) === tokenHash) {
    state.authenticated = true;
  }
}

async function tryLogin(password) {
  const bs = bruteStatus();
  if (bs.locked) { state.pwdError = `Per daug bandymų. Palaukite ${bs.secs}s.`; render(); return; }
  if (!password) { state.pwdError = 'Įveskite slaptažodį'; render(); return; }

  const hash = await sha256(password);
  if (hash === CORRECT_HASH) {
    resetBrute();
    await createSession();
  } else {
    const b = getBrute();
    b.attempts = (b.attempts || 0) + 1;
    if (b.attempts >= MAX_ATTEMPTS) {
      b.lockedUntil = Date.now() + LOCKOUT_MS;
      b.attempts = 0;
      state.pwdError = `Per daug bandymų. Užblokuota 5 minutėms.`;
    } else {
      state.pwdError = `Neteisingas slaptažodis (${b.attempts}/${MAX_ATTEMPTS} bandymų)`;
    }
    setBrute(b);
    render();
  }
}

async function createSession() {
  const token = genToken();
  const tokenHash = await sha256(token);
  sessionStorage.setItem(AUTH_KEY, token);
  localStorage.setItem(AUTH_KEY + '_hash', tokenHash);
  state.authenticated = true;
  state.pwdError = '';
  render();
}

function logout() {
  sessionStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(AUTH_KEY + '_hash');
  state.authenticated = false;
  render();
}

// ── Persist ────────────────────────────────────────────────────────────────
function load() {
  try { state.items = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { state.items = []; }
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items)); } catch(e) {
    if (e.name === 'QuotaExceededError') alert('Vieta telefone baigiasi! Ištrinkite kai kurias nuotraukas.');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function daysLeft(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / 86400000);
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('lt-LT');
}
function badgeHtml(days) {
  if (days === null) return '';
  if (days < 0)   return `<span class="badge badge-exp">Baigėsi</span>`;
  if (days <= 30) return `<span class="badge badge-warn">${days}d. liko</span>`;
  return `<span class="badge badge-ok">${days}d. liko</span>`;
}
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function safeId(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('root');
  if (!state.authenticated) { root.innerHTML = renderLogin(); attachLoginEvents(); return; }
  if (state.view === 'list')   root.innerHTML = renderList();
  if (state.view === 'add')    root.innerHTML = renderAdd();
  if (state.view === 'detail') root.innerHTML = renderDetail();
  attachEvents();
}

// ── Login view ─────────────────────────────────────────────────────────────
function renderLogin() {
  const bs = bruteStatus();
  return `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
      <div style="width:100%;max-width:320px">
        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:48px;margin-bottom:12px">🛡️</div>
          <h1 style="font-size:22px;font-weight:600;color:var(--text);margin-bottom:6px">Garantijos</h1>
          <p style="font-size:14px;color:var(--text2)">Įveskite slaptažodį</p>
        </div>
        <div style="background:var(--bg);border:0.5px solid var(--border);border-radius:16px;padding:24px">
          <input type="password" id="pwdInput" placeholder="Slaptažodis" autofocus ${bs.locked ? 'disabled' : ''}
            style="width:100%;box-sizing:border-box;border-radius:10px;border:0.5px solid ${state.pwdError ? 'var(--red)' : 'var(--border2)'};background:var(--bg2);font-size:16px;padding:12px;color:var(--text);margin-bottom:${state.pwdError ? '8px' : '12px'}" />
          ${state.pwdError ? `<p style="font-size:13px;color:var(--red);margin-bottom:12px;text-align:center">${esc(state.pwdError)}</p>` : ''}
          <button id="loginBtn" ${bs.locked ? 'disabled' : ''} style="width:100%;background:var(--text);color:var(--bg);border:none;border-radius:12px;padding:14px;font-size:15px;font-weight:500;cursor:${bs.locked ? 'not-allowed' : 'pointer'};opacity:${bs.locked ? '0.5' : '1'}">
            Prisijungti
          </button>
        </div>
      </div>
    </div>`;
}

function attachLoginEvents() {
  const btn = document.getElementById('loginBtn');
  const inp = document.getElementById('pwdInput');
  if (btn) btn.addEventListener('click', () => tryLogin(inp?.value || ''));
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(inp.value); });
}

// ── List view ──────────────────────────────────────────────────────────────
function renderList() {
  const { items, search, filterCat, sortBy } = state;
  const expired  = items.filter(i => { const d = daysLeft(i.warrantyEnd); return d !== null && d < 0; }).length;
  const expiring = items.filter(i => { const d = daysLeft(i.warrantyEnd); return d !== null && d >= 0 && d <= 30; }).length;
  const valid    = items.length - expired;

  const filtered = items
    .filter(i => {
      const q = search.toLowerCase();
      return (i.name.toLowerCase().includes(q) || (i.shop||'').toLowerCase().includes(q) || (i.notes||'').toLowerCase().includes(q));
    })
    .filter(i => filterCat === 'Visos' || i.category === filterCat)
    .sort((a, b) => {
      if (sortBy === 'name')     return a.name.localeCompare(b.name, 'lt');
      if (sortBy === 'expiring') { const da = daysLeft(a.warrantyEnd)??99999, db = daysLeft(b.warrantyEnd)??99999; return da - db; }
      if (sortBy === 'newest')   return b.id - a.id;
      return 0;
    });

  const statsHtml = items.length > 0 ? `
    <div class="stats">
      <div class="stat-card" style="background:var(--green-bg)"><div class="num" style="color:var(--green)">${valid}</div><div class="lbl" style="color:var(--green)">Galioja</div></div>
      <div class="stat-card" style="background:var(--orange-bg)"><div class="num" style="color:var(--orange)">${expiring}</div><div class="lbl" style="color:var(--orange)">Baigiasi</div></div>
      <div class="stat-card" style="background:var(--red-bg)"><div class="num" style="color:var(--red)">${expired}</div><div class="lbl" style="color:var(--red)">Baigėsi</div></div>
    </div>` : '';

  const filtersHtml = ['Visos', ...CATEGORIES].map(c =>
    `<button class="filter-chip${filterCat===c?' active':''}" data-filter="${esc(c)}">${esc(c)}</button>`
  ).join('');

  const sortHtml = items.length > 1 ? `
    <div class="sort-row">
      <span>Rikiuoti:</span>
      <button class="sort-chip${sortBy==='name'?' active':''}" data-sort="name">A–Z</button>
      <button class="sort-chip${sortBy==='expiring'?' active':''}" data-sort="expiring">Baigiasi greičiau</button>
      <button class="sort-chip${sortBy==='newest'?' active':''}" data-sort="newest">Naujausi</button>
    </div>` : '';

  const emptyHtml = items.length === 0 ? `
    <div class="empty">
      <i class="ti ti-shield-check"></i>
      <h3>Dar nėra garantijų</h3>
      <p>Pridėkite pirmą daiktą ir įkelkite pirkimo čekį</p>
      <button class="btn-primary" id="addFirst"><i class="ti ti-plus"></i> Pridėti daiktą</button>
    </div>` : '';

  const noResultsHtml = filtered.length === 0 && items.length > 0
    ? `<p style="text-align:center;color:var(--text2);font-size:14px;margin-top:40px">Nieko nerasta.</p>` : '';

  const cardsHtml = filtered.map(item => {
    const days = daysLeft(item.warrantyEnd);
    const thumb = item.imageData
      ? `<img class="item-thumb" src="${esc(item.imageData)}" alt="" loading="lazy" />`
      : `<div class="item-icon"><i class="ti ti-receipt"></i></div>`;
    return `
      <div class="item-card" data-id="${esc(String(item.id))}">
        ${thumb}
        <div class="item-info">
          <div class="item-top">
            <span class="item-name">${esc(item.name)}</span>
            ${badgeHtml(days)}
          </div>
          <div class="item-meta">${esc(item.shop||'')}${item.shop?' · ':''}${esc(item.category)}</div>
          ${item.warrantyEnd ? `<div class="item-date"><i class="ti ti-calendar" style="font-size:12px;margin-right:4px;vertical-align:-1px"></i>Garantija iki ${fmtDate(item.warrantyEnd)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="view">
      <div class="header">
        <div class="header-row">
          <div>
            <h1>Mano garantijos</h1>
            <div class="subtitle">${items.length} daiktas${items.length===1?'':' (-ai)'} išsaugota</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="logoutBtn" title="Atsijungti" style="background:none;border:0.5px solid var(--border2);border-radius:8px;padding:7px 9px;cursor:pointer;color:var(--text2)"><i class="ti ti-logout" style="font-size:16px"></i></button>
            <button class="btn-primary" id="addBtn"><i class="ti ti-plus"></i> Pridėti</button>
          </div>
        </div>
        ${statsHtml}
        <div class="search-wrap">
          <i class="ti ti-search"></i>
          <input type="search" id="searchInput" placeholder="Ieškoti..." value="${esc(search)}" />
        </div>
        <div class="filter-row">${filtersHtml}</div>
      </div>
      ${sortHtml}
      <div class="item-list">${emptyHtml}${cardsHtml}${noResultsHtml}</div>
    </div>`;
}

// ── Add view ───────────────────────────────────────────────────────────────
function renderAdd() {
  const f = state.form;
  const imgHtml = state.imagePreview
    ? `<img src="${esc(state.imagePreview)}" alt="Čekis" />`
    : `<div class="img-upload-placeholder">
         <i class="ti ti-camera"></i>
         <p>Įkelkite čekio nuotrauką</p>
         <small>AI automatiškai ištrauks informaciją</small>
       </div>`;

  const analyzingHtml = state.analyzing
    ? `<div class="analyzing"><div class="spinner"></div><span style="font-size:13px;color:var(--text2)">AI analizuoja čekį...</span></div>` : '';

  const imgErrHtml = state.imgError
    ? `<p style="font-size:12px;color:var(--red);margin-top:6px">${esc(state.imgError)}</p>` : '';

  const catOptions = CATEGORIES.map(c => `<option${c===f.category?' selected':''}>${esc(c)}</option>`).join('');

  return `
    <div class="view">
      <div class="header" style="display:flex;align-items:center;gap:10px;padding:16px;">
        <button class="btn-back" id="backBtn"><i class="ti ti-arrow-left" style="font-size:20px"></i></button>
        <h1 style="font-size:17px">Naujas daiktas</h1>
      </div>
      <div class="form-wrap">
        <div class="field">
          <label>Čekis / sąskaita</label>
          <label class="img-upload">
            ${imgHtml}
            <input type="file" id="imgInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" style="display:none" />
          </label>
          ${imgErrHtml}
          ${analyzingHtml}
        </div>
        <div class="field"><label>Pavadinimas *</label><input type="text" id="f_name" placeholder='pvz. Samsung TV 55"' value="${esc(f.name)}" autocomplete="off" /></div>
        <div class="field"><label>Parduotuvė</label><input type="text" id="f_shop" placeholder="pvz. Pigu.lt, Euronics..." value="${esc(f.shop)}" autocomplete="off" /></div>
        <div class="field"><label>Pirkimo data</label><input type="date" id="f_purchaseDate" value="${esc(f.purchaseDate)}" /></div>
        <div class="field"><label>Garantija galioja iki</label><input type="date" id="f_warrantyEnd" value="${esc(f.warrantyEnd)}" /></div>
        <div class="field"><label>Kategorija</label><select id="f_category">${catOptions}</select></div>
        <div class="field"><label>Pastabos</label><textarea id="f_notes" rows="3" placeholder="Papildoma informacija...">${esc(f.notes)}</textarea></div>
        <button class="btn-save" id="saveBtn" ${f.name.trim()?'':'disabled'}>Išsaugoti</button>
      </div>
    </div>`;
}

// ── Detail view ────────────────────────────────────────────────────────────
function renderDetail() {
  const item = state.items.find(i => i.id === state.selected);
  if (!item) { state.view = 'list'; render(); return ''; }
  const days = daysLeft(item.warrantyEnd);

  let statusBg, statusColor, statusIcon, statusText;
  if (days === null)   { statusBg='var(--bg2)'; statusColor='var(--text2)'; statusIcon='ti-shield'; statusText='Nenurodyta'; }
  else if (days < 0)   { statusBg='var(--red-bg)'; statusColor='var(--red)'; statusIcon='ti-shield-x'; statusText='Garantija baigėsi'; }
  else if (days <= 30) { statusBg='var(--orange-bg)'; statusColor='var(--orange)'; statusIcon='ti-shield-exclamation'; statusText=`Liko ${days} dienos`; }
  else                 { statusBg='var(--green-bg)'; statusColor='var(--green)'; statusIcon='ti-shield-check'; statusText=`Liko ${days} dienos`; }

  const imgHtml = item.imageData
    ? `<img src="${esc(item.imageData)}" alt="Čekis" style="width:100%;border-radius:12px;max-height:240px;object-fit:cover;margin-bottom:16px" />` : '';

  const rows = [
    { icon:'ti-tag', label:'Pavadinimas', val: item.name },
    { icon:'ti-building-store', label:'Parduotuvė', val: item.shop||'—' },
    { icon:'ti-category', label:'Kategorija', val: item.category },
    { icon:'ti-calendar', label:'Pirkimo data', val: fmtDate(item.purchaseDate) },
    { icon:'ti-calendar-due', label:'Garantija iki', val: fmtDate(item.warrantyEnd) },
  ].map(r => `
    <div class="detail-row">
      <i class="ti ${r.icon}"></i>
      <span class="dl">${esc(r.label)}</span>
      <span class="dv">${esc(r.val)}</span>
    </div>`).join('');

  const notesHtml = item.notes ? `
    <div class="notes-box">
      <div class="notes-lbl">Pastabos</div>
      <p>${esc(item.notes)}</p>
    </div>` : '';

  return `
    <div class="view">
      <div class="detail-header">
        <button class="btn-back" id="backBtn"><i class="ti ti-arrow-left" style="font-size:20px"></i></button>
        <h2>${esc(item.name)}</h2>
        <button class="btn-back" id="deleteBtn" style="color:var(--red)"><i class="ti ti-trash" style="font-size:20px"></i></button>
      </div>
      <div style="padding:16px">
        ${imgHtml}
        <div class="status-card" style="background:${statusBg}">
          <div>
            <div class="status-label" style="color:${statusColor}">Garantijos statusas</div>
            <div class="status-val" style="color:${statusColor}">${statusText}</div>
          </div>
          <i class="ti ${statusIcon}" style="font-size:32px;color:${statusColor}"></i>
        </div>
        <div class="detail-rows">${rows}</div>
        ${notesHtml}
        <button class="btn-danger" id="deleteBtn2"><i class="ti ti-trash" style="margin-right:6px;vertical-align:-1px"></i>Ištrinti</button>
      </div>
    </div>`;
}

// ── Events ─────────────────────────────────────────────────────────────────
function attachEvents() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  const onAll = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));

  on('addBtn',      'click', () => { state.form = emptyForm(); state.imagePreview = null; state.imgError = ''; state.view = 'add'; render(); });
  on('addFirst',    'click', () => { state.form = emptyForm(); state.imagePreview = null; state.imgError = ''; state.view = 'add'; render(); });
  on('searchInput', 'input', e => { state.search = e.target.value; render(); });
  on('logoutBtn',   'click', () => { if (confirm('Atsijungti?')) logout(); });
  on('backBtn',     'click', () => { state.view = 'list'; render(); });
  on('imgInput',    'change', handleImageUpload);

  onAll('.filter-chip', 'click', e => { state.filterCat = e.target.dataset.filter; render(); });
  onAll('.sort-chip',   'click', e => { state.sortBy = e.target.dataset.sort; render(); });
  onAll('.item-card',   'click', e => {
    const id = safeId(e.currentTarget.dataset.id);
    if (id === null) return;
    state.selected = id; state.view = 'detail'; render();
  });

  ['name','shop','purchaseDate','warrantyEnd','category','notes'].forEach(k => {
    on(`f_${k}`, 'input',  e => { state.form[k] = e.target.value; syncSaveBtn(); });
    on(`f_${k}`, 'change', e => { state.form[k] = e.target.value; syncSaveBtn(); });
  });

  on('saveBtn',    'click', saveItem);
  on('deleteBtn',  'click', () => deleteItem(state.selected));
  on('deleteBtn2', 'click', () => deleteItem(state.selected));
}

function syncSaveBtn() {
  const btn = document.getElementById('saveBtn');
  if (btn) btn.disabled = !state.form.name.trim();
}

function deleteItem(id) {
  if (!confirm('Ištrinti šį įrašą?')) return;
  state.items = state.items.filter(i => i.id !== id);
  persist();
  state.view = 'list';
  render();
}

function saveItem() {
  if (!state.form.name.trim()) return;
  state.items.unshift({ ...state.form, id: Date.now() });
  persist();
  state.form = emptyForm();
  state.imagePreview = null;
  state.imgError = '';
  state.view = 'list';
  render();
}

// ── Image + AI ─────────────────────────────────────────────────────────────
function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Validate MIME type
  if (!ALLOWED_MIME.includes(file.type)) {
    state.imgError = 'Leidžiami tik JPEG, PNG, WebP, HEIC formatai';
    render(); return;
  }

  // Validate size
  if (file.size > MAX_IMG_BYTES) {
    state.imgError = `Nuotrauka per didelė (max 4MB, jūsų: ${(file.size/1024/1024).toFixed(1)}MB)`;
    render(); return;
  }

  state.imgError = '';
  const reader = new FileReader();
  reader.onload = async ev => {
    const dataUrl = ev.target.result;
    // Double-check it's a real image by trying to load it
    const img = new Image();
    img.onload = async () => {
      const base64 = dataUrl.split(',')[1];
      state.imagePreview = dataUrl;
      state.form.imageData = dataUrl;
      state.analyzing = true;
      render();
      await analyzeReceipt(base64, file.type);
      state.analyzing = false;
      render();
    };
    img.onerror = () => {
      state.imgError = 'Failas neatpažintas kaip nuotrauka';
      render();
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

async function analyzeReceipt(base64, mimeType) {
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: `Tai yra pirkimo čekis arba sąskaita. Ištraukite informaciją ir grąžinkite TIK JSON (be paaiškinimų, be markdown):
{"name":"produkto pavadinimas","shop":"parduotuvė","purchaseDate":"YYYY-MM-DD arba null","price":"kaina su valiuta arba null","notes":"trumpas aprašymas"}
Jei informacijos nėra – naudokite null.` }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`Worker klaida: ${res.status}`);
    const data = await res.json();
    const text  = (data.content || []).map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const p = JSON.parse(clean);
    // Only accept string values, not arbitrary objects
    if (p.name && typeof p.name === 'string')         state.form.name = p.name.slice(0, 200);
    if (p.shop && typeof p.shop === 'string')         state.form.shop = p.shop.slice(0, 100);
    if (p.purchaseDate && typeof p.purchaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.purchaseDate))
      state.form.purchaseDate = p.purchaseDate;
    const notesParts = [p.price ? `Kaina: ${String(p.price).slice(0,50)}` : '', typeof p.notes === 'string' ? p.notes.slice(0,500) : ''].filter(Boolean);
    if (notesParts.length) state.form.notes = notesParts.join('\n');
  } catch (err) {
    console.warn('AI analizė nepavyko:', err);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
load();
checkAuth().then(() => render());
