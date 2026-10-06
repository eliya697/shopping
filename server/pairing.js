"use strict";

/*
 * Device pairing with a 6-digit code (or a QR code that opens ?pair=<code>).
 *
 *   Device A (signed in):  POST /api/pair/start    Authorization: Bearer <token>  -> { code, expiresAt }
 *   Device B (new):        POST /api/pair/redeem   { code }                       -> { token, user, lists }
 *
 * The database stores only a hash of each account's token, so the code carries
 * device A's token in memory: single use, gone after 5 minutes or a restart.
 * Wrong guesses are rate-limited per IP and globally, so the 1,000,000-code space
 * can't be swept in the 5-minute window.
 */
const crypto = require("crypto");
const express = require("express");
const store = require("./db");

const CODE_TTL_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS_PER_IP = 8;
const MAX_FAILS_GLOBAL = 60;

const codes = new Map(); // code -> { token, userId, expiresAt }
const codeByUser = new Map(); // userId -> code (one live code per account)
const failsByIp = new Map(); // ip -> [timestamps]
let globalFails = [];

function sweep(now = Date.now()) {
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) {
      codes.delete(code);
      if (codeByUser.get(entry.userId) === code) codeByUser.delete(entry.userId);
    }
  }
  globalFails = globalFails.filter((t) => now - t < FAIL_WINDOW_MS);
  for (const [ip, list] of failsByIp) {
    const recent = list.filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length) failsByIp.set(ip, recent);
    else failsByIp.delete(ip);
  }
}
setInterval(sweep, 60 * 1000).unref();

function newCode() {
  for (;;) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    if (!codes.has(code)) return code;
  }
}

function tooManyFailures(ip) {
  sweep();
  return (failsByIp.get(ip) || []).length >= MAX_FAILS_PER_IP || globalFails.length >= MAX_FAILS_GLOBAL;
}
function recordFailure(ip) {
  const now = Date.now();
  failsByIp.set(ip, [...(failsByIp.get(ip) || []), now]);
  globalFails.push(now);
}

function pairingRouter() {
  const router = express.Router();

  router.use((_req, res, next) => {
    if (store.isReady()) return next();
    res.set("Retry-After", "3").status(503).json({ error: "server is starting, try again", code: "SERVER_UNAVAILABLE" });
  });

  router.post("/start", async (req, res) => {
    const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const user = token ? await store.findUserByToken(token) : null;
    if (!user) return res.status(401).json({ error: "invalid token", code: "INVALID_TOKEN" });

    // A new code replaces this account's previous one.
    const previous = codeByUser.get(user.userId);
    if (previous) codes.delete(previous);
    const code = newCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    codes.set(code, { token, userId: user.userId, expiresAt });
    codeByUser.set(user.userId, code);
    res.json({ code, expiresAt, ttlMs: CODE_TTL_MS });
  });

  router.post("/redeem", async (req, res) => {
    const ip = req.ip;
    if (tooManyFailures(ip)) return res.status(429).json({ error: "too many attempts, try later", code: "RATE_LIMITED" });

    const code = String((req.body && req.body.code) || "").replace(/\D/g, "");
    const entry = code.length === 6 ? codes.get(code) : null;
    if (!entry || entry.expiresAt <= Date.now()) {
      recordFailure(ip);
      return res.status(404).json({ error: "invalid or expired code", code: "INVALID_CODE" });
    }

    const user = await store.findUserByToken(entry.token);
    codes.delete(code); // single use, even if the account turns out to be gone
    if (codeByUser.get(entry.userId) === code) codeByUser.delete(entry.userId);
    if (!user) return res.status(404).json({ error: "account no longer exists", code: "INVALID_CODE" });

    store.touchUser(user.userId).catch(() => {});
    res.json({ token: entry.token, user, lists: await store.getListsForUser(user.userId) });
  });

  return router;
}

module.exports = pairingRouter;
