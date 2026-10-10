/*
 * PWAUpdate — registers the service worker and shows the "new version" banner.
 *
 * Flow:
 *   deploy -> browser notices sw.js changed -> new worker installs and WAITS
 *   -> banner appears -> user taps "Update now" -> we post SKIP_WAITING
 *   -> new worker activates -> `controllerchange` -> reload once.
 */
(function (global) {
  "use strict";

  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // installed PWAs can stay open for days
  const MIN_CHECK_GAP_MS = 60 * 1000;

  let waitingWorker = null;
  let reloadRequested = false;
  let lastCheck = 0;

  function banner() { return document.getElementById("updateBanner"); }

  function showBanner(worker) {
    waitingWorker = worker;
    const el = banner();
    if (el) el.classList.remove("hidden");
  }

  function hideBanner() {
    const el = banner();
    if (el) el.classList.add("hidden");
  }

  function applyUpdate() {
    if (!waitingWorker) return;
    reloadRequested = true;
    const btn = document.getElementById("updateNowBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "מעדכן…";
    }
    waitingWorker.postMessage({ action: "SKIP_WAITING" });
  }

  function trackRegistration(reg) {
    // A worker may already be waiting (user dismissed/ignored the banner last time).
    if (reg.waiting && navigator.serviceWorker.controller) showBanner(reg.waiting);

    reg.addEventListener("updatefound", () => {
      const installingWorker = reg.installing;
      if (!installingWorker) return;
      installingWorker.addEventListener("statechange", () => {
        // Having a controller means this is an update, not the very first install.
        if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
          showBanner(installingWorker);
        }
      });
    });
  }

  function checkForUpdate(reg) {
    const now = Date.now();
    if (now - lastCheck < MIN_CHECK_GAP_MS) return;
    lastCheck = now;
    reg.update().catch(() => {});
  }

  async function register(scriptUrl = "sw.js") {
    if (!("serviceWorker" in navigator)) return null;

    let firstInstall = !navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // First install finished: the whole app is cached and now opens without a network.
      if (firstInstall) {
        firstInstall = false;
        global.dispatchEvent(new CustomEvent("pwa:offline-ready"));
      }
      // Only reload when *this* tab asked for it. Also fires on first install
      // (clients.claim) and when another tab updated; don't yank the page then.
      if (!reloadRequested) {
        hideBanner();
        return;
      }
      reloadRequested = false;
      global.location.reload();
    });

    const btn = document.getElementById("updateNowBtn");
    if (btn) btn.addEventListener("click", applyUpdate);
    const dismiss = document.getElementById("updateDismissBtn");
    if (dismiss) dismiss.addEventListener("click", hideBanner);

    try {
      // updateViaCache: "none" -> the browser never serves sw.js from HTTP cache.
      const reg = await navigator.serviceWorker.register(scriptUrl, { updateViaCache: "none" });
      trackRegistration(reg);
      lastCheck = Date.now();
      setInterval(() => checkForUpdate(reg), CHECK_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate(reg);
      });
      return reg;
    } catch (e) {
      console.warn("Service worker registration failed", e);
      return null;
    }
  }

  global.PWAUpdate = { register };
})(window);
