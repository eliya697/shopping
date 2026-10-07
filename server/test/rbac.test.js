// Role-based access control. Run against a server started with ADMIN_SECRET_KEY=$ADMIN_KEY.
const URL = process.env.URL || "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-secret-key-123";
const ADMIN_EMAIL = "eliyamistriel1234@gmail.com";
const assert = require("assert");

const json = async (path, opts = {}) => {
  const r = await fetch(URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const bearer = (token) => ({ authorization: "Bearer " + token });
const register = async (name) => (await json("/api/register", { method: "POST", body: JSON.stringify({ username: name }) })).body;
const claim = (token, email, secretKey) =>
  json("/api/admin/claim-owner", { method: "POST", headers: bearer(token), body: JSON.stringify({ email, secretKey }) });

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
  assert.equal((await json("/api/me", { headers: bearer(alice.token) })).body.user.role, "user");

  // With the key (email case/space-insensitive), the account becomes the owner.
  const ok = await claim(alice.token, "  Eliyamistriel1234@Gmail.com ", ADMIN_KEY);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.role, "owner");
  assert.equal(ok.body.user.isAdmin, true);
  assert.ok(ok.body.session.token);
  const me = (await json("/api/me", { headers: bearer(alice.token) })).body.user;
  assert.equal(me.role, "owner");
  assert.ok(!("email" in me));

  // The owner account passes requireAdmin directly and can mint a dashboard session.
  assert.equal((await json("/api/admin/users", { headers: bearer(alice.token) })).status, 200);
  const session = await json("/api/admin/session", { method: "POST", headers: bearer(alice.token) });
  assert.equal(session.status, 200);
  assert.equal((await json("/api/admin/lists", { headers: bearer(session.body.token) })).status, 200);
  const listed = (await json("/api/admin/users", { headers: bearer(alice.token) })).body.users;
  assert.equal(listed.find((u) => u.userId === alice.user.userId).role, "owner");

  // Only one owner: a second claim moves the role, it doesn't duplicate it.
  const bob = await register("bob-rbac");
  assert.equal((await claim(bob.token, ADMIN_EMAIL, ADMIN_KEY)).body.user.role, "owner");
  assert.equal((await json("/api/me", { headers: bearer(alice.token) })).body.user.role, "user");
  assert.equal((await json("/api/admin/users", { headers: bearer(alice.token) })).status, 403);
  assert.equal((await json("/api/admin/users", { headers: bearer(bob.token) })).status, 200);

  // Clean up the test accounts.
  for (const u of [alice, bob]) await json(`/api/admin/users/${u.user.userId}`, { method: "DELETE", headers: bearer(bob.token) });
  console.log("RBAC TESTS PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
