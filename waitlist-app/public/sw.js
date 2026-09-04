// Pho Ha Noi Staff — service worker. Network-first for the app shell so staff
// always get the latest code online, with a cached fallback for offline. Live
// data (/api/*) and the Management app (cross-origin) always go to the network.
const CACHE = 'phn-staff-v4';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/brand.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // Management API etc. → network
  if (url.pathname.startsWith('/api/')) return;         // live data → network
  e.respondWith(
    fetch(req)
      .then((res) => { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); return res; })
      .catch(() => caches.match(req).then((c) => c || caches.match('/')))
  );
});
