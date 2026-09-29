"use strict";

const store = require("./db");

const CATEGORIES = new Set(["produce", "dairy", "meat", "pantry", "cleaning", "misc"]);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

function cleanQty(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 1;
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
    for (const userId of userIds) {
      io.to(userRoom(userId)).emit("lists:updated", { lists: store.getListsForUser(userId) });
    }
  }

  function pushMembers(listId) {
    const list = store.getList(listId);
    if (list) io.to(listRoom(listId)).emit("list:members", { listId, members: list.members, ownerId: list.ownerId });
  }

  io.on("connection", (socket) => {
    const me = socket.data.user;
    socket.join(userRoom(me.userId));
    socket.emit("session", { user: me, lists: store.getListsForUser(me.userId) });

    /* Wrap handlers: validate membership, catch errors, always answer the ack. */
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

    on("join:list", (payload) => {
      const listId = memberListId(payload);
      for (const room of socket.rooms) {
        if (room.startsWith("list:") && room !== listRoom(listId)) socket.leave(room);
      }
      socket.join(listRoom(listId));
      socket.emit("list:state", { list: store.getList(listId), items: store.getItems(listId) });
    });

    on("share:list", (payload) => {
      const listId = memberListId(payload);
      const list = store.getList(listId);
      if (list.ownerId !== me.userId) fail("only the list owner can share it");
      const targetId = typeof payload.targetUserId === "string" ? payload.targetUserId.trim() : "";
      if (targetId === me.userId) fail("you cannot share a list with yourself");
      const target = store.findUserById(targetId);
      if (!target) fail("user not found");
      if (!store.addMember(listId, target.userId)) fail("already shared with this user");

      io.to(userRoom(target.userId)).emit("list:shared_notification", {
        listId,
        from: { userId: me.userId, username: me.username },
      });
      pushLists(target.userId, ...list.members.map((m) => m.userId));
      pushMembers(listId);
      return { member: target };
    });

    /* Owner removes someone, or a member leaves a list shared with them. */
    on("list:remove_member", (payload) => {
      const listId = memberListId(payload);
      const list = store.getList(listId);
      const targetId = typeof payload.userId === "string" ? payload.userId : "";
      if (targetId === list.ownerId) fail("the owner cannot leave their own list");
      if (targetId !== me.userId && list.ownerId !== me.userId) fail("only the owner can remove members");
      if (!store.removeMember(listId, targetId)) fail("user is not a member");

      io.in(userRoom(targetId)).socketsLeave(listRoom(listId));
      io.to(userRoom(targetId)).emit("list:removed", { listId });
      pushLists(...list.members.map((m) => m.userId));
      pushMembers(listId);
    });

    on("user:rename", (payload) => {
      const username = cleanText(payload.username, 30);
      store.renameUser(me.userId, username);
      me.username = username;
      for (const list of store.getListsForUser(me.userId)) pushMembers(list.listId);
      return { user: me };
    });

    on("item:add", (payload) => {
      const listId = memberListId(payload);
      const src = payload.item || {};
      const category = CATEGORIES.has(src.category) ? src.category : "misc";
      const item = store.addItem(listId, {
        itemId: requireId(src.itemId, "itemId"),
        text: cleanText(src.text, 80),
        category,
        qty: cleanQty(src.qty),
      }, me.userId);
      if (!item) fail("item id already in use");
      io.to(listRoom(listId)).emit("item:added", { listId, item });
      return { item };
    });

    on("item:toggle", (payload) => {
      const listId = memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      const isCompleted = !!payload.isCompleted;
      const updatedAt = store.setCompleted(listId, itemId, isCompleted);
      if (updatedAt) io.to(listRoom(listId)).emit("item:toggled", { listId, itemId, isCompleted, updatedAt });
    });

    on("item:update_qty", (payload) => {
      const listId = memberListId(payload);
      const item = store.setQty(listId, requireId(payload.itemId, "itemId"), cleanQty(payload.qty));
      if (item) io.to(listRoom(listId)).emit("item:updated", { listId, item });
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
