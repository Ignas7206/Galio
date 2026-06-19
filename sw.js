const CACHE = 'garantijos-v4';
const BASE = '/Garantija';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/app.js',
  BASE + '/firebase-config.js',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Never cache Firebase, Anthropic, or Cloudflare Worker calls
  if (url.includes('googleapis.com') || url.includes('firebaseapp.com') ||
      url.includes('firebasestorage') || url.includes('gstatic.com') ||
      url.includes('api.anthropic.com') || url.includes('workers.dev')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => caches.match(BASE + '/index.html')))
  );
});
