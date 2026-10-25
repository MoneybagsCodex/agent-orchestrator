# Orchestrator Implementation

Your multi-agent orchestration system for agent-orchestrator project.

## Architecture

```
┌─────────────────┐
│   Dashboard     │ localhost:4000
│  (HTML/JS)      │
└────────┬────────┘
         │ polls /status
         ↓
┌─────────────────────────────────────┐
│      Orchestrator Server (3003)     │
├─────────────────────────────────────┤
│ • Express app (src/server.ts)       │
│ • HTTP bridge (port 5001)           │
│ • Agent registry                    │
│ • Compact request tracking          │
└────┬────────────────────────────┬───┘
     │ SendMessage/bridge         │ /status, /compact
     ↓                            ↓
┌─────────────────────────────────────┐
│      Agent Sessions                 │
│ (Claude Code running locally)       │
├─────────────────────────────────────┤
│ • Agent-1: reads tasks from bridge  │
│ • Agent-2: executes work            │
│ • Agent-N: replies via orch-reply   │
└─────────────────────────────────────┘
```

## Key Components

### 1. Dashboard (public/index.html)

**Port:** localhost:4000
**Polling:** Every 2 seconds to `/status`
**Display:**
- Agent list with status (IDLE/WORKING/BLOCKED)
- Context tokens (current/150k threshold)
- Progress bar (green → yellow → red)
- Compact button (appears at 90%+ threshold)
- THINKING spinner while compacting

**Compact flow:**
```
Click "Compact" → POST /agent/:agentId/compact
                 ↓
              Server triggers quickAction(sid, 'compact')
                 ↓
              Dashboard shows THINKING spinner
                 ↓
              Agent runs /compact command
                 ↓
              Context tokens drop
                 ↓
              Dashboard detects drop, hides spinner
```

### 2. HTTP Bridge (src/http-bridge.ts, port 5001)

**Purpose:** Bypass cross-session message holding issue

**Endpoints:**
- `POST /task` — Assign work to agent
- `GET /task` — Agent polls for work
- `POST /result` — Agent reports completion
- `POST /message` — Agent sends reply
- `GET /capability` — Agent reports capabilities
- `POST /capability` — Register capability

**Token:** Stored in `~/.operator-state/bridge.token`

**Integration:** `orch-reply` script sends replies via bridge (no message holding)

### 3. Compact Protocol (src/server.ts)

**POST /agent/:agentId/compact**
- Input: agent ID
- Action: triggers `quickAction(sid, 'compact')`
- Returns: `{ok: true, requestId, agentName}`

**GET /agent/:agentId/compact/:requestId**
- Returns: pending status or expired
- Cleanup: removes requests after 60s

**Tracking:** `compactRequests` Map in memory

### 4. Agent Capability Registry (src/capability-registry.ts)

**Purpose:** Intelligent task routing by agent capabilities

**Tracks per agent:**
- Name
- Capabilities (bash, fileOps, languages, tools)
- Last-seen timestamp

**TTL:** 60 seconds (agents expire if silent)

**Usage:** Route tasks to agents with matching skills

### 5. Auto-Approval System (src/insights.ts)

**Gate:** `hasRunningAgents()` checks state = WORKING or BLOCKED

**Only sends alerts if:**
- Agents exist AND
- No approval activity in last minute

**Metrics tracked:**
- Approvals/denials per minute
- orch-send failure rate
- Decision latency

### 6. Auto-Compact Watchdog (src/host.ts)

**Triggers when:**
- Orchestrator context > 150k (default threshold)
- Active agents = 0 (idle)
- Or after 10+ minutes over threshold

**Cleanup:** Clears stuck compacting flag after 7m, retries

## Current Status

**Working:**
- ✅ Multi-agent orchestration (5 agents live)
- ✅ HTTP bridge (agents reply autonomously)
- ✅ Dashboard (shows agents, tokens, compact)
- ✅ Compact protocol (button → auto-compact → tokens drop)
- ✅ Auto-approval (safe ops auto-approved)
- ✅ Agent capability registry (routing by skills)
- ✅ Watchdog auto-compact (context stays below 150k)

**Known issues:**
- Listener alert still fires (agent registration timeout handling)
- No headless goal engine yet (semi-autonomous only)

## Deployed Commits

- `e7f96a5` Compact protocol design
- `1fd639b` Dashboard UI
- `f997b35` Compact endpoints + static serving
- `2edcc70` Project status update
- `b7cc974` Value proposition doc
- `60efb69` Head-to-head comparison
- `b4479ab` CLAUDE.md procedures

## Configuration

**orchestrator.config.json:**
```json
{
  "httpBridge": {
    "enabled": true,
    "host": "localhost",
    "port": 5001,
    "tokenFile": "~/.operator-state/bridge.token"
  },
  "agentRegistry": {
    "capabilityTTL": 60000
  },
  "contextCompactTokens": 150000
}
```

## Quick Reference

| Task | Command |
|------|---------|
| Check agents | `orch-status` |
| Read agent work | `orch-read <id> 3` |
| Manual compact | `orch-send <id> --confirmed "/compact"` |
| View logs | `tail -f orchestrator.log` |
| Test compact button | Open localhost:4000, find agent >90% tokens |

## Next Steps (Roadmap)

1. **Fix listener alert** (gate on agents.length > 0 properly)
2. **Build goal engine** (autonomous task generation from high-level objectives)
3. **Add planning layer** (multi-step task decomposition)
4. **Implement escalation** (gate decisions needing human input)
5. **Enable headless mode** (24/7 autonomous operation)

## Files to Know

- `src/server.ts` — Main orchestrator server
- `src/http-bridge.ts` — Task assignment API
- `src/insights.ts` — Auto-approval + monitoring
- `src/host.ts` — Orchestrator session lifecycle + auto-compact
- `src/capability-registry.ts` — Agent skill tracking
- `public/index.html` — Dashboard UI
- `bin/orch-reply` — Agent reply script
- `CLAUDE.md` — Operating guidelines
- `orchestrator.config.json` — Runtime configuration

