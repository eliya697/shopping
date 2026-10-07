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

// Streaming (/chat/stream): the answer is shown while it is written, so only the wait for the
// *first* token and stalls between tokens are timed, not the whole answer.
const STREAM_IDLE_MS = 20000;
const STREAM_HEARTBEAT_MS = 15000; // SSE comment lines keep proxies (Render) from closing a quiet stream
const MAX_MISSING_ITEMS = 12;
const MAX_SUMMARY_CHARS = 600;
// One photo per question, already downscaled by the app (~1024px JPEG ≈ 150–400 KB of base64).
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;
const DEFAULT_IMAGE_QUESTION = "מה אפשר לבשל ממה שיש בתמונה, ומה חסר לי?";

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

/*
 * Streaming answers can't be one JSON object (the user would watch braces appear), so the
 * model writes readable text first, then DATA_MARKER and a JSON trailer that the server
 * holds back and parses:
 *   { imageSummary: "...", missing: [items], sections: [{ title, items }] }
 */
const DATA_MARKER = "<<<DATA>>>";

function streamSystemPrompt(now = new Date()) {
  const date = now.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "long", year: "numeric" });
  return [
    "אתה AI Chef: עוזר חכם בתוך אפליקציית רשימת קניות ישראלית — מומחה לתכנון ארוחות, בישול ביתי וקניות חכמות.",
    `התאריך היום: ${date} (ישראל). כשנשאלים על עונתיות, התייחס לעונה הנוכחית בישראל.`,
    "",
    "חלק 1 — התשובה: כתוב בעברית, בטקסט רגיל ללא Markdown (בלי כוכביות, סולמיות או טבלאות), בטון חם וענייני.",
    "קצר ולעניין: עד כ-120 מילים. במתכון: שם המנה, ואז שלבי הכנה ממוספרים וקצרים.",
    "אם צורפה תמונה (מקרר/מזווה/מצרכים): פתח במשפט אחד על מה שרואים, והצע מתכון שמתבסס בעיקר על מה שיש.",
    "אם השאלה לא קשורה לאוכל, בישול או קניות — ענה בקצרה ובנימוס.",
    "אל תמציא מחירים מדויקים.",
    "",
    `חלק 2 — הנתונים: מיד אחרי התשובה, בשורה חדשה, כתוב בדיוק ${DATA_MARKER} ואחריו אובייקט JSON יחיד בשורה אחת, בלי שום טקסט אחריו:`,
    '{"imageSummary": "...", "missing": [{"name": "...", "quantity": "...", "category": "dairy"}], "sections": [{"title": "...", "items": [...]}]}',
    "- imageSummary: רק אם צורפה תמונה בהודעה הנוכחית — מלאי תמציתי בעברית של מה שנראה בה (מצרכים וכמויות משוערות, עד 60 מילים). אחרת מחרוזת ריקה.",
    "  התיאור הזה יחליף את התמונה בהמשך השיחה, אז כלול בו כל מה שחשוב לשאלות המשך.",
    "- missing: מצרכים שהמתכון או ההצעה שלך צריכים ושאין למשתמש (לא נראים בתמונה ולא ברשימת הקניות שבהקשר). עד 10.",
    "- sections: מוצרים נוספים שאתה ממליץ לקנות שאינם חלק מ-missing (רעיונות לארוחות, פירות העונה וכו'), קבוצה אחת או שתיים, עד 8 מוצרים בסך הכל. מערך ריק אם אין.",
    "כל פריט: name — שם קצר כמו ברשימת קניות (\"חזה עוף\", לא \"500 גרם חזה עוף טרי\"); quantity — כמות משוערת (\"500 גרם\", \"2\") או מחרוזת ריקה;",
    "category — אחת מתוך: " + CATEGORY_KEYS.join(", ") + ".",
    "אל תציע מוצר שכבר ברשימת הקניות של המשתמש (מופיעה בהקשר).",
    `Always end with ${DATA_MARKER} followed by the JSON object, even when missing and sections are empty.`,
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
/*
 * History is text only: a photo travels once, with the question it belongs to. Later turns
 * carry the photo's text summary instead (the app puts it in the history), which keeps
 * follow-up requests small and fast.
 */
function buildContents(history, message, listItems, image = null) {
  const contents = history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }));
  const context = listItems.length
    ? `\n\n[הקשר: הפריטים שכבר ברשימת הקניות שלי: ${listItems.join(", ")}]`
    : "\n\n[הקשר: רשימת הקניות שלי ריקה כרגע]";
  const parts = [{ text: message + context }];
  if (image) parts.unshift({ inlineData: { mimeType: image.mimeType, data: image.data } });
  contents.push({ role: "user", parts });
  return contents;
}

/* { inlineData: { mimeType, data } } or { mimeType, data } -> the same, validated; else null. */
function parseImage(raw) {
  const d = raw && typeof raw === "object" ? raw.inlineData || raw : null;
  if (!d || typeof d.data !== "string" || !IMAGE_TYPES.has(d.mimeType)) return null;
  const data = d.data.replace(/\s+/g, "");
  if (!data || data.length > MAX_IMAGE_BASE64_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(data)) return null;
  return { mimeType: d.mimeType, data };
}

/* Model-made product list -> short, deduplicated, known categories. */
function sanitizeItems(list, max) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((i) => ({
      name: clip(i && i.name, 60),
      quantity: clip(i && i.quantity, 30),
      category: CATEGORY_KEYS.includes(i && i.category) ? i.category : "misc",
    }))
    .filter((i) => i.name && !seen.has(i.name) && seen.add(i.name))
    .slice(0, max);
}

function sanitizeAnswer(raw) {
  const reply = clip(raw && raw.reply, 4000);
  const sections = (Array.isArray(raw && raw.sections) ? raw.sections : [])
    .slice(0, 3)
    .map((s) => ({ title: clip(s && s.title, 80), items: sanitizeItems(s && s.items, 25) }))
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

/*
 * Runs run({ model, useSchema, useThinkingConfig, timeoutMs }) on each model in modelOrder()
 * until one succeeds: retries transient errors, rests a model after a quota hit, drops a
 * missing model, and gives up at once on errors another model can't fix.
 */
async function tryModels(run) {
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
        const answer = await run({ model, useSchema, useThinkingConfig, timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining) });
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
        throw err; // invalid_key, forbidden, blocked, bad_request, cancelled: another model won't help
      }
    }
  }
  throw quotaError || lastError;
}

async function askGemini({ apiKey, history, message, listItems }) {
  const contents = buildContents(history, message, listItems);
  return tryModels((o) => callModel({ apiKey, contents, ...o }));
}

/* ---------- Streaming ---------- */

/*
 * Opens :streamGenerateContent (the REST call behind the SDK's generateContentStream).
 * Resolves once Gemini accepted the request, so tryModels can still fall back to another
 * model on 404/429/503; after that the answer is committed to this model.
 */
async function openStream({ apiKey, model, contents, useThinkingConfig, timeoutMs, signal }) {
  const thinkingConfig = useThinkingConfig ? thinkingConfigFor(model) : null;
  const controller = new AbortController();
  const onCancel = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new GeminiError("cancelled", "client went away");
    signal.addEventListener("abort", onCancel, { once: true });
  }
  const firstByte = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: streamSystemPrompt() }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }),
    });
  } catch (err) {
    if (signal && signal.aborted) throw new GeminiError("cancelled", "client went away");
    const timedOut = controller.signal.aborted || (err && (err.name === "TimeoutError" || err.name === "AbortError"));
    throw new GeminiError(timedOut ? "timeout" : "network", `${model}: ${err.message}`);
  } finally {
    clearTimeout(firstByte);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body.error && body.error.message) || "request failed";
    const err = new GeminiError(classify(res.status, message), `${model} ${res.status}: ${redact(message)}`, res.status);
    err.detail = redact(message);
    err.model = model;
    if (err.reason === "quota") err.retryAfterMs = retryDelayMs(body) || QUOTA_COOLDOWN_MS;
    throw err;
  }
  return { res, model, controller, release: () => signal && signal.removeEventListener("abort", onCancel) };
}

/* Gemini's SSE body -> parsed `data:` payloads. Aborts the request if it stalls for idleMs. */
async function* readSse(res, controller, idleMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let timer;
      const stalled = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new GeminiError("timeout", `stream stalled for ${idleMs / 1000}s`));
        }, idleMs);
      });
      const { value, done } = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { yield JSON.parse(data); } catch (e) { /* a malformed event: skip it */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/*
 * Passes the readable answer through (onText) and keeps everything after DATA_MARKER.
 * The tail of each chunk that could be the start of a marker split across chunks is held
 * back until the next chunk shows whether it is one.
 */
class ReplySplitter {
  constructor(onText) {
    this.onText = onText;
    this.pending = "";
    this.text = "";
    this.data = null; // string once the marker was seen
  }

  push(chunk) {
    if (this.data !== null) {
      this.data += chunk;
      return;
    }
    this.pending += chunk;
    const at = this.pending.indexOf(DATA_MARKER);
    if (at !== -1) {
      this.emit(this.pending.slice(0, at).replace(/\s+$/, ""));
      this.data = this.pending.slice(at + DATA_MARKER.length);
      this.pending = "";
      return;
    }
    let keep = Math.min(this.pending.length, DATA_MARKER.length - 1);
    while (keep && !DATA_MARKER.startsWith(this.pending.slice(-keep))) keep--;
    this.emit(this.pending.slice(0, this.pending.length - keep));
    this.pending = this.pending.slice(this.pending.length - keep);
  }

  end() {
    if (this.data === null) this.emit(this.pending);
    this.pending = "";
    return { text: this.text.trim(), data: this.data };
  }

  emit(text) {
    if (!text) return;
    this.text += text;
    this.onText(text);
  }
}

/* The streamed text + JSON trailer -> { reply, sections, missing, imageSummary }. */
function finalizeStream(text, data, hadImage) {
  const parsed = (data !== null && parseLooseJson(data)) || {};
  const missing = sanitizeItems(parsed.missing, MAX_MISSING_ITEMS);
  const missingNames = new Set(missing.map((i) => i.name));
  const { reply, sections } = sanitizeAnswer({
    reply: text,
    sections: (Array.isArray(parsed.sections) ? parsed.sections : []).map((s) => ({
      ...s,
      items: (s && Array.isArray(s.items) ? s.items : []).filter((i) => !missingNames.has(clip(i && i.name, 60))),
    })),
  });
  // Without a summary the next turn would know nothing about the photo: the answer itself
  // (which opens by describing it) is the next best thing.
  const imageSummary = hadImage ? clip(parsed.imageSummary, MAX_SUMMARY_CHARS) || clip(text, MAX_SUMMARY_CHARS) : "";
  return { reply: reply || (missing.length ? "אלה המצרכים שחסרים לך:" : ""), sections, missing, imageSummary };
}

/*
 * One streamed question. onText(delta) gets the answer as Gemini writes it; resolves with
 * the structured parts once the stream ends. `signal` aborts the Gemini call (client left).
 */
async function streamGemini({ apiKey, history, message, listItems, image = null, signal, onText }) {
  const contents = buildContents(history, message, listItems, image);
  const stream = await tryModels((o) => openStream({ apiKey, contents, signal, ...o }));
  const splitter = new ReplySplitter(onText);
  let finish = null;
  let blocked = null;
  try {
    for await (const chunk of readSse(stream.res, stream.controller, STREAM_IDLE_MS)) {
      if (chunk.error) {
        const message = chunk.error.message || "stream error";
        throw new GeminiError(classify(chunk.error.code, message), `${stream.model}: ${redact(message)}`, chunk.error.code);
      }
      if (chunk.promptFeedback && chunk.promptFeedback.blockReason) blocked = chunk.promptFeedback.blockReason;
      const candidate = chunk.candidates && chunk.candidates[0];
      if (!candidate) continue;
      // Thought summaries (if a model sends them) are not part of the answer.
      ((candidate.content && candidate.content.parts) || []).forEach((p) => {
        if (p.text && !p.thought) splitter.push(p.text);
      });
      if (candidate.finishReason) finish = candidate.finishReason;
    }
  } catch (err) {
    if (signal && signal.aborted) throw new GeminiError("cancelled", "client went away");
    if (err instanceof GeminiError) throw Object.assign(err, { model: err.model || stream.model });
    throw Object.assign(new GeminiError("network", `${stream.model}: ${err.message}`), { model: stream.model });
  } finally {
    stream.release();
  }
  const { text, data } = splitter.end();
  if (!text && data === null) {
    const why = blocked || finish || "empty";
    throw Object.assign(
      new GeminiError(/SAFETY|BLOCK|PROHIBITED|RECITATION/i.test(why) ? "blocked" : "bad_response", `${stream.model}: no text (${why})`),
      { model: stream.model }
    );
  }
  return finalizeStream(text, data, !!image);
}

/* ---------- Router ---------- */

/*
 * What every chat request needs before Gemini is called: a configured key, a ready
 * database, a signed-in user under the hourly limit, and a clean history. Answers the
 * request itself (and returns null) when something is missing.
 */
async function prepareChat(req, res, { allowImage = false } = {}) {
  const apiKey = geminiKey();
  if (!apiKey) {
    res.status(503).json({
      error: "AI assistant is not configured",
      code: "AI_DISABLED",
      message: "מפתח GEMINI_API_KEY חסר בשרת (Render)",
    });
    return null;
  }
  if (!store.isReady()) {
    res.set("Retry-After", "3").status(503).json({ error: "server is starting, try again", code: "SERVER_UNAVAILABLE" });
    return null;
  }

  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const user = token ? await store.findUserByToken(token) : null;
  if (!user) {
    res.status(401).json({ error: "sign in to use the assistant", code: "INVALID_TOKEN" });
    return null;
  }

  const body = req.body || {};
  let image = null;
  if (allowImage && body.image) {
    image = parseImage(body.image);
    if (!image) {
      res.status(400).json({ error: "image must be a JPEG/PNG/WebP/HEIC under ~3.5 MB", code: "BAD_IMAGE" });
      return null;
    }
  }
  const message = clip(body.message, MAX_MESSAGE_CHARS) || (image ? DEFAULT_IMAGE_QUESTION : "");
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return null;
  }

  const retryAfter = rateLimited(user.userId);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter)).status(429).json({ error: "too many questions, try later", code: "RATE_LIMITED" });
    return null;
  }

  // Gemini requires turns to alternate and start with the user. Text only: photos in earlier
  // turns were replaced by their summaries on the client.
  const history = [];
  (Array.isArray(body.history) ? body.history : []).slice(-MAX_HISTORY_TURNS).forEach((t) => {
    const role = t && t.role === "model" ? "model" : "user";
    const text = clip(t && t.text, MAX_TURN_CHARS);
    if (!text) return;
    if (!history.length && role !== "user") return;
    if (history.length && history[history.length - 1].role === role) history[history.length - 1].text += "\n" + text;
    else history.push({ role, text });
  });
  if (history.length && history[history.length - 1].role === "user") history.pop();

  const listItems = (Array.isArray(body.listItems) ? body.listItems : [])
    .map((n) => clip(n, 60))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);

  return { apiKey, user, message, history, listItems, image };
}

/*
 * A failed question -> { status, headers, body } the app understands, and the failure
 * recorded for /api/ai/status. Status 200 means "answer with this body instead".
 */
function describeFailure(err) {
  const reason = err.reason || "unknown";
  const detail = err.detail || redact(err.message);
  health.reason = reason;
  health.lastError = { reason, detail, model: err.model || null, at: Date.now() };
  if (reason === "invalid_key" || reason === "forbidden") health.ok = false;
  console.error(`[ai] giving up (${reason}): ${err.message}`);
  if (reason === "blocked") {
    return { status: 200, headers: {}, body: { reply: "אני לא יכול לעזור עם זה. אפשר לשאול אותי על ארוחות, מתכונים וקניות 🙂", sections: [] } };
  }
  if (reason === "quota") {
    const retryAfter = Math.ceil((err.retryAfterMs || QUOTA_COOLDOWN_MS) / 1000);
    return {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
      body: {
        error: "Gemini quota exceeded",
        code: "AI_QUOTA",
        reason,
        message: "מכסת ה-AI הזמנית התמלאה. נסו שוב בעוד דקה.",
        retryAfter,
        detail,
        model: err.model || null,
      },
    };
  }
  // Structured, so the app can say exactly what's wrong (bad key, missing model…).
  const body = { error: "assistant unavailable", code: "AI_FAILED", reason, detail, model: err.model || null };
  if (reason === "model_not_found" && health.available) body.tried = [...health.dead];
  return { status: 502, headers: {}, body };
}

function aiRouter() {
  const router = express.Router();
  const smallJson = express.json({ limit: "64kb" });
  // A downscaled photo is a few hundred KB of base64; the limit leaves room for a large one.
  const photoJson = express.json({ limit: "8mb" });

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

  /* The original request/response endpoint (kept for app versions without streaming). */
  router.post("/chat", smallJson, async (req, res) => {
    const chat = await prepareChat(req, res);
    if (!chat) return;
    try {
      const answer = await askGemini(chat);
      store.touchUser(chat.user.userId).catch(() => {});
      res.json(answer);
    } catch (err) {
      refund(chat.user.userId);
      const failure = describeFailure(err);
      res.set(failure.headers).status(failure.status).json(failure.body);
    }
  });

  /*
   * Streaming endpoint: Server-Sent Events over a POST, read with fetch() on the client
   * (EventSource can't POST a body or send an Authorization header).
   *
   * Problems found before Gemini is called get a normal JSON error, exactly like /chat.
   * After that the response is text/event-stream:
   *   event: delta  data: { text }                                     the answer as it is written
   *   event: done   data: { reply, sections, missing, imageSummary }   the final, structured answer
   *   event: error  data: { code, reason, message, detail, retryAfter } same shape as /chat errors
   * plus ": ping" comment lines while Gemini is quiet.
   */
  router.post("/chat/stream", photoJson, async (req, res) => {
    const chat = await prepareChat(req, res, { allowImage: true });
    if (!chat) return;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // no proxy buffering
    });
    const open = () => !res.writableEnded && !res.destroyed;
    const send = (event, data) => open() && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write(": stream open\n\n");
    const heartbeat = setInterval(() => open() && res.write(": ping\n\n"), STREAM_HEARTBEAT_MS);

    // The user closed the app or started a new chat: stop paying for tokens nobody reads.
    const cancel = new AbortController();
    res.on("close", () => { if (!res.writableFinished) cancel.abort(); });

    let streamed = false;
    try {
      const answer = await streamGemini({
        ...chat,
        signal: cancel.signal,
        onText: (text) => {
          streamed = true;
          send("delta", { text });
        },
      });
      store.touchUser(chat.user.userId).catch(() => {});
      send("done", answer);
    } catch (err) {
      if (!streamed) refund(chat.user.userId);
      if (err.reason === "cancelled") return;
      const failure = describeFailure(err);
      if (failure.status === 200) send("done", { ...failure.body, missing: [], imageSummary: "" });
      else send("error", failure.body);
    } finally {
      clearInterval(heartbeat);
      if (open()) res.end();
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
aiRouter.streamGemini = streamGemini;
aiRouter.ReplySplitter = ReplySplitter;
aiRouter.finalizeStream = finalizeStream;
aiRouter.parseImage = parseImage;
aiRouter.DATA_MARKER = DATA_MARKER;
module.exports = aiRouter;
