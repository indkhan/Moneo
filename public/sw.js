const CACHE = "moneo-offline-v1";
const OFFLINE = "/offline.html";
const SKIP = ["/api/", "/.well-known/", "/artifact-lib/"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(new Request(OFFLINE, { cache: "reload" }))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === OFFLINE || SKIP.some(prefix => url.pathname.startsWith(prefix))) return;
  const offline = () => caches.match(OFFLINE);
  event.respondWith(fetch(request).then(response => [502, 503, 504].includes(response.status) ? offline().then(page => page ?? response) : response, () => offline().then(page => page ?? Response.error())));
});
