// Uygulama kabuğunu önbelleğe alır: bir kez açıldıktan sonra sayfa internetsiz de yüklenir
// (çeviri için yine internet gerekir). Yeni sürüm yayınlanınca SURUM'ü artırın.
const SURUM = 'v2';
const DOSYALAR = ['./', 'index.html', 'app.js', 'yakala-worklet.js', 'vendor/anthropic.js',
  'manifest.webmanifest', 'ikon.svg', 'ikon-180.png', 'ikon-192.png', 'ikon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SURUM).then(c => c.addAll(DOSYALAR.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(x => x !== SURUM).map(x => caches.delete(x))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;  // API çağrılarına dokunma
  // önce önbellek (hızlı açılış), arka planda güncelle
  e.respondWith(caches.open(SURUM).then(async c => {
    const eski = await c.match(e.request, { ignoreSearch: true });
    const yeni = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => eski);
    return eski || yeni;
  }));
});
