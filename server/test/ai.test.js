// AI assistant endpoint. Runs against a live server with or without GEMINI_API_KEY;
// it never needs a real Gemini answer (that would cost quota and be non-deterministic).
const assert = require("assert");
const aiRouter = require("../ai");
const URL = process.env.URL || "http://localhost:3000";

const json = async (path, opts = {}) => {
  const r = await fetch(URL + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const chat = (body, token) => json("/api/ai/chat", {
  method: "POST",
  body: JSON.stringify(body),
  headers: token ? { authorization: "Bearer " + token } : {},
});

(async () => {
  // ---- sanitizeAnswer: model output is untrusted shape-wise
  const clean = aiRouter.sanitizeAnswer({
    reply: "  שלום  ",
    sections: [
      { title: "פסטה", items: [{ name: "פסטה", quantity: "500 גרם", category: "pantry" }, { name: "פסטה", quantity: "", category: "pantry" }, { name: "בזיליקום", category: "nonsense" }] },
      { title: "ריק", items: [] },
      "garbage",
    ],
  });
  assert.equal(clean.reply, "שלום");
  assert.equal(clean.sections.length, 1, "empty and malformed sections are dropped");
  assert.deepEqual(clean.sections[0].items.map((i) => i.name), ["פסטה", "בזיליקום"], "duplicates are dropped");
  assert.equal(clean.sections[0].items[1].category, "misc", "unknown categories fall back to misc");
  assert.deepEqual(aiRouter.sanitizeAnswer(null), { reply: "", sections: [] });

  // ---- HTTP contract
  const { enabled } = (await json("/api/ai/status")).body;
  if (!enabled) {
    const res = await chat({ message: "היי" });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "AI_DISABLED");
    console.log("AI TESTS PASSED (server has no GEMINI_API_KEY: checked the disabled path)");
    return;
  }
  assert.equal((await chat({ message: "היי" })).status, 401, "anonymous calls are rejected");
  assert.equal((await chat({ message: "היי" }, "not-a-token")).body.code, "INVALID_TOKEN");
  const { token } = (await json("/api/register", { method: "POST", body: JSON.stringify({ username: "AI tester" }) })).body;
  assert.equal((await chat({ message: "   " }, token)).status, 400, "empty message is a 400");
  console.log("AI TESTS PASSED");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
