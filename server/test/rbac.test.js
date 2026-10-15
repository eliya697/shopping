// Role-based access control + owner account recovery.
// Run against a server started with ADMIN_SECRET_KEY=$ADMIN_KEY and an EMPTY database
// (no owner account yet), e.g. DB_PATH=/tmp/rbac.db.
const URL = process.env.URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-secret-key-123";
const ADMIN_EMAIL = "eliyamistriel1234@gmail.com";
const assert = require("assert");
const { randomUUID } = require("crypto");
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");

const json = async (path, opts = {}) => {
  const r = await fetch(URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const bearer = (token) => ({ authorization: "Bearer " + token });
const register = async (name) => (await json("/api/register", { method: "POST", body: JSON.stringify({ username: name }) })).body;
const claim = (token, email, secretKey) =>
  json("/api/admin/claim-owner", { method: "POST", headers: bearer(token), body: JSON.stringify({ email, secretKey }) });
const me = async (token) => (await json("/api/me", { headers: bearer(token) })).body;

const connect = (token) => new Promise((res, rej) => {
  const s = io(URL, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
  s.once("session", (session) => res({ s, session }));
  s.once("connect_error", rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));

(async () => {
  // New accounts are regular users, and the email never appears in responses.
  const alice = await register("alice-rbac");
  assert.equal(alice.user.role, "user");
  assert.equal(alice.user.isAdmin, false);
  assert.ok(!("email" in alice.user));

  // Regular users get 403 on every admin route; no credentials is 401.
  assert.equal((await json("/api/admin/users")).status, 401);
  for (const path of ["/api/admin/users", "/api/admin/lists", "/api/admin/health", "/api/admin/export"]) {
    const r = await json(path, { headers: bearer(alice.token) });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.code, "FORBIDDEN");
  }
  assert.equal((await json("/api/admin/session", { method: "POST", headers: bearer(alice.token) })).status, 403);

  // Knowing the email is not enough: the secret key is required to become owner.
  assert.equal((await claim(alice.token, ADMIN_EMAIL, "wrong-key-wrong-key")).status, 401);
  assert.equal((await claim(alice.token, "someone@else.com", ADMIN_KEY)).status, 401);
  assert.equal((await claim("not-a-token", ADMIN_EMAIL, ADMIN_KEY)).status, 401);
  assert.equal((await me(alice.token)).user.role, "user");

  // With the key (email case/space-insensitive), the account becomes the owner.
  const ok = await claim(alice.token, "  Eliyamistriel1234@Gmail.com ", ADMIN_KEY);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.recovered, false, "the first claim must not merge (start this test on an empty database)");
  assert.equal(ok.body.user.role, "owner");
  assert.equal(ok.body.user.isAdmin, true);
  assert.ok(ok.body.session.token);
  const aliceMe = (await me(alice.token)).user;
  assert.equal(aliceMe.role, "owner");
  assert.ok(!("email" in aliceMe));
  // Claiming again from the owner account itself changes nothing.
  assert.equal((await claim(alice.token, ADMIN_EMAIL, ADMIN_KEY)).body.user.userId, alice.user.userId);

  // The owner account passes requireAdmin directly and can mint a dashboard session.
  assert.equal((await json("/api/admin/users", { headers: bearer(alice.token) })).status, 200);
  const session = await json("/api/admin/session", { method: "POST", headers: bearer(alice.token) });
  assert.equal(session.status, 200);
  assert.equal((await json("/api/admin/lists", { headers: bearer(session.body.token) })).status, 200);
  const listed = (await json("/api/admin/users", { headers: bearer(alice.token) })).body.users;
  assert.equal(listed.find((u) => u.userId === alice.user.userId).role, "owner");

  /*
   * Owner recovery. The owner's device lost its storage and is now on a fresh account
   * ("bob") that made a list with an item and shared it with carol. Proving the owner
   * credentials from that device must NOT move the role onto the empty account:
   * it folds bob into the original owner account instead.
   */
  const bob = await register("bob-rbac");
  const carol = await register("carol-rbac");
  const B = await connect(bob.token);
  const C = await connect(carol.token);
  const groceries = randomUUID();
  assert((await emit(B.s, "list:create", { listId: groceries, name: "Groceries" })).ok);
  assert((await emit(B.s, "item:add", { listId: groceries, item: { itemId: randomUUID(), text: "milk" } })).ok);
  const { code } = await emit(B.s, "list:share_code", { listId: groceries });
  assert((await emit(C.s, "list:join_by_code", { code })).ok);
  assert((await emit(C.s, "join:list", { listId: groceries })).ok); // carol has the list open

  const bobDisconnected = new Promise((r) => B.s.once("disconnect", r));
  const carolSeesNewOwner = new Promise((r) => C.s.on("list:members", (m) => { if (m.listId === groceries && m.ownerId === alice.user.userId) r(m); }));
  const rec = await claim(bob.token, ADMIN_EMAIL, ADMIN_KEY);
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.recovered, true);
  assert.equal(rec.body.user.userId, alice.user.userId, "the device is now the original owner account");
  assert.equal(rec.body.user.role, "owner");
  const recoveredIds = rec.body.lists.map((l) => l.listId);
  assert(recoveredIds.includes(alice.listId), "keeps the owner's own list");
  assert(recoveredIds.includes(groceries), "brings the device's real list along");
  assert(!recoveredIds.includes(bob.listId), "drops the fresh account's empty auto-list");
  assert.equal(rec.body.lists.find((l) => l.listId === groceries).ownerId, alice.user.userId);
  await bobDisconnected; // its sockets are dropped so they reconnect as the owner
  const members = await carolSeesNewOwner; // other members are told in real time
  assert.deepEqual(members.members.map((m) => m.userId).sort(), [alice.user.userId, carol.user.userId].sort());

  // Both tokens now sign in as the owner account; bob's account no longer exists.
  assert.equal((await me(bob.token)).user.userId, alice.user.userId);
  assert.equal((await me(alice.token)).user.role, "owner");
  const B2 = await connect(bob.token);
  assert.equal(B2.session.user.userId, alice.user.userId);
  assert.equal(B2.session.user.role, "owner");
  const users = (await json("/api/admin/users", { headers: bearer(alice.token) })).body.users;
  assert(!users.some((u) => u.userId === bob.user.userId));
  assert.equal(users.filter((u) => u.role === "owner").length, 1, "still exactly one owner");
  // The merged list kept its item and its added-by now points at the owner.
  const st = await new Promise((r) => { B2.s.once("list:state", r); B2.s.emit("join:list", { listId: groceries }); });
  assert.equal(st.items.length, 1);
  assert.equal(st.items[0].addedBy, alice.user.userId);

  // Dashboard repair for an account lost before recovery existed: merge it into the owner.
  const old = await register("old-owner-device");
  const D = await connect(old.token);
  assert((await emit(D.s, "item:add", { listId: old.listId, item: { itemId: randomUUID(), text: "bread" } })).ok);
  assert.equal((await json(`/api/admin/users/${old.user.userId}/merge`, { method: "POST", headers: bearer(carol.token), body: "{}" })).status, 403);
  const merged = await json(`/api/admin/users/${old.user.userId}/merge`, { method: "POST", headers: bearer(alice.token), body: "{}" });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.into.userId, alice.user.userId);
  const afterRepair = (await me(old.token));
  assert.equal(afterRepair.user.userId, alice.user.userId);
  assert(afterRepair.lists.some((l) => l.listId === old.listId && l.ownerId === alice.user.userId), "non-empty list kept and now owned");
  assert.equal((await json(`/api/admin/users/${alice.user.userId}/merge`, { method: "POST", headers: bearer(alice.token), body: "{}" })).status, 400);

  [B2, C, D].forEach((x) => x.s.close());
  // Clean up the test accounts (deleting the owner removes every token, including the merged ones).
  await json(`/api/admin/users/${carol.user.userId}`, { method: "DELETE", headers: bearer(alice.token) });
  await json(`/api/admin/users/${alice.user.userId}`, { method: "DELETE", headers: bearer(alice.token) });
  assert.equal((await json("/api/me", { headers: bearer(bob.token) })).status, 401, "merged tokens die with the account");
  console.log("RBAC + RECOVERY TESTS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
