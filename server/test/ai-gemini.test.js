// Gemini client resilience, against a fake Gemini server (no network, no key, no running app server):
//   node test/ai-gemini.test.js
const assert = require("assert");
const http = require("http");

const calls = [];
let listed = ["gemini-2.5-flash", "gemini-3-flash"]; // what the fake key's model list returns
let script = {}; // model -> array of responses to hand out in order: { status, body } | "hang"
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.url.startsWith("/models?")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: listed.map((id) => ({
        name: "models/" + id,
        supportedGenerationMethods: id.includes("embedding") ? ["embedContent"] : ["generateContent"],
      })) }));
    }
    const model = decodeURIComponent(/\/models\/([^:]+):generateContent/.exec(req.url)[1]);
    const body = JSON.parse(raw || "{}");
    calls.push({ model, schema: !!body.generationConfig.responseSchema, thinking: body.generationConfig.thinkingConfig || null, key: req.headers["x-goog-api-key"] });
    const next = (script[model] || []).shift() || { status: 404, body: { error: { message: `models/${model} is not found` } } };
    if (next === "hang") return; // never answers
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(JSON.stringify(next.body));
  });
});

const answer = (text) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] } });
const good = JSON.stringify({ reply: "שקשוקה!", sections: [{ title: "שקשוקה", items: [{ name: "ביצים", quantity: "6", category: "dairy" }] }] });

(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.GEMINI_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.GEMINI_API_KEY = '  "test-key"\n';
  delete process.env.GEMINI_MODEL;
  const ai = require("../ai");
  const ask = () => ai.askGemini({ apiKey: "test-key", history: [], message: "ארוחת ערב?", listItems: [] });

  // Key check: picks a model the key can use; the alias is kept first.
  await ai.checkGemini();
  assert.equal(ai.health.ok, true);
  assert.equal(ai.health.model, "gemini-flash-latest");

  // Retired alias -> falls back to the next listed model.
  calls.length = 0;
  script = { "gemini-2.5-flash": [answer(good)] };
  let res = await ask();
  assert.equal(res.sections[0].items[0].name, "ביצים");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-flash-latest", "gemini-2.5-flash"]);
  assert.equal(calls[0].key, "test-key");
  assert.equal(ai.health.model, "gemini-2.5-flash", "remembers the model that worked");

  // Overloaded: no retry on the same model and no pause — the next model at once, while
  // the failed one rests for 60s.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 503, body: { error: { message: "The model is overloaded" } } }], "gemini-3-flash": [answer(good)] };
  let t0 = Date.now();
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash", "gemini-3-flash"]);
  assert(Date.now() - t0 < 1000, "no sleeping between models");
  assert(ai.health.cooldown.get("gemini-2.5-flash") - Date.now() > 55000, "the failed model rests 60s");
  calls.length = 0;
  script = { "gemini-3-flash": [answer(good)] };
  await ask();
  assert.deepEqual(calls.map((c) => c.model), ["gemini-3-flash"], "a resting model isn't called");
  ai.health.cooldown.clear();

  // A hanging model times out after attemptMs (not the whole budget) and the next one answers.
  const legacyTiming = { ...ai.TIMING.legacy };
  Object.assign(ai.TIMING.legacy, { attemptMs: 300, budgetMs: 2000 });
  calls.length = 0;
  script = { "gemini-3-flash": ["hang"], "gemini-2.5-flash": [answer(good)] };
  t0 = Date.now();
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert(Date.now() - t0 < 1000, `hang cut off at attemptMs (took ${Date.now() - t0}ms)`);
  // Every model hangs: a clean "busy" error within the budget, never a 45s wait.
  ai.health.cooldown.clear();
  script = { "gemini-2.5-flash": ["hang"], "gemini-3-flash": ["hang"] };
  t0 = Date.now();
  await assert.rejects(ask(), (e) => e.reason === "cooldown" && e.retryAfterMs > 0);
  assert(Date.now() - t0 <= 2100, `gave up within the budget (took ${Date.now() - t0}ms)`);
  Object.assign(ai.TIMING.legacy, legacyTiming);
  ai.health.cooldown.clear();
  ai.health.model = "gemini-2.5-flash";

  // Schema rejected -> same model again without responseSchema; fenced JSON is still parsed.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 400, body: { error: { message: "Invalid JSON payload received. Unknown name \"responseSchema\"" } } }, answer("```json\n" + good + "\n```")] };
  res = await ask();
  assert.equal(res.sections.length, 1);
  assert.deepEqual(calls.filter((c) => c.model === "gemini-2.5-flash").map((c) => c.schema), [true, false]);

  // Bad key -> fails fast with a clear reason, no pointless retries.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }] };
  await assert.rejects(ask(), (e) => e.reason === "invalid_key");
  assert.equal(calls.length, 1);

  // Quota (429): the model rests 60s, and a lite model (separate quota) is asked at once.
  listed = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
  await ai.checkGemini();
  const quota = (delay) => ({ status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota).",
    details: delay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] : [] } } });
  calls.length = 0;
  script = { "gemini-flash-latest": [quota("30s")], "gemini-2.5-flash": [quota()], "gemini-2.5-flash-lite": [answer(good)] };
  t0 = Date.now();
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"]);
  assert(Date.now() - t0 < 1000, "no pause after a quota hit");
  const rest = (m) => ai.health.cooldown.get(m) - Date.now();
  assert(rest("gemini-flash-latest") > 55000 && rest("gemini-2.5-flash") > 55000, "both rest 60s");
  assert.notEqual(ai.health.model, "gemini-2.5-flash-lite", "a lite stopgap doesn't become the main model");

  // While they rest, cooled models aren't called at all.
  calls.length = 0;
  script = { "gemini-2.5-flash-lite": [quota()] };
  await assert.rejects(ask(), (e) => e.reason === "quota" && e.retryAfterMs > 0);
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash-lite"]);
  // Everything resting: "busy" at once, without spending another request.
  calls.length = 0;
  t0 = Date.now();
  await assert.rejects(ask(), (e) => e.reason === "cooldown" && e.retryAfterMs > 0);
  assert.equal(calls.length, 0);
  assert(Date.now() - t0 < 50);
  ai.health.cooldown.clear();

  // Production case: the key's model list has none of the built-in names, and the
  // alias 404s. The server must move on to the Flash models the key does list.
  listed = ["gemini-3-flash-lite", "gemini-3-flash", "gemini-3-flash-image", "gemini-3-pro", "text-embedding-005"];
  await ai.checkGemini();
  assert.deepEqual(ai.rankFlashModels(listed), ["gemini-3-flash", "gemini-3-flash-lite"]);
  calls.length = 0;
  script = { "gemini-3-flash": [answer(good)] };
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-flash-latest", "gemini-3-flash"]);
  // The dead alias isn't retried on the next question.
  calls.length = 0;
  script = { "gemini-3-flash": [answer(good)] };
  await ask();
  assert.deepEqual(calls.map((c) => c.model), ["gemini-3-flash"]);
  // "not supported" about the request shape is a schema problem, not a missing model.
  assert.equal(ai.classify(400, "JSON mode is not supported for this model"), "schema");

  // Speed: thinking is turned down where the setting is known, and dropped if a model rejects it.
  assert.deepEqual(ai.thinkingConfigFor("gemini-2.5-flash"), { thinkingBudget: 0 });
  assert.deepEqual(ai.thinkingConfigFor("gemini-3-flash"), { thinkingLevel: "low" });
  assert.equal(ai.thinkingConfigFor("gemini-flash-latest"), null);
  calls.length = 0;
  script = { "gemini-3-flash": [{ status: 400, body: { error: { message: "Thinking level is not supported for this model." } } }, answer(good)] };
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.thinking), [{ thinkingLevel: "low" }, null]);

  // At most 8 products per answer, however many the model sends.
  const many = (n, p) => Array.from({ length: n }, (_, i) => ({ name: `${p}${i}`, quantity: "", category: "misc" }));
  const capped = ai.sanitizeAnswer({ reply: "x", sections: [{ title: "a", items: many(6, "a") }, { title: "b", items: many(6, "b") }, { title: "c", items: many(3, "c") }] });
  assert.deepEqual(capped.sections.map((x) => x.items.length), [6, 2]);

  // Lenient parsing helpers
  assert.deepEqual(ai.parseLooseJson('Sure! {"reply":"x","sections":[]} hope it helps'), { reply: "x", sections: [] });
  assert.equal(ai.parseLooseJson("no json here"), null);
  assert.equal(ai.classify(404, "models/x is not found"), "model_not_found");

  console.log("AI GEMINI CLIENT TESTS PASSED");
  fake.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
