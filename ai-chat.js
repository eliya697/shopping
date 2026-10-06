/*
 * AIChat — the "AI assistant" tab: a chat with the Gemini-backed /api/ai/chat
 * endpoint. Suggested products come back as structured sections and are shown
 * as cards with one-tap "add to list" buttons.
 *
 * The conversation is kept on the device (localStorage). The app supplies the
 * account token, the open items on the active list (context for the model) and
 * an addItem() callback, so this module never touches list state itself.
 */
(function (root) {
  "use strict";

  const STORAGE_KEY = "shoppingList.aiChat.v1";
  const MAX_STORED = 40;
  const HISTORY_TURNS = 12;
  const REQUEST_TIMEOUT_MS = 90000; // a sleeping Render instance can take ~50s to answer
  const SLOW_AFTER_MS = 5000;
  const STARTING_RETRIES = 3;

  const PROMPTS = [
    "מה בעונה עכשיו? 🍓",
    "3 רעיונות לארוחת ערב מהירה 🍔",
    "מה לקנות בתקציב נמוך 💰",
    "מזונות עשירים בחלבון לקנייה 🦾",
  ];

  const ERRORS = {
    AI_DISABLED: "העוזר החכם עדיין לא הוגדר בשרת (חסר מפתח Gemini).",
    INVALID_TOKEN: "החשבון לא אומת מול השרת. נסו להתחבר מחדש.",
    RATE_LIMITED: "הגעתם למגבלת השאלות לשעה. נסו שוב מאוחר יותר.",
    SERVER_UNAVAILABLE: "השרת עדיין עולה. נסו שוב בעוד כמה שניות.",
    offline: "אין חיבור לאינטרנט. נסו שוב כשתהיו מחוברים.",
    timeout: "השרת לא הגיב. נסו שוב.",
    default: "העוזר לא זמין כרגע. נסו שוב.",
  };

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
  let messages = []; // { role: "user" | "model", text, sections?, error?: true, retryText? }
  let busy = false;
  let voice = null;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      messages = Array.isArray(saved) ? saved : [];
    } catch (e) {
      messages = [];
    }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.filter((m) => !m.error).slice(-MAX_STORED))); } catch (e) {}
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
  function renderChips() {
    $.chips.innerHTML = "";
    PROMPTS.forEach((prompt) => {
      const chip = make("button", "chip ai-chip", prompt);
      chip.addEventListener("click", () => send(prompt));
      $.chips.appendChild(chip);
    });
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
    if (m.text) wrap.appendChild(make("div", "ai-bubble", m.text));
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

  function renderWelcome() {
    const wrap = make("div", "ai-msg model");
    wrap.appendChild(make("div", "ai-bubble",
      "שלום! 👋 אני העוזר החכם של רשימת הקניות.\nאפשר לשאול אותי על רעיונות לארוחות, מתכונים, מה בעונה או איך לחסוך — ואת המצרכים שאציע תוכלו להוסיף לרשימה בלחיצה."));
    return wrap;
  }

  function render() {
    const signedIn = !!opts.getToken();
    $.gate.classList.toggle("hidden", signedIn);
    $.messages.classList.toggle("hidden", !signedIn);
    $.bar.classList.toggle("hidden", !signedIn);
    $.chips.classList.toggle("hidden", !signedIn);
    $.newChat.classList.toggle("hidden", !signedIn || !messages.length);
    if (!signedIn) return;

    $.messages.innerHTML = "";
    if (!messages.length) $.messages.appendChild(renderWelcome());
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
  async function request(payload) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      let body;
      try {
        res = await fetch(opts.backendUrl + "/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.getToken() },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        throw { code: e && e.name === "AbortError" ? "timeout" : navigator.onLine === false ? "offline" : "default" };
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return body;
      // The database is still connecting after a cold start: wait and retry quietly.
      if (body.code === "SERVER_UNAVAILABLE" && attempt < STARTING_RETRIES) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw { code: body.code || (res.status === 401 ? "INVALID_TOKEN" : res.status === 429 ? "RATE_LIMITED" : "default") };
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
    messages.push({ role: "user", text });
    $.input.value = "";
    busy = true;
    render();
    scrollToEnd();

    const slow = setTimeout(() => {
      const label = document.querySelector("#aiTyping .ai-typing-text");
      if (label) label.textContent = "השרת מתעורר, זה יכול לקחת עד דקה…";
    }, SLOW_AFTER_MS);

    try {
      const answer = await request({ message: text, history, listItems: opts.getListNames() });
      messages.push({ role: "model", text: answer.reply || "", sections: answer.sections || [] });
    } catch (e) {
      const code = e && e.code;
      const retryable = code !== "AI_DISABLED" && code !== "RATE_LIMITED";
      messages.push({ role: "model", error: true, text: ERRORS[code] || ERRORS.default, retryText: retryable ? text : null });
    } finally {
      clearTimeout(slow);
      busy = false;
      save();
      render();
      scrollToEnd();
    }
  }

  function newChat() {
    if (busy) return;
    messages = [];
    save();
    render();
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
    load();
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
