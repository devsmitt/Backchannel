# Backchannel

**A chat room that's only open while your agent is building.**

Fire a prompt at your coding agent and you've got dead time. Twenty seconds, ten minutes, who knows. Backchannel turns it into a room: while your agent works, you're in it with other builders who are also mid-build. When it stops, you fade out.

No lurking. No "online all day." You show up in the cracks of real work, next to people doing the same. The gate is the whole point.

And no bots. No AI in the room, no model calls anywhere. Just real builders in their dead time.

🔒 How it stays safe: [SECURITY.md](SECURITY.md)

## Three states

- **active:** your agent is working, so you're live. You can read and post.
- **building:** heads-down between prompts. Read-only.
- **offline:** been quiet a while.

You can always read. You can only talk while you're actually building.

## What's inside

- Channels, DMs, and group DMs.
- A live "who's building" roster.
- A builder profile: streak, total builds, build-time, and your projects. All earned from real activity. No points, no badges, no leaderboard.
- GIFs and reactions.
- Recent history that ages out. A backlog, not an archive.

## Get in

```sh
curl -fsSL https://backchannel-production-3df1.up.railway.app/install.sh | sh
```

Pick a username, save the recovery phrase it shows you, and your browser opens signed in. Leave the tab open. Next time you prompt your agent, the room fades in.

Works with **Claude Code** (native hooks), **other CLI agents and the raw terminal** (shell integration), and **Cursor**. Every ping sends only your token, nothing else.

## Run your own

One Node process, one SQLite file. No database server, no Redis, no microservices.

```sh
npm install && npm start
```

On **Railway**: deploy the repo, add a mounted Volume, set `DB_PATH` to a file on it, deploy. First boot seeds `#general`, `#help`, and `#what-are-you-building`. (The volume is required, or your data is wiped on every redeploy.)

### Settings

All optional, all env vars:

| Var | Default | What it does |
|---|---|---|
| `DB_PATH` | `./backchannel.db` | Where the SQLite file lives. Point at a mounted volume in prod. |
| `DB_KEY` | off | 64 hex chars → encrypts the whole database at rest. Set once; it migrates in place. Lose it, lose the DB. |
| `ADMIN_TOKEN` | off | ≥32-char secret for the owner-only admin CLI (`admin.js`). Off = no admin surface. |
| `GIPHY_API_KEY` | off | Turns on the GIF picker (proxied server-side). |
| `GENESIS_INVITES` | off | Seed invite codes so the first account on a fresh deploy can sign up. It's invite-only. |
| `BUILDING_WINDOW` | 30 min | How long after a build you stay "building" before going offline. |
| `RETENTION_MS` | 6 h | Messages older than this are pruned. |
| `PORT` | `8080` | Listen port. |

## How it works

Your agent opens the door, it never walks through it. Claude Code fires a hook when a prompt starts (`/enter`) and when it stops (`/exit`); each sends only your token. `/enter` marks you active and the rooms appear; `/exit` drops you to building. Posting is refused at the server unless you're active, so being signed in isn't enough. You have to be building.

Messages live in SQLite and stream over a WebSocket. The agent has no presence, no name, no voice. It just holds the door.

## Security

DMs stay between their members. Every message is shown as text, never run as code. The whole database is encrypted at rest. It is **not** end-to-end encrypted (the server can read messages, like Slack or Discord). Full threat model, honestly stated: [SECURITY.md](SECURITY.md).

## Under the hood

The whole thing is small on purpose and meant to be read: `server.js` (HTTP + WebSocket + presence), `db.js` (SQLite via `better-sqlite3-multiple-ciphers`), and `public/index.html` (the client). Presence is held in memory; data is one encrypted file. That's why it's fast and cheap to run.

---

Built small, on purpose. One process, one file, one mechanic that matters: the gate, which is also the meter.
