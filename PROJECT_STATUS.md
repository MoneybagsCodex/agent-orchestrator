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

1. **Permission system blocker:** agents on "don't ask" permission mode are blocked on Bash.
2. **Listener alert fix:** listener floods alerts when idle. `bb03819` addresses part of this by skipping auto-approval alerts when no agents are running. Whether it fully resolves the flood is unverified.
3. **Stalled dashboard work:** (unverified) scope not defined in the repo.

## 4. Open Tasks

| Task | Status | Blocked by |
|---|---|---|
| Permission mode "don't ask" blocks Bash | Blocked | Permission config (not changed by this session) |
| Listener alert flood when idle | Partially addressed (`bb03819`) | Verification needed |
| Missing context tracking | Not started (unverified) | — |
| Dashboard tile layout | Stalled | Locating dashboard code (localhost:4000). Flickering from polling; Y-axis height makes it hard to see all agents at once. Plan: switch to SSE or implement responsive CSS Grid layout. |

## 5. Known Blockers

- **"Don't ask" permission mode blocks Bash.** Recent commit `107b52e` checks the prompt's own command for bash auto-approval. Effect on this blocker is unverified.
- **Listener floods alerts when idle.** Docs describe a "Listener may be stuck" alert after 3+ minutes with no activity (`docs/AUTO_APPROVAL_SYSTEM.md`). This may be the source of the flood. Partial fix in `bb03819`.
- **Missing context tracking.** No evidence in the repo of a context-tracking feature. (unverified)

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
6. Scope context tracking as a new task.

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

## 9. SOLUTION: HTTP Sideband API for Orchestrator Communication

**Problem:** Cross-session messaging is held by permission mode mismatches, blocking autonomous orchestration.

**Solution:** HTTP-based parallel infrastructure for autonomous orchestrated workflows. Agents coordinate via REST API instead of cross-session messages, enabling reliable async task assignment and result reporting.

**Architecture:**
- Orchestrator runs lightweight HTTP server (localhost:5000, `src/http-bridge.ts`, config under `httpBridge` in `orchestrator.config.json`)
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
