/* RF Creative: funciona offline e abre rápido. Com internet, sempre busca a versão mais nova. */
const CACHE = 'rf-creative-v3';
const BASE = ['./', 'index.html', 'manifest.webmanifest', 'logo-horizontal.svg', 'icon-192.png', 'icon-512.png', 'supabase-config.js', 'rf-nuvem.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  const mesmo = u.origin === location.origin;
  const sdk = /cdn\.jsdelivr\.net\/npm\/@supabase|fonts\.(googleapis|gstatic)\.com/.test(u.href);
  if (!mesmo && !sdk) return; /* banco de dados e login passam direto */
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
