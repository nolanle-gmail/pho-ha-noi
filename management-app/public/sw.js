// Pho Ha Noi Management — service worker. Network-first for the app shell so the
// console always loads the latest code online, with a cached fallback offline.
// Live data (/api/*) always goes to the network.
const CACHE = 'phn-mgmt-v14';
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
  if (url.origin !== location.origin) return;      // external calls → network
  if (url.pathname.startsWith('/api/')) return;     // live data → network
  e.respondWith(
    fetch(req)
      .then((res) => { const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); return res; })
      .catch(() => caches.match(req).then((c) => c || caches.match('/')))
  );
});

// ── Web Push: a real OS notification, even when the console is closed ──────────
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const title = d.title || 'Phở Hà Nội';
  const opts = {
    body: d.body || 'You have a new notification.',
    tag: d.tag || 'phn',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [120, 60, 120],
    data: { url: d.url || '/' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) { try { if (c.navigate) await c.navigate(target); } catch { /* cross-scope */ } return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
