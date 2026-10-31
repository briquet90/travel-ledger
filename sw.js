// 앱 화면은 오프라인에서도 열리게 캐시한다. 환율 API 요청은 캐시하지 않는다(앱이 직접 관리).
const CACHE = "dogi-travel-shell-v1";
const SHELL = ["./", "index.html", "styles.css", "ledger.js", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // 네트워크 우선(새 버전 반영), 실패하면 캐시.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
