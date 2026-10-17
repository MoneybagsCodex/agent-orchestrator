# Agent Capability Discovery

Agents announce what they can do to the HTTP task bridge. The orchestrator can then route a task to a capable agent without naming one.

## Endpoints (bridge, port 5001, `X-Orch-Token` required)

| Method | Path | Body / query | Result |
|---|---|---|---|
| POST | `/capability` | `{name, bash, fileOps, languages?, tools?}` | 200 `{ok, name, expiresInMs}`; 400 with a reason if invalid or the registry is full (`maxAgents`) |
| GET | `/capability` | none | `{ttlMs, agents: [{name, bash, fileOps, languages, tools, lastSeen, stale}]}` |
| POST | `/task` | `{task, requiresCapability}` with no `agent` | Picks the least-loaded fresh capable agent. 201 includes the chosen `agent`. |
| POST | `/task` | `{agent, task, requiresCapability}` | Assigns to `agent` only if it is fresh and has the capability; otherwise 400. |

`/task` without `requiresCapability` is unchanged: `agent` is required and is used as given.

### Requirement format

- Shorthand strings: `"bash"`, `"fileOps"`, `"language:ts"`, `"tool:vitest"`.
- Object form: `{bash?: true, fileOps?: true, languages?: ["ts"], tools?: ["vitest"]}`. Every listed language and tool must be present.
- Values are case-insensitive. Lists hold up to 50 short identifiers (`a-z 0-9 . _ + -`).

### Errors

- `400 no agent has required capability`: no fresh agent matches.
- `400 agent X is not registered, is stale, or lacks the required capability`: explicit agent does not qualify.

## Agent startup and refresh

Run once when the session starts, then keep it running in the background. A refresh every 30 seconds keeps the agent fresh inside the 60-second TTL.

```bash
bin/orch-capability --name my-agent --bash --file-ops --lang ts --tool vitest,git            # one announcement
bin/orch-capability --name my-agent --bash --file-ops --lang ts --tool vitest --loop &      # refresh every 30s
```

`orch-capability` reads the token from `$OPERATOR_STATE_DIR/bridge.token` (default `~/.operator-state`) and sends it through a temp header file, never on the command line. Use `ORCH_BRIDGE_URL` to point at another bridge. Note that `--file-ops` is the flag; the JSON field is `fileOps`.

## Configuration

`orchestrator.config.json` → `agentRegistry`:

| Key | Default | Meaning |
|---|---|---|
| `capabilityTTL` | 60000 | ms without an update before an agent is stale and no longer routed to |
| `maxAgents` | 100 | Registry size cap; refreshing an existing agent is always allowed |
| `maxListItems` | 50 | Max entries in `languages` or `tools` |

## Behavior and limits

- **In-memory.** The registry is lost when the bridge restarts. Agents re-announce on their next refresh.
- **Least-loaded routing.** Among fresh matches, the agent with the fewest pending or claimed tasks wins. Ties go to the first name alphabetically.
- **Staleness is checked at routing time.** A stale agent stays visible in `GET /capability` with `stale: true` but is never chosen.
- **Not a permission check.** Capabilities are self-reported. They route work; they do not grant access. Permission boundaries still live in each session's own settings.
- **Not the prototype.** `src/agent-registry.ts` is the old static table used only by the unused workflow-engine prototype. It is not read by this system.
