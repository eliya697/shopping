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
  "./local-db.js",
  "./categories.js",
  "./item-parser.js",
  "./quick-add.js",
  "./voice.js",
  "./ai-chat.js",
  "./fridge-vision.js",
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

/*
 * Background push. Expected payload (JSON):
 *   { title, body, tag?, url?, listId? }
 * Plain-text payloads are shown as the body. Nothing is shown while one of our
 * pages is visible: the app already displays its own in-app toast then.
 */
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = { body: event.data.text() }; }
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((c) => c.visibilityState === "visible")) return;
    await self.registration.showNotification(data.title || "רשימת קניות 🛒", {
      body: data.body || "יש עדכון ברשימה",
      icon: "./icon.svg",
      badge: "./icon.svg",
      tag: data.tag || (data.listId ? "list-" + data.listId : "shopping-list"),
      renotify: true,
      dir: "rtl",
      lang: "he",
      data: { url: data.url || "./" },
    });
  })());
});

/* Tapping a notification focuses an open tab of the app, or opens one. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((c) => c.url.startsWith(self.registration.scope));
    if (existing) return existing.focus();
    return self.clients.openWindow(target);
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never touch cross-origin traffic (the Socket.io / API backend).
  if (url.origin !== self.location.origin) return;

  // The admin dashboard is network-only: never cached, never swapped for the app shell.
  if (/\/admin(\.html|\.js)?$/.test(url.pathname)) return;

  // Invite deep links (…/join/?code=X): hand the code to the app. Serving the shell at
  // /join/ itself would break its relative script and style paths.
  if (request.mode === "navigate" && /\/join\/?$/.test(url.pathname)) {
    const code = url.searchParams.get("code") || url.searchParams.get("join") || "";
    const target = new URL("./", self.registration.scope);
    if (code) target.searchParams.set("join", code);
    event.respondWith(Response.redirect(target.href, 302));
    return;
  }

  // App navigations: serve the precached shell (versioned together with the JS/CSS).
  // It never waits on the network, so the app opens instantly even with one bar of
  // reception in the supermarket.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match("./index.html");
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (e) {
        // Our cache was evicted under storage pressure: any other cached shell
        // still beats the browser's offline page.
        return (await caches.match("./index.html", { ignoreSearch: true })) || offlinePage();
      }
    })());
    return;
  }

  // App-shell assets: cache-first. Anything else same-origin: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const isShell = APP_SHELL.some((p) => new URL(p, self.location).pathname === url.pathname);
    // Fall back to an older version's copy when this one is missing (partial eviction).
    const cached = (await cache.match(request, { ignoreSearch: true }))
      || (isShell ? await caches.match(request, { ignoreSearch: true }) : undefined);
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

/* Last resort when there's no network and no cached shell at all (should be rare). */
function offlinePage() {
  const html = '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>אין חיבור</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;'
    + 'justify-content:center;background:#0f172a;color:#e8eef7;font-family:system-ui,sans-serif;text-align:center;padding:24px">'
    + '<div><div style="font-size:3rem">📡</div><h1 style="font-size:1.2rem">אין חיבור לאינטרנט</h1>'
    + '<p style="color:#94a3b8">הרשימה תיפתח ברגע שהחיבור יחזור.</p>'
    + '<button onclick="location.reload()" style="margin-top:8px;padding:12px 20px;border:0;border-radius:14px;'
    + 'background:#00e676;color:#04210f;font-weight:800;font-size:1rem">נסו שוב</button></div>';
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
