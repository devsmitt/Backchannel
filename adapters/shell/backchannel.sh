# backchannel.sh — tool-agnostic shell presence integration
# ----------------------------------------------------------------------------
# Source this from your ~/.zshrc or ~/.bashrc (the installer does that for you):
#
#     source ~/.config/backchannel/backchannel.sh
#
# WHAT IT DOES
#   Backchannel only lets you be PRESENT while your agent is working. Claude Code
#   has precise native hooks (UserPromptSubmit -> /enter, Stop -> /exit) and does
#   NOT need this. This snippet covers EVERYTHING ELSE: other CLI coding agents
#   (codex, aider, gemini, llm, goose, opencode, ...) and — optionally — any
#   long-running terminal command, so your dead-time gates presence too.
#
#   When you run a command whose program matches the agent list, we POST /enter
#   {token} as it starts and POST /exit {token} when it finishes. The curl calls
#   are backgrounded and capped at 2s, so your prompt NEVER blocks or hangs.
#
# SAFETY / CONTRACT
#   - Sends ONLY the token (read from ~/.config/backchannel/token). Never a URL,
#     never a username — the server resolves identity from the token's hash.
#   - Completely silent and non-fatal: missing curl, missing token, or a dead
#     server all degrade to a no-op. Sourcing this never prints or errors.
#   - Idempotent: safe to source multiple times (re-sourcing just rebinds hooks).
#   - Works in BOTH zsh (preexec/precmd) and bash (DEBUG trap + PROMPT_COMMAND),
#     and leaves any existing hooks you already had in place untouched.
#
# CONFIG (env vars — set BEFORE sourcing, or in your rc above the source line)
#   BACKCHANNEL_AGENTS        space-separated program names that gate presence.
#                             Default: "codex aider gemini llm goose opencode".
#                             DELIBERATELY excludes "claude" (it has native hooks).
#   BACKCHANNEL_WATCH_ALL     "1" to also gate on ANY command that runs longer
#                             than BACKCHANNEL_WATCH_SECONDS (pure-terminal
#                             dead-time). Default: off.
#   BACKCHANNEL_WATCH_SECONDS threshold in seconds for WATCH_ALL. Default: 30.
#   BACKCHANNEL_CONFIG_DIR    config dir. Default: ~/.config/backchannel.
# ----------------------------------------------------------------------------

# Guard: only meaningful in an interactive shell. (Sourcing in a script is a
# harmless no-op rather than an error.)
case "$-" in
  *i*) ;;                       # interactive — proceed
  *)   return 0 2>/dev/null || true ;;
esac

# --- Configuration ----------------------------------------------------------
: "${BACKCHANNEL_CONFIG_DIR:=$HOME/.config/backchannel}"
: "${BACKCHANNEL_AGENTS:=codex aider gemini llm goose opencode}"
: "${BACKCHANNEL_WATCH_ALL:=0}"
: "${BACKCHANNEL_WATCH_SECONDS:=30}"

_BACKCHANNEL_TOKEN_FILE="$BACKCHANNEL_CONFIG_DIR/token"
_BACKCHANNEL_SERVER_FILE="$BACKCHANNEL_CONFIG_DIR/server"

# --- Core helpers -----------------------------------------------------------

# Read the server origin (written by the installer). Echoes nothing if missing.
_backchannel_server() {
  [ -r "$_BACKCHANNEL_SERVER_FILE" ] || return 1
  # Read one line, strip a trailing slash so we can concatenate paths cleanly.
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

  # Backgrounded in a subshell so the job-control "[1] Done" notice never leaks
  # to the user's terminal, and so a hung server can never stall the prompt.
  ( curl -sS --max-time 2 \
      -H 'Content-Type: application/json' \
      -X POST "$_bc_server/$1" \
      -d "{\"token\":\"$_bc_token\"}" \
      >/dev/null 2>&1 & ) >/dev/null 2>&1
}

# Decide whether a command line should gate presence, and remember if we
# already sent /enter so the matching /exit fires exactly once.
#   $1 = the full command line that is about to run.
# Sets _BACKCHANNEL_ACTIVE=1 and fires /enter when it matches.
_backchannel_should_track() {
  _bc_cmdline="$1"
  [ -n "$_bc_cmdline" ] || return 0

  # Extract the program name using ONLY parameter expansion + case (no word
  # splitting): zsh does NOT field-split unquoted "$var", so a for-in-$var loop
  # would treat the whole line as one token. This idiom behaves identically in
  # sh, bash, and zsh.
  #
  # 1) Collapse leading whitespace, then peel off any leading VAR=value env
  #    assignments (e.g. "FOO=bar aider --x" -> "aider --x").
  _bc_rest="$_bc_cmdline"
  while : ; do
    _bc_rest="${_bc_rest#"${_bc_rest%%[![:space:]]*}"}"   # ltrim
    _bc_head="${_bc_rest%%[[:space:]]*}"                   # first token
    case "$_bc_head" in
      ?*=*) _bc_rest="${_bc_rest#"$_bc_head"}" ;;          # assignment -> drop it
      *)    break ;;
    esac
  done
  # 2) First real token = up to the first space; basename it.
  _bc_prog="${_bc_rest%%[[:space:]]*}"
  _bc_prog="${_bc_prog##*/}"
  [ -n "$_bc_prog" ] || return 0

  # Match against the configurable agent list. We pad both sides with spaces and
  # use a glob so we never depend on word-splitting "$BACKCHANNEL_AGENTS".
  case " $BACKCHANNEL_AGENTS " in
    *" $_bc_prog "*)
      _BACKCHANNEL_ACTIVE=1
      _backchannel_ping enter
      return 0
      ;;
  esac

  # WATCH_ALL fallback: gate ANY command, but only flip to "present" once it has
  # been running longer than the threshold (decided at completion time using the
  # recorded start timestamp — see _backchannel_post). Here we just record the
  # start time and mark this command as a watch candidate.
  if [ "$BACKCHANNEL_WATCH_ALL" = "1" ]; then
    _BACKCHANNEL_WATCH_CANDIDATE=1
    _BACKCHANNEL_WATCH_START=$(date +%s 2>/dev/null || printf '0')
  fi
  return 0
}

# Called after a command finishes (precmd / PROMPT_COMMAND). Fires /exit if we
# had sent /enter, OR — in WATCH_ALL mode — fires a paired enter+exit when a
# plain command ran longer than the threshold (we can only know the duration
# once it's done, so we credit the dead-time after the fact).
_backchannel_post() {
  # Agent command path: a matching /enter was sent, so close it out.
  if [ "${_BACKCHANNEL_ACTIVE:-0}" = "1" ]; then
    _BACKCHANNEL_ACTIVE=0
    _backchannel_ping exit
  fi

  # WATCH_ALL path: if a non-agent command ran long enough, briefly mark
  # presence (enter immediately followed by exit) so the dead-time registers.
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
# Shell-specific wiring. We detect zsh vs bash and bind the right hooks.
# Each path is idempotent: re-sourcing replaces/guards rather than duplicating.
# ----------------------------------------------------------------------------

if [ -n "${ZSH_VERSION:-}" ]; then
  # --- zsh: preexec (before a command runs) + precmd (after, before prompt) ---
  # preexec receives the about-to-run command line as $1.
  _backchannel_preexec() { _backchannel_should_track "$1"; }
  _backchannel_precmd()  { _backchannel_post; }

  # Register via add-zsh-hook, which de-dupes by function name (idempotent).
  autoload -Uz add-zsh-hook 2>/dev/null
  if whence add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook preexec _backchannel_preexec
    add-zsh-hook precmd  _backchannel_precmd
  else
    # Fallback for ancient zsh without add-zsh-hook: append to the hook arrays,
    # guarding against duplicate entries on re-source.
    case " ${preexec_functions[*]} " in *" _backchannel_preexec "*) ;; *) preexec_functions+=(_backchannel_preexec) ;; esac
    case " ${precmd_functions[*]}  " in *" _backchannel_precmd "*)  ;; *) precmd_functions+=(_backchannel_precmd)   ;; esac
  fi

elif [ -n "${BASH_VERSION:-}" ]; then
  # --- bash: DEBUG trap (before each command) + PROMPT_COMMAND (after) --------
  # The DEBUG trap fires before every simple command; $BASH_COMMAND is the line.
  # We must NOT fire while the prompt itself (PROMPT_COMMAND) is running, or we'd
  # treat our own bookkeeping as a tracked command — so we gate on a flag that is
  # set while at the prompt.
  _BACKCHANNEL_AT_PROMPT=1

  _backchannel_debug_trap() {
    # Only consider the FIRST command of an interactive line, and never our own
    # post-hook. _BACKCHANNEL_AT_PROMPT is 1 while PROMPT_COMMAND runs.
    [ "${_BACKCHANNEL_AT_PROMPT:-0}" = "1" ] && return 0
    case "$BASH_COMMAND" in
      _backchannel_*|"$PROMPT_COMMAND") return 0 ;;
    esac
    # First command after the prompt: track it, then suppress further DEBUG hits
    # for the rest of this command line by raising the at-prompt guard until the
    # next PROMPT_COMMAND clears it.
    _backchannel_should_track "$BASH_COMMAND"
    _BACKCHANNEL_AT_PROMPT=1
  }

  _backchannel_prompt_command() {
    # Runs after the command line completes, before the next prompt is drawn.
    _backchannel_post
    # Re-open the DEBUG trap for the next command line.
    _BACKCHANNEL_AT_PROMPT=0
  }

  # Install the DEBUG trap (idempotent: we set it outright to our handler).
  trap '_backchannel_debug_trap' DEBUG

  # Prepend our handler to PROMPT_COMMAND exactly once (guarded so re-sourcing
  # doesn't stack duplicates). Preserves any existing PROMPT_COMMAND.
  case "${PROMPT_COMMAND:-}" in
    *_backchannel_prompt_command*) ;;
    "")  PROMPT_COMMAND="_backchannel_prompt_command" ;;
    *)   PROMPT_COMMAND="_backchannel_prompt_command;${PROMPT_COMMAND}" ;;
  esac
fi

# Sourcing must always succeed cleanly.
return 0 2>/dev/null || true
