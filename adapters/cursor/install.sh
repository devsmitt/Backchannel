#!/bin/sh
# Backchannel — Cursor adapter installer
# POSIX sh, idempotent, no sudo. Wires Cursor's agent hooks so your tab lights
# up only while Cursor's AI agent is building.
#
#   beforeSubmitPrompt -> POST /enter {token}   (agent starts on your prompt)
#   stop               -> POST /exit  {token}   (agent loop ends)
#
# This adapter ASSUMES you already ran the main Backchannel installer (or the
# Claude Code adapter) so a token exists at ~/.config/backchannel/token. It does
# NOT claim a username or mint a token — Cursor shares your existing identity.
#
# Requirements: Cursor >= 1.7 (hooks are beta), curl, and a token file.
#
# Server URL: baked into the hook scripts at install time. Override with:
#   BACKCHANNEL_SERVER=https://my.host sh install.sh

set -eu

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
SERVER="${BACKCHANNEL_SERVER:-https://backchannel.example}"
SERVER="${SERVER%/}"

CONFIG_DIR="$HOME/.config/backchannel"
TOKEN_FILE="$CONFIG_DIR/token"
# Where we install the hook scripts. Absolute paths -> Cursor's `command` field
# resolves them unambiguously, independent of hooks.json relative-path rules.
HOOKS_DIR="$CONFIG_DIR/cursor-hooks"

CURSOR_DIR="$HOME/.cursor"
HOOKS_JSON="$CURSOR_DIR/hooks.json"

# This script's own directory, so we can copy the bundled hook templates.
SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SRC_HOOKS_DIR="$SELF_DIR/hooks"

say() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
die() { err "error: $*"; exit 1; }

say ""
say "  backchannel — cursor adapter"
say "  server: $SERVER"
say ""

# --------------------------------------------------------------------------
# Preconditions
# --------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required but was not found in PATH."

if [ ! -r "$TOKEN_FILE" ]; then
  err "  no token found at $TOKEN_FILE"
  err "  run the main Backchannel installer (or the Claude Code adapter) first"
  err "  to claim a username and create your token, then re-run this."
  exit 1
fi

# Sanity check the token isn't empty.
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')"
[ -n "$TOKEN" ] || die "token file $TOKEN_FILE is empty."

# --------------------------------------------------------------------------
# Install hook scripts (written inline so this installer is self-contained and
# can be piped straight from the server: curl .../cursor.sh | sh). The server
# URL is baked into the body below; both still honor a BACKCHANNEL_SERVER env
# override at runtime. Each hook drains stdin, POSTs only the token, exits 0.
# --------------------------------------------------------------------------
umask 077
mkdir -p "$HOOKS_DIR"

write_hook() {  # $1 = dest path, $2 = endpoint (/enter|/exit)
  cat > "$1" <<EOF
#!/bin/sh
set -eu
SERVER="\${BACKCHANNEL_SERVER:-$SERVER}"
SERVER="\${SERVER%/}"
TOKEN_FILE="\${BACKCHANNEL_TOKEN_FILE:-\$HOME/.config/backchannel/token}"
cat >/dev/null 2>&1 || :
[ -r "\$TOKEN_FILE" ] || exit 0
TOKEN="\$(cat "\$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')"
[ -n "\$TOKEN" ] || exit 0
command -v curl >/dev/null 2>&1 && \\
  curl -sS -m 2 -X POST -H 'Content-Type: application/json' \\
    -d "{\\"token\\":\\"\$TOKEN\\"}" "\$SERVER$2" >/dev/null 2>&1 &
exit 0
EOF
  chmod 700 "$1" 2>/dev/null || :
}
write_hook "$HOOKS_DIR/enter.sh" "/enter"
write_hook "$HOOKS_DIR/exit.sh"  "/exit"

ENTER_CMD="$HOOKS_DIR/enter.sh"
EXIT_CMD="$HOOKS_DIR/exit.sh"

# --------------------------------------------------------------------------
# Merge into ~/.cursor/hooks.json (de-dupe our own entries, preserve others)
# --------------------------------------------------------------------------
mkdir -p "$CURSOR_DIR"

# Back up an existing hooks.json before touching it.
if [ -f "$HOOKS_JSON" ]; then
  cp "$HOOKS_JSON" "$HOOKS_JSON.backchannel.bak" 2>/dev/null || :
fi

merged_via=""

# --- Preferred path: python3 (robust JSON merge + de-dupe) -----------------
if command -v python3 >/dev/null 2>&1; then
  HOOKS_JSON="$HOOKS_JSON" \
  ENTER_CMD="$ENTER_CMD" \
  EXIT_CMD="$EXIT_CMD" \
  HOOKS_DIR="$HOOKS_DIR" \
  python3 - <<'PYEOF' && merged_via="python3"
import json, os

path      = os.environ["HOOKS_JSON"]
enter_cmd = os.environ["ENTER_CMD"]
exit_cmd  = os.environ["EXIT_CMD"]
hooks_dir = os.environ["HOOKS_DIR"]

# Load existing hooks.json (tolerate empty / missing / malformed).
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            txt = f.read().strip()
        if txt:
            data = json.loads(txt)
    except Exception:
        data = {}
if not isinstance(data, dict):
    data = {}

# Cursor's schema requires a version field.
data["version"] = data.get("version", 1)

hooks = data.get("hooks")
if not isinstance(hooks, dict):
    hooks = {}
data["hooks"] = hooks

def is_backchannel(entry):
    """True if a hook entry is one of ours (points at our cursor-hooks dir)."""
    return (isinstance(entry, dict)
            and isinstance(entry.get("command"), str)
            and hooks_dir in entry["command"])

def ensure(event, command):
    """Strip any prior Backchannel entry for this event (de-dupe), keep the
    rest, then append our fresh hook."""
    kept = [e for e in (hooks.get(event) or []) if not is_backchannel(e)]
    kept.append({"command": command})
    hooks[event] = kept

ensure("beforeSubmitPrompt", enter_cmd)
ensure("stop", exit_cmd)

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
fi

# --- Fallback: jq ----------------------------------------------------------
if [ -z "$merged_via" ] && command -v jq >/dev/null 2>&1; then
  _tmp="$(mktemp 2>/dev/null || printf '%s' "$HOOKS_JSON.tmp.$$")"
  if [ -s "$HOOKS_JSON" ] && jq -e . "$HOOKS_JSON" >/dev/null 2>&1; then
    _base="$HOOKS_JSON"
  else
    printf '{}' > "$_tmp.base"
    _base="$_tmp.base"
  fi
  if jq \
      --arg enter "$ENTER_CMD" \
      --arg exitc "$EXIT_CMD" \
      --arg dir   "$HOOKS_DIR" '
      def is_bc: (.command? // "") | contains($dir) ;
      def strip($evt): (.hooks[$evt] // []) | map(select(is_bc | not)) ;
      .version = (.version // 1)
      | .hooks = (.hooks // {})
      | .hooks.beforeSubmitPrompt = ( (strip("beforeSubmitPrompt"))
          + [ { "command": $enter } ] )
      | .hooks.stop = ( (strip("stop")) + [ { "command": $exitc } ] )
      ' "$_base" > "$_tmp" 2>/dev/null; then
    mv "$_tmp" "$HOOKS_JSON"
    rm -f "$_tmp.base" 2>/dev/null || :
    merged_via="jq"
  else
    rm -f "$_tmp" "$_tmp.base" 2>/dev/null || :
  fi
fi

# --- Pure-sh fallback: only safe when there is no existing hooks.json -------
if [ -z "$merged_via" ]; then
  if [ ! -s "$HOOKS_JSON" ]; then
    # Absolute script paths contain no quotes/backslashes that need escaping
    # for JSON on a normal home dir, but escape defensively anyway.
    json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
    _enter_j="$(json_escape "$ENTER_CMD")"
    _exit_j="$(json_escape "$EXIT_CMD")"
    cat > "$HOOKS_JSON" <<EOF
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "$_enter_j" }
    ],
    "stop": [
      { "command": "$_exit_j" }
    ]
  }
}
EOF
    merged_via="pure-sh"
  else
    err ""
    err "  ! could not safely merge hooks: neither python3 nor jq is available,"
    err "    and $HOOKS_JSON already exists (won't risk corrupting it)."
    err "    Add these two entries manually under .hooks:"
    err "      beforeSubmitPrompt: { \"command\": \"$ENTER_CMD\" }"
    err "      stop:               { \"command\": \"$EXIT_CMD\" }"
    merged_via="manual"
  fi
fi

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
say ""
say "  ------------------------------------------------------------"
say "  cursor adapter installed"
say "  hook scripts: $HOOKS_DIR/{enter,exit}.sh"
if [ "$merged_via" = "manual" ]; then
  say "  hooks.json:   NOT wired automatically — see the note above"
else
  say "  hooks.json:   wired into $HOOKS_JSON (via $merged_via)"
fi
say "  ------------------------------------------------------------"
say ""
say "  IMPORTANT: hooks are a beta feature and load at Cursor startup."
say "  Fully quit and reopen Cursor (Cmd/Ctrl+Q), then run an agent prompt."
say "  Your tab should light up while the agent works and clear when it stops."
say ""
say "  Requires Cursor 1.7 or newer."
say ""
