# Orchestrator setup

Covers both repos: `agent-orchestrator` (server and `bin/orch-*` scripts, port 3003) and `cockpit-orchestrator` (dashboard, port 4000). Validated from fresh clones with an empty `$HOME` on 2026-10-05.

```
browser :4000 (cockpit-orchestrator) --> :3003 (agent-orchestrator) --> persistent `claude` process
                  |                              |
                  +--- /api/terminals -----------+--> bridge :3002 (operator-cockpit) --> your live agent terminals
```

## 1. Prerequisites

| Need | Notes |
|---|---|
| Node 18 or newer | Tested on 22. Both repos are ESM. |
| npm | Ships with Node. |
| `claude` CLI on `PATH`, logged in | The orchestrator spawns `claude -p ...`. It uses your CLI login. No API key is needed or read. Check with `claude auth status`. |
| `jq`, `curl`, bash | Used by `bin/orch-*`, which the orchestrator runs as its tools. |
| operator-cockpit bridge on :3002 | Optional for chat, required to see or message your agent terminals. Start it from the operator-cockpit repo. |

macOS or Linux. The tools in `bin/` are bash.

## 2. Installation

```bash
git clone <agent-orchestrator>   && cd agent-orchestrator   && npm ci && cd ..
git clone <cockpit-orchestrator> && cd cockpit-orchestrator && npm ci
```

There is no build step. The server runs TypeScript directly through `tsx`, and the dashboard is a static page served by `node`.
Do not run `npm run build` or `npm run typecheck` in agent-orchestrator: they fail on the legacy prototype files (`src/demo.ts` and friends), which the running server does not import.

## 3. Configuration

All optional; defaults work on one machine.

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `ORCH_PORT` | agent-orchestrator | `3003` | Orchestrator HTTP port |
| `BRIDGE_URL` | both repos and `bin/orch-*` | `http://localhost:3002` | operator-cockpit bridge |
| `ORCH_MAX_WORKERS` | agent-orchestrator | `5` | Cap on concurrent sub-agent workers |
| `PORT` | cockpit-orchestrator | `4000` | Dashboard port |
| `ORCHESTRATOR_URL` | cockpit-orchestrator | `http://localhost:3003` | Where the browser finds the orchestrator (served to the page via `/orch-url.js`) |
| `OPERATOR_STATE_DIR` | `bin/orch-*` only | `~/.operator-state` | The server itself always uses `~/.operator-state`; override `$HOME` to relocate it |

Run both processes with the same `BRIDGE_URL`. The dashboard calls the orchestrator straight from the browser, and the orchestrator only accepts `localhost` / `127.0.0.1` origins.

State lives in `~/.operator-state/` and is created on first start:
- `orchestrator-sessions/`: orchestrator session id, `messages.json` chat history, `plans/`, `budgets.json`, `usage-log.jsonl`, `compactions.json`, `standing.json`
- Read-only inputs from operator-cockpit: `active-sessions.json`, `session-metadata/`, `approvals/`
- Claude Code's own transcripts under `~/.claude/projects/` are read to label agents and detect idle.

Deleting `orchestrator-sessions/` resets the orchestrator to a blank conversation and plan list.

Cost settings (including the 150k auto-compact line) are in `budgets.json` and documented in `docs/COST_CONTROL.md`.

## 4. Running

Two terminals (or `nohup ... &`). Start the bridge first if you want live agents.

```bash
# orchestrator (:3003)
cd agent-orchestrator   && npm run server
# dashboard (:4000)
cd cockpit-orchestrator && npm start
```

Open http://localhost:4000.

Checks:
```bash
curl -s localhost:3003/health         # {"status":"ok",...}
curl -s localhost:4000/api/health
curl -s localhost:4000/api/terminals  # {"error":"Bridge offline"} until the bridge is up
agent-orchestrator/bin/orch-overview  # text summary, including the orchestrator's own token burn
```

Starting the server spawns one persistent `claude` process (Haiku by default). It makes no model call until you send a message.

To restart the orchestrator: `kill $(lsof -ti :3003)`, then start it again. Restarts rewrite the prompt cache, so avoid restarting often.

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Chat replies `Not logged in · Please run /login` | The `claude` CLI has no login for this user/`$HOME`. Run `claude` once and log in; confirm with `claude auth status`. The server still starts fine without it. |
| `EADDRINUSE` on 3003 or 4000 | A previous instance is still up (a restart that fails silently keeps the old code running). `kill $(lsof -ti :3003)`, or use `ORCH_PORT` / `PORT`. |
| Dashboard loads but chat shows no replies or "Working" never ends | Page cannot reach the orchestrator. Check `ORCHESTRATOR_URL` matches `ORCH_PORT`, and hard-reload (the page is static and cached). |
| `/api/terminals` returns `Bridge offline`; agents panel empty; `bridge unreachable` from `orch-list` | The operator-cockpit bridge is not on `BRIDGE_URL`. Start it, or fix the URL. Chat still works. |
| `orch-*`: `jq: command not found` | Install jq (`brew install jq`). |
| Dashboard stale or stuck after a server restart | Hard reload. The event stream resumes by sequence number, which survives restarts. |
| Cost warning about many restarts | Each restart re-reads the whole conversation uncached. Leave the server running; the orchestrator compacts itself. |
| Dollar figures look low or high | Estimates use Haiku 4.5 rates unless the model is priced; they are not billing data. |
| `npm run build` / `typecheck` errors in `src/demo.ts` | Known: legacy prototype files. Not needed to run. |
| Browser blocked calling :3003 | CORS allows only `localhost` / `127.0.0.1` origins. Open the dashboard via `localhost`, not a LAN IP. |
