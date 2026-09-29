"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "shopping.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id     TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lists (
    list_id     TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS list_members (
    list_id     TEXT NOT NULL REFERENCES lists(list_id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (list_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_members_user ON list_members(user_id);

  CREATE TABLE IF NOT EXISTS items (
    item_id      TEXT PRIMARY KEY,
    list_id      TEXT NOT NULL REFERENCES lists(list_id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'misc',
    qty          INTEGER NOT NULL DEFAULT 1,
    is_completed INTEGER NOT NULL DEFAULT 0,
    added_by     TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id);
`);

/* ---------- Additive migrations (safe to run on every start) ---------- */
function columnsOf(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}
db.transaction(() => {
  const listCols = columnsOf("lists");
  if (!listCols.has("name")) db.exec("ALTER TABLE lists ADD COLUMN name TEXT");
  if (!listCols.has("share_code")) db.exec("ALTER TABLE lists ADD COLUMN share_code TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_share_code ON lists(share_code)");

  const itemCols = columnsOf("items");
  if (!itemCols.has("quantity")) {
    // v1 stored an integer counter; 1 meant "no quantity given".
    db.exec("ALTER TABLE items ADD COLUMN quantity TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE items SET quantity = CAST(qty AS TEXT) WHERE qty > 1");
  }
  if (!itemCols.has("notes")) db.exec("ALTER TABLE items ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
})();

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/* 8 chars from an alphabet without look-alikes (0/O, 1/I/L). ~40 bits. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newShareCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}
const normalizeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const stmt = {
  insertUser: db.prepare("INSERT INTO users (user_id, username, token_hash, created_at) VALUES (?, ?, ?, ?)"),
  userByToken: db.prepare("SELECT user_id, username, created_at FROM users WHERE token_hash = ?"),
  userById: db.prepare("SELECT user_id, username, created_at FROM users WHERE user_id = ?"),
  renameUser: db.prepare("UPDATE users SET username = ? WHERE user_id = ?"),

  insertList: db.prepare("INSERT INTO lists (list_id, owner_id, name, created_at) VALUES (?, ?, ?, ?)"),
  listById: db.prepare("SELECT list_id, owner_id, name, share_code, created_at FROM lists WHERE list_id = ?"),
  listByCode: db.prepare("SELECT list_id FROM lists WHERE share_code = ?"),
  renameList: db.prepare("UPDATE lists SET name = ? WHERE list_id = ?"),
  setShareCode: db.prepare("UPDATE lists SET share_code = ? WHERE list_id = ?"),
  deleteList: db.prepare("DELETE FROM lists WHERE list_id = ?"),

  insertMember: db.prepare("INSERT OR IGNORE INTO list_members (list_id, user_id, joined_at) VALUES (?, ?, ?)"),
  deleteMember: db.prepare("DELETE FROM list_members WHERE list_id = ? AND user_id = ?"),
  isMember: db.prepare("SELECT 1 FROM list_members WHERE list_id = ? AND user_id = ?"),
  membershipCount: db.prepare("SELECT COUNT(*) AS n FROM list_members WHERE user_id = ?"),
  membersOf: db.prepare(`
    SELECT u.user_id, u.username FROM list_members m
    JOIN users u ON u.user_id = m.user_id
    WHERE m.list_id = ? ORDER BY m.joined_at`),
  listsOfUser: db.prepare(`
    SELECT l.list_id, l.owner_id, l.name, o.username AS owner_name,
           (SELECT COUNT(*) FROM list_members x WHERE x.list_id = l.list_id) AS member_count,
           (SELECT COUNT(*) FROM items i WHERE i.list_id = l.list_id AND i.is_completed = 0) AS remaining
    FROM list_members m
    JOIN lists l ON l.list_id = m.list_id
    JOIN users o ON o.user_id = l.owner_id
    WHERE m.user_id = ?
    ORDER BY (l.owner_id = m.user_id) DESC, l.created_at, m.joined_at`),

  itemsOf: db.prepare("SELECT * FROM items WHERE list_id = ? ORDER BY created_at"),
  itemById: db.prepare("SELECT * FROM items WHERE item_id = ? AND list_id = ?"),
  openItemsOf: db.prepare("SELECT * FROM items WHERE list_id = ? AND is_completed = 0"),
  insertItem: db.prepare(`
    INSERT OR IGNORE INTO items (item_id, list_id, text, category, quantity, notes, is_completed, added_by, created_at, updated_at)
    VALUES (@itemId, @listId, @text, @category, @quantity, @notes, 0, @addedBy, @createdAt, @updatedAt)`),
  updateItem: db.prepare(`
    UPDATE items SET
      text = COALESCE(@text, text),
      category = COALESCE(@category, category),
      quantity = COALESCE(@quantity, quantity),
      notes = COALESCE(@notes, notes),
      updated_at = @updatedAt
    WHERE item_id = @itemId AND list_id = @listId`),
  toggleItem: db.prepare("UPDATE items SET is_completed = ?, updated_at = ? WHERE item_id = ? AND list_id = ?"),
  deleteItem: db.prepare("DELETE FROM items WHERE item_id = ? AND list_id = ?"),
  completedIds: db.prepare("SELECT item_id FROM items WHERE list_id = ? AND is_completed = 1"),
  deleteCompleted: db.prepare("DELETE FROM items WHERE list_id = ? AND is_completed = 1"),
  allIds: db.prepare("SELECT item_id FROM items WHERE list_id = ?"),
  deleteAll: db.prepare("DELETE FROM items WHERE list_id = ?"),
};

/* ---------- Row -> API shape ---------- */
const toUser = (r) => r && { userId: r.user_id, username: r.username, createdAt: r.created_at };
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

const normalizeText = (t) => String(t).trim().toLowerCase().replace(/\s+/g, " ");

/* ---------- Users ---------- */
const createUser = db.transaction((username) => {
  const now = Date.now();
  const userId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  stmt.insertUser.run(userId, username, hashToken(token), now);
  stmt.insertList.run(listId, userId, null, now);
  stmt.insertMember.run(listId, userId, now);
  return { user: { userId, username, createdAt: now }, token, listId };
});

const findUserByToken = (token) => (token ? toUser(stmt.userByToken.get(hashToken(token))) : null);
const findUserById = (userId) => toUser(stmt.userById.get(userId));
const renameUser = (userId, username) => stmt.renameUser.run(username, userId);

/* ---------- Lists ---------- */
function getList(listId) {
  const row = stmt.listById.get(listId);
  if (!row) return null;
  return {
    listId: row.list_id,
    ownerId: row.owner_id,
    name: row.name,
    members: stmt.membersOf.all(listId).map((m) => ({ userId: m.user_id, username: m.username })),
  };
}

const getListsForUser = (userId) =>
  stmt.listsOfUser.all(userId).map((r) => ({
    listId: r.list_id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    name: r.name,
    memberCount: r.member_count,
    remaining: r.remaining,
  }));

const createList = db.transaction((listId, ownerId, name) => {
  const now = Date.now();
  stmt.insertList.run(listId, ownerId, name, now);
  stmt.insertMember.run(listId, ownerId, now);
  return getList(listId);
});

const renameList = (listId, name) => stmt.renameList.run(name, listId).changes > 0;
const deleteList = (listId) => stmt.deleteList.run(listId).changes > 0;
const membershipCount = (userId) => stmt.membershipCount.get(userId).n;

/* Returns the list's invite code, creating (or replacing) it when needed. */
function getShareCode(listId, regenerate) {
  const row = stmt.listById.get(listId);
  if (!row) return null;
  if (row.share_code && !regenerate) return row.share_code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newShareCode();
    try {
      stmt.setShareCode.run(code, listId);
      return code;
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
    }
  }
  throw new Error("could not allocate share code");
}

function findListIdByCode(code) {
  const normalized = normalizeCode(code);
  if (normalized.length !== 8) return null;
  const row = stmt.listByCode.get(normalized);
  return row ? row.list_id : null;
}

const isMember = (listId, userId) => !!stmt.isMember.get(listId, userId);
const addMember = (listId, userId) => stmt.insertMember.run(listId, userId, Date.now()).changes > 0;
const removeMember = (listId, userId) => stmt.deleteMember.run(listId, userId).changes > 0;

/* ---------- Items ---------- */
const getItems = (listId) => stmt.itemsOf.all(listId).map(toItem);
const getItem = (listId, itemId) => toItem(stmt.itemById.get(itemId, listId));

/* An unchecked item with the same name already on the list (e.g. two people added "milk" while offline). */
function findOpenDuplicate(listId, text) {
  const wanted = normalizeText(text);
  const row = stmt.openItemsOf.all(listId).find((r) => normalizeText(r.text) === wanted);
  return toItem(row);
}

function addItem(listId, { itemId, text, category, quantity, notes }, addedBy) {
  const now = Date.now();
  stmt.insertItem.run({ itemId, listId, text, category, quantity, notes, addedBy, createdAt: now, updatedAt: now });
  // INSERT OR IGNORE makes replayed offline adds idempotent; return whatever is stored.
  return getItem(listId, itemId);
}

/* changes: any of { text, category, quantity, notes }; missing fields are left alone. */
function updateItem(listId, itemId, changes) {
  const res = stmt.updateItem.run({
    listId,
    itemId,
    text: changes.text ?? null,
    category: changes.category ?? null,
    quantity: changes.quantity ?? null,
    notes: changes.notes ?? null,
    updatedAt: Date.now(),
  });
  return res.changes > 0 ? getItem(listId, itemId) : null;
}

function setCompleted(listId, itemId, isCompleted) {
  const now = Date.now();
  return stmt.toggleItem.run(isCompleted ? 1 : 0, now, itemId, listId).changes > 0 ? now : null;
}

const deleteItem = (listId, itemId) => stmt.deleteItem.run(itemId, listId).changes > 0;

const clearCompleted = db.transaction((listId) => {
  const ids = stmt.completedIds.all(listId).map((r) => r.item_id);
  stmt.deleteCompleted.run(listId);
  return ids;
});

const clearAll = db.transaction((listId) => {
  const ids = stmt.allIds.all(listId).map((r) => r.item_id);
  stmt.deleteAll.run(listId);
  return ids;
});

module.exports = {
  db,
  createUser,
  findUserByToken,
  findUserById,
  renameUser,
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
};
