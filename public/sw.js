const CACHE_NAME = 'priceaction-v5';
const ASSETS = ['/', '/index.html', '/logo.svg', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  // Only handle http/https — never chrome-extension, data, blob, etc.
  if (!url.startsWith('https://') && !url.startsWith('http://')) return;
  if (url.includes('/api/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') return response;
        // Double-check scheme before caching — prevents chrome-extension errors
        if (!url.startsWith('https://') && !url.startsWith('http://')) return response;
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, toCache)).catch(() => {});
        return response;
      }).catch(() => {
        if (e.request.destination === 'document') {
          return caches.match('/index.html').then(r => r || new Response(
            `<!DOCTYPE html><html><head><title>PriceAction AI — Offline</title>
            <style>body{background:#06080d;color:#dce8f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
            h1{color:#00e5b4}p{color:#5a7a96}</style></head>
            <body><div><h1>You're offline</h1><p>PriceAction AI requires an internet connection.<br>Please reconnect and try again.</p></div></body></html>`,
            { headers: { 'Content-Type': 'text/html' } }
          ));
        }
      });
    })
  );
});
