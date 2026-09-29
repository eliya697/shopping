# 🛒 Shopping List PWA

An offline-first shopping list (Hebrew, RTL) with multiple real-time shared lists, smart supermarket sorting, quick-add, voice input and in-app update prompts.

- **Frontend:** vanilla JS, served from GitHub Pages
- **Backend:** Node.js + Express + Socket.io + libSQL/**Turso** (hosted SQLite; a local file in development), hosted on Render

## Features

| | |
|---|---|
| **Multiple lists** | Create lists (“קניות שבועיות”, “בית מרקחת”, “ארוחת שבת”…), switch from the title in the header, rename or delete them. |
| **Sharing** | Invite by **link or 8-character code** (`?join=ABCD2345`), or by user ID. Members, joins, renames and deletions sync live. |
| **Quantity & notes** | Free-text quantity (“3”, “1 ק״ג”, “2 חבילות”) and notes (“אורגני בלבד”). Tap an item to edit. The row shows a small quantity pill and a one-line note. |
| **Smart categories** | 11 supermarket sections, auto-detected from the name. The head noun wins (“מיץ תפוזים” → drinks), and corrections you make are remembered. |
| **Store layout** | 🧭 toggle groups the list by aisle along a walking path: produce first, chilled and frozen last so they stay cold. ⚙️ reorders the aisles for your store. |
| **Quick add** | Chips above the input while typing, plus a ⚡ drawer. Ranked by how often and how recently you added each item, favoring items from the current list. |
| **Offline-first** | Every change is queued locally and replayed on reconnect. The header pill shows *מחובר* / *מסנכרן 3…* / *לא מקוון · 3 ממתינים*. |
| **Voice** | 🎤 → “תוסיף שני קילו עגבניות, חלב ונייר טואלט” → three items (with “2 ק״ג”), with an **undo** button. |

Typed input understands quantities too: `2 חלב`, `חלב x2`, `חצי קילו גבינה`, and comma-separated lists.

## Project structure

```
shop app/
├── index.html              # UI: list, sheets (lists, item, share, quick-add, aisle order), update banner
├── style.css
├── app.js                  # state, rendering (keyed DOM patching), actions, sync wiring
├── categories.js           # supermarket sections, auto-categorize, default walking order
├── item-parser.js          # "2 ק״ג עגבניות" and dictated lists -> items
├── quick-add.js            # purchase history + frequency/recency ranking
├── voice.js                # Web Speech API wrapper
├── socket-client.js        # SyncClient: reconnection, persisted outbox, id remapping
├── pwa-update.js           # SW registration + "new version available" banner
├── sw.js                   # service worker (versioned precache, SKIP_WAITING)
├── config.js               # BACKEND_URL
├── admin.html / admin.js   # hidden admin dashboard (developer only)
├── vendor/socket.io.min.js # Socket.io client (same-origin, so it works offline)
├── tests/parser.test.js    # categorizer + parser tests:  node tests/parser.test.js
├── .github/workflows/deploy.yml  # Pages deploy; stamps a new version into sw.js
├── render.yaml             # Render blueprint for the backend
└── server/
    ├── server.js           # Express app, CORS, /health, /api/register, /api/me
    ├── sockets.js          # Socket.io auth + events
    ├── admin.js            # /api/admin/* (login, health, users, lists, cleanup, export)
    ├── db.js               # libSQL/Turso schema, additive migrations, queries
    └── test/               # end-to-end socket tests:  npm test  (server must be running)
```

## How it works

### Identity

`POST /api/register { username }` returns three things:

| Value | Public? | Purpose |
|---|---|---|
| `userId` (UUID v4) | ✅ share it | Others can share a list with you by ID |
| `token` (256-bit random) | ❌ secret | Authenticates the socket; shown in the app as the **device link code** |
| `listId` | – | Your first list, created with the account |

The server stores only a SHA-256 hash of the token. To use the same account on a second device, go to **Share → Another device**, copy the link code, and on the new device pick **"I already have an account"**.

### Data model (SQLite dialect, stored in Turso)

- `users(user_id, username, token_hash, created_at, last_seen_at)`
- `lists(list_id, owner_id, name, share_code, created_at)`
- `list_members(list_id, user_id, joined_at)` is the members array, stored as a join table
- `items(item_id, list_id, text, category, quantity, notes, is_completed, added_by, created_at, updated_at)`

`db.js` connects to Turso when `TURSO_DATABASE_URL` is set, otherwise to `server/data/shopping.db`. It migrates older databases on startup with additive `ALTER TABLE`s only. The old integer `qty` becomes the text `quantity`, and the migration is safe to re-run.

### Socket events

Client → server calls all take an ack callback `{ ok, error? }`.

| Client emits | Server sends |
|---|---|
| `join:list { listId }` | `list:state { list, items }` to the caller |
| `list:create { listId, name }` | `lists:updated` to your devices |
| `list:rename { listId, name }` *(owner)* | `list:members` (includes `name`), `lists:updated` |
| `list:delete { listId }` *(owner)* | `list:removed { reason: "deleted" }` to every member |
| `list:share_code { listId, regenerate? }` | ack `{ code }`; only the owner can regenerate |
| `list:join_by_code { code }` | `list:member_joined`, `list:members`, `lists:updated` |
| `share:list { listId, targetUserId }` *(owner)* | `list:shared_notification` to the target, `list:members`, `lists:updated` |
| `list:remove_member { listId, userId }` | `list:removed { reason }` to that user, `list:members` |
| `item:add { listId, item }` | `item:added`, or ack `{ mergedInto }` for a duplicate (see below) |
| `item:update { listId, itemId, changes }` | `item:updated`; only the fields you send change |
| `item:toggle { listId, itemId, isCompleted }` | `item:toggled` |
| `item:delete { listId, itemId }` | `item:deleted` |
| `item:clear_completed` / `list:reset { listId }` | `item:cleared { itemIds }` |
| `user:rename { username }` | `list:members` |

Every write checks list membership. Nobody can end up with zero lists: you can't delete or leave your only list, and a user removed from their last list gets a fresh one. Wrong invite codes are rate-limited per user (10 per 10 minutes).

**Backward compatibility:** clients still running v1 (before they tap *Update*) keep working. The server still accepts `item:update_qty` and integer `qty`, and it sends `qty` alongside `quantity`.

### Offline-first sync and conflicts

- Every change applies to the screen immediately and goes into a **persisted outbox** (`localStorage`). The outbox is sent in order, with acks, whenever the socket is up. It survives reloads, dead zones and Render cold starts.
- Replays are safe: ids are generated on the client, adds are idempotent, and toggles and edits send absolute values.
- **Field-level edits:** `item:update` sends only the changed fields. So if one person changes the quantity while another adds a note, both edits survive.
- **Duplicate merge:** two people add “חלב” while offline. The second add to reach the server is merged into the existing open item instead of creating a duplicate. The server answers `{ mergedInto }`, and the client points its queued edits and check-offs for that item at the surviving id, then shows a toast.
- **Edits to deleted items** are ignored (`{ missing: true }`). Ops for a list you were removed from are dropped, and the client re-syncs.
- While the outbox holds unacknowledged changes for an item, echoes for that item are ignored, so the screen doesn't flicker. After the flush, a fresh `list:state` settles everything.
- List management (create, rename, delete, invite, join) needs a connection and says so when offline. Item actions all work offline.

### Cold starts and sign-out rules

The server listens right away and connects to the database in the background, retrying until it answers. The app only signs out on a **confirmed** answer from the database:

| Handshake result | `err.data.code` | App behaviour |
|---|---|---|
| Token not in the database | `INVALID_TOKEN` (message `unauthorized`) | Sign out, keep items as a local list |
| Account blocked | `USER_BANNED` | Sign out |
| Database not connected yet / query failed | `SERVER_UNAVAILABLE` (message `server_unavailable`) | Stay signed in, show *השרת מתעורר*, retry with backoff |
| Network error / timeout | – | Stay signed in, Socket.io retries |

Server-side failures during a call answer `{ ok: false, retryable: true }`. The outbox keeps those operations and retries them, and a failed `join:list` never makes the app forget a list.

### Admin dashboard

`admin.html` isn't linked from the app. Log in with the admin email and `ADMIN_SECRET_KEY`. You get a 12-hour HMAC-signed session token, stored in `localStorage` and sent as `Authorization: Bearer …`. Failed logins are limited to 5 per 15 minutes per IP.

| Endpoint | |
|---|---|
| `POST /api/admin/login` | `{ email, secretKey }` → `{ token, expiresAt }` |
| `GET /api/admin/health` | uptime, memory, active sockets, DB status/latency/size/counts |
| `GET /api/admin/users` · `DELETE /api/admin/users/:id` | users with last activity and list ids; deleting removes their owned lists and memberships and disconnects them |
| `GET /api/admin/lists` · `DELETE /api/admin/lists/:id` | lists with item/member counts; members are evicted live |
| `POST /api/admin/cleanup` | permanently deletes items checked more than 14 days ago |
| `GET /api/admin/export` | full JSON backup of every table (includes token hashes, so keep it private) |

### Voice input

This uses the browser's `SpeechRecognition` in `he-IL`. The mic button only appears where it's supported: Chrome, Edge, Android and Safari 14.5+, but not Firefox. The parser:
- strips command words (תוסיף / צריך / add…),
- splits on commas, “וגם” and a leading “ו” before a known item,
- reads number words and units into the quantity,
- keeps descriptive words with their item (“שמן זית”).

Multi-word items it already knows about (from your history) stay together. Note: in Chrome, speech is processed by Google's speech service.

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
   | `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` (see below) |
   | `TURSO_AUTH_TOKEN` | the database token from `turso db tokens create` |
   | `ADMIN_SECRET_KEY` | 16+ random characters; enables `admin.html` |

   `PORT` is set by Render automatically.
4. After the deploy, open `https://<your-service>.onrender.com/health` and check that it returns `{"ok":true,...}`.

> ⚠️ **Persistence:** Render's free plan has an ephemeral disk that is wiped whenever the instance spins down, so the data lives in **Turso** instead. Create the database once:
>
> ```bash
> turso auth signup            # or: turso auth login
> turso db create shopping-list
> turso db show shopping-list --url      # -> TURSO_DATABASE_URL
> turso db tokens create shopping-list   # -> TURSO_AUTH_TOKEN
> ```
>
> The schema is created automatically on first start. Without `TURSO_DATABASE_URL` the server falls back to a local file and logs a warning, and the admin dashboard shows *"קובץ מקומי"*.

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
cd server && npm install && npm run dev      # backend on http://localhost:3000 (reads server/.env, see .env.example)
cd server && npm test                        # socket tests against the running backend
node tests/parser.test.js                    # parser/categorizer tests
python -m http.server 5173                   # frontend on http://localhost:5173
```

On `localhost` / `127.0.0.1` the app talks to `http://localhost:3000` automatically, and the server always allows localhost origins. To try sharing, open the app on both `localhost:5173` and `127.0.0.1:5173`. They are different origins, so they act as two separate users.

To test the update banner locally, change `__BUILD_VERSION__` in `sw.js` to any other string and reload (or refocus) the page. Change it back before committing.
