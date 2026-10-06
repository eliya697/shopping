(() => {
  "use strict";

  /* ---------- Constants ---------- */
  const STORAGE_KEYS = {
    items: "shoppingList.items.v1", // local-only mode (no account)
    templates: "shoppingList.templates.v1",
    theme: "shoppingList.theme.v1",
    account: "shoppingList.account.v1",
    activeList: "shoppingList.activeList.v1",
    lists: "shoppingList.lists.v1",
    listCachePrefix: "shoppingList.listCache.v1.", // + listId -> { list, items }
    checkedOpen: "shoppingList.checkedOpen.v1",
    welcomeSeen: "shoppingList.welcomeSeen.v1",
    viewMode: "shoppingList.viewMode.v1",
    storeOrder: "shoppingList.storeOrder.v1",
    learnedCategories: "shoppingList.learnedCategories.v1",
    pendingJoin: "shoppingList.pendingJoin.v1",
  };

  const BACKEND_URL = ((window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || "").replace(/\/+$/, "");
  const PUBLIC_URL = (window.APP_CONFIG && window.APP_CONFIG.PUBLIC_URL) || "";
  const { Categories, ItemParser, QuickAdd, VoiceInput, AIChat } = window;

  /* ---------- Native shell (Capacitor Android). All no-ops in the browser. ---------- */
  const Cap = window.Capacitor;
  const Native = {
    isApp: !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform()),
    plugin: (name) => (Cap && Cap.Plugins && Cap.Plugins[name]) || null,
    /*
     * The app draws edge-to-edge (Android 15+ requires it), so the page background is
     * what shows behind the status bar; only the icon color has to follow the theme.
     * Style "DARK" = light icons, for a dark background.
     */
    setStatusBar(theme) {
      const bars = Native.isApp && Native.plugin("SystemBars");
      if (!bars) return;
      Promise.resolve(bars.setStyle({ style: theme === "dark" ? "DARK" : "LIGHT" })).catch(() => {});
    },
  };

  const DEFAULT_TEMPLATE = {
    "קניות שבועיות בסיסיות": [
      { name: "חלב", category: "dairy" },
      { name: "ביצים", category: "dairy" },
      { name: "לחם", category: "bakery" },
      { name: "עגבניות", category: "produce" },
      { name: "מלפפונים", category: "produce" },
      { name: "בננות", category: "produce" },
      { name: "חזה עוף", category: "meat" },
      { name: "נייר טואלט", category: "cleaning" },
    ],
  };

  const LIST_NAME_SUGGESTIONS = ["קניות שבועיות", "בית מרקחת", "ארוחת שבת", "מסיבה", "לבית החדש"];
  const UNIT_CHIPS = ["יח׳", "ק״ג", "גרם", "ליטר", "חבילות"];

  const STATUS_TEXT = {
    online: "מחובר — שינויים מסתנכרנים בזמן אמת",
    connecting: "מתחבר לשרת…",
    waking: "השרת מתעורר (יכול לקחת עד דקה)…",
    offline: "לא מקוון — השינויים נשמרים במכשיר ויסתנכרנו כשהחיבור יחזור",
  };

  /* ---------- State ---------- */
  let items = [];
  let templates = {};
  let activeFilter = "all";
  let searchQuery = "";
  let viewMode = "list"; // "list" | "store"
  let storeOrder = Categories.DEFAULT_STORE_ORDER.slice();

  let account = null; // { userId, username, token }
  let lists = []; // { listId, ownerId, ownerName, name, memberCount, remaining }
  let activeListId = null;
  let listInfo = null; // { listId, ownerId, name, members: [{ userId, username }] }
  let sync = null;
  let syncStatus = "offline";
  let pendingCount = 0;
  let activeTab = "lists"; // "lists" | "ai" | "profile"
  const flashIds = new Set(); // rows to highlight after a remote add

  /* ---------- Storage ---------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function removeKey(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  /* Items saved by v1 have an integer `qty` and no notes. */
  function normalizeItem(i) {
    return {
      id: i.id,
      name: i.name,
      category: Categories.MAP[i.category] ? i.category : "misc",
      bought: !!i.bought,
      quantity: typeof i.quantity === "string" ? i.quantity : i.qty > 1 ? String(i.qty) : "",
      notes: i.notes || "",
      createdAt: i.createdAt || Date.now(),
      addedBy: i.addedBy,
    };
  }

  function loadState() {
    templates = readJSON(STORAGE_KEYS.templates, null) || { ...DEFAULT_TEMPLATE };
    viewMode = readJSON(STORAGE_KEYS.viewMode, "list") === "store" ? "store" : "list";
    storeOrder = Categories.sanitizeOrder(readJSON(STORAGE_KEYS.storeOrder, null) || Categories.DEFAULT_STORE_ORDER);
    Categories.learned = readJSON(STORAGE_KEYS.learnedCategories, {});

    account = BACKEND_URL ? readJSON(STORAGE_KEYS.account, null) : null;
    if (account) {
      lists = readJSON(STORAGE_KEYS.lists, []);
      activeListId = readJSON(STORAGE_KEYS.activeList, null) || (lists[0] && lists[0].listId);
      loadListCache(activeListId);
    } else {
      items = readJSON(STORAGE_KEYS.items, []).map(normalizeItem);
    }
  }

  function loadListCache(listId) {
    const cached = listId ? readJSON(STORAGE_KEYS.listCachePrefix + listId, null) : null;
    items = ((cached && cached.items) || []).map(normalizeItem);
    listInfo = (cached && cached.list) || null;
  }

  function saveItems() {
    if (account && activeListId) {
      writeJSON(STORAGE_KEYS.listCachePrefix + activeListId, { list: listInfo, items });
    } else {
      writeJSON(STORAGE_KEYS.items, items);
    }
  }
  function saveTemplates() {
    writeJSON(STORAGE_KEYS.templates, templates);
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
  }

  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

  /* ---------- DOM refs ---------- */
  const el = (id) => document.getElementById(id);
  const $ = {};
  [
    "listContainer", "emptyState", "subtitle", "filterRow", "searchInput",
    "clearSearchBtn", "newItemInput", "addBtn", "resetAllBtn",
    "templatesBtn", "templatesOverlay", "closeTemplatesBtn", "templateNameInput", "saveTemplateBtn",
    "templatesList", "confirmOverlay", "confirmMessage", "confirmOkBtn", "confirmCancelBtn", "toast",
    "toastText", "toastAction",
    // header & account row
    "appTitle", "listSwitcherBtn", "listTitle", "connPill", "syncDot", "connText", "accountRow",
    "enableSyncBtn", "membersBtn", "membersText", "syncBar",
    // tabs & profile
    "bottomNav", "profileGuestSection", "profileSyncBtn", "profileAccountSection", "profileSyncSection",
    "syncDetailText", "syncNowBtn", "profileListsBtn", "profileTemplatesBtn", "profileOrderBtn", "deviceSection",
    "appVersion",
    // layout
    "layoutToggleBtn", "orderBtn", "orderOverlay", "closeOrderBtn", "orderList", "resetOrderBtn",
    // add bar
    "quickStrip", "quickAddBtn", "micBtn", "voicePanel", "voiceText", "voiceStopBtn",
    // quick-add sheet
    "quickOverlay", "closeQuickBtn", "quickSearchInput", "quickList",
    // lists sheet
    "listsOverlay", "closeListsBtn", "listsList", "newListInput", "createListBtn", "listNameSuggestions",
    "joinCodeInput", "joinCodeBtn",
    // item sheet
    "itemOverlay", "closeItemBtn", "itemNameInput", "itemQtyInput", "qtyMinusBtn", "qtyPlusBtn", "unitChips",
    "itemNotesInput", "categoryGrid", "itemMeta", "deleteItemBtn", "saveItemBtn",
    // share / account sheet
    "accountOverlay", "accountTitle", "closeAccountBtn", "listSettingsSection", "listNameInput",
    "saveListNameBtn", "inviteCode", "shareLinkBtn", "copyCodeBtn", "regenCodeBtn", "shareSection",
    "shareUserIdInput", "shareBtn", "membersTitle", "membersList", "sharedWithMeSection", "sharedByText",
    "leaveListBtn", "deleteListSection", "deleteListBtn", "usernameInput", "saveUsernameBtn", "fullUserId",
    "copyFullIdBtn", "syncStatusText", "linkCodeRow", "linkCode", "copyLinkCodeBtn", "showLinkCodeBtn",
    "logoutBtn",
    // welcome
    "welcomeOverlay", "closeWelcomeBtn", "welcomeText", "registerPanel", "linkPanel", "welcomeNameInput",
    "registerBtn", "showLinkPanelBtn", "showRegisterPanelBtn", "linkCodeInput", "linkDeviceBtn",
    "welcomeStatus", "skipWelcomeBtn",
  ].forEach((id) => { $[id] = el(id); });

  /* ---------- Sheets (bottom modals) ---------- */
  function openSheet(overlay) { overlay.classList.remove("hidden"); }
  function closeSheet(overlay) { overlay.classList.add("hidden"); }
  function wireSheet(overlay, closeBtn, onClose) {
    const close = () => { closeSheet(overlay); if (onClose) onClose(); };
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }
  const isOpen = (overlay) => !overlay.classList.contains("hidden");

  /* ---------- Toast ---------- */
  let toastTimer = null;
  let toastActionFn = null;
  function showToast(msg, ms = 2200, action = null) {
    $.toastText.textContent = msg;
    toastActionFn = action ? action.fn : null;
    $.toastAction.textContent = action ? action.label : "";
    $.toastAction.classList.toggle("hidden", !action);
    $.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $.toast.classList.add("hidden"), ms);
  }
  $.toastAction.addEventListener("click", () => {
    const fn = toastActionFn;
    $.toast.classList.add("hidden");
    if (fn) fn();
  });

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(okMsg);
    } catch (e) {
      showToast("ההעתקה נכשלה — סמנו והעתיקו ידנית");
    }
  }

  /* ---------- Confirm modal ---------- */
  let confirmCallback = null;
  function showConfirm(message, onConfirm) {
    $.confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    openSheet($.confirmOverlay);
  }
  function hideConfirm() {
    closeSheet($.confirmOverlay);
    confirmCallback = null;
  }
  $.confirmOkBtn.addEventListener("click", () => {
    const cb = confirmCallback;
    hideConfirm();
    if (cb) cb();
  });
  $.confirmCancelBtn.addEventListener("click", hideConfirm);
  $.confirmOverlay.addEventListener("click", (e) => { if (e.target === $.confirmOverlay) hideConfirm(); });

  /* ---------- Theme (dark by default; light is opt-in from the Profile tab) ---------- */
  const THEME_BAR_COLOR = { dark: "#121212", light: "#f4f6f4" };
  const themeButtons = document.querySelectorAll("[data-theme-choice]");

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute("content", THEME_BAR_COLOR[theme]);
    themeButtons.forEach((b) => {
      const on = b.dataset.themeChoice === theme;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    });
    Native.setStatusBar(theme);
  }
  themeButtons.forEach((b) => b.addEventListener("click", () => {
    applyTheme(b.dataset.themeChoice);
    try { localStorage.setItem(STORAGE_KEYS.theme, b.dataset.themeChoice); } catch (e) {}
  }));

  /* ---------- Operations ----------
   * Every change — a local tap or a socket event — is an "op" applied by
   * applyOp(). Local ops are additionally queued to the server by commit().
   */
  function applyOp(op) {
    switch (op.type) {
      case "add": {
        const idx = items.findIndex((i) => i.id === op.item.id);
        if (idx >= 0) items[idx] = { ...items[idx], ...op.item };
        else items.push(op.item);
        break;
      }
      case "toggle": {
        const item = items.find((i) => i.id === op.id);
        if (item) item.bought = op.bought;
        break;
      }
      case "update": {
        const item = items.find((i) => i.id === op.id);
        if (item) Object.assign(item, op.changes);
        break;
      }
      case "delete":
        items = items.filter((i) => i.id !== op.id);
        break;
      case "remove": {
        const ids = new Set(op.ids);
        items = items.filter((i) => !ids.has(i.id));
        break;
      }
      case "clearBought":
        items = items.filter((i) => !i.bought);
        break;
      case "reset":
        items = [];
        break;
    }
  }

  function toWire(op, listId) {
    switch (op.type) {
      case "add": {
        const { id, name, category, quantity, notes } = op.item;
        return ["item:add", { listId, item: { itemId: id, text: name, category, quantity, notes } }];
      }
      case "toggle":
        return ["item:toggle", { listId, itemId: op.id, isCompleted: op.bought }];
      case "update": {
        const c = op.changes;
        const changes = {};
        if (c.name !== undefined) changes.text = c.name;
        ["category", "quantity", "notes"].forEach((k) => { if (c[k] !== undefined) changes[k] = c[k]; });
        return ["item:update", { listId, itemId: op.id, changes }];
      }
      case "delete":
        return ["item:delete", { listId, itemId: op.id }];
      case "clearBought":
        return ["item:clear_completed", { listId }];
      case "reset":
        return ["list:reset", { listId }];
    }
    return null;
  }

  /* Local user action: apply optimistically, persist, render, and queue for the server. */
  function commit(op) {
    applyOp(op);
    saveItems();
    render();
    if (sync && activeListId) {
      const wire = toWire(op, activeListId);
      if (wire) sync.send(wire[0], wire[1], op);
    }
  }

  function fromServerItem(s) {
    return {
      id: s.itemId,
      name: s.text,
      category: Categories.MAP[s.category] ? s.category : "misc",
      bought: !!s.isCompleted,
      quantity: typeof s.quantity === "string" ? s.quantity : s.qty > 1 ? String(s.qty) : "",
      notes: s.notes || "",
      createdAt: s.createdAt,
      addedBy: s.addedBy,
    };
  }

  /* ---------- Rendering: filter chips (only sections that have items) ---------- */
  let chipSignature = "";
  function renderFilterRow() {
    const present = new Set(items.map((i) => i.category));
    if (activeFilter !== "all" && !present.has(activeFilter)) activeFilter = "all";
    const keys = ["all", ...storeOrder.filter((k) => present.has(k))];
    const signature = keys.join("|") + "#" + activeFilter;
    if (signature === chipSignature) return;
    chipSignature = signature;

    $.filterRow.innerHTML = "";
    $.filterRow.classList.toggle("hidden", keys.length <= 2);
    keys.forEach((key) => {
      const c = key === "all" ? { label: "הכל", emoji: "📋" } : Categories.get(key);
      const btn = document.createElement("button");
      btn.className = "chip" + (activeFilter === key ? " active" : "");
      btn.textContent = `${c.emoji} ${c.label}`;
      btn.addEventListener("click", () => {
        activeFilter = activeFilter === key ? "all" : key;
        render();
      });
      $.filterRow.appendChild(btn);
    });
  }

  /* ---------- Rendering: list (keyed, patches the DOM in place) ---------- */
  const rowRefs = new Map(); // item id -> { row, content, circle, nameEl, qtyEl, metaEl }
  const headerEls = new Map(); // section key -> element

  function sectionHeader(key, text) {
    let h = headerEls.get(key);
    if (!h) {
      h = document.createElement("div");
      h.className = "section-label";
      headerEls.set(key, h);
    }
    if (h.textContent !== text) h.textContent = text;
    return h;
  }

  /* Checked items live in a collapsible drawer under the open ones. */
  let checkedOpen = readJSON(STORAGE_KEYS.checkedOpen, false) === true;
  const checkedHeader = (() => {
    const wrap = document.createElement("div");
    wrap.className = "checked-header";
    const toggle = document.createElement("button");
    toggle.className = "checked-toggle";
    const label = document.createElement("span");
    const chev = document.createElement("span");
    chev.className = "checked-chev";
    chev.textContent = "▾";
    toggle.appendChild(label);
    toggle.appendChild(chev);
    const clear = document.createElement("button");
    clear.className = "checked-clear";
    clear.textContent = "🧹 ניקוי";
    clear.setAttribute("aria-label", "מחיקת הפריטים שסומנו");
    toggle.addEventListener("click", () => {
      checkedOpen = !checkedOpen;
      writeJSON(STORAGE_KEYS.checkedOpen, checkedOpen);
      render();
    });
    clear.addEventListener("click", clearBought);
    wrap.appendChild(toggle);
    wrap.appendChild(clear);
    return { wrap, label, toggle };
  })();

  function checkedHeaderNode(count, open) {
    const text = `פריטים שסומנו (${count})`;
    if (checkedHeader.label.textContent !== text) checkedHeader.label.textContent = text;
    checkedHeader.wrap.classList.toggle("open", open);
    checkedHeader.toggle.setAttribute("aria-expanded", String(open));
    headerEls.set("bought", checkedHeader.wrap);
    return checkedHeader.wrap;
  }

  function getVisibleItems() {
    let visible = items;
    if (activeFilter !== "all") visible = visible.filter((i) => i.category === activeFilter);
    if (searchQuery.trim()) {
      const q = norm(searchQuery);
      visible = visible.filter((i) => norm(i.name).includes(q) || norm(i.notes).includes(q));
    }
    return visible;
  }

  /* The ordered DOM nodes (section headers + rows) for the current view. */
  function layoutNodes(visible) {
    const nodes = [];
    const open = visible.filter((i) => !i.bought);
    const bought = visible.filter((i) => i.bought);

    if (viewMode === "store") {
      const byCat = new Map();
      open.forEach((i) => {
        if (!byCat.has(i.category)) byCat.set(i.category, []);
        byCat.get(i.category).push(i);
      });
      storeOrder.forEach((key) => {
        const group = byCat.get(key);
        if (!group) return;
        const c = Categories.get(key);
        nodes.push(sectionHeader("cat:" + key, `${c.emoji} ${c.label} · ${group.length}`));
        group.forEach((i) => nodes.push(upsertRow(i).row));
      });
    } else {
      open.forEach((i) => nodes.push(upsertRow(i).row));
    }

    if (bought.length) {
      // A search always shows its checked matches; otherwise the drawer decides.
      const open = checkedOpen || !!searchQuery.trim();
      nodes.push(checkedHeaderNode(bought.length, open));
      if (open) bought.forEach((i) => nodes.push(upsertRow(i).row));
    }
    return nodes;
  }

  function render() {
    renderFilterRow();

    const totalCount = items.length;
    const remaining = items.filter((i) => !i.bought).length;
    $.subtitle.textContent = totalCount === 0 ? "הרשימה ריקה" : `${remaining} מתוך ${totalCount} נותרו לקנייה`;

    const visible = getVisibleItems();
    const desired = layoutNodes(visible);

    // Drop rows/headers that are no longer shown; animate only real deletions.
    const keep = new Set(desired);
    const existingIds = new Set(items.map((i) => i.id));
    rowRefs.forEach((ref, id) => {
      if (keep.has(ref.row)) return;
      rowRefs.delete(id);
      if (existingIds.has(id)) ref.row.remove();
      else retireRow(ref.row);
    });
    headerEls.forEach((h, key) => {
      if (!keep.has(h)) {
        h.remove();
        headerEls.delete(key);
      }
    });

    // Put nodes in order, moving only the ones that are out of place.
    let cursor = $.listContainer.firstChild;
    desired.forEach((node) => {
      while (cursor && cursor.classList.contains("removing")) cursor = cursor.nextSibling;
      if (cursor === node) cursor = node.nextSibling;
      else $.listContainer.insertBefore(node, cursor);
    });

    flashIds.forEach((id) => {
      const ref = rowRefs.get(id);
      if (!ref) return;
      ref.content.classList.remove("pulse-remote");
      void ref.content.offsetWidth;
      ref.content.classList.add("pulse-remote");
    });
    flashIds.clear();

    const isEmpty = visible.length === 0;
    $.emptyState.classList.toggle("hidden", !isEmpty);
    $.listContainer.classList.toggle("hidden", isEmpty);
    if (isEmpty) {
      $.emptyState.querySelector("p").textContent = totalCount === 0 ? "הרשימה ריקה" : "לא נמצאו פריטים";
      $.emptyState.querySelector("span").textContent = totalCount === 0
        ? "הוסיפו פריט בתחתית המסך — או לחצו על 🎤 ותגידו מה צריך"
        : "נסו לשנות את החיפוש או הסינון";
    }

    if (isOpen($.quickOverlay)) renderQuickList();
    if (document.activeElement === $.newItemInput) renderQuickStrip();
    if (activeTab === "ai") AIChat.refreshAddButtons();
  }

  function retireRow(row) {
    row.style.maxHeight = row.offsetHeight + "px";
    void row.offsetHeight; // commit the start height so the collapse animates
    row.classList.add("removing");
    row.style.maxHeight = "0px";
    setTimeout(() => row.remove(), 260);
  }

  function memberName(userId) {
    const m = listInfo && listInfo.members.find((x) => x.userId === userId);
    return m ? m.username : null;
  }

  const showsQuantity = (q) => !!q && q !== "1";

  function upsertRow(item) {
    let ref = rowRefs.get(item.id);
    if (!ref) {
      ref = buildItemRow(item.id);
      rowRefs.set(item.id, ref);
    }
    const cat = Categories.get(item.category);
    const shared = listInfo && listInfo.members.length > 1;
    const adder = shared && item.addedBy && account && item.addedBy !== account.userId ? memberName(item.addedBy) : null;

    ref.circle.classList.toggle("checked", !!item.bought);
    ref.row.classList.toggle("is-bought", !!item.bought);
    ref.nameEl.classList.toggle("bought", !!item.bought);
    const emojiKey = item.name + "|" + item.category;
    if (ref.emojiKey !== emojiKey) {
      ref.emojiKey = emojiKey;
      ref.emojiEl.textContent = Categories.emojiFor(item.name, item.category);
    }
    if (ref.nameEl.textContent !== item.name) ref.nameEl.textContent = item.name;

    const qty = showsQuantity(item.quantity) ? item.quantity : "";
    if (ref.qtyEl.textContent !== qty) ref.qtyEl.textContent = qty;
    ref.qtyEl.classList.toggle("hidden", !qty);

    // Second line: section (hidden in store view, where headers already say it) · note · who added it
    const parts = [];
    if (viewMode !== "store" || item.bought) parts.push(cat.label);
    if (adder) parts.push(adder);
    const metaText = parts.join(" · ");
    if (ref.metaText.textContent !== metaText) ref.metaText.textContent = metaText;
    const note = item.notes ? `📝 ${item.notes}` : "";
    if (ref.noteEl.textContent !== note) ref.noteEl.textContent = note;
    ref.noteEl.classList.toggle("hidden", !note);
    ref.metaEl.classList.toggle("hidden", !metaText && !note);
    return ref;
  }

  function buildItemRow(id) {
    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.id = id;

    const deleteAction = document.createElement("div");
    deleteAction.className = "item-delete-action";
    deleteAction.textContent = "🗑️ מחיקה";

    const content = document.createElement("div");
    content.className = "item-content";

    const circle = document.createElement("button");
    circle.className = "check-circle";
    circle.textContent = "✓";
    circle.setAttribute("aria-label", "סמן כנקנה");
    circle.addEventListener("click", () => toggleBought(id));

    const emojiEl = document.createElement("span");
    emojiEl.className = "item-emoji";
    emojiEl.setAttribute("aria-hidden", "true");

    const main = document.createElement("button");
    main.className = "item-main";
    main.setAttribute("aria-label", "פרטי פריט");
    const nameEl = document.createElement("div");
    nameEl.className = "item-name";
    const metaEl = document.createElement("div");
    metaEl.className = "item-meta-line";
    const metaText = document.createElement("span");
    const noteEl = document.createElement("span");
    noteEl.className = "item-note";
    metaEl.appendChild(metaText);
    metaEl.appendChild(noteEl);
    main.appendChild(nameEl);
    main.appendChild(metaEl);

    const qtyEl = document.createElement("button");
    qtyEl.className = "qty-pill hidden";
    qtyEl.setAttribute("aria-label", "כמות");

    content.appendChild(circle);
    content.appendChild(emojiEl);
    content.appendChild(main);
    content.appendChild(qtyEl);
    row.appendChild(deleteAction);
    row.appendChild(content);

    const swipe = attachSwipeToDelete(content, id);
    const openEditor = () => { if (!swipe.justSwiped()) openItemEditor(id); };
    main.addEventListener("click", openEditor);
    qtyEl.addEventListener("click", openEditor);

    return { row, content, circle, emojiEl, emojiKey: null, nameEl, qtyEl, metaEl, metaText, noteEl };
  }

  /* ---------- Swipe to delete ---------- */
  function attachSwipeToDelete(content, id) {
    let startX = 0;
    let currentX = 0;
    let dragging = false;
    let swipedAt = 0;
    const threshold = 70;

    function onDown(e) {
      dragging = true;
      startX = e.clientX;
      currentX = 0;
      content.style.transition = "none";
    }
    function onMove(e) {
      if (!dragging) return;
      currentX = e.clientX - startX;
      if (currentX > 0) currentX = 0; // only allow leftward drag
      content.style.transform = `translateX(${currentX}px)`;
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      content.style.transition = "transform 0.18s ease";
      if (Math.abs(currentX) > 6) swipedAt = Date.now(); // a drag, not a tap
      if (Math.abs(currentX) > threshold) {
        deleteItem(id);
      } else {
        content.style.transform = "translateX(0)";
      }
      currentX = 0;
    }

    content.addEventListener("pointerdown", onDown);
    content.addEventListener("pointermove", onMove);
    content.addEventListener("pointerup", onUp);
    content.addEventListener("pointercancel", onUp);
    content.addEventListener("pointerleave", () => { if (dragging) onUp(); });
    return { justSwiped: () => Date.now() - swipedAt < 400 };
  }

  /* ---------- Actions ---------- */
  function newItem({ name, category, quantity = "", notes = "" }) {
    return {
      id: uid(),
      name,
      category: category || Categories.categorize(name),
      bought: false,
      quantity,
      notes,
      createdAt: Date.now(),
      addedBy: account ? account.userId : undefined,
    };
  }

  function findOpen(name) {
    const key = norm(name);
    return items.find((i) => !i.bought && norm(i.name) === key);
  }

  function pulseRow(id) {
    const ref = rowRefs.get(id);
    if (!ref) return;
    ref.content.scrollIntoView({ behavior: "smooth", block: "center" });
    ref.content.classList.add("pulse");
    setTimeout(() => ref.content.classList.remove("pulse"), 500);
  }

  /* Adds one item unless it's already open on the list. Returns the new item, or null. */
  function addNamed(spec) {
    const name = String(spec.name || "").trim();
    if (!name) return null;
    if (findOpen(name)) return null;
    const item = newItem({ ...spec, name });
    commit({ type: "add", item });
    QuickAdd.record(item, historyKey());
    return item;
  }

  /* Typed input: "2 חלב", "חלב x2", and comma-separated lists all work. */
  function addFromInput() {
    const raw = $.newItemInput.value.trim();
    if (!raw) return;
    const specs = raw.split(/[,،]/).map((part) => ItemParser.parseSingle(part)).filter((s) => s.name);
    const added = [];
    let duplicate = null;
    specs.forEach((spec) => {
      const item = addNamed(spec);
      if (item) added.push(item);
      else duplicate = duplicate || findOpen(spec.name);
    });
    $.newItemInput.value = "";
    renderQuickStrip();
    if (duplicate && !added.length) {
      showToast(`"${duplicate.name}" כבר ברשימה`);
      pulseRow(duplicate.id);
    } else if (added.length > 1) {
      showToast(`נוספו ${added.length} פריטים`);
    }
  }

  function toggleBought(id) {
    const item = items.find((i) => i.id === id);
    if (item) commit({ type: "toggle", id, bought: !item.bought });
  }

  function deleteItem(id) {
    commit({ type: "delete", id });
  }

  function clearBought() {
    if (!items.some((i) => i.bought)) {
      showToast("אין פריטים שנקנו");
      return;
    }
    showConfirm("למחוק את כל הפריטים שנקנו?", () => {
      commit({ type: "clearBought" });
      showToast("הפריטים שנקנו נמחקו");
    });
  }

  function resetAll() {
    if (items.length === 0) {
      showToast("הרשימה כבר ריקה");
      return;
    }
    const msg = isSharedList()
      ? "לאפס את כל הרשימה? היא תתאפס גם אצל כל המשתתפים."
      : "לאפס את כל הרשימה? הפעולה לא ניתנת לביטול.";
    showConfirm(msg, () => {
      commit({ type: "reset" });
      showToast("הרשימה אופסה");
    });
  }

  /* ---------- Item details sheet ---------- */
  let editingId = null;
  let editingCategory = "misc";

  function renderCategoryGrid() {
    $.categoryGrid.innerHTML = "";
    Categories.LIST.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "cat-option" + (c.key === editingCategory ? " active" : "");
      btn.textContent = `${c.emoji} ${c.label}`;
      btn.addEventListener("click", () => {
        editingCategory = c.key;
        renderCategoryGrid();
      });
      $.categoryGrid.appendChild(btn);
    });
  }

  function relativeTime(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return "עכשיו";
    if (min < 60) return `לפני ${min} דק׳`;
    const h = Math.round(min / 60);
    if (h < 24) return `לפני ${h} שע׳`;
    return `לפני ${Math.round(h / 24)} ימים`;
  }

  function openItemEditor(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    editingId = id;
    editingCategory = item.category;
    $.itemNameInput.value = item.name;
    $.itemQtyInput.value = item.quantity;
    $.itemNotesInput.value = item.notes;
    renderCategoryGrid();
    const by = item.addedBy && account ? (item.addedBy === account.userId ? "את/ה" : memberName(item.addedBy)) : null;
    $.itemMeta.textContent = [by ? `נוסף ע״י ${by}` : "", item.createdAt ? relativeTime(item.createdAt) : ""].filter(Boolean).join(" · ");
    openSheet($.itemOverlay);
  }

  function closeItemEditor() {
    editingId = null;
    closeSheet($.itemOverlay);
  }

  /* "2 ק״ג" -> { n: 2, unit: "ק״ג" };  "" -> { n: null, unit: "" } */
  function splitQuantity(q) {
    const m = /^\s*(\d+(?:\.\d+)?|½)\s*(.*)$/.exec(q || "");
    if (!m) return { n: null, unit: (q || "").trim() };
    return { n: m[1] === "½" ? 0.5 : parseFloat(m[1]), unit: m[2].trim() };
  }
  function stepQuantity(delta) {
    const { n, unit } = splitQuantity($.itemQtyInput.value);
    const next = Math.max(1, (n === null ? 1 : n) + delta);
    $.itemQtyInput.value = unit ? `${next} ${unit}` : String(next);
  }
  function setUnit(unit) {
    const { n } = splitQuantity($.itemQtyInput.value);
    $.itemQtyInput.value = `${n === null ? 1 : n} ${unit}`;
  }

  function saveItemEditor() {
    const item = items.find((i) => i.id === editingId);
    if (!item) return closeItemEditor();
    const next = {
      name: $.itemNameInput.value.trim() || item.name,
      quantity: $.itemQtyInput.value.trim(),
      notes: $.itemNotesInput.value.trim(),
      category: editingCategory,
    };
    const changes = {};
    Object.keys(next).forEach((k) => { if (next[k] !== item[k]) changes[k] = next[k]; });
    if (changes.category) {
      Categories.learn(next.name, changes.category);
      writeJSON(STORAGE_KEYS.learnedCategories, Categories.learned);
    }
    if (Object.keys(changes).length) commit({ type: "update", id: item.id, changes });
    closeItemEditor();
  }

  UNIT_CHIPS.forEach((unit) => {
    const chip = document.createElement("button");
    chip.className = "suggestion-chip";
    chip.textContent = unit;
    chip.addEventListener("click", () => setUnit(unit));
    $.unitChips.appendChild(chip);
  });

  /* ---------- Store layout ---------- */
  function setViewMode(mode) {
    viewMode = mode;
    writeJSON(STORAGE_KEYS.viewMode, mode);
    $.layoutToggleBtn.classList.toggle("active", mode === "store");
    $.layoutToggleBtn.setAttribute("aria-pressed", String(mode === "store"));
    $.orderBtn.classList.toggle("hidden", mode !== "store");
    render();
  }

  function renderOrderList() {
    $.orderList.innerHTML = "";
    storeOrder.forEach((key, idx) => {
      const c = Categories.get(key);
      const row = document.createElement("div");
      row.className = "acc-row";
      const num = document.createElement("span");
      num.className = "order-num";
      num.textContent = idx + 1;
      const title = document.createElement("div");
      title.className = "acc-row-main acc-row-title";
      title.textContent = `${c.emoji} ${c.label}`;
      row.appendChild(num);
      row.appendChild(title);
      [["▲", -1, "למעלה"], ["▼", 1, "למטה"]].forEach(([icon, dir, label]) => {
        const btn = document.createElement("button");
        btn.className = "order-move";
        btn.textContent = icon;
        btn.setAttribute("aria-label", `${label}: ${c.label}`);
        btn.disabled = idx + dir < 0 || idx + dir >= storeOrder.length;
        btn.addEventListener("click", () => moveSection(idx, dir));
        row.appendChild(btn);
      });
      $.orderList.appendChild(row);
    });
  }

  function moveSection(idx, dir) {
    const next = storeOrder.slice();
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    storeOrder = next;
    writeJSON(STORAGE_KEYS.storeOrder, storeOrder);
    chipSignature = "";
    renderOrderList();
    render();
  }

  /* ---------- Quick add ---------- */
  const historyKey = () => activeListId || "local";

  function openNames() {
    return new Set(items.filter((i) => !i.bought).map((i) => norm(i.name)));
  }

  function addFromHistory(entry) {
    const existing = findOpen(entry.name);
    if (existing) {
      showToast(`"${entry.name}" כבר ברשימה`);
      return null;
    }
    return addNamed({ name: entry.name, category: entry.category, quantity: entry.quantity });
  }

  /* Chips above the input while typing: frequent items, filtered by what's typed. */
  function renderQuickStrip() {
    if (document.activeElement !== $.newItemInput) {
      $.quickStrip.classList.add("hidden");
      return;
    }
    const query = ItemParser.parseSingle($.newItemInput.value).name;
    const suggestions = QuickAdd.suggestions({ exclude: openNames(), query, limit: 10, listId: historyKey() });
    $.quickStrip.innerHTML = "";
    $.quickStrip.classList.toggle("hidden", !suggestions.length);
    suggestions.forEach((entry) => {
      const chip = document.createElement("button");
      chip.className = "quick-chip";
      chip.textContent = `${Categories.get(entry.category).emoji} ${entry.name}`;
      // Keep focus in the input so the keyboard stays open on mobile.
      chip.addEventListener("pointerdown", (e) => e.preventDefault());
      chip.addEventListener("click", () => {
        const typed = ItemParser.parseSingle($.newItemInput.value);
        const item = addFromHistory({ ...entry, quantity: typed.quantity || entry.quantity });
        if (item) $.newItemInput.value = "";
        renderQuickStrip();
      });
      $.quickStrip.appendChild(chip);
    });
  }

  function renderQuickList() {
    const open = openNames();
    const all = QuickAdd.suggestions({ query: $.quickSearchInput.value, limit: 60, listId: historyKey() });
    $.quickList.innerHTML = "";
    if (!all.length) {
      const empty = document.createElement("div");
      empty.className = "templates-empty";
      empty.textContent = QuickAdd.size() ? "לא נמצאו פריטים" : "פריטים שתוסיפו לרשימות יופיעו כאן להוספה מהירה";
      $.quickList.appendChild(empty);
      return;
    }
    all.forEach((entry) => {
      const inList = open.has(norm(entry.name));
      const row = document.createElement("div");
      row.className = "acc-row";

      const main = document.createElement("button");
      main.className = "acc-row-main quick-row-main";
      const title = document.createElement("div");
      title.className = "acc-row-title";
      title.textContent = `${Categories.get(entry.category).emoji} ${entry.name}`;
      const sub = document.createElement("div");
      sub.className = "acc-row-sub";
      sub.textContent = entry.count > 1 ? `נוסף ${entry.count} פעמים` : "נוסף פעם אחת";
      main.appendChild(title);
      main.appendChild(sub);

      const add = document.createElement("button");
      add.className = "quick-add-btn" + (inList ? " in-list" : "");
      add.textContent = inList ? "✓ ברשימה" : "+ הוספה";
      add.disabled = inList;
      const doAdd = () => { if (!inList) addFromHistory(entry); };
      add.addEventListener("click", doAdd);
      main.addEventListener("click", doAdd);

      const forget = document.createElement("button");
      forget.className = "acc-remove";
      forget.textContent = "✕";
      forget.setAttribute("aria-label", `הסרה מההיסטוריה: ${entry.name}`);
      forget.addEventListener("click", () => {
        QuickAdd.forget(entry.name);
        renderQuickList();
      });

      row.appendChild(main);
      row.appendChild(add);
      row.appendChild(forget);
      $.quickList.appendChild(row);
    });
  }

  /* ---------- Voice input ---------- */
  let voice = null;

  function voiceVocabulary() {
    return [...Categories.vocabulary(), ...QuickAdd.names(), ...items.map((i) => i.name)];
  }

  function handleSpoken(text) {
    const specs = ItemParser.parseSpoken(text, voiceVocabulary());
    const added = [];
    const skipped = [];
    specs.forEach((spec) => {
      const item = addNamed(spec);
      if (item) added.push(item);
      else skipped.push(spec.name);
    });

    if (!added.length) {
      showToast(skipped.length ? `כבר ברשימה: ${skipped.join(", ")}` : `לא זיהיתי פריטים ב"${text}"`, 3500);
      return;
    }
    const names = added.map((i) => i.name).join(", ");
    const already = skipped.length ? ` (כבר ברשימה: ${skipped.join(", ")})` : "";
    showToast(`נוספו: ${names}${already}`, 6000, {
      label: "ביטול",
      fn: () => {
        added.forEach((i) => { if (items.some((x) => x.id === i.id)) commit({ type: "delete", id: i.id }); });
        showToast("ההוספה בוטלה");
      },
    });
  }

  function setupVoice() {
    if (!VoiceInput.supported) return;
    $.micBtn.classList.remove("hidden");
    voice = new VoiceInput({
      lang: "he-IL",
      onStart: () => {
        $.micBtn.classList.add("listening");
        $.voiceText.textContent = "מקשיב… אמרו למשל: ״חלב, ביצים ועגבניות״";
        $.voicePanel.classList.remove("hidden");
        $.quickStrip.classList.add("hidden");
      },
      onInterim: (text) => { $.voiceText.textContent = text; },
      onResult: handleSpoken,
      onError: (msg) => showToast(msg, 3500),
      onEnd: () => {
        $.micBtn.classList.remove("listening");
        $.voicePanel.classList.add("hidden");
      },
    });
    $.micBtn.addEventListener("click", () => (voice.listening ? voice.stop() : voice.start()));
    $.voiceStopBtn.addEventListener("click", () => voice.stop());
  }

  /* ---------- Templates ---------- */
  function renderTemplatesList() {
    $.templatesList.innerHTML = "";
    const names = Object.keys(templates);
    if (names.length === 0) {
      const empty = document.createElement("div");
      empty.className = "templates-empty";
      empty.textContent = "אין תבניות שמורות עדיין";
      $.templatesList.appendChild(empty);
      return;
    }
    names.forEach((name) => {
      const card = document.createElement("div");
      card.className = "template-card";

      const info = document.createElement("div");
      info.className = "template-info";
      const nameEl = document.createElement("div");
      nameEl.className = "template-name";
      nameEl.textContent = name;
      const countEl = document.createElement("div");
      countEl.className = "template-count";
      countEl.textContent = `${templates[name].length} פריטים`;
      info.appendChild(nameEl);
      info.appendChild(countEl);

      const actions = document.createElement("div");
      actions.className = "template-actions";
      const loadBtn = document.createElement("button");
      loadBtn.className = "template-btn";
      loadBtn.textContent = "טען";
      loadBtn.addEventListener("click", () => loadTemplate(name));
      const delBtn = document.createElement("button");
      delBtn.className = "template-del";
      delBtn.textContent = "✕";
      delBtn.addEventListener("click", () => {
        showConfirm(`למחוק את התבנית "${name}"?`, () => {
          delete templates[name];
          saveTemplates();
          renderTemplatesList();
          showToast("התבנית נמחקה");
        });
      });
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);

      card.appendChild(info);
      card.appendChild(actions);
      $.templatesList.appendChild(card);
    });
  }

  function saveCurrentAsTemplate() {
    const name = $.templateNameInput.value.trim();
    if (!name) {
      showToast("יש להזין שם לתבנית");
      return;
    }
    if (items.length === 0) {
      showToast("הרשימה ריקה, אין מה לשמור");
      return;
    }
    templates[name] = items.map((i) => ({ name: i.name, category: i.category, quantity: i.quantity }));
    saveTemplates();
    $.templateNameInput.value = "";
    renderTemplatesList();
    showToast(`התבנית "${name}" נשמרה`);
  }

  function loadTemplate(name) {
    const templateItems = templates[name];
    if (!templateItems) return;
    const addedCount = templateItems.filter((ti) => addNamed(ti)).length;
    closeSheet($.templatesOverlay);
    showToast(addedCount > 0 ? `${addedCount} פריטים נוספו מהתבנית` : "כל הפריטים כבר ברשימה");
  }

  /* ================================================================
   * Accounts, lists, sharing & real-time sync
   * ================================================================ */
  function ownListId() {
    const own = lists.find((l) => account && l.ownerId === account.userId);
    return own ? own.listId : lists[0] && lists[0].listId;
  }
  function activeListMeta() {
    return lists.find((l) => l.listId === activeListId) || null;
  }
  function isOwnList() {
    const meta = activeListMeta();
    const ownerId = (listInfo && listInfo.ownerId) || (meta && meta.ownerId);
    return !!account && ownerId === account.userId;
  }
  function isSharedList() {
    const meta = activeListMeta();
    const count = listInfo ? listInfo.members.length : meta ? meta.memberCount : 1;
    return count > 1;
  }
  function listDisplayName(l) {
    if (!l) return "רשימת קניות";
    if (l.name) return l.name;
    return account && l.ownerId === account.userId ? "הרשימה שלי" : `הרשימה של ${l.ownerName || ""}`;
  }
  function activeListName() {
    const meta = activeListMeta();
    return listDisplayName({ ...(meta || {}), ...(listInfo ? { name: listInfo.name, ownerId: listInfo.ownerId } : {}) });
  }

  function saveLists() {
    writeJSON(STORAGE_KEYS.lists, lists);
  }

  function setActiveList(listId) {
    activeListId = listId;
    writeJSON(STORAGE_KEYS.activeList, listId);
  }

  function switchList(listId) {
    if (!listId) return;
    if (listId !== activeListId) {
      setActiveList(listId);
      loadListCache(listId);
      rowRefs.forEach((ref) => ref.row.remove());
      rowRefs.clear();
      headerEls.forEach((h) => h.remove());
      headerEls.clear();
      activeFilter = "all";
      chipSignature = "";
      if (isOpen($.itemOverlay)) closeItemEditor();
      render();
    }
    if (sync) sync.setActiveList(listId);
    renderAccountUI();
  }

  function forgetList(listId) {
    lists = lists.filter((l) => l.listId !== listId);
    saveLists();
    removeKey(STORAGE_KEYS.listCachePrefix + listId);
    if (sync) sync.dropList(listId);
  }

  const needsConnection = (res) => {
    const text = {
      offline: "הפעולה דורשת חיבור לשרת — נסו שוב כשתהיו מחוברים",
      timeout: "השרת לא הגיב, נסו שוב",
    }[res.error];
    showToast(text || "הפעולה נכשלה", 3000);
  };

  /* ---------- Header ---------- */
  function renderAccountUI() {
    $.accountRow.classList.toggle("hidden", !BACKEND_URL);
    $.appTitle.classList.toggle("hidden", !!account);
    $.listSwitcherBtn.classList.toggle("hidden", !account);
    $.connPill.classList.toggle("hidden", !account);
    if (!BACKEND_URL) return;

    $.enableSyncBtn.classList.toggle("hidden", !!account);
    $.membersBtn.classList.toggle("hidden", !account);
    renderProfile();
    if (aiSignedIn !== !!account) {
      aiSignedIn = !!account;
      AIChat.render();
    }
    if (!account) {
      $.syncBar.classList.add("hidden");
      return;
    }

    $.listTitle.textContent = "🛒 " + activeListName();
    renderConnPill();

    const meta = activeListMeta();
    const memberCount = listInfo ? listInfo.members.length : meta ? meta.memberCount : 1;
    if (!isOwnList()) {
      const ownerName = (meta && meta.ownerName) || (listInfo && memberName(listInfo.ownerId)) || "";
      $.membersText.textContent = `של ${ownerName}`;
    } else if (memberCount > 1) {
      $.membersText.textContent = `משותף עם ${memberCount - 1}`;
    } else {
      $.membersText.textContent = "שיתוף";
    }

    if (isOpen($.accountOverlay)) renderAccountModal();
    if (isOpen($.listsOverlay)) renderListsSheet();
  }

  /*
   * "Online" / "Syncing…" / "Offline · 3 pending". While the server is connecting or
   * waking up (Render cold start) the cached list stays usable and a thin bar under
   * the header shows that a sync is in progress.
   */
  function renderConnPill() {
    let text;
    if (syncStatus === "online") {
      text = pendingCount ? `מסתנכרן ${pendingCount}…` : "מחובר";
    } else if (syncStatus === "offline") {
      text = pendingCount ? `לא מקוון · ${pendingCount} ממתינים` : "לא מקוון";
    } else {
      text = pendingCount ? `מסתנכרן · ${pendingCount} ממתינים` : "מסתנכרן…";
    }
    const syncing = syncStatus === "connecting" || syncStatus === "waking" || (syncStatus === "online" && pendingCount > 0);
    $.syncBar.classList.toggle("hidden", !syncing);
    $.connText.textContent = text;
    $.syncDot.className = "sync-dot " + syncStatus;
    $.connPill.classList.remove("online", "offline", "connecting", "waking");
    $.connPill.classList.add(syncStatus);
    $.connPill.classList.toggle("pending", !!pendingCount);
    $.connPill.title = STATUS_TEXT[syncStatus] + (pendingCount ? ` (${pendingCount} שינויים ממתינים)` : "");
  }

  /* ---------- Profile tab ---------- */
  let aiSignedIn = null;

  function renderProfile() {
    const signedIn = !!account;
    $.profileGuestSection.classList.toggle("hidden", signedIn || !BACKEND_URL);
    [$.profileAccountSection, $.profileSyncSection, $.deviceSection, $.profileListsBtn].forEach((x) => {
      x.classList.toggle("hidden", !signedIn);
    });
    if (!signedIn) return;

    if (document.activeElement !== $.usernameInput) $.usernameInput.value = account.username;
    $.fullUserId.textContent = account.userId;
    $.syncStatusText.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "sync-dot " + syncStatus;
    $.syncStatusText.appendChild(dot);
    $.syncStatusText.appendChild(document.createTextNode(STATUS_TEXT[syncStatus]));
    $.syncDetailText.textContent = pendingCount
      ? `${pendingCount} שינויים שמורים במכשיר וממתינים לשליחה`
      : syncStatus === "online" ? "כל השינויים נשמרו בשרת" : "הרשימות שמורות במכשיר וזמינות גם בלי חיבור";
  }

  /* ---------- Bottom navigation ---------- */
  const tabPanels = document.querySelectorAll(".tab-panel");
  const navButtons = $.bottomNav.querySelectorAll(".nav-btn");

  function switchTab(tab) {
    if (tab === activeTab) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    activeTab = tab;
    tabPanels.forEach((panel) => panel.classList.toggle("hidden", panel.dataset.tab !== tab));
    navButtons.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (tab === "lists") render();
    if (tab === "ai") AIChat.onShow();
    if (tab === "profile") {
      $.linkCodeRow.classList.add("hidden");
      $.showLinkCodeBtn.classList.remove("hidden");
      renderProfile();
    }
  }
  navButtons.forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  /* ---------- Lists sheet ---------- */
  function renderListsSheet() {
    $.listsList.innerHTML = "";
    lists.forEach((l) => {
      const isActive = l.listId === activeListId;
      const remaining = isActive ? items.filter((i) => !i.bought).length : l.remaining || 0;
      const btn = document.createElement("button");
      btn.className = "acc-row" + (isActive ? " active" : "");
      const main = document.createElement("div");
      main.className = "acc-row-main";
      const title = document.createElement("div");
      title.className = "acc-row-title";
      title.textContent = listDisplayName(isActive ? { ...l, name: (listInfo && listInfo.name) || l.name } : l);
      const sub = document.createElement("div");
      sub.className = "acc-row-sub";
      const who = l.ownerId === account.userId
        ? (l.memberCount > 1 ? `משותפת עם ${l.memberCount - 1}` : "רק את/ה")
        : `של ${l.ownerName}`;
      sub.textContent = `${who} · ${remaining ? `${remaining} לקנייה` : "אין פריטים פתוחים"}`;
      main.appendChild(title);
      main.appendChild(sub);
      btn.appendChild(main);
      if (isActive) {
        const tag = document.createElement("span");
        tag.className = "acc-tag";
        tag.textContent = "פעילה";
        btn.appendChild(tag);
      }
      btn.addEventListener("click", () => {
        switchList(l.listId);
        closeSheet($.listsOverlay);
      });
      $.listsList.appendChild(btn);
    });
  }

  function openListsSheet() {
    renderListsSheet();
    openSheet($.listsOverlay);
  }

  LIST_NAME_SUGGESTIONS.forEach((name) => {
    const chip = document.createElement("button");
    chip.className = "suggestion-chip";
    chip.textContent = name;
    chip.addEventListener("click", () => { $.newListInput.value = name; createList(); });
    $.listNameSuggestions.appendChild(chip);
  });

  async function createList() {
    const name = $.newListInput.value.trim();
    if (!name) {
      showToast("תנו שם לרשימה");
      return;
    }
    $.createListBtn.disabled = true;
    const res = await sync.request("list:create", { listId: uid(), name });
    $.createListBtn.disabled = false;
    if (!res.ok) return needsConnection(res);
    const list = res.list;
    if (!lists.some((l) => l.listId === list.listId)) {
      lists.push({ listId: list.listId, ownerId: list.ownerId, ownerName: account.username, name: list.name, memberCount: 1, remaining: 0 });
      saveLists();
    }
    $.newListInput.value = "";
    closeSheet($.listsOverlay);
    switchList(list.listId);
    showToast(`הרשימה "${list.name}" נוצרה`);
  }

  async function joinByCode(code) {
    const clean = String(code || "").trim();
    if (!clean) {
      showToast("הזינו קוד הזמנה");
      return false;
    }
    const res = await sync.request("list:join_by_code", { code: clean });
    if (!res.ok) {
      if (res.error === "invalid code") showToast("קוד ההזמנה לא תקין או שפג תוקפו", 3000);
      else if (res.error === "too many attempts, try again later") showToast("יותר מדי ניסיונות, נסו שוב מאוחר יותר", 3000);
      else needsConnection(res);
      return false;
    }
    closeSheet($.listsOverlay);
    $.joinCodeInput.value = "";
    switchList(res.listId);
    showToast(res.already ? "כבר חברים ברשימה הזו" : `הצטרפת לרשימה "${activeListName()}" 🎉`, 3000);
    return true;
  }

  /* ---------- Share / account sheet ---------- */
  let inviteCode = null;

  const formatCode = (code) => (code ? code.slice(0, 4) + "-" + code.slice(4) : "••••-••••");
  // Inside the Android app the page lives on https://localhost, so invites point at the public web app.
  const inviteBase = () => (Native.isApp && PUBLIC_URL ? PUBLIC_URL : location.origin + location.pathname);
  const inviteLink = (code) => `${inviteBase()}?join=${code}`;

  async function loadInviteCode(regenerate = false) {
    const listId = activeListId;
    const res = await sync.request("list:share_code", { listId, regenerate });
    if (listId !== activeListId) return;
    inviteCode = res.ok ? res.code : null;
    $.inviteCode.textContent = res.ok ? formatCode(inviteCode) : "צריך חיבור לשרת";
    [$.shareLinkBtn, $.copyCodeBtn, $.regenCodeBtn].forEach((b) => { b.disabled = !inviteCode; });
    if (regenerate && res.ok) showToast("נוצר קוד חדש — הקוד הקודם כבר לא עובד");
  }

  async function shareInviteLink() {
    if (!inviteCode) return;
    const url = inviteLink(inviteCode);
    const text = `הצטרפו לרשימת הקניות "${activeListName()}"`;
    if (navigator.share) {
      try {
        await navigator.share({ title: activeListName(), text, url });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    copyText(url, "קישור ההזמנה הועתק");
  }

  function renderAccountModal() {
    if (!account) return;
    const own = isOwnList();
    $.accountTitle.textContent = `שיתוף: ${activeListName()}`;

    $.listSettingsSection.classList.toggle("hidden", !own);
    if (own && document.activeElement !== $.listNameInput) $.listNameInput.value = (listInfo && listInfo.name) || (activeListMeta() || {}).name || "";
    $.regenCodeBtn.classList.toggle("hidden", !own);
    $.shareSection.classList.toggle("hidden", !own);
    $.deleteListSection.classList.toggle("hidden", !own);
    $.sharedWithMeSection.classList.toggle("hidden", own);
    if (!own) {
      const meta = activeListMeta();
      const ownerName = (meta && meta.ownerName) || (listInfo && memberName(listInfo.ownerId)) || "";
      $.sharedByText.textContent = `הרשימה שייכת ל${ownerName}. שינויים שתעשו יופיעו אצל כל המשתתפים.`;
    }

    // Members
    $.membersList.innerHTML = "";
    const members = listInfo ? listInfo.members : [];
    $.membersTitle.textContent = `משתתפים (${members.length || 1})`;
    members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "acc-row";
      const main = document.createElement("div");
      main.className = "acc-row-main";
      const title = document.createElement("div");
      title.className = "acc-row-title";
      title.textContent = m.username + (m.userId === account.userId ? " (את/ה)" : "");
      main.appendChild(title);
      row.appendChild(main);
      if (listInfo && m.userId === listInfo.ownerId) {
        const tag = document.createElement("span");
        tag.className = "acc-tag";
        tag.textContent = "בעלים";
        row.appendChild(tag);
      } else if (own) {
        const rm = document.createElement("button");
        rm.className = "acc-remove";
        rm.textContent = "✕";
        rm.setAttribute("aria-label", `הסר את ${m.username}`);
        rm.addEventListener("click", () => {
          showConfirm(`להסיר את ${m.username} מהרשימה?`, () => removeMember(m.userId));
        });
        row.appendChild(rm);
      }
      $.membersList.appendChild(row);
    });
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "templates-empty";
      empty.textContent = "הפרטים ייטענו כשהחיבור לשרת יתחדש";
      $.membersList.appendChild(empty);
    }
  }

  function openAccountModal() {
    inviteCode = null;
    $.inviteCode.textContent = "טוען…";
    [$.shareLinkBtn, $.copyCodeBtn, $.regenCodeBtn].forEach((b) => { b.disabled = true; });
    renderAccountModal();
    openSheet($.accountOverlay);
    loadInviteCode();
  }

  async function saveListName() {
    const name = $.listNameInput.value.trim();
    if (!name) return;
    const res = await sync.request("list:rename", { listId: activeListId, name });
    if (!res.ok) return needsConnection(res);
    $.listNameInput.blur();
    showToast("שם הרשימה עודכן");
  }

  async function shareList() {
    const targetUserId = $.shareUserIdInput.value.trim();
    if (!targetUserId) {
      showToast("הדביקו מזהה משתמש");
      return;
    }
    if (targetUserId === account.userId) {
      showToast("זה המזהה שלך 🙂");
      return;
    }
    $.shareBtn.disabled = true;
    const res = await sync.request("share:list", { listId: activeListId, targetUserId });
    $.shareBtn.disabled = false;
    if (res.ok) {
      $.shareUserIdInput.value = "";
      showToast(`הרשימה שותפה עם ${res.member.username} ✓`);
      return;
    }
    const errors = {
      "user not found": "לא נמצא משתמש עם המזהה הזה",
      "already shared with this user": "הרשימה כבר משותפת עם המשתמש הזה",
    };
    if (errors[res.error]) showToast(errors[res.error]);
    else needsConnection(res);
  }

  async function removeMember(userId) {
    const res = await sync.request("list:remove_member", { listId: activeListId, userId });
    if (!res.ok) needsConnection(res);
  }

  function leaveList() {
    showConfirm("לעזוב את הרשימה המשותפת? לא תוכלו לראות אותה יותר.", async () => {
      const listId = activeListId;
      const res = await sync.request("list:remove_member", { listId, userId: account.userId });
      if (!res.ok) {
        if (res.error === "cannot leave your only list") showToast("זו הרשימה היחידה שלך — צרו רשימה אחרת קודם");
        else needsConnection(res);
        return;
      }
      closeSheet($.accountOverlay);
      forgetList(listId);
      switchList(ownListId());
      showToast("עזבת את הרשימה");
    });
  }

  function deleteList() {
    if (lists.length <= 1) {
      showToast("זו הרשימה היחידה שלך. אפשר לאפס אותה עם 🗑️ למעלה.", 3500);
      return;
    }
    const others = isSharedList() ? " היא תימחק גם אצל כל המשתתפים." : "";
    showConfirm(`למחוק את הרשימה "${activeListName()}" לצמיתות?${others}`, async () => {
      const listId = activeListId;
      const res = await sync.request("list:delete", { listId });
      if (!res.ok) return needsConnection(res);
      closeSheet($.accountOverlay);
      forgetList(listId);
      switchList(ownListId());
      showToast("הרשימה נמחקה");
    });
  }

  async function saveUsername() {
    const username = $.usernameInput.value.trim();
    if (!username || username === account.username) return;
    const res = await sync.request("user:rename", { username });
    if (!res.ok) return needsConnection(res);
    account.username = res.user.username;
    writeJSON(STORAGE_KEYS.account, account);
    $.usernameInput.blur();
    showToast("השם עודכן");
  }

  /* Leave account mode, keeping what's on screen as the local list. */
  function dropAccount() {
    if (sync) {
      sync.stop();
      sync.clearQueue();
      sync = null;
    }
    lists.forEach((l) => removeKey(STORAGE_KEYS.listCachePrefix + l.listId));
    [STORAGE_KEYS.account, STORAGE_KEYS.lists, STORAGE_KEYS.activeList].forEach(removeKey);
    account = null;
    lists = [];
    activeListId = null;
    listInfo = null;
    syncStatus = "offline";
    pendingCount = 0;
    saveItems(); // now writes to the local-only key
    render();
    renderAccountUI();
  }

  function logout() {
    showConfirm("להתנתק מהחשבון במכשיר הזה? כדי לחזור תצטרכו את קוד החיבור. הרשימה הנוכחית תישאר במכשיר.", () => {
      closeSheet($.accountOverlay);
      dropAccount();
      showToast("התנתקת מהחשבון");
    });
  }

  /* ---------- Invite links (?join=CODE) ---------- */
  function takeJoinCodeFromUrl() {
    const params = new URLSearchParams(location.search);
    const code = params.get("join");
    if (!code) return;
    params.delete("join");
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    if (BACKEND_URL) writeJSON(STORAGE_KEYS.pendingJoin, code);
  }

  async function processPendingJoin() {
    const code = readJSON(STORAGE_KEYS.pendingJoin, null);
    if (!code || !sync || syncStatus !== "online") return;
    removeKey(STORAGE_KEYS.pendingJoin);
    await joinByCode(code);
  }

  /* ---------- Real-time wiring ---------- */
  function startSync() {
    const client = new window.SyncClient({ url: BACKEND_URL, token: account.token });
    sync = client;
    pendingCount = client.pendingCount;
    let wakeToastShown = false;

    // Socket events about the active list: apply, persist, render.
    const forActive = (fn) => (data) => {
      if (!data || data.listId !== activeListId) return;
      fn(data);
      saveItems();
      render();
    };

    client.on("status", (status) => {
      syncStatus = status;
      renderAccountUI();
      if (status === "waking" && !wakeToastShown) {
        wakeToastShown = true;
        showToast("השרת מתעורר… הרשימה זמינה ותסתנכרן בעוד רגע", 3500);
      }
      if (status === "online") {
        processPendingJoin();
        if (isOpen($.accountOverlay) && !inviteCode) loadInviteCode();
      }
    });

    client.on("queue", (count) => {
      pendingCount = count;
      renderConnPill();
    });

    client.on("session", ({ user, lists: serverLists }) => {
      account.username = user.username;
      writeJSON(STORAGE_KEYS.account, account);
      applyLists(serverLists);
    });

    client.on("lists:updated", ({ lists: serverLists }) => applyLists(serverLists));

    client.on("list:state", ({ list, items: serverItems }) => {
      if (!list || list.listId !== activeListId || !Array.isArray(serverItems)) return;
      const before = items;
      listInfo = list;
      items = serverItems.map(fromServerItem);
      // Re-apply local changes the server hasn't confirmed yet.
      client.pendingFor(activeListId).forEach((entry) => entry.op && applyOp(entry.op));
      saveItems();
      render();
      renderAccountUI();
      if (!items.length && before.length) offerRestore(list.listId, before);
    });

    client.on("list:members", ({ listId, members, ownerId, name }) => {
      const meta = lists.find((l) => l.listId === listId);
      if (meta) {
        meta.memberCount = members.length;
        meta.name = name;
        saveLists();
      }
      if (listId !== activeListId) return;
      listInfo = { listId, ownerId, name, members };
      saveItems();
      render();
      renderAccountUI();
    });

    client.on("list:member_joined", ({ listId, user }) => {
      if (listId === activeListId && user.userId !== account.userId) showToast(`${user.username} הצטרפ/ה לרשימה 👋`, 3000);
    });

    client.on("item:added", forActive(({ listId, item }) => {
      if (client.hasPending(listId, item.itemId)) return;
      const isNew = !items.some((i) => i.id === item.itemId);
      const local = fromServerItem(item);
      applyOp({ type: "add", item: local });
      if (isNew && item.addedBy !== account.userId) {
        flashIds.add(item.itemId);
        QuickAdd.record(local, listId);
      }
    }));
    client.on("item:toggled", forActive(({ listId, itemId, isCompleted }) => {
      if (!client.hasPending(listId, itemId)) applyOp({ type: "toggle", id: itemId, bought: isCompleted });
    }));
    client.on("item:updated", forActive(({ listId, item }) => {
      if (!client.hasPending(listId, item.itemId)) applyOp({ type: "add", item: fromServerItem(item) });
    }));
    client.on("item:deleted", forActive(({ itemId }) => {
      applyOp({ type: "delete", id: itemId });
      if (editingId === itemId) {
        closeItemEditor();
        showToast("הפריט נמחק ע״י משתתף אחר");
      }
    }));
    client.on("item:cleared", forActive(({ itemIds }) => {
      applyOp({ type: "remove", ids: itemIds });
      if (itemIds.includes(editingId)) closeItemEditor();
    }));

    // Our offline add collided with the same item added by someone else: keep theirs.
    client.on("item_merged", forActive(({ fromId, item }) => {
      applyOp({ type: "delete", id: fromId });
      applyOp({ type: "add", item: fromServerItem(item) });
      if (editingId === fromId) closeItemEditor();
      showToast(`"${item.text}" כבר נוסף ע״י משתתף אחר — אוחד`, 3000);
    }));

    client.on("list:shared_notification", ({ listId, from, name }) => {
      const what = name ? `את הרשימה "${name}"` : "רשימה";
      showToast(`${from.username} שיתף/ה איתך ${what}`, 7000, { label: "פתיחה", fn: () => switchList(listId) });
    });

    client.on("list:removed", ({ listId, reason }) => {
      const wasActive = listId === activeListId;
      const name = listDisplayName(lists.find((l) => l.listId === listId));
      forgetList(listId);
      if (wasActive) switchList(ownListId());
      if (reason === "deleted") showToast(`הרשימה "${name}" נמחקה ע״י הבעלים`, 3500);
      else if (reason === "removed") showToast(`הוסרת מהרשימה "${name}"`, 3500);
      renderAccountUI();
    });

    // The active list isn't accessible anymore (e.g. removed while offline).
    client.on("join_failed", ({ listId }) => {
      if (listId !== activeListId) return;
      forgetList(listId);
      const fallback = ownListId();
      if (fallback && fallback !== listId) switchList(fallback);
    });

    // Server refused a queued change: re-sync so the screen matches the truth.
    client.on("op_rejected", () => client.join());

    // Fired only after the server's database confirmed the token is unknown or blocked
    // (INVALID_TOKEN / USER_BANNED). Cold starts, timeouts and DB hiccups never get here:
    // the client stays in "connecting"/"waking" and keeps the account and outbox.
    client.on("auth_error", ({ code } = {}) => {
      dropAccount();
      if (code === "USER_BANNED") {
        showToast("החשבון הזה הושבת. הרשימה נשמרה במכשיר.", 6000);
        return;
      }
      showToast("החשבון לא נמצא בשרת. הרשימה נשמרה במכשיר — אפשר ליצור חשבון חדש.", 6000);
      openWelcome("החשבון הקודם לא נמצא בשרת. צרו חשבון חדש כדי להמשיך לסנכרן — הפריטים שעל המסך יישמרו.");
    });

    client.setActiveList(activeListId);
    return client;
  }

  /*
   * The server answered with an empty list while this device still had items. That's
   * either a clear from another device or lost server data; either way, never drop
   * the device's copy silently: offer to put it back.
   */
  function offerRestore(listId, snapshot) {
    const n = snapshot.length;
    showToast(`הרשימה ריקה בשרת (אולי נוקתה ממכשיר אחר). לשחזר ${n} פריטים מהמכשיר?`, 12000, {
      label: "שחזור",
      fn: () => {
        if (listId !== activeListId) return;
        snapshot.forEach((item) => {
          if (items.some((i) => i.id === item.id)) return;
          commit({ type: "add", item: { ...item, bought: false } });
          if (item.bought) commit({ type: "toggle", id: item.id, bought: true });
        });
        showToast(`שוחזרו ${n} פריטים`);
      },
    });
  }

  function applyLists(serverLists) {
    // Every account always has at least one list, so an empty array is a bad answer, not "no lists".
    if (!Array.isArray(serverLists) || !serverLists.length) return;
    lists = serverLists;
    saveLists();
    if (!lists.some((l) => l.listId === activeListId)) {
      switchList(ownListId());
    } else {
      renderAccountUI();
    }
  }

  /* ---------- Welcome / sign-up ---------- */
  const WELCOME_DEFAULT = "צרו חשבון כדי לסנכרן את הרשימה בין מכשירים ולשתף אותה בזמן אמת עם בני הבית. הפריטים שכבר ברשימה יישמרו.";

  function openWelcome(message) {
    $.welcomeText.textContent = message || WELCOME_DEFAULT;
    setWelcomeStatus("");
    $.registerPanel.classList.remove("hidden");
    $.linkPanel.classList.add("hidden");
    openSheet($.welcomeOverlay);
  }
  function closeWelcome() {
    closeSheet($.welcomeOverlay);
    writeJSON(STORAGE_KEYS.welcomeSeen, true);
  }
  function setWelcomeStatus(text, isError) {
    $.welcomeStatus.textContent = text;
    $.welcomeStatus.classList.toggle("hidden", !text);
    $.welcomeStatus.classList.toggle("error", !!isError);
  }
  function setWelcomeBusy(busy) {
    [$.registerBtn, $.linkDeviceBtn, $.welcomeNameInput, $.linkCodeInput].forEach((x) => { x.disabled = busy; });
  }

  /* Render's free tier can take ~50s to wake up, so allow a long timeout. */
  async function backendFetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const slow = setTimeout(() => setWelcomeStatus("השרת מתעורר, זה יכול לקחת עד דקה…"), 3000);
    try {
      const res = await fetch(BACKEND_URL + path, { ...options, signal: controller.signal });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
      clearTimeout(slow);
    }
  }

  async function registerAccount() {
    const username = $.welcomeNameInput.value.trim();
    if (!username) {
      setWelcomeStatus("הזינו שם", true);
      return;
    }
    setWelcomeBusy(true);
    setWelcomeStatus("יוצר חשבון…");
    try {
      const res = await backendFetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      if (!res.ok) throw new Error(res.body.error || "register failed");
      const { user, token, listId } = res.body;

      const localItems = items.slice();
      account = { userId: user.userId, username: user.username, token };
      writeJSON(STORAGE_KEYS.account, account);
      lists = [{ listId, ownerId: user.userId, ownerName: user.username, name: null, memberCount: 1, remaining: 0 }];
      saveLists();
      setActiveList(listId);
      listInfo = { listId, ownerId: user.userId, name: null, members: [{ userId: user.userId, username: user.username }] };
      items = localItems.map((i) => ({ ...i, addedBy: user.userId }));
      saveItems();

      // Upload what was already on the device, then connect.
      sync = startSync();
      items.forEach((item) => {
        const add = { type: "add", item };
        sync.send(...toWire(add, listId), add);
        if (item.bought) {
          const toggle = { type: "toggle", id: item.id, bought: true };
          sync.send(...toWire(toggle, listId), toggle);
        }
      });
      sync.start();

      closeWelcome();
      render();
      renderAccountUI();
      showToast(`ברוכים הבאים, ${user.username}! 🎉`);
    } catch (e) {
      setWelcomeStatus(e.name === "AbortError" ? "השרת לא הגיב. נסו שוב בעוד רגע." : "יצירת החשבון נכשלה. בדקו את החיבור ונסו שוב.", true);
    } finally {
      setWelcomeBusy(false);
    }
  }

  async function linkDevice() {
    const token = $.linkCodeInput.value.trim();
    if (!token) {
      setWelcomeStatus("הזינו קוד חיבור", true);
      return;
    }
    setWelcomeBusy(true);
    setWelcomeStatus("מתחבר…");
    try {
      const res = await backendFetch("/api/me", { headers: { Authorization: "Bearer " + token } });
      if (res.status === 401) {
        setWelcomeStatus("קוד החיבור לא תקין", true);
        return;
      }
      if (res.status === 503) {
        setWelcomeStatus("השרת עדיין עולה. נסו שוב בעוד כמה שניות.", true);
        return;
      }
      if (!res.ok) throw new Error("link failed");
      const { user, lists: serverLists } = res.body;

      // Keep this device's local-only list untouched under its own key.
      account = { userId: user.userId, username: user.username, token };
      writeJSON(STORAGE_KEYS.account, account);
      lists = serverLists;
      saveLists();
      setActiveList(ownListId());
      loadListCache(activeListId);
      rowRefs.forEach((ref) => ref.row.remove());
      rowRefs.clear();

      sync = startSync();
      sync.start();

      closeWelcome();
      render();
      renderAccountUI();
      showToast(`מחובר כ-${user.username} ✓`);
    } catch (e) {
      setWelcomeStatus(e.name === "AbortError" ? "השרת לא הגיב. נסו שוב בעוד רגע." : "החיבור נכשל. בדקו את החיבור לאינטרנט ונסו שוב.", true);
    } finally {
      setWelcomeBusy(false);
    }
  }

  /* ---------- Event wiring ---------- */
  $.addBtn.addEventListener("click", addFromInput);
  $.newItemInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addFromInput(); });
  $.newItemInput.addEventListener("focus", renderQuickStrip);
  $.newItemInput.addEventListener("input", renderQuickStrip);
  $.newItemInput.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== $.newItemInput) $.quickStrip.classList.add("hidden");
  }, 150));

  $.searchInput.addEventListener("input", () => {
    searchQuery = $.searchInput.value;
    $.clearSearchBtn.classList.toggle("hidden", !searchQuery);
    render();
  });
  $.clearSearchBtn.addEventListener("click", () => {
    $.searchInput.value = "";
    searchQuery = "";
    $.clearSearchBtn.classList.add("hidden");
    render();
  });

  $.resetAllBtn.addEventListener("click", resetAll);

  // Layout
  $.layoutToggleBtn.addEventListener("click", () => {
    setViewMode(viewMode === "store" ? "list" : "store");
    showToast(viewMode === "store" ? "🧭 מסודר לפי המסלול בסופר" : "📋 תצוגת רשימה רגילה");
  });
  const openOrder = () => { renderOrderList(); openSheet($.orderOverlay); };
  $.orderBtn.addEventListener("click", openOrder);
  wireSheet($.orderOverlay, $.closeOrderBtn);
  $.resetOrderBtn.addEventListener("click", () => {
    storeOrder = Categories.DEFAULT_STORE_ORDER.slice();
    writeJSON(STORAGE_KEYS.storeOrder, storeOrder);
    chipSignature = "";
    renderOrderList();
    render();
  });

  // Item sheet
  wireSheet($.itemOverlay, $.closeItemBtn, () => { editingId = null; });
  $.saveItemBtn.addEventListener("click", saveItemEditor);
  $.deleteItemBtn.addEventListener("click", () => {
    const id = editingId;
    closeItemEditor();
    if (id) deleteItem(id);
  });
  $.qtyMinusBtn.addEventListener("click", () => stepQuantity(-1));
  $.qtyPlusBtn.addEventListener("click", () => stepQuantity(1));
  [$.itemNameInput, $.itemQtyInput].forEach((input) => {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveItemEditor(); });
  });

  // Quick add
  $.quickAddBtn.addEventListener("click", () => {
    $.quickSearchInput.value = "";
    renderQuickList();
    openSheet($.quickOverlay);
  });
  wireSheet($.quickOverlay, $.closeQuickBtn);
  $.quickSearchInput.addEventListener("input", renderQuickList);

  // Templates
  const openTemplates = () => {
    renderTemplatesList();
    openSheet($.templatesOverlay);
  };
  $.templatesBtn.addEventListener("click", openTemplates);
  wireSheet($.templatesOverlay, $.closeTemplatesBtn);
  $.saveTemplateBtn.addEventListener("click", saveCurrentAsTemplate);

  // Lists
  $.listSwitcherBtn.addEventListener("click", openListsSheet);
  wireSheet($.listsOverlay, $.closeListsBtn);
  $.createListBtn.addEventListener("click", createList);
  $.newListInput.addEventListener("keydown", (e) => { if (e.key === "Enter") createList(); });
  $.joinCodeBtn.addEventListener("click", () => joinByCode($.joinCodeInput.value));
  $.joinCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinByCode($.joinCodeInput.value); });

  // Connection pill: explain, and retry right away.
  $.connPill.addEventListener("click", () => {
    showToast($.connPill.title, 3500);
    if (sync) sync.kick();
  });

  // Share & account
  $.enableSyncBtn.addEventListener("click", () => openWelcome());
  $.copyFullIdBtn.addEventListener("click", () => copyText(account.userId, "מזהה המשתמש הועתק"));
  $.membersBtn.addEventListener("click", openAccountModal);
  wireSheet($.accountOverlay, $.closeAccountBtn);
  $.saveListNameBtn.addEventListener("click", saveListName);
  $.listNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveListName(); });
  $.shareLinkBtn.addEventListener("click", shareInviteLink);
  $.copyCodeBtn.addEventListener("click", () => inviteCode && copyText(formatCode(inviteCode), "קוד ההזמנה הועתק"));
  $.regenCodeBtn.addEventListener("click", () => {
    showConfirm("ליצור קוד הזמנה חדש? הקוד והקישור הקודמים יפסיקו לעבוד (מי שכבר הצטרף יישאר).", () => loadInviteCode(true));
  });
  $.shareBtn.addEventListener("click", shareList);
  $.shareUserIdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") shareList(); });
  $.leaveListBtn.addEventListener("click", leaveList);
  $.deleteListBtn.addEventListener("click", deleteList);
  $.saveUsernameBtn.addEventListener("click", saveUsername);
  $.usernameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveUsername(); });
  $.showLinkCodeBtn.addEventListener("click", () => {
    $.linkCode.textContent = account.token;
    $.linkCodeRow.classList.remove("hidden");
    $.showLinkCodeBtn.classList.add("hidden");
  });
  $.copyLinkCodeBtn.addEventListener("click", () => copyText(account.token, "קוד החיבור הועתק — אל תשתפו אותו"));
  $.logoutBtn.addEventListener("click", logout);

  // Profile tab
  $.profileSyncBtn.addEventListener("click", () => openWelcome());
  $.profileListsBtn.addEventListener("click", openListsSheet);
  $.profileTemplatesBtn.addEventListener("click", openTemplates);
  $.profileOrderBtn.addEventListener("click", openOrder);
  $.syncNowBtn.addEventListener("click", () => {
    if (!sync) return;
    sync.kick();
    sync.flush();
    if (syncStatus === "online") sync.join();
    showToast(syncStatus === "online" ? "מסתנכרן…" : "מנסה להתחבר לשרת…");
  });

  // Android hardware back: close the top sheet, then return to the Lists tab, then exit.
  const appPlugin = Native.plugin("App");
  if (Native.isApp && appPlugin) {
    appPlugin.addListener("backButton", () => {
      const open = Array.from(document.querySelectorAll(".modal-overlay")).reverse().find(isOpen);
      if (open === $.welcomeOverlay) closeWelcome();
      else if (open) open.click(); // every other sheet closes on a backdrop click
      else if (activeTab !== "lists") switchTab("lists");
      else appPlugin.exitApp();
    });
  }

  // Welcome
  $.closeWelcomeBtn.addEventListener("click", closeWelcome);
  $.skipWelcomeBtn.addEventListener("click", closeWelcome);
  $.registerBtn.addEventListener("click", registerAccount);
  $.welcomeNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") registerAccount(); });
  $.linkDeviceBtn.addEventListener("click", linkDevice);
  $.linkCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") linkDevice(); });
  $.showLinkPanelBtn.addEventListener("click", () => {
    setWelcomeStatus("");
    $.registerPanel.classList.add("hidden");
    $.linkPanel.classList.remove("hidden");
  });
  $.showRegisterPanelBtn.addEventListener("click", () => {
    setWelcomeStatus("");
    $.linkPanel.classList.add("hidden");
    $.registerPanel.classList.remove("hidden");
  });

  /* ---------- Init ---------- */
  takeJoinCodeFromUrl();
  loadState();
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  QuickAdd.seed(items, historyKey());
  AIChat.init({
    backendUrl: BACKEND_URL,
    getToken: () => (account ? account.token : null),
    getListNames: () => items.filter((i) => !i.bought).map((i) => i.name),
    isInList: (name) => !!findOpen(name),
    // Prefer this device's own categorizer (it knows the user's corrections); the model's guess fills gaps.
    addItem: (spec) => !!addNamed({
      name: spec.name,
      quantity: spec.quantity || "",
      category: Categories.categorize(spec.name) === "misc" && Categories.MAP[spec.category] ? spec.category : undefined,
    }),
    showToast,
    onNeedAccount: () => openWelcome("צרו חשבון כדי להשתמש בעוזר החכם ולסנכרן את הרשימות. הפריטים שכבר ברשימה יישמרו."),
  });
  $.appVersion.textContent = `רשימת קניות ${(window.APP_CONFIG && window.APP_CONFIG.APP_VERSION) || ""}${Native.isApp ? " · Android" : ""}`;
  setViewMode(viewMode);
  renderAccountUI();
  setupVoice();

  if (account) {
    sync = startSync();
    sync.start();
  } else if (BACKEND_URL && readJSON(STORAGE_KEYS.pendingJoin, null)) {
    openWelcome("הוזמנת להצטרף לרשימת קניות משותפת! 🎉 צרו חשבון (או התחברו) כדי להצטרף.");
  } else if (BACKEND_URL && !readJSON(STORAGE_KEYS.welcomeSeen, false)) {
    openWelcome();
  }

  // The Android app ships its files inside the APK; updates come from the store, not a service worker.
  if (window.PWAUpdate && !Native.isApp) window.PWAUpdate.register("sw.js");
})();
