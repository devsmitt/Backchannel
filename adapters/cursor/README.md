# Backchannel — Cursor adapter

Lights up your Backchannel tab only while **Cursor's in-editor AI agent** is
actually working, and clears it when the agent stops — the same presence model
as the Claude Code adapter, just wired through Cursor's own hooks.

## TL;DR — is this possible?

**Yes.** As of **Cursor 1.7** (shipped Sept/Oct 2025, currently a **beta**
feature), Cursor exposes an official **Hooks** API that fires shell commands at
agent-lifecycle events. Two of those events map cleanly onto Backchannel:

| Backchannel event | Cursor hook        | When it fires                          |
| ----------------- | ------------------ | -------------------------------------- |
| `POST /enter`     | `beforeSubmitPrompt` | user submits a prompt to the agent (agent starts) |
| `POST /exit`      | `stop`             | the agent loop ends (`completed` / `aborted` / `error`) |

This is the direct analog of Claude Code's `UserPromptSubmit` → `/enter` and
`Stop` → `/exit` hooks. The adapter sends **only the token** (read from
`~/.config/backchannel/token`), exactly like every other integration.

## Requirements

- **Cursor 1.7 or newer** (hooks are beta — see Caveats).
- `curl` on your `PATH`.
- An existing Backchannel token at `~/.config/backchannel/token`. This adapter
  does **not** claim a username or mint a token — Cursor shares your existing
  identity. Run the main Backchannel installer (or the Claude Code adapter)
  first if you haven't.

## Install

```sh
# from the server (recommended — server bakes its own origin in):
#   curl -fsSL https://<your-backchannel-host>/cursor/install.sh | sh
#
# or locally from this repo:
sh adapters/cursor/install.sh

# override the server origin if needed:
BACKCHANNEL_SERVER=https://my.host sh adapters/cursor/install.sh
```

Then **fully quit and reopen Cursor** (Cmd/Ctrl+Q). Hooks are loaded at startup,
so a reload is required for the first install (and after any hooks.json change).

## What the installer does

1. Reads your existing token from `~/.config/backchannel/token` (errors out if
   missing — it never creates one).
2. Installs two small POSIX-sh hook scripts to
   `~/.config/backchannel/cursor-hooks/{enter,exit}.sh`, baking the server URL
   in. Absolute paths are used so Cursor's `command` resolution is unambiguous.
3. Safely merges two entries into your **user-global** `~/.cursor/hooks.json`:
   - `beforeSubmitPrompt` → `enter.sh`
   - `stop` → `exit.sh`

   It preserves any hooks you (or other tools) already have, de-dupes its own
   entries on re-run (idempotent), backs up the prior file to
   `hooks.json.backchannel.bak`, and prefers `python3`, then `jq`, then a
   pure-sh fallback for the merge.

### Why user-global, not per-project?

Cursor reads `hooks.json` from several locations — user-global
`~/.cursor/hooks.json`, project `<repo>/.cursor/hooks.json`, and enterprise
paths. We install to the **user-global** path so presence works in every
project automatically, mirroring how the Claude Code adapter writes to
`~/.claude/settings.json`. If you'd rather scope it to one repo, copy the same
two entries into that repo's `.cursor/hooks.json`.

## How the hooks behave (and why they're safe)

Cursor runs each hook as a standalone process and pipes the event JSON to it on
**stdin**. Our scripts:

- **drain stdin** (so Cursor never blocks writing the payload),
- read the token from `~/.config/backchannel/token`,
- fire a **backgrounded** `curl` capped at **2 seconds** to `/enter` or `/exit`
  with a body of exactly `{"token":"..."}` — nothing else,
- always **exit 0**.

`beforeSubmitPrompt` and `stop` are treated as informational; we never emit a
`continue:false` or a `followup_message`, so the adapter **cannot block your
prompt or make the agent loop**. If the token is missing, curl is absent, or the
server is down, the hook silently no-ops and your agent is unaffected.

## What is and isn't covered

- **Covered — the in-editor Cursor agent (Agent / Composer / Cmd-K chat).**
  This is the main event and it's fully handled via the hooks above.
- **Covered already by the shell integration — `cursor-agent` CLI and any
  agent-run terminal commands.** Cursor's terminal-launched commands and the
  standalone `cursor-agent` CLI run through your shell, so Backchannel's
  existing shell integration picks those up without this adapter. (If you only
  use the in-editor agent, this adapter is what you need.)
- **Tab completions are intentionally not covered.** Cursor's inline "Tab"
  autocomplete fires `beforeTabFileRead` / `afterTabFileEdit`, not the agent
  lifecycle. Presence tracks *agent work*, not keystroke-level completion, so we
  deliberately don't wire those.

## Caveats

- **Hooks are beta.** Event names and payloads can change between Cursor
  releases. If presence stops working after a Cursor update, check
  `~/.cursor/hooks.json` against the current
  [Cursor Hooks docs](https://cursor.com/docs/hooks) and re-run the installer.
- **Startup-loaded.** Editing `hooks.json` requires restarting Cursor to take
  effect.
- **`stop` fires per agent loop end.** Long agentic runs end with a single
  `stop`; rapid back-to-back prompts produce a `beforeSubmitPrompt` each time,
  matching the enter/exit rhythm Backchannel expects.

## Uninstall

Remove the two `command` entries pointing at
`~/.config/backchannel/cursor-hooks/` from `~/.cursor/hooks.json` (or restore
`~/.cursor/hooks.json.backchannel.bak`), then optionally:

```sh
rm -rf ~/.config/backchannel/cursor-hooks
```

Restart Cursor.

## References

- Cursor Hooks docs — https://cursor.com/docs/hooks
- InfoQ, "Cursor 1.7 Adds Hooks for Agent Lifecycle Control" —
  https://www.infoq.com/news/2025/10/cursor-hooks/
- GitButler, "Deep Dive into the new Cursor Hooks" —
  https://blog.gitbutler.com/cursor-hooks-deep-dive
