const CACHE = 'galio-v4';
const BASE = '/Galio';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/app.js',
  BASE + '/firebase-config.js',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
  BASE + '/privacy.html',
  BASE + '/terms.html',
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
  if (url.includes('googleapis.com') || url.includes('firebaseapp.com') ||
      url.includes('firebasestorage') || url.includes('gstatic.com') ||
      url.includes('api.anthropic.com') || url.includes('workers.dev')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => caches.match(BASE + '/index.html')))
  );
});

// ── FCM Background Push pranešimai ────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBHYfvHY2Bs0xPcwdjlQ86uYWGGH9NITLM",
  authDomain: "garantijos-4f397.firebaseapp.com",
  projectId: "garantijos-4f397",
  storageBucket: "garantijos-4f397.firebasestorage.app",
  messagingSenderId: "178623389138",
  appId: "1:178623389138:web:b0cfa084fec80b80b7fc0b"
});

const messagingSW = firebase.messaging();

// Tvarko pranešimus kai app'as uždarytas
messagingSW.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'Galio', {
    body: body || '',
    icon: BASE + '/icon-192.png',
    badge: BASE + '/icon-192.png',
    tag: payload.data?.tag || 'galio-notif',
    requireInteraction: true,
    data: { url: 'https://ignas7206.github.io/Galio/' },
  });
});

// Paspaudus pranešimą — atidaryti programėlę
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || 'https://ignas7206.github.io/Galio/';
  e.waitUntil(clients.matchAll({ type: 'window' }).then(wins => {
    for (const w of wins) {
      if (w.url.includes('Galio') && 'focus' in w) return w.focus();
    }
    return clients.openWindow(url);
  }));
});
