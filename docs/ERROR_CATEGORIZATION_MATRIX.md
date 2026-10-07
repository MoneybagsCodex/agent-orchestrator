# Error Categorization Matrix

This document provides the definitive mapping of error patterns to categories for implementing `categorizeError()` in the Error Recovery system.

## Error Category Definitions

### TRANSIENT
**Definition**: Temporary errors that will likely resolve with time or retries.
**Recovery**: Retry with exponential backoff (up to 4 attempts)
**Examples**: Network glitches, rate limits, temporary service unavailability

### PERMANENT  
**Definition**: Errors that will not resolve with retries; require fixing root cause.
**Recovery**: Escalate to user with context
**Examples**: File not found, permission denied, invalid parameters

### AGENT_SPECIFIC
**Definition**: Errors specific to an agent's configuration, state, or availability.
**Recovery**: Fallback to alternative agent or manual intervention
**Examples**: Tool not available, agent not responding, message delivery refused

### SYSTEM
**Definition**: Errors in orchestrator infrastructure or resource limits.
**Recovery**: Graceful degradation, auto-recovery where possible
**Examples**: Context limit exceeded, disk full, process crashed

### USER
**Definition**: Errors requiring clarification or decision from the user.
**Recovery**: Present options and ask for choice
**Examples**: Ambiguous instruction, conflicting parameters

---

## Categorization Rules by Source

### Claude API Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| `error.status === 'rate_limit_exceeded'` or HTTP 429 | TRANSIENT | Message contains "rate_limit" or status 429 | Retry with backoff |
| `error.status === 'overloaded'` or HTTP 503 | TRANSIENT | Status 503 or "service_unavailable" | Retry with backoff |
| `error.status === 'timeout'` or `error.type === 'timeout_error'` | TRANSIENT | Timeout exception or >30s elapsed | Retry with backoff |
| `error.status === 'invalid_request_error'` | PERMANENT | Invalid parameter or malformed request | Escalate (user may need to fix) |
| `error.status === 'authentication_error'` or HTTP 401 | PERMANENT | 401 or "unauthorized" | Escalate (check API key) |
| `error.status === 'permission_error'` or HTTP 403 | PERMANENT | 403 or "forbidden" | Escalate (insufficient permissions) |
| `error.status === 'not_found_error'` or HTTP 404 | PERMANENT | 404 or "not_found" | Escalate (resource doesn't exist) |
| `error.status === 'api_error'` (generic) | TRANSIENT | Generic error with no specific status | Retry once, then escalate |
| HTTP 500, 502 (service error) | TRANSIENT | 500/502 status | Retry with backoff |
| Connection aborted/refused (`ERR_HTTP2_STREAM_RESET`) | TRANSIENT | Socket error or stream reset | Retry with backoff |

### File System Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| `ENOENT` (File not found) | PERMANENT | errno 2 or "ENOENT" in message | Escalate (file missing or path wrong) |
| `EACCES` (Permission denied) | PERMANENT | errno 13 or "EACCES" in message | Escalate (need higher permissions) |
| `EPERM` (Operation not permitted) | PERMANENT | errno 1 or "EPERM" in message | Escalate (system denied operation) |
| `ENOSPC` (Disk full) | SYSTEM | errno 28 or "ENOSPC" in message | Degrade (try to cleanup, compact) |
| `EISDIR` (Is a directory) | PERMANENT | errno 21 or "EISDIR" in message | Escalate (wrong file type) |
| `EMFILE` (Too many open files) | SYSTEM | errno 24 or "EMFILE" in message | Degrade (close handles, retry) |
| `ENAMETOOLONG` (Name too long) | PERMANENT | errno 36 or "ENAMETOOLONG" | Escalate (path too long) |
| Timeout reading/writing file (>10s) | TRANSIENT | setTimeout elapsed or `ETIMEDOUT` | Retry with backoff |

### Network Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| `ETIMEDOUT` (Connection timeout) | TRANSIENT | "ETIMEDOUT" or timeout >30s | Retry with backoff |
| `ECONNREFUSED` (Connection refused) | TRANSIENT | "ECONNREFUSED" or "refused" | Retry with backoff |
| `EHOSTUNREACH` (Host unreachable) | TRANSIENT | "EHOSTUNREACH" or "unreachable" | Retry with backoff |
| `ENETUNREACH` (Network unreachable) | TRANSIENT | "ENETUNREACH" | Retry with backoff |
| `ECONNRESET` (Connection reset) | TRANSIENT | "ECONNRESET" or "reset by peer" | Retry with backoff |
| DNS resolution failure | TRANSIENT | "getaddrinfo" or "ENOTFOUND" | Retry with backoff |
| SSL/TLS error | PERMANENT | "CERT_" or "ERR_SSL_" in message | Escalate (certificate issue) |

### Child Process Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| Process exits unexpectedly (code 1, signal) | SYSTEM | Exit without `restarting` flag set | System recovery (restart process) |
| Process hangs (no stdout for >2 min) | TRANSIENT | Last activity >120s ago, process running | Interrupt and retry |
| Process memory exceeded | SYSTEM | Out of memory exception | Degrade (compact, restart) |
| Process killed by signal (SIGKILL, SIGTERM) | SYSTEM | Signal number in exit event | System recovery (restart) |

### Agent Communication Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| Message delivery refused (agent user denied) | AGENT_SPECIFIC | Delivery notice says "refused" | Fallback (try different agent, escalate) |
| Agent inbox not found or unreadable | AGENT_SPECIFIC | Cannot locate `.jsonl` transcript file | Fallback (agent may have crashed) |
| Agent not responding after 10 min (message still "sent") | AGENT_SPECIFIC | Message state "sent" and age >600s | Escalate (agent may be stuck) |
| Cross-session message expired | AGENT_SPECIFIC | Delivery notice says "expired" | Escalate (agent not ready to receive) |
| Agent marked as BLOCKED (permission prompt) | AGENT_SPECIFIC | Agent state is "BLOCKED" | Escalate (user must approve in agent terminal) |

### Task/Worker Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| Worker exceeded stale timeout (20 min no update) | AGENT_SPECIFIC | Worker.status = "running" and quiet >1200s | Escalate (worker may be stuck) |
| Worker exits with failed status | SYSTEM | Worker.status = "failed" | Escalate (worker hit error, logs available) |
| Too many active workers (>5) | SYSTEM | ActiveWorker count ≥ MAX_ACTIVE_WORKERS | Degrade (queue next worker) |

### Metrics/State Errors

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| Context tokens >200k (near compact line) | SYSTEM | context.tokens > budgets.contextWarnTokens | Degrade (auto-compact) |
| Context tokens >150k and must continue | SYSTEM | context.tokens > budgets.contextCompactTokens | Degrade (compact automatically) |
| Usage budget exceeded (chat hourly) | SYSTEM | spentThisHour > chatHourlyUsd budget | Degrade (slow down, warn user) |
| Daily budget exceeded (80%+) | SYSTEM | spentToday > 0.8 * dailyBudget | Warn user, encourage pause |

### Invalid Input (User Error)

| Error Signal | Category | Detection | Action |
|---|---|---|---|
| Ambiguous agent reference (multiple matches) | USER | Agent query matches 2+ agents | Escalate (ask user to clarify which one) |
| Missing required parameter in request | USER | Parameter in POST body is undefined/empty | Escalate (return 400 with missing field name) |
| Conflicting instructions (mutually exclusive) | USER | User asks for A AND NOT A simultaneously | Escalate (ask which one takes precedence) |
| Invalid JSON in request body | USER | JSON.parse() throws SyntaxError | Respond with 400 (bad request format) |
| Out-of-range value (e.g., limit=99999) | USER | Parameter outside valid range | Respond with 400 (explain valid range) |

---

## Decision Tree: How to Categorize an Error

```
Is it from Claude API?
├─ YES → Check HTTP status or error.status
│   ├─ 429, 503, 504, timeout, ERR_HTTP2_STREAM_RESET? → TRANSIENT
│   ├─ 400, 401, 403, 404, invalid_request? → PERMANENT
│   ├─ 500, 502, generic api_error? → TRANSIENT
│   └─ anything else? → TRANSIENT (retry once, then escalate)
│
└─ NO, is it a file system error?
   ├─ YES → Check errno
   │   ├─ ENOENT, EACCES, EPERM, EISDIR, ENAMETOOLONG? → PERMANENT
   │   ├─ ENOSPC, EMFILE? → SYSTEM
   │   ├─ Timeout? → TRANSIENT
   │   └─ anything else? → PERMANENT (safer to escalate)
   │
   └─ NO, is it a network error?
      ├─ YES → Check error name
      │   ├─ ETIMEDOUT, ECONNREFUSED, EHOSTUNREACH, ECONNRESET, DNS? → TRANSIENT
      │   ├─ SSL/TLS? → PERMANENT
      │   └─ anything else? → TRANSIENT
      │
      └─ NO, is it a process error?
         ├─ YES → Check what happened
         │   ├─ Process exited/killed? → SYSTEM
         │   ├─ Process hangs (no output 2+ min)? → TRANSIENT
         │   ├─ Out of memory? → SYSTEM
         │   └─ anything else? → SYSTEM
         │
         └─ NO, is it agent communication?
            ├─ YES → Check delivery status
            │   ├─ Message refused? → AGENT_SPECIFIC
            │   ├─ Agent not responding 10+ min? → AGENT_SPECIFIC
            │   ├─ Agent BLOCKED? → AGENT_SPECIFIC
            │   └─ Message expired? → AGENT_SPECIFIC
            │
            └─ NO, is it orchestrator infrastructure?
               ├─ YES → Context/budget/state issues? → SYSTEM
               │
               └─ NO, is it user input?
                  ├─ YES → Invalid/ambiguous/missing? → USER
                  │
                  └─ NO → Default to TRANSIENT (unknown error, try once)
```

---

## Recovery Action Lookup

Once categorized, the recovery action is determined by:

```typescript
const recoveryMap: Record<ErrorCategory, RecoveryAction[]> = {
  TRANSIENT: ['retry', 'escalate'],              // Primary: retry; fallback: escalate
  PERMANENT: ['escalate', 'rollback'],           // Primary: escalate; fallback: rollback
  AGENT_SPECIFIC: ['fallback', 'escalate'],      // Primary: fallback; fallback: escalate
  SYSTEM: ['degraded', 'cleanup', 'escalate'],   // Primary: degrade; escalate if impossible
  USER: ['escalate'],                            // Always ask user
};
```

### Examples

**Claude API 429 (Rate Limit)**
1. Categorize: TRANSIENT
2. Apply retry policy: maxRetries=4, backoff=500ms base
3. If still failing after 4 retries: escalate to user with message "API rate limited; try again in X seconds"

**File not found on write**
1. Categorize: PERMANENT
2. Escalate: "Cannot write to /path/file: file not found or path is invalid"
3. User must fix path or create file

**Agent message delivery refused**
1. Categorize: AGENT_SPECIFIC
2. Fallback: Offer to try agent-2
3. If no fallback available: escalate with "Agent refused message. Its user must approve in the agent terminal."

**Orchestrator context 95% full**
1. Categorize: SYSTEM
2. Degrade: Auto-compact conversation to clear context
3. Notify: "Orchestrator context compacted; operating at reduced capacity"

**Ambiguous agent reference ("compile")**
1. Categorize: USER
2. Escalate: "Which agent did you mean? compile-ui [id1] or compile-backend [id2]?"
3. Wait for user clarification

---

## Testing Checklist

For each error category, ensure tests cover:

- [ ] TRANSIENT: Retry logic works; exhausts max retries; backoff increases; jitter applied
- [ ] PERMANENT: Escalation message clear and actionable; no silent failures
- [ ] AGENT_SPECIFIC: Fallback tried; agent state cleanup happens; escalation clear
- [ ] SYSTEM: Degraded mode activated; cleanup attempted; user notified
- [ ] USER: User asked for clarification; options presented; timeout if no response
- [ ] Circuit breaker: Opens after threshold; half-open after recovery timeout; closes on success
- [ ] Metrics: Errors counted by category; retry success rate tracked; recovery actions recorded
- [ ] Configuration: Policies loaded correctly; can be reloaded live; invalid config falls back to defaults
