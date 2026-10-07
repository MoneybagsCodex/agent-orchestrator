# Error Recovery System Design

## Overview

The Error Recovery layer sits between the orchestrator and agents, providing intelligent error classification, automatic retry with exponential backoff, circuit breaker patterns, and recovery actions. This replaces ad-hoc error handling with a systematic approach to transient failures, permanent errors, and agent-specific issues.

**Goal:** Maximize uptime and resilience by automatically recovering from transient errors while escalating permanent failures to the user with actionable context.

## Architecture

### System Components

```
Agent/API Call
      ↓
Error Captured
      ↓
categorizeError() → ErrorCategory (TRANSIENT, PERMANENT, AGENT_SPECIFIC, SYSTEM, USER)
      ↓
getRecoveryStrategy() → RetryPolicy + Recovery Actions
      ↓
CircuitBreaker.canRetry() → Check open/closed state
      ↓
calculateBackoff() → ms = base * (multiplier ^ attempt) + jitter
      ↓
execute retry or invoke recovery actions
      ↓
Track metrics (success rate, retry exhaustion, recovery outcome)
      ↓
Notify user/escalate if unrecoverable
```

### Integration Points

| Component | File | Role |
|-----------|------|------|
| **Error Categorization** | `src/error-recovery.ts` | Classify error types based on message, code, source |
| **Retry & Backoff** | `src/error-recovery.ts` | Exponential backoff with jitter, per-error-type policies |
| **Circuit Breaker** | `src/error-recovery.ts` | Track failure rates per agent/endpoint, open when threshold exceeded |
| **Recovery Actions** | `src/error-recovery.ts` | Execute rollback, fallback, cleanup, escalation |
| **Metrics Collection** | `src/insights.ts` | Track error rates, retry success, circuit breaker trips, recovery outcomes |
| **Configuration** | `orchestrator.config.json` | Error policies, retry limits, circuit breaker thresholds, budgets |
| **Host Integration** | `src/host.ts` | Wrap Claude API calls, handle process errors, manage message delivery |
| **Server Integration** | `src/server.ts` | HTTP error responses, task failure handling, worker state recovery |

---

## Error Categorization Schema

### ErrorCategory Enum

```typescript
enum ErrorCategory {
  TRANSIENT = 'transient',           // Network blip, rate limit, timeout → retry
  PERMANENT = 'permanent',           // Permission denied, file not found, syntax error → escalate
  AGENT_SPECIFIC = 'agent-specific', // Tool not available, wrong context → fallback
  SYSTEM = 'system',                 // Orchestrator overload, disk full → degrade gracefully
  USER = 'user',                     // Invalid input, ambiguous instruction → ask user
}
```

### ErrorRecord Interface

```typescript
interface ErrorRecord {
  id: string;                        // Unique error instance ID (UUID)
  category: ErrorCategory;
  code?: string;                     // Error code if available (e.g., "ECONNREFUSED", "429")
  message: string;                   // Error message (first 500 chars)
  source: string;                    // Where error originated (Claude API, file system, shell, etc.)
  context?: {
    agentId?: string;                // Agent SID if agent-related
    operationName?: string;          // What was being attempted
    commandLine?: string;            // For CLI/bash errors (scrubbed of secrets)
    filePath?: string;               // For file operation errors
    statusCode?: number;             // HTTP status if applicable
    retryable: boolean;              // Manual override if auto-categorization wrong
  };
  firstSeenAt: number;               // Unix timestamp
  lastSeenAt: number;
  occurrenceCount: number;           // How many times this error has occurred
  recoverable: boolean;              // Can this error be recovered from?
  suggestedAction: string;           // Recommended recovery action (rollback, fallback, escalate, etc.)
}
```

### Error Classification Rules

#### TRANSIENT Errors (Auto-Retry)
- **Conditions**: Errors that are likely temporary
- **Triggers**:
  - HTTP status 429 (rate limit)
  - HTTP status 502, 503, 504 (service unavailable)
  - Network timeouts (`ETIMEDOUT`, `EHOSTUNREACH`, `ECONNREFUSED`)
  - Claude API temporary errors (error.status === 'temporarily_unavailable')
  - Agent process temporarily unavailable
- **Recovery**: Retry with exponential backoff
- **Example**: "Connection refused (ECONNREFUSED). Service may restart shortly."

#### PERMANENT Errors (Escalate)
- **Conditions**: Errors that will not resolve with retries
- **Triggers**:
  - HTTP status 400, 401, 403, 404 (client error)
  - File not found (`ENOENT`)
  - Permission denied (`EACCES`, `EPERM`)
  - Syntax errors in code
  - Claude model error (invalid parameter)
  - Disk full (`ENOSPC`)
- **Recovery**: Rollback, escalate to user with context
- **Example**: "File /path/to/file not found. The path may be incorrect or the file was deleted."

#### AGENT_SPECIFIC Errors (Fallback)
- **Conditions**: Errors specific to how an agent is configured or running
- **Triggers**:
  - Tool not available for this agent
  - Agent context missing or corrupted
  - Agent in unexpected state (not responding)
  - Message delivery failed (agent refused)
- **Recovery**: Fallback to manual intervention, try different agent, escalate
- **Example**: "Agent could not reach agent-2. Fallback: try agent-3 or handle manually."

#### SYSTEM Errors (Graceful Degradation)
- **Conditions**: Errors in orchestrator infrastructure
- **Triggers**:
  - Orchestrator context token budget exceeded
  - Metrics system overload
  - Database/state file corruption
  - Child process crashed unexpectedly
- **Recovery**: Degrade gracefully, notify user, auto-recover if possible
- **Example**: "Orchestrator context reached limit. Auto-compacting to continue."

#### USER Errors (Ask User)
- **Conditions**: Errors requiring clarification or decision from user
- **Triggers**:
  - Ambiguous instruction (multiple agents match)
  - Missing required parameter
  - Conflicting instructions
  - User needs to make a choice
- **Recovery**: Present options, ask user to clarify
- **Example**: "Which agent did you mean: 'compile-ui' or 'compile-backend'?"

---

## Retry Strategy Configuration

### RetryPolicy Interface

```typescript
interface RetryPolicy {
  maxRetries: number;               // Max attempts (total = 1 + maxRetries)
  backoffMs: number;                // Base backoff in milliseconds
  backoffMultiplier: number;        // Exponential multiplier (typically 2)
  jitterFactor: number;             // Random jitter (0 = none, 0.5 = ±50% variance)
  maxBackoffMs: number;             // Cap on backoff time
  timeoutMs: number;                // Timeout for each attempt
}
```

### Per-Error-Type Policies

```json
{
  "errorRecovery": {
    "retryPolicies": {
      "TRANSIENT": {
        "maxRetries": 4,
        "backoffMs": 500,
        "backoffMultiplier": 2,
        "jitterFactor": 0.3,
        "maxBackoffMs": 32000,
        "timeoutMs": 30000,
        "description": "Fast retries for network glitches, API timeouts"
      },
      "AGENT_SPECIFIC": {
        "maxRetries": 2,
        "backoffMs": 1000,
        "backoffMultiplier": 1.5,
        "jitterFactor": 0.2,
        "maxBackoffMs": 10000,
        "timeoutMs": 15000,
        "description": "Slower retries for agent-specific issues (may need state changes)"
      },
      "SYSTEM": {
        "maxRetries": 1,
        "backoffMs": 2000,
        "backoffMultiplier": 1,
        "jitterFactor": 0,
        "maxBackoffMs": 2000,
        "timeoutMs": 60000,
        "description": "Single retry for system errors (often need manual intervention)"
      }
    },
    "circuitBreaker": {
      "failureThreshold": 5,
      "failureWindow": 60000,
      "recoveryTimeout": 30000,
      "description": "Open after 5 failures in 60s window; retry after 30s cooldown"
    }
  }
}
```

### Backoff Calculation

```typescript
function calculateBackoff(attempt: number, policy: RetryPolicy): number {
  // Exponential backoff: base * (multiplier ^ attempt) + jitter
  const exponential = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt);
  const capped = Math.min(exponential, policy.maxBackoffMs);
  
  // Add jitter to prevent thundering herd
  const jitter = capped * policy.jitterFactor * (Math.random() - 0.5) * 2;
  
  return Math.max(0, Math.round(capped + jitter));
}
```

**Examples** (TRANSIENT policy with jitter ≈ ±50%):
- Attempt 1: 500ms ± 250ms
- Attempt 2: 1000ms ± 500ms
- Attempt 3: 2000ms ± 1000ms
- Attempt 4: 4000ms ± 2000ms

---

## Circuit Breaker Pattern

### CircuitBreaker Class

```typescript
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures: number = 0;
  private lastFailureAt: number = 0;
  private lastRecoveryAt: number = 0;
  
  canRetry(policy: CircuitBreakerPolicy): boolean {
    const now = Date.now();
    
    if (this.state === 'closed') {
      // Track failures in a sliding window
      if (now - this.lastFailureAt > policy.failureWindow) {
        this.failures = 0;
      }
      return this.failures < policy.failureThreshold;
    }
    
    if (this.state === 'open') {
      // Allow recovery after timeout
      if (now - this.lastRecoveryAt > policy.recoveryTimeout) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    
    // half-open: retry once to check if service recovered
    return true;
  }
  
  recordSuccess(): void {
    this.state = 'closed';
    this.failures = 0;
  }
  
  recordFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.policy.failureThreshold) {
      this.state = 'open';
      this.lastRecoveryAt = Date.now();
    }
  }
}
```

**States**:
- **Closed**: Normal operation, failures tracked in sliding window
- **Open**: Too many failures → reject calls immediately (fast-fail)
- **Half-Open**: After recovery timeout → allow one test call to see if service recovered

---

## Recovery Actions

### Recovery Action Types

```typescript
type RecoveryAction = 
  | 'retry'                     // Retry with backoff
  | 'fallback'                  // Try alternative approach
  | 'rollback'                  // Undo failed operation
  | 'cleanup'                   // Clean up partial state
  | 'escalate'                  // Ask user to decide
  | 'degraded'                  // Continue with reduced functionality
  | 'notify';                   // Alert user but continue
```

### Recovery Strategy Matrix

| Error Category | Example | Primary Action | Secondary | Tertiary |
|---|---|---|---|---|
| **TRANSIENT** | Rate limit (429) | retry | escalate if exhausted | notify user |
| **TRANSIENT** | Connection timeout | retry | circuit breaker | escalate |
| **PERMANENT** | File not found | escalate | notify user | cleanup |
| **PERMANENT** | Permission denied | escalate | ask user to fix | stop agent |
| **AGENT_SPECIFIC** | Tool unavailable | fallback | try agent-2 | escalate |
| **AGENT_SPECIFIC** | Agent not responding | fallback | notify user | escalate |
| **SYSTEM** | Context limit exceeded | degraded | auto-compact | notify user |
| **SYSTEM** | Disk full | degraded | cleanup logs | escalate |
| **USER** | Ambiguous input | escalate | ask for clarification | — |

### Recovery Action Handlers

#### 1. Retry with Backoff
```typescript
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  categorize: (error: any) => ErrorCategory
): Promise<T> {
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (categorize(error) !== ErrorCategory.TRANSIENT || attempt === policy.maxRetries) {
        throw error;
      }
      const backoffMs = calculateBackoff(attempt, policy);
      console.log(`[retry] attempt ${attempt + 1}/${policy.maxRetries + 1}, waiting ${backoffMs}ms`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}
```

#### 2. Fallback to Alternative
```typescript
async function fallbackToAlternative(
  primaryAgent: string,
  fallbackAgent: string,
  operation: (agentId: string) => Promise<any>
): Promise<any> {
  try {
    return await operation(primaryAgent);
  } catch (error) {
    console.log(`[fallback] ${primaryAgent} failed, trying ${fallbackAgent}`);
    return await operation(fallbackAgent);
  }
}
```

#### 3. Rollback Operation
```typescript
async function rollbackOperation(
  operationId: string,
  getRollbackOp: () => Promise<() => Promise<void>>
): Promise<void> {
  try {
    const undo = await getRollbackOp();
    await undo();
    console.log(`[rollback] operation ${operationId} rolled back`);
  } catch (error) {
    console.error(`[rollback-failed] ${operationId}: ${error.message}`);
    // Log rollback failure as critical; may need manual intervention
  }
}
```

#### 4. Graceful Degradation
```typescript
async function degradeGracefully(
  feature: string,
  fullOperation: () => Promise<any>,
  degradedOperation: () => Promise<any>
): Promise<any> {
  try {
    return await fullOperation();
  } catch (error) {
    console.log(`[degradation] ${feature} full mode failed, using degraded mode`);
    return await degradedOperation();
  }
}
```

#### 5. Escalate to User
```typescript
async function escalateToUser(
  error: ErrorRecord,
  options?: { defaultAction?: string }
): Promise<void> {
  const message = formatErrorForUser(error);
  host.notify({
    level: 'warn',
    title: `${error.source} Error`,
    text: message,
  });
  console.log(`[escalate] ${error.id}: ${error.message}`);
}
```

---

## Monitoring & Observability

### Error Metrics to Track

```typescript
interface ErrorMetrics {
  errorsByCategory: Record<ErrorCategory, number>;      // Count per minute
  retrySuccessRate: Map<ErrorCategory, number>;         // % that succeed after retry
  circuitBreakerTrips: Map<string, number>;             // Count per agent/endpoint
  recoveryActions: Map<RecoveryAction, number>;         // Which actions were taken
  errorTimeseries: ErrorRecord[];                        // Recent errors (last 1000)
  systemHealth: {
    transientErrorRate: number;                         // Per minute
    permanentErrorRate: number;
    retryExhaustionRate: number;
  };
}
```

### Health Alerts

```typescript
function generateHealthAlerts(metrics: ErrorMetrics): string[] {
  const alerts: string[] = [];
  
  // Alert 1: High error rate
  if (metrics.systemHealth.transientErrorRate > 50) {
    alerts.push('⚠️ High transient error rate (>50/min). Check network or API status.');
  }
  
  // Alert 2: Circuit breaker open
  for (const [key, trips] of metrics.circuitBreakerTrips) {
    if (trips > 3) {
      alerts.push(`⚠️ Circuit breaker for ${key} has tripped ${trips} times. Service may be down.`);
    }
  }
  
  // Alert 3: Retry exhaustion
  if (metrics.retryExhaustionRate > 0.1) {
    alerts.push('⚠️ Retries exhausted on >10% of transient errors. May need manual intervention.');
  }
  
  // Alert 4: Recovery action failure
  if (metrics.recoveryActions.get('rollback-failed') ?? 0 > 0) {
    alerts.push('🚨 Rollback failed on one or more operations. Check state consistency.');
  }
  
  return alerts;
}
```

### Metrics Endpoints

```typescript
GET /metrics/errors
  Returns: {
    errorsByCategory: {...},
    retrySuccessRate: {...},
    circuitBreakerStatus: [{agent, state, failures, lastTrip}],
    recoveryActions: {...},
    recentErrors: [...]
  }

GET /metrics/errors/trends
  Returns: Time-series data for last 1 hour (minute-by-minute error rates)

GET /metrics/errors/{id}
  Returns: Full ErrorRecord with retry history and recovery actions
```

---

## Configuration Schema

### orchestrator.config.json Addition

```json
{
  "errorRecovery": {
    "enabled": true,
    "categorization": {
      "transientTimeoutMs": 30000,
      "description": "Errors without response in 30s are considered transient (network issue)"
    },
    "retryPolicies": {
      "TRANSIENT": {
        "maxRetries": 4,
        "backoffMs": 500,
        "backoffMultiplier": 2,
        "jitterFactor": 0.3,
        "maxBackoffMs": 32000,
        "timeoutMs": 30000
      },
      "AGENT_SPECIFIC": {
        "maxRetries": 2,
        "backoffMs": 1000,
        "backoffMultiplier": 1.5,
        "jitterFactor": 0.2,
        "maxBackoffMs": 10000,
        "timeoutMs": 15000
      },
      "SYSTEM": {
        "maxRetries": 1,
        "backoffMs": 2000,
        "backoffMultiplier": 1,
        "jitterFactor": 0,
        "maxBackoffMs": 2000,
        "timeoutMs": 60000
      }
    },
    "circuitBreaker": {
      "enabled": true,
      "failureThreshold": 5,
      "failureWindow": 60000,
      "recoveryTimeout": 30000,
      "description": "Open after 5 failures in 60s window; try recovery after 30s"
    },
    "budgets": {
      "maxErrorsPerMinute": 100,
      "maxRetriesPerHour": 1000,
      "description": "If exceeded, enable degraded mode"
    },
    "recovery": {
      "rollbackTimeout": 10000,
      "description": "Rollback must complete within 10s or abort"
    }
  }
}
```

---

## Integration with Existing Systems

### 1. Host Integration (src/host.ts)

Wrap Claude API calls:
```typescript
// Before
p.stdin!.write(JSON.stringify({ type: 'user', message: {...} }) + '\n');

// After
const result = await retryWithBackoff(
  () => sendToModel(message),
  getRetryPolicy(errorCategory),
  categorizeError
);
```

Capture stderr errors:
```typescript
// Before
p.stderr!.on('data', (d) => console.error('[host stderr]', d));

// After
p.stderr!.on('data', (d) => {
  const error = parseStderrError(d);
  recordError(error);
  notifyIfCritical(error);
});
```

### 2. Server Integration (src/server.ts)

Wrap API endpoints:
```typescript
app.get('/status', async (_req, res) => {
  try {
    const status = await withErrorRecovery(
      () => buildStatus(),
      { fallback: getCachedStatus }
    );
    res.json(status);
  } catch (e) {
    // Categorize, escalate, use degraded fallback
    res.status(503).json({ error: e.message });
  }
});
```

### 3. Insights Integration (src/insights.ts)

Track error metrics:
```typescript
function recordErrorMetric(error: ErrorRecord): void {
  const category = error.category;
  errorMetrics.errorsByCategory[category]++;
  
  if (error.recoverable) {
    // Track recovery success
  }
  
  if (Date.now() - errorMetrics.lastMetricsReset > 60000) {
    // Log and reset
  }
}
```

---

## Success Criteria

- ✅ Error categorization works for all error types
- ✅ Retry backoff correct (exponential with jitter, respects max)
- ✅ Circuit breaker prevents cascading failures
- ✅ Recovery actions execute and are logged
- ✅ Metrics accessible via API and logged to console
- ✅ No silent error swallowing (all errors logged)
- ✅ Configuration reloadable without restart
- ✅ TypeScript: Zero type errors
- ✅ Tests: 100+ unit tests covering all categories and policies

---

## Next Steps (Phase 2-3)

1. **Phase 2**: Implement error categorization + unit tests
2. **Phase 3**: Implement retry + backoff + circuit breaker
3. **Phase 4**: Implement recovery actions
4. **Phase 5**: Add metrics and monitoring
5. **Phase 6**: Integration tests + documentation
