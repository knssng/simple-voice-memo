// オフライン用のアプリ本体キャッシュ + 並列計算用のヘッダー付与。ファイル更新時は VERSION を上げる。
const VERSION = 'v13';
const PREFIX = 'voicememo-';
const CACHE = `${PREFIX}${VERSION}`;
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'zip.js', 'whisper-worker.js', 'sensevoice-worker.js', 'lib/transformers.min.js', 'lib/ort.webgpu.min.mjs', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // 古いアプリ本体のキャッシュだけを消す（文字起こしモデルの 'transformers-cache' / 'sensevoice-cache' は残す）
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/*
 * クロスオリジン分離（COOP/COEP）ヘッダーを付ける。
 * GitHub Pages ではサーバーのヘッダーを設定できないため、ここで付与して SharedArrayBuffer を有効にし、
 * 文字起こしを複数スレッドで並列計算できるようにする。
 */
function withIsolation(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// ネットワーク優先・失敗時キャッシュ（更新がすぐ反映されるように）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // ブラウザのHTTPキャッシュを使わず毎回サーバーに確認する（更新がすぐ反映されるように）
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return withIsolation(res);
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(withIsolation)),
  );
});
