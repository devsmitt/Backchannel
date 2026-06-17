# Backchannel

> A builder community you can only be present in while your agent is working.

When you fire a prompt at an agentic coding tool, there's dead time — twenty seconds to thirty minutes — while it builds. That time is involuntary, recurring, and unowned. Backchannel claims it.

It's a small, persistent, dark-mode chat for developers. Your tab is **dark unless your agent is building**. The moment it starts, you fade into the rooms — with their real history — alongside other builders who are *also* mid-build right now. When your build finishes, you drop to **building** (heads-down, recently active) and then to **offline**. The agent never enters the room; it only holds the door open by being busy on your behalf.

This is the anti-Discord. You cannot lurk all day. There is no "online all the time." You can only *talk* in your own dead-time, in the cracks of real work, next to other people in theirs. The gate isn't a limitation bolted onto a chat app — **the gate *is* the product**, and the same gated activity quietly becomes your builder résumé (see [The gate is the meter](#the-gate-is-the-meter)).

No AI participants. No bots. No model calls anywhere in the stack. Real usernames, real history, real builders.

---

## What's new in v2

v1 was the gate: dark tab, three channels, message history, hardened token identity. v2 keeps all of that and adds the social and credential layer around it:

- **Three presence states** — `active` / `building` / `offline` — instead of a binary present/absent.
- **Native builder status** earned purely from gated build activity: streak, total builds, build-time, tenure. No GitHub, no OAuth, no points or badges.
- **Builder profiles** with a tagline and a list of projects you add.
- **Rooms as one primitive** — open channels plus on-demand **DMs and groups**.
- **A "who's building" roster** in the left rail with live presence and ambient streak marks.
- **Retention** — messages older than the retention window (default 6h) are pruned.

---

## Presence states — the soul

Every user is in exactly one of three states, computed server-side and broadcast to everyone:

| State | Meaning | How you get there |
|---|---|---|
| **active** | Present *right now* — your agent is working, so you're live in Backchannel. You can read and post. | `POST /enter` |
| **building** | Not present, but last active **less than `BUILDING_WINDOW`** ago (default 30 min). You're heads-down between prompts. Read-only. | `POST /exit`, or any recent `enter` that has lapsed |
| **offline** | Last active **`BUILDING_WINDOW` or longer** ago. | time passes |

The roster in the left rail shows all three. `active` and `building` are listed by handle (with tagline + ambient streak mark); `offline` may collapse to a count you can expand.

**How the states flip:**

- `POST /enter` → you go **active**, presence + roster re-broadcast to everyone.
- `POST /exit` → you go **building**, `last_active` recorded, presence + roster re-broadcast.
- A periodic **sweep** (every `SWEEP_MS`, default 60s) flips stale `building` users to `offline` and re-broadcasts the roster, so the rail stays honest even if no one sends anything.

**Posting is gated on `active`.** Being signed in — even being `building` — is not enough. The server refuses `say` at the protocol layer unless you're present. You can *catch up* on history while building or offline; you can only *talk* while building-for-real.

---

## The gate is the meter

The mechanic that limits you is the same mechanic that credits you. Every gated `enter`/`exit` we already see is mined for a **native builder status** — no external accounts, no self-reported stats:

- **streak_days** — consecutive UTC days with at least one `enter`. Build today after building yesterday → streak +1; skip a day → resets to 1; multiple builds same day → no change.
- **total_builds** — count of `enter` events.
- **build_seconds** — summed active durations. On `exit` we add `min(now − enterTime, CAMP_CEILING)`, so a forgotten session can't inflate your time past the ceiling.
- **tenure** — `users.created_at`: "building here since …".

This is **credential energy, not a game.** Status shows up *ambiently* (a quiet streak mark next to your handle in the roster) and *fully* on your profile. There are deliberately **no points, badges, confetti, or leaderboards** — the number that matters is just: you keep showing up and shipping.

---

## Builder profiles

Click any handle to open its profile. It shows:

- handle and **"building here since"** (tenure)
- streak, total builds, total build-time
- the user's **tagline**
- a list of **projects** (name + optional URL + short blurb)

Your own profile is **editable**: set your tagline, add and remove projects. DMs and groups start from the same roster — click a person to open one.

**Safety (all user text):** everything is rendered as **text, never HTML** (escaped on output). Caps are enforced: tagline ≤ 80 chars, project name ≤ 80, blurb ≤ 200, URL ≤ 200 and must start `http://` or `https://` (otherwise it's shown as plain text, not a link). Max **6 projects per user**.

---

## Rooms, DMs, and groups — one primitive

Every conversation is a **room** with a `type`:

- **`channel`** — open to everyone. Seeded on first boot: `#general`, `#help`, `#what-are-you-building`.
- **`dm`** — a private room between two people, created on demand from the roster.
- **`group`** — a DM with more than two members (multi-member DM).

DMs and groups are just rooms with explicit membership (`room_members`), created the first time you open one. The **same** say/history path serves all three; `dm` and `group` are membership-gated, so non-members can't read or post.

---

## Retention

Messages are **pruned after `RETENTION_MS`** (default 6h) — both at startup and on the periodic sweep. Backchannel is a real backlog for the recent past, not a permanent archive: enough history to catch up on what's happening *now*, then it ages out.

---

## Works with your tools

Presence is gated the same way no matter how you build — one install covers all of them:

- **Claude Code** — **native hooks** (precise). `UserPromptSubmit` → `/enter`, `Stop` → `/exit`, wired straight into `~/.claude/settings.json`. The gate opens exactly when a prompt starts and closes exactly when it stops.
- **Other CLI agents + raw terminal** — **shell integration** (one install). A sourced snippet (`adapters/shell/backchannel.sh`) watches your shell and fires the same `/enter`/`/exit` pings when you run another agent (`codex`, `aider`, `gemini`, `llm`, `goose`, `opencode` — configurable via `BACKCHANNEL_AGENTS`; `claude` is deliberately excluded since it has the native hooks above). Optionally set `BACKCHANNEL_WATCH_ALL=1` to also light up for any command running longer than `BACKCHANNEL_WATCH_SECONDS` (default 30). Works in **zsh** and **bash**; every ping is a backgrounded `curl --max-time 2`, so your prompt never blocks.
- **Cursor** — see [`adapters/cursor/`](adapters/cursor/) for editor-status integration.

Every integration sends **only your token** (read from `~/.config/backchannel/token`); the server resolves your username from its hash. Nothing else — no username, never a URL.

---

## Quickstart

One command. It claims a username, wires the enter/exit hooks into Claude Code, installs the shell integration for other CLI agents, then **opens your browser already signed in** — no token to copy or paste.

```sh
curl -fsSL https://backchannel.example/install.sh | sh
```

The installer will:

1. **Ask for a username** — 2–24 chars, `[a-z0-9_-]`, lowercased. Reprompts if it's taken.
2. **Generate a secret token** and a **recovery phrase** (random words). It prints the recovery phrase once — **save it**, it's the only way to get your username back if you lose the token.
3. **Wire two hooks** into `~/.claude/settings.json` (backed up first, merged without clobbering): `UserPromptSubmit` → enter, `Stop` → exit. **Each hook sends only your token** — nothing else.
4. **Install the shell integration** for non-Claude CLI agents and raw terminal: it writes the server origin to `~/.config/backchannel/server`, drops `backchannel.sh` into `~/.config/backchannel/`, and adds a single guarded `source` line to your `~/.zshrc` or `~/.bashrc` (idempotent — re-runs never duplicate it). See [Works with your tools](#works-with-your-tools).
5. **Open the web client signed in.** It mints a one-time pairing code (8 chars, 5-min TTL) and opens `…/?pair=<code>`; the browser redeems it for your token, stores it in `localStorage` (`backchannel-token`), and strips the code from the URL. Your long token **never travels in a URL**.

If no browser launcher is found (or the network call fails), the installer falls back to printing the sign-in URL and your token to paste manually. Your token always lives at `~/.config/backchannel/token` too.

**Leave the tab open.** When you're not building you get a calm "you're not in the channel — it opens when your agent runs" state, not a black void. Kick off any prompt in Claude Code and the rooms fade in.

---

## How it works

**The gate is enforced by hooks, not honor.** Claude Code fires `UserPromptSubmit` when you send a prompt and `Stop` when it finishes. The installer wires each to a tiny backgrounded `curl` (capped at ~2 seconds, so Claude Code never blocks):

- `UserPromptSubmit` → `POST /enter` → server marks you **active**, updates `last_active`, bumps `total_builds` + streak, starts the camping timer, and broadcasts presence + roster. The rooms fade in.
- `Stop` → `POST /exit` → server marks you **building**, records `last_active`, adds `build_seconds`, and broadcasts presence + roster. The tab fades back, the composer goes dead.

Each hook sends **only your token**. The server resolves your username from it. While you're `active` you can read and post; otherwise the server **refuses your messages at the protocol layer** — being signed in is not enough, you have to be building.

**History persists (within the window).** Every message is written to **SQLite**. When you join a room you get its recent history (the catch-up), then live messages stream in over a WebSocket. Messages older than `RETENTION_MS` are pruned.

**The agent never enters.** It has no presence, no username, no voice in the rooms. Its only role is lifecycle: its work opens and closes the door for *you*. There are no AI participants anywhere — no roaming agents, no bots, no model calls in the server or client.

**Camping has a ceiling.** Presence is honor-system at the access layer (we can't truly prove your agent is busy), and that's accepted. The one abuse worth stopping server-side is silent permanent camping, so every `enter` (re)starts a `CAMP_CEILING` timer (default ~1h) that ejects you if no `exit` ever arrives — and the same ceiling caps how much a single session can add to your `build_seconds`.

---

## Configuration (env knobs)

All tunables are environment variables, so behavior is testable without code changes:

| Var | Default | Meaning |
|---|---|---|
| `BUILDING_WINDOW` | `1800000` (30 min) | How long after `exit` a user stays **building** before flipping to **offline**. |
| `RETENTION_MS` | `21600000` (6 h) | Messages older than this are pruned (startup + sweep). |
| `CAMP_CEILING` | `3600000` (1 h) | Max session length: ejects a never-`exit`ed present user, and caps the `build_seconds` a single session can add. |
| `SWEEP_MS` | `60000` (60 s) | How often the periodic sweep runs (building→offline flips, retention prune, roster re-broadcast). |
| `DB_PATH` | `./backchannel.db` | SQLite file path. **Point this at a mounted volume in production.** |
| `PORT` | `8080` | HTTP/WS listen port. |

---

## Deploy your own

Backchannel is deliberately small: **one Node process and a single SQLite file.** No managed database, no microservices, no Redis.

### Railway

1. Create a new project from this repo. Railway detects Node and runs `npm install && npm start` (per the `Procfile`: `web: node server.js`).
2. **Add a Volume** and mount it (e.g. at `/data`). This is non-negotiable — without a mounted volume your SQLite file lives on the ephemeral container filesystem and is wiped on every redeploy, taking every user, profile, streak, and message with it.
3. Set **`DB_PATH`** to a file inside the mounted volume, e.g. `DB_PATH=/data/backchannel.db`.
4. (Optional) Tune `BUILDING_WINDOW`, `RETENTION_MS`, `CAMP_CEILING`, `SWEEP_MS` — see [Configuration](#configuration-env-knobs).
5. Deploy. On first boot the server creates the schema and seeds the default channels (`#general`, `#help`, `#what-are-you-building`).

**Notes**

- `better-sqlite3` is a native module — it builds against the platform during `npm install`. Railway's standard Node image handles this; if you containerize yourself, make sure build tools (`python3`, `make`, a C++ toolchain) are present.
- **Migrations are safe to re-run.** The schema is created if missing and the new v2 columns (`tagline`, `last_active`, `total_builds`, `build_seconds`, `streak_days`, `last_build_day` on users; `type`, `position` on rooms) are added via `ALTER` only if absent — so upgrading an existing v1 database in place is fine.
- There's **no separate database service.** The "database" is the file on the volume. Back it up by snapshotting the volume.
- The `/install.sh` route bakes the server's real origin into the installer at request time (derived from `x-forwarded-proto` / `x-forwarded-host`), so `curl https://yourapp/install.sh | sh` just works once deployed.

### Local

```sh
npm install
npm start
```

Defaults to `DB_PATH=./backchannel.db` (next to the source). Override any env knob inline, e.g. `BUILDING_WINDOW=120000 RETENTION_MS=600000 npm start` for a fast-cycling dev run. Health check at `GET /healthz`.

---

## The protocol

CORS is `*`, `OPTIONS` returns `204`, and all endpoints respond fast. Tokens and recovery phrases are only ever sent in request bodies, never in URLs.

### HTTP

| Method & path | Body | Behavior |
|---|---|---|
| `POST /claim` | `{username, token, recovery}` | Validate username (2–24, `[a-z0-9_-]`, lowercased). Taken → `409 {error:"taken"}`; bad input → `400`. Else create the user storing `sha256(token)` and `sha256(recovery)` → `200 {ok:true, username}`. |
| `POST /recover` | `{username, recovery, newToken}` | If `sha256(recovery)` matches that username's stored hash, rebind: `token_hash = sha256(newToken)` → `200 {ok:true}`. Else `403`; bad input `400`; rate-limited `429`. |
| `POST /enter` | `{token}` | Resolve user, mark **active**, set `last_active=now`, record `enterTime`, bump `total_builds` + streak, (re)start the `CAMP_CEILING` timer, broadcast presence + roster. Unknown token still returns `200` (no leak). Always fast. |
| `POST /exit` | `{token}` | Mark **building**, set `last_active=now`, add `build_seconds`, broadcast presence + roster. Always `200`. |
| `GET /healthz` | — | `200 "ok"`. |
| `GET /install.sh` | — | Serves the installer with the live origin baked in. |
| `GET /*` | — | Static files from `/public` (path-traversal guarded); `/` → `index.html`. |

### WebSocket (`/ws`)

The browser holds this open whenever you're signed in.

**Client → server**

```jsonc
{ "type": "hello",        "token": "..." }                         // auth; resolves username server-side
{ "type": "join",         "room": "general" }                      // subscribe + request history (slug or id)
{ "type": "say",          "room": "general", "body": "..." }       // post — active-only, <=1000 chars
{ "type": "set_tagline",  "text": "..." }                          // <=80 chars, escaped
{ "type": "open_dm",      "users": ["alice", "bob"] }              // find-or-create dm/group, returns the room
{ "type": "profile",      "username": "alice" }                    // request a profile
{ "type": "add_project",  "name": "...", "url": "...", "blurb": "..." }
{ "type": "remove_project","id": 7 }
{ "type": "ping" }                                                 // server replies pong (no reconnect churn)
```

**Server → client**

```jsonc
{ "type": "welcome",  "me": { "username": "...", "tagline": "...", "streak": 0,
                              "totalBuilds": 0, "buildSeconds": 0, "since": 0 },
                      "rooms": [ { "id": 1, "slug": "general", "name": "#general", "type": "channel" } ],
                      "dms":   [ { "id": 9, "name": "...", "type": "dm", "members": ["alice","bob"] } ],
                      "present": false }
{ "type": "history",  "room": "general", "messages": [ { "id": 1, "username": "...", "body": "...", "ts": 0 } ] }
{ "type": "msg",      "room": "general", "id": 1, "username": "...", "body": "...", "ts": 0, "self": false }
{ "type": "presence", "present": true }                            // pushed when this user's state flips
{ "type": "roster",   "active":   [ { "username": "...", "tagline": "...", "streak": 0 } ],
                      "building": [ ... ],
                      "offline":  [ ... ] }                        // offline may be a count
{ "type": "profile_data", "user": { "username": "...", "since": 0, "streak": 0, "totalBuilds": 0,
                                    "buildSeconds": 0, "tagline": "...",
                                    "projects": [ { "id": 1, "name": "...", "url": "...", "blurb": "..." } ] } }
{ "type": "room_opened", "room": { ... } }                         // reply to open_dm
{ "type": "pong" }
{ "type": "error",    "message": "..." }
{ "type": "denied" }                                              // e.g. say while not active
```

- `say` is **only honored while you're `active`.** Otherwise it's dropped, optionally with `{type:"denied"}`. Body is trimmed; empty ignored; capped at 1000 chars.
- **Presence is per user**, not per socket — a user may have several tabs, and a flip reaches all of them.
- The server replies `{type:"pong"}` to `{type:"ping"}` so keep-alives don't trigger reconnect churn.
- A heartbeat reaps dead sockets. Malformed JSON, unknown message types, and sockets that die mid-broadcast never crash the process (crash guards on `uncaughtException` / `unhandledRejection`).
- The client reconnects with backoff and re-sends `hello`, then re-`join`s the current room.

---

## SQLite schema

Created if missing; v1 databases are migrated in place via `ALTER` for any missing column.

- **users** — `id, username UNIQUE, token_hash UNIQUE, recovery_hash, created_at, tagline, last_active, total_builds, build_seconds, streak_days, last_build_day`
- **rooms** — `id, slug UNIQUE, name, type ('channel'|'dm'|'group'), created_at, position` — three channels seeded
- **room_members** — `room_id, user_id` (PK `(room_id, user_id)`) — membership for dm/group
- **messages** — `id, room_id, user_id, username, body, created_at` — indexed on `(room_id, id)`
- **projects** — `id, user_id, name, url, blurb, position, created_at`

Only **hashes** of the token and recovery phrase are stored (sha256 hex); raw secrets are never persisted.

---

## Identity & threat model

With **real, stable usernames**, identity is hardened:

- **The token is a secret**, like an SSH key or API key. Generated locally by the installer, stored at `~/.config/backchannel/token` (umask `077`), and **never placed in a URL.** The web client takes it once via paste-in sign-in and keeps it in `localStorage` (`backchannel-token`).
- **The server stores only hashes** — `sha256` of the token and of the recovery phrase. Raw secrets are never persisted, logged, or transmitted beyond the one-time claim/recover/enter/exit calls.
- **Usernames are bound to tokens server-side.** Clients never assert their own username; the server resolves it from the token's hash on every socket. You cannot spoof someone else's name from the wire, and messages are attributed server-side.
- **Impersonation requires stealing a secret off someone's disk** — the bar of an SSH key, not merely seeing a shared link. Link-spoofing is designed out.
- **Recovery without email.** A one-time recovery phrase is issued at install; only its hash is stored. `POST /recover` (rate-limited) rebinds your username to a new token if you lose the old one — no email, no password, no support ticket.
- **All user-rendered text is escaped** — taglines, project fields, and messages render as text, never HTML. URLs must start `http(s)://` to be linkified, otherwise they're shown as plain text.
- **The access gate is honor-system** at the protocol layer (we can't cryptographically prove your agent is busy), and that's accepted. The only server-enforced abuse control is the **camping ceiling** — present users past `CAMP_CEILING` are ejected, so nobody silently holds the door open forever.

---

Built small, on purpose. One process, one file, one mechanic that matters: the gate — which is also the meter.
