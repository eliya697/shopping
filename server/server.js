"use strict";

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const store = require("./db");
const attachSockets = require("./sockets");
const adminRouter = require("./admin");

const PORT = Number(process.env.PORT) || 3000;

/* ---------- CORS ----------
 * ALLOWED_ORIGINS is a comma-separated list, e.g.
 *   https://eliya697.github.io,http://localhost:5173
 * Note: a GitHub Pages origin never includes the repo path.
 * localhost / 127.0.0.1 on any port is always allowed for development.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function checkOrigin(origin, callback) {
  // Requests without an Origin header (curl, health checks) are fine.
  if (!origin || LOCAL_ORIGIN.test(origin) || allowedOrigins.includes(origin)) return callback(null, true);
  callback(new Error(`Origin ${origin} not allowed by CORS`));
}
const corsOptions = { origin: checkOrigin, methods: ["GET", "POST", "DELETE"] };

/* ---------- Express + Socket.io ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  pingInterval: 25000,
  pingTimeout: 20000,
});
const sockets = attachSockets(io);

app.set("trust proxy", 1); // Render/Railway/Fly sit behind a proxy; needed for req.ip
app.use(cors(corsOptions));
app.use(express.json({ limit: "10kb" }));

app.get("/", (_req, res) => res.type("text").send("Shopping list server is running."));
// Always 200 so Render's health check passes during a cold start; `db` tells the real state.
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now(), db: store.isReady() ? "ready" : "connecting" }));

/* Until the database answers, say "try again" — never "not found". */
function requireDb(_req, res, next) {
  if (store.isReady()) return next();
  res.set("Retry-After", "3").status(503).json({ error: "server is starting, try again", code: "SERVER_UNAVAILABLE" });
}

/* Tiny in-memory rate limit for account creation. */
const registerHits = new Map();
const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
function registerRateLimited(ip) {
  const now = Date.now();
  const hits = (registerHits.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  hits.push(now);
  registerHits.set(ip, hits);
  return hits.length > REGISTER_LIMIT;
}
setInterval(() => registerHits.clear(), REGISTER_WINDOW_MS).unref();

app.post("/api/register", requireDb, async (req, res) => {
  if (registerRateLimited(req.ip)) return res.status(429).json({ error: "too many accounts, try later" });
  const username = typeof req.body?.username === "string" ? req.body.username.trim().slice(0, 30) : "";
  if (!username) return res.status(400).json({ error: "username is required" });
  const { user, token, listId } = await store.createUser(username);
  res.status(201).json({ user, token, listId });
});

/* Used by the "connect another device" flow to validate a pasted code. */
app.get("/api/me", requireDb, async (req, res) => {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const user = await store.findUserByToken(token);
  if (!user) return res.status(401).json({ error: "invalid code", code: "INVALID_TOKEN" });
  store.touchUser(user.userId).catch(() => {});
  res.json({ user, lists: await store.getListsForUser(user.userId) });
});

app.use("/api/admin", adminRouter(sockets));

app.use((err, _req, res, _next) => {
  if (err.message?.includes("CORS")) return res.status(403).json({ error: err.message });
  console.error(err);
  // Most unexpected failures here are the database being unreachable: tell clients to retry.
  res.status(503).json({ error: "server error", code: "SERVER_UNAVAILABLE" });
});

/* ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`Server listening on :${PORT} (database: ${store.mode})`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ") || "(localhost only)"}`);
});
store.init(); // connects + migrates in the background, retrying until the database answers

function shutdown() {
  io.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
