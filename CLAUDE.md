# CLAUDE.md — Agent-Orchestrator Operating Guidelines

## Core Principles

- **Isolation > Convenience** — Keep systems cleanly separated
- **Reversible > Clever** — Prefer simple, undoable approaches
- **Explicit > Implicit** — Clear APIs and communication patterns
- **Boring > Trendy** — Proven patterns over experimental frameworks

## Communication Patterns

### Response Style
- **Concise:** One sentence per update. State fact, not process.
- **Plain Language:** No jargon unless unavoidable. No marketing speak.
- **Status-Driven:** Report state changes, not intermediate steps.
- **Decision Transparent:** When unclear, show trade-offs. Don't hide judgment calls.

### Status Updates
Format: `**[STATUS]** Brief fact + next step or blocker`

✅ Good:
```
✅ Auto-approval system: Production-ready (5/5 phases complete, 170/170 tests passing)
```

❌ Avoid:
```
The system has been thoroughly tested and developed through a comprehensive five-phase process...
```

### Cross-Agent Communication
- Use `SendMessage` to communicate with other agents (master-orchestrator, error-recovery-system, dashboard-upgrade, etc.)
- Include short 5-10 word summaries in SendMessage calls
- Agents reply via SendMessage back to this agent or orchestrator
- Wait for agent completion notifications before reporting results

## Git Workflow (MANDATORY)

**Auto-commit and auto-push EVERY change:**

1. After Edit/Write/Bash that modifies files → immediately commit + push
2. Commit message format: `Short summary (max 70 chars), optional detail body`
3. Include attribution: `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`
4. Never skip hooks (--no-verify), never force push to main
5. Stage specific files (`git add <files>`), never use `git add -A` without review

**Example:**
```bash
git add src/insights.ts
git commit -m "Add metrics tracking for auto-approval decisions

- Record approvals/denials per minute
- Track pattern frequency
- Measure decision latency

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
git push
```

## Token Discipline

- **Target:** ~1k tokens per turn
- **Avoid:** Sequential tool calls, re-reading files, verbose explanations
- **Do:** Batch independent calls, reference prior context, be terse
- **Compact:** When context exceeds 150k tokens, summarize and start fresh turn

**Token Budget Breakdown:**
- Tool calls: ~500 tokens (batch when possible)
- Responses: ~300-400 tokens (concise updates)
- Context overhead: ~100-200 tokens

## Code Standards

### TypeScript
- Run `npm run typecheck` before committing
- Zero compilation errors in auto-approval and error-recovery systems
- Use strict mode, explicit types on public APIs

### Testing
- Unit tests required for all public functions
- Integration tests for system boundaries (host.ts ↔ insights.ts)
- Minimum 80% code coverage
- All tests passing before commit

### Configuration
- All runtime values in `orchestrator.config.json` (never hardcoded)
- Document all config sections with descriptions
- Use sensible defaults (system works without manual config)

## Windows/Mac Compatibility

### File Paths
- **Always use forward slashes** (`/`) in code — Node.js handles both platforms
- Use `path.join()` or `path.resolve()` for system-dependent paths
- Never hardcode absolute paths

### Script Execution
- **Bash scripts:** Use `#!/usr/bin/env bash` shebang (portable)
- **Binaries:** Check both `bin/orch-send` and `bin/orch-send.ps1`
- **Node commands:** Prefer `npm run` over direct node invocation

### Path Separators in ENV
- Always use `process.env.PATH` (Node.js abstracts separator)
- Don't manually construct PATH with `:` or `;`
- Use `path.delimiter` when building PATH manually:
  ```typescript
  const newPath = [binDir, process.env.PATH].join(path.delimiter);
  ```

### Process Environment
- Use `process.platform` to detect OS (returns 'win32', 'darwin', 'linux')
- Normalize paths before comparing: `path.normalize(p1) === path.normalize(p2)`

## Documentation Standards

### Architecture Files (docs/)
- `SYSTEM_NAME_DESIGN.md`: Architecture, data flow, integration points
- `SYSTEM_NAME.md`: User guide, troubleshooting, best practices
- Include examples with real output
- Update when implementation changes

### Code Comments
- Only WHY (hidden constraints, invariants, workarounds)
- Never WHAT (well-named code shows that)
- Never reference tasks or callers (belongs in PR description, rots over time)

### Commit Messages
- Line 1: Imperative, present tense, <70 chars
- Line 2: Blank
- Lines 3+: Explain WHY, not WHAT
- List changes as bullets (what changed)
- Include Co-Authored-By line

## System Boundaries

### Agent-Orchestrator → Master-Orchestrator
- Master-orchestrator reads agent state via `/status` (polled every ~2s)
- Communication: SendMessage to agent.peer (Unix socket)
- No direct function calls across processes

### Agent-Orchestrator ↔ Agents
- `orch-send` and `orch-read` shell commands (bin/orch-* scripts)
- Never assume bash availability — could be Windows with PowerShell
- All agent discovery via Claude Code bridge

### Internal (host.ts ↔ insights.ts)
- Direct function calls (same process)
- Synchronous where possible (insights.ts runs periodically)
- Error handling must be explicit

## Logging Standards

### Log Tags (console.log prefix format)
- `[auto-approval-*]` — Auto-approval decisions and status
- `[error-recovery-*]` — Error categorization and recovery actions
- `[metrics]` — Per-minute metric summaries
- `[listener-running]` — Monitoring loop status
- `[blocker-*]` — Permission prompt detection and resolution

### What to Log
✅ State changes (IDLE → WORKING)
✅ Permission prompts detected
✅ Auto-approval decisions (approved/denied/unknown)
✅ Errors categorized and recovery actions taken
✅ Metrics summaries (approvals/denials per minute)
✅ System health events (circuit breaker open, rate limit hit)

❌ Intermediate steps (reading files, parsing JSON)
❌ Loops or repeated events (log once per state, not every iteration)
❌ PII or sensitive data

## Decision Log

When making architectural choices:
1. State the options
2. Note the trade-off
3. Record the decision
4. Store in `docs/DECISIONS.md`

Example:
```markdown
## Auto-Approval: Fail-Safe Ordering

**Options:**
- Check safe patterns first, then risky (can approve dangerous ops)
- Check risky patterns first, then safe (fail-safe, correct)

**Trade-off:**
Fail-safe ordering is slightly slower but prevents catastrophic mistakes.

**Decision:** Fail-safe first (risky patterns checked before safe).
Reasoning: Safety > performance for permission decisions.
```

## Pre-Release Checklist

Before marking a system "production-ready":
- [ ] All tests passing (unit + integration)
- [ ] TypeScript compilation succeeds (zero errors)
- [ ] Documentation complete (design, user guide, troubleshooting)
- [ ] Git history clean (all changes committed and pushed)
- [ ] Code reviewed for security (no hardcoded credentials, injection vectors)
- [ ] Performance verified (latency < target, memory bounded)
- [ ] Windows/Mac compatibility tested (or documented as single-platform)
- [ ] Configuration examples provided (orchestrator.config.json)

## Related Files

- `/CLAUDE.md` — This file (global operating guidelines)
- `docs/ORCHESTRATOR_PROMPT.md` — Orchestrator system prompt (Rule 5b: continuous blocker monitoring)
- `docs/AUTO_APPROVAL_SYSTEM.md` — Auto-approval implementation guide
- `docs/ERROR_RECOVERY_DESIGN.md` — Error recovery architecture
- `orchestrator.config.json` — Runtime configuration (all systems)
- `REPOS.md` (in agentic-personal) — Cross-project routing and artifact storage

## Quick Reference

| Task | Command |
|------|---------|
| Test | `npm run test:run` |
| Type-check | `npm run typecheck` |
| Build | `npm run build` |
| Server | `npm run server` |
| Commit + push | `git add <files> && git commit -m "..." && git push` |

---

**Last Updated:** 2026-10-08  
**Version:** 1.0  
**Applies to:** agent-orchestrator, master-orchestrator
