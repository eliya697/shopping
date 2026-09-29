// v1 compatibility test (clients from before multi-list): two users, share, real-time add/toggle/delete/clear, auth rejection.
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");
const URL = process.env.URL || "http://localhost:3000";
const assert = require("assert");

async function register(name) {
  const r = await fetch(URL + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name }) });
  return r.json();
}
const connect = (token) => new Promise((res, rej) => {
  const s = io(URL, { auth: { token }, transports: ["websocket"] });
  s.once("session", (sess) => res({ s, sess }));
  s.once("connect_error", rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev) => new Promise((r) => s.once(ev, r));

(async () => {
  const a = await register("Alice");
  const b = await register("Bob");
  assert(a.token && a.user.userId && a.listId);

  // Bad token rejected
  await assert.rejects(connect("nope"));

  const A = await connect(a.token);
  const B = await connect(b.token);
  assert.equal(A.sess.lists.length, 1);

  // Using Bob's *public* userId as a token must not work
  await assert.rejects(connect(b.user.userId));

  // Bob cannot join Alice's list before sharing
  assert.equal((await emit(B.s, "join:list", { listId: a.listId })).ok, false);

  const notif = next(B.s, "list:shared_notification");
  const listsUpd = next(B.s, "lists:updated");
  const sh = await emit(A.s, "share:list", { listId: a.listId, targetUserId: b.user.userId });
  assert(sh.ok, JSON.stringify(sh));
  assert.equal((await notif).from.username, "Alice");
  assert.equal((await listsUpd).lists.length, 2);

  // Bob cannot re-share Alice's list (not owner)
  assert.equal((await emit(B.s, "share:list", { listId: a.listId, targetUserId: a.user.userId })).ok, false);

  await emit(A.s, "join:list", { listId: a.listId });
  const stP = next(B.s, "list:state");
  assert((await emit(B.s, "join:list", { listId: a.listId })).ok);
  assert.equal((await stP).list.members.length, 2);

  const itemId = "11111111-2222-3333-4444-555555555555";
  let got = next(B.s, "item:added");
  await emit(A.s, "item:add", { listId: a.listId, item: { itemId, text: "חלב", category: "dairy", qty: 2 } });
  const added = await got;
  assert.equal(added.item.text, "חלב"); assert.equal(added.item.addedBy, a.user.userId);

  // Replayed add is idempotent
  assert((await emit(A.s, "item:add", { listId: a.listId, item: { itemId, text: "חלב", category: "dairy" } })).ok);

  got = next(A.s, "item:toggled");
  await emit(B.s, "item:toggle", { listId: a.listId, itemId, isCompleted: true });
  assert.equal((await got).isCompleted, true);

  got = next(B.s, "item:updated");
  await emit(A.s, "item:update_qty", { listId: a.listId, itemId, qty: 500 });
  assert.equal((await got).item.qty, 99);

  got = next(A.s, "item:cleared");
  await emit(B.s, "item:clear_completed", { listId: a.listId });
  assert.deepEqual((await got).itemIds, [itemId]);

  const id2 = "22222222-2222-3333-4444-555555555555";
  await emit(A.s, "item:add", { listId: a.listId, item: { itemId: id2, text: "לחם" } });
  got = next(A.s, "item:deleted");
  await emit(B.s, "item:delete", { listId: a.listId, itemId: id2 });
  assert.equal((await got).itemId, id2);

  // Bob leaves
  const removed = next(B.s, "list:removed");
  assert((await emit(B.s, "list:remove_member", { listId: a.listId, userId: b.user.userId })).ok);
  await removed;
  assert.equal((await emit(B.s, "item:add", { listId: a.listId, item: { itemId: id2, text: "x" } })).ok, false);

  // /api/me with token
  const me = await (await fetch(URL + "/api/me", { headers: { authorization: "Bearer " + a.token } })).json();
  assert.equal(me.user.username, "Alice");

  // CORS: foreign origin rejected, localhost allowed
  const bad = await fetch(URL + "/health", { headers: { origin: "https://evil.example" } });
  assert.equal(bad.status, 403);

  console.log("ALL SMOKE TESTS PASSED");
  A.s.close(); B.s.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
