"use strict";

/*
 * Admin API — developer-only.
 *
 * Login: POST /api/admin/login { email, secretKey } with the admin email and the
 * ADMIN_SECRET_KEY environment variable. Returns a signed session token (12h).
 * Every other route needs `Authorization: Bearer <admin token>`.
 *
 * Tokens are HMAC-signed with ADMIN_SECRET_KEY, so they survive restarts and
 * rotating the key logs every admin session out.
 * If ADMIN_SECRET_KEY is missing (or shorter than 16 chars) the admin API is disabled.
 */

const crypto = require("crypto");
const express = require("express");
const store = require("./db");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "eliyamistriel1234@gmail.com").trim().toLowerCase();
const SECRET = process.env.ADMIN_SECRET_KEY || "";
const ENABLED = SECRET.length >= 16;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CLEANUP_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/* Login brute-force guard: max failed attempts per IP per window. */
const LOGIN_FAILS_MAX = 5;
const LOGIN_FAILS_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map();
setInterval(() => loginFails.clear(), LOGIN_FAILS_WINDOW_MS).unref();

if (!ENABLED) console.warn("[admin] ADMIN_SECRET_KEY is not set (or < 16 chars); the admin API is disabled.");

/* Constant-time comparison of two arbitrary strings. */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const sign = (payload) => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

function issueToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(12).toString("base64url");
  const payload = `admin.${exp}.${nonce}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== "admin") return false;
  const payload = parts.slice(0, 3).join(".");
  if (!safeEqual(sign(payload), parts[3])) return false;
  return Number(parts[1]) > Date.now();
}

/* Wrap async route handlers: database trouble becomes a 503, never a crash. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[admin] ${req.method} ${req.path}`, err);
    res.status(503).json({ error: "database error", detail: err.message });
  }
};

module.exports = function adminRouter(sockets) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!ENABLED) return res.status(503).json({ error: "admin API is disabled on this server", code: "ADMIN_DISABLED" });
    next();
  });

  router.post("/login", (req, res) => {
    const now = Date.now();
    const record = loginFails.get(req.ip);
    if (record && now - record.since < LOGIN_FAILS_WINDOW_MS && record.count >= LOGIN_FAILS_MAX) {
      return res.status(429).json({ error: "too many attempts, try again later" });
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const key = String(req.body?.secretKey || "");
    // Evaluate both so timing doesn't reveal which one was wrong.
    const emailOk = safeEqual(email, ADMIN_EMAIL);
    const keyOk = safeEqual(key, SECRET);
    if (!(emailOk && keyOk)) {
      const fresh = !record || now - record.since >= LOGIN_FAILS_WINDOW_MS;
      loginFails.set(req.ip, fresh ? { since: now, count: 1 } : { ...record, count: record.count + 1 });
      return res.status(401).json({ error: "invalid credentials" });
    }
    loginFails.delete(req.ip);
    res.json(issueToken());
  });

  /* Everything below requires a valid admin token. */
  router.use((req, res, next) => {
    const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!verifyToken(token)) return res.status(401).json({ error: "admin session invalid or expired", code: "ADMIN_UNAUTHORIZED" });
    next();
  });

  router.get("/health", handle(async (_req, res) => {
    const mem = process.memoryUsage();
    const db = { mode: store.mode, ready: store.isReady(), connectedAt: store.state.connectedAt, error: store.state.lastError };
    if (db.ready) {
      try {
        db.latencyMs = await store.ping();
        Object.assign(db, await store.adminStats());
        db.status = "ok";
      } catch (err) {
        db.status = "error";
        db.error = err.message;
      }
    } else {
      db.status = "connecting";
    }
    res.json({
      uptimeSec: Math.round(process.uptime()),
      startedAt: Date.now() - Math.round(process.uptime() * 1000),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      sockets: sockets.connectionCount(),
      node: process.version,
      db,
    });
  }));

  router.get("/users", handle(async (_req, res) => {
    res.json({ users: await store.adminListUsers() });
  }));

  router.delete("/users/:id", handle(async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid user id" });
    const result = await store.adminDeleteUser(req.params.id);
    if (!result) return res.status(404).json({ error: "user not found" });
    await sockets.userDeleted(result);
    res.json({ ok: true, deletedLists: result.deletedLists.length, leftLists: result.leftLists.length });
  }));

  router.get("/lists", handle(async (_req, res) => {
    res.json({ lists: await store.adminListLists() });
  }));

  router.delete("/lists/:id", handle(async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "invalid list id" });
    const list = await store.adminDeleteList(req.params.id);
    if (!list) return res.status(404).json({ error: "list not found" });
    await sockets.listDeleted(list);
    res.json({ ok: true, members: list.members.length });
  }));

  router.post("/cleanup", handle(async (_req, res) => {
    const { cutoff, deleted, byList } = await store.purgeCompleted(CLEANUP_AGE_MS);
    sockets.itemsPurged(byList);
    console.log(`[admin] cleanup removed ${deleted} checked items older than ${new Date(cutoff).toISOString()}`);
    res.json({ ok: true, deleted, lists: Object.keys(byList).length, cutoff });
  }));

  router.get("/export", handle(async (_req, res) => {
    const dump = await store.exportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.set("Content-Disposition", `attachment; filename="shopping-backup-${stamp}.json"`);
    res.json(dump);
  }));

  return router;
};
