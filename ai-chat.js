/*
 * AIChat — the "AI assistant" tab: a chat with the Gemini-backed /api/ai/chat/stream
 * endpoint. The answer is shown as it is written (Server-Sent Events read with fetch);
 * when it is complete, suggested products and the ingredients missing for the recipe
 * arrive as structured lists, shown as cards with one-tap "add to list" buttons.
 *
 * Photos (Fridge Vision) are sent once, with the question they belong to. The server
 * answers with a text summary of the photo, and later turns send that summary instead of
 * the image, so follow-up questions stay small and fast.
 *
 * The conversation lives in memory only: every app start (and "שיחה חדשה") begins
 * fresh, showing just the suggestion chips. The app supplies the
 * account token, the open items on the active list (context for the model) and
 * an addItem() callback, so this module never touches list state itself.
 */
(function (root) {
  "use strict";

  const LEGACY_STORAGE_KEY = "shoppingList.aiChat.v1"; // older versions saved the chat; removed on start
  const HISTORY_TURNS = 12;
  const REQUEST_TIMEOUT_MS = 60000; // until the server starts answering; Gemini itself is retried on the server
  const STREAM_IDLE_MS = 40000; // silence allowed mid-answer (the server sends a ping every 15s)
  const CHAT_PATH = "/api/ai/chat/stream";
  const WAKE_DEADLINE_MS = 100000; // a sleeping Render instance can take ~50s (sometimes more) to boot
  const WAKE_HINT_AFTER_MS = 2500; // /health not answering by then = the server is asleep

  const STATUS = {
    waking: "השרת מתעורר, מיד מתחברים…",
    thinking: "ה-AI חושב…",
    analyzing: "מנתח את התמונה…",
  };

  const PROMPTS = [
    "3 רעיונות לארוחת ערב",
    "מה בעונה עכשיו?",
    "מה לקנות בתקציב נמוך 💰",
    "מזונות עשירים בחלבון 🦾",
    "ארוחת שבת לשישה 🕯️",
  ];

  // Keys: the server's `code`, or for AI_FAILED its `reason`.
  const ERRORS = {
    AI_DISABLED: "מפתח GEMINI_API_KEY חסר בשרת (Render), ולכן העוזר החכם כבוי.",
    INVALID_TOKEN: "החשבון לא אומת מול השרת. נסו להתחבר מחדש.",
    RATE_LIMITED: "הגעתם למגבלת השאלות לשעה. נסו שוב מאוחר יותר.",
    AI_QUOTA: "מכסת ה-AI הזמנית התמלאה. נסו שוב בעוד דקה.",
    invalid_key: "מפתח ה-Gemini שמוגדר בשרת לא תקין או חסום, ולכן העוזר לא זמין. (מנהל האפליקציה: בדקו את GEMINI_API_KEY ב-Render.)",
    forbidden: "מפתח ה-Gemini בשרת לא מורשה להשתמש במודל. (מנהל האפליקציה: בדקו את הגבלות המפתח ב-Google AI Studio.)",
    model_not_found: "אף מודל Gemini לא זמין כרגע למפתח שמוגדר בשרת.",
    bad_request: "Gemini דחה את הבקשה.",
    overloaded: "Gemini עמוס כרגע. נסו שוב בעוד רגע.",
    timeout: "התשובה לקחה יותר מדי זמן. נסו שוב.",
    bad_response: "התקבלה תשובה משובשת מהעוזר. נסו לנסח את השאלה מחדש.",
    offline: "אין חיבור לאינטרנט. נסו שוב כשתהיו מחוברים.",
    asleep: "השרת לא התעורר בזמן. נסו שוב בעוד רגע.",
    interrupted: "החיבור נקטע באמצע התשובה. נסו שוב.",
    BAD_IMAGE: "לא הצלחנו לשלוח את התמונה. נסו תמונה אחרת.",
    default: "העוזר לא זמין כרגע. נסו שוב.",
  };
  const NOT_RETRYABLE = new Set(["AI_DISABLED", "RATE_LIMITED", "invalid_key", "forbidden"]);

  const el = (id) => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let opts = null;
  let $ = {};
  // { role: "user" | "model", text, sections?, missing?, image?, imageSummary?, streaming?, partial?,
  //   local?: true, error?: true, detail?, retry?: { text, image } }
  // `local` messages are shown but never sent as history; `image` is a data URL for display only.
  let messages = [];
  let busy = false;
  let voice = null;
  let conversation = 0; // bumped by "new chat"; answers to an older conversation are dropped
  let inFlight = null; // AbortController of the question being answered
  let pinned = true; // the message list is scrolled to the bottom
  // After a send, sending is locked for a moment so a double tap can't fire two
  // Gemini requests (each one counts against the API quota).
  const SEND_COOLDOWN_MS = 3000;
  let sendLockedUntil = 0;
  let unlockTimer = null;
  const sendLocked = () => Date.now() < sendLockedUntil;

  function forgetStoredChat() {
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) {}
  }

  /*
   * The conversation so far, compacted to text: photos become their summary, and the
   * model's turns carry the product names it suggested.
   */
  function historyForServer() {
    return messages
      .filter((m) => !m.error && !m.local && !m.partial && !m.streaming)
      .slice(-HISTORY_TURNS)
      .map((m) => {
        let text = m.text || "";
        if (m.image) text = (m.imageSummary ? `[צירפתי תמונה. מה שרואים בה: ${m.imageSummary}]` : "[צירפתי תמונה]") + "\n" + text;
        if (m.missing && m.missing.length) text += `\nחסר: ${m.missing.map((i) => i.name).join(", ")}`;
        (m.sections || []).forEach((s) => {
          text += `\n${s.title}: ${s.items.map((i) => i.name).join(", ")}`;
        });
        return { role: m.role, text };
      });
  }

  /* ---------- Rendering ---------- */
  function promptButtons(className) {
    return PROMPTS.map((prompt) => {
      const chip = make("button", className, prompt);
      chip.addEventListener("click", () => send(prompt));
      return chip;
    });
  }

  function renderChips() {
    $.chips.innerHTML = "";
    promptButtons("chip ai-chip").forEach((chip) => $.chips.appendChild(chip));
  }

  function addButtonState(btn, name) {
    const inList = opts.isInList(name);
    btn.disabled = inList;
    btn.classList.toggle("done", inList);
    btn.textContent = inList ? "✓ ברשימה" : "+ הוסף לרשימה";
  }

  /* missing: the recipe's missing ingredients — one big "add them all" button under the items. */
  function renderSection(section, { missing = false } = {}) {
    const card = make("div", missing ? "ai-card missing" : "ai-card");
    const head = make("div", "ai-card-head");
    head.appendChild(make("div", "ai-card-title", section.title));
    const addAll = missing
      ? make("button", "ai-add-all ai-import-btn", `🛒 הוסף ${section.items.length} חסרים לרשימה`)
      : make("button", "ai-add-all", "הוסף הכל");
    if (!missing) head.appendChild(addAll);
    card.appendChild(head);

    const buttons = [];
    section.items.forEach((item) => {
      const row = make("div", "ai-item");
      row.appendChild(make("span", "ai-item-emoji", root.Categories.emojiFor(item.name, item.category)));
      const main = make("div", "ai-item-main");
      main.appendChild(make("div", "ai-item-name", item.name));
      if (item.quantity) main.appendChild(make("div", "ai-item-qty", item.quantity));
      row.appendChild(main);
      const btn = make("button", "ai-add-btn");
      addButtonState(btn, item.name);
      btn.addEventListener("click", () => {
        if (opts.addItem(item)) opts.showToast(`"${item.name}" נוסף לרשימה ✓`);
        refreshAddButtons();
      });
      buttons.push({ btn, item });
      row.appendChild(btn);
      card.appendChild(row);
    });
    if (missing) card.appendChild(addAll);

    addAll.addEventListener("click", () => {
      const added = section.items.filter((item) => opts.addItem(item)).length;
      opts.showToast(added ? `נוספו ${added} פריטים לרשימה ✓` : "כל הפריטים כבר ברשימה");
      refreshAddButtons();
    });
    return card;
  }

  function renderMessage(m, index) {
    const wrap = make("div", `ai-msg ${m.error ? "error" : m.role}`);
    if (m.image) {
      const img = make("img", "ai-image");
      img.src = m.image;
      img.alt = "תמונה ששלחתם";
      wrap.appendChild(img);
    }
    if (m.text) {
      const bubble = make("div", "ai-bubble", m.text);
      if (m.streaming) {
        bubble.id = "aiLive";
        bubble.classList.add("streaming");
      }
      // Gemini's own words (key/quota/model problems), for whoever has to fix it.
      if (m.detail) {
        const detail = make("div", "ai-error-detail", m.detail);
        detail.dir = "ltr";
        bubble.appendChild(detail);
      }
      wrap.appendChild(bubble);
    }
    if (m.missing && m.missing.length) wrap.appendChild(renderSection({ title: "חסר לך למתכון", items: m.missing }, { missing: true }));
    (m.sections || []).forEach((s) => wrap.appendChild(renderSection(s)));
    if (m.error && m.retry && index === messages.length - 1) {
      const retry = make("button", "small-btn", "🔄 נסו שוב");
      retry.addEventListener("click", () => {
        messages.pop(); // the error
        while (messages.length && messages[messages.length - 1].partial) messages.pop();
        const last = messages[messages.length - 1];
        if (last && last.role === "user" && last.text === m.retry.text) messages.pop();
        send(m.retry.text, m.retry.image);
      });
      wrap.appendChild(retry);
    }
    return wrap;
  }

  /* Fresh chat: a greeting; the suggestion chips sit in the input dock. */
  function renderEmpty() {
    const wrap = make("div", "ai-empty");
    wrap.appendChild(make("div", "ai-empty-icon", "👨‍🍳"));
    wrap.appendChild(make("div", "ai-empty-title", "מה מבשלים היום?"));
    wrap.appendChild(make("div", "ai-empty-text", "שאלו על ארוחות ומתכונים, בחרו הצעה למטה, או צלמו את המקרר 📸 ונגלה מה חסר."));
    return wrap;
  }

  function render() {
    const signedIn = !!opts.getToken();
    $.gate.classList.toggle("hidden", signedIn);
    $.messages.classList.toggle("hidden", !signedIn);
    $.bar.classList.toggle("hidden", !signedIn);
    $.chips.classList.toggle("hidden", !signedIn);
    $.newChat.classList.toggle("hidden", !signedIn);
    $.newChat.disabled = !messages.length && !busy;
    if (!signedIn) return;

    $.messages.innerHTML = "";
    if (!messages.length && !busy) $.messages.appendChild(renderEmpty());
    messages.forEach((m, i) => $.messages.appendChild(renderMessage(m, i)));
    const writing = messages.length && messages[messages.length - 1].streaming;
    if (busy && !writing) {
      // Loading bubble: shown from the moment a question is sent until the answer is rendered.
      const typing = make("div", "ai-msg model ai-loading");
      const bubble = make("div", "ai-bubble ai-typing");
      bubble.id = "aiTyping";
      bubble.setAttribute("role", "status");
      const dots = make("span", "ai-dots");
      dots.setAttribute("aria-hidden", "true");
      dots.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      bubble.appendChild(dots);
      bubble.appendChild(make("span", "ai-typing-text", statusText));
      typing.appendChild(bubble);
      $.messages.appendChild(typing);
    }
    // Invisible room under the last message, so it always scrolls fully clear of the input bar.
    const spacer = make("div", "scroll-spacer");
    spacer.setAttribute("aria-hidden", "true");
    $.messages.appendChild(spacer);

    $.send.disabled = busy || sendLocked();
    refreshAddButtons();
  }

  /*
   * Only the message list scrolls (the input bar is a normal block below it), so
   * "newest message fully visible" is simply: list scrolled to its very bottom.
   */
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function scrollToEnd(smooth = true) {
    const list = $.messages;
    if (!list) return;
    const snap = () => { list.scrollTop = list.scrollHeight; };
    // Reading scrollHeight forces layout, so this works right after render().
    if (smooth && !reduceMotion) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    else snap();
    // A smooth scroll can be cut short (backgrounded app, list still growing): always end at the bottom.
    setTimeout(() => {
      if (list.scrollHeight - list.scrollTop - list.clientHeight > 2) snap();
    }, 400);
  }

  /* The list changed (item added/removed elsewhere): update the "in list" buttons. */
  function refreshAddButtons() {
    if (!$.messages || $.messages.classList.contains("hidden")) return;
    $.messages.querySelectorAll(".ai-card").forEach((card) => {
      const addAll = card.querySelector(".ai-add-all");
      let anyMissing = false;
      card.querySelectorAll(".ai-item").forEach((row) => {
        const name = row.querySelector(".ai-item-name").textContent;
        const btn = row.querySelector(".ai-add-btn");
        addButtonState(btn, name);
        if (!btn.disabled) anyMissing = true;
      });
      addAll.disabled = !anyMissing;
    });
  }

  /* ---------- Talking to the server ---------- */
  let statusText = STATUS.thinking;
  let baseStatus = STATUS.thinking; // what to show once the server is awake
  function setStatus(text) {
    statusText = text || baseStatus;
    const label = document.querySelector("#aiTyping .ai-typing-text");
    if (label) label.textContent = statusText;
  }

  /* Resolves true when the server answers /health, false on failure or after `ms`. */
  async function ping(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(opts.backendUrl + "/health", { cache: "no-store", signal: controller.signal });
      return res.ok;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /* A JSON error body from the server (or an SSE `error` event) -> { code, message?, detail? }. */
  function serverError(body, status) {
    if (body.code === "AI_FAILED") return { code: body.reason || "default", detail: body.detail };
    return {
      code: body.code || (status === 401 ? "INVALID_TOKEN" : status === 429 ? "RATE_LIMITED" : "default"),
      message: body.message,
      detail: body.detail,
    };
  }

  /*
   * Reads the answer stream: `delta` events go to onDelta as they arrive; resolves with the
   * `done` event's { reply, sections, missing, imageSummary }. Never resolves to a retry:
   * once the server has started answering, resending would cost a second Gemini call.
   */
  async function readStream(res, controller, onDelta) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;
    let idle = null;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
    };
    try {
      arm();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message";
          let data = "";
          raw.split("\n").forEach((line) => {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          });
          if (!data) continue; // ": ping" comments
          const payload = JSON.parse(data);
          if (event === "delta") onDelta(payload.text || "");
          else if (event === "done") result = payload;
          else if (event === "error") throw serverError(payload);
        }
      }
    } catch (e) {
      if (e && e.code) throw e;
      throw { code: controller.signal.aborted ? "timeout" : "interrupted" };
    } finally {
      clearTimeout(idle);
    }
    if (!result) throw { code: "interrupted" };
    return result;
  }

  /*
   * One question, cold-start aware. A sleeping Render instance shows up as a hanging
   * /health, a network error, a proxy 502/503/504 without our JSON, or our own
   * SERVER_UNAVAILABLE while the database connects. All of those mean "wait and
   * retry" with a friendly status, never an error, until WAKE_DEADLINE_MS.
   * `cancel` (an AbortController) stops the question, e.g. on "new chat".
   */
  async function request(payload, onDelta, cancel) {
    const deadline = Date.now() + WAKE_DEADLINE_MS;
    let waking = false;
    const showWaking = () => {
      waking = true;
      setStatus(STATUS.waking);
    };

    // Kick the server awake right away and find out whether it is asleep.
    const hint = setTimeout(showWaking, WAKE_HINT_AFTER_MS);
    ping(WAKE_DEADLINE_MS).then((up) => {
      clearTimeout(hint);
      if (up) setStatus(baseStatus);
    });

    try {
      for (let attempt = 0; ; attempt++) {
        if (navigator.onLine === false) throw { code: "offline" };
        if (cancel.signal.aborted) throw { code: "cancelled" };
        const controller = new AbortController();
        const stop = () => controller.abort();
        cancel.signal.addEventListener("abort", stop);
        const timer = setTimeout(stop, REQUEST_TIMEOUT_MS);
        let res = null;
        let body = {};
        try {
          res = await fetch(opts.backendUrl + CHAT_PATH, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.getToken() },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (res.ok && /text\/event-stream/.test(res.headers.get("content-type") || "")) {
            return await readStream(res, controller, onDelta);
          }
          body = await res.json().catch(() => ({}));
        } catch (e) {
          if (e && e.code) throw e; // from readStream
          if (cancel.signal.aborted) throw { code: "cancelled" };
          // Our own timeout means the server is awake but slow: don't resend the same question.
          if (e && e.name === "AbortError") throw { code: "timeout" };
          res = null; // network error: most likely the server is still booting
        } finally {
          clearTimeout(timer);
          cancel.signal.removeEventListener("abort", stop);
        }

        const asleep = !res || (!body.code && [502, 503, 504].includes(res.status)) || body.code === "SERVER_UNAVAILABLE";
        if (asleep) {
          if (Date.now() > deadline) throw { code: navigator.onLine === false ? "offline" : "asleep" };
          if (!waking) showWaking();
          await ping(10000); // returns as soon as the server answers
          await sleep(Math.min(1000 * (attempt + 1), 4000));
          setStatus(baseStatus);
          continue;
        }
        throw serverError(body, res.status);
      }
    } finally {
      clearTimeout(hint);
    }
  }

  /* Streamed text lands in the live bubble directly: re-rendering the chat per chunk would flicker. */
  let paintQueued = false;
  function paintLive(message) {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const bubble = document.getElementById("aiLive");
      if (!bubble) return render();
      bubble.textContent = message.text;
      if (pinned) scrollToEnd(false);
    });
  }

  /*
   * Asks one question. `image` ({ dataUrl, base64, mimeType } from FridgeVision.prepareImage)
   * is sent with this question only; the answer's imageSummary stands in for it afterwards.
   * Returns false when the question couldn't be sent right now.
   */
  async function send(rawText, image = null) {
    const text = String(rawText || "").trim();
    if (!text || busy || sendLocked()) return false;
    sendLockedUntil = Date.now() + SEND_COOLDOWN_MS;
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => { $.send.disabled = busy; }, SEND_COOLDOWN_MS);
    if (!opts.getToken()) {
      opts.onNeedAccount();
      return false;
    }
    const history = historyForServer();
    const myConversation = conversation;
    baseStatus = image ? STATUS.analyzing : STATUS.thinking;
    statusText = baseStatus;
    const question = { role: "user", text, image: image ? image.dataUrl : null };
    messages.push(question);
    if (!image) $.input.value = "";
    busy = true;
    pinned = true;
    render();
    scrollToEnd();

    const cancel = new AbortController();
    inFlight = cancel;
    let live = null; // the answer being written
    const onDelta = (delta) => {
      if (!delta || myConversation !== conversation) return;
      if (!live) {
        live = { role: "model", text: delta, streaming: true };
        messages.push(live);
        render();
        scrollToEnd(false);
        return;
      }
      live.text += delta;
      paintLive(live);
    };

    try {
      const answer = await request({
        message: text,
        history,
        listItems: opts.getListNames(),
        ...(image ? { image: { inlineData: { mimeType: image.mimeType, data: image.base64 } } } : {}),
      }, onDelta, cancel);
      if (myConversation !== conversation) return true; // the user started a new chat meanwhile
      if (image && answer.imageSummary) question.imageSummary = answer.imageSummary;
      const reply = {
        role: "model",
        text: answer.reply || (live && live.text) || "",
        sections: answer.sections || [],
        missing: answer.missing || [],
        streaming: false,
      };
      if (live) Object.assign(live, reply);
      else messages.push(reply);
    } catch (e) {
      if (myConversation !== conversation) return true;
      const code = (e && e.code) || "default";
      const showDetail = ["invalid_key", "forbidden", "AI_QUOTA", "model_not_found", "bad_request"].includes(code);
      if (live) Object.assign(live, { streaming: false, partial: true }); // keep what was written
      messages.push({
        role: "model",
        error: true,
        text: (code === "AI_DISABLED" && e.message ? e.message : ERRORS[code]) || ERRORS.default,
        detail: showDetail && e.detail ? e.detail : null,
        retry: NOT_RETRYABLE.has(code) ? null : { text, image },
      });
    } finally {
      if (inFlight === cancel) inFlight = null;
    }
    busy = false;
    render();
    if (pinned) scrollToEnd();
    return true;
  }

  /* A Fridge Vision photo, asked as a question in this chat. */
  function sendPhoto(image, question) {
    if (busy) {
      opts.showToast("רגע, ה-AI עוד עונה על השאלה הקודמת…", 3000);
      return Promise.resolve(false);
    }
    sendLockedUntil = 0; // a photo is a deliberate action, not a double tap
    return send(question, image);
  }

  function newChat() {
    conversation++;
    if (inFlight) inFlight.abort(); // the server stops the Gemini call too
    inFlight = null;
    sendLockedUntil = 0;
    messages = [];
    busy = false;
    forgetStoredChat();
    if (voice && voice.listening) voice.cancel();
    $.input.value = "";
    render();
    $.messages.scrollTop = 0;
  }

  /* Web Speech API. Without it the mic stays visible and explains why it can't listen. */
  function setupVoice() {
    const VoiceInput = root.VoiceInput;
    if (!VoiceInput || !VoiceInput.supported) {
      $.mic.addEventListener("click", () => opts.showToast("שאלה בקול לא נתמכת בדפדפן הזה — נסו Chrome", 3500));
      return;
    }
    voice = new VoiceInput({
      lang: "he-IL",
      onStart: () => {
        $.mic.classList.add("listening");
        $.voiceText.textContent = "מקשיב… שאלו למשל: ״מה לבשל הערב?״";
        $.voicePanel.classList.remove("hidden");
      },
      onInterim: (text) => { $.voiceText.textContent = text; },
      onResult: (text) => send(text),
      onError: (msg) => opts.showToast(msg, 3500),
      onEnd: () => {
        $.mic.classList.remove("listening");
        $.voicePanel.classList.add("hidden");
      },
    });
    $.mic.addEventListener("click", () => (voice.listening ? voice.stop() : voice.start()));
    $.voiceStop.addEventListener("click", () => voice.stop());
  }

  /*
   * options: {
   *   backendUrl, getToken(), getListNames(), isInList(name),
   *   addItem({ name, quantity, category }) -> true if added,
   *   showToast(msg, ms), onNeedAccount()
   * }
   */
  function init(options) {
    opts = options;
    $ = {
      chips: el("aiChips"), messages: el("aiMessages"), gate: el("aiGate"), gateBtn: el("aiGateBtn"),
      bar: el("aiBar"), input: el("aiInput"), send: el("aiSendBtn"), mic: el("aiMicBtn"),
      voicePanel: el("aiVoicePanel"), voiceText: el("aiVoiceText"), voiceStop: el("aiVoiceStopBtn"),
      newChat: el("aiNewChatBtn"),
    };
    forgetStoredChat(); // always start fresh
    renderChips();
    setupVoice();
    $.send.addEventListener("click", () => send($.input.value));
    $.input.addEventListener("keydown", (e) => { if (e.key === "Enter") send($.input.value); });
    $.gateBtn.addEventListener("click", () => opts.onNeedAccount());
    $.newChat.addEventListener("click", newChat);

    // The on-screen keyboard shrinks the list: stay pinned to the bottom if we were there.
    $.messages.addEventListener("scroll", () => {
      pinned = $.messages.scrollHeight - $.messages.scrollTop - $.messages.clientHeight < 40;
    }, { passive: true });
    const keepPinned = () => { if (pinned) scrollToEnd(false); };
    (window.visualViewport || window).addEventListener("resize", keepPinned);
    $.input.addEventListener("focus", () => setTimeout(keepPinned, 300));
    render();
  }

  /* Shows messages produced on this device (e.g. Fridge Vision) without asking the server. */
  function postLocal(...newMessages) {
    newMessages.forEach((m) => messages.push({ ...m, local: true }));
    render();
    scrollToEnd();
  }

  root.AIChat = {
    init,
    sendPhoto: (image, question) => (opts ? sendPhoto(image, question) : Promise.resolve(false)),
    postLocal: (...m) => opts && postLocal(...m),
    render: () => opts && render(),
    refreshAddButtons: () => opts && refreshAddButtons(),
    onShow: () => {
      if (!opts) return;
      render();
      scrollToEnd();
    },
  };
})(window);
