(() => {
  "use strict";

  /* ---------- Constants ---------- */
  const STORAGE_KEYS = {
    items: "shoppingList.items.v1",
    templates: "shoppingList.templates.v1",
    theme: "shoppingList.theme.v1",
  };

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

  /* ---------- State ---------- */
  let items = [];
  let templates = {};
  let activeFilter = "all";
  let searchQuery = "";

  /* ---------- Storage ---------- */
  function loadState() {
    try {
      const rawItems = localStorage.getItem(STORAGE_KEYS.items);
      items = rawItems ? JSON.parse(rawItems) : [];
    } catch (e) {
      items = [];
    }
    try {
      const rawTemplates = localStorage.getItem(STORAGE_KEYS.templates);
      templates = rawTemplates ? JSON.parse(rawTemplates) : { ...DEFAULT_TEMPLATE };
    } catch (e) {
      templates = { ...DEFAULT_TEMPLATE };
    }
  }

  function saveItems() {
    try { localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(items)); } catch (e) {}
  }
  function saveTemplates() {
    try { localStorage.setItem(STORAGE_KEYS.templates, JSON.stringify(templates)); } catch (e) {}
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

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function showToast(msg, ms = 2200) {
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), ms);
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

  /* ---------- Rendering: filter chips ---------- */
  function renderFilterRow() {
    const chips = [{ key: "all", label: "הכל", emoji: "📋" }, ...CATEGORIES];
    filterRow.innerHTML = "";
    chips.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "chip" + (activeFilter === c.key ? " active" : "");
      btn.textContent = `${c.emoji} ${c.label}`;
      btn.addEventListener("click", () => {
        activeFilter = activeFilter === c.key ? "all" : c.key;
        render();
      });
      filterRow.appendChild(btn);
    });
  }

  /* ---------- Rendering: list ---------- */
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

  function render() {
    renderFilterRow();

    const visible = getVisibleItems();
    listContainer.innerHTML = "";

    const totalCount = items.length;
    const remaining = items.filter((i) => !i.bought).length;
    const boughtCount = totalCount - remaining;
    if (totalCount === 0) {
      subtitle.textContent = "הרשימה ריקה";
    } else {
      subtitle.textContent = `${remaining} מתוך ${totalCount} נותרו לקנייה`;
    }

    if (boughtCount > 0) {
      boughtBarText.textContent = `✓ ${boughtCount} פריטים נקנו`;
      boughtBar.classList.remove("hidden");
    } else {
      boughtBar.classList.add("hidden");
    }

    if (visible.length === 0) {
      emptyState.classList.remove("hidden");
      emptyState.querySelector("p").textContent = totalCount === 0 ? "הרשימה ריקה" : "לא נמצאו פריטים";
      emptyState.querySelector("span").textContent = totalCount === 0 ? "הוסיפו פריט ראשון בתחתית המסך" : "נסו לשנות את החיפוש או הסינון";
      listContainer.classList.add("hidden");
      return;
    }
    emptyState.classList.add("hidden");
    listContainer.classList.remove("hidden");

    let lastBoughtHeaderShown = false;
    visible.forEach((item) => {
      if (item.bought && !lastBoughtHeaderShown) {
        const label = document.createElement("div");
        label.className = "section-label";
        label.textContent = "נקנו";
        listContainer.appendChild(label);
        lastBoughtHeaderShown = true;
      }
      listContainer.appendChild(buildItemRow(item));
    });
  }

  function buildItemRow(item) {
    const cat = CAT_MAP[item.category] || CAT_MAP.misc;

    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.id = item.id;

    const deleteAction = document.createElement("div");
    deleteAction.className = "item-delete-action";
    deleteAction.textContent = "🗑️ מחיקה";

    const content = document.createElement("div");
    content.className = "item-content";

    const circle = document.createElement("button");
    circle.className = "check-circle" + (item.bought ? " checked" : "");
    circle.textContent = "✓";
    circle.setAttribute("aria-label", "סמן כנקנה");
    circle.addEventListener("click", () => toggleBought(item.id));

    const main = document.createElement("div");
    main.className = "item-main";
    const nameEl = document.createElement("div");
    nameEl.className = "item-name" + (item.bought ? " bought" : "");
    nameEl.textContent = item.name;
    const badge = document.createElement("div");
    badge.className = "item-cat-badge";
    badge.textContent = `${cat.emoji} ${cat.label}`;
    main.appendChild(nameEl);
    main.appendChild(badge);

    const qtyControl = document.createElement("div");
    qtyControl.className = "qty-control";
    const minusBtn = document.createElement("button");
    minusBtn.className = "qty-btn";
    minusBtn.textContent = "–";
    minusBtn.addEventListener("click", (e) => { e.stopPropagation(); changeQty(item.id, -1); });
    const qtyVal = document.createElement("span");
    qtyVal.className = "qty-val";
    qtyVal.textContent = item.qty || 1;
    const plusBtn = document.createElement("button");
    plusBtn.className = "qty-btn";
    plusBtn.textContent = "+";
    plusBtn.addEventListener("click", (e) => { e.stopPropagation(); changeQty(item.id, 1); });
    qtyControl.appendChild(minusBtn);
    qtyControl.appendChild(qtyVal);
    qtyControl.appendChild(plusBtn);

    content.appendChild(circle);
    content.appendChild(main);
    content.appendChild(qtyControl);

    row.appendChild(deleteAction);
    row.appendChild(content);

    attachSwipeToDelete(content, row, item.id);
    return row;
  }

  /* ---------- Swipe to delete ---------- */
  function attachSwipeToDelete(content, row, id) {
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

    items.push({
      id: uid(),
      name: rawName,
      category,
      bought: false,
      qty: 1,
      createdAt: Date.now(),
    });
    saveItems();
    newItemInput.value = "";
    render();
  }

  function toggleBought(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.bought = !item.bought;
    saveItems();
    render();
  }

  function changeQty(id, delta) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.qty = Math.min(99, Math.max(1, (item.qty || 1) + delta));
    saveItems();
    render();
  }

  function deleteItem(id) {
    const rowEl = listContainer.querySelector(`[data-id="${id}"]`);
    if (rowEl) {
      rowEl.classList.add("removing");
      setTimeout(() => {
        items = items.filter((i) => i.id !== id);
        saveItems();
        render();
      }, 220);
    } else {
      items = items.filter((i) => i.id !== id);
      saveItems();
      render();
    }
  }

  function clearBought() {
    if (!items.some((i) => i.bought)) {
      showToast("אין פריטים שנקנו");
      return;
    }
    showConfirm("למחוק את כל הפריטים שנקנו?", () => {
      items = items.filter((i) => !i.bought);
      saveItems();
      render();
      showToast("הפריטים שנקנו נמחקו");
    });
  }

  function resetAll() {
    if (items.length === 0) {
      showToast("הרשימה כבר ריקה");
      return;
    }
    showConfirm("לאפס את כל הרשימה? הפעולה לא ניתנת לביטול.", () => {
      items = [];
      saveItems();
      render();
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
        items.push({
          id: uid(),
          name: ti.name,
          category: ti.category,
          bought: false,
          qty: 1,
          createdAt: Date.now(),
        });
        addedCount++;
      }
    });
    saveItems();
    render();
    templatesOverlay.classList.add("hidden");
    showToast(addedCount > 0 ? `${addedCount} פריטים נוספו מהתבנית` : "כל הפריטים כבר ברשימה");
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

  /* ---------- Init ---------- */
  loadState();
  render();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
