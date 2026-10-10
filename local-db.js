/*
 * LocalDB — the device's copy of the lists and the sync outbox, in IndexedDB.
 *
 * Reads are synchronous: at startup every record is loaded into memory once
 * (LocalDB.ready), so rendering never waits on storage. Writes update memory
 * immediately and reach IndexedDB in one batched transaction a frame later, so a
 * tap never blocks on JSON.stringify + localStorage the way it used to.
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
  const OPEN_TIMEOUT_MS = 1500;
  const MAX_WRITE_DELAY_MS = 120;
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
      const timer = setTimeout(() => reject(new Error("indexedDB open timed out")), OPEN_TIMEOUT_MS);
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

  /* First run on IndexedDB: copy the old localStorage data over, then drop it there. */
  function migrateFromLocalStorage() {
    let keys = [];
    try {
      keys = Object.keys(localStorage).filter(isMigrated);
    } catch (e) {
      return Promise.resolve();
    }
    const fresh = keys.filter((k) => !memory.has(k));
    if (!fresh.length) return Promise.resolve();
    fresh.forEach((k) => {
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

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    // After the frame that shows the change, so the write never delays the paint.
    // Frames can be paused (pane hidden, screen turning off), so a timer bounds the wait.
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      flushScheduled = false;
      writeDirty();
    };
    if (global.requestAnimationFrame && document.visibilityState === "visible") requestAnimationFrame(() => setTimeout(run, 0));
    setTimeout(run, MAX_WRITE_DELAY_MS);
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
