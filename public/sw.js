// Moneo's service worker exists so phones and tablets can install the app. It never stores
// pages, API answers or financial data: every request goes to the network as usual. The only thing
// it keeps is offline.html, shown when opening Moneo fails because the computer is off or unreachable.
const CACHE = "moneo-offline-v1";
const OFFLINE = "/offline.html";
// Never touched, even as page navigations (sign-in callbacks, workflow endpoints, artifact libraries).
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
  // 502-504 is what Tailscale answers when the computer is on but Moneo is not running.
  event.respondWith(fetch(request).then(response => [502, 503, 504].includes(response.status) ? offline().then(page => page ?? response) : response, () => offline().then(page => page ?? Response.error())));
});
