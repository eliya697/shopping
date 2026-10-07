"use strict";

/*
 * Admin API — developer-only.
 *
 * Login: POST /api/admin/login { email, secretKey } with the admin email and the
 * ADMIN_SECRET_KEY environment variable. Returns a signed session token (12h).
 *
 * Owner account: POST /api/admin/claim-owner { email, secretKey } with an app
 * account's token marks that account as the owner (role "owner", see roles.js).
 *
 * Every other route is behind server.js's requireAdmin middleware: an admin
 * session token or the owner account's token passes, a regular account gets 403.
 *
 * Tokens are HMAC-signed with ADMIN_SECRET_KEY, so they survive restarts and
 * rotating the key logs every admin session out.
 * If ADMIN_SECRET_KEY is missing (or shorter than 16 chars) the admin API is disabled:
 * the rest of the server keeps working, and GET /api/admin/check says why.
 * There is deliberately no built-in default key.
 */

const crypto = require("crypto");
const express = require("express");
const store = require("./db");
const roles = require("./roles");

const MIN_KEY_LENGTH = 16;
// ADMIN_SECRET_KEY is the documented name; the others are accepted (with a warning) to survive typos.
const KEY_NAMES = ["ADMIN_SECRET_KEY", "ADMIN_SECRET", "ADMIN_KEY"];

/*
 * Reads the admin key, tolerating the usual dashboard copy-paste accidents:
 * surrounding whitespace/newlines and wrapping quotes. Never returns why in terms
 * of the value itself — only its length — so it's safe to log.
 */
function loadAdminKey(env = process.env) {
  for (const name of KEY_NAMES) {
    const raw = env[name];
    if (raw === undefined) continue;
    const value = raw.trim().replace(/^(['"])(.*)\1$/s, "$2").trim();
    const notes = [];
    if (value !== raw) notes.push("removed surrounding whitespace/quotes");
    if (name !== KEY_NAMES[0]) notes.push(`read from ${name} — rename it to ${KEY_NAMES[0]}`);
    const base = { source: name, length: value.length, notes, minLength: MIN_KEY_LENGTH };
    if (!value) return { ...base, value: "", reason: "empty" };
    if (value.length < MIN_KEY_LENGTH) return { ...base, value: "", reason: "too_short" };
    return { ...base, value, reason: null };
  }
  return { source: null, length: 0, notes: [], minLength: MIN_KEY_LENGTH, value: "", reason: "missing" };
}

const REASON_TEXT = {
  missing: `ADMIN_SECRET_KEY is not set on this server`,
  empty: `ADMIN_SECRET_KEY is set but empty`,
  too_short: `ADMIN_SECRET_KEY is shorter than ${MIN_KEY_LENGTH} characters`,
};

const keyConfig = loadAdminKey();
const SECRET = keyConfig.value;
const ENABLED = !keyConfig.reason;
const ADMIN_EMAIL = roles.adminEmail();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CLEANUP_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/* Login brute-force guard: max failed attempts per IP per window. */
const LOGIN_FAILS_MAX = 5;
const LOGIN_FAILS_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map();
setInterval(() => loginFails.clear(), LOGIN_FAILS_WINDOW_MS).unref();

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

/* Shared brute-force guard for every endpoint that checks ADMIN_SECRET_KEY. */
function loginBlocked(ip) {
  const record = loginFails.get(ip);
  return !!record && Date.now() - record.since < LOGIN_FAILS_WINDOW_MS && record.count >= LOGIN_FAILS_MAX;
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const record = loginFails.get(ip);
  const fresh = !record || now - record.since >= LOGIN_FAILS_WINDOW_MS;
  loginFails.set(ip, fresh ? { since: now, count: 1 } : { ...record, count: record.count + 1 });
}
/* Both compared every time, so timing doesn't reveal which one was wrong. */
function credentialsOk(body) {
  const emailOk = safeEqual(roles.normalizeEmail(body?.email), ADMIN_EMAIL);
  const keyOk = safeEqual(String(body?.secretKey || "").trim(), SECRET);
  return emailOk && keyOk;
}

/* requireAdmin: the middleware from server.js that guards every non-public route. */
function adminRouter(sockets, requireAdmin) {
  if (typeof requireAdmin !== "function") throw new Error("adminRouter needs the requireAdmin middleware");
  const router = express.Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  /* Public: is the admin API usable here? Reveals only enabled/why, never the key or its length. */
  router.get("/check", (_req, res) => {
    res.json({ enabled: ENABLED, reason: keyConfig.reason, minLength: MIN_KEY_LENGTH });
  });

  router.use((_req, res, next) => {
    if (ENABLED) return next();
    res.status(503).json({
      error: `admin API is disabled: ${REASON_TEXT[keyConfig.reason]}`,
      code: "ADMIN_DISABLED",
      reason: keyConfig.reason,
      minLength: MIN_KEY_LENGTH,
    });
  });

  router.post("/login", (req, res) => {
    if (loginBlocked(req.ip)) return res.status(429).json({ error: "too many attempts, try again later" });
    if (!credentialsOk(req.body)) {
      recordLoginFailure(req.ip);
      return res.status(401).json({ error: "invalid credentials" });
    }
    loginFails.delete(req.ip);
    res.json(issueToken());
  });

  /*
   * Link the calling app account (Bearer <account token>) to the owner email. The
   * secret key is the proof of identity: accounts have no passwords, so typing the
   * email alone must never be enough. Any other account holding the email loses it.
   */
  router.post("/claim-owner", handle(async (req, res) => {
    if (loginBlocked(req.ip)) return res.status(429).json({ error: "too many attempts, try again later" });
    const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const user = token ? await store.findUserByToken(token) : null;
    if (!user) return res.status(401).json({ error: "sign in to the app first", code: "INVALID_TOKEN" });
    if (!credentialsOk(req.body)) {
      recordLoginFailure(req.ip);
      return res.status(401).json({ error: "invalid credentials" });
    }
    loginFails.delete(req.ip);
    const owner = await store.setVerifiedEmail(user.userId, ADMIN_EMAIL);
    console.log(`[admin] account ${user.userId} is now the owner`);
    res.json({ user: owner, session: issueToken() });
  }));

  /* Everything below: owner or admin session only (401 without credentials, 403 for regular users). */
  router.use(requireAdmin);

  /* The owner account opens the web dashboard without typing the secret key again. */
  router.post("/session", (req, res) => {
    if (!req.admin || req.admin.via !== "owner") {
      return res.status(403).json({ error: "only the owner account can open a session", code: "FORBIDDEN" });
    }
    res.json(issueToken());
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
}

/* Startup diagnostics for server.js. Safe to log: no key material, only name/length/reason. */
function describeAdminConfig() {
  const lines = [];
  if (ENABLED) {
    lines.push(`ADMIN_SECRET_KEY: OK (${keyConfig.length} chars, from ${keyConfig.source}) — admin API enabled for ${ADMIN_EMAIL}`);
  } else {
    const detail = keyConfig.reason === "too_short"
      ? ` (got ${keyConfig.length}, need at least ${MIN_KEY_LENGTH})`
      : "";
    lines.push(`ADMIN_SECRET_KEY: ${keyConfig.reason.toUpperCase()}${detail} — admin API DISABLED. ` +
      "Set it in Render → Environment and redeploy.");
  }
  keyConfig.notes.forEach((n) => lines.push(`ADMIN_SECRET_KEY: note: ${n}`));
  return { ok: ENABLED, lines };
}

module.exports = adminRouter;
module.exports.describeAdminConfig = describeAdminConfig;
module.exports.loadAdminKey = loadAdminKey;
module.exports.verifyAdminSession = (token) => ENABLED && verifyToken(token);
