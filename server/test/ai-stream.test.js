// Streaming AI Chef (/api/ai/chat/stream) against a fake Gemini SSE server — no network,
// no key, no database (the store is stubbed):
//   node test/ai-stream.test.js
const assert = require("assert");
const http = require("http");
const express = require("express");

const calls = [];
let script = {}; // model -> array of: { status, body } (error) | { chunks: [text...] } (SSE answer)
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.url.startsWith("/models?")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: ["gemini-2.5-flash", "gemini-3-flash"].map((id) => ({ name: "models/" + id, supportedGenerationMethods: ["generateContent"] })) }));
    }
    const m = /\/models\/([^:]+):(\w+)/.exec(req.url);
    const model = decodeURIComponent(m[1]);
    calls.push({ model, method: m[2], url: req.url, body: JSON.parse(raw || "{}") });
    const next = (script[model] || []).shift() || { status: 404, body: { error: { message: `models/${model} is not found` } } };
    if (!next.chunks) {
      res.writeHead(next.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(next.body));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const tick = () => {
      if (i >= next.chunks.length) return res.end();
      const last = i === next.chunks.length - 1;
      const candidate = { content: { role: "model", parts: [{ text: next.chunks[i++] }] }, ...(last ? { finishReason: "STOP" } : {}) };
      res.write(`data: ${JSON.stringify({ candidates: [candidate] })}\r\n\r\n`);
      setTimeout(tick, 5);
    };
    tick();
  });
});

const data = JSON.stringify({
  imageSummary: "במקרר: 6 ביצים, עגבניות, חצי בצל",
  missing: [{ name: "פלפל אדום", quantity: "1", category: "produce" }, { name: "פלפל אדום", quantity: "", category: "produce" }, { name: "גבינה בולגרית", quantity: "", category: "nope" }],
  sections: [{ title: "לשבת", items: [{ name: "חלה", quantity: "", category: "bakery" }, { name: "פלפל אדום", quantity: "", category: "produce" }] }],
});
// The marker arrives split across chunks: no piece of it may reach the user.
const shakshuka = ["רואה ביצים ועגבניות — ", "שקשוקה!\n1. מטגנים בצל.\n<<<DA", "TA>>>", data.slice(0, 20), data.slice(20)];

async function readEvents(res) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(raw);
      const payload = /^data: (.*)$/m.exec(raw);
      if (event) events.push({ event: event[1], data: JSON.parse(payload[1]) });
    }
  }
  return events;
}

(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.GEMINI_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;

  const store = require("../db");
  Object.assign(store, {
    isReady: () => true,
    findUserByToken: async (t) => (t === "good-token" ? { userId: "u1" } : null),
    touchUser: async () => {},
  });
  const ai = require("../ai");
  await ai.checkGemini();

  // ---- ReplySplitter: a marker split over many chunks, and text that only looks like one.
  let shown = "";
  const splitter = new ai.ReplySplitter((t) => { shown += t; });
  ["a <", "<", "<D", "AT", "A>>> {\"x\":1}"].forEach((c) => splitter.push(c));
  assert.deepEqual(splitter.end(), { text: "a", data: " {\"x\":1}" });
  assert.equal(shown, "a ", "marker never reaches onText (the trailing space is trimmed in the final reply)");
  shown = "";
  const plain = new ai.ReplySplitter((t) => { shown += t; });
  ["x <<<", "D", "ONE"].forEach((c) => plain.push(c));
  assert.equal(plain.end().text, "x <<<DONE");
  assert.equal(shown, "x <<<DONE", "a near-miss is released in full");

  // ---- parseImage
  assert.equal(ai.parseImage({ inlineData: { mimeType: "image/gif", data: "AAAA" } }), null);
  assert.equal(ai.parseImage({ mimeType: "image/jpeg", data: "not base64!" }), null);
  assert.deepEqual(ai.parseImage({ mimeType: "image/jpeg", data: "AA\nAA==" }), { mimeType: "image/jpeg", data: "AAAA==" });

  // ---- The HTTP endpoint
  const app = express();
  app.use("/api/ai", ai());
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/ai/chat/stream`;
  const post = (body, token = "good-token") => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });

  // Validation errors are plain JSON, before any stream starts.
  assert.equal((await post({ message: "hi" }, "bad")).status, 401);
  assert.equal((await post({ message: "  " })).status, 400);
  const badImage = await post({ message: "x", image: { mimeType: "text/html", data: "AAAA" } });
  assert.equal(badImage.status, 400);
  assert.equal((await badImage.json()).code, "BAD_IMAGE");

  // A photo question: first model is gone (404), the next one streams.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ chunks: shakshuka }] };
  const image = { inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQ" } };
  let res = await post({
    message: "מה לבשל?",
    image,
    history: [{ role: "user", text: "[צירפתי תמונה: גבינות]" }, { role: "model", text: "אפשר פסטה" }],
    listItems: ["חלב"],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  let events = await readEvents(res);
  const deltas = events.filter((e) => e.event === "delta").map((e) => e.data.text);
  assert(deltas.length >= 2, "the answer arrives in pieces");
  assert(!deltas.join("").includes("<<<") && !deltas.join("").includes("{"), "neither marker nor JSON is shown");
  const done = events.find((e) => e.event === "done").data;
  assert.equal(done.reply, "רואה ביצים ועגבניות — שקשוקה!\n1. מטגנים בצל.");
  assert.equal(done.imageSummary, "במקרר: 6 ביצים, עגבניות, חצי בצל");
  assert.deepEqual(done.missing.map((i) => [i.name, i.category]), [["פלפל אדום", "produce"], ["גבינה בולגרית", "misc"]], "deduped, categories checked");
  assert.deepEqual(done.sections[0].items.map((i) => i.name), ["חלה"], "items already in `missing` are not repeated");

  assert.deepEqual(calls.map((c) => c.model), ["gemini-flash-latest", "gemini-2.5-flash"]);
  const sent = calls[1];
  assert.equal(sent.method, "streamGenerateContent");
  assert.match(sent.url, /alt=sse/);
  const last = sent.body.contents[sent.body.contents.length - 1];
  assert.deepEqual(last.parts[0], { inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQ" } }, "the photo goes with the current question");
  assert.match(last.parts[1].text, /חלב/, "list context is included");
  assert(sent.body.contents.slice(0, -1).every((c) => c.parts.every((p) => "text" in p)), "history is text only");

  // A follow-up without a photo: no inlineData anywhere, imageSummary empty.
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ chunks: ["בטח, ", "גם עם פטריות.", "\n<<<DATA>>>", "{\"imageSummary\":\"x\",\"missing\":[],\"sections\":[]}"] }] };
  events = await readEvents(await post({ message: "ואם אין לי בצל?", history: [{ role: "user", text: "[תמונה: ביצים]" }, { role: "model", text: "שקשוקה" }] }));
  const followUp = events.find((e) => e.event === "done").data;
  assert.equal(followUp.imageSummary, "", "no photo, no summary");
  assert(!JSON.stringify(calls[0].body).includes("inlineData"));

  // The model forgot the marker: everything is the reply.
  script = { "gemini-2.5-flash": [{ chunks: ["רק טקסט ", "בלי נתונים"] }] };
  events = await readEvents(await post({ message: "היי" }));
  assert.deepEqual(events.find((e) => e.event === "done").data, { reply: "רק טקסט בלי נתונים", sections: [], missing: [], imageSummary: "" });

  // Suggestion chips: the first ask goes to Gemini without the asker's list (the answer is
  // shared); repeats within the hour are served from memory with no Gemini call.
  const chip = "מה בעונה עכשיו?";
  calls.length = 0;
  script = { "gemini-2.5-flash": [{ chunks: ["תותים ", "ותפוזים!", "\n<<<DATA>>>{\"missing\":[],\"sections\":[{\"title\":\"עונה\",\"items\":[{\"name\":\"תותים\",\"quantity\":\"\",\"category\":\"produce\"}]}]}"] }] };
  const first = (await readEvents(await post({ message: chip, listItems: ["חלב פרטי של מישהו"] }))).find((e) => e.event === "done").data;
  assert.equal(calls.length, 1);
  assert(!JSON.stringify(calls[0].body).includes("חלב פרטי"), "a shared answer isn't built from one user's list");
  calls.length = 0;
  let t0 = Date.now();
  events = await readEvents(await post({ message: `  ${chip} ` }));
  assert.equal(calls.length, 0, "cache hit: Gemini not called");
  assert(Date.now() - t0 < 200, "served immediately");
  assert.equal(events.find((e) => e.event === "delta").data.text, first.reply);
  assert.deepEqual(events.find((e) => e.event === "done").data, first);
  // Not cached: a chip asked mid-conversation, or any other text.
  script = { "gemini-2.5-flash": [{ chunks: ["אחר"] }, { chunks: ["אחר"] }] };
  await readEvents(await post({ message: chip, history: [{ role: "user", text: "היי" }, { role: "model", text: "שלום" }] }));
  await readEvents(await post({ message: "מה בעונה עכשיו" }));
  assert.equal(calls.length, 2);
  // Expired entries are dropped.
  for (const entry of ai.promptCache.values()) entry.expires = Date.now() - 1;
  script = { "gemini-2.5-flash": [{ chunks: ["חדש"] }] };
  calls.length = 0;
  await readEvents(await post({ message: chip }));
  assert.equal(calls.length, 1, "after the TTL, Gemini is asked again");

  // Quota on every model: one `error` event with the same shape /chat uses.
  script = {
    "gemini-2.5-flash": [{ status: 429, body: { error: { message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" }] } } }],
    "gemini-3-flash": [{ status: 429, body: { error: { message: "Quota exceeded" } } }],
  };
  events = await readEvents(await post({ message: "היי" }));
  const error = events.find((e) => e.event === "error");
  assert(error, JSON.stringify(events));
  assert.equal(error.data.code, "AI_QUOTA");
  assert(error.data.retryAfter > 0);

  server.close();
  fake.close();
  console.log("AI STREAM TESTS PASSED");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
