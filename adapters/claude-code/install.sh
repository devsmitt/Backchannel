#!/bin/sh
# Backchannel — Claude Code installer
# POSIX sh, idempotent, no sudo. Claims a username, generates a secret token +
# recovery phrase, registers with the server, and wires enter/exit hooks into
# Claude Code so your tab lights up only while your agent is building.
#
# The /install.sh route on the server bakes the real origin into the SERVER
# default below before serving this file. You can also override with:
#   BACKCHANNEL_SERVER=https://my.host sh install.sh

set -eu

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
# SERVER default — the server's /install.sh route rewrites this placeholder to
# its own origin. Env override always wins.
SERVER="${BACKCHANNEL_SERVER:-https://backchannel.example}"
# Strip any trailing slash so we can concatenate paths cleanly.
SERVER="${SERVER%/}"

CONFIG_DIR="$HOME/.config/backchannel"
TOKEN_FILE="$CONFIG_DIR/token"
RECOVERY_FILE="$CONFIG_DIR/recovery"
SETTINGS_DIR="$HOME/.claude"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

# --------------------------------------------------------------------------
# Pretty output helpers
# --------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
err()  { printf '%s\n' "$*" >&2; }
die()  { err "error: $*"; exit 1; }

# We need an interactive terminal to prompt for the username.
[ -r /dev/tty ] || die "no /dev/tty available — run this in an interactive shell."

# We need curl to talk to the server.
command -v curl >/dev/null 2>&1 || die "curl is required but was not found in PATH."

say ""
say "  backchannel installer"
say "  server: $SERVER"
say ""

# --------------------------------------------------------------------------
# Secret + recovery generation
# --------------------------------------------------------------------------
# High-entropy hex token from /dev/urandom (fallback to uuidgen, then date+pid).
gen_token() {
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    # 32 random bytes -> 64 hex chars.
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  elif command -v uuidgen >/dev/null 2>&1; then
    # Two UUIDs concatenated, dashes stripped, for ample entropy.
    printf '%s%s' "$(uuidgen)" "$(uuidgen)" | tr 'A-Z' 'a-z' | tr -d '-'
  else
    # Last-resort fallback; still unpredictable enough for a small community.
    printf '%s-%s-%s' "$(date +%s)" "$$" "$(awk 'BEGIN{srand();print int(rand()*1000000000)}')"
  fi
}

# Embedded wordlist for the recovery phrase (kept short + readable; no ambiguity).
WORDLIST="amber anchor apple arbor atlas basil beacon birch bison bramble
breeze cedar cinder clover cobalt comet copper coral cosmos cypress delta
ember falcon fennel fjord flint garnet ginger glacier granite harbor hazel
heron indigo ivory jasper jetty juniper kelp lantern larch lichen lily lotus
maple marble meadow mesa moss nectar nimbus oak onyx opal orchid otter pebble
pewter pine pixel plume quartz quill raven reef rowan saffron sage sequoia
silo slate sparrow spruce summit thistle thorn tide topaz tundra umber vapor
velvet violet walnut willow wren zephyr zinc"

# Pick 6 random words, space-joined, using cryptographic randomness from
# /dev/urandom (not awk's time-seeded PRNG). 6 words from ~96 ≈ 40 bits, and
# the server rate-limits /recover, so the phrase resists brute force.
gen_recovery() {
  # shellcheck disable=SC2086  # intentional word-splitting of the list
  set -- $WORDLIST
  _n=$#
  _words=6
  if [ -r /dev/urandom ]; then
    _out=""
    _i=0
    while [ "$_i" -lt "$_words" ]; do
      _r="$(od -An -N2 -tu2 < /dev/urandom | tr -d ' ')"
      _idx=$(( _r % _n + 1 ))
      _w="$(eval "printf '%s' \"\${$_idx}\"")"
      _out="${_out:+$_out }$_w"
      _i=$(( _i + 1 ))
    done
    printf '%s' "$_out"
  else
    # Fallback: awk shuffle (weaker; only if /dev/urandom is unreadable).
    printf '%s\n' "$@" | awk -v k="$_words" '
      BEGIN { srand() } { w[NR]=$0 }
      END { n=NR; for(i=1;i<=k&&i<=n;i++){ j=i+int(rand()*(n-i+1)); t=w[i];w[i]=w[j];w[j]=t }
            o=""; for(i=1;i<=k&&i<=n;i++) o=(o==""?w[i]:o" "w[i]); print o }'
  fi
}

# --------------------------------------------------------------------------
# HTTP helper: POST JSON, echo body, set global HTTP_CODE.
# --------------------------------------------------------------------------
# A scratch file the helper uses to hand the status code back to the caller.
# (post_json is invoked via command substitution, which runs in a SUBSHELL, so
# a plain variable assignment inside it would not survive to the parent shell —
# we round-trip the code through a file instead.)
HTTP_CODE=""
_CODE_FILE="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/bc.code.$$")"
# Clean up the scratch file on any exit.
trap 'rm -f "$_CODE_FILE" 2>/dev/null || :' EXIT INT TERM HUP
post_json() {
  _url="$1"; _body="$2"
  # Append the 3-digit status code to the end of the response body via -w, then
  # split with sed (POSIX-portable — avoids shell-specific newline handling).
  _resp="$(curl -sS -m 15 \
    -H 'Content-Type: application/json' \
    -X POST "$_url" \
    -d "$_body" \
    -w 'HTTPSTATUS:%{http_code}' 2>/dev/null
  )" || { printf '000' > "$_CODE_FILE"; printf '%s' ""; return 0; }

  _code="$(printf '%s' "$_resp" | sed -n 's/.*HTTPSTATUS:\([0-9][0-9][0-9]\)$/\1/p')"
  [ -n "$_code" ] || _code="000"
  printf '%s' "$_code" > "$_CODE_FILE"
  # Body is everything before the HTTPSTATUS marker.
  printf '%s' "$_resp" | sed 's/HTTPSTATUS:[0-9]*$//'
}
# Read the status code stashed by the most recent post_json call.
last_code() { HTTP_CODE="$(cat "$_CODE_FILE" 2>/dev/null)"; [ -n "$HTTP_CODE" ] || HTTP_CODE="000"; }

# JSON string escaper for values we interpolate into request bodies.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Pull a top-level string field out of a small, flat JSON object. Good enough
# for the tiny {"code":"..."} bodies the server returns — no jq dependency.
json_field() {
  # $1 = field name, stdin = JSON body
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}

# Open a URL in the default browser, non-blocking, using whatever's available
# (macOS open, Linux xdg-open, WSL/Windows cmd.exe). Returns 0 if a launcher
# was found and fired, 1 otherwise so the caller can fall back to printing.
open_url() {
  _u="$1"
  if command -v open >/dev/null 2>&1; then
    open "$_u" >/dev/null 2>&1 &
    return 0
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$_u" >/dev/null 2>&1 &
    return 0
  elif command -v cmd.exe >/dev/null 2>&1; then
    # WSL / Git-Bash: start needs an empty title arg; & is escaped for cmd.
    cmd.exe /c start "" "$_u" >/dev/null 2>&1 &
    return 0
  fi
  return 1
}

# --------------------------------------------------------------------------
# Username claim loop
# --------------------------------------------------------------------------
TOKEN=""
RECOVERY=""
USERNAME=""

while : ; do
  printf 'choose a username (2-24 chars, a-z 0-9 _ -): ' > /dev/tty
  IFS= read -r raw < /dev/tty || die "could not read username."

  # Lowercase and trim surrounding whitespace.
  USERNAME="$(printf '%s' "$raw" | tr 'A-Z' 'a-z' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  # Validate: 2-24 chars, only [a-z0-9_-].
  case "$USERNAME" in
    *[!a-z0-9_-]* | "" )
      say "  invalid — use only a-z, 0-9, _ and -."
      continue
      ;;
  esac
  _len="$(printf '%s' "$USERNAME" | wc -c | tr -d ' ')"
  if [ "$_len" -lt 2 ] || [ "$_len" -gt 24 ]; then
    say "  invalid — must be 2 to 24 characters."
    continue
  fi

  # Fresh secret + recovery for each claim attempt.
  TOKEN="$(gen_token)"
  RECOVERY="$(gen_recovery)"

  _u="$(json_escape "$USERNAME")"
  _t="$(json_escape "$TOKEN")"
  _r="$(json_escape "$RECOVERY")"

  say "  claiming \"$USERNAME\"..."
  _out="$(post_json "$SERVER/claim" "{\"username\":\"$_u\",\"token\":\"$_t\",\"recovery\":\"$_r\"}")"
  last_code

  case "$HTTP_CODE" in
    200)
      say "  claimed: $USERNAME"
      break
      ;;
    409)
      say "  that username is taken — try another."
      continue
      ;;
    000)
      die "could not reach $SERVER — check the server URL / your connection."
      ;;
    *)
      err "  unexpected response from server (HTTP $HTTP_CODE): $_out"
      die "claim failed."
      ;;
  esac
done

# --------------------------------------------------------------------------
# Persist token + recovery locally (secrets — umask 077)
# --------------------------------------------------------------------------
umask 077
mkdir -p "$CONFIG_DIR"
printf '%s' "$TOKEN"    > "$TOKEN_FILE"
printf '%s' "$RECOVERY" > "$RECOVERY_FILE"
chmod 600 "$TOKEN_FILE" "$RECOVERY_FILE" 2>/dev/null || :

# --------------------------------------------------------------------------
# Wire Claude Code hooks (UserPromptSubmit -> /enter, Stop -> /exit)
# Merge safely into ~/.claude/settings.json without clobbering existing config.
# Each hook sends ONLY the token, backgrounded + --max-time 2 so Claude never
# blocks, and de-duped so re-running the installer doesn't pile up entries.
# --------------------------------------------------------------------------
mkdir -p "$SETTINGS_DIR"

# The exact shell commands the hooks run. Single quotes around the JSON body so
# the token is sent verbatim; backgrounded with & and capped at 2s.
ENTER_CMD="curl -sS -m 2 -X POST -H 'Content-Type: application/json' -d '{\"token\":\"$TOKEN\"}' '$SERVER/enter' >/dev/null 2>&1 &"
EXIT_CMD="curl -sS -m 2 -X POST -H 'Content-Type: application/json' -d '{\"token\":\"$TOKEN\"}' '$SERVER/exit' >/dev/null 2>&1 &"

# Back up an existing settings file before touching it.
if [ -f "$SETTINGS_FILE" ]; then
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.backchannel.bak" 2>/dev/null || :
fi

merged_via=""

# --- Preferred path: python3 (robust JSON merge + de-dupe) -----------------
if command -v python3 >/dev/null 2>&1; then
  SETTINGS_FILE="$SETTINGS_FILE" \
  ENTER_CMD="$ENTER_CMD" \
  EXIT_CMD="$EXIT_CMD" \
  python3 - <<'PYEOF' && merged_via="python3"
import json, os, sys

path       = os.environ["SETTINGS_FILE"]
enter_cmd  = os.environ["ENTER_CMD"]
exit_cmd   = os.environ["EXIT_CMD"]

# Load existing settings (tolerate empty / missing / malformed file).
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

hooks = data.get("hooks")
if not isinstance(hooks, dict):
    hooks = {}
data["hooks"] = hooks

def is_backchannel(h):
    """True if a hook entry points at our /enter or /exit endpoint."""
    return (isinstance(h, dict)
            and isinstance(h.get("command"), str)
            and ("/enter" in h["command"] or "/exit" in h["command"]))

def ensure(event, command):
    """Rebuild the event's hook list: strip any prior Backchannel entry
    (de-dupe), preserve everything else, then append our fresh hook."""
    rebuilt = []
    for group in (hooks.get(event) or []):
        if not isinstance(group, dict):
            rebuilt.append(group)
            continue
        inner = group.get("hooks")
        if isinstance(inner, list):
            inner2 = [h for h in inner if not is_backchannel(h)]
            if not inner2:
                # The whole group was just our old hook -> drop the group.
                continue
            group = dict(group)
            group["hooks"] = inner2
        rebuilt.append(group)
    rebuilt.append({
        "matcher": "*",
        "hooks": [{"type": "command", "command": command}],
    })
    hooks[event] = rebuilt

ensure("UserPromptSubmit", enter_cmd)
ensure("Stop", exit_cmd)

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
fi

# --- Fallback: jq ----------------------------------------------------------
if [ -z "$merged_via" ] && command -v jq >/dev/null 2>&1; then
  _tmp="$(mktemp 2>/dev/null || printf '%s' "$SETTINGS_FILE.tmp.$$")"
  # Start from existing object or {} if empty/malformed.
  if [ -s "$SETTINGS_FILE" ] && jq -e . "$SETTINGS_FILE" >/dev/null 2>&1; then
    _base="$SETTINGS_FILE"
  else
    printf '{}' > "$_tmp.base"
    _base="$_tmp.base"
  fi
  if jq \
      --arg enter "$ENTER_CMD" \
      --arg exitc "$EXIT_CMD" '
      # Remove any prior Backchannel hook (identified by the /enter|/exit URL)
      # from an event, dropping groups that become empty. Preserves all others.
      def is_bc: (.command? // "") | (test("/enter") or test("/exit")) ;
      def strip($evt):
        (.hooks[$evt] // [])
        | map(.hooks = ((.hooks? // []) | map(select(is_bc | not))))
        | map(select((.hooks? // []) | length > 0)) ;
      . as $root
      | .hooks = (.hooks // {})
      | .hooks.UserPromptSubmit = ( (strip("UserPromptSubmit"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $enter } ] } ] )
      | .hooks.Stop = ( (strip("Stop"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $exitc } ] } ] )
      ' "$_base" > "$_tmp" 2>/dev/null; then
    mv "$_tmp" "$SETTINGS_FILE"
    rm -f "$_tmp.base" 2>/dev/null || :
    merged_via="jq"
  else
    rm -f "$_tmp" "$_tmp.base" 2>/dev/null || :
  fi
fi

# --- Pure-sh fallback: only safe when there is no existing settings file ---
if [ -z "$merged_via" ]; then
  if [ ! -s "$SETTINGS_FILE" ]; then
    # The hook commands contain backslashes and double-quotes (the embedded JSON
    # body). JSON-escape them (\ -> \\, " -> \") before writing into the file.
    _enter_j="$(json_escape "$ENTER_CMD")"
    _exit_j="$(json_escape "$EXIT_CMD")"
    cat > "$SETTINGS_FILE" <<EOF
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_enter_j" } ] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_exit_j" } ] }
    ]
  }
}
EOF
    merged_via="pure-sh"
  else
    err ""
    err "  ! could not safely merge hooks: neither python3 nor jq is available,"
    err "    and $SETTINGS_FILE already exists (won't risk corrupting it)."
    err "    Add these two hooks manually under .hooks:"
    err "      UserPromptSubmit: $ENTER_CMD"
    err "      Stop:             $EXIT_CMD"
    merged_via="manual"
  fi
fi

# --------------------------------------------------------------------------
# Sign in — mint a single-use pairing code and open the browser straight in.
# The short code (8 chars, 5-min TTL, one-time) is safe to carry in a URL; the
# long token never is. If we can't mint a code or can't open a browser, we fall
# back to printing the sign-in URL and the raw token to paste.
# --------------------------------------------------------------------------
PAIR_CODE=""
_t="$(json_escape "$TOKEN")"
_out="$(post_json "$SERVER/pair/new" "{\"token\":\"$_t\"}")"
last_code
if [ "$HTTP_CODE" = "200" ]; then
  PAIR_CODE="$(printf '%s' "$_out" | json_field code)"
fi

OPENED=""
PAIR_URL=""
if [ -n "$PAIR_CODE" ]; then
  PAIR_URL="$SERVER/?pair=$PAIR_CODE"
  if open_url "$PAIR_URL"; then
    OPENED="yes"
  fi
fi

# --------------------------------------------------------------------------
# Done — print recovery phrase + (only if needed) manual sign-in
# --------------------------------------------------------------------------
say ""
say "  ------------------------------------------------------------"
say "  installed as: $USERNAME"
say "  token saved:  $TOKEN_FILE"
if [ "$merged_via" = "manual" ]; then
  say "  hooks:        NOT wired automatically — see the note above"
else
  say "  hooks:        wired into $SETTINGS_FILE (via $merged_via)"
fi
say "  ------------------------------------------------------------"
say ""
say "  RECOVERY PHRASE — save this. It's the ONLY way to recover your name:"
say ""
say "      $RECOVERY"
say ""
say "  (also written to $RECOVERY_FILE)"
say "  ------------------------------------------------------------"
say ""

if [ -n "$OPENED" ]; then
  say "  opening your browser — you'll land signed in."
  say "  if it didn't pop up, open: $PAIR_URL"
elif [ -n "$PAIR_URL" ]; then
  say "  sign in — open this once (single-use, expires in 5 min):"
  say ""
  say "      $PAIR_URL"
else
  # Couldn't mint a pairing code — fall back to pasting the token.
  say "  sign in — open $SERVER/ and paste this token:"
  say ""
  say "      $TOKEN"
fi
say ""
say "  done. happy building."
say ""
