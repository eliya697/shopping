"use strict";

const crypto = require("crypto");
const store = require("./db");

const CATEGORIES = new Set([
  "produce", "bakery", "dairy", "meat", "frozen", "pantry",
  "snacks", "drinks", "cleaning", "hygiene", "misc",
]);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LIMITS = { text: 80, quantity: 30, notes: 200, listName: 40, username: 30 };

/* Brute-force guard for invite codes: max failed attempts per user per window. */
const JOIN_FAILS_MAX = 10;
const JOIN_FAILS_WINDOW_MS = 10 * 60 * 1000;
const joinFails = new Map();

const listRoom = (listId) => `list:${listId}`;
const userRoom = (userId) => `user:${userId}`;

class ClientError extends Error {}
const fail = (msg) => { throw new ClientError(msg); };

function requireId(value, name) {
  if (typeof value !== "string" || !ID_RE.test(value)) fail(`invalid ${name}`);
  return value;
}

function cleanText(value, max) {
  const text = typeof value === "string" ? value.trim().slice(0, max) : "";
  if (!text) fail("text is required");
  return text;
}

/* Optional free-text field: undefined stays undefined (= "don't change"), anything else is trimmed. */
function optionalText(value, max) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, max);
}

/* v1 clients send an integer counter instead of free text; 1 meant "no quantity". */
function legacyQuantity(qty) {
  const n = Math.round(Number(qty));
  return Number.isFinite(n) && n > 1 ? String(Math.min(99, n)) : "";
}

module.exports = function attachSockets(io) {
  /* Every socket must present the secret token it got from /api/register. */
  io.use((socket, next) => {
    const user = store.findUserByToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  /* Push the fresh "lists I belong to" to every device of these users. */
  function pushLists(...userIds) {
    for (const userId of new Set(userIds)) {
      io.to(userRoom(userId)).emit("lists:updated", { lists: store.getListsForUser(userId) });
    }
  }

  function pushMembers(listId) {
    const list = store.getList(listId);
    if (list) io.to(listRoom(listId)).emit("list:members", { listId, ...list });
  }

  /* Nobody should ever end up with zero lists. */
  function ensureHasList(userId) {
    if (store.membershipCount(userId) > 0) return;
    store.createList(crypto.randomUUID(), userId, null);
    pushLists(userId);
  }

  /* Remove a user from a list's room on all their devices and tell them. */
  function evict(listId, userId, reason) {
    io.in(userRoom(userId)).socketsLeave(listRoom(listId));
    io.to(userRoom(userId)).emit("list:removed", { listId, reason });
  }

  io.on("connection", (socket) => {
    const me = socket.data.user;
    socket.join(userRoom(me.userId));
    ensureHasList(me.userId);
    socket.emit("session", { user: me, lists: store.getListsForUser(me.userId) });

    /* Wrap handlers: catch errors and always answer the ack. */
    function on(event, handler) {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          const result = handler(payload || {});
          reply({ ok: true, ...(result || {}) });
        } catch (err) {
          if (!(err instanceof ClientError)) console.error(`[${event}]`, err);
          reply({ ok: false, error: err instanceof ClientError ? err.message : "server error" });
        }
      });
    }

    function memberListId(payload) {
      const listId = requireId(payload.listId, "listId");
      if (!store.isMember(listId, me.userId)) fail("not a member of this list");
      return listId;
    }

    function ownedList(payload) {
      const listId = memberListId(payload);
      const list = store.getList(listId);
      if (list.ownerId !== me.userId) fail("only the list owner can do this");
      return list;
    }

    /* ---------- Lists ---------- */
    on("join:list", (payload) => {
      const listId = memberListId(payload);
      for (const room of socket.rooms) {
        if (room.startsWith("list:") && room !== listRoom(listId)) socket.leave(room);
      }
      socket.join(listRoom(listId));
      socket.emit("list:state", { list: store.getList(listId), items: store.getItems(listId) });
    });

    on("list:create", (payload) => {
      const listId = requireId(payload.listId, "listId");
      const name = cleanText(payload.name, LIMITS.listName);
      if (store.getList(listId)) fail("list id already in use");
      const list = store.createList(listId, me.userId, name);
      pushLists(me.userId);
      return { list };
    });

    on("list:rename", (payload) => {
      const list = ownedList(payload);
      store.renameList(list.listId, cleanText(payload.name, LIMITS.listName));
      pushMembers(list.listId);
      pushLists(...list.members.map((m) => m.userId));
    });

    on("list:delete", (payload) => {
      const list = ownedList(payload);
      if (store.membershipCount(me.userId) <= 1) fail("cannot delete your only list");
      store.deleteList(list.listId);
      for (const m of list.members) {
        evict(list.listId, m.userId, "deleted");
        ensureHasList(m.userId);
      }
      pushLists(...list.members.map((m) => m.userId));
    });

    /* Invite code for "join by code / link". Any member can read it; only the owner can reset it. */
    on("list:share_code", (payload) => {
      const listId = memberListId(payload);
      if (payload.regenerate) ownedList(payload);
      return { code: store.getShareCode(listId, !!payload.regenerate) };
    });

    on("list:join_by_code", (payload) => {
      const now = Date.now();
      const record = joinFails.get(me.userId);
      if (record && now - record.since < JOIN_FAILS_WINDOW_MS && record.count >= JOIN_FAILS_MAX) {
        fail("too many attempts, try again later");
      }
      const listId = store.findListIdByCode(payload.code);
      if (!listId) {
        const fresh = !record || now - record.since >= JOIN_FAILS_WINDOW_MS;
        joinFails.set(me.userId, fresh ? { since: now, count: 1 } : { ...record, count: record.count + 1 });
        fail("invalid code");
      }
      if (!store.addMember(listId, me.userId)) return { listId, already: true };

      const list = store.getList(listId);
      io.to(listRoom(listId)).emit("list:member_joined", { listId, user: me });
      pushMembers(listId);
      pushLists(...list.members.map((m) => m.userId));
      return { listId };
    });

    /* Share directly with a known user id (the original flow). */
    on("share:list", (payload) => {
      const list = ownedList(payload);
      const targetId = typeof payload.targetUserId === "string" ? payload.targetUserId.trim() : "";
      if (targetId === me.userId) fail("you cannot share a list with yourself");
      const target = store.findUserById(targetId);
      if (!target) fail("user not found");
      if (!store.addMember(list.listId, target.userId)) fail("already shared with this user");

      io.to(userRoom(target.userId)).emit("list:shared_notification", {
        listId: list.listId,
        name: list.name,
        from: { userId: me.userId, username: me.username },
      });
      pushLists(target.userId, ...list.members.map((m) => m.userId));
      pushMembers(list.listId);
      return { member: target };
    });

    /* Owner removes someone, or a member leaves a list shared with them. */
    on("list:remove_member", (payload) => {
      const listId = memberListId(payload);
      const list = store.getList(listId);
      const targetId = typeof payload.userId === "string" ? payload.userId : "";
      if (targetId === list.ownerId) fail("the owner cannot leave their own list");
      if (targetId !== me.userId && list.ownerId !== me.userId) fail("only the owner can remove members");
      if (targetId === me.userId && store.membershipCount(me.userId) <= 1) fail("cannot leave your only list");
      if (!store.removeMember(listId, targetId)) fail("user is not a member");

      evict(listId, targetId, targetId === me.userId ? "left" : "removed");
      ensureHasList(targetId);
      pushLists(...list.members.map((m) => m.userId));
      pushMembers(listId);
    });

    on("user:rename", (payload) => {
      const username = cleanText(payload.username, LIMITS.username);
      store.renameUser(me.userId, username);
      me.username = username;
      for (const list of store.getListsForUser(me.userId)) {
        pushMembers(list.listId);
        pushLists(...store.getList(list.listId).members.map((m) => m.userId));
      }
      return { user: me };
    });

    /* ---------- Items ---------- */
    on("item:add", (payload) => {
      const listId = memberListId(payload);
      const src = payload.item || {};
      const itemId = requireId(src.itemId, "itemId");

      // Replay of an add we already stored (outbox resent after a lost ack).
      const existing = store.getItem(listId, itemId);
      if (existing) return { item: existing };

      const text = cleanText(src.text, LIMITS.text);

      // Someone else added the same thing while this client was offline: merge
      // instead of creating a duplicate. The client remaps its id to ours.
      const duplicate = store.findOpenDuplicate(listId, text);
      if (duplicate) return { item: duplicate, mergedInto: duplicate.itemId };

      const item = store.addItem(listId, {
        itemId,
        text,
        category: CATEGORIES.has(src.category) ? src.category : "misc",
        quantity: optionalText(src.quantity, LIMITS.quantity) ?? legacyQuantity(src.qty),
        notes: optionalText(src.notes, LIMITS.notes) ?? "",
      }, me.userId);
      if (!item) fail("item id already in use");
      io.to(listRoom(listId)).emit("item:added", { listId, item });
      return { item };
    });

    /* Field-level update so concurrent edits to different fields don't clobber each other. */
    on("item:update", (payload) => {
      const listId = memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      const c = payload.changes || {};
      const changes = {
        text: c.text === undefined ? undefined : cleanText(c.text, LIMITS.text),
        category: CATEGORIES.has(c.category) ? c.category : undefined,
        quantity: optionalText(c.quantity, LIMITS.quantity),
        notes: optionalText(c.notes, LIMITS.notes),
      };
      const item = store.updateItem(listId, itemId, changes);
      if (item) io.to(listRoom(listId)).emit("item:updated", { listId, item });
      return { missing: !item };
    });

    // v1 clients (and their queued offline ops) still send integer quantity changes.
    on("item:update_qty", (payload) => {
      const listId = memberListId(payload);
      const item = store.updateItem(listId, requireId(payload.itemId, "itemId"), { quantity: legacyQuantity(payload.qty) });
      if (item) io.to(listRoom(listId)).emit("item:updated", { listId, item });
    });

    on("item:toggle", (payload) => {
      const listId = memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      const isCompleted = !!payload.isCompleted;
      const updatedAt = store.setCompleted(listId, itemId, isCompleted);
      if (updatedAt) io.to(listRoom(listId)).emit("item:toggled", { listId, itemId, isCompleted, updatedAt });
      return { missing: !updatedAt };
    });

    on("item:delete", (payload) => {
      const listId = memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      if (store.deleteItem(listId, itemId)) io.to(listRoom(listId)).emit("item:deleted", { listId, itemId });
    });

    on("item:clear_completed", (payload) => {
      const listId = memberListId(payload);
      const itemIds = store.clearCompleted(listId);
      if (itemIds.length) io.to(listRoom(listId)).emit("item:cleared", { listId, itemIds });
    });

    on("list:reset", (payload) => {
      const listId = memberListId(payload);
      const itemIds = store.clearAll(listId);
      if (itemIds.length) io.to(listRoom(listId)).emit("item:cleared", { listId, itemIds });
    });
  });
};
