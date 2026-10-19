# PROJECT_STATUS

Persistent context between sessions. Last updated: 2026-10-17.
Sources: git log, `npm run typecheck` result, and docs in `docs/`. Items marked **(unverified)** come from the session brief and were not confirmed in the repo.

## 1. System State

- **Repo:** `agent-orchestrator` (`origin` → github.com/MoneybagsCodex/agent-orchestrator)
- **Working tree:** clean at start of this session
- **Typecheck:** `npm run typecheck` passes (exit 0)
- **Latest commits:**
  - `107b52e` Check the prompt's own command for bash auto-approval
  - `e7a0b17` Fix typecheck errors and route categorized errors to retry strategies
  - `bb03819` Fix: skip auto-approval alerts when no agents running
- **Active agents:** (unverified) not checked in this session
- **Recent issues:** (unverified) see Known Blockers

## 2. Completed Phases

Per the brief: **Phases 1, 4, 5, 6 complete.**

Git history also contains commits for **Phase 2** (error categorization, `86bc48e`) and **Phase 3** (retry and backoff with circuit breaker, `b011d4d`). Phase 2 and 3 are not listed in the brief. Confirm their status before relying on this list.

| Phase | Commit(s) | Doc |
|---|---|---|
| 1 Auto-Planning | `c0f7d64` | `docs/AUTO_PLANNING.md` |
| 2 Error Categorization | `86bc48e` | `docs/ERROR_CATEGORIZATION_MATRIX.md` |
| 3 Retry & Backoff | `b011d4d` | `docs/PHASE_3_RETRY_BACKOFF.md` |
| 4 Recovery Actions | `480ed91` | `docs/PHASE_4_RECOVERY_ACTIONS.md` |
| 5 Monitoring | `ba19eea` | `docs/PHASE_5_MONITORING.md`, `docs/PHASE_5_VALIDATION_REPORT.md` |
| 6 Deployment / Integration | `71d0fbb`, `c2a7b48` | `docs/PHASE_6_DEPLOYMENT.md` |

## 3. Current Goals

1. **Permission system blocker: RESOLVED for agent replies** via the HTTP bridge (`506fe51`). Bash under "don't ask" mode is not covered by this and is still unverified (see section 4).
2. **Listener alert fix:** listener floods alerts when idle. `bb03819` addresses part of this by skipping auto-approval alerts when no agents are running. Whether it fully resolves the flood is unverified.
3. **Dashboard tile layout: COMPLETE** (`aa57f58`, four-part rows, task-centric). Verified in master-orchestrator; commits live in that repo, not this one.
4. **Agent capability discovery: COMPLETE** (`b1c226b`, `e484d85`). `requiresCapability` routing via the bridge. 396 tests pass. Live check was against a temporary bridge.

## 4. Open Tasks

| Task | Status | Blocked by |
|---|---|---|
| Permission mode "don't ask" blocks Bash | Blocked | Permission config (not changed by this session) |
| Listener alert flood when idle | Partially addressed (`bb03819`) | Verification needed |
## 5. Known Blockers

- **"Don't ask" permission mode blocks Bash.** Recent commit `107b52e` checks the prompt's own command for bash auto-approval. Effect on this blocker is unverified.
- **Listener floods alerts when idle.** Docs describe a "Listener may be stuck" alert after 3+ minutes with no activity (`docs/AUTO_APPROVAL_SYSTEM.md`). This may be the source of the flood. Partial fix in `bb03819`.
## 6. Next Steps

1. Verify `bb03819` stops the idle alert flood under a live run. Check logs for `[listener-running]` and idle alerts.
2. Reproduce the Bash-under-"don't ask" blocker and confirm whether `107b52e` resolves it.
3. Confirm status of Phases 2 and 3, then update section 2.
4. Locate and fix dashboard kanban tiles:
   - Find dashboard code (runs on localhost:4000)
   - Replace polling with SSE for real-time updates
   - Implement CSS Grid auto-fit for responsive layout
   - Fix flickering from constant re-renders
5. Confirm scope of dashboard work (not verified in the repo).
## 7. Context for Next Session

- This file was created at the request of the `master-orchestrator` session, for persistent context tracking.
- Repo was clean and typecheck passed when this file was written.
- Permission settings were not modified.
- Start by reading this file, then `git log --oneline -15`, then `docs/AUTO_APPROVAL_SYSTEM.md` for the listener and blocker behavior.

## 8. Blocker: Cross-Session Messages Held by Permission Mode Mismatch

**Priority:** High. Blocks reliable multi-session coordination.

**What happened:**
- A reply from this session to master-orchestrator (`uds:/tmp/cc-socks/40542.sock`, msg_id `b89844a8-3b1f-4435-aa06-830edd96106f`) was held by the recipient. Delivery notice: NOT delivered; its Claude has not seen it.
- The held state did not expire or release during this session. Do not treat the message as delivered.

**Likely cause (not confirmed):** Sessions run in different permission modes. A session in an interactive mode asks its user to approve; a non-interactive session cannot ask, so the hold expires unless the modes match. A session can also be set to hold all messages.

**Impact:**
- Orchestrator-to-agent work assignments and agent-to-orchestrator completion reports may not arrive.
- Workaround in use: share results through git (committed files) instead of messages.

**Options to resolve:**
1. Project-level permission config that all sessions inherit. Verify the mechanism exists before relying on it.
2. Orchestrator launches agents with matching permission modes.
3. Cross-session messages bypass the mode check. This is a permission decision, so it needs the user's approval, not a workaround.

**Not verified in this session:** Whether the other session has since released or denied the message, and whether any other session saw messages from this one.

**Update (2026-10-17):** Agent replies now go through the task bridge instead of SendMessage. Agents run `orch-reply --agent <name> "<text>"`, which POSTs to `/message` on port 5001 with a shared token (`~/.operator-state/bridge.token`). The server hands each reply to the master as a `[bridge-reply]` turn. End-to-end test: a reply from `smoke-test` appeared in the master's transcript. SendMessage remains a fallback. Limit: agent names are self-declared, and the token only keeps out processes outside this machine's user.

## 9. SOLUTION: HTTP Sideband API for Orchestrator Communication

**Problem:** Cross-session messaging is held by permission mode mismatches, blocking autonomous orchestration.

**Solution:** HTTP-based parallel infrastructure for autonomous orchestrated workflows. Agents coordinate via REST API instead of cross-session messages, enabling reliable async task assignment and result reporting.

**Architecture:**
- Orchestrator runs lightweight HTTP server (localhost:5001, `src/http-bridge.ts`, config under `httpBridge` in `orchestrator.config.json`)
- Agents make HTTP requests instead of cross-session messages
- REST API for task assignment and result reporting
- State is in memory; lost on restart

**Endpoints:**
- `POST /task` — Assign work to agent (orchestrator → agent)
- `GET /task` — Agent polls for pending work (agent → orchestrator)
- `POST /result` — Agent reports completion (agent → orchestrator)
- `GET /status` — Agent reports health/progress (agent → orchestrator)

**Why HTTP:**
- ✅ Standard, proven technology
- ✅ Cross-platform (Mac/Windows/Linux)
- ✅ Easy to debug (curl, logs, browser)
- ✅ Scales to remote agents later
- ✅ Low maintenance (industry standard patterns)

**Priority:** HIGH — Unblocks autonomous orchestration workflows

**Status:** Bridge module implemented (`src/http-bridge.ts`), disabled by default and not yet started by the server. Wiring it into startup is pending.

## 11. Session Summary (2026-10-17)

**Delivered:**
1. HTTP Sideband Bridge (506fe51) - agents reply via REST, no message holding
2. Agent Capability Discovery (b1c226b, e484d85) - intelligent routing, 396 tests, live (smoke-tested against a temporary bridge)
3. Dashboard Tiles (ff0cddb, ae545d3, bea8c9d, 2460531, aa57f58) - four-part rows, task-centric, compact (verified in master-orchestrator; commits are not in this repo)

**Architecture improvements:**
- Removed cross-session message dependency (now uses HTTP bridge)
- Added capability registry for intelligent agent routing
- Dashboard now scannable and task-focused

**Pending:**
- SSE state-stream endpoint (approved for future implementation)
- Blocker tile real-world testing (needs a live blocked agent)

## 12. E2E Orchestration Test (2026-10-18)

**Test executed:** Full orchestration loop: task assignment → agent claim → work → reply via bridge.

**Results: PASS (agent side)**
- Task assigned via POST /task (HTTP 201)
- Task claimed via GET /task?agent=<agent> (task `802074d5`)
- Work completed (2 s simulation)
- Reply sent via orch-reply (HTTP POST /message, message `1467c278`)
- Master-orchestrator reports a `[bridge-reply]` with no `[Cross-session delivery notice]`. **Reported by master-orchestrator; not verified in this repo.**
- **Confirms:** the message-holding blocker is resolved for bridge replies. Bash under "don't ask" mode is still unverified.

**Orphaned tasks issue:**
- Bridge has no DELETE /task endpoint
- Tasks claimed by the wrong agent stay in `claimed` state
- Needs a delete mechanism (tech debt)

**Permission scope learning:**
- Peer approval (cross-session messages) does not count as user approval
- Each session needs approval in that session for credentials and cross-agent work
- Proposed: standing rule pre-approving self-addressed test tasks (narrow scope). Not in effect until the user approves it.

**System status:** Bridge-based orchestration works end to end in the tests run. Broader autonomous operation is not yet verified.

## 13. Orchestration Fixes (Gemini Analysis & Implementation)

**Problem Analysis (from Gemini, relayed by master-orchestrator; not verified here):**
Claude Code evaluates tool permissions based on binary invocation, not stdin source. HTTP bridge solved message holding, but per-session approvals remain because each worker needs explicit launch flags.

**Solution: Three-Layer Fix (Sequential Implementation)**

### Layer 1: File-Driven Transient Workers (CRITICAL)
**Pivot (from Gemini analysis):** Instead of persistent sessions with pre-approved flags, use ephemeral headless workers.

**How it works:**
1. Master writes task JSON to `~/.operator-state/tasks/pending_[agent_name].json`
2. Spawn one-shot Claude Code instance with automation flags to read file, execute, reply, exit
3. No persistent session = no approval harness = clean autonomous execution

**Why this works (per Gemini analysis, not verified here):**
- File I/O (system boundary) doesn't trigger permission evaluation
- Ephemeral process has no lingering session state
- One-shot execution avoids approval gate entirely

**Open:**
- Tool calls (Bash, Edit) inside the worker are still permission-gated. File I/O only moves the task, so the worker still needs an allow-list or permission mode. The exact flags must come from the CLI check (`--permission-mode`, `--allowedTools`), not from the old `--auto --allow-bash` names, which do not exist.
- Changing worker permission modes is a user decision.

- Status: **IN DESIGN** (scoping Task A: CLI params, Task B: JSON schema, Task C: edge cases)

### Session 2026-10-18: File-Driven Worker Design & Permission Strategy

**Deliverables:**
- File-driven transient worker design: **proposed**, not yet tested against a live worker
- Task B JSON schema v1: **proposed** (sent to master-orchestrator; not yet accepted)
- Task C risk assessment: **not done.** The safeguards and blockers listed below are open items, not a completed assessment.

**Permission Decision: PROPOSED, needs the user's decision**
- Start: fixed allowlist (bounded commands, pre-approved in CLAUDE.md)
- Prove: run orchestration at scale with known-good commands
- Graduate: expand to auto-approval once the system is proven
- No permission settings or CLAUDE.md allowlist have been changed. Both need the user's approval.

**Blockers (next session):**
1. Add claim lease to bridge (fixes orphaned tasks)
2. Define a safe allowlist (git, npm, basic shell). Requires the user's approval before it goes into CLAUDE.md
3. Task A: CLI spec with allowlist permissions
4. Build and test the file-driven worker

**Alternative exploration:** Evaluate agentastic.dev as a comparison. Not started. Needs the user's go-ahead because it is an external service.

**Status:** Design proposed, not yet built or tested. Next: the user decides on the permission strategy, then implementation.

### Layer 2: Task Cleanup (IMPORTANT)
- Add DELETE /task/:id endpoint to http-bridge.ts
- Add TTL expiry (5-min default) with cleanup loop
- Prevents orphaned tasks from accumulating
- Status: **PLANNED**

### Layer 3: SSE Dashboard (NICE-TO-HAVE)
- Replace polling with Server-Sent Events stream
- Broadcast updates on POST /result and POST /capability
- Reduces CPU overhead on master orchestrator
- Status: **PLANNED**

**Testing:** Each layer tested independently. Stop and report at each stage.
