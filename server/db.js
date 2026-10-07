"use strict";

/*
 * Persistence layer on libSQL (Turso).
 *
 * Production (Render): TURSO_DATABASE_URL=libsql://<db>-<org>.turso.io + TURSO_AUTH_TOKEN.
 *   The data lives in Turso, so Render's ephemeral disk being wiped on spin-down
 *   no longer loses users, tokens or lists.
 * Development / tests: without TURSO_DATABASE_URL a local SQLite file is used
 *   (DB_PATH, default server/data/shopping.db). Same SQL dialect, same schema.
 *
 * Every export is async. Multi-statement writes go through client.batch(..., "write"),
 * which runs them as one atomic transaction in a single round trip.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@libsql/client");
const { roleForEmail, normalizeEmail } = require("./roles");

const REMOTE_URL = (process.env.TURSO_DATABASE_URL || "").trim();
const LOCAL_PATH = process.env.DB_PATH || path.join(__dirname, "data", "shopping.db");

let url = REMOTE_URL;
if (!url) {
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  url = "file:" + LOCAL_PATH;
  if (process.env.RENDER) {
    console.warn(
      "[db] WARNING: TURSO_DATABASE_URL is not set. Using a local file on Render's ephemeral disk — " +
        "ALL DATA WILL BE LOST when the instance spins down."
    );
  }
}

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const mode = REMOTE_URL ? "turso" : "local-file";

/* ---------- Tiny query helpers ---------- */
const q = (sql, args = []) => ({ sql, args });
const all = async (sql, args) => (await client.execute(q(sql, args))).rows;
const get = async (sql, args) => (await client.execute(q(sql, args))).rows[0];
const run = async (sql, args) => (await client.execute(q(sql, args))).rowsAffected;
const writeBatch = (stmts) => client.batch(stmts, "write");
const readBatch = (stmts) => client.batch(stmts, "read");

/* ---------- Schema + additive migrations (safe on every start) ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id     TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lists (
    list_id     TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS list_members (
    list_id     TEXT NOT NULL REFERENCES lists(list_id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (list_id, user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_members_user ON list_members(user_id)",
  `CREATE TABLE IF NOT EXISTS items (
    item_id      TEXT PRIMARY KEY,
    list_id      TEXT NOT NULL REFERENCES lists(list_id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'misc',
    qty          INTEGER NOT NULL DEFAULT 1,
    is_completed INTEGER NOT NULL DEFAULT 0,
    added_by     TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id)",
];

async function columnsOf(table) {
  return new Set((await all(`PRAGMA table_info(${table})`)).map((c) => c.name));
}

async function migrate() {
  await writeBatch(SCHEMA);

  const listCols = await columnsOf("lists");
  const itemCols = await columnsOf("items");
  const userCols = await columnsOf("users");
  const steps = [];
  if (!listCols.has("name")) steps.push("ALTER TABLE lists ADD COLUMN name TEXT");
  if (!listCols.has("share_code")) steps.push("ALTER TABLE lists ADD COLUMN share_code TEXT");
  if (!itemCols.has("quantity")) {
    // v1 stored an integer counter; 1 meant "no quantity given".
    steps.push("ALTER TABLE items ADD COLUMN quantity TEXT NOT NULL DEFAULT ''");
    steps.push("UPDATE items SET quantity = CAST(qty AS TEXT) WHERE qty > 1");
  }
  if (!itemCols.has("notes")) steps.push("ALTER TABLE items ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  if (!userCols.has("last_seen_at")) steps.push("ALTER TABLE users ADD COLUMN last_seen_at INTEGER");
  // Verified email: set only through the owner claim (see roles.js). NULL for everyone else.
  if (!userCols.has("email")) steps.push("ALTER TABLE users ADD COLUMN email TEXT");
  steps.push("CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_share_code ON lists(share_code)");
  steps.push("CREATE INDEX IF NOT EXISTS idx_items_completed ON items(is_completed, updated_at)");
  await writeBatch(steps);
}

/*
 * Connection state. The server starts listening immediately (so Render's health
 * check passes during a cold start) and keeps retrying the database in the
 * background. Until `ready` is true, sockets are told "server_unavailable" —
 * never "invalid token" — so clients keep their accounts and just wait.
 */
const state = { ready: false, lastError: null, connectedAt: null };
let initPromise = null;

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await migrate();
        state.ready = true;
        state.lastError = null;
        state.connectedAt = Date.now();
        console.log(`[db] ready (${mode})`);
        return;
      } catch (err) {
        state.lastError = err.message;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        console.error(`[db] init attempt ${attempt} failed: ${err.message}; retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();
  return initPromise;
}

const isReady = () => state.ready;

async function ping() {
  const started = Date.now();
  await client.execute("SELECT 1");
  return Date.now() - started;
}

/* ---------- Helpers ---------- */
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/* 8 chars from an alphabet without look-alikes (0/O, 1/I/L). ~40 bits. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newShareCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}
const normalizeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normalizeText = (t) => String(t).trim().toLowerCase().replace(/\s+/g, " ");

/* ---------- Row -> API shape ---------- */
/* The email itself never leaves the server: clients only see the role derived from it. */
const toUser = (r) => r && { userId: r.user_id, username: r.username, createdAt: r.created_at, ...roleForEmail(r.email) };
const toItem = (r) => r && {
  itemId: r.item_id,
  listId: r.list_id,
  text: r.text,
  category: r.category,
  quantity: r.quantity,
  notes: r.notes,
  qty: parseInt(r.quantity, 10) || 1, // for clients from before free-text quantities
  isCompleted: !!r.is_completed,
  addedBy: r.added_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
};

const SQL = {
  insertUser: "INSERT INTO users (user_id, username, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  insertList: "INSERT INTO lists (list_id, owner_id, name, created_at) VALUES (?, ?, ?, ?)",
  insertMember: "INSERT OR IGNORE INTO list_members (list_id, user_id, joined_at) VALUES (?, ?, ?)",
  listById: "SELECT list_id, owner_id, name, share_code, created_at FROM lists WHERE list_id = ?",
  membersOf: `
    SELECT u.user_id, u.username FROM list_members m
    JOIN users u ON u.user_id = m.user_id
    WHERE m.list_id = ? ORDER BY m.joined_at`,
  itemById: "SELECT * FROM items WHERE item_id = ? AND list_id = ?",
};

/* Deleting a list without relying on ON DELETE CASCADE (foreign_keys is a per-connection pragma). */
const deleteListStmts = (listId) => [
  q("DELETE FROM items WHERE list_id = ?", [listId]),
  q("DELETE FROM list_members WHERE list_id = ?", [listId]),
  q("DELETE FROM lists WHERE list_id = ?", [listId]),
];

/* ---------- Users ---------- */
async function createUser(username) {
  const now = Date.now();
  const userId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  await writeBatch([
    q(SQL.insertUser, [userId, username, hashToken(token), now, now]),
    q(SQL.insertList, [listId, userId, null, now]),
    q(SQL.insertMember, [listId, userId, now]),
  ]);
  return { user: { userId, username, createdAt: now, ...roleForEmail(null) }, token, listId };
}

/*
 * Returns the user, or null when the token is definitively unknown.
 * Throws when the database can't be reached — callers must NOT treat that as "unknown".
 */
async function findUserByToken(token) {
  if (!token) return null;
  return toUser(await get("SELECT user_id, username, created_at, email FROM users WHERE token_hash = ?", [hashToken(token)]));
}
const findUserById = async (userId) =>
  toUser(await get("SELECT user_id, username, created_at, email FROM users WHERE user_id = ?", [userId]));

/*
 * Attach a verified email to an account, taking it off any other account first, so
 * at most one account can ever hold the owner email. Callers must have verified it.
 */
async function setVerifiedEmail(userId, email) {
  const clean = normalizeEmail(email);
  const [, updated] = await writeBatch([
    q("UPDATE users SET email = NULL WHERE email = ? AND user_id <> ?", [clean, userId]),
    q("UPDATE users SET email = ? WHERE user_id = ?", [clean, userId]),
  ]);
  return updated.rowsAffected > 0 ? findUserById(userId) : null;
}
const renameUser = (userId, username) => run("UPDATE users SET username = ? WHERE user_id = ?", [username, userId]);
const touchUser = (userId) => run("UPDATE users SET last_seen_at = ? WHERE user_id = ?", [Date.now(), userId]);

/* ---------- Lists ---------- */
async function getList(listId) {
  const [listRes, membersRes] = await readBatch([q(SQL.listById, [listId]), q(SQL.membersOf, [listId])]);
  const row = listRes.rows[0];
  if (!row) return null;
  return {
    listId: row.list_id,
    ownerId: row.owner_id,
    name: row.name,
    members: membersRes.rows.map((m) => ({ userId: m.user_id, username: m.username })),
  };
}

async function getListsForUser(userId) {
  const rows = await all(`
    SELECT l.list_id, l.owner_id, l.name, o.username AS owner_name,
           (SELECT COUNT(*) FROM list_members x WHERE x.list_id = l.list_id) AS member_count,
           (SELECT COUNT(*) FROM items i WHERE i.list_id = l.list_id AND i.is_completed = 0) AS remaining
    FROM list_members m
    JOIN lists l ON l.list_id = m.list_id
    JOIN users o ON o.user_id = l.owner_id
    WHERE m.user_id = ?
    ORDER BY (l.owner_id = m.user_id) DESC, l.created_at, m.joined_at`, [userId]);
  return rows.map((r) => ({
    listId: r.list_id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    name: r.name,
    memberCount: r.member_count,
    remaining: r.remaining,
  }));
}

async function createList(listId, ownerId, name) {
  const now = Date.now();
  await writeBatch([q(SQL.insertList, [listId, ownerId, name, now]), q(SQL.insertMember, [listId, ownerId, now])]);
  return getList(listId);
}

const renameList = async (listId, name) => (await run("UPDATE lists SET name = ? WHERE list_id = ?", [name, listId])) > 0;
const deleteList = async (listId) => (await writeBatch(deleteListStmts(listId)))[2].rowsAffected > 0;
const membershipCount = async (userId) =>
  (await get("SELECT COUNT(*) AS n FROM list_members WHERE user_id = ?", [userId])).n;

/* Returns the list's invite code, creating (or replacing) it when needed. */
async function getShareCode(listId, regenerate) {
  const row = await get(SQL.listById, [listId]);
  if (!row) return null;
  if (row.share_code && !regenerate) return row.share_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newShareCode();
    try {
      await run("UPDATE lists SET share_code = ? WHERE list_id = ?", [code, listId]);
      return code;
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
    }
  }
  throw new Error("could not allocate share code");
}

async function findListIdByCode(code) {
  const normalized = normalizeCode(code);
  if (normalized.length !== 8) return null;
  const row = await get("SELECT list_id FROM lists WHERE share_code = ?", [normalized]);
  return row ? row.list_id : null;
}

const isMember = async (listId, userId) =>
  !!(await get("SELECT 1 AS x FROM list_members WHERE list_id = ? AND user_id = ?", [listId, userId]));
const addMember = async (listId, userId) => (await run(SQL.insertMember, [listId, userId, Date.now()])) > 0;
const removeMember = async (listId, userId) =>
  (await run("DELETE FROM list_members WHERE list_id = ? AND user_id = ?", [listId, userId])) > 0;

/* ---------- Items ---------- */
const getItems = async (listId) =>
  (await all("SELECT * FROM items WHERE list_id = ? ORDER BY created_at", [listId])).map(toItem);
const getItem = async (listId, itemId) => toItem(await get(SQL.itemById, [itemId, listId]));

/* An unchecked item with the same name already on the list (e.g. two people added "milk" while offline). */
async function findOpenDuplicate(listId, text) {
  const wanted = normalizeText(text);
  const rows = await all("SELECT * FROM items WHERE list_id = ? AND is_completed = 0", [listId]);
  return toItem(rows.find((r) => normalizeText(r.text) === wanted));
}

async function addItem(listId, { itemId, text, category, quantity, notes }, addedBy) {
  const now = Date.now();
  // INSERT OR IGNORE makes replayed offline adds idempotent; return whatever is stored.
  const [, stored] = await writeBatch([
    q(`INSERT OR IGNORE INTO items (item_id, list_id, text, category, quantity, notes, is_completed, added_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [itemId, listId, text, category, quantity, notes, addedBy, now, now]),
    q(SQL.itemById, [itemId, listId]),
  ]);
  return toItem(stored.rows[0]);
}

/* changes: any of { text, category, quantity, notes }; missing fields are left alone. */
async function updateItem(listId, itemId, changes) {
  const [updated, stored] = await writeBatch([
    q(`UPDATE items SET
         text = COALESCE(?, text),
         category = COALESCE(?, category),
         quantity = COALESCE(?, quantity),
         notes = COALESCE(?, notes),
         updated_at = ?
       WHERE item_id = ? AND list_id = ?`,
      [changes.text ?? null, changes.category ?? null, changes.quantity ?? null, changes.notes ?? null, Date.now(), itemId, listId]),
    q(SQL.itemById, [itemId, listId]),
  ]);
  return updated.rowsAffected > 0 ? toItem(stored.rows[0]) : null;
}

async function setCompleted(listId, itemId, isCompleted) {
  const now = Date.now();
  const n = await run("UPDATE items SET is_completed = ?, updated_at = ? WHERE item_id = ? AND list_id = ?",
    [isCompleted ? 1 : 0, now, itemId, listId]);
  return n > 0 ? now : null;
}

const deleteItem = async (listId, itemId) =>
  (await run("DELETE FROM items WHERE item_id = ? AND list_id = ?", [itemId, listId])) > 0;

async function clearCompleted(listId) {
  const [ids] = await writeBatch([
    q("SELECT item_id FROM items WHERE list_id = ? AND is_completed = 1", [listId]),
    q("DELETE FROM items WHERE list_id = ? AND is_completed = 1", [listId]),
  ]);
  return ids.rows.map((r) => r.item_id);
}

async function clearAll(listId) {
  const [ids] = await writeBatch([
    q("SELECT item_id FROM items WHERE list_id = ?", [listId]),
    q("DELETE FROM items WHERE list_id = ?", [listId]),
  ]);
  return ids.rows.map((r) => r.item_id);
}

/* ---------- Admin ---------- */
async function adminStats() {
  const c = await get(`
    SELECT (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM lists) AS lists,
           (SELECT COUNT(*) FROM items) AS items,
           (SELECT COUNT(*) FROM items WHERE is_completed = 1) AS completed_items`);
  let sizeBytes = null;
  try {
    const [pages, pageSize] = await readBatch(["PRAGMA page_count", "PRAGMA page_size"]);
    sizeBytes = Number(pages.rows[0].page_count) * Number(pageSize.rows[0].page_size);
  } catch (e) {
    // Some hosted setups don't expose these pragmas; the size is informational only.
  }
  return {
    users: c.users,
    lists: c.lists,
    items: c.items,
    completedItems: c.completed_items,
    sizeBytes,
  };
}

async function adminListUsers() {
  const [users, memberships] = await readBatch([
    "SELECT user_id, username, created_at, last_seen_at, email FROM users ORDER BY COALESCE(last_seen_at, created_at) DESC",
    "SELECT user_id, list_id FROM list_members ORDER BY joined_at",
  ]);
  const byUser = new Map();
  for (const m of memberships.rows) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m.list_id);
  }
  return users.rows.map((u) => ({
    userId: u.user_id,
    username: u.username,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    role: roleForEmail(u.email).role,
    listIds: byUser.get(u.user_id) || [],
  }));
}

async function adminListLists() {
  const rows = await all(`
    SELECT l.list_id, l.name, l.owner_id, l.created_at, o.username AS owner_name,
           (SELECT COUNT(*) FROM items i WHERE i.list_id = l.list_id) AS item_count,
           (SELECT COUNT(*) FROM items i WHERE i.list_id = l.list_id AND i.is_completed = 0) AS open_count,
           (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.list_id) AS user_count,
           (SELECT MAX(i.updated_at) FROM items i WHERE i.list_id = l.list_id) AS last_activity
    FROM lists l LEFT JOIN users o ON o.user_id = l.owner_id
    ORDER BY l.created_at DESC`);
  return rows.map((r) => ({
    listId: r.list_id,
    name: r.name,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    createdAt: r.created_at,
    itemCount: r.item_count,
    openCount: r.open_count,
    userCount: r.user_count,
    lastActivity: r.last_activity,
  }));
}

/*
 * Deletes a user, every list they own (with its items and members), and their
 * memberships in other people's lists. Returns what changed so the socket
 * layer can notify the other users involved; null if the user didn't exist.
 */
async function adminDeleteUser(userId) {
  const user = await findUserById(userId);
  if (!user) return null;
  const owned = (await all("SELECT list_id FROM lists WHERE owner_id = ?", [userId])).map((r) => r.list_id);
  const affected = [];
  for (const listId of owned) {
    const list = await getList(listId);
    if (list) affected.push(list);
  }
  const memberOf = (await all("SELECT list_id FROM list_members WHERE user_id = ?", [userId]))
    .map((r) => r.list_id)
    .filter((id) => !owned.includes(id));

  await writeBatch([
    ...owned.flatMap(deleteListStmts),
    q("DELETE FROM list_members WHERE user_id = ?", [userId]),
    q("DELETE FROM users WHERE user_id = ?", [userId]),
  ]);
  return { user, deletedLists: affected, leftLists: memberOf };
}

/* Returns the deleted list (with its former members) or null. */
async function adminDeleteList(listId) {
  const list = await getList(listId);
  if (!list) return null;
  await writeBatch(deleteListStmts(listId));
  return list;
}

/* Permanently deletes checked items older than `olderThanMs`. Returns { listId: [itemIds] }. */
async function purgeCompleted(olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const [found] = await writeBatch([
    q("SELECT item_id, list_id FROM items WHERE is_completed = 1 AND updated_at < ?", [cutoff]),
    q("DELETE FROM items WHERE is_completed = 1 AND updated_at < ?", [cutoff]),
  ]);
  const byList = {};
  for (const r of found.rows) (byList[r.list_id] = byList[r.list_id] || []).push(r.item_id);
  return { cutoff, deleted: found.rows.length, byList };
}

/* Full JSON dump (includes token hashes so it can be restored; treat as sensitive). */
async function exportAll() {
  const [users, lists, members, items] = await readBatch([
    "SELECT * FROM users",
    "SELECT * FROM lists",
    "SELECT * FROM list_members",
    "SELECT * FROM items",
  ]);
  const plain = (res) => res.rows.map((r) => Object.fromEntries(res.columns.map((c) => [c, r[c]])));
  return {
    format: "shopping-list-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: { users: plain(users), lists: plain(lists), list_members: plain(members), items: plain(items) },
  };
}

function close() {
  try { client.close(); } catch (e) {}
}

module.exports = {
  mode,
  state,
  init,
  isReady,
  ping,
  close,
  createUser,
  findUserByToken,
  findUserById,
  setVerifiedEmail,
  renameUser,
  touchUser,
  getList,
  getListsForUser,
  createList,
  renameList,
  deleteList,
  membershipCount,
  getShareCode,
  findListIdByCode,
  isMember,
  addMember,
  removeMember,
  getItems,
  getItem,
  findOpenDuplicate,
  addItem,
  updateItem,
  setCompleted,
  deleteItem,
  clearCompleted,
  clearAll,
  adminStats,
  adminListUsers,
  adminListLists,
  adminDeleteUser,
  adminDeleteList,
  purgeCompleted,
  exportAll,
};
