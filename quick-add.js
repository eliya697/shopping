/*
 * QuickAdd — remembers what gets added to lists (per device) and ranks it by
 * how often and how recently it was bought, for one-tap re-adding.
 */
(function (root) {
  "use strict";

  const KEY = "shoppingList.history.v1";
  const MAX_ENTRIES = 300;
  const HALF_LIFE_DAYS = 21;

  const norm = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");

  let entries = {}; // norm(name) -> { name, category, quantity, count, last, lists: { listId: count } }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === "object") entries = raw;
  } catch (e) {}

  function save() {
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => score(entries[a]) - score(entries[b]))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => delete entries[k]);
    }
    try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (e) {}
  }

  /*
   * Frequency with a recency decay: something bought weekly outranks a one-off
   * from months ago. Items added to *this* list count triple, so the pharmacy
   * list suggests pharmacy things first.
   */
  function score(entry, now = Date.now(), listId = null) {
    const days = Math.max(0, (now - entry.last) / 86400000);
    const inList = listId && entry.lists ? entry.lists[listId] || 0 : 0;
    return (entry.count + inList * 3) * Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  function record(item, listId) {
    const key = norm(item.name);
    if (!key) return;
    const prev = entries[key];
    const perList = { ...((prev && prev.lists) || {}) };
    if (listId) perList[listId] = (perList[listId] || 0) + 1;
    entries[key] = {
      name: item.name.trim(),
      category: item.category || (prev && prev.category) || "misc",
      quantity: item.quantity || "",
      count: (prev ? prev.count : 0) + 1,
      last: Date.now(),
      lists: perList,
    };
    save();
  }

  /* Seed from existing items once, so the section isn't empty right after the update. */
  function seed(items, listId) {
    if (Object.keys(entries).length) return;
    items.forEach((item) => {
      const key = norm(item.name);
      if (!key || entries[key]) return;
      entries[key] = {
        name: item.name.trim(),
        category: item.category,
        quantity: "",
        count: 1,
        last: item.createdAt || Date.now(),
        lists: listId ? { [listId]: 1 } : {},
      };
    });
    save();
  }

  function forget(name) {
    delete entries[norm(name)];
    save();
  }

  /*
   * exclude: Set of normalized names already open on the list.
   * query:   optional filter; matches the start of any word in the name.
   * listId:  rank items previously added to this list first.
   */
  function suggestions({ exclude = new Set(), query = "", limit = 12, listId = null } = {}) {
    const q = norm(query);
    const now = Date.now();
    return Object.entries(entries)
      .filter(([key]) => !exclude.has(key))
      .filter(([key]) => !q || key.startsWith(q) || key.includes(" " + q))
      .sort((a, b) => score(b[1], now, listId) - score(a[1], now, listId))
      .slice(0, limit)
      .map(([, e]) => e);
  }

  const names = () => Object.values(entries).map((e) => e.name);
  const size = () => Object.keys(entries).length;

  root.QuickAdd = { record, seed, forget, suggestions, names, size, norm };
})(window);
