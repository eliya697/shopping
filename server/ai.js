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
 */
const express = require("express");
const store = require("./db");

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = 30000;

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
    "ענה תמיד בעברית, בטון חם, ענייני ותמציתי (עד כ-120 מילים בשדה reply), בטקסט רגיל ללא Markdown.",
    "כשאתה ממליץ על מוצרים לקנייה — מתכונים, מצרכים, רעיונות לתקציב, מזונות עשירים בחלבון וכו' — החזר אותם גם במערך sections,",
    "מקובצים לפי נושא או מתכון, עם שם מוצר קצר כפי שכותבים ברשימת קניות, כמות משוערת כשזה רלוונטי, וקטגוריה מתאימה.",
    "אל תכפיל מוצרים בתוך אותה קבוצה. אם המשתמש כבר מחזיק מוצר ברשימה (מופיע בהקשר), ציין זאת ואל תציע אותו שוב.",
    "אם השאלה לא קשורה לאוכל, בישול או קניות — ענה בקצרה ובנימוס והחזר sections ריק.",
    "אל תמציא מחירים מדויקים; מותר לתת הערכות כלליות (זול/יקר).",
  ].join("\n");
}

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

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
setInterval(() => hits.clear(), 3600 * 1000).unref();

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
    .slice(0, 6)
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
  return { reply: reply || (sections.length ? "הנה כמה הצעות:" : ""), sections };
}

async function askGemini({ apiKey, model, history, message, listItems }) {
  const res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents: buildContents(history, message, listItems),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192, // 2.5 models count "thinking" tokens here too; too low truncates the JSON
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}: ${(body.error && body.error.message) || "request failed"}`);
    err.upstreamStatus = res.status;
    throw err;
  }
  const candidate = body.candidates && body.candidates[0];
  const text = candidate && candidate.content && (candidate.content.parts || []).map((p) => p.text || "").join("");
  if (!text) {
    const reason = (candidate && candidate.finishReason) || (body.promptFeedback && body.promptFeedback.blockReason) || "empty";
    const err = new Error(`gemini returned no text (${reason})`);
    err.blocked = /SAFETY|BLOCK|PROHIBITED/i.test(reason);
    throw err;
  }
  return sanitizeAnswer(JSON.parse(text));
}

/* ---------- Router ---------- */
function aiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  router.get("/status", (_req, res) => res.json({ enabled: !!process.env.GEMINI_API_KEY }));

  router.post("/chat", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "AI assistant is not configured", code: "AI_DISABLED" });
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
      const answer = await askGemini({ apiKey, model: process.env.GEMINI_MODEL || DEFAULT_MODEL, history, message, listItems });
      store.touchUser(user.userId).catch(() => {});
      res.json(answer);
    } catch (err) {
      console.error("[ai]", err.message);
      if (err.blocked) return res.json({ reply: "אני לא יכול לעזור עם זה. אפשר לשאול אותי על ארוחות, מתכונים וקניות 🙂", sections: [] });
      const status = err.upstreamStatus === 429 ? 429 : 502;
      res.status(status).json({ error: "assistant unavailable, try again", code: status === 429 ? "RATE_LIMITED" : "AI_FAILED" });
    }
  });

  return router;
}

aiRouter.sanitizeAnswer = sanitizeAnswer;
module.exports = aiRouter;
