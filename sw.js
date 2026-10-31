// 앱 화면은 오프라인에서도 열리게 캐시한다. 환율 API는 캐시하지 않는다(앱이 직접 관리).
// 공유 가계부용 Firebase 라이브러리(gstatic, 버전 고정)는 처음 받은 뒤 캐시해서 오프라인에서도 열리게 한다.
const CACHE = "dogi-travel-shell-v3";
const SHELL = ["./", "index.html", "styles.css", "ledger.js", "app.js", "sync.js", "firebase-config.js",
  "manifest.webmanifest", "icon.svg", "icon-192.png",
  "dog/", "dog/index.html", "dog/dog.css", "dog/manifest.webmanifest", "dog/icon-192.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  // 네트워크 우선(새 버전 반영), 실패하면 캐시.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
