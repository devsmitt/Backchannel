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

ensure("UserPromptSubmit", enter_cmd)
ensure("Stop", exit_cmd)
# Questions (AskUserQuestion) don't fire UserPromptSubmit on answer, so without
# these you'd get exited by Stop and never re-entered. PreToolUse = we're asking;
# PostToolUse = you answered and the agent is resuming. Both re-enter you.
ensure("PreToolUse", enter_cmd, "AskUserQuestion")
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
      | .hooks.PreToolUse = ( (strip("PreToolUse"))
          + [ { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": $enter } ] } ] )
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
    ],
    "PreToolUse": [
      { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "$_enter_j" } ] }
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
    err "    Add these two hooks manually under .hooks:"
    err "      UserPromptSubmit: $ENTER_CMD"
    err "      Stop:             $EXIT_CMD"
    merged_via="manual"
  fi
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

# (1) Persist the server origin for the snippet to read. Not secret, but keep
# the tidy 600 from the umask above; the snippet only needs to read it.
printf '%s' "$SERVER" > "$SERVER_FILE"

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
#                             Default: "codex aider gemini llm goose opencode".
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
: "${BACKCHANNEL_AGENTS:=codex aider gemini llm goose opencode}"
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
say "  installed as: $USERNAME"
say "  token saved:  $TOKEN_FILE"
if [ "$merged_via" = "manual" ]; then
  say "  hooks:        NOT wired automatically — see the note above"
else
  say "  hooks:        wired into $SETTINGS_FILE (via $merged_via)"
fi
case "$SHELL_WIRED" in
  "")        say "  cli agents:   shell integration NOT wired (unknown shell — source $SHELL_SNIPPET manually)" ;;
  already)   say "  cli agents:   covered — shell integration already in your rc (codex, aider, gemini, ...)" ;;
  *)         say "  cli agents:   covered — shell integration added to $SHELL_WIRED (codex, aider, gemini, ...)" ;;
esac
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
