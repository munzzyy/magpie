// Magpie service worker. Offline shell and share-target hand-off only.
// Journal data lives in IndexedDB, encrypted, and never touches a cache.

const VERSION = "magpie-v0.1.0";
const SHARE_CACHE = "magpie-share";

const PRECACHE = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/main.js",
  "/js/vault.js",
  "/js/cryptobox.js",
  "/js/chain.js",
  "/js/canon.js",
  "/js/zip.js",
  "/js/export.js",
  "/js/platform.js",
  "/js/i18n.js",
  "/js/strings-es.js",
  "/icons/magpie.svg",
  "/icons/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/privacy.html",
  "/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll(PRECACHE);
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== VERSION && n !== SHARE_CACHE).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(
      (async () => {
        const site = event.request.headers.get("Sec-Fetch-Site");
        if (site !== null && site !== "none" && site !== "same-origin") {
          return new Response("no", { status: 403 });
        }
        try {
          const form = await event.request.formData();
          const files = form.getAll("evidence").filter((f) => f && f.size && f.size <= 200 * 1024 * 1024);
          const cache = await caches.open(SHARE_CACHE);
          for (const req of await cache.keys()) await cache.delete(req);
          let n = 0;
          for (const file of files.slice(0, 50)) {
            await cache.put(
              `/share-incoming-${n++}`,
              new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } })
            );
          }
        } catch {
          // A malformed share still lands on the app, just with nothing parked.
        }
        return Response.redirect("/?share-target=1", 303);
      })()
    );
    return;
  }

  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/share-incoming")) {
    event.respondWith(new Response("gone", { status: 404 }));
    return;
  }

  if (event.request.mode === "navigate") {
    const shell =
      url.pathname === "/" || url.pathname === "/index.html"
        ? "/index.html"
        : url.pathname === "/privacy.html" || url.pathname === "/privacy"
          ? "/privacy.html"
          : null;
    if (shell) {
      event.respondWith(
        (async () => {
          const cached = await caches.match(shell, { cacheName: VERSION });
          return cached || fetch(event.request);
        })()
      );
    }
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request, { cacheName: VERSION });
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res && res.ok && PRECACHE.includes(url.pathname)) {
        const cache = await caches.open(VERSION);
        cache.put(event.request, res.clone());
      }
      return res;
    })()
  );
});
