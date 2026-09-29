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

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

const stmt = {
  insertUser: db.prepare("INSERT INTO users (user_id, username, token_hash, created_at) VALUES (?, ?, ?, ?)"),
  userByToken: db.prepare("SELECT user_id, username, created_at FROM users WHERE token_hash = ?"),
  userById: db.prepare("SELECT user_id, username, created_at FROM users WHERE user_id = ?"),
  renameUser: db.prepare("UPDATE users SET username = ? WHERE user_id = ?"),

  insertList: db.prepare("INSERT INTO lists (list_id, owner_id, created_at) VALUES (?, ?, ?)"),
  listById: db.prepare("SELECT list_id, owner_id, created_at FROM lists WHERE list_id = ?"),
  insertMember: db.prepare("INSERT OR IGNORE INTO list_members (list_id, user_id, joined_at) VALUES (?, ?, ?)"),
  deleteMember: db.prepare("DELETE FROM list_members WHERE list_id = ? AND user_id = ?"),
  isMember: db.prepare("SELECT 1 FROM list_members WHERE list_id = ? AND user_id = ?"),
  membersOf: db.prepare(`
    SELECT u.user_id, u.username FROM list_members m
    JOIN users u ON u.user_id = m.user_id
    WHERE m.list_id = ? ORDER BY m.joined_at`),
  listsOfUser: db.prepare(`
    SELECT l.list_id, l.owner_id, o.username AS owner_name,
           (SELECT COUNT(*) FROM list_members x WHERE x.list_id = l.list_id) AS member_count
    FROM list_members m
    JOIN lists l ON l.list_id = m.list_id
    JOIN users o ON o.user_id = l.owner_id
    WHERE m.user_id = ?
    ORDER BY (l.owner_id = m.user_id) DESC, m.joined_at`),

  itemsOf: db.prepare("SELECT * FROM items WHERE list_id = ? ORDER BY created_at"),
  itemById: db.prepare("SELECT * FROM items WHERE item_id = ? AND list_id = ?"),
  insertItem: db.prepare(`
    INSERT OR IGNORE INTO items (item_id, list_id, text, category, qty, is_completed, added_by, created_at, updated_at)
    VALUES (@itemId, @listId, @text, @category, @qty, 0, @addedBy, @createdAt, @updatedAt)`),
  toggleItem: db.prepare("UPDATE items SET is_completed = ?, updated_at = ? WHERE item_id = ? AND list_id = ?"),
  qtyItem: db.prepare("UPDATE items SET qty = ?, updated_at = ? WHERE item_id = ? AND list_id = ?"),
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
  qty: r.qty,
  isCompleted: !!r.is_completed,
  addedBy: r.added_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
};

/* ---------- Users ---------- */
const createUser = db.transaction((username) => {
  const now = Date.now();
  const userId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  stmt.insertUser.run(userId, username, hashToken(token), now);
  stmt.insertList.run(listId, userId, now);
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
    members: stmt.membersOf.all(listId).map((m) => ({ userId: m.user_id, username: m.username })),
  };
}

const getListsForUser = (userId) =>
  stmt.listsOfUser.all(userId).map((r) => ({
    listId: r.list_id,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    memberCount: r.member_count,
  }));

const isMember = (listId, userId) => !!stmt.isMember.get(listId, userId);
const addMember = (listId, userId) => stmt.insertMember.run(listId, userId, Date.now()).changes > 0;
const removeMember = (listId, userId) => stmt.deleteMember.run(listId, userId).changes > 0;

/* ---------- Items ---------- */
const getItems = (listId) => stmt.itemsOf.all(listId).map(toItem);
const getItem = (listId, itemId) => toItem(stmt.itemById.get(itemId, listId));

function addItem(listId, { itemId, text, category, qty }, addedBy) {
  const now = Date.now();
  stmt.insertItem.run({ itemId, listId, text, category, qty, addedBy, createdAt: now, updatedAt: now });
  // INSERT OR IGNORE makes replayed offline adds idempotent; return whatever is stored.
  return getItem(listId, itemId);
}

function setCompleted(listId, itemId, isCompleted) {
  const now = Date.now();
  return stmt.toggleItem.run(isCompleted ? 1 : 0, now, itemId, listId).changes > 0 ? now : null;
}

function setQty(listId, itemId, qty) {
  return stmt.qtyItem.run(qty, Date.now(), itemId, listId).changes > 0 ? getItem(listId, itemId) : null;
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
  isMember,
  addMember,
  removeMember,
  getItems,
  addItem,
  setCompleted,
  setQty,
  deleteItem,
  clearCompleted,
  clearAll,
};
