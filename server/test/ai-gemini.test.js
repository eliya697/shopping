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

  // Overloaded once, then OK: one retry on the same model.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 503, body: { error: { message: "The model is overloaded" } } }, answer(good)] };
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash", "gemini-2.5-flash"]);

  // Overloaded twice: no third hammering of the same model; the next model, after a pause.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 503, body: {} }, { status: 500, body: {} }], "gemini-3-flash": [answer(good)] };
  let t0 = Date.now();
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash", "gemini-2.5-flash", "gemini-3-flash"]);
  assert(Date.now() - t0 >= 2000, "2s pause before falling back to another model");

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

  // Quota (429): the model rests for Gemini's retryDelay, and after a 2s pause a
  // lite model (separate quota) answers. 404s cost no quota and get no pause.
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
  assert(Date.now() - t0 >= 4000, "a 2s pause after each quota hit");
  const rest = (m) => ai.health.cooldown.get(m) - Date.now();
  assert(rest("gemini-flash-latest") > 25000 && rest("gemini-flash-latest") <= 30000, "uses Gemini's retryDelay");
  assert(rest("gemini-2.5-flash") > 55000, "defaults to 60s");
  assert.notEqual(ai.health.model, "gemini-2.5-flash-lite", "a lite stopgap doesn't become the main model");

  // While they rest, cooled models aren't called at all.
  calls.length = 0;
  script = { "gemini-2.5-flash-lite": [quota()] };
  await assert.rejects(ask(), (e) => e.reason === "quota" && e.retryAfterMs > 0);
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash-lite"]);
  // Everything cooling down: answer "quota" at once, without spending another request.
  calls.length = 0;
  await assert.rejects(ask(), (e) => e.reason === "quota" && e.retryAfterMs > 0);
  assert.equal(calls.length, 0);
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
