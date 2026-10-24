// Offline app shell. Bump VERSION when you deploy changes.
const VERSION = 'art-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest', 'src/app.js', 'src/data.js', 'src/care.js',
  'vendor/supabase.js', 'data/seed.json', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('art-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;     // Supabase API goes straight to the network
  // network first (fresh code when online); cache when offline, or when the network is very slow (4 s) and we have a copy
  const cached = () => caches.match(e.request, { ignoreSearch: true });
  e.respondWith(new Promise((resolve) => {
    let done = false; const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => cached().then(finish), 4000);
    fetch(e.request, { cache: 'no-cache' }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      clearTimeout(timer); finish(r);
    }).catch(() => { clearTimeout(timer); cached().then((r) => finish(r || Response.error())); });
  }));
});
