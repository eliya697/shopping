/*
 * AIChat — the "AI assistant" tab: a chat with the Gemini-backed /api/ai/chat
 * endpoint. Suggested products come back as structured sections and are shown
 * as cards with one-tap "add to list" buttons.
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
  const REQUEST_TIMEOUT_MS = 60000; // one attempt; Gemini itself is retried on the server
  const WAKE_DEADLINE_MS = 100000; // a sleeping Render instance can take ~50s (sometimes more) to boot
  const WAKE_HINT_AFTER_MS = 2500; // /health not answering by then = the server is asleep

  const STATUS = {
    waking: "השרת מתעורר, מיד מתחברים…",
    thinking: "חושב על תשובה…",
  };

  const PROMPTS = [
    "מה בעונה עכשיו? 🍓",
    "3 רעיונות לארוחת ערב מהירה 🍔",
    "מה לקנות בתקציב נמוך 💰",
    "מזונות עשירים בחלבון לקנייה 🦾",
  ];

  // Keys: the server's `code`, or for AI_FAILED its `reason`.
  const ERRORS = {
    AI_DISABLED: "מפתח GEMINI_API_KEY חסר בשרת (Render), ולכן העוזר החכם כבוי.",
    INVALID_TOKEN: "החשבון לא אומת מול השרת. נסו להתחבר מחדש.",
    RATE_LIMITED: "הגעתם למגבלת השאלות לשעה. נסו שוב מאוחר יותר.",
    AI_QUOTA: "העוזר הגיע למכסת השימוש של Gemini. נסו שוב בעוד כמה דקות.",
    invalid_key: "מפתח ה-Gemini שמוגדר בשרת לא תקין או חסום, ולכן העוזר לא זמין. (מנהל האפליקציה: בדקו את GEMINI_API_KEY ב-Render.)",
    forbidden: "מפתח ה-Gemini בשרת לא מורשה להשתמש במודל. (מנהל האפליקציה: בדקו את הגבלות המפתח ב-Google AI Studio.)",
    model_not_found: "אף מודל Gemini לא זמין כרגע למפתח שמוגדר בשרת.",
    bad_request: "Gemini דחה את הבקשה.",
    overloaded: "Gemini עמוס כרגע. נסו שוב בעוד רגע.",
    timeout: "התשובה לקחה יותר מדי זמן. נסו שוב.",
    bad_response: "התקבלה תשובה משובשת מהעוזר. נסו לנסח את השאלה מחדש.",
    offline: "אין חיבור לאינטרנט. נסו שוב כשתהיו מחוברים.",
    asleep: "השרת לא התעורר בזמן. נסו שוב בעוד רגע.",
    default: "העוזר לא זמין כרגע. נסו שוב.",
  };
  const NOT_RETRYABLE = new Set(["AI_DISABLED", "RATE_LIMITED", "AI_QUOTA", "invalid_key", "forbidden"]);

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
  let messages = []; // { role: "user" | "model", text, sections?, error?: true, detail?, retryText? }
  let busy = false;
  let voice = null;
  let conversation = 0; // bumped by "new chat"; answers to an older conversation are dropped

  function forgetStoredChat() {
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) {}
  }

  /* What the model said before, compacted: its text plus the product names it suggested. */
  function historyForServer() {
    return messages
      .filter((m) => !m.error)
      .slice(-HISTORY_TURNS)
      .map((m) => {
        let text = m.text || "";
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

  function renderSection(section) {
    const card = make("div", "ai-card");
    const head = make("div", "ai-card-head");
    head.appendChild(make("div", "ai-card-title", section.title));
    const addAll = make("button", "ai-add-all", "הוסף הכל");
    head.appendChild(addAll);
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

    addAll.addEventListener("click", () => {
      const added = section.items.filter((item) => opts.addItem(item)).length;
      opts.showToast(added ? `נוספו ${added} פריטים לרשימה ✓` : "כל הפריטים כבר ברשימה");
      refreshAddButtons();
    });
    return card;
  }

  function renderMessage(m, index) {
    const wrap = make("div", `ai-msg ${m.error ? "error" : m.role}`);
    if (m.text) {
      const bubble = make("div", "ai-bubble", m.text);
      // Gemini's own words (key/quota/model problems), for whoever has to fix it.
      if (m.detail) {
        const detail = make("div", "ai-error-detail", m.detail);
        detail.dir = "ltr";
        bubble.appendChild(detail);
      }
      wrap.appendChild(bubble);
    }
    (m.sections || []).forEach((s) => wrap.appendChild(renderSection(s)));
    if (m.error && m.retryText && index === messages.length - 1) {
      const retry = make("button", "small-btn", "🔄 נסו שוב");
      retry.addEventListener("click", () => {
        messages.pop(); // the error
        const last = messages[messages.length - 1];
        if (last && last.role === "user" && last.text === m.retryText) messages.pop();
        send(m.retryText);
      });
      wrap.appendChild(retry);
    }
    return wrap;
  }

  /* Fresh chat: nothing but the suggestions. */
  function renderEmpty() {
    const wrap = make("div", "ai-empty");
    wrap.appendChild(make("div", "ai-empty-icon", "✦"));
    wrap.appendChild(make("div", "ai-empty-title", "במה אפשר לעזור?"));
    const grid = make("div", "ai-empty-prompts");
    promptButtons("ai-prompt-card").forEach((card) => grid.appendChild(card));
    wrap.appendChild(grid);
    return wrap;
  }

  function render() {
    const signedIn = !!opts.getToken();
    $.gate.classList.toggle("hidden", signedIn);
    $.messages.classList.toggle("hidden", !signedIn);
    $.bar.classList.toggle("hidden", !signedIn);
    $.chips.classList.toggle("hidden", !signedIn || !messages.length);
    $.newChat.classList.toggle("hidden", !signedIn);
    $.newChat.disabled = !messages.length && !busy;
    if (!signedIn) return;

    $.messages.innerHTML = "";
    if (!messages.length && !busy) $.messages.appendChild(renderEmpty());
    messages.forEach((m, i) => $.messages.appendChild(renderMessage(m, i)));
    if (busy) {
      const typing = make("div", "ai-msg model");
      const bubble = make("div", "ai-bubble ai-typing");
      bubble.id = "aiTyping";
      bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      bubble.appendChild(make("span", "ai-typing-text"));
      typing.appendChild(bubble);
      $.messages.appendChild(typing);
    }
    $.send.disabled = busy;
    refreshAddButtons();
  }

  function scrollToEnd() {
    const last = $.messages.lastElementChild;
    if (last) last.scrollIntoView({ behavior: "smooth", block: "end" });
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
  function setStatus(text) {
    const label = document.querySelector("#aiTyping .ai-typing-text");
    if (label) label.textContent = text || "";
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

  /*
   * One question, cold-start aware. A sleeping Render instance shows up as a hanging
   * /health, a network error, a proxy 502/503/504 without our JSON, or our own
   * SERVER_UNAVAILABLE while the database connects. All of those mean "wait and
   * retry" with a friendly status, never an error, until WAKE_DEADLINE_MS.
   */
  async function request(payload) {
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
      if (up) setStatus(STATUS.thinking);
    });

    try {
      for (let attempt = 0; ; attempt++) {
        if (navigator.onLine === false) throw { code: "offline" };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res = null;
        let body = {};
        try {
          res = await fetch(opts.backendUrl + "/api/ai/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.getToken() },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          body = await res.json().catch(() => ({}));
        } catch (e) {
          // Our own timeout means the server is awake but slow: don't resend the same question.
          if (e && e.name === "AbortError") throw { code: "timeout" };
          res = null; // network error: most likely the server is still booting
        } finally {
          clearTimeout(timer);
        }

        if (res && res.ok) return body;

        const asleep = !res || (!body.code && [502, 503, 504].includes(res.status)) || body.code === "SERVER_UNAVAILABLE";
        if (asleep) {
          if (Date.now() > deadline) throw { code: navigator.onLine === false ? "offline" : "asleep" };
          if (!waking) showWaking();
          await ping(10000); // returns as soon as the server answers
          await sleep(Math.min(1000 * (attempt + 1), 4000));
          setStatus(STATUS.thinking);
          continue;
        }
        if (body.code === "AI_FAILED") throw { code: body.reason || "default", detail: body.detail };
        throw {
          code: body.code || (res.status === 401 ? "INVALID_TOKEN" : res.status === 429 ? "RATE_LIMITED" : "default"),
          message: body.message,
          detail: body.detail,
        };
      }
    } finally {
      clearTimeout(hint);
    }
  }

  async function send(rawText) {
    const text = String(rawText || "").trim();
    if (!text || busy) return;
    if (!opts.getToken()) {
      opts.onNeedAccount();
      return;
    }
    const history = historyForServer();
    const myConversation = conversation;
    messages.push({ role: "user", text });
    $.input.value = "";
    busy = true;
    render();
    scrollToEnd();

    let reply;
    try {
      const answer = await request({ message: text, history, listItems: opts.getListNames() });
      reply = { role: "model", text: answer.reply || "", sections: answer.sections || [] };
    } catch (e) {
      const code = (e && e.code) || "default";
      const showDetail = ["invalid_key", "forbidden", "AI_QUOTA", "model_not_found", "bad_request"].includes(code);
      reply = {
        role: "model",
        error: true,
        text: (code === "AI_DISABLED" && e.message ? e.message : ERRORS[code]) || ERRORS.default,
        detail: showDetail && e.detail ? e.detail : null,
        retryText: NOT_RETRYABLE.has(code) ? null : text,
      };
    }
    if (myConversation !== conversation) return; // the user started a new chat meanwhile
    messages.push(reply);
    busy = false;
    render();
    scrollToEnd();
  }

  function newChat() {
    conversation++;
    messages = [];
    busy = false;
    forgetStoredChat();
    if (voice && voice.listening) voice.cancel();
    $.input.value = "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setupVoice() {
    const VoiceInput = root.VoiceInput;
    if (!VoiceInput || !VoiceInput.supported) return;
    $.mic.classList.remove("hidden");
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
    render();
  }

  root.AIChat = {
    init,
    render: () => opts && render(),
    refreshAddButtons: () => opts && refreshAddButtons(),
    onShow: () => {
      if (!opts) return;
      render();
      scrollToEnd();
    },
  };
})(window);
