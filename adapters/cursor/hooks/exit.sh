#!/bin/sh
# Backchannel — Cursor "exit" hook (fires on stop, when the agent loop ends).
#
# Cursor runs this as a standalone process and pipes the event JSON in on stdin.
# We drain stdin, then POST only the token to /exit and exit 0. The stop hook is
# informational here — we do NOT emit a followup_message, so the agent simply
# stops as the user expects.
#
# The token is read from ~/.config/backchannel/token. The server URL is baked in
# by the installer (replacing the placeholder below) or overridden via env.

set -eu

SERVER="${BACKCHANNEL_SERVER:-__BACKCHANNEL_SERVER__}"
SERVER="${SERVER%/}"
TOKEN_FILE="${BACKCHANNEL_TOKEN_FILE:-$HOME/.config/backchannel/token}"

# Read stdin best-effort for a session id (also drains it so Cursor never blocks).
SID="$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' 2>/dev/null | head -n1)"

# No token -> nothing to do. Exit 0 so we never interfere with the agent.
[ -r "$TOKEN_FILE" ] || exit 0
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')"
[ -n "$TOKEN" ] || exit 0

# Fire-and-forget: token + session + event:'exit' (this session is done), cap 2s.
command -v curl >/dev/null 2>&1 && \
  curl -sS -m 2 -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"token\":\"$TOKEN\",\"session\":\"$SID\",\"event\":\"exit\"}" \
    "$SERVER/exit" >/dev/null 2>&1 &

exit 0
