const CACHE_PREFIX = 'qianchuan-v4-';
const CACHE_NAME = CACHE_PREFIX + 'v28';
const ASSETS = [
  "/v4",
  "/v4/v4.css",
  "/v4/shared.js",
  "/v4/v4.js",
  "/v4/demo-data.js?v=21",
  "/v4/view-effects.js?v=12",
  "/v4/account-ui-fixes.js",
  "/v4/privacy.js?v=19",
  "/v4/workbench-theme.css?v=28",
  "/v4/workbench-theme.js?v=25",
  "/v4/workbench-art.js?v=24",
  "/v4/assets/silk-light-v1.webp",
  "/v4/assets/river-moon-v1.webp",
  "/v4/assets/flowing-silk.svg",
  "/v4/assets/ink-landscape.svg",
  "/v4/assets/jade-fold.svg",
  "/v4/assets/fonts/notoserifsc-ui-500.woff2?v=25",
  "/v4/assets/command-orbit.svg",
  "/icon.svg"
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.searchParams.has('token')) return;
  const staticResource = ['/v4', '/v4/', '/icon.svg', '/manifest.json'].includes(url.pathname)
    || /^\/v4\/.*\.(?:js|css|svg|webp|woff2?)$/.test(url.pathname);
  if (!staticResource) return;

  event.respondWith(
    fetch(event.request).then(netRes => {
      if (netRes && netRes.status === 200) {
        const resClone = netRes.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone)).catch(() => {}));
      }
      return netRes;
    }).catch(async () => (await (await caches.open(CACHE_NAME)).match(event.request))
      || new Response('页面资源暂时不可用，请恢复连接后重试。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
  );
});
