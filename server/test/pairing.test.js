// Device pairing with a 6-digit code. Run against a live server (npm test).
const assert = require("assert");
const URL = process.env.URL || "http://localhost:3000";

const json = async (path, opts = {}) => {
  const r = await fetch(URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (path, body, token) => json(path, {
  method: "POST",
  body: JSON.stringify(body || {}),
  headers: token ? { authorization: "Bearer " + token } : {},
});

(async () => {
  const a = (await post("/api/register", { username: "Pairer" })).body;

  // Only a signed-in device can create a code.
  assert.equal((await post("/api/pair/start", {})).status, 401);
  assert.equal((await post("/api/pair/start", {}, "nope")).status, 401);

  const first = await post("/api/pair/start", {}, a.token);
  assert.equal(first.status, 200);
  assert.match(first.body.code, /^\d{6}$/);
  assert(first.body.ttlMs > 0);

  // A new code replaces the previous one.
  const second = (await post("/api/pair/start", {}, a.token)).body;
  if (second.code !== first.body.code) {
    assert.equal((await post("/api/pair/redeem", { code: first.body.code })).status, 404, "old code is dead");
  }

  // Redeem: formatting is tolerated, the token and lists come back, and the code is single use.
  const spaced = second.code.slice(0, 3) + " " + second.code.slice(3);
  const ok = await post("/api/pair/redeem", { code: spaced });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.token, a.token);
  assert.equal(ok.body.user.userId, a.user.userId);
  assert(ok.body.lists.some((l) => l.listId === a.listId));
  assert.equal((await post("/api/pair/redeem", { code: second.code })).status, 404, "single use");

  // Guessing is rate-limited per IP.
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    limited = (await post("/api/pair/redeem", { code: "000000" })).status === 429;
  }
  assert(limited, "wrong guesses get rate-limited");

  console.log("PAIRING TESTS PASSED");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
