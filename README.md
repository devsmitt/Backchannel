# Backchannel

> A builder community you can only enter while your agent is working.

When you fire a prompt at an agentic coding tool, there's dead time — twenty seconds to thirty minutes — while it builds. That time is involuntary, recurring, and unowned. Backchannel claims it.

It's a small, persistent, terminal-styled chat room for developers. Your tab is **dark unless your agent is building**. The moment it starts, you fade into the rooms — with their real history — alongside other builders who are *also* mid-build right now. When your build finishes, you're out. The agent never enters the room; it only holds the door open by being busy on your behalf.

This is the anti-Discord. You cannot lurk all day. There is no "online all the time." You can only be here in your own dead-time, in the cracks of real work, next to other people in theirs. The gate isn't a limitation bolted onto a chat app — the gate *is* the product. It bounds the time and self-selects for people actually shipping something.

No AI participants. No bots. No model calls anywhere in the stack. Real usernames, real history, real builders.

---

## Quickstart

One command. It claims a username, generates your secret token and recovery phrase, and wires the enter/exit hooks into Claude Code.

```sh
curl -fsSL https://backchannel.example/install.sh | sh
```

The installer will:

1. **Ask for a username** — 2–24 chars, `[a-z0-9_-]`, lowercased. Reprompts if it's taken.
2. **Generate a secret token** and a **recovery phrase** (four random words). It prints the recovery phrase once — **save it**, it's the only way to get your username back if you lose the token.
3. **Wire two hooks** into `~/.claude/settings.json` (backed up first, merged without clobbering): `UserPromptSubmit` → enter, `Stop` → exit.

Then **sign in to the web client**:

1. Open <https://backchannel.example/> in a browser.
2. Paste your token when prompted. It's stored once in `localStorage` and never travels in a URL. (It also lives at `~/.config/backchannel/token`.)
3. **Leave the tab open.** It's dark now — that's correct. It lights up the moment your agent starts working.

Kick off any prompt in Claude Code and the rooms appear.

---

## How it works

**The gate is enforced by hooks, not honor.** Claude Code fires `UserPromptSubmit` when you send a prompt and `Stop` when it finishes. The installer wires each to a tiny backgrounded `curl` (capped at 2 seconds, so Claude Code never blocks):

- `UserPromptSubmit` → `POST /enter` → the server marks you **present** and pushes a presence flip to your open tab. The rooms fade in.
- `Stop` → `POST /exit` → the server marks you **absent**. The tab fades back to black mid-whatever, and the input goes dead.

Each hook sends **only your token**. The server resolves your username from it. While you're present you can read and post; while you're absent the server **refuses your messages at the protocol layer** — being signed in is not enough, you have to be building.

**History persists.** Every message is written to **SQLite**. When you enter a room you get the last 50 messages (the catch-up), then live messages stream in over a WebSocket. Rooms are not cleared between visits — this is a real community with a real backlog, not an ephemeral shout into the void.

**The agent never enters.** It has no presence, no username, no voice in the rooms. Its only role is lifecycle: its work opens and closes the door for *you*. There are no AI participants anywhere — no roaming agents, no bots, no model calls in the server or client.

**Camping has a ceiling.** Presence is honor-system at the access layer (we can't truly prove your agent is busy), and that's accepted. The one abuse worth stopping server-side is silent permanent camping, so every `enter` (re)starts a ~1-hour timer that ejects you if no `exit` ever arrives.

---

## Deploy your own

Backchannel is deliberately small: **one Node process and a single SQLite file.** No managed database, no microservices, no Redis.

### Railway

1. Create a new project from this repo. Railway detects Node and runs `npm install && npm start` (per the `Procfile`: `web: node server.js`).
2. **Add a Volume** and mount it (e.g. at `/data`). This is non-negotiable — without a mounted volume your SQLite file lives on the ephemeral container filesystem and is wiped on every redeploy.
3. Set the env var **`DB_PATH`** to a file inside the mounted volume, e.g. `DB_PATH=/data/backchannel.db`.
4. Deploy. The server seeds the default rooms (`#general`, `#help`, `#what-are-you-building`) on first boot.

**Notes**

- `better-sqlite3` is a native module — it builds against the platform during `npm install`. Railway's standard Node image handles this; if you containerize yourself, make sure build tools (`python3`, `make`, a C++ toolchain) are present.
- There's **no separate database service**. The "database" is the file on the volume. Back it up by snapshotting the volume.
- The `/install.sh` route bakes the server's real origin into the installer at request time (derived from `x-forwarded-proto` / `x-forwarded-host`), so `curl https://yourapp/install.sh | sh` just works once deployed.

### Local

```sh
npm install
npm start
```

Defaults to `DB_PATH=/Users/devonsmittkamp/Desktop/Personal/Backchannel/backchannel.db`. Override it with the env var for a different location. Health check at `GET /healthz`.

---

## The protocol

CORS is `*`, `OPTIONS` returns `204`, and all endpoints respond fast. Tokens and recovery phrases are only ever sent in request bodies, never in URLs.

### HTTP

| Method & path | Body | Behavior |
|---|---|---|
| `POST /claim` | `{username, token, recovery}` | Validate username (2–24, `[a-z0-9_-]`, lowercased). If taken → `409 {error:"taken"}`. Else create the user storing `sha256(token)` and `sha256(recovery)` → `200 {ok:true, username}`. |
| `POST /recover` | `{username, recovery, newToken}` | If `sha256(recovery)` matches that username's stored hash, rebind it: `token_hash = sha256(newToken)` → `200 {ok:true}`. Else `403 {error:"no match"}`. |
| `POST /enter` | `{token}` | Resolve user by `sha256(token)`, mark **present**, (re)start the ~1h camping timer, push `{type:"presence", present:true}` to that user's sockets. Unknown token still returns `200` (no leak). Always fast. |
| `POST /exit` | `{token}` | Mark **absent**, push `{type:"presence", present:false}`. Always `200`. |
| `GET /healthz` | — | `200 "ok"`. |
| `GET /install.sh` | — | Serves the installer with the live origin baked in. `Content-Type: text/x-shellscript`. |
| `GET /*` | — | Static files from `/public` (path-traversal guarded); `/` → `index.html`. |

### WebSocket (`/ws`)

The browser holds this open whenever you're signed in.

**Client → server**

```jsonc
{ "type": "hello", "token": "..." }      // auth; resolves username server-side
{ "type": "join",  "room": "general" }   // subscribe + request history
{ "type": "say",   "room": "general", "body": "..." }  // post (present-only)
```

- `hello` → server replies `{type:"welcome", username, rooms:[{slug,name}], present}`, or `{type:"error", message:"bad token"}` and closes if the token is unknown.
- `join` → server replies `{type:"history", room, messages:[{id,username,body,ts}...]}` (last 50, oldest first) and subscribes this socket to the room.
- `say` → **only honored if the user is currently present.** Otherwise dropped, with an optional `{type:"denied"}`. Body is trimmed, empty is ignored, capped at 1000 chars. Persisted, then broadcast.

**Server → client**

```jsonc
{ "type": "welcome",  "username": "...", "rooms": [...], "present": false }
{ "type": "history",  "room": "general", "messages": [...] }
{ "type": "msg",      "room": "general", "id": 1, "username": "...", "body": "...", "ts": 0, "self": false }
{ "type": "presence", "present": true }   // pushed when enter/exit flips for this user
{ "type": "error",    "message": "..." }
{ "type": "denied" }
```

- **Presence is per user**, not per socket — a user may have several tabs; a flip reaches all of them.
- A heartbeat ping reaps dead sockets. Malformed JSON, unknown message types, and sockets that die mid-broadcast never crash the process (`uncaughtException` / `unhandledRejection` guards).
- The client reconnects with backoff and re-sends `hello` + re-`join`s the current room.

---

## Identity & threat model

The Void's "anyone with your link is you" was fine when everyone was anonymous. With **real, stable usernames** it isn't — so identity is hardened:

- **The token is a secret**, like an SSH key or an API key. It's generated locally by the installer, stored at `~/.config/backchannel/token` (umask `077`), and **never placed in a URL.** The web client takes it once via a paste-in sign-in and keeps it in `localStorage` (`backchannel-token`).
- **The server stores only hashes** — `sha256` of the token and of the recovery phrase. Raw secrets are never persisted, logged, or transmitted beyond the one-time claim/recover/enter/exit calls.
- **Usernames are bound to tokens server-side.** Clients never assert their own username; the server resolves it from the token's hash on every socket. You cannot spoof someone else's name from the wire.
- **Impersonation requires stealing a secret off someone's disk** — the bar of an SSH key, not merely seeing a shared link. Link-spoofing is designed out.
- **Recovery without email.** A one-time recovery phrase (a few random words) is issued at install; only its hash is stored. `POST /recover` lets you rebind your username to a brand-new token if you lose the old one — no email, no password, no support ticket.
- **The access gate is honor-system** at the protocol layer (we can't cryptographically prove your agent is busy), and that's accepted. The only server-enforced abuse control is the **camping ceiling** — present users past the ~1h ceiling are ejected, so nobody silently holds the door open forever.

---

Built small, on purpose. One process, one file, one mechanic that matters: the gate.
