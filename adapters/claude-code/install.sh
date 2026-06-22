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
SERVER_FILE="$CONFIG_DIR/server"
SHELL_SNIPPET="$CONFIG_DIR/backchannel.sh"
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

# A friendly name for this environment, sent with claim/pair/recover so the
# profile lists real machine names ("devons-mbp") instead of a generic label.
# Strips a trailing .local and anything outside a safe charset; caps at 40 chars.
device_label() {
  _h="$(hostname 2>/dev/null || printf '')"
  _h="$(printf '%s' "$_h" | sed 's/\.local$//' | tr -cd 'A-Za-z0-9 ._-' | cut -c1-40)"
  if [ -n "$_h" ]; then printf '%s' "$_h"; else printf 'terminal'; fi
}
DEVICE_LABEL="$(device_label)"

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
# Add this environment to an existing account. Two self-contained ways:
#   • a PAIRING CODE  (minted on another signed-in device:
#                      backchannel -> your name -> "pair a device")
#                      ADDITIVE: every other environment stays signed in.
#   • your USERNAME + RECOVERY PHRASE (the words saved at sign-up)
#                      DESTRUCTIVE: signs out every other environment.
# We auto-detect: input with a space = a phrase (we then ask the username);
# otherwise = a code. Sets TOKEN (and RECOVERY when known) + MOVED=yes.
# --------------------------------------------------------------------------
move_existing() {
  say ""
  say "  add this environment to your account:"
  say "   • a pairing code (signed-in device: your name -> 'pair a device')"
  say "     -> adds this machine; every other stays signed in, or"
  say "   • your username + recovery phrase"
  say "     -> recovery, only if you've lost access: signs out every"
  say "        other environment and starts fresh here"
  say ""
  while : ; do
    printf '  paste a pairing code OR your recovery phrase: ' > /dev/tty
    IFS= read -r _in < /dev/tty || die "could not read input."
    _in="$(printf '%s' "$_in" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "$_in" ] || { say "  nothing entered — try again."; continue; }

    case "$_in" in
      *[[:space:]]*)
        # Has whitespace -> a recovery phrase. Ask for the username, then rebind.
        printf '  your username: ' > /dev/tty
        IFS= read -r _mu < /dev/tty || die "could not read username."
        _mu="$(printf '%s' "$_mu" | tr 'A-Z' 'a-z' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -n "$_mu" ] || { say "  username required — try again."; continue; }
        TOKEN="$(gen_token)"
        _ju="$(json_escape "$_mu")"; _jr="$(json_escape "$_in")"; _jt="$(json_escape "$TOKEN")"; _jl="$(json_escape "$DEVICE_LABEL")"
        _out="$(post_json "$SERVER/recover" "{\"username\":\"$_ju\",\"recovery\":\"$_jr\",\"newToken\":\"$_jt\",\"label\":\"$_jl\",\"agent\":true}")"
        last_code
        case "$HTTP_CODE" in
          200) RECOVERY="$_in"; USERNAME="$_mu"; MOVED="yes"; say "  recovered: $_mu (other environments signed out)"; return 0 ;;
          403) say "  that username + phrase didn't match — try again." ;;
          429) say "  too many tries — wait a few minutes, then retry." ;;
          000) die "could not reach $SERVER — check your connection." ;;
          *)   say "  recover failed (HTTP $HTTP_CODE) — try again." ;;
        esac
        ;;
      *)
        # No whitespace -> a pairing code (additive).
        _jc="$(json_escape "$_in")"; _jl="$(json_escape "$DEVICE_LABEL")"
        _out="$(post_json "$SERVER/pair/redeem" "{\"code\":\"$_jc\",\"label\":\"$_jl\",\"agent\":true}")"
        last_code
        if [ "$HTTP_CODE" = "200" ]; then
          TOKEN="$(printf '%s' "$_out" | json_field token)"
          if [ -n "$TOKEN" ]; then MOVED="yes"; say "  this environment is paired (others still signed in)."; return 0; fi
          say "  empty pairing response — try again."
        elif [ "$HTTP_CODE" = "000" ]; then
          die "could not reach $SERVER — check your connection."
        else
          say "  that code is invalid or expired — try again."
        fi
        ;;
    esac
  done
}

# --------------------------------------------------------------------------
# Identity: reuse an existing install, start a new account, or move one here.
#
# Idempotent: if this machine already has a token, we REUSE that identity and
# just re-run the wiring (never a duplicate user, never a rotated secret).
# Otherwise we fork: NEW claims a username (+ generates a recovery phrase the
# user must save); MOVE pulls an existing identity onto this device.
# --------------------------------------------------------------------------
TOKEN=""
RECOVERY=""
USERNAME=""
EXISTING_INSTALL=""
MOVED=""
CHOICE=""

if [ -s "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE" 2>/dev/null || printf '')"
  if [ -n "$TOKEN" ]; then
    # Confirm the token is still live before reusing it. A recovery on another
    # machine revokes this environment server-side, leaving a dead token on disk;
    # a hard 401 means exactly that, so we drop the reuse path and let the user
    # reconnect (pair / claim). A network error (000/5xx) is NOT treated as dead,
    # so installs still work offline and survive transient server hiccups.
    _jt="$(json_escape "$TOKEN")"
    _out="$(post_json "$SERVER/verify" "{\"token\":\"$_jt\"}")"
    last_code
    if [ "$HTTP_CODE" = "401" ]; then
      say "  this environment was signed out remotely (a recovery on another"
      say "  machine). let's reconnect it."
      TOKEN=""
    else
      EXISTING_INSTALL="yes"
      [ -s "$RECOVERY_FILE" ] && RECOVERY="$(cat "$RECOVERY_FILE" 2>/dev/null || printf '')" || RECOVERY=""
      say "  existing install found — keeping your identity, re-wiring hooks."
    fi
  fi
fi

# Fork only when this machine has no token yet. Enter defaults to "new".
if [ -z "$EXISTING_INSTALL" ]; then
  say ""
  say "  new here, or adding this environment to an existing account?"
  while [ -z "$CHOICE" ]; do
    printf '  [n] new account   [a] add this environment  (n/a): ' > /dev/tty
    IFS= read -r _c < /dev/tty || die "could not read choice."
    case "$(printf '%s' "$_c" | tr 'A-Z' 'a-z' | tr -d '[:space:]')" in
      n|new|"")        CHOICE="new" ;;
      a|add|m|move)    CHOICE="move" ;;
      *)               say "  please type n or a." ;;
    esac
  done
fi

if [ "$CHOICE" = "move" ]; then
  move_existing
fi

# Invite-only: new accounts need a code to claim. Ask once up front (re-prompted
# below if the server rejects it). Normalize to the code alphabet locally too.
INVITE=""
INVITES=""
if [ "$CHOICE" = "new" ]; then
  printf '  invite code (ask a builder who is already in): ' > /dev/tty
  IFS= read -r INVITE < /dev/tty || die "could not read invite code."
  INVITE="$(printf '%s' "$INVITE" | tr 'a-z' 'A-Z' | tr -cd '0-9A-Z')"
fi

while [ "$CHOICE" = "new" ] ; do
  printf '  choose a username (2-24 chars, a-z 0-9 _ -): ' > /dev/tty
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
  _ic="$(json_escape "$INVITE")"
  _jl="$(json_escape "$DEVICE_LABEL")"

  say "  claiming \"$USERNAME\"..."
  _out="$(post_json "$SERVER/claim" "{\"username\":\"$_u\",\"token\":\"$_t\",\"recovery\":\"$_r\",\"code\":\"$_ic\",\"label\":\"$_jl\"}")"
  last_code

  case "$HTTP_CODE" in
    200)
      say "  claimed: $USERNAME"
      # Pull the new user's own invite codes out of the response (a JSON array of
      # strings) into a space-separated list for display below.
      INVITES="$(printf '%s' "$_out" | sed -n 's/.*"invites":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' ' ')"
      break
      ;;
    409)
      say "  that username is taken — try another."
      continue
      ;;
    403)
      say "  that invite code isn't valid (or it's already been used)."
      printf '  invite code: ' > /dev/tty
      IFS= read -r INVITE < /dev/tty || die "could not read invite code."
      INVITE="$(printf '%s' "$INVITE" | tr 'a-z' 'A-Z' | tr -cd '0-9A-Z')"
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
# Persist token + recovery locally (secrets — umask 077). For an existing
# install the files already hold the right values — don't overwrite (we'd blank
# the recovery phrase), just ensure the dir + perms.
# --------------------------------------------------------------------------
umask 077
mkdir -p "$CONFIG_DIR"
if [ -z "$EXISTING_INSTALL" ]; then
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  # Recovery is only known on a NEW account or a MOVE-via-phrase; a MOVE-via-code
  # never sees it, so don't clobber any existing file with an empty value.
  [ -n "$RECOVERY" ] && printf '%s' "$RECOVERY" > "$RECOVERY_FILE"
fi
chmod 600 "$TOKEN_FILE" 2>/dev/null || :
[ -s "$RECOVERY_FILE" ] && chmod 600 "$RECOVERY_FILE" 2>/dev/null || :

# --------------------------------------------------------------------------
# NEW ACCOUNT: show the identity + recovery phrase prominently and REQUIRE the
# user to confirm they saved it BEFORE we wire anything or open the browser.
# This is the one moment the recovery phrase is ever shown — losing it means
# losing the account (unless another device is still signed in to link from).
# --------------------------------------------------------------------------
if [ "$CHOICE" = "new" ]; then
  say ""
  say "  ============================================================"
  say "   SAVE THIS — your way back into your account"
  say "  ============================================================"
  say "   username:        $USERNAME"
  say ""
  say "   recovery phrase: $RECOVERY"
  say ""
  say "   You'll need the phrase (with your username) to sign in on"
  say "   another device or if you lose this machine. It is shown"
  say "   ONLY now. A copy is at $RECOVERY_FILE — but write it down."
  if [ -n "$INVITES" ]; then
    say "  ------------------------------------------------------------"
    say "   invite codes — share these to bring others in:"
    say ""
    for _code in $INVITES; do say "       $_code"; done
    say ""
    say "   (also in the app: your name → invite codes)"
  fi
  say "  ============================================================"
  say ""
  while : ; do
    printf "  type 'saved' once you've written down your recovery phrase: " > /dev/tty
    IFS= read -r _ack < /dev/tty || die "could not read confirmation."
    case "$(printf '%s' "$_ack" | tr 'A-Z' 'a-z' | tr -d '[:space:]')" in
      saved) break ;;
      *)     say "  please type 'saved' to continue." ;;
    esac
  done
fi

# --------------------------------------------------------------------------
# Presence hook helper. One small script handles every Claude Code event, reads
# the token + server from disk at runtime (so neither is duplicated into
# settings.json), and forwards Claude's session_id so concurrent agents are
# tracked independently — one ending never kicks you while another still builds.
# --------------------------------------------------------------------------
HOOK_SH="$CONFIG_DIR/hook.sh"
# Persist the server origin early so hook.sh can read it (also re-written later
# for the shell snippet; harmless to write twice).
printf '%s' "$SERVER" > "$SERVER_FILE"

# Quoted heredoc ('HOOKEOF') — nothing here is expanded by the installer; the
# script reads token/server from $CONFIG_DIR at runtime.
cat > "$HOOK_SH" <<'HOOKEOF'
#!/bin/sh
# Backchannel presence hook (Claude Code). One script, three events:
#   prompt -> you fired a prompt (a real turn): presence + counts a "session"
#   enter  -> heartbeat (PreToolUse) or answering a question: presence only
#   exit   -> a turn/session ended: that session goes quiet
# Claude pipes the hook JSON (with session_id) on stdin; we forward that id so
# concurrent agents are tracked independently and one ending never kicks you out
# while another is still building. Sends ONLY the token (read from disk).
#
# 'prompt' runs SYNCHRONOUSLY (once per turn) so it can read back a re-engagement
# nudge from the server and hand it to Claude as additionalContext — your agent
# then drops a chill one-liner ("2 unread mentions in the backchannel") into its
# reply, without interrupting your actual task. Capped at 3s; any failure = no
# nudge, never an error. 'enter'/'exit' stay backgrounded so they never block.
# Missing prereqs (curl/token/server) = silent no-op.
set -eu
EVENT="${1:-enter}"
DIR="${BACKCHANNEL_CONFIG_DIR:-$HOME/.config/backchannel}"

# Read the hook JSON from stdin ONCE, then pull session_id from it (best-effort).
STDIN_JSON="$(cat 2>/dev/null || printf '')"
SID="$(printf '%s' "$STDIN_JSON" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"

command -v curl >/dev/null 2>&1 || exit 0
[ -r "$DIR/token" ] || exit 0
TOKEN="$(tr -d '\r\n' < "$DIR/token" 2>/dev/null)"
[ -n "$TOKEN" ] || exit 0
SERVER="$(head -n1 "$DIR/server" 2>/dev/null | tr -d '\r\n')"
SERVER="${SERVER%/}"
[ -n "$SERVER" ] || exit 0

case "$EVENT" in
  exit) ENDPOINT="exit" ;;
  *)    ENDPOINT="enter" ;;
esac
BODY="{\"token\":\"$TOKEN\",\"session\":\"$SID\",\"event\":\"$EVENT\"}"

# Heartbeat / exit: fire-and-forget, capped at 2s, so Claude never blocks.
if [ "$EVENT" != "prompt" ]; then
  curl -sS -m 2 -X POST -H 'Content-Type: application/json' \
    -d "$BODY" "$SERVER/$ENDPOINT" >/dev/null 2>&1 &
  exit 0
fi

# Prompt: synchronous so we can surface the nudge this turn. Marks presence too.
RESP="$(curl -sS -m 3 -X POST -H 'Content-Type: application/json' \
  -d "$BODY" "$SERVER/enter" 2>/dev/null || printf '')"

# Pull nudge.text out of the response. The server only ever puts safe characters
# (no quotes/backslashes) in this field, so a flat extraction is enough.
NUDGE="$(printf '%s' "$RESP" | sed -n 's/.*"nudge":{.*"text":"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$NUDGE" ] || exit 0
NUDGE="${NUDGE%.}"   # drop a trailing period so the wrapper reads cleanly

# JSON-escape (defensive) and wrap with a gentle instruction so the agent relays
# it as a calm aside, never letting it derail the user's real request.
ESC="$(printf '%s' "$NUDGE" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
CTX="Backchannel — a calm side-channel for builders, unrelated to the current task: ${ESC}. If it fits naturally, add ONE short, friendly line about this at the very end of your reply. Never let it change, delay, or interrupt your work on the user's actual request; if it doesn't fit cleanly, just skip it."
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$CTX"
exit 0
HOOKEOF
chmod 644 "$HOOK_SH" 2>/dev/null || :

# --------------------------------------------------------------------------
# Wire Claude Code hooks into ~/.claude/settings.json (merge, never clobber;
# de-duped so re-running the installer doesn't pile up entries). Each hook just
# invokes hook.sh with its event name — the token lives only in the config dir.
# --------------------------------------------------------------------------
mkdir -p "$SETTINGS_DIR"

# The exact shell commands the hooks run (token is NOT embedded — hook.sh reads it).
PROMPT_CMD="sh \"$HOOK_SH\" prompt"
ENTER_CMD="sh \"$HOOK_SH\" enter"
EXIT_CMD="sh \"$HOOK_SH\" exit"

# Back up an existing settings file before touching it.
if [ -f "$SETTINGS_FILE" ]; then
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.backchannel.bak" 2>/dev/null || :
fi

merged_via=""

# --- Preferred path: python3 (robust JSON merge + de-dupe) -----------------
if command -v python3 >/dev/null 2>&1; then
  SETTINGS_FILE="$SETTINGS_FILE" \
  PROMPT_CMD="$PROMPT_CMD" \
  ENTER_CMD="$ENTER_CMD" \
  EXIT_CMD="$EXIT_CMD" \
  python3 - <<'PYEOF' && merged_via="python3"
import json, os, sys

path       = os.environ["SETTINGS_FILE"]
prompt_cmd = os.environ["PROMPT_CMD"]
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
    """True if a hook entry is one of ours — matches both the new hook.sh form
    and any older inline curl /enter|/exit command (so re-running migrates)."""
    if not (isinstance(h, dict) and isinstance(h.get("command"), str)):
        return False
    c = h["command"]
    return ("backchannel" in c) or ("/enter" in c) or ("/exit" in c)

def ensure(event, command, matcher="*"):
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
        "matcher": matcher,
        "hooks": [{"type": "command", "command": command}],
    })
    hooks[event] = rebuilt

# UserPromptSubmit is a real turn -> 'prompt' (presence + counts a session).
ensure("UserPromptSubmit", prompt_cmd)
ensure("Stop", exit_cmd)
# Stop misses some endings (API errors -> StopFailure; app close -> SessionEnd).
# Exit on those too, so a session is released. (Interrupts/silent stalls fire no
# hook at all — the server's inactivity backstop reaps those.)
ensure("StopFailure", exit_cmd)
ensure("SessionEnd", exit_cmd)
# PreToolUse on ALL tools = the heartbeat that keeps a session alive through a
# turn. PostToolUse(AskUserQuestion) re-asserts the moment you answer a question
# (answers fire PostToolUse, not UserPromptSubmit). Both are 'enter' (presence
# only — they must NOT inflate the session count).
ensure("PreToolUse", enter_cmd, "*")
ensure("PostToolUse", enter_cmd, "AskUserQuestion")

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
      --arg prompt "$PROMPT_CMD" \
      --arg enter "$ENTER_CMD" \
      --arg exitc "$EXIT_CMD" '
      # Remove any prior Backchannel hook (new hook.sh form or older inline
      # curl /enter|/exit) from an event, dropping groups that become empty.
      def is_bc: (.command? // "") | (test("backchannel") or test("/enter") or test("/exit")) ;
      def strip($evt):
        (.hooks[$evt] // [])
        | map(.hooks = ((.hooks? // []) | map(select(is_bc | not))))
        | map(select((.hooks? // []) | length > 0)) ;
      . as $root
      | .hooks = (.hooks // {})
      | .hooks.UserPromptSubmit = ( (strip("UserPromptSubmit"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $prompt } ] } ] )
      | .hooks.Stop = ( (strip("Stop"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $exitc } ] } ] )
      | .hooks.StopFailure = ( (strip("StopFailure"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $exitc } ] } ] )
      | .hooks.SessionEnd = ( (strip("SessionEnd"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $exitc } ] } ] )
      | .hooks.PreToolUse = ( (strip("PreToolUse"))
          + [ { "matcher": "*", "hooks": [ { "type": "command", "command": $enter } ] } ] )
      | .hooks.PostToolUse = ( (strip("PostToolUse"))
          + [ { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": $enter } ] } ] )
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
    _prompt_j="$(json_escape "$PROMPT_CMD")"
    _enter_j="$(json_escape "$ENTER_CMD")"
    _exit_j="$(json_escape "$EXIT_CMD")"
    cat > "$SETTINGS_FILE" <<EOF
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_prompt_j" } ] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_exit_j" } ] }
    ],
    "StopFailure": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_exit_j" } ] }
    ],
    "SessionEnd": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_exit_j" } ] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$_enter_j" } ] }
    ],
    "PostToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "$_enter_j" } ] }
    ]
  }
}
EOF
    merged_via="pure-sh"
  else
    err ""
    err "  ! could not safely merge hooks: neither python3 nor jq is available,"
    err "    and $SETTINGS_FILE already exists (won't risk corrupting it)."
    err "    Add these hooks manually under .hooks (each runs hook.sh):"
    err "      UserPromptSubmit: $PROMPT_CMD"
    err "      PreToolUse(*):    $ENTER_CMD"
    err "      Stop/SessionEnd:  $EXIT_CMD"
    merged_via="manual"
  fi
fi

# --------------------------------------------------------------------------
# Wire Codex hooks (~/.codex/hooks.json) to the SAME hook.sh. Codex's hook
# system mirrors Claude's (UserPromptSubmit/PreToolUse/Stop, event JSON with
# session_id on stdin), so the one helper covers both. This is what makes Codex
# (CLI or the desktop app, which share ~/.codex) actually mark you present —
# the shell snippet below can't see a GUI agent. Safe + idempotent.
# --------------------------------------------------------------------------
CODEX_DIR="$HOME/.codex"
CODEX_HOOKS="$CODEX_DIR/hooks.json"
codex_via=""
mkdir -p "$CODEX_DIR" 2>/dev/null || :
[ -f "$CODEX_HOOKS" ] && cp "$CODEX_HOOKS" "$CODEX_HOOKS.backchannel.bak" 2>/dev/null || :

if command -v python3 >/dev/null 2>&1; then
  CODEX_HOOKS="$CODEX_HOOKS" \
  PROMPT_CMD="$PROMPT_CMD" ENTER_CMD="$ENTER_CMD" EXIT_CMD="$EXIT_CMD" \
  python3 - <<'PYEOF' && codex_via="python3"
import json, os
path = os.environ["CODEX_HOOKS"]
prompt, enter, exitc = os.environ["PROMPT_CMD"], os.environ["ENTER_CMD"], os.environ["EXIT_CMD"]
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

def is_bc(h):
    return (isinstance(h, dict) and isinstance(h.get("command"), str)
            and ("backchannel" in h["command"] or "/enter" in h["command"] or "/exit" in h["command"]))

def ensure(ev, cmd):
    rebuilt = []
    for g in (hooks.get(ev) or []):
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            inner = [h for h in g["hooks"] if not is_bc(h)]
            if not inner:
                continue
            g = dict(g); g["hooks"] = inner
        rebuilt.append(g)
    rebuilt.append({"matcher": ".*", "hooks": [{"type": "command", "command": cmd}]})
    hooks[ev] = rebuilt

ensure("UserPromptSubmit", prompt)
ensure("PreToolUse", enter)
ensure("Stop", exitc)
with open(path, "w") as f:
    json.dump(data, f, indent=2); f.write("\n")
PYEOF
fi

if [ -z "$codex_via" ] && command -v jq >/dev/null 2>&1; then
  _tmp="$(mktemp 2>/dev/null || printf '%s' "$CODEX_HOOKS.tmp.$$")"
  if [ -s "$CODEX_HOOKS" ] && jq -e . "$CODEX_HOOKS" >/dev/null 2>&1; then _base="$CODEX_HOOKS"; else printf '{}' > "$_tmp.base"; _base="$_tmp.base"; fi
  if jq --arg prompt "$PROMPT_CMD" --arg enter "$ENTER_CMD" --arg exitc "$EXIT_CMD" '
      def is_bc: (.command? // "") | (test("backchannel") or test("/enter") or test("/exit")) ;
      def strip($e): (.hooks[$e] // []) | map(.hooks = ((.hooks? // []) | map(select(is_bc | not)))) | map(select((.hooks? // []) | length > 0)) ;
      .hooks = (.hooks // {})
      | .hooks.UserPromptSubmit = ((strip("UserPromptSubmit")) + [ {"matcher":".*","hooks":[{"type":"command","command":$prompt}]} ])
      | .hooks.PreToolUse = ((strip("PreToolUse")) + [ {"matcher":".*","hooks":[{"type":"command","command":$enter}]} ])
      | .hooks.Stop = ((strip("Stop")) + [ {"matcher":".*","hooks":[{"type":"command","command":$exitc}]} ])
    ' "$_base" > "$_tmp" 2>/dev/null; then
    mv "$_tmp" "$CODEX_HOOKS"; rm -f "$_tmp.base" 2>/dev/null || :; codex_via="jq"
  else
    rm -f "$_tmp" "$_tmp.base" 2>/dev/null || :
  fi
fi

if [ -z "$codex_via" ] && [ ! -s "$CODEX_HOOKS" ]; then
  _p="$(json_escape "$PROMPT_CMD")"; _e="$(json_escape "$ENTER_CMD")"; _x="$(json_escape "$EXIT_CMD")"
  cat > "$CODEX_HOOKS" <<EOF
{
  "hooks": {
    "UserPromptSubmit": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "$_p" } ] } ],
    "PreToolUse": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "$_e" } ] } ],
    "Stop": [ { "matcher": ".*", "hooks": [ { "type": "command", "command": "$_x" } ] } ]
  }
}
EOF
  codex_via="pure-sh"
fi

# --------------------------------------------------------------------------
# Shell integration — gate presence for NON-Claude CLI agents + raw terminal.
#
# Claude Code uses the precise native hooks wired above. This step is ADDITIVE:
# it installs a sourced shell snippet that watches for other CLI coding agents
# (codex, aider, gemini, ...) and fires the same /enter|/exit {token} pings.
#   1. write the SERVER origin to ~/.config/backchannel/server (the snippet
#      reads it at runtime — token + server both live under the config dir).
#   2. write the snippet itself to ~/.config/backchannel/backchannel.sh.
#   3. detect the user's login shell and idempotently add ONE guarded
#      'source ~/.config/backchannel/backchannel.sh' line to the right rc file.
# --------------------------------------------------------------------------

# (1) The server origin was already persisted to $SERVER_FILE earlier (for
# hook.sh); the snippet reads the same file. Nothing to do here.

# (2) Write the shell snippet. Quoted heredoc ('SHELLEOF') so NOTHING inside is
# expanded by this installer — the snippet ships verbatim, exactly as authored.
cat > "$SHELL_SNIPPET" <<'SHELLEOF'
# backchannel.sh — tool-agnostic shell presence integration
# ----------------------------------------------------------------------------
# Sourced from your ~/.zshrc or ~/.bashrc by the Backchannel installer:
#     source ~/.config/backchannel/backchannel.sh
#
# Backchannel only lets you be PRESENT while your agent is working. Claude Code
# has precise native hooks (UserPromptSubmit -> /enter, Stop -> /exit) and does
# NOT need this. This snippet covers EVERYTHING ELSE: other CLI coding agents
# (codex, aider, gemini, llm, goose, opencode, ...) and — optionally — any
# long-running terminal command, so your dead-time gates presence too.
#
# When you run a command whose program matches the agent list, we POST /enter
# {token} as it starts and POST /exit {token} when it finishes. The curl calls
# are backgrounded and capped at 2s, so your prompt NEVER blocks or hangs.
#
# SAFETY: sends ONLY the token (~/.config/backchannel/token), never a URL or
# username. Silent + non-fatal if curl/token/server are missing. Idempotent.
#
# CONFIG (env vars, set before sourcing):
#   BACKCHANNEL_AGENTS        space-separated programs that gate presence.
#                             Default: "codex aider gemini llm goose opencode
#                             hermes openclaw".
#                             DELIBERATELY excludes "claude" (native hooks).
#   BACKCHANNEL_WATCH_ALL     "1" to also gate ANY command running longer than
#                             BACKCHANNEL_WATCH_SECONDS. Default: off.
#   BACKCHANNEL_WATCH_SECONDS threshold seconds for WATCH_ALL. Default: 30.
#   BACKCHANNEL_CONFIG_DIR    config dir. Default: ~/.config/backchannel.
# ----------------------------------------------------------------------------

# Only meaningful in an interactive shell; otherwise a harmless no-op.
case "$-" in
  *i*) ;;
  *)   return 0 2>/dev/null || true ;;
esac

# --- Configuration ----------------------------------------------------------
: "${BACKCHANNEL_CONFIG_DIR:=$HOME/.config/backchannel}"
: "${BACKCHANNEL_AGENTS:=codex aider gemini llm goose opencode hermes openclaw}"
: "${BACKCHANNEL_WATCH_ALL:=0}"
: "${BACKCHANNEL_WATCH_SECONDS:=30}"

_BACKCHANNEL_TOKEN_FILE="$BACKCHANNEL_CONFIG_DIR/token"
_BACKCHANNEL_SERVER_FILE="$BACKCHANNEL_CONFIG_DIR/server"

# Read the server origin (written by the installer). Returns nonzero if missing.
_backchannel_server() {
  [ -r "$_BACKCHANNEL_SERVER_FILE" ] || return 1
  _bc_s=$(head -n1 "$_BACKCHANNEL_SERVER_FILE" 2>/dev/null)
  _bc_s=${_bc_s%/}
  [ -n "$_bc_s" ] || return 1
  printf '%s' "$_bc_s"
}

# Fire a presence ping at /enter or /exit. $1 is "enter" or "exit".
# Sends ONLY the token, backgrounded + --max-time 2, all output discarded.
# Any missing prerequisite (curl, token, server) makes this a silent no-op.
_backchannel_ping() {
  command -v curl >/dev/null 2>&1 || return 0
  [ -r "$_BACKCHANNEL_TOKEN_FILE" ] || return 0

  _bc_server=$(_backchannel_server) || return 0
  _bc_token=$(head -n1 "$_BACKCHANNEL_TOKEN_FILE" 2>/dev/null)
  [ -n "$_bc_token" ] || return 0

  # Backgrounded in a subshell so the "[1] Done" job notice never leaks to the
  # terminal, and a hung server can never stall the prompt.
  ( curl -sS --max-time 2 \
      -H 'Content-Type: application/json' \
      -X POST "$_bc_server/$1" \
      -d "{\"token\":\"$_bc_token\"}" \
      >/dev/null 2>&1 & ) >/dev/null 2>&1
}

# Decide whether an about-to-run command line gates presence ($1 = command line).
# On a match: set _BACKCHANNEL_ACTIVE=1 and fire /enter. In WATCH_ALL mode a
# non-agent command is recorded as a candidate (duration judged at completion).
_backchannel_should_track() {
  _bc_cmdline="$1"
  [ -n "$_bc_cmdline" ] || return 0

  # Program name via parameter expansion + case ONLY (no word splitting): zsh
  # does not field-split unquoted "$var", so for-in-$var would see one token.
  # This idiom behaves identically in sh, bash, and zsh.
  # Peel leading VAR=value env-assignments, then take the first token, basename.
  _bc_rest="$_bc_cmdline"
  while : ; do
    _bc_rest="${_bc_rest#"${_bc_rest%%[![:space:]]*}"}"   # ltrim
    _bc_head="${_bc_rest%%[[:space:]]*}"                   # first token
    case "$_bc_head" in
      ?*=*) _bc_rest="${_bc_rest#"$_bc_head"}" ;;          # assignment -> drop
      *)    break ;;
    esac
  done
  _bc_prog="${_bc_rest%%[[:space:]]*}"
  _bc_prog="${_bc_prog##*/}"
  [ -n "$_bc_prog" ] || return 0

  # Match the agent list with a space-padded glob (no word-splitting needed).
  case " $BACKCHANNEL_AGENTS " in
    *" $_bc_prog "*)
      _BACKCHANNEL_ACTIVE=1
      _backchannel_ping enter
      return 0
      ;;
  esac

  if [ "$BACKCHANNEL_WATCH_ALL" = "1" ]; then
    _BACKCHANNEL_WATCH_CANDIDATE=1
    _BACKCHANNEL_WATCH_START=$(date +%s 2>/dev/null || printf '0')
  fi
  return 0
}

# Called after a command completes (precmd / PROMPT_COMMAND). Closes out an
# agent /enter with /exit, or — in WATCH_ALL — credits long dead-time after the
# fact with a paired enter+exit (duration is only knowable once it's finished).
_backchannel_post() {
  if [ "${_BACKCHANNEL_ACTIVE:-0}" = "1" ]; then
    _BACKCHANNEL_ACTIVE=0
    _backchannel_ping exit
  fi

  if [ "${_BACKCHANNEL_WATCH_CANDIDATE:-0}" = "1" ]; then
    _BACKCHANNEL_WATCH_CANDIDATE=0
    _bc_now=$(date +%s 2>/dev/null || printf '0')
    _bc_start=${_BACKCHANNEL_WATCH_START:-0}
    _BACKCHANNEL_WATCH_START=0
    if [ "$_bc_now" -gt 0 ] && [ "$_bc_start" -gt 0 ]; then
      _bc_dur=$(( _bc_now - _bc_start ))
      if [ "$_bc_dur" -ge "$BACKCHANNEL_WATCH_SECONDS" ]; then
        _backchannel_ping enter
        _backchannel_ping exit
      fi
    fi
  fi
}

# ----------------------------------------------------------------------------
# Shell-specific wiring. Detect zsh vs bash; bind hooks idempotently.
# ----------------------------------------------------------------------------
if [ -n "${ZSH_VERSION:-}" ]; then
  # zsh: preexec (before a command, receives the line as $1) + precmd (after).
  _backchannel_preexec() { _backchannel_should_track "$1"; }
  _backchannel_precmd()  { _backchannel_post; }

  autoload -Uz add-zsh-hook 2>/dev/null
  if whence add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook preexec _backchannel_preexec   # de-dupes by function name
    add-zsh-hook precmd  _backchannel_precmd
  else
    case " ${preexec_functions[*]} " in *" _backchannel_preexec "*) ;; *) preexec_functions+=(_backchannel_preexec) ;; esac
    case " ${precmd_functions[*]}  " in *" _backchannel_precmd "*)  ;; *) precmd_functions+=(_backchannel_precmd)   ;; esac
  fi

elif [ -n "${BASH_VERSION:-}" ]; then
  # bash: DEBUG trap (before each command, $BASH_COMMAND) + PROMPT_COMMAND (after).
  # We gate on _BACKCHANNEL_AT_PROMPT so only the FIRST command of an interactive
  # line is tracked and our own bookkeeping is never treated as a command.
  _BACKCHANNEL_AT_PROMPT=1

  _backchannel_debug_trap() {
    [ "${_BACKCHANNEL_AT_PROMPT:-0}" = "1" ] && return 0
    case "$BASH_COMMAND" in
      _backchannel_*|"$PROMPT_COMMAND") return 0 ;;
    esac
    _backchannel_should_track "$BASH_COMMAND"
    # Suppress further DEBUG hits for this command line until PROMPT_COMMAND.
    _BACKCHANNEL_AT_PROMPT=1
  }

  _backchannel_prompt_command() {
    _backchannel_post
    _BACKCHANNEL_AT_PROMPT=0   # re-open the trap for the next command line
  }

  trap '_backchannel_debug_trap' DEBUG

  # Prepend our handler to PROMPT_COMMAND exactly once (guarded; preserves yours).
  case "${PROMPT_COMMAND:-}" in
    *_backchannel_prompt_command*) ;;
    "")  PROMPT_COMMAND="_backchannel_prompt_command" ;;
    *)   PROMPT_COMMAND="_backchannel_prompt_command;${PROMPT_COMMAND}" ;;
  esac
fi

return 0 2>/dev/null || true
SHELLEOF
chmod 600 "$SERVER_FILE" 2>/dev/null || :
chmod 644 "$SHELL_SNIPPET" 2>/dev/null || :

# (3) Detect the user's shell and wire a single guarded source line into the
# right rc file. We pick the rc by the login shell ($SHELL), guarded by a marker
# so re-running the installer never duplicates the line.
SHELL_WIRED=""
BC_MARKER="# >>> backchannel shell integration >>>"
BC_SOURCE_LINE="source \"$SHELL_SNIPPET\""

# Choose the rc file from the login shell's basename.
_login_shell="${SHELL##*/}"
case "$_login_shell" in
  zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)
    # Unknown shell: fall back to whichever rc already exists, preferring zsh.
    if [ -f "$HOME/.zshrc" ]; then RC_FILE="$HOME/.zshrc"
    elif [ -f "$HOME/.bashrc" ]; then RC_FILE="$HOME/.bashrc"
    else RC_FILE="" ; fi
    ;;
esac

if [ -n "$RC_FILE" ]; then
  # Idempotent: only append the guarded block if our marker isn't already there.
  if [ -f "$RC_FILE" ] && grep -qF "$BC_MARKER" "$RC_FILE" 2>/dev/null; then
    SHELL_WIRED="already"
  else
    {
      printf '\n%s\n' "$BC_MARKER"
      printf '%s\n' "[ -f \"$SHELL_SNIPPET\" ] && $BC_SOURCE_LINE"
      printf '%s\n' "# <<< backchannel shell integration <<<"
    } >> "$RC_FILE" 2>/dev/null && SHELL_WIRED="$RC_FILE"
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
if [ -n "$EXISTING_INSTALL" ]; then
  say "  re-wired existing install (identity unchanged)"
elif [ -n "$MOVED" ]; then
  say "  added this environment to your account"
else
  say "  installed as: $USERNAME"
fi
say "  token saved:  $TOKEN_FILE"
if [ "$merged_via" = "manual" ]; then
  say "  hooks:        NOT wired automatically — see the note above"
else
  say "  hooks:        wired into $SETTINGS_FILE (via $merged_via)"
fi
if [ -n "$codex_via" ]; then
  say "  codex:        wired into $CODEX_HOOKS (via $codex_via)"
else
  say "  codex:        hooks NOT wired ($CODEX_HOOKS exists; no python3/jq) — add by hand"
fi
case "$SHELL_WIRED" in
  "")        say "  cli agents:   shell integration NOT wired (unknown shell — source $SHELL_SNIPPET manually)" ;;
  already)   say "  cli agents:   covered — shell integration already in your rc (codex, aider, gemini, ...)" ;;
  *)         say "  cli agents:   covered — shell integration added to $SHELL_WIRED (codex, aider, gemini, ...)" ;;
esac
# A new account already saw + confirmed its recovery phrase above the gate; just
# a one-line reminder of where the copy lives.
if [ "$CHOICE" = "new" ]; then
  say "  recovery:     phrase saved to $RECOVERY_FILE (you wrote it down above)"
fi
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
