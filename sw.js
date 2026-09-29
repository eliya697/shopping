/*
 * Service worker.
 *
 * BUILD_VERSION is replaced with the commit SHA by .github/workflows/deploy.yml,
 * so every deploy produces a byte-different sw.js -> the browser installs the new
 * worker -> it waits -> pwa-update.js shows the "update available" banner.
 * (If you ever deploy without that workflow, bump the string by hand.)
 */
const BUILD_VERSION = "__BUILD_VERSION__";
const CACHE_PREFIX = "shopping-list-";
const CACHE_NAME = CACHE_PREFIX + BUILD_VERSION;
const LEGACY_CACHE = "shopping-list-v2"; // the pre-update-banner version of this app

const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./socket-client.js",
  "./pwa-update.js",
  "./vendor/socket.io.min.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: "reload" bypasses the HTTP cache (GitHub Pages sends max-age=600),
    // so we never precache a stale copy of a file from the previous deploy.
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));

    // One-time migration: the old version has no update banner to ask the user,
    // so take over immediately instead of waiting for every tab to close.
    if (await caches.has(LEGACY_CACHE)) await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* The page sends this when the user taps "Update now". */
self.addEventListener("message", (event) => {
  if (event.data && event.data.action === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never touch cross-origin traffic (the Socket.io / API backend).
  if (url.origin !== self.location.origin) return;

  // App navigations: serve the precached shell (versioned together with the JS/CSS).
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match("./index.html");
      if (cached) return cached;
      return fetch(request);
    })());
    return;
  }

  // App-shell assets: cache-first. Anything else same-origin: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    const isShell = APP_SHELL.some((p) => new URL(p, self.location).pathname === url.pathname);
    if (cached && isShell) return cached;

    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached || Response.error());

    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network;
  })());
});
