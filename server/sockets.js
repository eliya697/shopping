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

/*
 * Handshake errors. The message stays "unauthorized" for a definitively unknown
 * token so clients from before this change keep working; new clients look at
 * err.data.code. Anything that is *not* a confirmed database answer is sent as
 * "server_unavailable", which every client treats as "retry later".
 */
function authError(code) {
  const err = new Error("unauthorized");
  err.data = { code };
  return err;
}
function unavailableError() {
  const err = new Error("server_unavailable");
  err.data = { code: "SERVER_UNAVAILABLE", retryAfterMs: 3000 };
  return err;
}

module.exports = function attachSockets(io) {
  /* Every socket must present the secret token it got from /api/register. */
  io.use(async (socket, next) => {
    if (!store.isReady()) return next(unavailableError());
    let user;
    try {
      user = await store.findUserByToken(socket.handshake.auth && socket.handshake.auth.token);
    } catch (err) {
      console.error("[auth] token lookup failed:", err.message);
      return next(unavailableError());
    }
    if (!user) return next(authError("INVALID_TOKEN"));
    socket.data.user = user;
    next();
  });

  /* Push the fresh "lists I belong to" to every device of these users. */
  async function pushLists(...userIds) {
    await Promise.all([...new Set(userIds)].map(async (userId) => {
      io.to(userRoom(userId)).emit("lists:updated", { lists: await store.getListsForUser(userId) });
    }));
  }

  async function pushMembers(listId) {
    const list = await store.getList(listId);
    if (list) io.to(listRoom(listId)).emit("list:members", { listId, ...list });
  }

  /* Nobody should ever end up with zero lists. Deduped per user so two devices connecting at once don't both create one. */
  const ensuring = new Map();
  function ensureHasList(userId) {
    if (ensuring.has(userId)) return ensuring.get(userId);
    const job = (async () => {
      if ((await store.membershipCount(userId)) > 0) return;
      await store.createList(crypto.randomUUID(), userId, null);
      await pushLists(userId);
    })().finally(() => ensuring.delete(userId));
    ensuring.set(userId, job);
    return job;
  }

  /* Remove a user from a list's room on all their devices and tell them. */
  function evict(listId, userId, reason) {
    io.in(userRoom(userId)).socketsLeave(listRoom(listId));
    io.to(userRoom(userId)).emit("list:removed", { listId, reason });
  }

  io.on("connection", (socket) => {
    const me = socket.data.user;
    socket.join(userRoom(me.userId));

    /*
     * Wrap handlers: catch errors and always answer the ack. Failures that are not
     * the client's fault (e.g. a database hiccup) carry retryable: true so the
     * client keeps the operation in its outbox instead of dropping it.
     */
    function on(event, handler) {
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          const result = await handler(payload || {});
          reply({ ok: true, ...(result || {}) });
        } catch (err) {
          if (err instanceof ClientError) return reply({ ok: false, error: err.message });
          console.error(`[${event}]`, err);
          reply({ ok: false, error: "server error", retryable: true });
        }
      });
    }

    async function memberListId(payload) {
      const listId = requireId(payload.listId, "listId");
      if (!(await store.isMember(listId, me.userId))) fail("not a member of this list");
      return listId;
    }

    async function ownedList(payload) {
      const listId = await memberListId(payload);
      const list = await store.getList(listId);
      if (list.ownerId !== me.userId) fail("only the list owner can do this");
      return list;
    }

    /* ---------- Lists ---------- */
    on("join:list", async (payload) => {
      const listId = await memberListId(payload);
      const [list, items] = await Promise.all([store.getList(listId), store.getItems(listId)]);
      for (const room of socket.rooms) {
        if (room.startsWith("list:") && room !== listRoom(listId)) socket.leave(room);
      }
      socket.join(listRoom(listId));
      socket.emit("list:state", { list, items });
    });

    on("list:create", async (payload) => {
      const listId = requireId(payload.listId, "listId");
      const name = cleanText(payload.name, LIMITS.listName);
      if (await store.getList(listId)) fail("list id already in use");
      const list = await store.createList(listId, me.userId, name);
      await pushLists(me.userId);
      return { list };
    });

    on("list:rename", async (payload) => {
      const list = await ownedList(payload);
      await store.renameList(list.listId, cleanText(payload.name, LIMITS.listName));
      await pushMembers(list.listId);
      await pushLists(...list.members.map((m) => m.userId));
    });

    on("list:delete", async (payload) => {
      const list = await ownedList(payload);
      if ((await store.membershipCount(me.userId)) <= 1) fail("cannot delete your only list");
      await store.deleteList(list.listId);
      for (const m of list.members) {
        evict(list.listId, m.userId, "deleted");
        await ensureHasList(m.userId);
      }
      await pushLists(...list.members.map((m) => m.userId));
    });

    /* Invite code for "join by code / link". Any member can read it; only the owner can reset it. */
    on("list:share_code", async (payload) => {
      const listId = await memberListId(payload);
      if (payload.regenerate) await ownedList(payload);
      return { code: await store.getShareCode(listId, !!payload.regenerate) };
    });

    on("list:join_by_code", async (payload) => {
      const now = Date.now();
      const record = joinFails.get(me.userId);
      if (record && now - record.since < JOIN_FAILS_WINDOW_MS && record.count >= JOIN_FAILS_MAX) {
        fail("too many attempts, try again later");
      }
      const listId = await store.findListIdByCode(payload.code);
      if (!listId) {
        const fresh = !record || now - record.since >= JOIN_FAILS_WINDOW_MS;
        joinFails.set(me.userId, fresh ? { since: now, count: 1 } : { ...record, count: record.count + 1 });
        fail("invalid code");
      }
      if (!(await store.addMember(listId, me.userId))) return { listId, already: true };

      const list = await store.getList(listId);
      io.to(listRoom(listId)).emit("list:member_joined", { listId, user: me });
      await pushMembers(listId);
      await pushLists(...list.members.map((m) => m.userId));
      return { listId };
    });

    /* Share directly with a known user id (the original flow). */
    on("share:list", async (payload) => {
      const list = await ownedList(payload);
      const targetId = typeof payload.targetUserId === "string" ? payload.targetUserId.trim() : "";
      if (targetId === me.userId) fail("you cannot share a list with yourself");
      const target = await store.findUserById(targetId);
      if (!target) fail("user not found");
      if (!(await store.addMember(list.listId, target.userId))) fail("already shared with this user");

      io.to(userRoom(target.userId)).emit("list:shared_notification", {
        listId: list.listId,
        name: list.name,
        from: { userId: me.userId, username: me.username },
      });
      await pushLists(target.userId, ...list.members.map((m) => m.userId));
      await pushMembers(list.listId);
      return { member: target };
    });

    /* Owner removes someone, or a member leaves a list shared with them. */
    on("list:remove_member", async (payload) => {
      const listId = await memberListId(payload);
      const list = await store.getList(listId);
      const targetId = typeof payload.userId === "string" ? payload.userId : "";
      if (targetId === list.ownerId) fail("the owner cannot leave their own list");
      if (targetId !== me.userId && list.ownerId !== me.userId) fail("only the owner can remove members");
      if (targetId === me.userId && (await store.membershipCount(me.userId)) <= 1) fail("cannot leave your only list");
      if (!(await store.removeMember(listId, targetId))) fail("user is not a member");

      evict(listId, targetId, targetId === me.userId ? "left" : "removed");
      await ensureHasList(targetId);
      await pushLists(...list.members.map((m) => m.userId));
      await pushMembers(listId);
    });

    on("user:rename", async (payload) => {
      const username = cleanText(payload.username, LIMITS.username);
      await store.renameUser(me.userId, username);
      me.username = username;
      for (const list of await store.getListsForUser(me.userId)) {
        await pushMembers(list.listId);
        const full = await store.getList(list.listId);
        await pushLists(...full.members.map((m) => m.userId));
      }
      return { user: me };
    });

    /* ---------- Items ---------- */
    on("item:add", async (payload) => {
      const listId = await memberListId(payload);
      const src = payload.item || {};
      const itemId = requireId(src.itemId, "itemId");

      // Replay of an add we already stored (outbox resent after a lost ack).
      const existing = await store.getItem(listId, itemId);
      if (existing) return { item: existing };

      const text = cleanText(src.text, LIMITS.text);

      // Someone else added the same thing while this client was offline: merge
      // instead of creating a duplicate. The client remaps its id to ours.
      const duplicate = await store.findOpenDuplicate(listId, text);
      if (duplicate) return { item: duplicate, mergedInto: duplicate.itemId };

      const item = await store.addItem(listId, {
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
    on("item:update", async (payload) => {
      const listId = await memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      const c = payload.changes || {};
      const changes = {
        text: c.text === undefined ? undefined : cleanText(c.text, LIMITS.text),
        category: CATEGORIES.has(c.category) ? c.category : undefined,
        quantity: optionalText(c.quantity, LIMITS.quantity),
        notes: optionalText(c.notes, LIMITS.notes),
      };
      const item = await store.updateItem(listId, itemId, changes);
      if (item) io.to(listRoom(listId)).emit("item:updated", { listId, item });
      return { missing: !item };
    });

    // v1 clients (and their queued offline ops) still send integer quantity changes.
    on("item:update_qty", async (payload) => {
      const listId = await memberListId(payload);
      const item = await store.updateItem(listId, requireId(payload.itemId, "itemId"), { quantity: legacyQuantity(payload.qty) });
      if (item) io.to(listRoom(listId)).emit("item:updated", { listId, item });
    });

    on("item:toggle", async (payload) => {
      const listId = await memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      const isCompleted = !!payload.isCompleted;
      const updatedAt = await store.setCompleted(listId, itemId, isCompleted);
      if (updatedAt) io.to(listRoom(listId)).emit("item:toggled", { listId, itemId, isCompleted, updatedAt });
      return { missing: !updatedAt };
    });

    on("item:delete", async (payload) => {
      const listId = await memberListId(payload);
      const itemId = requireId(payload.itemId, "itemId");
      if (await store.deleteItem(listId, itemId)) io.to(listRoom(listId)).emit("item:deleted", { listId, itemId });
    });

    on("item:clear_completed", async (payload) => {
      const listId = await memberListId(payload);
      const itemIds = await store.clearCompleted(listId);
      if (itemIds.length) io.to(listRoom(listId)).emit("item:cleared", { listId, itemIds });
    });

    on("list:reset", async (payload) => {
      const listId = await memberListId(payload);
      const itemIds = await store.clearAll(listId);
      if (itemIds.length) io.to(listRoom(listId)).emit("item:cleared", { listId, itemIds });
    });

    /*
     * Session setup runs after the handlers are registered, so nothing the client
     * sends right after "connect" is lost while we wait on the database.
     * If it fails (transient DB error) we drop the socket; the client reconnects.
     */
    (async () => {
      await ensureHasList(me.userId);
      socket.emit("session", { user: me, lists: await store.getListsForUser(me.userId) });
      store.touchUser(me.userId).catch((err) => console.error("[touchUser]", err.message));
    })().catch((err) => {
      console.error("[session]", err);
      socket.disconnect(true);
    });
  });

  /* Used by the admin API to keep connected clients in sync with its changes. */
  return {
    connectionCount: () => io.of("/").sockets.size,

    /* A list was deleted by the admin: evict its members and make sure they still have a list. */
    async listDeleted(list) {
      for (const m of list.members) {
        evict(list.listId, m.userId, "deleted");
        await ensureHasList(m.userId);
      }
      await pushLists(...list.members.map((m) => m.userId));
    },

    /* A user was deleted by the admin: notify everyone who shared lists with them, then drop their sockets. */
    async userDeleted({ user, deletedLists, leftLists }) {
      for (const list of deletedLists) {
        await this.listDeleted({ ...list, members: list.members.filter((m) => m.userId !== user.userId) });
      }
      for (const listId of leftLists) {
        await pushMembers(listId);
        const list = await store.getList(listId);
        if (list) await pushLists(...list.members.map((m) => m.userId));
      }
      // On reconnect their token is rejected with INVALID_TOKEN and the app signs out cleanly.
      io.in(userRoom(user.userId)).disconnectSockets(true);
    },

    /* Checked items were purged by the cleanup job. */
    itemsPurged(byList) {
      for (const [listId, itemIds] of Object.entries(byList)) {
        io.to(listRoom(listId)).emit("item:cleared", { listId, itemIds });
      }
    },
  };
};
