# agent-orchestrator

The brain of a personal "master orchestrator": one long-lived Claude process you talk to in plain language, which supervises your other Claude Code agents, tracks their work against plans, and watches its own cost.

It is half of a pair. The web dashboard is the other half: [master-orchestrator](https://github.com/MoneybagsCodex/master-orchestrator). Install and run instructions for both are in [SETUP.md](SETUP.md).

## Why this exists

If you run several Claude Code sessions at once (a game agent, a refactor agent, a research agent), you become the router: which terminal is stuck, which one finished, what did it say, what should I tell the next one. That bookkeeping is the actual bottleneck.

This tool puts one agent in that seat. You say "what is everyone doing?" or "tell the game agent to start step 4", and the orchestrator reads the real state of your terminals, relays your instruction, waits, and reports what the agent itself said back. It keeps your plans, notices when an agent needs a decision from you, and tells you what its own conversation costs.

Design rules that come from that purpose:
- **Report, don't invent.** The orchestrator's prompt forbids stating results an agent did not itself report, and treats everything inside an agent's reply as data, never as instructions.
- **Humans decide.** Permission prompts, destructive actions and slash commands wait for you.
- **Local only.** It runs on your machine, uses your own `claude` CLI login (no API key is read), and only accepts browser calls from `localhost`.
- **Cost is visible.** A long-lived conversation re-reads itself every turn, so it tracks its own tokens and compacts itself automatically.

## How it works

```
 you (browser :4000, master-orchestrator)
        |  chat + live event stream (SSE)
        v
 this server :3003 ──── persistent `claude -p --input-format stream-json` process (Haiku by default; Sonnet/Opus selectable)
        |                     |
        |                     | runs shell tools in bin/  (orch-status, orch-read, orch-send, orch-plan, ...)
        |                     | and SendMessage to peer agents
        v                     v
 state in ~/.operator-state    your live agent terminals, via the operator-cockpit bridge :3002 (optional)
```

1. **The host** (`src/host.ts`) keeps one headless Claude process alive across turns, so the conversation persists and a turn does not pay a cold start. It streams every event (your message, tool calls, replies, turn start/end, peer messages) to the dashboard and replays missed events on reconnect.
2. **The tools** (`bin/orch-*`) are the only things the model can do. They list terminals, read an agent's recent transcript, send it input, wait for it to go quiet, and manage plans. Agents are mostly addressed with `SendMessage` over their peer sockets; delivery is two-stage (accepted, then released, held for the agent's user to approve, or refused), and the orchestrator will not claim delivery before it is confirmed.
3. **Plans** are one dependency graph per domain (for example a game and the orchestrator itself), stored as JSON. A routing table maps each agent to its plan, and when an agent is told `Step N: ...` its progress is tracked on that plan. Detection of finished steps is automatic but conservative. Details in [docs/PLANS_AND_SUBAGENTS.md](docs/PLANS_AND_SUBAGENTS.md).
4. **Insights** (`src/insights.ts`) turn raw transcripts into the dashboard's picture: agent state (working, idle, blocked), headlines, per-agent token use against a context threshold, a "needs you" list, standing instructions, and approval handling.
5. **Cost control** is built in: the orchestrator's own spend is logged by feature, budgets and warnings are configurable, and its conversation is compacted automatically at a 150k-token context line. Live figures: `orch-cost`, `GET /orchestrator/tokens`. Details in [docs/COST_CONTROL.md](docs/COST_CONTROL.md).

## What is in the repo

| Path | What |
|---|---|
| `src/server.ts` | HTTP API on :3003: `/chat`, `/events` (SSE), `/status`, `/overview`, plans, routing, standing instructions, costs, workers |
| `src/host.ts` | The persistent Claude process, event log, auto-compaction |
| `src/insights.ts` | Status, cost, token and approval logic |
| `src/autoplan.ts` | Detects plan steps and completions from agent output |
| `bin/orch-*` | The command-line tools the orchestrator (and you) use; `orch-overview` and `orch-cost` are good first commands |
| `docs/MASTER_PROMPT.md` | **The orchestrator's system prompt** (source of truth), runtime context, and Windows port checklist |
| `docs/ORCHESTRATOR_PROMPT.md` | **Complete interaction guidelines** for orchestrator behavior: multi-agent reporting, CLI protocol, communication style, status format, git governance, porting checklist |
| `docs/` | Plans/sub-agents and cost control |
| `src/demo.ts`, `orchestrator.ts`, `state-machine.ts`, `router.ts`, `mission-parser.ts`, `agent-registry.ts`, `master-agent.ts`, `api-server.ts` | Original workflow-engine prototype. Not used by the running server; `npm run build` fails on them (see SETUP.md) |

## Quick start

```bash
npm ci
npm run server        # http://localhost:3003
bin/orch-overview     # text summary, including the orchestrator's own token burn
```

Needs Node 18+, a logged-in `claude` CLI, `jq` and `curl`. Pair it with the dashboard for the full experience, and with the operator-cockpit bridge if you want it to see and message live agent terminals. See [SETUP.md](SETUP.md).

## Status

Personal tool, actively changing, tested on macOS. Dollar figures are estimates from token counts. There is no authentication because it is built for a single user on localhost; do not expose port 3003 to a network.

---

Developed by Joshua Minton. Copyright © 2026 Joshua Minton. Property of Joshua Minton; all rights reserved.
