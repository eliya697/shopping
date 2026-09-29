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
    welcomeSeen: "shoppingList.welcomeSeen.v1",
  };

  const BACKEND_URL = ((window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || "").replace(/\/+$/, "");

  const CATEGORIES = [
    { key: "produce", label: "ירקות ופירות", emoji: "🥦" },
    { key: "dairy", label: "מוצרי חלב", emoji: "🧀" },
    { key: "meat", label: "בשר ודגים", emoji: "🍗" },
    { key: "pantry", label: "מזווה", emoji: "🥫" },
    { key: "cleaning", label: "ניקיון", emoji: "🧼" },
    { key: "misc", label: "שונות", emoji: "🛒" },
  ];
  const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

  const KEYWORD_MAP = {
    produce: ["עגבני", "מלפפון", "חסה", "גזר", "תפוח אדמה", "תפוח", "בננה", "תפוז", "לימון", "בצל", "שום", "בטטה", "פלפל", "קישוא", "כרוב", "ברוקולי", "אבוקדו", "ענבים", "תות", "אבטיח", "מלון", "פטרוזיליה", "כוסברה", "נענע", "שומר", "פטריות", "תרד", "סלרי"],
    dairy: ["חלב", "גבינה", "קוטג", "יוגורט", "חמאה", "שמנת", "ביצים", "לבן", "גבינה לבנה", "יוגורט"],
    meat: ["עוף", "בקר", "הודו", "קציצות", "נקניק", "סלמון", "טונה טרי", "דג", "פילה", "שניצל", "כבד", "המבורגר", "סטייק", "כרעיים", "חזה עוף"],
    pantry: ["אורז", "פסטה", "קמח", "סוכר", "שמן", "מלח", "קפה", "תה", "שוקולד", "ביסקוויט", "דגני בוקר", "עדשים", "חומוס", "טחינה", "פתיתים", "קורנפלור", "סויה", "רסק עגבניות", "שימורים", "מים", "מיץ", "במבה", "קטניות", "פריכיות", "דבש", "ריבה"],
    cleaning: ["סבון", "אקונומיקה", "נייר טואלט", "מגבונים", "שקיות אשפה", "מרכך", "אבקת כביסה", "נוזל כלים", "מטהר", "ספריי", "מגבת נייר", "כלור"],
  };

  const DEFAULT_TEMPLATE = {
    "קניות שבועיות בסיסיות": [
      { name: "חלב", category: "dairy" },
      { name: "ביצים", category: "dairy" },
      { name: "לחם", category: "pantry" },
      { name: "עגבניות", category: "produce" },
      { name: "מלפפונים", category: "produce" },
      { name: "בננות", category: "produce" },
      { name: "חזה עוף", category: "meat" },
      { name: "נייר טואלט", category: "cleaning" },
    ],
  };

  const STATUS_TEXT = {
    online: "מחובר — שינויים מסתנכרנים בזמן אמת",
    connecting: "מתחבר לשרת…",
    waking: "השרת מתעורר (יכול לקחת עד דקה)…",
    offline: "לא מחובר — השינויים יישמרו ויסתנכרנו כשהחיבור יחזור",
  };

  /* ---------- State ---------- */
  let items = [];
  let templates = {};
  let activeFilter = "all";
  let searchQuery = "";

  let account = null; // { userId, username, token }
  let lists = []; // lists I'm a member of: { listId, ownerId, ownerName, memberCount }
  let activeListId = null;
  let listInfo = null; // { listId, ownerId, members: [{ userId, username }] }
  let sync = null;
  let syncStatus = "offline";
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

  function loadState() {
    templates = readJSON(STORAGE_KEYS.templates, null) || { ...DEFAULT_TEMPLATE };
    account = BACKEND_URL ? readJSON(STORAGE_KEYS.account, null) : null;
    if (account) {
      lists = readJSON(STORAGE_KEYS.lists, []);
      activeListId = readJSON(STORAGE_KEYS.activeList, null) || (lists[0] && lists[0].listId);
      loadListCache(activeListId);
    } else {
      items = readJSON(STORAGE_KEYS.items, []);
    }
  }

  function loadListCache(listId) {
    const cached = listId ? readJSON(STORAGE_KEYS.listCachePrefix + listId, null) : null;
    items = (cached && cached.items) || [];
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

  /* ---------- DOM refs ---------- */
  const el = (id) => document.getElementById(id);
  const listContainer = el("listContainer");
  const emptyState = el("emptyState");
  const subtitle = el("subtitle");
  const filterRow = el("filterRow");
  const boughtBar = el("boughtBar");
  const boughtBarText = el("boughtBarText");
  const searchInput = el("searchInput");
  const clearSearchBtn = el("clearSearchBtn");
  const newItemInput = el("newItemInput");
  const addBtn = el("addBtn");
  const themeToggleBtn = el("themeToggleBtn");
  const clearBoughtBtn = el("clearBoughtBtn");
  const resetAllBtn = el("resetAllBtn");
  const templatesBtn = el("templatesBtn");
  const templatesOverlay = el("templatesOverlay");
  const closeTemplatesBtn = el("closeTemplatesBtn");
  const templateNameInput = el("templateNameInput");
  const saveTemplateBtn = el("saveTemplateBtn");
  const templatesList = el("templatesList");
  const confirmOverlay = el("confirmOverlay");
  const confirmMessage = el("confirmMessage");
  const confirmOkBtn = el("confirmOkBtn");
  const confirmCancelBtn = el("confirmCancelBtn");
  const toast = el("toast");
  const toastText = el("toastText");
  const toastAction = el("toastAction");

  const accountRow = el("accountRow");
  const enableSyncBtn = el("enableSyncBtn");
  const idBadge = el("idBadge");
  const syncDot = el("syncDot");
  const userIdShort = el("userIdShort");
  const copyIdBtn = el("copyIdBtn");
  const membersBtn = el("membersBtn");
  const membersText = el("membersText");

  const accountOverlay = el("accountOverlay");
  const closeAccountBtn = el("closeAccountBtn");
  const usernameInput = el("usernameInput");
  const saveUsernameBtn = el("saveUsernameBtn");
  const fullUserId = el("fullUserId");
  const copyFullIdBtn = el("copyFullIdBtn");
  const syncStatusText = el("syncStatusText");
  const shareSection = el("shareSection");
  const shareUserIdInput = el("shareUserIdInput");
  const shareBtn = el("shareBtn");
  const sharedWithMeSection = el("sharedWithMeSection");
  const sharedByText = el("sharedByText");
  const leaveListBtn = el("leaveListBtn");
  const membersTitle = el("membersTitle");
  const membersList = el("membersList");
  const listsSection = el("listsSection");
  const listsList = el("listsList");
  const linkCodeRow = el("linkCodeRow");
  const linkCode = el("linkCode");
  const copyLinkCodeBtn = el("copyLinkCodeBtn");
  const showLinkCodeBtn = el("showLinkCodeBtn");
  const logoutBtn = el("logoutBtn");

  const welcomeOverlay = el("welcomeOverlay");
  const closeWelcomeBtn = el("closeWelcomeBtn");
  const welcomeText = el("welcomeText");
  const registerPanel = el("registerPanel");
  const linkPanel = el("linkPanel");
  const welcomeNameInput = el("welcomeNameInput");
  const registerBtn = el("registerBtn");
  const showLinkPanelBtn = el("showLinkPanelBtn");
  const showRegisterPanelBtn = el("showRegisterPanelBtn");
  const linkCodeInput = el("linkCodeInput");
  const linkDeviceBtn = el("linkDeviceBtn");
  const welcomeStatus = el("welcomeStatus");
  const skipWelcomeBtn = el("skipWelcomeBtn");

  /* ---------- Toast ---------- */
  let toastTimer = null;
  let toastActionFn = null;
  function showToast(msg, ms = 2200, action = null) {
    toastText.textContent = msg;
    toastActionFn = action ? action.fn : null;
    toastAction.textContent = action ? action.label : "";
    toastAction.classList.toggle("hidden", !action);
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), ms);
  }
  toastAction.addEventListener("click", () => {
    const fn = toastActionFn;
    toast.classList.add("hidden");
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
    confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmOverlay.classList.remove("hidden");
  }
  function hideConfirm() {
    confirmOverlay.classList.add("hidden");
    confirmCallback = null;
  }
  confirmOkBtn.addEventListener("click", () => {
    const cb = confirmCallback;
    hideConfirm();
    if (cb) cb();
  });
  confirmCancelBtn.addEventListener("click", hideConfirm);
  confirmOverlay.addEventListener("click", (e) => { if (e.target === confirmOverlay) hideConfirm(); });

  /* ---------- Dark mode ---------- */
  function getEffectiveTheme() {
    const stored = document.documentElement.getAttribute("data-theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function updateThemeToggleIcon() {
    const isDark = getEffectiveTheme() === "dark";
    themeToggleBtn.textContent = isDark ? "☀️" : "🌙";
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute("content", isDark ? "#101214" : "#0f766e");
  }
  function toggleTheme() {
    const next = getEffectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(STORAGE_KEYS.theme, next); } catch (e) {}
    updateThemeToggleIcon();
  }
  themeToggleBtn.addEventListener("click", toggleTheme);
  updateThemeToggleIcon();

  /* ---------- Category suggestion ---------- */
  function suggestCategory(name) {
    const n = name.trim().toLowerCase();
    if (!n) return "misc";
    for (const [cat, words] of Object.entries(KEYWORD_MAP)) {
      for (const w of words) {
        if (n.includes(w)) return cat;
      }
    }
    return "misc";
  }

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
      case "qty": {
        const item = items.find((i) => i.id === op.id);
        if (item) item.qty = op.qty;
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
      case "add":
        return ["item:add", { listId, item: { itemId: op.item.id, text: op.item.name, category: op.item.category, qty: op.item.qty } }];
      case "toggle":
        return ["item:toggle", { listId, itemId: op.id, isCompleted: op.bought }];
      case "qty":
        return ["item:update_qty", { listId, itemId: op.id, qty: op.qty }];
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
      category: s.category,
      bought: !!s.isCompleted,
      qty: s.qty || 1,
      createdAt: s.createdAt,
      addedBy: s.addedBy,
    };
  }

  /* ---------- Rendering: filter chips ---------- */
  const chipEls = new Map();
  function buildFilterRow() {
    const chips = [{ key: "all", label: "הכל", emoji: "📋" }, ...CATEGORIES];
    chips.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "chip";
      btn.textContent = `${c.emoji} ${c.label}`;
      btn.addEventListener("click", () => {
        activeFilter = activeFilter === c.key ? "all" : c.key;
        render();
      });
      chipEls.set(c.key, btn);
      filterRow.appendChild(btn);
    });
  }
  function updateFilterRow() {
    chipEls.forEach((btn, key) => btn.classList.toggle("active", key === activeFilter));
  }

  /* ---------- Rendering: list (keyed, patches the DOM in place) ---------- */
  const rowRefs = new Map(); // item id -> { row, content, circle, nameEl, badge, qtyVal }
  const boughtLabel = document.createElement("div");
  boughtLabel.className = "section-label";
  boughtLabel.textContent = "נקנו";

  function getVisibleItems() {
    let visible = items;
    if (activeFilter !== "all") visible = visible.filter((i) => i.category === activeFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      visible = visible.filter((i) => i.name.toLowerCase().includes(q));
    }
    const unbought = visible.filter((i) => !i.bought);
    const bought = visible.filter((i) => i.bought);
    return [...unbought, ...bought];
  }

  function memberName(userId) {
    const m = listInfo && listInfo.members.find((x) => x.userId === userId);
    return m ? m.username : null;
  }

  function render() {
    updateFilterRow();

    const visible = getVisibleItems();
    const totalCount = items.length;
    const remaining = items.filter((i) => !i.bought).length;
    const boughtCount = totalCount - remaining;
    subtitle.textContent = totalCount === 0 ? "הרשימה ריקה" : `${remaining} מתוך ${totalCount} נותרו לקנייה`;

    if (boughtCount > 0) {
      boughtBarText.textContent = `✓ ${boughtCount} פריטים נקנו`;
      boughtBar.classList.remove("hidden");
    } else {
      boughtBar.classList.add("hidden");
    }

    const desired = [];
    let labelShown = false;
    visible.forEach((item) => {
      if (item.bought && !labelShown) {
        desired.push(boughtLabel);
        labelShown = true;
      }
      desired.push(upsertRow(item).row);
    });

    // Drop rows that are no longer visible; animate only real deletions.
    const keep = new Set(desired);
    const existingIds = new Set(items.map((i) => i.id));
    rowRefs.forEach((ref, id) => {
      if (keep.has(ref.row)) return;
      rowRefs.delete(id);
      if (existingIds.has(id)) ref.row.remove();
      else retireRow(ref.row);
    });
    if (!labelShown) boughtLabel.remove();

    // Put nodes in order, moving only the ones that are out of place.
    let cursor = listContainer.firstChild;
    desired.forEach((node) => {
      while (cursor && cursor.classList.contains("removing")) cursor = cursor.nextSibling;
      if (cursor === node) cursor = node.nextSibling;
      else listContainer.insertBefore(node, cursor);
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
    emptyState.classList.toggle("hidden", !isEmpty);
    listContainer.classList.toggle("hidden", isEmpty);
    if (isEmpty) {
      emptyState.querySelector("p").textContent = totalCount === 0 ? "הרשימה ריקה" : "לא נמצאו פריטים";
      emptyState.querySelector("span").textContent = totalCount === 0 ? "הוסיפו פריט ראשון בתחתית המסך" : "נסו לשנות את החיפוש או הסינון";
    }
  }

  function retireRow(row) {
    row.style.maxHeight = row.offsetHeight + "px";
    void row.offsetHeight; // commit the start height so the collapse animates
    row.classList.add("removing");
    row.style.maxHeight = "0px";
    setTimeout(() => row.remove(), 260);
  }

  function upsertRow(item) {
    let ref = rowRefs.get(item.id);
    if (!ref) {
      ref = buildItemRow(item.id);
      rowRefs.set(item.id, ref);
    }
    const cat = CAT_MAP[item.category] || CAT_MAP.misc;
    const shared = listInfo && listInfo.members.length > 1;
    const adder = shared && item.addedBy && account && item.addedBy !== account.userId ? memberName(item.addedBy) : null;

    ref.circle.classList.toggle("checked", !!item.bought);
    ref.nameEl.classList.toggle("bought", !!item.bought);
    if (ref.nameEl.textContent !== item.name) ref.nameEl.textContent = item.name;
    const badgeText = `${cat.emoji} ${cat.label}` + (adder ? ` · ${adder}` : "");
    if (ref.badge.textContent !== badgeText) ref.badge.textContent = badgeText;
    const qty = String(item.qty || 1);
    if (ref.qtyVal.textContent !== qty) ref.qtyVal.textContent = qty;
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

    const main = document.createElement("div");
    main.className = "item-main";
    const nameEl = document.createElement("div");
    nameEl.className = "item-name";
    const badge = document.createElement("div");
    badge.className = "item-cat-badge";
    main.appendChild(nameEl);
    main.appendChild(badge);

    const qtyControl = document.createElement("div");
    qtyControl.className = "qty-control";
    const minusBtn = document.createElement("button");
    minusBtn.className = "qty-btn";
    minusBtn.textContent = "–";
    minusBtn.addEventListener("click", (e) => { e.stopPropagation(); changeQty(id, -1); });
    const qtyVal = document.createElement("span");
    qtyVal.className = "qty-val";
    const plusBtn = document.createElement("button");
    plusBtn.className = "qty-btn";
    plusBtn.textContent = "+";
    plusBtn.addEventListener("click", (e) => { e.stopPropagation(); changeQty(id, 1); });
    qtyControl.appendChild(minusBtn);
    qtyControl.appendChild(qtyVal);
    qtyControl.appendChild(plusBtn);

    content.appendChild(circle);
    content.appendChild(main);
    content.appendChild(qtyControl);

    row.appendChild(deleteAction);
    row.appendChild(content);

    attachSwipeToDelete(content, id);
    return { row, content, circle, nameEl, badge, qtyVal };
  }

  /* ---------- Swipe to delete ---------- */
  function attachSwipeToDelete(content, id) {
    let startX = 0;
    let currentX = 0;
    let dragging = false;
    const threshold = 70;

    function onDown(e) {
      dragging = true;
      startX = (e.touches ? e.touches[0].clientX : e.clientX);
      content.style.transition = "none";
    }
    function onMove(e) {
      if (!dragging) return;
      currentX = (e.touches ? e.touches[0].clientX : e.clientX) - startX;
      if (currentX > 0) currentX = 0; // only allow leftward drag
      content.style.transform = `translateX(${currentX}px)`;
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      content.style.transition = "transform 0.18s ease";
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
  }

  /* ---------- Actions ---------- */
  function newItem(name, category) {
    return {
      id: uid(),
      name,
      category,
      bought: false,
      qty: 1,
      createdAt: Date.now(),
      addedBy: account ? account.userId : undefined,
    };
  }

  function addItem() {
    const rawName = newItemInput.value.trim();
    if (!rawName) return;
    const category = suggestCategory(rawName);

    const existing = items.find(
      (i) => !i.bought && i.name.trim().toLowerCase() === rawName.toLowerCase()
    );
    if (existing) {
      showToast(`"${rawName}" כבר ברשימה`);
      const rowEl = listContainer.querySelector(`[data-id="${existing.id}"] .item-content`);
      if (rowEl) {
        rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
        rowEl.classList.add("pulse");
        setTimeout(() => rowEl.classList.remove("pulse"), 500);
      }
      return;
    }

    newItemInput.value = "";
    commit({ type: "add", item: newItem(rawName, category) });
  }

  function toggleBought(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    commit({ type: "toggle", id, bought: !item.bought });
  }

  function changeQty(id, delta) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const qty = Math.min(99, Math.max(1, (item.qty || 1) + delta));
    if (qty !== item.qty) commit({ type: "qty", id, qty });
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

  /* ---------- Templates ---------- */
  function renderTemplatesList() {
    templatesList.innerHTML = "";
    const names = Object.keys(templates);
    if (names.length === 0) {
      const empty = document.createElement("div");
      empty.className = "templates-empty";
      empty.textContent = "אין תבניות שמורות עדיין";
      templatesList.appendChild(empty);
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
      templatesList.appendChild(card);
    });
  }

  function saveCurrentAsTemplate() {
    const name = templateNameInput.value.trim();
    if (!name) {
      showToast("יש להזין שם לתבנית");
      return;
    }
    if (items.length === 0) {
      showToast("הרשימה ריקה, אין מה לשמור");
      return;
    }
    templates[name] = items.map((i) => ({ name: i.name, category: i.category }));
    saveTemplates();
    templateNameInput.value = "";
    renderTemplatesList();
    showToast(`התבנית "${name}" נשמרה`);
  }

  function loadTemplate(name) {
    const templateItems = templates[name];
    if (!templateItems) return;
    let addedCount = 0;
    templateItems.forEach((ti) => {
      const exists = items.some(
        (i) => !i.bought && i.name.trim().toLowerCase() === ti.name.trim().toLowerCase()
      );
      if (!exists) {
        commit({ type: "add", item: newItem(ti.name, ti.category) });
        addedCount++;
      }
    });
    templatesOverlay.classList.add("hidden");
    showToast(addedCount > 0 ? `${addedCount} פריטים נוספו מהתבנית` : "כל הפריטים כבר ברשימה");
  }

  /* ================================================================
   * Accounts, sharing & real-time sync
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
      render();
    }
    if (sync) sync.setActiveList(listId);
    renderAccountUI();
  }

  /* ---------- Header badge ---------- */
  function renderAccountUI() {
    accountRow.classList.toggle("hidden", !BACKEND_URL);
    if (!BACKEND_URL) return;

    enableSyncBtn.classList.toggle("hidden", !!account);
    idBadge.classList.toggle("hidden", !account);
    membersBtn.classList.toggle("hidden", !account);
    if (!account) return;

    userIdShort.textContent = account.userId.slice(0, 8) + "…";
    syncDot.className = "sync-dot " + syncStatus;
    syncDot.title = STATUS_TEXT[syncStatus];

    const meta = activeListMeta();
    const memberCount = listInfo ? listInfo.members.length : meta ? meta.memberCount : 1;
    if (!isOwnList()) {
      const ownerName = (meta && meta.ownerName) || (listInfo && memberName(listInfo.ownerId)) || "";
      membersText.textContent = `הרשימה של ${ownerName}`;
    } else if (memberCount > 1) {
      membersText.textContent = `משותף עם ${memberCount - 1}`;
      membersBtn.title = memberCount === 2 ? "משותף עם משתמש 1" : `משותף עם ${memberCount - 1} משתמשים`;
    } else {
      membersText.textContent = "שיתוף";
    }

    if (!accountOverlay.classList.contains("hidden")) renderAccountModal();
  }

  /* ---------- Share / account modal ---------- */
  function renderAccountModal() {
    if (!account) return;
    if (document.activeElement !== usernameInput) usernameInput.value = account.username;
    fullUserId.textContent = account.userId;
    syncStatusText.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "sync-dot " + syncStatus;
    syncStatusText.appendChild(dot);
    syncStatusText.appendChild(document.createTextNode(STATUS_TEXT[syncStatus]));

    const own = isOwnList();
    const meta = activeListMeta();
    shareSection.classList.toggle("hidden", !own);
    sharedWithMeSection.classList.toggle("hidden", own);
    if (!own) {
      const ownerName = (meta && meta.ownerName) || (listInfo && memberName(listInfo.ownerId)) || "";
      sharedByText.textContent = `את הרשימה הזו שיתף/ה איתך ${ownerName}. שינויים שתעשו יופיעו אצל כל המשתתפים.`;
    }

    // Members
    membersList.innerHTML = "";
    const members = listInfo ? listInfo.members : [];
    membersTitle.textContent = `משתתפים ברשימה (${members.length || 1})`;
    members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "acc-row";
      const main = document.createElement("div");
      main.className = "acc-row-main";
      const title = document.createElement("div");
      title.className = "acc-row-title";
      title.textContent = m.username + (m.userId === account.userId ? " (את/ה)" : "");
      const sub = document.createElement("div");
      sub.className = "acc-row-sub";
      sub.dir = "ltr";
      sub.textContent = m.userId.slice(0, 8) + "…";
      main.appendChild(title);
      main.appendChild(sub);
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
      membersList.appendChild(row);
    });
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "templates-empty";
      empty.textContent = "הפרטים ייטענו כשהחיבור לשרת יתחדש";
      membersList.appendChild(empty);
    }

    // Lists switcher (only useful once something was shared with me)
    listsSection.classList.toggle("hidden", lists.length < 2);
    listsList.innerHTML = "";
    lists.forEach((l) => {
      const btn = document.createElement("button");
      btn.className = "acc-row" + (l.listId === activeListId ? " active" : "");
      const main = document.createElement("div");
      main.className = "acc-row-main";
      const title = document.createElement("div");
      title.className = "acc-row-title";
      title.textContent = l.ownerId === account.userId ? "הרשימה שלי" : `הרשימה של ${l.ownerName}`;
      const sub = document.createElement("div");
      sub.className = "acc-row-sub";
      sub.textContent = l.memberCount > 1 ? `${l.memberCount} משתתפים` : "רק את/ה";
      main.appendChild(title);
      main.appendChild(sub);
      btn.appendChild(main);
      if (l.listId === activeListId) {
        const tag = document.createElement("span");
        tag.className = "acc-tag";
        tag.textContent = "פעילה";
        btn.appendChild(tag);
      }
      btn.addEventListener("click", () => {
        switchList(l.listId);
        accountOverlay.classList.add("hidden");
      });
      listsList.appendChild(btn);
    });
  }

  function openAccountModal() {
    linkCodeRow.classList.add("hidden");
    showLinkCodeBtn.classList.remove("hidden");
    renderAccountModal();
    accountOverlay.classList.remove("hidden");
  }

  async function shareList() {
    const targetUserId = shareUserIdInput.value.trim();
    if (!targetUserId) {
      showToast("הדביקו מזהה משתמש");
      return;
    }
    if (targetUserId === account.userId) {
      showToast("זה המזהה שלך 🙂");
      return;
    }
    shareBtn.disabled = true;
    const res = await sync.request("share:list", { listId: activeListId, targetUserId });
    shareBtn.disabled = false;
    if (res.ok) {
      shareUserIdInput.value = "";
      showToast(`הרשימה שותפה עם ${res.member.username} ✓`);
      return;
    }
    const errors = {
      offline: "אין חיבור לשרת כרגע, נסו שוב בעוד רגע",
      timeout: "השרת לא הגיב, נסו שוב",
      "user not found": "לא נמצא משתמש עם המזהה הזה",
      "already shared with this user": "הרשימה כבר משותפת עם המשתמש הזה",
    };
    showToast(errors[res.error] || "השיתוף נכשל");
  }

  async function removeMember(userId) {
    const res = await sync.request("list:remove_member", { listId: activeListId, userId });
    if (!res.ok) showToast(res.error === "offline" ? "אין חיבור לשרת כרגע" : "הפעולה נכשלה");
  }

  function leaveList() {
    showConfirm("לעזוב את הרשימה המשותפת? לא תוכלו לראות אותה יותר.", async () => {
      const listId = activeListId;
      const res = await sync.request("list:remove_member", { listId, userId: account.userId });
      if (!res.ok) {
        showToast(res.error === "offline" ? "אין חיבור לשרת כרגע" : "הפעולה נכשלה");
        return;
      }
      accountOverlay.classList.add("hidden");
      // list:removed will also arrive; switching here makes it feel instant.
      forgetList(listId);
      switchList(ownListId());
      showToast("עזבת את הרשימה");
    });
  }

  async function saveUsername() {
    const username = usernameInput.value.trim();
    if (!username || username === account.username) return;
    const res = await sync.request("user:rename", { username });
    if (!res.ok) {
      showToast(res.error === "offline" ? "אין חיבור לשרת כרגע" : "שמירת השם נכשלה");
      return;
    }
    account.username = res.user.username;
    writeJSON(STORAGE_KEYS.account, account);
    usernameInput.blur();
    showToast("השם עודכן");
  }

  function forgetList(listId) {
    lists = lists.filter((l) => l.listId !== listId);
    saveLists();
    removeKey(STORAGE_KEYS.listCachePrefix + listId);
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
    saveItems(); // now writes to the local-only key
    render();
    renderAccountUI();
  }

  function logout() {
    showConfirm("להתנתק מהחשבון במכשיר הזה? כדי לחזור תצטרכו את קוד החיבור. הרשימה הנוכחית תישאר במכשיר.", () => {
      accountOverlay.classList.add("hidden");
      dropAccount();
      showToast("התנתקת מהחשבון");
    });
  }

  /* ---------- Real-time wiring ---------- */
  function startSync() {
    const client = new window.SyncClient({ url: BACKEND_URL, token: account.token });
    sync = client;
    let wakeToastShown = false;

    // Handlers for a socket event about the active list. Skip echoes of items
    // we still have unacknowledged local changes for (ours are newer).
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
    });

    client.on("session", ({ user, lists: serverLists }) => {
      account.username = user.username;
      writeJSON(STORAGE_KEYS.account, account);
      applyLists(serverLists);
    });

    client.on("lists:updated", ({ lists: serverLists }) => applyLists(serverLists));

    client.on("list:state", ({ list, items: serverItems }) => {
      if (!list || list.listId !== activeListId) return;
      listInfo = list;
      items = serverItems.map(fromServerItem);
      // Re-apply local changes the server hasn't confirmed yet.
      client.pendingFor(activeListId).forEach((entry) => entry.op && applyOp(entry.op));
      saveItems();
      render();
      renderAccountUI();
    });

    client.on("list:members", ({ listId, members, ownerId }) => {
      if (listId !== activeListId) return;
      listInfo = { listId, ownerId, members };
      const meta = activeListMeta();
      if (meta) meta.memberCount = members.length;
      saveLists();
      saveItems();
      render();
      renderAccountUI();
    });

    client.on("item:added", forActive(({ listId, item }) => {
      if (client.hasPending(listId, item.itemId)) return;
      const isNew = !items.some((i) => i.id === item.itemId);
      applyOp({ type: "add", item: fromServerItem(item) });
      if (isNew && item.addedBy !== account.userId) flashIds.add(item.itemId);
    }));
    client.on("item:toggled", forActive(({ listId, itemId, isCompleted }) => {
      if (!client.hasPending(listId, itemId)) applyOp({ type: "toggle", id: itemId, bought: isCompleted });
    }));
    client.on("item:updated", forActive(({ listId, item }) => {
      if (!client.hasPending(listId, item.itemId)) applyOp({ type: "add", item: fromServerItem(item) });
    }));
    client.on("item:deleted", forActive(({ itemId }) => applyOp({ type: "delete", id: itemId })));
    client.on("item:cleared", forActive(({ itemIds }) => applyOp({ type: "remove", ids: itemIds })));

    client.on("list:shared_notification", ({ listId, from }) => {
      showToast(`${from.username} שיתף/ה איתך רשימה`, 7000, { label: "פתיחה", fn: () => switchList(listId) });
    });

    client.on("list:removed", ({ listId }) => {
      const wasActive = listId === activeListId;
      forgetList(listId);
      if (wasActive) {
        switchList(ownListId());
        showToast("הוסרת מהרשימה המשותפת");
      }
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

    client.on("auth_error", () => {
      // Token unknown to the server (e.g. its database was reset).
      dropAccount();
      showToast("החשבון לא נמצא בשרת. הרשימה נשמרה במכשיר — אפשר ליצור חשבון חדש.", 6000);
      openWelcome("החשבון הקודם לא נמצא בשרת. צרו חשבון חדש כדי להמשיך לסנכרן — הפריטים שעל המסך יישמרו.");
    });

    client.setActiveList(activeListId);
    return client;
  }

  function applyLists(serverLists) {
    lists = serverLists || [];
    saveLists();
    if (!lists.some((l) => l.listId === activeListId)) {
      switchList(ownListId());
    } else {
      renderAccountUI();
    }
  }

  /* ---------- Welcome / sign-up ---------- */
  function openWelcome(message) {
    welcomeText.textContent = message || "צרו חשבון כדי לסנכרן את הרשימה בין מכשירים ולשתף אותה בזמן אמת עם בני הבית. הפריטים שכבר ברשימה יישמרו.";
    setWelcomeStatus("");
    registerPanel.classList.remove("hidden");
    linkPanel.classList.add("hidden");
    welcomeOverlay.classList.remove("hidden");
  }
  function closeWelcome() {
    welcomeOverlay.classList.add("hidden");
    writeJSON(STORAGE_KEYS.welcomeSeen, true);
  }
  function setWelcomeStatus(text, isError) {
    welcomeStatus.textContent = text;
    welcomeStatus.classList.toggle("hidden", !text);
    welcomeStatus.classList.toggle("error", !!isError);
  }
  function setWelcomeBusy(busy) {
    [registerBtn, linkDeviceBtn, welcomeNameInput, linkCodeInput].forEach((x) => { x.disabled = busy; });
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
    const username = welcomeNameInput.value.trim();
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
      lists = [{ listId, ownerId: user.userId, ownerName: user.username, memberCount: 1 }];
      saveLists();
      setActiveList(listId);
      listInfo = { listId, ownerId: user.userId, members: [{ userId: user.userId, username: user.username }] };
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
    const token = linkCodeInput.value.trim();
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
  addBtn.addEventListener("click", addItem);
  newItemInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    clearSearchBtn.classList.toggle("hidden", !searchQuery);
    render();
  });
  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    clearSearchBtn.classList.add("hidden");
    render();
  });

  clearBoughtBtn.addEventListener("click", clearBought);
  resetAllBtn.addEventListener("click", resetAll);

  templatesBtn.addEventListener("click", () => {
    renderTemplatesList();
    templatesOverlay.classList.remove("hidden");
  });
  closeTemplatesBtn.addEventListener("click", () => templatesOverlay.classList.add("hidden"));
  templatesOverlay.addEventListener("click", (e) => { if (e.target === templatesOverlay) templatesOverlay.classList.add("hidden"); });
  saveTemplateBtn.addEventListener("click", saveCurrentAsTemplate);

  // Account & sharing
  enableSyncBtn.addEventListener("click", () => openWelcome());
  copyIdBtn.addEventListener("click", () => copyText(account.userId, "מזהה המשתמש הועתק"));
  copyFullIdBtn.addEventListener("click", () => copyText(account.userId, "מזהה המשתמש הועתק"));
  membersBtn.addEventListener("click", openAccountModal);
  closeAccountBtn.addEventListener("click", () => accountOverlay.classList.add("hidden"));
  accountOverlay.addEventListener("click", (e) => { if (e.target === accountOverlay) accountOverlay.classList.add("hidden"); });
  shareBtn.addEventListener("click", shareList);
  shareUserIdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") shareList(); });
  leaveListBtn.addEventListener("click", leaveList);
  saveUsernameBtn.addEventListener("click", saveUsername);
  usernameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveUsername(); });
  showLinkCodeBtn.addEventListener("click", () => {
    linkCode.textContent = account.token;
    linkCodeRow.classList.remove("hidden");
    showLinkCodeBtn.classList.add("hidden");
  });
  copyLinkCodeBtn.addEventListener("click", () => copyText(account.token, "קוד החיבור הועתק — אל תשתפו אותו"));
  logoutBtn.addEventListener("click", logout);

  // Welcome
  closeWelcomeBtn.addEventListener("click", closeWelcome);
  skipWelcomeBtn.addEventListener("click", closeWelcome);
  registerBtn.addEventListener("click", registerAccount);
  welcomeNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") registerAccount(); });
  linkDeviceBtn.addEventListener("click", linkDevice);
  linkCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") linkDevice(); });
  showLinkPanelBtn.addEventListener("click", () => {
    setWelcomeStatus("");
    registerPanel.classList.add("hidden");
    linkPanel.classList.remove("hidden");
  });
  showRegisterPanelBtn.addEventListener("click", () => {
    setWelcomeStatus("");
    linkPanel.classList.add("hidden");
    registerPanel.classList.remove("hidden");
  });

  /* ---------- Init ---------- */
  loadState();
  buildFilterRow();
  render();
  renderAccountUI();

  if (account) {
    sync = startSync();
    sync.start();
  } else if (BACKEND_URL && !readJSON(STORAGE_KEYS.welcomeSeen, false)) {
    openWelcome();
  }

  if (window.PWAUpdate) window.PWAUpdate.register("sw.js");
})();
