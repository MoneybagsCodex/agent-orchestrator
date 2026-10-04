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
  local arr
  arr=$(echo "$raw" | jq -c --argjson M "$meta" --argjson A "$active" '.sessions | map(
    .label = (if (($A[.sid] // "") != "") then $A[.sid]
              elif (($M[.sid] // "") != "") then $M[.sid]
              elif ((.label // "") != "") then .label
              elif ((.agent // "") != "") then .agent
              else .sid[0:8] end))')
  # Second identity: the conversation each terminal is actually running. Panel labels can be wrong
  # (e.g. swapped), the conversation title is what the agent is really working on.
  local topics='{}' row sid pid t
  while IFS='|' read -r sid pid; do
    t=$(orch_topic "$sid" "$pid")
    topics=$(jq -c --arg k "$sid" --arg v "$t" '. + {($k): $v}' <<<"$topics")
  done < <(echo "$arr" | jq -r '.[] | "\(.sid)|\(.pid)"')
  echo "$arr" | jq -c --argjson T "$topics" 'map(.topic = ($T[.sid] // ""))'
}

# What conversation a terminal is really running: the transcript's auto-title, else the process's own session name.
orch_topic() {
  local tr t
  tr=$(orch_transcript "$1" "$2")
  [[ -n "$tr" ]] && t=$(grep '"type":"ai-title"' "$tr" | tail -1 | jq -r '.aiTitle // empty' 2>/dev/null)
  [[ -z "$t" && -f "$HOME/.claude/sessions/$2.json" ]] && t=$(jq -r '.name // empty' "$HOME/.claude/sessions/$2.json")
  echo "$t"
}

# Resolve a terminal to exactly one session object. Identity order: session-id prefix, then conversation
# title (exact, then partial), and only as a last resort the panel label, because labels can be wrong.
# Prints the JSON object; on none/ambiguous prints a message to stderr and returns 1.
orch_resolve() {
  local target="$1" sessions out how n
  sessions=$(orch_sessions) || return 1
  for how in sid title-exact title-part label-exact label-part; do
    out=$(echo "$sessions" | jq -c --arg t "$target" --arg how "$how" '
      ($t | ascii_downcase) as $q
      | map(select(
          if $how == "sid" then (.sid | startswith($t))
          elif $how == "title-exact" then ((.topic | ascii_downcase) == $q)
          elif $how == "title-part" then ((.topic | ascii_downcase) | contains($q))
          elif $how == "label-exact" then ((.label | ascii_downcase) == $q)
          else ((.label | ascii_downcase) | contains($q)) end))')
    n=$(jq length <<<"$out")
    if (( n == 1 )); then
      [[ "$how" == label* ]] && echo "NOTE: '$target' matched by PANEL LABEL only, and labels can be wrong. Check the conversation title before acting." >&2
      jq -c '.[0]' <<<"$out"; return 0
    elif (( n > 1 )); then
      echo "AMBIGUOUS: '$target' matches several terminals: $(echo "$out" | jq -r 'map("\"\(.topic)\" [\(.sid[0:8])]") | join(", ")'). Use the session id." >&2; return 1
    fi
  done
  echo "NOT FOUND: '$target'. Live terminals: $(echo "$sessions" | jq -r 'map("\"\(.topic)\" [\(.sid[0:8])]") | join(", ")')" >&2; return 1
}

# Human identity of a session object: "<conversation title>" [id] (panel label: X)
orch_who() { jq -r '"\"\(if .topic == "" then "untitled" else .topic end)\" [\(.sid[0:8])] (panel label: \(.label))"' <<<"$1"; }

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
