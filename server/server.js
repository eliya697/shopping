"use strict";

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const store = require("./db");
const attachSockets = require("./sockets");

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
const corsOptions = { origin: checkOrigin, methods: ["GET", "POST"] };

/* ---------- Express ---------- */
const app = express();
app.set("trust proxy", 1); // Render/Railway/Fly sit behind a proxy; needed for req.ip
app.use(cors(corsOptions));
app.use(express.json({ limit: "10kb" }));

app.get("/", (_req, res) => res.type("text").send("Shopping list server is running."));
app.get("/health", (_req, res) => res.json({ ok: true, time: Date.now() }));

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

app.post("/api/register", (req, res) => {
  if (registerRateLimited(req.ip)) return res.status(429).json({ error: "too many accounts, try later" });
  const username = typeof req.body?.username === "string" ? req.body.username.trim().slice(0, 30) : "";
  if (!username) return res.status(400).json({ error: "username is required" });
  const { user, token, listId } = store.createUser(username);
  res.status(201).json({ user, token, listId });
});

/* Used by the "connect another device" flow to validate a pasted code. */
app.get("/api/me", (req, res) => {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const user = store.findUserByToken(token);
  if (!user) return res.status(401).json({ error: "invalid code" });
  res.json({ user, lists: store.getListsForUser(user.userId) });
});

app.use((err, _req, res, _next) => {
  if (err.message?.includes("CORS")) return res.status(403).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

/* ---------- Socket.io ---------- */
const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  pingInterval: 25000,
  pingTimeout: 20000,
});
attachSockets(io);

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`Allowed origins: ${allowedOrigins.join(", ") || "(localhost only)"}`);
});

function shutdown() {
  io.close();
  server.close(() => {
    store.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
