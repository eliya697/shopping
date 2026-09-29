// v2 smoke test: multiple lists, invite codes, notes/quantity, offline duplicate merge, legacy ops.
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");
const URL = process.env.URL || "http://localhost:3000";
const assert = require("assert");
const { randomUUID } = require("crypto");

async function register(name) {
  const r = await fetch(URL + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name }) });
  return r.json();
}
const connect = (token) => new Promise((res, rej) => {
  const s = io(URL, { auth: { token }, transports: ["websocket"], forceNew: true });
  s.once("session", (sess) => res({ s, sess }));
  s.once("connect_error", rej);
});
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const next = (s, ev, ms = 2000) => new Promise((r, j) => { const t = setTimeout(() => j(new Error("timeout waiting " + ev)), ms); s.once(ev, (d) => { clearTimeout(t); r(d); }); });

(async () => {
  const a = await register("Alice");
  const b = await register("Bob");
  const A = await connect(a.token);
  const B = await connect(b.token);

  // Only-list protection
  assert.equal((await emit(A.s, "list:delete", { listId: a.listId })).error, "cannot delete your only list");

  // Create + rename a second list
  const pharmacy = randomUUID();
  let upd = next(A.s, "lists:updated");
  const created = await emit(A.s, "list:create", { listId: pharmacy, name: "בית מרקחת" });
  assert(created.ok, JSON.stringify(created));
  assert.equal((await upd).lists.length, 2);
  assert.equal((await emit(A.s, "list:create", { listId: pharmacy, name: "x" })).ok, false);

  // Invite code: Bob joins by code (lowercase + dash tolerated)
  const { code } = await emit(A.s, "list:share_code", { listId: pharmacy });
  assert.match(code, /^[A-Z2-9]{8}$/);
  await emit(A.s, "join:list", { listId: pharmacy });
  const joinedEvt = next(A.s, "list:member_joined");
  const membersEvt = next(A.s, "list:members");
  const j = await emit(B.s, "list:join_by_code", { code: code.slice(0, 4).toLowerCase() + "-" + code.slice(4) });
  assert(j.ok && j.listId === pharmacy, JSON.stringify(j));
  assert.equal((await joinedEvt).user.username, "Bob");
  const mem = await membersEvt;
  assert.equal(mem.members.length, 2); assert.equal(mem.name, "בית מרקחת");
  assert((await emit(B.s, "list:join_by_code", { code })).already);
  assert.equal((await emit(B.s, "list:join_by_code", { code: "ZZZZZZZZ" })).error, "invalid code");
  // Only the owner may regenerate
  assert.equal((await emit(B.s, "list:share_code", { listId: pharmacy, regenerate: true })).ok, false);
  const regen = await emit(A.s, "list:share_code", { listId: pharmacy, regenerate: true });
  assert.notEqual(regen.code, code);

  // Rename propagates
  await emit(B.s, "join:list", { listId: pharmacy });
  let m = next(B.s, "list:members");
  assert((await emit(A.s, "list:rename", { listId: pharmacy, name: "פארם" })).ok);
  assert.equal((await m).name, "פארם");
  assert.equal((await emit(B.s, "list:rename", { listId: pharmacy, name: "x" })).ok, false);

  // Items with quantity + notes, field-level update
  const id1 = randomUUID();
  let added = next(B.s, "item:added");
  await emit(A.s, "item:add", { listId: pharmacy, item: { itemId: id1, text: "אקמול", category: "hygiene", quantity: "2 חבילות", notes: "" } });
  const ai = (await added).item;
  assert.equal(ai.quantity, "2 חבילות"); assert.equal(ai.qty, 2);
  let u = next(A.s, "item:updated");
  await emit(B.s, "item:update", { listId: pharmacy, itemId: id1, changes: { notes: "  לילדים  " } });
  let ui = (await u).item;
  assert.equal(ui.notes, "לילדים"); assert.equal(ui.quantity, "2 חבילות"); assert.equal(ui.text, "אקמול");
  u = next(A.s, "item:updated");
  await emit(B.s, "item:update", { listId: pharmacy, itemId: id1, changes: { quantity: "", category: "bogus" } });
  ui = (await u).item;
  assert.equal(ui.quantity, ""); assert.equal(ui.category, "hygiene"); assert.equal(ui.notes, "לילדים");
  assert((await emit(B.s, "item:update", { listId: pharmacy, itemId: randomUUID(), changes: { notes: "x" } })).missing);

  // Legacy v1 ops
  u = next(A.s, "item:updated");
  await emit(B.s, "item:update_qty", { listId: pharmacy, itemId: id1, qty: 3 });
  assert.equal((await u).item.quantity, "3");
  const legacyId = randomUUID();
  const la = await emit(B.s, "item:add", { listId: pharmacy, item: { itemId: legacyId, text: "פלסטר", category: "misc", qty: 1 } });
  assert.equal(la.item.quantity, "");

  // Offline duplicate: Bob "adds" אקמול again with his own id -> merged, no broadcast
  let gotBroadcast = false; A.s.once("item:added", () => { gotBroadcast = true; });
  const dupId = randomUUID();
  const dup = await emit(B.s, "item:add", { listId: pharmacy, item: { itemId: dupId, text: " אקמול " } });
  assert.equal(dup.mergedInto, id1);
  // Replay of an already stored add is a no-op
  const replay = await emit(A.s, "item:add", { listId: pharmacy, item: { itemId: id1, text: "אקמול" } });
  assert(replay.ok && !replay.mergedInto);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gotBroadcast, false);

  // Checked items don't count as duplicates
  await emit(A.s, "item:toggle", { listId: pharmacy, itemId: id1, isCompleted: true });
  const again = await emit(B.s, "item:add", { listId: pharmacy, item: { itemId: randomUUID(), text: "אקמול" } });
  assert(!again.mergedInto);

  // Lists carry names + remaining counts
  const listsA = (await next(A.s, "lists:updated", 50).catch(() => null)) || null;
  const bLists = (await (await fetch(URL + "/api/me", { headers: { authorization: "Bearer " + b.token } })).json()).lists;
  const ph = bLists.find((l) => l.listId === pharmacy);
  assert.equal(ph.name, "פארם"); assert.equal(ph.ownerName, "Alice"); assert.equal(ph.remaining, 2);

  // Bob can leave (he has his own list too); owner deletes -> everyone evicted
  const removedB = next(B.s, "list:removed");
  assert((await emit(A.s, "list:delete", { listId: pharmacy })).ok);
  assert.equal((await removedB).reason, "deleted");
  assert.equal((await emit(B.s, "item:add", { listId: pharmacy, item: { itemId: randomUUID(), text: "x" } })).ok, false);

  // Owner removes a member whose only list it was -> they get a fresh list
  const c = await register("Carol");
  const C = await connect(c.token);
  const { code: code2 } = await emit(A.s, "list:share_code", { listId: a.listId });
  await emit(C.s, "join:list", { listId: c.listId });
  // Carol deletes... can't delete her only list
  assert.equal((await emit(C.s, "list:delete", { listId: c.listId })).ok, false);
  await emit(C.s, "list:join_by_code", { code: code2 });
  assert((await emit(C.s, "list:delete", { listId: c.listId })).ok); // now allowed: she's in Alice's list
  assert.equal((await emit(C.s, "list:remove_member", { listId: a.listId, userId: c.user.userId })).error, "cannot leave your only list");
  const freshLists = next(C.s, "lists:updated");
  assert((await emit(A.s, "list:remove_member", { listId: a.listId, userId: c.user.userId })).ok);
  let fl = await freshLists;
  while (fl.lists.length !== 1) fl = await next(C.s, "lists:updated");
  assert.equal(fl.lists[0].ownerId, c.user.userId);

  console.log("ALL V2 SMOKE TESTS PASSED");
  [A, B, C].forEach((x) => x.s.close());
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
