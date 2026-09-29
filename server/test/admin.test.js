// Admin API + auth-error semantics. Run against a server started with ADMIN_SECRET_KEY=$ADMIN_KEY.
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");
const URL = process.env.URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-secret-key-123";
const ADMIN_EMAIL = "eliyamistriel1234@gmail.com";
const assert = require("assert");
const { randomUUID } = require("crypto");

const json = async (path, opts = {}) => {
  const r = await fetch(URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const register = async (name) => (await json("/api/register", { method: "POST", body: JSON.stringify({ username: name }) })).body;
const connect = (token) => new Promise((res, rej) => {
  const s = io(URL, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  s.once("session", (sess) => res({ s, sess }));
  s.once("connect_error", rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 3000) => new Promise((r, j) => { const t = setTimeout(() => j(new Error("timeout waiting " + ev)), ms); s.once(ev, (d) => { clearTimeout(t); r(d); }); });

(async () => {
  // Unknown token is rejected with the definitive code (message kept for old clients).
  const bad = await connect("definitely-not-a-token").catch((e) => e);
  assert.equal(bad.message, "unauthorized");
  assert.equal(bad.data.code, "INVALID_TOKEN");
  assert.equal((await json("/api/me", { headers: { authorization: "Bearer nope" } })).body.code, "INVALID_TOKEN");

  // Public availability check
  assert.deepEqual((await json("/api/admin/check")).body, { enabled: true, reason: null, minLength: 16 });
  // Malformed JSON is a 400, not a misleading 503
  assert.equal((await fetch(URL + "/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" })).status, 400);

  // Login
  assert.equal((await json("/api/admin/health")).status, 401);
  assert.equal((await json("/api/admin/login", { method: "POST", body: JSON.stringify({ email: ADMIN_EMAIL, secretKey: "wrong" }) })).status, 401);
  assert.equal((await json("/api/admin/login", { method: "POST", body: JSON.stringify({ email: "x@y.z", secretKey: ADMIN_KEY }) })).status, 401);
  const login = await json("/api/admin/login", { method: "POST", body: JSON.stringify({ email: " Eliyamistriel1234@gmail.com ", secretKey: ADMIN_KEY }) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const auth = { authorization: "Bearer " + login.body.token };
  const tampered = login.body.token.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await json("/api/admin/users", { headers: { authorization: "Bearer " + tampered } })).status, 401);

  // Fixtures: Dana owns a shared list with Eli
  const d = await register("Dana");
  const e = await register("Eli");
  const D = await connect(d.token);
  const E = await connect(e.token);
  const shared = randomUUID();
  await emit(D.s, "list:create", { listId: shared, name: "משותפת" });
  const { code } = await emit(D.s, "list:share_code", { listId: shared });
  assert((await emit(E.s, "list:join_by_code", { code })).ok);
  await emit(D.s, "item:add", { listId: shared, item: { itemId: randomUUID(), text: "חלב" } });

  // Health
  const health = await json("/api/admin/health", { headers: auth });
  assert.equal(health.status, 200);
  assert(health.body.uptimeSec >= 0 && health.body.memory.rss > 0);
  assert(health.body.sockets >= 2);
  assert.equal(health.body.db.status, "ok");
  assert(health.body.db.users >= 2);

  // Users
  const users = (await json("/api/admin/users", { headers: auth })).body.users;
  const du = users.find((u) => u.userId === d.user.userId);
  assert.equal(du.username, "Dana");
  assert(du.lastSeenAt > 0);
  assert(du.listIds.includes(shared) && du.listIds.includes(d.listId));

  // Lists
  const lists = (await json("/api/admin/lists", { headers: auth })).body.lists;
  const sl = lists.find((l) => l.listId === shared);
  assert.equal(sl.itemCount, 1); assert.equal(sl.userCount, 2); assert.equal(sl.ownerName, "Dana");

  // Delete list -> members are evicted live
  const removed = next(E.s, "list:removed");
  assert((await json("/api/admin/lists/" + shared, { method: "DELETE", headers: auth })).body.ok);
  assert.equal((await removed).listId, shared);
  assert.equal((await json("/api/admin/lists/" + shared, { method: "DELETE", headers: auth })).status, 404);

  // Cleanup (nothing is 14 days old in a fresh test DB, but the job must run)
  const cleanup = await json("/api/admin/cleanup", { method: "POST", headers: auth });
  assert(cleanup.body.ok && typeof cleanup.body.deleted === "number");

  // Export
  const dump = (await json("/api/admin/export", { headers: auth })).body;
  assert.equal(dump.format, "shopping-list-backup");
  assert(dump.tables.users.some((u) => u.user_id === d.user.userId));

  // Delete user -> their sockets drop, and the token is now definitively invalid
  const dropped = next(D.s, "disconnect");
  assert((await json("/api/admin/users/" + d.user.userId, { method: "DELETE", headers: auth })).body.ok);
  await dropped;
  const gone = await connect(d.token).catch((err) => err);
  assert.equal(gone.data.code, "INVALID_TOKEN");
  // Eli still has his own list
  assert((await json("/api/me", { headers: { authorization: "Bearer " + e.token } })).body.lists.length >= 1);

  console.log("ALL ADMIN TESTS PASSED");
  E.s.close();
})().catch((err) => { console.error("FAIL", err); process.exit(1); });
