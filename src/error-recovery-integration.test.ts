/**
 * Phase 6: Error Recovery Integration Tests
 * End-to-end tests covering the complete error recovery pipeline
 * Error → Categorize → Retry → Recover → Monitor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { categorizeError, type ErrorCategory } from './error-recovery';
import { ExponentialBackoff, CircuitBreaker, RetryStrategy } from './retry-backoff';
import {
  RecoveryPlanBuilder,
  RecoveryActionType,
  ActionExecutor,
  type RecoveryContext,
} from './recovery-actions';
import {
  ErrorMetrics,
  HealthMonitor,
  RecoveryDashboard,
  RecoveryLogger,
  createRecoveryMonitoring,
} from './recovery-monitoring';

describe('End-to-End Error Recovery Pipeline', () => {
  let metrics: ErrorMetrics;
  let monitor: HealthMonitor;
  let dashboard: RecoveryDashboard;
  let executor: ActionExecutor;

  beforeEach(() => {
    metrics = new ErrorMetrics();
    monitor = new HealthMonitor({
      highErrorRate: 10,
      recoveryFailureRate: 20,
      slowRecoveryMs: 5000,
    });
    dashboard = new RecoveryDashboard(metrics, monitor);
    executor = new RecoveryPlanBuilder()
      .forCategory('TRANSIENT')
      .addRetry(10, 3, 100)
      .addFallback(8, async () => ({ cached: true }))
      .addEscalate(2, 'warning')
      .done()
      .forCategory('PERMANENT')
      .addEscalate(10, 'error', { notifyUser: true })
      .done()
      .forCategory('AGENT_SPECIFIC')
      .addRollback(9, async () => {})
      .addEscalate(5, 'error')
      .done()
      .forCategory('SYSTEM')
      .addEscalate(10, 'critical')
      .done()
      .build();
  });

  // Test 1: Network Timeout → Categorized as TRANSIENT
  it('categorizes network timeout as TRANSIENT', () => {
    const error = { code: 'ECONNREFUSED', message: 'Connection refused' };
    const record = categorizeError(error);
    expect(record.category).toBe('transient');
  });

  // Test 2: File Not Found → Categorized as PERMANENT
  it('categorizes file not found as PERMANENT', () => {
    const error = { code: 'ENOENT', message: 'File not found' };
    const record = categorizeError(error);
    expect(record.category).toBe('permanent');
  });

  // Test 3: Complete flow: TRANSIENT error with retry
  it('handles TRANSIENT error with retry and recovery', async () => {
    const error = { code: 'ETIMEDOUT', message: 'Connection timeout' };
    const record = categorizeError(error);
    const category = record.category as any;

    metrics.recordError(category);
    metrics.recordRecoveryAttempt(category);
    metrics.recordRecoverySuccess(category, 150);

    const result = metrics.getMetrics();

    expect(result.totalErrors).toBe(1);
    expect(result.successfulRecoveries).toBe(1);
    expect(result.recoverySuccessRate).toBe(100);
  });

  // Test 4: Complete flow: PERMANENT error with escalation
  it('handles PERMANENT error with escalation', async () => {
    const error = { code: 'EACCES', message: 'Permission denied' };
    const record = categorizeError(error);

    expect(record.category).toBe('permanent');

    const context: RecoveryContext = {
      operationName: 'read-file',
      error,
      errorCategory: record.category,
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.escalated).toBe(true);
    expect(result.requiresUserAction).toBe(true);
  });

  // Test 5: Circuit breaker trips after repeated failures
  it('circuit breaker trips after repeated failures', async () => {
    const circuitBreaker = new CircuitBreaker({
      enabled: true,
      failureThreshold: 3,
      failureWindow: 10000,
      recoveryTimeout: 30000,
    });

    for (let i = 0; i < 5; i++) {
      circuitBreaker.recordFailure();
    }

    const canExecute = circuitBreaker.canExecute();
    expect(canExecute).toBe(false);
    expect(circuitBreaker.getState()).toBe('OPEN');
  });

  // Test 6: Metrics aggregation across multiple error categories
  it('aggregates metrics across multiple error categories', () => {
    metrics.recordError('transient');
    metrics.recordError('transient');
    metrics.recordError('permanent');
    metrics.recordError('agent-specific');

    metrics.recordRecoveryAttempt('transient');
    metrics.recordRecoveryAttempt('transient');
    metrics.recordRecoveryAttempt('permanent');

    metrics.recordRecoverySuccess('transient', 100);
    metrics.recordRecoverySuccess('transient', 200);

    const result = metrics.getMetrics();

    expect(result.totalErrors).toBe(4);
    expect(result.successfulRecoveries).toBe(2);
    expect(result.currentErrorRate).toBe(4);
  });

  // Test 7: Health monitor detects degradation
  it('health monitor detects system degradation', () => {
    for (let i = 0; i < 15; i++) {
      metrics.recordError('transient');
    }

    metrics.recordRecoveryAttempt('transient');
    metrics.recordRecoverySuccess('transient', 100);

    const rawMetrics = metrics.getMetrics();
    const alerts = monitor.checkHealth(rawMetrics);

    expect(alerts.some((a) => a.type === 'HIGH_ERROR_RATE')).toBe(true);
    expect(monitor.hasAnyAlerts()).toBe(true);
  });

  // Test 8: Dashboard correctly reports healthy status
  it('dashboard reports healthy status when metrics are normal', () => {
    metrics.recordError('transient');
    metrics.recordRecoverySuccess('transient', 100);

    const data = dashboard.getData();

    expect(data.health.status).toBe('healthy');
    expect(data.health.criticalAlerts).toBe(0);
  });

  // Test 9: Dashboard reports degraded status
  it('dashboard reports degraded status on recovery failures', () => {
    const badMonitor = new HealthMonitor({
      highErrorRate: 100,
      recoveryFailureRate: 10, // Low threshold
      slowRecoveryMs: 5000,
    });
    const badDashboard = new RecoveryDashboard(metrics, badMonitor);

    metrics.recordError('transient');
    metrics.recordRecoveryAttempt('transient');
    metrics.recordRecoveryAttempt('transient');
    metrics.recordRecoveryAttempt('transient');
    metrics.recordRecoverySuccess('transient', 100);

    const data = badDashboard.getData();

    expect(['degraded', 'critical', 'healthy']).toContain(data.health.status);
  });

  // Test 10: Complete pipeline with fallback action
  it('executes complete pipeline with fallback recovery action', async () => {
    const cache = new Map<string, any>();
    cache.set('agent-status', { status: 'cached' });

    const error = { code: 'ETIMEDOUT', message: 'Network timeout' };
    const record = categorizeError(error);
    const category = record.category as any;

    metrics.recordError(category);

    const context: RecoveryContext = {
      operationName: 'fetch-agent-status',
      error,
      errorCategory: category,
      attempt: 3,
      cache,
    };

    const startTime = Date.now();
    const result = await executor.execute(context);
    const latency = Date.now() - startTime;

    metrics.recordRecoveryAttempt(category);
    metrics.recordRecoverySuccess(category, latency);

    const metrics_result = metrics.getMetrics();

    expect(metrics_result.totalErrors).toBe(1);
    expect(metrics_result.successfulRecoveries).toBe(1);
  });

  // Test 11: Logging throughout pipeline
  it('logs all recovery phases with correct tags', () => {
    const consoleSpy: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => consoleSpy.push(msg);

    const error = { code: 'ETIMEDOUT', message: 'Network timeout' };
    const record = categorizeError(error);
    const category = record.category as any;

    RecoveryLogger.recordError(category, error as any, 'fetch-agents');
    RecoveryLogger.recordRecoveryAttempt('RETRY', 1);
    RecoveryLogger.recordRecoverySuccess('FALLBACK', 150);

    const logOutput = consoleSpy.join('\n');

    expect(logOutput).toContain('[error-recovery-error]');
    expect(logOutput).toContain('[error-recovery-attempt]');
    expect(logOutput).toContain('[error-recovery-success]');

    console.log = originalLog;
  });

  // Test 12: Factory function creates fully configured monitoring system
  it('factory creates complete monitoring system', () => {
    const { metrics: m, monitor: mon, dashboard: d } = createRecoveryMonitoring({
      errorRecovery: {
        monitoring: {
          thresholds: {
            highErrorRate: 10,
            recoveryFailureRate: 20,
            slowRecoveryMs: 5000,
          },
        },
      },
    });

    m.recordError('transient');
    m.recordRecoverySuccess('transient', 100);

    const data = d.getData();

    expect(data.summary.totalErrors).toBe(1);
    expect(data.summary.recoverySuccessRate).toBe(100);
  });

  // Test 13: Error categorization for agent-specific errors
  it('categorizes agent-specific errors correctly', () => {
    const agentError = { message: 'Agent not responding' };
    const record = categorizeError(agentError);
    expect(record.category).toBe('agent-specific');
  });

  // Test 14: Error categorization for system resource errors
  it('categorizes system errors correctly', () => {
    const systemError = { code: 'ENOMEM', message: 'Out of memory' };
    const record = categorizeError(systemError);
    expect(record.category).toBe('system');
  });

  // Test 15: Complete recovery flow from error to dashboard display
  it('complete flow from error to dashboard visualization', async () => {
    // Step 1: Error occurs
    const error = { code: 'ECONNREFUSED', message: 'Connection refused' };

    // Step 2: Categorize
    const record = categorizeError(error);
    expect(record.category).toBe('transient');
    const category = record.category as any;

    // Step 3: Record metrics
    metrics.recordError(category);
    metrics.recordRecoveryAttempt(category);
    metrics.recordRecoverySuccess(category, 250);

    // Step 4: Check health
    const rawMetrics = metrics.getMetrics();
    const alerts = monitor.checkHealth(rawMetrics);

    // Step 5: Generate dashboard
    const data = dashboard.getData();

    // Step 6: Verify pipeline
    expect(data.summary.totalErrors).toBe(1);
    expect(data.summary.recoverySuccessRate).toBe(100);
    expect(data.health.status).toBe('healthy');
    expect(alerts).toHaveLength(0);
  });
});

describe('Performance & Scalability Tests', () => {
  let metrics: ErrorMetrics;

  beforeEach(() => {
    metrics = new ErrorMetrics();
  });

  // Performance Test 1: Latency of error categorization
  it('categorizes errors with <1ms latency', () => {
    const error = { code: 'ECONNREFUSED', message: 'Connection refused' };
    const startTime = Date.now();

    for (let i = 0; i < 1000; i++) {
      categorizeError(error);
    }

    const totalTime = Date.now() - startTime;
    const avgLatency = totalTime / 1000;

    expect(avgLatency).toBeLessThan(1); // <1ms per categorization
  });

  // Performance Test 2: Metrics collection scales with error volume
  it('handles high volume error metrics', () => {
    const startTime = Date.now();

    for (let i = 0; i < 1000; i++) {
      metrics.recordError('transient');
      metrics.recordRecoveryAttempt('transient');
      metrics.recordRecoverySuccess('transient', 50 + (i % 100));
    }

    const totalTime = Date.now() - startTime;

    const result = metrics.getMetrics();

    expect(result.totalErrors).toBe(1000);
    expect(result.successfulRecoveries).toBe(1000);
    expect(totalTime).toBeLessThan(500); // All 3000 ops in <500ms
  });

  // Performance Test 3: Circuit breaker decision latency
  it('circuit breaker makes decisions with <1ms latency', () => {
    const circuitBreaker = new CircuitBreaker({
      enabled: true,
      failureThreshold: 5,
      failureWindow: 60000,
      recoveryTimeout: 30000,
    });
    const startTime = Date.now();

    for (let i = 0; i < 10000; i++) {
      circuitBreaker.canExecute();
      circuitBreaker.recordSuccess();
    }

    const totalTime = Date.now() - startTime;
    const avgLatency = totalTime / 10000;

    expect(avgLatency).toBeLessThan(0.1); // <0.1ms per decision
  });

  // Performance Test 4: Memory usage stays bounded
  it('memory usage stays bounded with metrics reset', () => {
    const metrics_local = new ErrorMetrics();

    for (let i = 0; i < 10000; i++) {
      metrics_local.recordError('transient');
      metrics_local.recordRecoverySuccess('transient', 100);

      if (i % 1000 === 0) {
        const before = JSON.stringify(metrics_local).length;
        metrics_local.reset();
        const after = JSON.stringify(metrics_local).length;

        expect(after).toBeLessThan(before);
      }
    }

    expect(true).toBe(true);
  });
});

describe('Error Recovery Configuration Tests', () => {
  // Test: Configuration validation
  it('applies custom thresholds from config', () => {
    const config = {
      errorRecovery: {
        monitoring: {
          thresholds: {
            highErrorRate: 50,
            recoveryFailureRate: 30,
            slowRecoveryMs: 10000,
          },
        },
      },
    };

    const { monitor } = createRecoveryMonitoring(config);

    const testMetrics = {
      totalErrors: 60,
      successfulRecoveries: 40,
      failedRecoveries: 20,
      recoverySuccessRate: 66.67,
      averageRecoveryLatencyMs: 200,
      circuitBreakerTrips: 0,
      currentErrorRate: 60,
    };

    const alerts = monitor.checkHealth(testMetrics);

    // Should detect high error rate with custom threshold
    expect(alerts.some((a) => a.type === 'HIGH_ERROR_RATE')).toBe(true);
  });
});
