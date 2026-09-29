# 🛒 Shopping List PWA

An offline-first shopping list (Hebrew, RTL) with accounts, real-time shared lists and in-app update prompts.

- **Frontend:** vanilla JS, served from GitHub Pages
- **Backend:** Node.js + Express + Socket.io + SQLite (`better-sqlite3`), hosted on Render (or Railway / Fly.io)

## Project structure

```
shop app/
├── index.html              # UI: list, share/account modal, welcome modal, update banner
├── style.css
├── app.js                  # state, rendering (keyed DOM patching), actions, sync wiring
├── socket-client.js        # SyncClient: reconnection, persisted outbox, event forwarding
├── pwa-update.js           # SW registration + "new version available" banner
├── sw.js                   # service worker (versioned precache, SKIP_WAITING)
├── config.js               # BACKEND_URL  ← set this after deploying the server
├── vendor/socket.io.min.js # Socket.io client (same-origin, so it works offline)
├── manifest.json, icon.svg
├── .github/workflows/deploy.yml  # Pages deploy; stamps a new version into sw.js
├── render.yaml             # Render blueprint for the backend
└── server/
    ├── package.json
    ├── server.js           # Express app, CORS, /health, /api/register, /api/me
    ├── sockets.js          # Socket.io auth + events
    └── db.js               # SQLite schema and queries
```

## How it works

### Identity

`POST /api/register { username }` returns three things:

| Value | Public? | Purpose |
|---|---|---|
| `userId` (UUID v4) | ✅ share it | Others enter it to share a list with you |
| `token` (256-bit random) | ❌ secret | Authenticates the socket; shown in the app as the **device link code** |
| `listId` | – | Your personal list, created with the account |

The userId is public, so it can't also be the credential. Otherwise anyone you shared your ID with could sign in as you. The server stores only a SHA-256 hash of the token.

To use the same account on a second device, go to **Share & account → Another device**, copy the link code, and on the new device pick **"I already have an account"**.

### Data model (SQLite)

- `users(user_id, username, token_hash, created_at)`
- `lists(list_id, owner_id, created_at)`
- `list_members(list_id, user_id, joined_at)` is the `members` array, stored as a join table
- `items(item_id, list_id, text, category, qty, is_completed, added_by, created_at, updated_at)`

### Socket events

Client → server calls all take an ack callback `{ ok, error? }`.

| Client emits | Server broadcasts to room `list:<listId>` |
|---|---|
| `join:list { listId }` | `list:state { list, items }` (to the caller) |
| `share:list { listId, targetUserId }` | `list:members` + `list:shared_notification` to the target, `lists:updated` |
| `list:remove_member { listId, userId }` | `list:members`, `list:removed` to that user |
| `item:add { listId, item }` | `item:added` |
| `item:toggle { listId, itemId, isCompleted }` | `item:toggled` |
| `item:update_qty { listId, itemId, qty }` | `item:updated` |
| `item:delete { listId, itemId }` | `item:deleted` |
| `item:clear_completed { listId }` | `item:cleared { itemIds }` |
| `list:reset { listId }` | `item:cleared { itemIds }` |
| `user:rename { username }` | `list:members` |

Every write checks list membership. Only the owner can share or remove members, and a member can leave.

### Offline and reconnection

- Changes apply to the screen immediately and go into a **persisted outbox** (`localStorage`). The outbox is sent in order, with acks, whenever the socket is connected, so edits made offline or during a Render cold start survive a reload.
- Replaying is safe: item ids are generated on the client, adds are `INSERT OR IGNORE`, and toggle/qty send absolute values.
- On every (re)connect the client flushes the outbox, then re-joins the list and gets a fresh `list:state`.
- A sleeping Render instance is woken with a `/health` request. Reconnection backs off up to 15s, and the app reconnects right away when the network or the tab comes back. The status dot next to your ID shows 🟢 online / 🟠 connecting / ⚪ offline.
- The last state of each list is cached, so the list shows instantly and works with no connection at all.

### PWA updates

1. Each deploy through `deploy.yml` replaces `__BUILD_VERSION__` in `sw.js` with the commit SHA, so every deploy changes `sw.js`.
2. The browser installs the new worker, which **waits** (it no longer calls `skipWaiting` on install).
3. `pwa-update.js` notices (`updatefound` → `installed` while a controller exists) and shows **"🚀 גרסה חדשה זמינה! [עדכן עכשיו]"**.
4. Tapping it posts `{ action: 'SKIP_WAITING' }`. The new worker activates, `controllerchange` fires, and the page reloads once.

The app checks for updates on load, when the app returns to the foreground, and every 30 minutes. `sw.js` is fetched with `updateViaCache: 'none'` and precached with `cache: 'reload'`, so GitHub Pages' 10-minute HTTP cache can't hold an update back.

Users on the old version (cache `shopping-list-v2`) have no banner code yet, so the new worker takes over immediately **one time only**. After that, every update goes through the banner.

---

## Deployment

### 1. Deploy the backend to Render

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint**, pick the repo, and Render reads `render.yaml`.
   *Or do it by hand:* **New → Web Service** with these settings:
   - Root Directory: `server`
   - Build Command: `npm ci`
   - Start Command: `node server.js`
   - Health Check Path: `/health`
3. Environment variables:

   | Key | Value |
   |---|---|
   | `ALLOWED_ORIGINS` | `https://eliya697.github.io` (origin only, **no** `/shopping` path; comma-separate extra origins) |
   | `NODE_VERSION` | `24` |
   | `DB_PATH` | *(optional)* e.g. `/var/data/shopping.db` on a persistent disk |

   `PORT` is set by Render automatically.
4. After the deploy, open `https://<your-service>.onrender.com/health` and check that it returns `{"ok":true,...}`.

> ⚠️ **Persistence on Render's free plan:** free web services have an **ephemeral filesystem**. The SQLite file is wiped on every redeploy/restart, and free instances also restart after spinning down. SQLite alone does not make data survive there. Options:
> - **Render Starter + persistent disk:** uncomment the `disk` block in `render.yaml` and set `DB_PATH=/var/data/shopping.db`.
> - **Railway:** attach a Volume mounted at `/data` and set `DB_PATH=/data/shopping.db`.
> - **Fly.io:** `fly volumes create data`, mount it at `/data`, and set `DB_PATH=/data/shopping.db`.
>
> If the database is reset anyway, the app notices (the saved token is rejected), keeps the items on screen as a local list, and offers to create a new account.

### 2. Point the frontend at the backend

Edit `config.js`:

```js
BACKEND_URL: isLocal ? "http://localhost:3000" : "https://<your-service>.onrender.com",
```

With `BACKEND_URL` empty, the app runs exactly as before: local-only, with no account UI.

### 3. Deploy the frontend to GitHub Pages

1. On GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions** (instead of "Deploy from a branch").
2. Commit and push to `main`. The **Deploy to GitHub Pages** workflow publishes the site (without `server/`) and stamps the service worker version.
3. Open `https://eliya697.github.io/shopping/`. Every later push makes installed copies show the update banner.

## Local development

```bash
cd server && npm install && npm run dev      # backend on http://localhost:3000
python -m http.server 5173                   # frontend on http://localhost:5173
```

On `localhost` / `127.0.0.1` the app talks to `http://localhost:3000` automatically, and the server always allows localhost origins. To try sharing, open the app on both `localhost:5173` and `127.0.0.1:5173`. They are different origins, so they act as two separate users.

To test the update banner locally, change `__BUILD_VERSION__` in `sw.js` to any other string and reload (or refocus) the page. Change it back before committing.
