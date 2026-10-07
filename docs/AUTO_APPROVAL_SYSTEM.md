# Auto-Approval System

## Overview

The auto-approval system provides **continuous background monitoring** of agent permission prompts, automatically approving safe operations and escalating risky ones to the user. This eliminates manual blocker management for routine tasks while maintaining full user control over sensitive operations.

**Goal:** Let agents work unblocked on safe operations (git, npm, standard tools) while requiring explicit user approval for risky operations (rm -rf, sudo, network access).

## Architecture

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Listener Loop** | `src/insights.ts:startInsights()` | Runs every 5 seconds, detects blockers, executes auto-approval decisions |
| **Eligibility Checker** | `src/insights.ts:checkAutoApprovalEligibility()` | Evaluates if a blocker matches safe/risky patterns |
| **Metrics Tracker** | `src/insights.ts:recordMetric()` | Records approvals/denials per minute, latencies, pattern frequency |
| **Alert System** | `src/insights.ts:checkAutoApprovalAlerts()` | Detects health issues (zero activity, high failures) |
| **Config** | `orchestrator.config.json:autoApproval` | Whitelist of safe/risky bash and file patterns |
| **API** | `src/server.ts:/metrics` | Exposes metrics and alerts for monitoring |

### Data Flow

```
Agent hits permission prompt
        ↓
monitorAgentBlockers() runs every 5s
        ↓
Detect BLOCKED state transition
        ↓
checkAutoApprovalEligibility(prompt, lastCmd)
        ↓
        ├─→ Check RISKY patterns first (fail-safe)
        │   ├─→ Match: Return { isSafe: false }
        │   └─→ No match: Continue
        │
        ├─→ Check SAFE patterns
        │   ├─→ Match: Return { isSafe: true, operation: pattern }
        │   └─→ No match: Continue
        │
        └─→ No patterns matched: Return { isSafe: false }
        ↓
        ├─→ SAFE: Auto-approve
        │   ├─ Send orch-send <sid> --key y
        │   ├─ Record approval metric
        │   └─ Log [auto-approved] tag
        │
        └─→ RISKY/UNKNOWN: Require user decision
            ├─ Add to "needs your attention" list
            ├─ Record denial metric
            └─ Log [blocker-detected] tag
```

## Configuration

### orchestrator.config.json

```json
{
  "autoApproval": {
    "enabled": true,
    "safeOperations": {
      "bashPatterns": [
        "git", "npm", "ls", "cat", "grep", "find", "echo", "test", "bash"
      ],
      "fileWritePatterns": [
        "docs/", "config/", "test/", ".md", ".ts", ".js", ".json"
      ],
      "risky": {
        "bashPatterns": [
          "rm -rf", "sudo", "curl", "wget", "deploy", "chmod 777"
        ],
        "filePatterns": [
          ".env", "secrets", "/etc/", ".key", ".pem", "credentials"
        ]
      }
    },
    "monitoring": {
      "blockersCheckIntervalMs": 5000,
      "messageTimeoutMs": 30000,
      "autoApprovalReportFormat": "✅ Auto-approved: {operation}",
      "blockerTimeoutMs": 300000,
      "maxApprovalsPerMinute": 10
    }
  }
}
```

### Configuration Guide

- **enabled**: Master switch for auto-approval system
- **bashPatterns** (safe): Commands safe to auto-approve (matched against first word before pipes)
- **fileWritePatterns** (safe): File paths safe to auto-approve (matched as substrings)
- **risky.bashPatterns**: Commands that require user approval (checked first, fail-safe)
- **risky.filePatterns**: Files that require user approval (.env, secrets, etc.)
- **blockersCheckIntervalMs**: How often to check for new blockers (default: 5s)
- **blockerTimeoutMs**: Clear stale blockers after this time (default: 5 min)
- **maxApprovalsPerMinute**: Rate limit to prevent approval spam (default: 10/min)

## Matching Logic

### How Commands Are Matched

1. **Prompt Extraction**: Extract command from permission prompt
   - `"Allow 'git commit'?"` → `git commit`
   - `"Permission denied. Allow 'git add'?"` → `git add`
   - `"Do you authorize 'npm install'?"` → `npm install`

2. **Command Normalization**: 
   - Expand environment variables: `git commit -m $MESSAGE` → `git commit -m <value>`
   - Extract primary command from piped operations: `git log | grep fix` → `git log`
   - Convert to lowercase for case-insensitive matching

3. **Pattern Matching** (fail-safe order):
   - **First**: Check RISKY patterns (if matched → deny)
   - **Then**: Check SAFE patterns (if matched → approve)
   - **Default**: Unknown → deny (conservative)

### Examples

#### Safe Operations (Auto-Approved)

```
✅ git commit -m "fix: bug"         → matches "git" → auto-approved
✅ npm install --save-dev package  → matches "npm" → auto-approved
✅ git log | grep "fix"            → matches "git" (primary) → auto-approved
✅ write docs/README.md            → matches "docs/" → auto-approved
✅ git commit -m $MESSAGE          → expands env var, matches "git" → auto-approved
```

#### Risky Operations (Require User Decision)

```
❌ rm -rf /path                     → matches "rm -rf" (risky) → denied
❌ sudo apt-get install            → matches "sudo" (risky) → denied
❌ curl http://example.com         → matches "curl" (risky) → denied
❌ write .env                       → matches ".env" (risky) → denied
❌ chmod 777 file.txt              → matches "chmod 777" (risky) → denied
```

#### Unknown Operations (Require User Decision)

```
⚠️  custom-script.sh               → no matching pattern → denied (conservative)
⚠️  ./deploy.sh                    → no matching pattern → denied (conservative)
```

## Features

### 1. Environment Variable Expansion

Commands with environment variables are automatically expanded before matching:

```bash
# Command: git commit -m $MESSAGE
# With env: {MESSAGE: "fix: critical bug"}
# Expanded: git commit -m "fix: critical bug"
# Result: Matches "git" → auto-approved
```

Supports both `$VAR` and `${VAR}` syntax.

### 2. Rate Limiting

Prevents approval spam by limiting approvals to 10 per minute. If the limit is hit:
- New blockers are added to "needs your attention" list
- User must decide whether to approve or deny
- Rate limit resets automatically every 60 seconds

```
[auto-approval-rate-limited] Too many approvals in last minute (10/10)
```

### 3. Blocker Timeout

Stale blockers that haven't been resolved are automatically cleared after 5 minutes:

```
[blocker-timeout] compile-master-prompt: blocker unresolved for 5 minutes, clearing
```

This prevents orphaned state if an agent crashes or terminates unexpectedly.

### 4. Agent Cleanup

When an agent terminates, all its associated state is cleaned up:
- Blocker alerts
- Approval history
- Agent state tracking

```
[cleanup-agent] Removed state for agent a1b2c3d4:5678
```

### 5. Prompt Variation Handling

Matches permission prompts regardless of format:

- `Allow 'git commit'?`
- `Permission denied. Allow 'git add'?`
- `Do you authorize 'npm install'?`
- `Grant permission for 'git push'?`

All are correctly extracted and matched.

## Metrics

The system tracks metrics every minute and logs them to console:

```
[metrics] approved: 12, denied: 3, unknown: 1, orch-failures: 0
```

### Available Metrics

- **Approvals/minute**: Number of auto-approved operations
- **Denials/minute**: Number of denied operations (risky/unknown)
- **Unknown/minute**: Number of unmatched operations
- **Orch-send failures**: Failed approval delivery attempts
- **Pattern frequency**: Count of each matched pattern
- **Decision latency**: Min/max/avg time to evaluate eligibility

### Accessing Metrics

**On-demand via API:**
```bash
curl http://localhost:3003/metrics
```

**In orchestrator logs:**
```
[metrics] approved: 12, denied: 3, unknown: 1, orch-failures: 0
[auto-approval-approved] safe bash pattern matched: git
[auto-approval-denied] risky bash pattern matched: rm -rf
```

## Alerting

The system detects and alerts on health issues:

### Alert Conditions

| Condition | Threshold | Alert |
|-----------|-----------|-------|
| No activity | 3+ minutes zero approvals/denials/unknowns | "Listener may be stuck" |
| High failures | >5 orch-send failures/minute | "High orch-send failure rate" |
| Slow decisions | >500ms average decision latency | "Slow auto-approval decisions" |
| High denials | Denials > Approvals × 2 | "Many denials this minute" |

### Alert Delivery

Alerts are sent as periodic system messages to the orchestrator:

```
[auto-approval-status] 
⚠️ No auto-approval activity detected in the last minute. Listener may be stuck.
⚠️ High orch-send failure rate: 7 failures recorded
```

Sent every 60 seconds, only when conditions exist.

## Logging

All auto-approval activity is logged with specific tags for easy grepping:

```bash
# View all auto-approval activity
grep '\[auto-approval-' orchestrator.log

# View specific approvals
grep '\[auto-approval-approved\]' orchestrator.log

# View denials
grep '\[auto-approval-denied\]' orchestrator.log

# View metrics
grep '\[metrics\]' orchestrator.log

# View errors
grep '\[auto-approval-failed\]' orchestrator.log
```

### Log Tags

| Tag | Meaning | Example |
|-----|---------|---------|
| `[listener-running]` | Monitoring started | `Monitoring 3 agents` |
| `[listener-checking]` | Checking agent | `Agent: compile-master, LastCmd: git add .` |
| `[auto-approval-check]` | Evaluating operation | `prompt: Allow 'git commit'?, cmd: git commit` |
| `[auto-approval-approved]` | Approved and sent | `safe bash pattern matched: git` |
| `[auto-approval-denied]` | Denied (risky) | `risky bash pattern matched: rm -rf` |
| `[auto-approval-unknown]` | Denied (unknown) | `no patterns matched` |
| `[auto-approved]` | Approval delivered | `compile-master-prompt: git (approval sent via orch-send)` |
| `[auto-approval-failed]` | Delivery failed | `git: spawn ENOENT` |
| `[auto-approval-rate-limited]` | Rate limit hit | `Too many approvals in last minute (10/10)` |
| `[blocker-timeout]` | Stale blocker cleared | `agent: blocker unresolved for 5 minutes, clearing` |
| `[cleanup-agent]` | Agent state cleaned up | `Removed state for agent a1b2c3d4` |
| `[metrics]` | Minute-by-minute summary | `approved: 12, denied: 3, unknown: 1` |
| `[auto-approval-status]` | System alerts | `⚠️ No activity for 3 minutes` |

## Troubleshooting

### Agent Still Prompting for Safe Operations

**Problem:** Auto-approval isn't working for operations that should be safe.

**Causes & Solutions:**

1. **Config not reloaded**: Restart the orchestrator to reload `orchestrator.config.json`
   ```bash
   npm run server
   ```

2. **Pattern doesn't match**: Check that the command matches a pattern exactly
   - Pattern: `git` | Command: `GIT` → ✅ (case-insensitive)
   - Pattern: `git` | Command: `git-flow` → ❌ (substring match, but word boundary differs)

3. **Listener not running**: Check logs for `[listener-running]`
   - If missing, the listener loop may have crashed
   - Check orchestrator logs for errors

**Debug Steps:**

1. Check if listener is running:
   ```bash
   grep '\[listener-running\]' orchestrator.log
   ```

2. Check if operation was evaluated:
   ```bash
   grep '\[auto-approval-check\].*your-command' orchestrator.log
   ```

3. Check matching result:
   ```bash
   grep '\[auto-approval-approved\|auto-approval-denied\|auto-approval-unknown\]' orchestrator.log
   ```

### High Denial Rate

**Problem:** Many operations are being denied that should be auto-approved.

**Causes & Solutions:**

1. **Rate limit hit**: Check for rate limit messages
   ```bash
   grep '\[auto-approval-rate-limited\]' orchestrator.log
   ```
   Solution: Increase `maxApprovalsPerMinute` in config or wait for limit to reset

2. **Risky pattern too broad**: A safe operation matches a risky pattern
   - Example: Pattern `rm` matches `mkdir` (substring match)
   - Solution: Use more specific patterns (e.g., `rm -rf` instead of `rm`)

3. **Missing safe pattern**: A command isn't in the safe list
   - Solution: Add the pattern to `safeOperations.bashPatterns`

### Metrics Show No Activity

**Problem:** No auto-approval activity in metrics.

**Causes & Solutions:**

1. **No blockers occurring**: Agents might not be hitting permission prompts
   - Run an agent that uses tools to trigger blockers for testing

2. **System disabled**: Check if `autoApproval.enabled` is `true`

3. **Listener crashed**: Check orchestrator logs for errors
   - If listener loop fails, auto-approval stops until orchestrator restarts

## Adding New Safe Patterns

To extend the whitelist with new safe operations:

1. **Edit** `orchestrator.config.json`
2. **Add pattern** to `safeOperations.bashPatterns` or `safeOperations.fileWritePatterns`
3. **Restart** orchestrator: `npm run server`
4. **Verify** by checking logs for matching operations

### Example: Adding `python` to Safe Patterns

```json
{
  "safeOperations": {
    "bashPatterns": [
      "git", "npm", "python", "ls", "cat", "grep"
    ]
  }
}
```

After restart, `python script.py` will be auto-approved.

## Best Practices

1. **Be Conservative with Safe Patterns**: Only add patterns for tools you trust
   - `git` ✅ (version control, safe)
   - `python` ⚠️ (can do anything, consider context)
   - `curl` ❌ (network access, risky)

2. **Use Specific Patterns**: Be precise to avoid false positives
   - Good: `rm -rf` (specific dangerous operation)
   - Bad: `rm` (could match `mkdir`, `grep`, etc.)

3. **Monitor Activity**: Check logs regularly for anomalies
   ```bash
   grep '\[auto-approval\|blocker-timeout\|metrics\]' orchestrator.log
   ```

4. **Review Denials**: If an operation is denied, verify it's actually risky
   ```bash
   grep '\[auto-approval-denied\]' orchestrator.log
   ```

5. **Set Appropriate Rate Limit**: Balance throughput with safety
   - Default: 10/minute (reasonable for most workflows)
   - High-volume agent: increase to 20-30/minute
   - Security-sensitive: decrease to 5/minute

## Performance

- **Decision latency**: <10ms per operation (sub-second)
- **Listener overhead**: <1% CPU (runs every 5 seconds)
- **Memory usage**: ~1-2MB for state tracking
- **Rate limit**: 10 approvals/minute (configurable)

## Security Notes

- **Fail-safe**: Unknown operations are always denied (conservative default)
- **Risky patterns checked first**: Prevents accidental approval of dangerous ops
- **Rate limiting**: Prevents approval spam attacks
- **No privilege escalation**: Only approves exactly what pattern matches
- **User control maintained**: Risky operations always require explicit user decision

## Examples

### Example: Safe Git Workflow

```
Agent: "git add ."
System: "Allow 'git add .'?"
Result: ✅ Auto-approved (matches 'git' pattern)
Agent: "git commit -m 'fix: bug'"
System: "Allow 'git commit -m fix: bug'?"
Result: ✅ Auto-approved (matches 'git' pattern)
Agent: "git push"
System: "Allow 'git push'?"
Result: ✅ Auto-approved (matches 'git' pattern)
```

### Example: Risky Operation Caught

```
Agent: "rm -rf /path"
System: "Allow 'rm -rf /path'?"
Result: 🚨 Denied (matches risky pattern 'rm -rf')
Orchestrator: User notified, must decide
User: "Approve" or "Deny"
```

### Example: Unknown Operation

```
Agent: "bash ./deploy.sh"
System: "Allow 'bash ./deploy.sh'?"
Result: ⚠️ Denied (unknown script, no pattern match)
Orchestrator: User notified
User: "Approve" or "Deny"
```

## See Also

- `orchestrator.config.json` — Configuration file
- `src/insights.ts` — Implementation
- `ORCHESTRATOR_PROMPT.md` — Master orchestrator rules (Rule 5b)
