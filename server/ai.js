"use strict";

/*
 * /api/ai/chat — the in-app shopping assistant, backed by Google Gemini (REST API,
 * no SDK needed on Node 20+).
 *
 * Only signed-in users can call it (Authorization: Bearer <device token>), with a
 * per-user hourly limit, so the GEMINI_API_KEY can't be burned by anonymous traffic.
 *
 * Gemini is asked for structured JSON:
 *   { reply: "<conversational Hebrew>", sections: [{ title, items: [{ name, quantity, category }] }] }
 * The app renders `reply` as the chat bubble and every section as a card with
 * "add to list" buttons.
 *
 * Reliability: Google renames and retires models, rejects schemas, and answers
 * "model overloaded" under load. So the server
 *   - checks the key on startup and picks a model the key can actually use
 *     (result in the Render log and in GET /api/ai/status),
 *   - falls back to other Flash models when a model is gone,
 *   - retries transient errors (503/500/timeouts) with a short backoff,
 *   - retries without the JSON schema if Gemini rejects it, and parses JSON leniently,
 *   - tells the app *why* a call failed (`reason`) instead of a bare 502.
 */
const express = require("express");
const store = require("./db");

// GEMINI_API_BASE exists only so tests can point this at a fake server.
const GEMINI_API = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";
// Tried after GEMINI_MODEL, then every Flash model the key's model list reports (newest first).
// "gemini-flash-latest" is Google's alias for the current Flash model. (gemini-1.5-* was retired in 2025.)
const MODEL_CANDIDATES = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
// Lighter models have separate (and larger) free-tier quotas: the fallback when a model answers 429.
const LITE_CANDIDATES = ["gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
// Tried first, but only if the key's model list still reports them (Google retired gemini-1.5-* in 2025).
const LEGACY_IF_LISTED = ["gemini-1.5-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro"];
const MAX_MAIN_MODELS = 3;
const MAX_LITE_MODELS = 2;
const FALLBACK_DELAY_MS = 2000; // between models after a quota/transient failure, so retries don't hammer the quota
const MAX_QUOTA_FALLBACKS = 2; // per question
const QUOTA_COOLDOWN_MS = 60000; // when Gemini doesn't say how long to wait
// Short answers are fast answers: the prompt asks for at most 8 products and the server enforces it.
const MAX_ITEMS_PER_ANSWER = 8;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS_PER_MODEL = 2; // one retry for transient errors (overloaded, timeout), then the next model
const TOTAL_BUDGET_MS = 45000; // all models and retries together; the app waits 60s

const LIMIT_PER_HOUR = 40;
const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY_TURNS = 12;
const MAX_TURN_CHARS = 2000;
const MAX_LIST_ITEMS = 80;

const CATEGORY_KEYS = ["produce", "bakery", "dairy", "meat", "frozen", "pantry", "snacks", "drinks", "cleaning", "hygiene", "misc"];

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING", description: "The conversational answer, in Hebrew, plain text (no markdown)." },
    sections: {
      type: "ARRAY",
      description: "Groups of products the user can add to their shopping list. Empty when nothing to buy is suggested.",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Group title in Hebrew, e.g. a recipe name or 'פירות העונה'." },
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING", description: "Short product name in Hebrew as written on a shopping list, e.g. 'חזה עוף'." },
                quantity: { type: "STRING", description: "Optional amount with unit in Hebrew, e.g. '500 גרם', '2', '1 ק״ג'. Empty string if not relevant." },
                category: { type: "STRING", enum: CATEGORY_KEYS },
              },
              required: ["name", "quantity", "category"],
            },
          },
        },
        required: ["title", "items"],
      },
    },
  },
  required: ["reply", "sections"],
};

function systemPrompt(now = new Date()) {
  const date = now.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "long", year: "numeric" });
  return [
    "אתה עוזר חכם בתוך אפליקציית רשימת קניות ישראלית: מומחה לתכנון ארוחות, בישול ביתי וקניות חכמות בסופר.",
    `התאריך היום: ${date} (ישראל). כשנשאלים על עונתיות, התייחס לעונה הנוכחית בישראל ולמה שזמין וזול עכשיו בשווקים.`,
    "ענה תמיד בעברית, בטון חם וענייני, בטקסט רגיל ללא Markdown. reply קצר: 1–3 משפטים (עד כ-50 מילים).",
    "",
    "מהירות לפני שלמות: הצע לכל היותר 6 עד 8 מוצרים רלוונטיים במיוחד בכל התשובה (סך הכל, בכל הקבוצות יחד),",
    "בקבוצה אחת או שתיים לכל היותר. עדיף מעט מוצרים מדויקים מאשר רשימה ארוכה.",
    "Provide a maximum of 6 to 8 highly relevant items per response. Prioritize speed and conciseness over exhaustive lists.",
    "",
    "חשוב מאוד: כל מוצר או מצרך שאתה ממליץ לקנות (מתכונים, רעיונות לארוחות, פירות וירקות העונה, קניות בתקציב,",
    "מזונות עשירים בחלבון וכו') חייב להופיע במערך sections — האפליקציה מציגה ליד כל פריט שם כפתור \"הוסף לרשימה\".",
    "אל תסתפק ברשימת מצרכים בתוך הטקסט: בשדה reply תן הסבר קצר, ואת המוצרים עצמם שים ב-sections.",
    "קבץ לפי מתכון או נושא (title), עם שם מוצר קצר כפי שכותבים ברשימת קניות (\"חזה עוף\", לא \"500 גרם חזה עוף טרי\"),",
    "כמות משוערת ב-quantity כשזה רלוונטי (\"500 גרם\", \"2\", \"1 ק״ג\", אחרת מחרוזת ריקה), וקטגוריה אחת מתוך:",
    CATEGORY_KEYS.join(", ") + ".",
    "אל תכפיל מוצרים בתוך אותה קבוצה. אם מוצר כבר ברשימה של המשתמש (מופיע בהקשר), ציין זאת ואל תציע אותו שוב.",
    "אם השאלה לא קשורה לאוכל, בישול או קניות — ענה בקצרה ובנימוס והחזר sections ריק.",
    "אל תמציא מחירים מדויקים; מותר לתת הערכות כלליות (זול/יקר).",
    "",
    "פורמט התשובה: אובייקט JSON יחיד בלבד, בלי טקסט לפניו או אחריו:",
    '{"reply": "...", "sections": [{"title": "...", "items": [{"name": "...", "quantity": "...", "category": "produce"}]}]}',
  ].join("\n");
}

/* The key as pasted into Render: tolerate surrounding whitespace, newlines or quotes. */
const geminiKey = () => String(process.env.GEMINI_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim();

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Per-user rate limit (in memory; resets on restart, good enough for a single instance) ---------- */
const hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < 3600 * 1000);
  if (recent.length >= LIMIT_PER_HOUR) {
    hits.set(userId, recent);
    return Math.ceil((recent[0] + 3600 * 1000 - now) / 1000);
  }
  recent.push(now);
  hits.set(userId, recent);
  return 0;
}
/* A failed call shouldn't count against the user's hourly questions. */
function refund(userId) {
  const recent = hits.get(userId);
  if (recent && recent.length) recent.pop();
}
setInterval(() => hits.clear(), 3600 * 1000).unref();
setInterval(() => {
  const now = Date.now();
  for (const [m, until] of health.cooldown) if (until <= now) health.cooldown.delete(m);
}, 30000).unref();

/* ---------- Errors ----------
 * reason: invalid_key | forbidden | model_not_found | quota | overloaded | timeout | schema | bad_response | blocked | network
 */
class GeminiError extends Error {
  constructor(reason, message, status) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

function classify(status, message) {
  const m = String(message || "");
  if (status === 400 && /api key|API_KEY/i.test(m)) return "invalid_key";
  if (status === 401 || status === 403) return /api key|API_KEY/i.test(m) ? "invalid_key" : "forbidden";
  if (status === 429) return "quota";
  if (status === 400 && /thinking/i.test(m)) return "thinking";
  // Request-shape problems first: "JSON mode is not supported…" is not a missing model.
  if (status === 400 && /schema|response_mime_type|responseMimeType|mime type|JSON mode|Invalid JSON payload|Unknown name/i.test(m)) return "schema";
  if (status === 404 || /models\/\S+ is not found|not found for API version|not supported for generateContent|no longer available/i.test(m)) return "model_not_found";
  if (status >= 500) return "overloaded";
  return "bad_request";
}

/* Gemini's own error text, safe to show: trimmed, and any API key in it redacted. */
const redact = (text) => String(text || "").replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza…").slice(0, 300);

const TRANSIENT = new Set(["overloaded", "timeout", "bad_response", "network"]);

/* ---------- Model selection ---------- */
const health = {
  checked: false,
  ok: null, // true once the key was confirmed (startup check or a successful answer)
  model: null, // the model currently used first
  reason: null, // last failure reason, for /api/ai/status
  available: null, // Set of model ids the key can call generateContent on, if known
  dead: new Set(), // models that answered "not found" — skipped from then on
  cooldown: new Map(), // model -> time its quota (429) should have recovered
  lastError: null, // { reason, detail, model, at } of the last failed question
  checkedAt: null,
};

/*
 * "gemini-2.5-flash" > "gemini-2.0-flash"; stable before preview; full before lite.
 * Only text chat models: no image/tts/live/audio/embedding variants.
 */
function rankFlashModels(ids) {
  const version = (id) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || "0");
  return ids
    .filter((id) => /^gemini-.*flash/.test(id) && !/image|tts|live|audio|embedding|vision|thinking-exp|learnlm|omni/.test(id))
    .sort((a, b) =>
      version(b) - version(a)
      || /preview|exp/.test(a) - /preview|exp/.test(b)
      || /lite/.test(a) - /lite/.test(b)
      || a.length - b.length);
}

const isLite = (id) => /lite/.test(id);

function modelOrder(now = Date.now()) {
  const configured = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL.trim()] : [];
  const listed = (m) => !health.available || !health.available.size || health.available.has(m) || /latest$/.test(m) || configured.includes(m);
  const usable = (m) => listed(m) && !health.dead.has(m) && !((health.cooldown.get(m) || 0) > now);
  const discovered = health.available ? rankFlashModels([...health.available]) : [];
  const legacy = health.available ? LEGACY_IF_LISTED.filter((m) => health.available.has(m)) : [];

  const main = [...new Set([...configured, health.model, ...legacy, ...MODEL_CANDIDATES, ...discovered.filter((m) => !isLite(m))])]
    .filter((m) => m && usable(m))
    .slice(0, MAX_MAIN_MODELS + configured.length);
  const lite = [...new Set([...LITE_CANDIDATES, ...discovered.filter(isLite)])]
    .filter((m) => usable(m) && !main.includes(m))
    .slice(0, MAX_LITE_MODELS);
  return [...main, ...lite];
}

/* "37s" / "1.5s" (google.rpc.RetryInfo) -> ms */
function retryDelayMs(body) {
  const details = (body && body.error && body.error.details) || [];
  const info = details.find((d) => /RetryInfo/.test(d["@type"] || ""));
  const secs = info && parseFloat(String(info.retryDelay || "").replace(/s$/, ""));
  return secs > 0 ? Math.ceil(secs * 1000) : null;
}

/*
 * On startup: list the models this key can use. Confirms the key works (or says
 * exactly why not in the Render log) and picks a model that exists, so the first
 * user question doesn't hit a retired one.
 */
async function checkGemini(apiKey = geminiKey()) {
  if (!apiKey) return health;
  try {
    const models = [];
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
      const res = await fetch(`${GEMINI_API}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = redact((body.error && body.error.message) || `HTTP ${res.status}`);
        health.ok = false;
        health.reason = classify(res.status, message);
        health.lastError = { reason: health.reason, detail: message, model: null, at: Date.now() };
        console.error(`[ai] Gemini key check failed (${health.reason}): ${message}`);
        return health;
      }
      models.push(...(body.models || []));
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    health.available = new Set(
      models
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .filter(Boolean)
    );
    health.ok = true;
    health.reason = null;
    health.model = null;
    health.dead.clear();
    const order = modelOrder();
    health.model = order[0] || null;
    console.log(`[ai] Gemini key OK — ${health.available.size} models available; will try: ${order.join(", ") || "(no Flash model found!)"}`);
  } catch (err) {
    health.reason = "network";
    console.error(`[ai] Gemini key check could not reach Google: ${err.message}`);
  } finally {
    health.checked = true;
    health.checkedAt = Date.now();
  }
  return health;
}

/* ---------- Gemini call ---------- */
function buildContents(history, message, listItems) {
  const contents = history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }));
  const context = listItems.length
    ? `\n\n[הקשר: הפריטים שכבר ברשימת הקניות שלי: ${listItems.join(", ")}]`
    : "\n\n[הקשר: רשימת הקניות שלי ריקה כרגע]";
  contents.push({ role: "user", parts: [{ text: message + context }] });
  return contents;
}

function sanitizeAnswer(raw) {
  const reply = clip(raw && raw.reply, 4000);
  const sections = (Array.isArray(raw && raw.sections) ? raw.sections : [])
    .slice(0, 3)
    .map((s) => {
      const seen = new Set();
      const items = (Array.isArray(s && s.items) ? s.items : [])
        .map((i) => ({
          name: clip(i && i.name, 60),
          quantity: clip(i && i.quantity, 30),
          category: CATEGORY_KEYS.includes(i && i.category) ? i.category : "misc",
        }))
        .filter((i) => i.name && !seen.has(i.name) && seen.add(i.name))
        .slice(0, 25);
      return { title: clip(s && s.title, 80), items };
    })
    .filter((s) => s.items.length);
  // Enforce the item budget across all sections, whatever the model sent.
  let budget = MAX_ITEMS_PER_ANSWER;
  const trimmed = sections
    .map((s) => {
      const items = s.items.slice(0, budget);
      budget -= items.length;
      return { ...s, items };
    })
    .filter((s) => s.items.length);
  return { reply: reply || (trimmed.length ? "הנה כמה הצעות:" : ""), sections: trimmed };
}

/* JSON from the model: plain, fenced in ```json, or with stray text around it. */
function parseLooseJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* fall through */ }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fall through */ }
  }
  return null;
}

/*
 * Gemini 2.5+ "thinks" before answering, which is most of the wait for a simple
 * shopping answer. Turn it down where we know the setting: 2.5 Flash takes a token
 * budget (0 = off), Gemini 3 a level. Unknown models/aliases get the default, and a
 * model that rejects the setting is retried without it.
 */
function thinkingConfigFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-[3-9]/.test(model) && /flash/.test(model)) return { thinkingLevel: "low" };
  return null;
}

async function callModel({ apiKey, model, contents, useSchema, useThinkingConfig = true, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const thinkingConfig = useThinkingConfig ? thinkingConfigFor(model) : null;
  let res;
  try {
    res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192, // 2.5+ models count "thinking" tokens here too; too low truncates the JSON
          responseMimeType: "application/json",
          ...(useSchema ? { responseSchema: RESPONSE_SCHEMA } : {}),
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GeminiError(timedOut ? "timeout" : "network", `${model}: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body.error && body.error.message) || "request failed";
    const err = new GeminiError(classify(res.status, message), `${model} ${res.status}: ${redact(message)}`, res.status);
    err.detail = redact(message);
    err.model = model;
    if (err.reason === "quota") err.retryAfterMs = retryDelayMs(body) || QUOTA_COOLDOWN_MS;
    throw err;
  }
  const candidate = body.candidates && body.candidates[0];
  const text = candidate && candidate.content && (candidate.content.parts || []).map((p) => p.text || "").join("");
  if (!text) {
    const why = (candidate && candidate.finishReason) || (body.promptFeedback && body.promptFeedback.blockReason) || "empty";
    throw new GeminiError(/SAFETY|BLOCK|PROHIBITED|RECITATION/i.test(why) ? "blocked" : "bad_response", `${model}: no text (${why})`);
  }
  const parsed = parseLooseJson(text);
  if (!parsed || typeof parsed !== "object") throw new GeminiError("bad_response", `${model}: unparseable JSON`);
  return sanitizeAnswer(parsed);
}

async function askGemini({ apiKey, history, message, listItems }) {
  const contents = buildContents(history, message, listItems);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const models = modelOrder();

  // Every model is still cooling down after a 429: answer now instead of spending more quota.
  if (!models.length && health.cooldown.size) {
    const until = Math.min(...health.cooldown.values());
    const err = new GeminiError("quota", "all models are cooling down after quota errors");
    err.retryAfterMs = Math.max(1000, until - Date.now());
    throw err;
  }

  let lastError = new GeminiError("model_not_found", "no model to try");
  let quotaHits = 0;
  let quotaError = null; // reported over later 404s: "quota" is the useful answer
  let pauseBeforeNext = false;

  for (const model of models) {
    if (pauseBeforeNext) await sleep(FALLBACK_DELAY_MS);
    pauseBeforeNext = false;
    let useSchema = true;
    let useThinkingConfig = true;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) throw lastError.reason === "model_not_found" ? new GeminiError("timeout", "out of time") : lastError;
      try {
        const answer = await callModel({ apiKey, model, contents, useSchema, useThinkingConfig, timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining) });
        if (health.model !== model && !isLite(model)) console.log(`[ai] now using model ${model}`);
        // Lite models are a stopgap during a quota hit; keep preferring the main model.
        Object.assign(health, { ok: true, reason: null }, isLite(model) ? {} : { model });
        return answer;
      } catch (err) {
        lastError = err;
        console.warn(`[ai] ${model} attempt ${attempt} failed (${err.reason}): ${err.message}`);
        if (err.reason === "schema" && useSchema) {
          useSchema = false; // the prompt also describes the JSON shape
          continue;
        }
        if (err.reason === "thinking" && useThinkingConfig) {
          useThinkingConfig = false; // this model doesn't take our thinking setting: use its default
          continue;
        }
        if (err.reason === "model_not_found") {
          health.dead.add(model); // a 404 costs no quota: move on right away
          if (health.model === model) health.model = null;
          break;
        }
        if (err.reason === "quota") {
          // Quotas are per model: rest this one, and try another (a lite model) after a pause.
          health.cooldown.set(model, Date.now() + (err.retryAfterMs || QUOTA_COOLDOWN_MS));
          quotaError = err;
          if (++quotaHits > MAX_QUOTA_FALLBACKS) throw err;
          pauseBeforeNext = true;
          break;
        }
        if (TRANSIENT.has(err.reason) && attempt < MAX_ATTEMPTS_PER_MODEL) {
          await sleep(1000);
          continue;
        }
        if (TRANSIENT.has(err.reason)) {
          pauseBeforeNext = true; // this model keeps failing: next one, after a pause
          break;
        }
        throw err; // invalid_key, forbidden, blocked, bad_request: another model won't help
      }
    }
  }
  throw quotaError || lastError;
}

/* ---------- Router ---------- */
function aiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  /*
   * Safe to expose: no secrets, just whether the assistant works and why not.
   * ?refresh=1 re-runs the key check (at most once a minute).
   */
  router.get("/status", async (req, res) => {
    if (req.query.refresh && geminiKey() && Date.now() - (health.checkedAt || 0) > 60000) await checkGemini();
    res.json({
      enabled: !!geminiKey(),
      ok: health.ok,
      model: health.model,
      tryOrder: geminiKey() ? modelOrder() : [],
      availableFlash: health.available ? rankFlashModels([...health.available]) : null,
      notFound: [...health.dead],
      coolingDown: Object.fromEntries([...health.cooldown].map(([m, until]) => [m, Math.max(0, Math.ceil((until - Date.now()) / 1000))])),
      reason: health.reason,
      lastError: health.lastError,
      checkedAt: health.checkedAt,
    });
  });

  router.post("/chat", async (req, res) => {
    const apiKey = geminiKey();
    if (!apiKey) {
      return res.status(503).json({
        error: "AI assistant is not configured",
        code: "AI_DISABLED",
        message: "מפתח GEMINI_API_KEY חסר בשרת (Render)",
      });
    }
    if (!store.isReady()) {
      return res.set("Retry-After", "3").status(503).json({ error: "server is starting, try again", code: "SERVER_UNAVAILABLE" });
    }

    const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const user = token ? await store.findUserByToken(token) : null;
    if (!user) return res.status(401).json({ error: "sign in to use the assistant", code: "INVALID_TOKEN" });

    const message = clip(req.body && req.body.message, MAX_MESSAGE_CHARS);
    if (!message) return res.status(400).json({ error: "message is required" });

    const retryAfter = rateLimited(user.userId);
    if (retryAfter) {
      return res.set("Retry-After", String(retryAfter)).status(429).json({ error: "too many questions, try later", code: "RATE_LIMITED" });
    }

    // Gemini requires turns to alternate and start with the user.
    const history = [];
    (Array.isArray(req.body.history) ? req.body.history : []).slice(-MAX_HISTORY_TURNS).forEach((t) => {
      const role = t && t.role === "model" ? "model" : "user";
      const text = clip(t && t.text, MAX_TURN_CHARS);
      if (!text) return;
      if (!history.length && role !== "user") return;
      if (history.length && history[history.length - 1].role === role) history[history.length - 1].text += "\n" + text;
      else history.push({ role, text });
    });
    if (history.length && history[history.length - 1].role === "user") history.pop();

    const listItems = (Array.isArray(req.body.listItems) ? req.body.listItems : [])
      .map((n) => clip(n, 60))
      .filter(Boolean)
      .slice(0, MAX_LIST_ITEMS);

    try {
      const answer = await askGemini({ apiKey, history, message, listItems });
      store.touchUser(user.userId).catch(() => {});
      res.json(answer);
    } catch (err) {
      refund(user.userId);
      const reason = err.reason || "unknown";
      const detail = err.detail || redact(err.message);
      health.reason = reason;
      health.lastError = { reason, detail, model: err.model || null, at: Date.now() };
      if (reason === "invalid_key" || reason === "forbidden") health.ok = false;
      console.error(`[ai] giving up (${reason}): ${err.message}`);
      if (reason === "blocked") {
        return res.json({ reply: "אני לא יכול לעזור עם זה. אפשר לשאול אותי על ארוחות, מתכונים וקניות 🙂", sections: [] });
      }
      if (reason === "quota") {
        const retryAfter = Math.ceil((err.retryAfterMs || QUOTA_COOLDOWN_MS) / 1000);
        return res.set("Retry-After", String(retryAfter)).status(429).json({
          error: "Gemini quota exceeded",
          code: "AI_QUOTA",
          reason,
          message: "מכסת ה-AI הזמנית התמלאה. נסו שוב בעוד דקה.",
          retryAfter,
          detail,
          model: err.model || null,
        });
      }
      // Structured, so the app can say exactly what's wrong (bad key, missing model…).
      const body = { error: "assistant unavailable", code: "AI_FAILED", reason, detail, model: err.model || null };
      if (reason === "model_not_found" && health.available) body.tried = [...health.dead];
      res.status(502).json(body);
    }
  });

  return router;
}

aiRouter.sanitizeAnswer = sanitizeAnswer;
aiRouter.parseLooseJson = parseLooseJson;
aiRouter.classify = classify;
aiRouter.checkGemini = checkGemini;
aiRouter.askGemini = askGemini;
aiRouter.health = health;
aiRouter.modelOrder = modelOrder;
aiRouter.rankFlashModels = rankFlashModels;
aiRouter.thinkingConfigFor = thinkingConfigFor;
module.exports = aiRouter;
