/*
 * SyncClient — thin real-time layer over Socket.io.
 *
 * - Every mutation goes into a persisted outbox (localStorage) and is sent in
 *   order with an ack. Nothing is lost if the tab closes while offline or while
 *   the Render free-tier instance is still waking up.
 * - All server operations are idempotent (client-generated ids, absolute values),
 *   so replaying the outbox after a reconnect is safe.
 * - On (re)connect: flush the outbox, then join the active list, which makes the
 *   server send a fresh `list:state`.
 */
(function (global) {
  "use strict";

  const QUEUE_KEY = "shoppingList.pending.v1";
  const ACK_TIMEOUT_MS = 10000;
  const WAKING_AFTER_MS = 4000;

  const FORWARDED_EVENTS = [
    "session",
    "lists:updated",
    "list:state",
    "list:members",
    "list:shared_notification",
    "list:removed",
    "list:member_joined",
    "item:added",
    "item:toggled",
    "item:updated",
    "item:deleted",
    "item:cleared",
  ];

  function readQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY));
      return Array.isArray(q) ? q : [];
    } catch (e) {
      return [];
    }
  }

  class SyncClient {
    constructor({ url, token }) {
      this.url = url;
      this.token = token;
      this.socket = null;
      this.handlers = {};
      this.queue = readQueue();
      this.flushing = false;
      this.stopped = false;
      this.activeListId = null;
      this.status = "offline"; // offline | connecting | waking | online
      this.wakeTimer = null;
      this.kick = this.kick.bind(this);
      this.onVisible = () => { if (document.visibilityState === "visible") this.kick(); };
    }

    /* ---------- Tiny event emitter for the app ---------- */
    on(event, fn) {
      (this.handlers[event] = this.handlers[event] || []).push(fn);
      return this;
    }
    emitLocal(event, data) {
      (this.handlers[event] || []).forEach((fn) => {
        try { fn(data); } catch (e) { console.error(`[sync] ${event} handler failed`, e); }
      });
    }
    setStatus(status) {
      if (status === this.status) return;
      this.status = status;
      this.emitLocal("status", status);
    }

    /* ---------- Connection lifecycle ---------- */
    start() {
      if (typeof global.io !== "function") {
        console.warn("[sync] socket.io client not loaded; staying offline");
        this.setStatus("offline");
        return;
      }
      this.stopped = false;
      this.wake();

      const socket = (this.socket = global.io(this.url, {
        auth: { token: this.token },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 15000,
        randomizationFactor: 0.5,
        timeout: 20000,
      }));

      this.setStatus(navigator.onLine === false ? "offline" : "connecting");
      this.armWakingTimer();

      socket.on("connect", async () => {
        clearTimeout(this.wakeTimer);
        this.setStatus("online");
        await this.flush();
        this.join();
      });

      socket.on("disconnect", (reason) => {
        if (this.stopped) return;
        this.setStatus(navigator.onLine === false ? "offline" : "connecting");
        this.armWakingTimer();
        // The server kicked us (e.g. redeploy); Socket.io won't retry by itself here.
        if (reason === "io server disconnect") socket.connect();
      });

      socket.on("connect_error", (err) => {
        if (err && err.message === "unauthorized") {
          this.stop();
          this.emitLocal("auth_error");
          return;
        }
        // Usually the free-tier server is still spinning up; Socket.io keeps retrying.
        this.setStatus(navigator.onLine === false ? "offline" : "waking");
      });

      FORWARDED_EVENTS.forEach((event) => socket.on(event, (data) => this.emitLocal(event, data)));

      global.addEventListener("online", this.kick);
      document.addEventListener("visibilitychange", this.onVisible);
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.wakeTimer);
      global.removeEventListener("online", this.kick);
      document.removeEventListener("visibilitychange", this.onVisible);
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      this.setStatus("offline");
    }

    /* Reconnect right away (instead of waiting for backoff) when the network or tab comes back. */
    kick() {
      if (this.stopped || !this.socket || this.socket.connected) return;
      this.wake();
      this.socket.connect();
    }

    /* A plain HTTP hit is the quickest way to make a sleeping Render instance start booting. */
    wake() {
      fetch(this.url + "/health", { cache: "no-store" }).catch(() => {});
    }

    armWakingTimer() {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = setTimeout(() => {
        if (this.socket && !this.socket.connected && navigator.onLine !== false) this.setStatus("waking");
      }, WAKING_AFTER_MS);
    }

    /* ---------- Lists ---------- */
    setActiveList(listId) {
      this.activeListId = listId;
      this.join();
    }

    join() {
      const listId = this.activeListId;
      if (!listId || !this.socket || !this.socket.connected) return;
      this.socket.emit("join:list", { listId }, (res) => {
        if (res && !res.ok) this.emitLocal("join_failed", { listId, error: res.error });
      });
    }

    /* Fire-and-forget calls that don't mutate list items (sharing, membership, rename). */
    request(event, payload) {
      if (!this.socket || !this.socket.connected) {
        return Promise.resolve({ ok: false, error: "offline" });
      }
      return this.socket
        .timeout(ACK_TIMEOUT_MS)
        .emitWithAck(event, payload)
        .catch(() => ({ ok: false, error: "timeout" }));
    }

    /* ---------- Outbox ---------- */
    send(event, payload, op) {
      this.queue.push({ event, payload, op });
      this.saveQueue();
      this.flush();
    }

    async flush() {
      if (this.flushing) return;
      this.flushing = true;
      try {
        while (this.queue.length && this.socket && this.socket.connected) {
          const entry = this.queue[0];
          let res;
          try {
            res = await this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck(entry.event, entry.payload);
          } catch (e) {
            break; // no ack in time; retry on the next flush/reconnect
          }
          if (this.queue[0] === entry) {
            this.queue.shift();
            if (res && res.mergedInto) this.remapItem(entry.payload.item.itemId, res.mergedInto);
            this.saveQueue();
          }
          if (!res || !res.ok) this.emitLocal("op_rejected", { entry, error: res && res.error });
          else if (res.mergedInto) {
            this.emitLocal("item_merged", {
              listId: entry.payload.listId,
              fromId: entry.payload.item.itemId,
              item: res.item,
            });
          }
        }
      } finally {
        this.flushing = false;
      }
    }

    /*
     * The server merged our offline add into an item someone else created with the
     * same name. Point our later queued ops (toggle, edit, delete) at that item.
     */
    remapItem(fromId, toId) {
      this.queue.forEach((e) => {
        if (e.payload && e.payload.itemId === fromId) e.payload.itemId = toId;
        if (e.op && e.op.id === fromId) e.op.id = toId;
      });
    }

    saveQueue() {
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue)); } catch (e) {}
      this.emitLocal("queue", this.queue.length);
    }

    get pendingCount() {
      return this.queue.length;
    }

    clearQueue() {
      this.queue = [];
      this.saveQueue();
    }

    /* Drop queued ops for a list we no longer have access to. */
    dropList(listId) {
      const before = this.queue.length;
      this.queue = this.queue.filter((e) => !e.payload || e.payload.listId !== listId);
      if (this.queue.length !== before) this.saveQueue();
    }

    pendingFor(listId) {
      return this.queue.filter((e) => e.payload && e.payload.listId === listId);
    }

    hasPending(listId, itemId) {
      return this.queue.some((e) => {
        const p = e.payload || {};
        return p.listId === listId && (p.itemId === itemId || (p.item && p.item.itemId === itemId));
      });
    }
  }

  SyncClient.clearStoredQueue = () => {
    try { localStorage.removeItem(QUEUE_KEY); } catch (e) {}
  };

  global.SyncClient = SyncClient;
})(window);
