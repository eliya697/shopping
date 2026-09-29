/*
 * Admin dashboard (admin.html). Talks to /api/admin/* on the backend from config.js.
 * The session token lives in localStorage; the server re-validates it on every call.
 * All user-provided strings are rendered with textContent (never innerHTML).
 */
(function () {
  "use strict";

  const BACKEND_URL = (window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || "";
  const SESSION_KEY = "shoppingList.adminSession";
  const REFRESH_MS = 10000;
  const REQUEST_TIMEOUT_MS = 90000; // Render's free tier can take ~50s to wake up

  const $ = (id) => document.getElementById(id);
  let refreshTimer = null;
  let users = [];
  let lists = [];

  /* ---------- Session ---------- */
  function readSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY));
      return s && s.token && s.expiresAt > Date.now() ? s : null;
    } catch (e) {
      return null;
    }
  }
  function saveSession(s) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  /* ---------- API ---------- */
  class ApiError extends Error {
    constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
  }

  async function api(path, { method = "GET", body, auth = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (auth) {
      const s = readSession();
      if (!s) { showLogin("פג תוקף ההתחברות"); throw new ApiError("no session", 401); }
      headers.Authorization = "Bearer " + s.token;
    }
    try {
      const res = await fetch(BACKEND_URL + "/api/admin" + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && auth) {
        showLogin("פג תוקף ההתחברות, התחברו מחדש");
        throw new ApiError(data.error || "unauthorized", 401);
      }
      if (!res.ok) throw new ApiError(data.error || "HTTP " + res.status, res.status, data);
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new ApiError("השרת לא הגיב", 0);
      if (e instanceof ApiError) throw e;
      throw new ApiError("אין חיבור לשרת", 0);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- Formatting ---------- */
  const numberFmt = new Intl.NumberFormat("he-IL");
  const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" });
  const relFmt = new Intl.RelativeTimeFormat("he", { numeric: "auto" });

  function formatBytes(n) {
    if (n == null) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + " " + units[i];
  }
  function formatDuration(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d} ימ׳ ${h} שע׳`;
    if (h) return `${h} שע׳ ${m} דק׳`;
    return `${m} דק׳ ${sec % 60} שנ׳`;
  }
  function formatRelative(ts) {
    if (!ts) return "—";
    const diff = (ts - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return relFmt.format(Math.round(diff), "second");
    if (abs < 3600) return relFmt.format(Math.round(diff / 60), "minute");
    if (abs < 86400) return relFmt.format(Math.round(diff / 3600), "hour");
    if (abs < 86400 * 30) return relFmt.format(Math.round(diff / 86400), "day");
    return dateFmt.format(ts);
  }
  const shortId = (id) => (id.length > 12 ? id.slice(0, 8) + "…" : id);

  /* ---------- UI helpers ---------- */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    children.forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(c == null ? "" : String(c))));
    return node;
  }

  let toastTimer = null;
  function toast(text, ms = 3000) {
    $("toast").textContent = text;
    $("toast").classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.add("hidden"), ms);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("הועתק: " + text);
    } catch (e) {
      toast(text, 6000);
    }
  }

  function idCell(id) {
    return el("td", {}, el("span", { className: "mono id", title: id + " (לחצו להעתקה)", onclick: () => copy(id) }, shortId(id)));
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (label) button.textContent = label;
  }

  /* ---------- Views ---------- */
  function showLogin(message) {
    stopRefresh();
    clearSession();
    $("dashView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    setLoginMsg(message || "", !!message);
    $("keyInput").value = "";
    ($("emailInput").value ? $("keyInput") : $("emailInput")).focus();
  }

  function showDashboard() {
    $("loginView").classList.add("hidden");
    $("dashView").classList.remove("hidden");
    refreshAll();
    startRefresh();
  }

  function setLoginMsg(text, isError) {
    $("loginMsg").textContent = text;
    $("loginMsg").classList.toggle("hidden", !text);
    $("loginMsg").classList.toggle("error", !!isError);
  }

  async function login(e) {
    e.preventDefault();
    const email = $("emailInput").value.trim();
    const secretKey = $("keyInput").value;
    if (!email || !secretKey) return;
    setBusy($("loginBtn"), true, "מתחבר…");
    const slow = setTimeout(() => setLoginMsg("השרת מתעורר, זה יכול לקחת עד דקה…"), 3000);
    try {
      const session = await api("/login", { method: "POST", body: { email, secretKey }, auth: false });
      saveSession(session);
      $("keyInput").value = "";
      setLoginMsg("");
      showDashboard();
    } catch (err) {
      const msg = err.status === 401 ? "אימייל או מפתח שגויים"
        : err.status === 429 ? "יותר מדי ניסיונות. נסו שוב בעוד 15 דקות."
        : err.data.code === "ADMIN_DISABLED" ? disabledMessage(err.data)
        : err.status === 503 ? "השרת עדיין עולה. נסו שוב בעוד כמה שניות."
        : err.message;
      setLoginMsg(msg, true);
    } finally {
      clearTimeout(slow);
      setBusy($("loginBtn"), false, "כניסה");
    }
  }

  function logout() {
    showLogin("");
  }

  function disabledMessage({ reason, minLength }) {
    const why = {
      missing: "המשתנה ADMIN_SECRET_KEY לא מוגדר בשרת",
      empty: "המשתנה ADMIN_SECRET_KEY מוגדר אבל ריק",
      too_short: `המפתח ב-ADMIN_SECRET_KEY קצר מ-${minLength || 16} תווים`,
    }[reason] || "ADMIN_SECRET_KEY לא תקין";
    return `ממשק הניהול כבוי: ${why}. הגדירו אותו ב-Render → Environment ופרסו מחדש.`;
  }

  /* Tell the developer up front if the server can't accept admin logins at all. */
  async function checkAvailability() {
    try {
      const res = await fetch(BACKEND_URL + "/api/admin/check", { cache: "no-store" });
      if (res.status === 404) return; // older server without /check
      const data = await res.json();
      if (!data.enabled) setLoginMsg(disabledMessage(data), true);
    } catch (e) {
      // Offline or waking up — the login attempt will report it.
    }
  }

  /* ---------- Health ---------- */
  async function loadHealth() {
    const h = await api("/health");
    $("statUptime").textContent = formatDuration(h.uptimeSec);
    $("statStarted").textContent = "עלה ב-" + dateFmt.format(h.startedAt);
    $("statMemory").textContent = formatBytes(h.memory.rss);
    $("statHeap").textContent = `Heap: ${formatBytes(h.memory.heapUsed)} / ${formatBytes(h.memory.heapTotal)}`;
    $("statSockets").textContent = numberFmt.format(h.sockets);
    $("statNode").textContent = "Node " + h.node;

    const db = h.db;
    const pill = $("dbPill");
    pill.className = "pill " + (db.status === "ok" ? (db.mode === "turso" ? "ok" : "warn") : db.status === "connecting" ? "warn" : "bad");
    pill.textContent =
      db.status === "ok" ? (db.mode === "turso" ? "מסד נתונים מחובר (Turso)" : "קובץ מקומי — הנתונים לא נשמרים ב-Render!")
      : db.status === "connecting" ? "מתחבר למסד הנתונים…"
      : "שגיאת מסד נתונים";
    $("statDb").textContent = db.status === "ok" ? `${db.latencyMs}ms` : db.status === "connecting" ? "מתחבר" : "שגיאה";
    $("statDbSub").textContent = db.status === "ok"
      ? `${db.mode} · ${formatBytes(db.sizeBytes)}`
      : (db.error || "");
    if (db.status === "ok") {
      $("statCounts").textContent = `${numberFmt.format(db.users)} · ${numberFmt.format(db.lists)}`;
      $("statItems").textContent = `${numberFmt.format(db.items)} פריטים (${numberFmt.format(db.completedItems)} נקנו)`;
    }
  }

  /* ---------- Users ---------- */
  async function loadUsers() {
    users = (await api("/users")).users;
    renderUsers();
  }

  function renderUsers() {
    const q = $("usersFilter").value.trim().toLowerCase();
    const rows = users.filter((u) => !q || u.username.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q));
    $("usersCount").textContent = `(${numberFmt.format(users.length)})`;
    const body = $("usersBody");
    body.replaceChildren();
    if (!rows.length) {
      body.append(el("tr", {}, el("td", { colSpan: 6, className: "empty" }, users.length ? "אין תוצאות" : "אין משתמשים")));
      return;
    }
    for (const u of rows) {
      const chips = el("div", { className: "chips" });
      u.listIds.forEach((id) => chips.append(el("span", { className: "chip mono", title: id, onclick: () => copy(id) }, shortId(id))));
      const del = el("button", { className: "danger small", onclick: () => deleteUser(u, del) }, "מחיקה");
      body.append(el("tr", {},
        el("td", {}, u.username),
        idCell(u.userId),
        el("td", { title: u.lastSeenAt ? dateFmt.format(u.lastSeenAt) : "לא נרשם" }, formatRelative(u.lastSeenAt)),
        el("td", { className: "dim" }, dateFmt.format(u.createdAt)),
        el("td", {}, chips),
        el("td", {}, del)));
    }
  }

  async function deleteUser(u, button) {
    const msg = `למחוק את המשתמש "${u.username}"?\n\n` +
      "• כל הרשימות שבבעלותו יימחקו (גם אצל משתתפים אחרים)\n" +
      "• הוא יוסר מרשימות משותפות\n" +
      "• המכשירים שלו יתנתקו מהחשבון\n\nלא ניתן לבטל.";
    if (!confirm(msg)) return;
    setBusy(button, true, "מוחק…");
    try {
      const res = await api("/users/" + encodeURIComponent(u.userId), { method: "DELETE" });
      toast(`המשתמש נמחק (${res.deletedLists} רשימות נמחקו)`);
      await Promise.all([loadUsers(), loadLists(), loadHealth()]);
    } catch (err) {
      if (err.status !== 401) toast("המחיקה נכשלה: " + err.message, 5000);
      setBusy(button, false, "מחיקה");
    }
  }

  /* ---------- Lists ---------- */
  async function loadLists() {
    lists = (await api("/lists")).lists;
    renderLists();
  }

  const listName = (l) => l.name || (l.ownerName ? `הרשימה של ${l.ownerName}` : "(ללא שם)");

  function renderLists() {
    const q = $("listsFilter").value.trim().toLowerCase();
    const rows = lists.filter((l) => !q || [listName(l), l.ownerName || "", l.listId].some((s) => s.toLowerCase().includes(q)));
    $("listsCount").textContent = `(${numberFmt.format(lists.length)})`;
    const body = $("listsBody");
    body.replaceChildren();
    if (!rows.length) {
      body.append(el("tr", {}, el("td", { colSpan: 7, className: "empty" }, lists.length ? "אין תוצאות" : "אין רשימות")));
      return;
    }
    for (const l of rows) {
      const del = el("button", { className: "danger small", onclick: () => deleteList(l, del) }, "מחיקה");
      body.append(el("tr", {},
        el("td", {}, listName(l)),
        el("td", {}, l.ownerName || el("span", { className: "dim" }, "—")),
        idCell(l.listId),
        el("td", { className: "num" }, `${numberFmt.format(l.openCount)} / ${numberFmt.format(l.itemCount)}`),
        el("td", { className: "num" }, numberFmt.format(l.userCount)),
        el("td", { title: dateFmt.format(l.lastActivity || l.createdAt) }, formatRelative(l.lastActivity || l.createdAt)),
        el("td", {}, del)));
    }
  }

  async function deleteList(l, button) {
    const msg = `למחוק את "${listName(l)}"?\n\n${l.itemCount} פריטים ו-${l.userCount} משתתפים יושפעו. ` +
      "משתתפים שזו הרשימה היחידה שלהם יקבלו רשימה ריקה חדשה.\n\nלא ניתן לבטל.";
    if (!confirm(msg)) return;
    setBusy(button, true, "מוחק…");
    try {
      await api("/lists/" + encodeURIComponent(l.listId), { method: "DELETE" });
      toast("הרשימה נמחקה");
      await Promise.all([loadUsers(), loadLists(), loadHealth()]);
    } catch (err) {
      if (err.status !== 401) toast("המחיקה נכשלה: " + err.message, 5000);
      setBusy(button, false, "מחיקה");
    }
  }

  /* ---------- Tools ---------- */
  async function cleanup() {
    if (!confirm("למחוק לצמיתות את כל הפריטים שסומנו כנקנו לפני יותר מ-14 יום?")) return;
    const button = $("cleanupBtn");
    const label = button.textContent;
    setBusy(button, true, "מנקה…");
    try {
      const res = await api("/cleanup", { method: "POST" });
      toast(res.deleted ? `נמחקו ${numberFmt.format(res.deleted)} פריטים מ-${res.lists} רשימות` : "אין פריטים ישנים למחיקה");
      await Promise.all([loadLists(), loadHealth()]);
    } catch (err) {
      if (err.status !== 401) toast("הניקוי נכשל: " + err.message, 5000);
    } finally {
      setBusy(button, false, label);
    }
  }

  async function downloadBackup() {
    const button = $("backupBtn");
    const label = button.textContent;
    setBusy(button, true, "מכין גיבוי…");
    try {
      const dump = await api("/export");
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = el("a", { href: url, download: `shopping-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const t = dump.tables;
      toast(`הגיבוי הורד: ${t.users.length} משתמשים, ${t.lists.length} רשימות, ${t.items.length} פריטים`);
    } catch (err) {
      if (err.status !== 401) toast("הגיבוי נכשל: " + err.message, 5000);
    } finally {
      setBusy(button, false, label);
    }
  }

  /* ---------- Refresh loop ---------- */
  async function refreshAll() {
    const results = await Promise.allSettled([loadHealth(), loadUsers(), loadLists()]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed && failed.reason.status !== 401) {
      $("updatedAt").textContent = "שגיאה: " + failed.reason.message;
      $("dbPill").className = "pill bad";
      $("dbPill").textContent = "השרת לא זמין";
    } else if (!failed) {
      $("updatedAt").textContent = "עודכן " + new Date().toLocaleTimeString("he-IL");
    }
  }

  async function refreshHealth() {
    try {
      await loadHealth();
      $("updatedAt").textContent = "עודכן " + new Date().toLocaleTimeString("he-IL");
    } catch (err) {
      if (err.status !== 401) $("updatedAt").textContent = "שגיאה: " + err.message;
    }
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") refreshHealth();
    }, REFRESH_MS);
  }
  function stopRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  /* ---------- Wiring ---------- */
  $("loginForm").addEventListener("submit", login);
  $("logoutBtn").addEventListener("click", logout);
  $("refreshBtn").addEventListener("click", refreshAll);
  $("cleanupBtn").addEventListener("click", cleanup);
  $("backupBtn").addEventListener("click", downloadBackup);
  $("usersFilter").addEventListener("input", renderUsers);
  $("listsFilter").addEventListener("input", renderLists);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && refreshTimer) refreshHealth();
  });

  if (!BACKEND_URL) {
    $("loginView").classList.remove("hidden");
    setLoginMsg("BACKEND_URL לא מוגדר ב-config.js", true);
    $("loginBtn").disabled = true;
  } else if (readSession()) {
    showDashboard();
  } else {
    showLogin("");
    checkAvailability();
  }
})();
