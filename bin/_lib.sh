# Shared helpers for orch-* scripts. Works against both the old and new bridge.
BRIDGE_URL="${BRIDGE_URL:-http://localhost:3002}"
STATE="${OPERATOR_STATE_DIR:-$HOME/.operator-state}"

# Live sessions as a JSON array with a human label on each.
# Label priority: cockpit panel name (active-sessions.json) > session metadata name > bridge label > agent > short sid.
orch_sessions() {
  local meta='{}' active='{}' raw
  compgen -G "$STATE/session-metadata/*.json" >/dev/null &&
    meta=$(jq -s -c 'map(select(.sessionId and .name) | {key: .sessionId, value: .name}) | from_entries' "$STATE"/session-metadata/*.json 2>/dev/null || echo '{}')
  [[ -f "$STATE/active-sessions.json" ]] &&
    active=$(jq -c 'reverse | map(select(.label) | {key: .sid, value: .label}) | from_entries' "$STATE/active-sessions.json" 2>/dev/null || echo '{}')
  # Old bridges 404 on ?tail=, so fall back to the bare route.
  raw=$(curl -sf "$BRIDGE_URL/terminals?tail=${1:-200}" 2>/dev/null || curl -sf "$BRIDGE_URL/terminals") || { echo "bridge unreachable at $BRIDGE_URL" >&2; return 1; }
  echo "$raw" | jq -c --argjson M "$meta" --argjson A "$active" '.sessions | map(
    .label = (if (($A[.sid] // "") != "") then $A[.sid]
              elif (($M[.sid] // "") != "") then $M[.sid]
              elif ((.label // "") != "") then .label
              elif ((.agent // "") != "") then .agent
              else .sid[0:8] end))'
}

# Resolve a label (case-insensitive, exact then substring) or sid prefix to exactly one session object.
# Prints the JSON object; on none/ambiguous prints a message to stderr and returns 1.
orch_resolve() {
  local target="$1" sessions out
  sessions=$(orch_sessions) || return 1
  out=$(echo "$sessions" | jq -c --arg t "$target" '
    ($t | ascii_downcase) as $q
    | (map(select((.label | ascii_downcase) == $q or (.sid | startswith($t)))) ) as $exact
    | if ($exact | length) > 0 then $exact
      else map(select((.label | ascii_downcase) | contains($q))) end')
  case $(echo "$out" | jq 'length') in
    1) echo "$out" | jq -c '.[0]' ;;
    0) echo "NOT FOUND: '$target'. Live terminals: $(echo "$sessions" | jq -r 'map(.label) | join(", ")')" >&2; return 1 ;;
    *) echo "AMBIGUOUS: '$target' matches: $(echo "$out" | jq -r 'map("\(.label) (\(.sid[0:8]))") | join(", ")')" >&2; return 1 ;;
  esac
}

# Transcript for a live terminal. The cockpit's sid is not always Claude's real session id (it changes
# on /clear, resume, etc.), so ask the process's own registry (~/.claude/sessions/<pid>.json) first.
# Usage: orch_transcript <sid> [pid]
orch_transcript() {
  local sid="$1" pid="$2" real="" f
  [[ -n "$pid" && -f "$HOME/.claude/sessions/$pid.json" ]] && real=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$pid.json")
  for id in $real $sid; do
    f=$(ls "$HOME"/.claude/projects/*/"$id".jsonl 2>/dev/null | head -1)
    [[ -n "$f" ]] && { echo "$f"; return; }
  done
}

# Live status as reported by the agent process itself, e.g. "idle", "busy", "waiting: permission prompt".
orch_status() {
  [[ -f "$HOME/.claude/sessions/$1.json" ]] &&
    jq -r '(.status // empty) + (if .waitingFor then ": " + .waitingFor else "" end)' "$HOME/.claude/sessions/$1.json"
}

orch_strip_ansi() { perl -CS -pe 's/\e\[\d*[CG]/ /g; s/\e\[[0-9;?>]*[ -\/]*[@-~]//g; s/\e\][^\a]*\a//g; s/\r//g' | cat -s; }

# Seconds since a file was last written.
orch_age() { echo $(( $(date +%s) - $(stat -f %m "$1") )); }
