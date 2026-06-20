// Local-only storage layer using IndexedDB.
// Used when storageMode === 'local': documents and warranty data never
// touch Firestore/Storage, everything lives only on this device.
'use strict';

const DB_VERSION = 1;
const STORE = 'warranties';

// SECURITY: the database is namespaced per Firebase user UID, not a single
// shared database for the whole browser origin. If this were one shared
// database, a second person signing into a *different* account on the same
// device/browser (e.g. a shared family tablet, or signing out and a friend
// signing in) would be able to read the first person's locally-stored
// warranty data and document photos — IndexedDB does not auto-clear on
// signOut() and isn't otherwise scoped to "who's currently logged in".
// Per-uid database names close that gap: each account only ever opens its
// own database, and other accounts' data simply isn't reachable from it.
function dbNameFor(uid) {
  if (!uid) throw new Error('localDb: missing uid — refusing to open an unscoped database');
  return 'galio_local_db_' + uid;
}

const openPromises = new Map();

function openDb(uid) {
  const name = dbNameFor(uid);
  if (openPromises.has(name)) return openPromises.get(name);
  const p = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAtMs', 'createdAtMs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  openPromises.set(name, p);
  return p;
}

export async function localGetAll(uid) {
  const db = await openDb(uid);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function localPut(uid, item) {
  const db = await openDb(uid);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve(item);
    tx.onerror = () => reject(tx.error);
  });
}

export async function localDelete(uid, id) {
  const db = await openDb(uid);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function localClear(uid) {
  const db = await openDb(uid);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Fully deletes this user's local database (used on account deletion, so
// that "delete my account" actually removes locally-stored data too, not
// just the Firestore profile doc).
export async function localDeleteDatabase(uid) {
  const name = dbNameFor(uid);
  openPromises.delete(name);
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve(); // best-effort; don't block account deletion on this
    req.onblocked = () => resolve();
  });
}

// Generates a locally-unique id, same shape as a Firestore doc id would be
// (timestamp + random suffix) so the rest of the app's code (which expects
// item.id) doesn't need to branch on storage mode.
export function genLocalId() {
  return 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}
