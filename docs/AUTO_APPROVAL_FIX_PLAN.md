# Auto-Approval System: Comprehensive Fix Plan

## 1. Edge Cases & Coverage Analysis

### Currently Covered
- ✅ Safe bash patterns (git, npm, standard tools)
- ✅ Safe file write patterns (docs/, config/, test/)
- ✅ Risky bash patterns (rm -rf, deploy, sudo, curl)
- ✅ Risky file patterns (.env, /etc/, secrets)
- ✅ Fail-safe approach (check risky FIRST)
- ✅ Auto-send approval via orch-send --key y

### Edge Cases NOT Yet Covered

#### 1. Permission Prompt Variations
- **Issue**: Different permission prompt formats may not be recognized
- **Examples**:
  - "Allow this tool to run?"
  - "Permission denied. Allow? [Y/n]"
  - "Do you authorize this operation?"
  - Tool-specific prompts (jq, sed, awk)
- **Fix**: Extend pattern matching to be more flexible; capture ANY permission-like prompt

#### 2. Multi-Step Operations
- **Issue**: Operations that require multiple approvals in sequence
- **Examples**:
  - `git commit` followed by `git push`
  - `npm install` followed by `npm build`
- **Current**: Each blocker is evaluated independently - should work, but no testing

#### 3. Piped Commands
- **Issue**: Commands with pipes may not match patterns correctly
- **Examples**:
  - `git log | grep "fix"`
  - `cat file.txt | jq '.field'`
  - `ls -la | head -5`
- **Current**: Logic checks if cmd includes pattern - pipes could break this

#### 4. Commands with Flags/Options
- **Issue**: Commands with complex flags may not match
- **Examples**:
  - `git commit -m "message"` vs pattern `git commit`
  - `npm install --save-dev` vs pattern `npm install`
  - `curl --header "X-Auth: token" http://...`
- **Current**: Uses string.includes() which should handle flags, but untested

#### 5. Environment Variable Expansion
- **Issue**: Commands may contain unexpanded env vars
- **Examples**:
  - `git commit -m "$MESSAGE"`
  - `cp $SOURCE $DEST`
- **Current**: No handling for this

#### 6. Unknown Tools/Custom Scripts
- **Issue**: Agents may run custom bash scripts not in whitelist
- **Examples**:
  - `bash custom-build.sh`
  - `./scripts/deploy.sh`
- **Current**: Default to deny (conservative), but no categorization

#### 7. Agent Registration
- **Issue**: How do we know if an agent is registered and should be monitored?
- **Current**: Listens to ALL agents; no registry or allowlist
- **Concern**: Should we whitelist which agents are trusted for auto-approval?

#### 8. Rate Limiting
- **Issue**: What if agent hits many blockers rapidly?
- **Current**: No rate limiting; could spam auto-approvals or denials
- **Concern**: Noisy logging, potential issues if whitelist is wrong

#### 9. Blocker Timeout
- **Issue**: What if auto-approval fails and blocker persists?
- **Current**: No retry logic, no escalation after timeout
- **Concern**: Agent could be stuck forever

#### 10. Stale Blockers
- **Issue**: What if agent dies while blocked?
- **Current**: Blocker stays in tracking map forever
- **Concern**: Memory leak in agentLastState and blockerAlerts maps

---

## 2. Test Plan

### Phase 1: Unit Tests (src/insights.test.ts)

#### Test checkAutoApprovalEligibility()
```
✓ Test safe bash patterns (git commit, npm install, ls, etc.)
✓ Test safe file patterns (docs/, config/, .md files)
✓ Test risky bash patterns (rm -rf, sudo, curl, deploy)
✓ Test risky file patterns (.env, /etc/, secrets)
✓ Test empty command (returns isSafe: false)
✓ Test undefined command (returns isSafe: false)
✓ Test command with flags (git commit -m "msg")
✓ Test piped commands (git log | grep fix)
✓ Test case insensitivity (GIT COMMIT vs git commit)
✓ Test pattern priority (risky checked before safe)
✓ Test no-keyword prompts (works without "allow" keyword)
✓ Test custom prompt variations (different permission texts)
```

#### Test monitorAgentBlockers()
```
✓ Test detection of new BLOCKED state
✓ Test no-op if agent already blocked (deduplication)
✓ Test blocker cleared when agent unblocks
✓ Test lastCmd is captured correctly
✓ Test auto-approval fires for safe operations
✓ Test auto-approval does NOT fire for risky operations
✓ Test logging contains required info
```

### Phase 2: Integration Tests (simulate real blockers)

#### Setup
- Create test agent that deliberately hits permission prompts
- Mock orch-send to capture approval attempts
- Monitor logs for auto-approval/denial decisions

#### Test Scenarios
```
Scenario 1: Safe Bash Operation
  - Agent hits blocker: "Allow 'git commit'?"
  - Expected: Auto-approved, logs [auto-approval-approved]
  - Verify: Agent receives approval, continues

Scenario 2: Risky Bash Operation
  - Agent hits blocker: "Allow 'rm -rf /path'?"
  - Expected: Denied, logs [auto-approval-denied]
  - Verify: Agent sees denial, requires manual approval

Scenario 3: Unknown Operation
  - Agent hits blocker: "Allow custom-script.sh?"
  - Expected: Denied (conservative), logs [auto-approval-unknown]
  - Verify: User must approve manually

Scenario 4: Piped Command
  - Agent hits blocker: "Allow 'git log | grep fix'?"
  - Expected: Auto-approved (git log is safe)
  - Verify: Blocker shows command contains "git log"

Scenario 5: Command with Flags
  - Agent hits blocker: "Allow 'npm install --save-dev package'?"
  - Expected: Auto-approved (npm install is safe)
  - Verify: Pattern matching handles flags

Scenario 6: Sequential Blockers
  - Agent hits: 1) git add, 2) git commit, 3) git push
  - Expected: All auto-approved in sequence
  - Verify: Logs show all three approvals

Scenario 7: Mixed Operations
  - Agent hits: 1) git add (safe), 2) curl command (risky), 3) npm install (safe)
  - Expected: Auto-approve #1 and #3, deny #2
  - Verify: Correct handling of mixed safe/risky
```

### Phase 3: Regression Testing

```
✓ Existing agents still work (no false denials)
✓ compile-master-prompt-windows-port runs unblocked
✓ Logging is readable and not too verbose
✓ No memory leaks (check map sizes over time)
✓ No false positives (risky ops slip through as safe)
```

### Phase 4: Performance Testing

```
✓ Listener loop runs every 5 seconds without lag
✓ Auto-approval latency < 100ms
✓ Logging doesn't cause memory issues
✓ No CPU spikes from continuous monitoring
```

---

## 3. Documentation Updates

### Update Files

#### docs/ORCHESTRATOR_PROMPT.md
- Section 22 (Active Alerting to Master-Orchestrator): Update to mention auto-approval system
- Add new section: "Auto-Approval Behavior"
  - Explain safe vs risky operation classification
  - List all safe patterns (bash, file write)
  - List all risky patterns
  - Explain logging format
  - Explain how to add new safe patterns

#### orchestrator.config.json
- Add comments explaining each pattern section
- Add safety notes (what makes an operation risky)
- Add instructions for extending the whitelist
- Document the monitoring interval and timeouts

#### docs/AUTO_APPROVAL_SYSTEM.md (NEW FILE)
- Complete guide to auto-approval:
  - How it works (listener → eligibility check → auto-send)
  - Architecture (where each piece lives)
  - Configuration (how to update whitelist)
  - Troubleshooting (how to read logs, debug issues)
  - Adding new patterns (step-by-step guide)

#### src/insights.ts comments
- Add JSDoc to checkAutoApprovalEligibility()
- Add comments explaining the three-phase check (risky first, then safe, then unknown)
- Document the logging format

---

## 4. Monitoring & Alerting

### Logging Strategy

#### Log Levels
```
[listener-running]         # Info: monitoring started, agent count
[listener-checking]        # Debug: agent name, last command (on blocker)
[auto-approval-check]      # Debug: prompt and command being evaluated
[auto-approval-approved]   # Info: safe pattern matched, which one
[auto-approval-denied]     # Warn: risky pattern matched, which one
[auto-approval-unknown]    # Warn: blocker for unknown operation
[auto-approved]            # Info: approval sent via orch-send
[auto-approval-failed]     # Error: orch-send failed for some reason
```

### Metrics to Track

1. **Auto-Approval Rates**
   - Operations approved per minute
   - Operations denied per minute
   - Operations requiring user intervention

2. **Pattern Matching**
   - Count of each matched pattern (to detect usage patterns)
   - Unmatched operations (to identify edge cases)

3. **Performance**
   - Listener loop execution time
   - Auto-approval latency (blocker detected → approval sent)
   - Orch-send command success rate

4. **Alerts**
   - Alert if approval rate is zero for > 30 minutes (possible silencing bug)
   - Alert if orch-send success rate drops below 95%
   - Alert if listener stops running

### Implementation

#### Add to src/insights.ts
```typescript
// Metrics tracking
const metrics = {
  approvalsThisMinute: 0,
  denialThisMinute: 0,
  unknownThisMinute: 0,
  orchSendFailures: 0,
  lastMetricsReset: Date.now(),
};

// Every minute, log metrics and reset
setInterval(() => {
  console.log(`[metrics] approved: ${metrics.approvalsThisMinute}, denied: ${metrics.denialThisMinute}, unknown: ${metrics.unknownThisMinute}`);
  // Alert if approved count is zero for last 3 minutes
  metrics.approvalsThisMinute = 0;
  metrics.denialThisMinute = 0;
  metrics.unknownThisMinute = 0;
}, 60000);
```

#### Add to orchestrator's system prompt
```
When operations are being auto-approved frequently (>5 per minute), log:
"Auto-approval system is active and functioning. Run `orch-read orchestrator 1 | grep auto-approval` to see recent decisions."
```

---

## 5. Implementation Order

### Phase 1: Write Tests (1-2 hours)
1. Create src/insights.test.ts with unit tests
2. Add mock fixtures for different blocker formats
3. Write integration test helper that simulates blockers

### Phase 2: Fix Edge Cases (2-3 hours)
1. Add blocker timeout logic (clear stale blockers after 5+ minutes)
2. Add rate limiting (max 10 approvals per minute before escalating)
3. Improve prompt matching to handle variations
4. Add env var handling for commands
5. Add blocker cleanup on agent termination

### Phase 3: Add Monitoring (1-2 hours)
1. Add metrics tracking to src/insights.ts
2. Add logging for all metrics
3. Add alerts for failure modes
4. Document log format

### Phase 4: Documentation (1 hour)
1. Update ORCHESTRATOR_PROMPT.md
2. Create AUTO_APPROVAL_SYSTEM.md
3. Add comments to src/insights.ts
4. Update orchestrator.config.json with comments

### Phase 5: Testing & Validation (2-3 hours)
1. Run unit tests
2. Run integration tests with simulated blockers
3. Deploy and monitor for 1 hour
4. Verify compile-master-prompt-windows-port runs unblocked
5. Check for any false denials

---

## 6. Success Criteria

✅ All tests pass (unit + integration)
✅ No false denials for safe operations
✅ No false approvals for risky operations
✅ Auto-approval latency < 500ms
✅ Listener loop runs continuously without errors
✅ Logging provides visibility into all decisions
✅ Documentation is complete and clear
✅ compile-master-prompt-windows-port runs for 10+ minutes without permission prompts
✅ Metrics show expected approval/denial rates

---

## 7. Rollback Plan

If auto-approval breaks:
1. Set `autoApproval.enabled: false` in orchestrator.config.json
2. Commit and push
3. Alert user: "Auto-approval disabled due to issue"
4. Investigate logs
5. Fix in new branch
6. Re-enable only after testing passes

---

## Approval Required
- [ ] Approve test plan
- [ ] Approve edge case fixes
- [ ] Approve monitoring strategy
- [ ] Proceed to implementation?
