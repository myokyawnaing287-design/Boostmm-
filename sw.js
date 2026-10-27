const CACHE_NAME = "boostmm-static-v1";
const STATIC_ASSETS = ["/", "/app.js", "/style.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API, authentication, order, deposit, or other dynamic requests.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth") || url.pathname.startsWith("/owner") || url.pathname.startsWith("/orders") || url.pathname.startsWith("/deposits")) return;
  if (url.pathname === "/" || ["/app.js", "/style.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"].includes(url.pathname)) {
    event.respondWith(fetch(request).then(response => { if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(request, copy)); } return response; }).catch(() => caches.match(request).then(cached => cached || caches.match("/"))));
  }
});
