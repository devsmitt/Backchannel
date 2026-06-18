#!/bin/sh
# Backchannel — uninstaller. Reverses what install.sh wired, leaving the rest of
# your config untouched: removes our Claude Code hooks from settings.json, strips
# the shell-integration block from your rc file, and deletes the local config
# dir (token, recovery, server, hook.sh, snippet). POSIX sh, idempotent, no sudo.
#
# This removes Backchannel from THIS DEVICE. Your account still exists — delete
# it from the app (your name -> "leave backchannel" -> delete account).

set -eu

CONFIG_DIR="${BACKCHANNEL_CONFIG_DIR:-$HOME/.config/backchannel}"
SETTINGS_FILE="$HOME/.claude/settings.json"

say() { printf '%s\n' "$*"; }

say ""
say "  backchannel uninstaller"
say ""

# --------------------------------------------------------------------------
# 1) Strip our hooks from ~/.claude/settings.json, preserving everything else.
#    We identify our entries by the command (hook.sh / our /enter|/exit URLs).
# --------------------------------------------------------------------------
if [ -f "$SETTINGS_FILE" ]; then
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.backchannel.bak" 2>/dev/null || :
  removed=""
  if command -v python3 >/dev/null 2>&1; then
    SETTINGS_FILE="$SETTINGS_FILE" python3 - <<'PYEOF' && removed="yes"
import json, os
p = os.environ["SETTINGS_FILE"]
try:
    with open(p) as f:
        d = json.loads(f.read() or "{}")
except Exception:
    d = None
if isinstance(d, dict) and isinstance(d.get("hooks"), dict):
    def is_bc(h):
        c = h.get("command", "") if isinstance(h, dict) else ""
        return ("backchannel" in c) or ("/enter" in c) or ("/exit" in c)
    hooks = d["hooks"]
    for ev in list(hooks.keys()):
        rebuilt = []
        for g in (hooks.get(ev) or []):
            if isinstance(g, dict) and isinstance(g.get("hooks"), list):
                inner = [h for h in g["hooks"] if not is_bc(h)]
                if inner:
                    g = dict(g); g["hooks"] = inner; rebuilt.append(g)
            else:
                rebuilt.append(g)
        if rebuilt:
            hooks[ev] = rebuilt
        else:
            del hooks[ev]
    if not hooks:
        del d["hooks"]
    with open(p, "w") as f:
        json.dump(d, f, indent=2); f.write("\n")
PYEOF
  elif command -v jq >/dev/null 2>&1; then
    _tmp="$(mktemp 2>/dev/null || printf '%s' "$SETTINGS_FILE.tmp.$$")"
    if jq '
      def is_bc: (.command? // "") | (test("backchannel") or test("/enter") or test("/exit")) ;
      if (.hooks | type) == "object" then
        .hooks |= ( with_entries(
          .value |= ( map(.hooks = ((.hooks? // []) | map(select(is_bc | not))))
                      | map(select((.hooks? // []) | length > 0)) ) )
          | with_entries(select((.value | length) > 0)) )
      else . end
      | if (.hooks? // {}) == {} then del(.hooks) else . end
    ' "$SETTINGS_FILE" > "$_tmp" 2>/dev/null; then
      mv "$_tmp" "$SETTINGS_FILE"; removed="yes"
    else
      rm -f "$_tmp" 2>/dev/null || :
    fi
  fi
  if [ -n "$removed" ]; then
    say "  removed hooks from $SETTINGS_FILE (backup: $SETTINGS_FILE.backchannel.bak)"
  else
    say "  ! couldn't auto-edit $SETTINGS_FILE (no python3/jq) — remove the"
    say "    backchannel hook entries (they run hook.sh) by hand."
  fi
fi

# --------------------------------------------------------------------------
# 2) Remove the shell-integration block (between our guard markers).
# --------------------------------------------------------------------------
for RC in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc"; do
  [ -f "$RC" ] || continue
  if grep -qF '# >>> backchannel shell integration >>>' "$RC" 2>/dev/null; then
    _tmp="$(mktemp 2>/dev/null || printf '%s' "$RC.tmp.$$")"
    sed '/# >>> backchannel shell integration >>>/,/# <<< backchannel shell integration <<</d' "$RC" > "$_tmp" \
      && mv "$_tmp" "$RC" \
      && say "  removed shell integration from $RC"
  fi
done

# --------------------------------------------------------------------------
# 3) Delete the local config dir (token, recovery, server, hook.sh, snippet).
# --------------------------------------------------------------------------
if [ -d "$CONFIG_DIR" ]; then
  rm -rf "$CONFIG_DIR" && say "  removed $CONFIG_DIR"
fi

say ""
say "  done — backchannel is off this device."
say "  open a new terminal so the shell change takes effect."
say ""
say "  your account still exists. to delete it everywhere, open the app →"
say "  your name (top-right) → \"leave backchannel\" → delete account."
say ""
