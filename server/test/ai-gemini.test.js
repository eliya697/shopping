// Gemini client resilience, against a fake Gemini server (no network, no key, no running app server):
//   node test/ai-gemini.test.js
const assert = require("assert");
const http = require("http");

const calls = [];
let script = {}; // model -> array of responses to hand out in order: { status, body } | "hang"
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.url.startsWith("/models?")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] },
      ] }));
    }
    const model = decodeURIComponent(/\/models\/([^:]+):generateContent/.exec(req.url)[1]);
    const body = JSON.parse(raw || "{}");
    calls.push({ model, schema: !!body.generationConfig.responseSchema, key: req.headers["x-goog-api-key"] });
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

  // Overloaded twice, then OK: retried on the same model.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 503, body: { error: { message: "The model is overloaded" } } }, { status: 500, body: {} }, answer(good)] };
  res = await ask();
  assert.equal(res.reply, "שקשוקה!");
  assert.deepEqual(calls.map((c) => c.model), ["gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-flash"]);

  // Schema rejected -> same model again without responseSchema; fenced JSON is still parsed.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 400, body: { error: { message: "Invalid JSON payload received. Unknown name \"responseSchema\"" } } }, answer("```json\n" + good + "\n```")] };
  res = await ask();
  assert.equal(res.sections.length, 1);
  assert.deepEqual(calls.map((c) => c.schema), [true, false]);

  // Bad key -> fails fast with a clear reason, no pointless retries.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }] };
  await assert.rejects(ask(), (e) => e.reason === "invalid_key");
  assert.equal(calls.length, 1);

  // Quota -> its own reason.
  script = { "gemini-2.5-flash": [{ status: 429, body: { error: { message: "Resource has been exhausted" } } }] };
  await assert.rejects(ask(), (e) => e.reason === "quota");

  // Lenient parsing helpers
  assert.deepEqual(ai.parseLooseJson('Sure! {"reply":"x","sections":[]} hope it helps'), { reply: "x", sections: [] });
  assert.equal(ai.parseLooseJson("no json here"), null);
  assert.equal(ai.classify(404, "models/x is not found"), "model_not_found");

  console.log("AI GEMINI CLIENT TESTS PASSED");
  fake.close();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
