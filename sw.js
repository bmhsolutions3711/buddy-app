/* Buddy shell. Never cache /api/. Tap the version pill to pull a new build. */
const VERSION = "buddy-shell-v23";

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "VERSION") {
    e.source && e.source.postMessage({ type: "VERSION", version: VERSION });
  }
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("install", (e) => {
  const base = self.registration.scope;
  const assets = ["", "index.html", "styles.css", "app.js", "manifest.json", "icon.svg",
    "icon-buddy-180.png", "icon-buddy-192.png", "icon-buddy-512.png",
    "icon-buddy-mask-192.png", "icon-buddy-mask-512.png"]
    .map((p) => new URL(p, base).href);
  e.waitUntil(
    caches.open(VERSION).then((c) =>
      Promise.all(
        assets.map((u) =>
          fetch(u, { cache: "reload" }).then((r) => {
            if (!r.ok) throw new Error("shell fetch failed: " + u);
            return c.put(u, r);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request))
  );
});
