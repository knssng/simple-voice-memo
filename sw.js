// オフライン用のアプリ本体キャッシュ。ファイル更新時は VERSION を上げる。
const VERSION = 'v5';
const CACHE = `voicememo-${VERSION}`;
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'zip.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
// ネットワーク優先・失敗時キャッシュ（更新がすぐ反映されるように）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // ブラウザのHTTPキャッシュを使わず毎回サーバーに確認する（更新がすぐ反映されるように）
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
