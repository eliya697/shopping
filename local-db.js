/*
 * LocalDB — the device's copy of the lists and the sync outbox, in IndexedDB.
 *
 * Reads are synchronous: at startup every record is loaded into memory once
 * (LocalDB.ready), so rendering never waits on storage. Writes update memory
 * immediately and reach IndexedDB in one batched transaction at the next idle
 * moment, so neither a tap nor a scroll ever waits on storage.
 *
 * Small preferences (theme, view mode…) stay in localStorage: they're read before
 * first paint by the inline script in index.html, and by admin.html.
 *
 * If IndexedDB is missing, broken or hangs (old Safari private mode), everything
 * falls back to localStorage under the same keys, so the app keeps working.
 */
(function (global) {
  "use strict";

  const DB_NAME = "shopping-list";
  const DB_VERSION = 1;
  const STORE = "kv";
  // A broken IndexedDB (old Safari private mode) hangs forever; a merely slow one (cold
  // start on a busy low-end phone) can take a few seconds. Falling back costs this
  // run its device data, so only give up on the first kind.
  const OPEN_TIMEOUT_MS = 6000;
  // Writes wait for an idle moment (never mid-scroll or mid-animation), at most this long.
  const MAX_WRITE_DELAY_MS = 500;
  // localStorage keys that move into IndexedDB (exact keys, or prefixes ending in ".").
  const MIGRATE = ["shoppingList.items.v1", "shoppingList.pending.v1", "shoppingList.listCache.v1."];

  const memory = new Map();
  const dirty = new Set(); // keys to write (value in memory) or delete (absent from memory)
  let db = null;
  let flushScheduled = false;
  let backend = "memory"; // "idb" | "localStorage" | "memory"

  const isMigrated = (key) => MIGRATE.some((k) => (k.endsWith(".") ? key.startsWith(k) : key === k));

  function lsGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) return reject(new Error("no indexedDB"));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("indexedDB open timed out"));
      }, OPEN_TIMEOUT_MS);
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        clearTimeout(timer);
        return reject(e);
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        const conn = req.result;
        // We already fell back to localStorage: don't leak a connection nobody uses.
        if (timedOut) return conn.close();
        // Another tab is upgrading the schema: let it, we'll reopen on next load.
        conn.onversionchange = () => conn.close();
        resolve(conn);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error);
      };
    });
  }

  function loadAll(conn) {
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => {
        keysReq.result.forEach((k, i) => memory.set(k, valsReq.result[i]));
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /*
   * Move localStorage copies of these keys into IndexedDB, then drop them there.
   * They exist in two cases: the very first run on IndexedDB (old app versions), and
   * after a run that had to fall back to localStorage. In the second case they are
   * NEWER than what IndexedDB holds (that run's edits and outbox), so they always win;
   * keeping the older IndexedDB copy and deleting these used to lose that run's data.
   */
  function migrateFromLocalStorage() {
    let keys = [];
    try {
      keys = Object.keys(localStorage).filter(isMigrated);
    } catch (e) {
      return Promise.resolve();
    }
    if (!keys.length) return Promise.resolve();
    keys.forEach((k) => {
      const value = lsGet(k);
      if (value !== undefined) {
        memory.set(k, value);
        dirty.add(k);
      }
    });
    return writeDirty().then(() => {
      keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
    });
  }

  function loadFromLocalStorage() {
    try {
      Object.keys(localStorage).filter(isMigrated).forEach((k) => {
        const value = lsGet(k);
        if (value !== undefined) memory.set(k, value);
      });
    } catch (e) {}
  }

  function writeDirty() {
    if (!dirty.size) return Promise.resolve();
    const keys = Array.from(dirty);
    dirty.clear();

    if (backend === "localStorage") {
      keys.forEach((k) => {
        try {
          if (memory.has(k)) localStorage.setItem(k, JSON.stringify(memory.get(k)));
          else localStorage.removeItem(k);
        } catch (e) {}
      });
      return Promise.resolve();
    }
    if (backend !== "idb" || !db) return Promise.resolve();

    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, "readwrite");
      } catch (e) {
        // The connection was closed (versionchange, storage cleared): keep the data on localStorage.
        backend = "localStorage";
        keys.forEach((k) => dirty.add(k));
        writeDirty().then(resolve);
        return;
      }
      const store = tx.objectStore(STORE);
      keys.forEach((k) => {
        if (memory.has(k)) store.put(memory.get(k), k);
        else store.delete(k);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => {
        console.warn("[LocalDB] write failed", tx.error);
        keys.forEach((k) => dirty.add(k)); // retry with the next write
        resolve();
      };
    });
  }

  /*
   * IndexedDB's put() structured-clones the value on the main thread, which for a big
   * list cache is real work. Do it when the browser is idle (not during a scroll fling
   * or an animation frame), bounded by MAX_WRITE_DELAY_MS. Going to the background
   * flushes immediately (see flushNow), so the delay never risks losing a change.
   */
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      flushScheduled = false;
      writeDirty();
    };
    if (global.requestIdleCallback) {
      global.requestIdleCallback(run, { timeout: MAX_WRITE_DELAY_MS });
    } else if (global.requestAnimationFrame && document.visibilityState === "visible") {
      requestAnimationFrame(() => setTimeout(run, 0)); // after the frame that shows the change
    }
    setTimeout(run, MAX_WRITE_DELAY_MS + 50); // frames/idle can be paused (hidden pane, screen off)
  }

  const ready = (async () => {
    try {
      db = await openDB();
      backend = "idb";
      await loadAll(db);
      await migrateFromLocalStorage();
    } catch (e) {
      console.warn("[LocalDB] IndexedDB unavailable, using localStorage:", e && e.message);
      db = null;
      backend = "localStorage";
      memory.clear();
      loadFromLocalStorage();
    }
    return backend;
  })();

  // The tab is going away or into the background (phone locked in the supermarket):
  // write now rather than a frame later, which may never come.
  const flushNow = () => { if (dirty.size) writeDirty(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushNow(); });
  global.addEventListener("pagehide", flushNow);

  global.LocalDB = {
    ready,
    get backend() { return backend; },
    get(key, fallback) {
      return memory.has(key) ? memory.get(key) : fallback;
    },
    set(key, value) {
      memory.set(key, value);
      dirty.add(key);
      scheduleFlush();
    },
    remove(key) {
      if (!memory.has(key)) return;
      memory.delete(key);
      dirty.add(key);
      scheduleFlush();
    },
    flush: writeDirty,
  };
})(window);
