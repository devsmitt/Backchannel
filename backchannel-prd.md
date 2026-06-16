# PRD: Backchannel

**Project:** Backchannel — a builder community you can only enter while your agent works
**Date:** 2026-06-16
**Status:** Draft — concept + name locked, scoping v1
**Lineage:** descends from The Void (`~/Desktop/Personal/Void`). Keeps the one mechanic that mattered — *access gated by real work* — and drops the rest (ephemerality, anonymity, AI participants).

---

## Problem

When a developer fires a prompt at an agentic coding tool, there's dead time — 20 seconds to 30+ minutes — while the agent builds. That time is involuntary, recurring, and unowned. The Void tried to fill it with an anonymous ephemeral chatroom and (later) roaming AI souls. The AI-souls direction collapsed: many instances of one model converge into one voice — it read as slop, not company. The lesson: **the magic isn't AI in the room, it's the gate.** A social space you can *only* reach in the cracks of real work is genuinely new — but it should be full of **real builders**, not imitations.

## The idea

Backchannel is a small, persistent, terminal-flavored chat community for developers. Your tab is **dark unless your agent is working**; the moment it starts, you fade into the rooms — with their real history — and can read and talk to other builders who are *also* mid-build right now. When your build finishes, you're out. The agent never enters; it only holds the door open by being busy on your behalf.

It is the anti-Discord: you cannot lurk all day. You can only be here in your own dead-time, alongside others in theirs.

## Users

Developers using agentic coding tools (Claude Code first) who want real, low-stakes connection with other builders without it becoming another always-on attention sink. The build-gate *is* the feature — it bounds the time and self-selects for people actually working.

## Goals

- A real, persistent community of builders accessible only while building.
- Stable, recognizable identities (usernames) so relationships and reputation can form.
- One-command install, no email/password/OAuth, hardened against impersonation.
- Stay small and minimal by design — techy, simple, real. Not a scale play.

## Non-goals

- **No AI participants.** No roaming agents, no bots. The agent does your work; it never speaks here. (Explicitly cut — it converged into slop.)
- **Not ephemeral.** History persists; rooms are not cleared between visits.
- **Not anonymous.** Real chosen usernames, not throwaway souls.
- **Not always-on.** No reading or posting when you're not building (strict gate).
- **Not a scale play.** One small process, a single SQLite file. No microservices, no big infra.
- **No heavy moderation/account system** in v1 beyond the basics below.

## Locked decisions

- **Name: Backchannel.** Config dir `~/.config/backchannel`.
- **Access: STRICT.** You are present only while your agent is working. Tab is fully dark otherwise — no reading, no posting. (`UserPromptSubmit` → enter, `Stop` → exit.) On entry you see real room history (the catch-up), then live messages; on exit you fade to black mid-whatever.
- **Identity: username + local secret token + recovery phrase.** At install you claim a username, get a secret token (stored locally, **never in a URL**), and a one-time **recovery phrase** so a lost token isn't a lost identity. No email, no password, no OAuth.
- **Rooms: a few fixed channels** to start — `#general`, `#help`, `#what-are-you-building`. No user-created rooms in v1.

## Scope

### Must-have (v1)

- One always-on Node process with a **SQLite** database on a **Railway volume** (persistent). Tables: users, rooms, messages.
- **Real-time messaging over WebSocket**, scoped to rooms; persisted to SQLite.
- **History on entry** — entering a room shows recent backlog (not a blank slate).
- **Strict presence gate** driven by Claude Code hooks (enter on prompt submit, exit on stop). When not building: dark, server refuses posts from non-present users.
- **Identity & auth:**
  - Claim a unique username at install; bind it to a freshly generated **secret token**.
  - Token is a credential (like an API key): stored at `~/.config/backchannel/token`, used by the web client (entered once → localStorage), **never placed in a URL**.
  - A **recovery phrase** (generated word list) issued at install; recovering an identity requires it. Server stores only **hashes** of token + recovery phrase.
  - Server authenticates each socket by token → resolves username. Messages attributed server-side; clients cannot spoof another username.
- **A few fixed channels**, switchable in the UI, each with its own history.
- **Single static terminal-aesthetic page** (carried from The Void): dark, monospace, low-res, with a channel switcher, message pane with history, and an input.
- **Claude Code adapter** — one-command install: claim username, generate token + recovery phrase, wire enter/exit hooks, print the local sign-in.
- **Server-side max-presence timeout** — eject anyone "present" past a plausible-run ceiling (~1h), to prevent silent permanent camping.

### Nice-to-have (v1.1+)

- **Presence/online list** — who's currently building (natural now that we're not anonymous).
- **Mentions / replies**, basic unread surfaced on next entry.
- **DMs** between builders.
- **Cursor / other tool adapters.**
- **Rate limiting / light moderation.**

### Out of scope (v1)

- User-created rooms, threads, reactions, file uploads.
- Email/OAuth, web signup outside the installer.
- Federation, mobile apps, multi-region/scale.

## Identity & threat model

The Void's "anyone with your link is you" was fine when anonymous. With real usernames it is not. Hardening:

- The token is a **secret**, generated locally, stored in `~/.config/backchannel/token`, and **never embedded in a shareable URL**. The web client takes it once and keeps it in `localStorage`.
- Server stores only a **hash** of the token and of the recovery phrase. Username ↔ token binding is server-side; clients never assert their own username.
- Impersonation therefore requires stealing a secret off someone's disk — the bar of an SSH key or API key — not merely seeing a link.
- **Recovery:** the one-time recovery phrase lets a user re-bind their username to a new token if the old one is lost, without email or support.
- The honor-system *access* gate (you must be building) remains unenforceable at the protocol layer, and that's accepted — the only abuse worth stopping server-side is permanent camping, handled by the presence ceiling.

## Dependencies & constraints

- **Server:** one always-on Node process (Railway). **SQLite** file on a **Railway volume**. No separate DB service.
- **Transport:** WebSocket for live messaging; HTTP for enter/exit hook pings, username claim, and recovery.
- **Page:** single static HTML/CSS/JS, terminal aesthetic reused from The Void.
- **Adapters:** per-tool install snippets only. Claude Code uses native hooks (`UserPromptSubmit` enter, `Stop` exit) firing HTTP to the server. No vendor account, no API key.
- **No AI / no vendor calls.** The server and client never call any model. The agent's only role is lifecycle — its work opens the gate.

## Open questions

1. **Sign-in hand-off.** Cleanest way to get the secret token into the browser without a URL: paste-once, a `localhost` hand-off from the installer, or a short-lived claim code. Pick during build.
2. **Recovery phrase scheme.** Length/wordlist (BIP39-style vs simple) and exact re-bind flow.
3. **Presence list in v1 or v1.1?** Showing who's currently building adds life but is a small build; decide.
4. **Strict-gate UX when not building.** Pure black like The Void, or a quiet "you're not building — come back when you are" with unread counts.
5. **Cold start.** Needs enough concurrent builders early to feel alive. Launch as a burst.

## Assumptions

- A single Node process + SQLite on a volume is sufficient for v1 scale; no managed DB until it actually grows.
- Claude Code hooks reliably fire enter/exit (proven in The Void).
- A locally-stored secret token + recovery phrase is "real enough" auth for a small builder community without accounts.
- Devon's audience can produce enough concurrent builders at launch for the rooms to feel alive.
