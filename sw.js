// 讓「加入主畫面」後可以快速開啟；資料本身由 Firebase 處理離線同步。
// 改版時把 VERSION 加 1，家人下次開啟就會拿到新版。
const VERSION = "v32";
const SHELL = ["./", "index.html", "styles.css?v=32", "app.js?v=32", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Firebase、Worker、字型等不攔截
  // 先拿網路上的新版，沒網路才用快取
  // 有網路時每次都跟伺服器確認是不是最新版（no-cache 會用 ETag 確認，沒改就很快），沒網路才用快取
  const fresh = e.request.mode === "navigate" ? fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(e.request, { cache: "no-cache" });
  e.respondWith(fresh.then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
