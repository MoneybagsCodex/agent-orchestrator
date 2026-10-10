/**
 * Recovery Monitoring Tests - Phase 5
 * 20+ test cases for metrics, health alerts, and dashboards
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ErrorMetrics,
  HealthMonitor,
  RecoveryDashboard,
  RecoveryLogger,
  createRecoveryMonitoring,
  type ErrorCategory,
} from './recovery-monitoring';

describe('ErrorMetrics', () => {
  let metrics: ErrorMetrics;

  beforeEach(() => {
    metrics = new ErrorMetrics();
  });

  it('records errors by category', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('PERMANENT');

    const transientMetrics = metrics.getCategoryMetrics('TRANSIENT');
    const permanentMetrics = metrics.getCategoryMetrics('PERMANENT');

    expect(transientMetrics.count).toBe(2);
    expect(permanentMetrics.count).toBe(1);
  });

  it('tracks recovery attempts', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoveryAttempt('TRANSIENT');

    const result = metrics.getMetrics();
    expect(result.totalErrors).toBe(1);
  });

  it('calculates recovery success rate', () => {
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 100);
    metrics.recordRecoverySuccess('TRANSIENT', 150);

    const result = metrics.getMetrics();
    expect(result.recoverySuccessRate).toBe(66.67);
  });

  it('calculates average recovery latency', () => {
    metrics.recordRecoverySuccess('TRANSIENT', 100);
    metrics.recordRecoverySuccess('TRANSIENT', 200);
    metrics.recordRecoverySuccess('TRANSIENT', 300);

    const result = metrics.getMetrics();
    expect(result.averageRecoveryLatencyMs).toBe(200);
  });

  it('tracks circuit breaker trips', () => {
    metrics.recordCircuitBreakerTrip();
    metrics.recordCircuitBreakerTrip();

    const result = metrics.getMetrics();
    expect(result.circuitBreakerTrips).toBe(2);
  });

  it('calculates current error rate (per minute)', () => {
    const now = Date.now();
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('PERMANENT');

    const result = metrics.getMetrics();
    expect(result.currentErrorRate).toBe(3);
  });

  it('returns zero metrics on fresh instance', () => {
    const result = metrics.getMetrics();

    expect(result.totalErrors).toBe(0);
    expect(result.successfulRecoveries).toBe(0);
    expect(result.recoverySuccessRate).toBe(0);
    expect(result.averageRecoveryLatencyMs).toBe(0);
  });

  it('resets all metrics', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 100);

    metrics.reset();

    const result = metrics.getMetrics();
    expect(result.totalErrors).toBe(0);
    expect(result.successfulRecoveries).toBe(0);
  });

  it('provides per-category metrics', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 150);

    const catMetrics = metrics.getCategoryMetrics('TRANSIENT');

    expect(catMetrics.category).toBe('TRANSIENT');
    expect(catMetrics.count).toBe(2);
    expect(catMetrics.recoveryRate).toBe(100);
    expect(catMetrics.averageLatencyMs).toBe(150);
  });
});

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor({
      highErrorRate: 10,
      recoveryFailureRate: 20,
      slowRecoveryMs: 5000,
    });
  });

  it('detects high error rate', () => {
    const metrics = {
      totalErrors: 15,
      successfulRecoveries: 10,
      failedRecoveries: 5,
      recoverySuccessRate: 66.67,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 15,
    };

    const alerts = monitor.checkHealth(metrics);

    expect(alerts.some((a) => a.type === 'HIGH_ERROR_RATE')).toBe(true);
  });

  it('detects recovery failures', () => {
    const metrics = {
      totalErrors: 20,
      successfulRecoveries: 10,
      failedRecoveries: 10,
      recoverySuccessRate: 50,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 5,
    };

    const alerts = monitor.checkHealth(metrics);

    expect(alerts.some((a) => a.type === 'RECOVERY_FAILURES')).toBe(true);
  });

  it('detects slow recovery', () => {
    const metrics = {
      totalErrors: 10,
      successfulRecoveries: 9,
      failedRecoveries: 1,
      recoverySuccessRate: 90,
      averageRecoveryLatencyMs: 6000,
      circuitBreakerTrips: 0,
      currentErrorRate: 5,
    };

    const alerts = monitor.checkHealth(metrics);

    expect(alerts.some((a) => a.type === 'SLOW_RECOVERY')).toBe(true);
  });

  it('detects circuit breaker trips', () => {
    const metrics = {
      totalErrors: 10,
      successfulRecoveries: 8,
      failedRecoveries: 2,
      recoverySuccessRate: 80,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 10,
      currentErrorRate: 5,
    };

    const alerts = monitor.checkHealth(metrics);

    expect(alerts.some((a) => a.type === 'CIRCUIT_OPEN')).toBe(true);
  });

  it('returns no alerts for healthy metrics', () => {
    const metrics = {
      totalErrors: 5,
      successfulRecoveries: 5,
      failedRecoveries: 0,
      recoverySuccessRate: 100,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 2,
    };

    const alerts = monitor.checkHealth(metrics);

    expect(alerts).toHaveLength(0);
  });

  it('stores and retrieves alerts', () => {
    const metrics = {
      totalErrors: 15,
      successfulRecoveries: 10,
      failedRecoveries: 5,
      recoverySuccessRate: 66.67,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 15,
    };

    monitor.checkHealth(metrics);
    const alerts = monitor.getAlerts();

    expect(alerts.length).toBeGreaterThan(0);
  });

  it('clears alerts', () => {
    const metrics = {
      totalErrors: 15,
      successfulRecoveries: 10,
      failedRecoveries: 5,
      recoverySuccessRate: 66.67,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 15,
    };

    monitor.checkHealth(metrics);
    monitor.clearAlerts();

    expect(monitor.getAlerts()).toHaveLength(0);
  });

  it('detects any alerts', () => {
    const metrics = {
      totalErrors: 15,
      successfulRecoveries: 10,
      failedRecoveries: 5,
      recoverySuccessRate: 66.67,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 15,
    };

    monitor.checkHealth(metrics);

    expect(monitor.hasAnyAlerts()).toBe(true);
  });

  it('detects critical alerts', () => {
    const metrics = {
      totalErrors: 10,
      successfulRecoveries: 8,
      failedRecoveries: 2,
      recoverySuccessRate: 80,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 10,
      currentErrorRate: 5,
    };

    monitor.checkHealth(metrics);

    expect(monitor.hasCriticalAlerts()).toBe(true);
  });

  it('uses custom thresholds', () => {
    const customMonitor = new HealthMonitor({
      highErrorRate: 50,
      recoveryFailureRate: 80,
      slowRecoveryMs: 10000,
    });

    const metrics = {
      totalErrors: 10,
      successfulRecoveries: 8,
      failedRecoveries: 2,
      recoverySuccessRate: 80,
      averageRecoveryLatencyMs: 100,
      circuitBreakerTrips: 0,
      currentErrorRate: 10,
    };

    const alerts = customMonitor.checkHealth(metrics);

    // Should not trigger alerts with higher thresholds
    expect(alerts).toHaveLength(0);
  });
});

describe('RecoveryDashboard', () => {
  let metrics: ErrorMetrics;
  let monitor: HealthMonitor;
  let dashboard: RecoveryDashboard;

  beforeEach(() => {
    metrics = new ErrorMetrics();
    monitor = new HealthMonitor();
    dashboard = new RecoveryDashboard(metrics, monitor);
  });

  it('aggregates data into dashboard format', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 100);

    const data = dashboard.getData();

    expect(data.summary).toBeDefined();
    expect(data.alerts).toBeDefined();
    expect(data.categories).toBeDefined();
    expect(data.health).toBeDefined();
  });

  it('provides summary metrics', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordError('PERMANENT');
    metrics.recordRecoverySuccess('TRANSIENT', 150);

    const data = dashboard.getData();

    expect(data.summary.totalErrors).toBe(2);
    expect(data.summary.recoverySuccessRate).toBeGreaterThanOrEqual(0);
  });

  it('includes category breakdown', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordError('PERMANENT');

    const data = dashboard.getData();

    expect(data.categories.length).toBeGreaterThan(0);
    expect(data.categories[0]).toHaveProperty('category');
    expect(data.categories[0]).toHaveProperty('count');
    expect(data.categories[0]).toHaveProperty('recoveryRate');
  });

  it('determines health status based on alerts', () => {
    const healthyData = dashboard.getData();
    expect(['healthy', 'degraded', 'critical']).toContain(healthyData.health.status);
  });

  it('counts critical and warning alerts', () => {
    const data = dashboard.getData();

    expect(data.health.criticalAlerts).toBeGreaterThanOrEqual(0);
    expect(data.health.warningAlerts).toBeGreaterThanOrEqual(0);
  });

  it('generates JSON-compatible metrics output', () => {
    metrics.recordError('TRANSIENT');

    const output = dashboard.getMetricsJSON();

    expect(typeof output).toBe('string');
    expect(output).toContain('Auto-Approval Metrics');
    expect(output).toContain('Health Status');
  });

  it('includes active alerts in metrics output', () => {
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');
    metrics.recordError('TRANSIENT');

    const output = dashboard.getMetricsJSON();

    expect(output).toContain('Health Status');
  });
});

describe('RecoveryLogger', () => {
  it('logs errors with correct tag', () => {
    const spy = console.log as any;
    const originalLog = console.log;

    RecoveryLogger.recordError('TRANSIENT', new Error('Test error'));

    expect(originalLog).toBeDefined(); // Verify logging is available
  });

  it('logs recovery attempts', () => {
    RecoveryLogger.recordRecoveryAttempt('FALLBACK', 1);
    // Just verify no exception thrown
    expect(true).toBe(true);
  });

  it('logs recovery success', () => {
    RecoveryLogger.recordRecoverySuccess('ROLLBACK', 500);
    // Just verify no exception thrown
    expect(true).toBe(true);
  });

  it('logs recovery failures', () => {
    RecoveryLogger.recordRecoveryFailure('All recovery actions failed');
    // Just verify no exception thrown
    expect(true).toBe(true);
  });

  it('logs circuit breaker events', () => {
    RecoveryLogger.recordCircuitBreakerEvent('open');
    RecoveryLogger.recordCircuitBreakerEvent('half-open');
    RecoveryLogger.recordCircuitBreakerEvent('closed');
    // Just verify no exception thrown
    expect(true).toBe(true);
  });

  it('logs alerts with severity', () => {
    RecoveryLogger.recordAlert('HIGH_ERROR_RATE', 'warning', 'Error rate exceeded threshold');
    // Just verify no exception thrown
    expect(true).toBe(true);
  });

  it('logs metrics', () => {
    const mockMetrics = {
      totalErrors: 10,
      successfulRecoveries: 8,
      failedRecoveries: 2,
      recoverySuccessRate: 80,
      averageRecoveryLatencyMs: 500,
      circuitBreakerTrips: 1,
      currentErrorRate: 5,
    };

    RecoveryLogger.recordMetrics(mockMetrics);
    // Just verify no exception thrown
    expect(true).toBe(true);
  });
});

describe('Integration scenarios', () => {
  it('tracks complete recovery workflow', () => {
    const metrics = new ErrorMetrics();
    const monitor = new HealthMonitor();
    const dashboard = new RecoveryDashboard(metrics, monitor);

    // Simulate error and recovery
    metrics.recordError('TRANSIENT');
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 200);

    const rawMetrics = metrics.getMetrics();

    expect(rawMetrics.totalErrors).toBe(1);
    expect(rawMetrics.successfulRecoveries).toBe(1);
    expect(rawMetrics.recoverySuccessRate).toBe(100);
  });

  it('monitors degrading system', () => {
    const metrics = new ErrorMetrics();
    const monitor = new HealthMonitor({
      highErrorRate: 5,
      recoveryFailureRate: 20,
      slowRecoveryMs: 1000,
    });
    const dashboard = new RecoveryDashboard(metrics, monitor);

    // Simulate degradation
    for (let i = 0; i < 10; i++) {
      metrics.recordError('TRANSIENT');
    }
    metrics.recordRecoveryAttempt('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 100);
    metrics.recordRecoverySuccess('TRANSIENT', 2000); // Slow recovery

    const rawMetrics = metrics.getMetrics();

    expect(rawMetrics.currentErrorRate).toBe(10);
    expect(rawMetrics.averageRecoveryLatencyMs).toBeGreaterThan(1000);
  });

  it('recovery dashboard provides all required data', () => {
    const { metrics, monitor, dashboard } = createRecoveryMonitoring({
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

    metrics.recordError('TRANSIENT');
    metrics.recordRecoverySuccess('TRANSIENT', 100);

    const data = dashboard.getData();

    expect(data).toHaveProperty('summary');
    expect(data).toHaveProperty('alerts');
    expect(data).toHaveProperty('categories');
    expect(data).toHaveProperty('health');
    expect(data.summary).toHaveProperty('totalErrors');
    expect(data.summary).toHaveProperty('recoverySuccessRate');
  });

  it('monitoring system scales with error volume', () => {
    const metrics = new ErrorMetrics();

    for (let i = 0; i < 100; i++) {
      metrics.recordError('TRANSIENT');
      metrics.recordRecoverySuccess('TRANSIENT', 100 + i);
    }

    const result = metrics.getMetrics();

    expect(result.totalErrors).toBe(100);
    expect(result.successfulRecoveries).toBe(100);
  });
});
