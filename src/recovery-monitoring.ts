/**
 * Recovery Monitoring & Observability - Phase 5
 * Tracks error metrics, recovery success rates, and health alerts
 */

import { ErrorCategory } from './error-recovery';
import { RecoveryActionType } from './recovery-actions';

export interface ErrorMetrics {
  totalErrors: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  recoverySuccessRate: number; // percentage
  averageRecoveryLatencyMs: number;
  circuitBreakerTrips: number;
  currentErrorRate: number; // errors/minute
}

export interface CategoryMetrics {
  category: ErrorCategory;
  count: number;
  recoveryRate: number;
  commonRecoveryAction: RecoveryActionType;
  lastErrorTime: number;
  averageLatencyMs: number;
}

export interface HealthAlert {
  type: 'HIGH_ERROR_RATE' | 'RECOVERY_FAILURES' | 'CIRCUIT_OPEN' | 'SLOW_RECOVERY';
  severity: 'warning' | 'error' | 'critical';
  message: string;
  timestamp: number;
  threshold?: number;
  current?: number;
}

/**
 * Error metrics tracker
 */
export class ErrorMetrics {
  private errorCounts = new Map<ErrorCategory, number>();
  private recoveryAttempts = new Map<ErrorCategory, number>();
  private recoverySuccesses = new Map<ErrorCategory, number>();
  private recoveryLatencies: number[] = [];
  private lastMetricsReset = Date.now();
  private circuitBreakerTrips = 0;
  private errorTimestamps: number[] = [];

  recordError(category: ErrorCategory): void {
    const count = (this.errorCounts.get(category) || 0) + 1;
    this.errorCounts.set(category, count);
    this.errorTimestamps.push(Date.now());

    // Keep only last 60 seconds of timestamps for error rate calculation
    const oneMinuteAgo = Date.now() - 60000;
    this.errorTimestamps = this.errorTimestamps.filter((t) => t > oneMinuteAgo);

    console.log(`[error-recovery-track] Error recorded: ${category} (total: ${count})`);
  }

  recordRecoveryAttempt(category: ErrorCategory): void {
    const count = (this.recoveryAttempts.get(category) || 0) + 1;
    this.recoveryAttempts.set(category, count);
  }

  recordRecoverySuccess(category: ErrorCategory, latencyMs: number): void {
    const count = (this.recoverySuccesses.get(category) || 0) + 1;
    this.recoverySuccesses.set(category, count);
    this.recoveryLatencies.push(latencyMs);

    console.log(
      `[error-recovery-success] Recovery successful for ${category} (${latencyMs}ms)`
    );
  }

  recordCircuitBreakerTrip(): void {
    this.circuitBreakerTrips++;
    console.log(
      `[error-recovery-circuit] Circuit breaker trip (total: ${this.circuitBreakerTrips})`
    );
  }

  getCategoryMetrics(category: ErrorCategory): CategoryMetrics {
    const count = this.errorCounts.get(category) || 0;
    const attempts = this.recoveryAttempts.get(category) || 0;
    const successes = this.recoverySuccesses.get(category) || 0;
    const rate = attempts > 0 ? (successes / attempts) * 100 : 0;

    // Calculate average latency for this category
    const avgLatency = this.recoveryLatencies.length > 0
      ? Math.round(this.recoveryLatencies.reduce((a, b) => a + b, 0) / this.recoveryLatencies.length)
      : 0;

    return {
      category,
      count,
      recoveryRate: Math.round(rate * 100) / 100,
      commonRecoveryAction: RecoveryActionType.RETRY,
      lastErrorTime: Math.max(...this.errorTimestamps, 0),
      averageLatencyMs: avgLatency,
    };
  }

  getMetrics(): {
    totalErrors: number;
    successfulRecoveries: number;
    failedRecoveries: number;
    recoverySuccessRate: number;
    averageRecoveryLatencyMs: number;
    circuitBreakerTrips: number;
    currentErrorRate: number;
  } {
    const totalErrors = Array.from(this.errorCounts.values()).reduce((a, b) => a + b, 0);
    const totalAttempts = Array.from(this.recoveryAttempts.values()).reduce((a, b) => a + b, 0);
    const totalSuccesses = Array.from(this.recoverySuccesses.values()).reduce((a, b) => a + b, 0);
    const totalFailures = totalAttempts - totalSuccesses;
    const successRate = totalAttempts > 0 ? (totalSuccesses / totalAttempts) * 100 : 0;
    const avgLatency = this.recoveryLatencies.length > 0
      ? Math.round(this.recoveryLatencies.reduce((a, b) => a + b, 0) / this.recoveryLatencies.length)
      : 0;
    const errorRate = this.errorTimestamps.length; // Errors in last 60 seconds

    return {
      totalErrors,
      successfulRecoveries: totalSuccesses,
      failedRecoveries: totalFailures,
      recoverySuccessRate: Math.round(successRate * 100) / 100,
      averageRecoveryLatencyMs: avgLatency,
      circuitBreakerTrips: this.circuitBreakerTrips,
      currentErrorRate: errorRate,
    };
  }

  reset(): void {
    this.errorCounts.clear();
    this.recoveryAttempts.clear();
    this.recoverySuccesses.clear();
    this.recoveryLatencies = [];
    this.errorTimestamps = [];
    this.circuitBreakerTrips = 0;
    this.lastMetricsReset = Date.now();

    console.log('[error-recovery-metrics] Metrics reset');
  }
}

/**
 * Health alerts detector
 */
export class HealthMonitor {
  private alerts: HealthAlert[] = [];
  private thresholds = {
    highErrorRate: 10, // errors/minute
    recoveryFailureRate: 20, // percentage
    slowRecoveryMs: 5000, // milliseconds
  };

  constructor(thresholds?: Partial<typeof HealthMonitor.prototype.thresholds>) {
    if (thresholds) {
      this.thresholds = { ...this.thresholds, ...thresholds };
    }
  }

  checkHealth(metrics: ReturnType<ErrorMetrics['getMetrics']>): HealthAlert[] {
    const newAlerts: HealthAlert[] = [];

    // Check error rate
    if (metrics.currentErrorRate > this.thresholds.highErrorRate) {
      newAlerts.push({
        type: 'HIGH_ERROR_RATE',
        severity: 'warning',
        message: `High error rate: ${metrics.currentErrorRate} errors/minute (threshold: ${this.thresholds.highErrorRate})`,
        timestamp: Date.now(),
        threshold: this.thresholds.highErrorRate,
        current: metrics.currentErrorRate,
      });
    }

    // Check recovery failure rate
    const failureRate = 100 - metrics.recoverySuccessRate;
    if (failureRate > this.thresholds.recoveryFailureRate) {
      newAlerts.push({
        type: 'RECOVERY_FAILURES',
        severity: 'error',
        message: `High recovery failure rate: ${failureRate.toFixed(2)}% (threshold: ${this.thresholds.recoveryFailureRate}%)`,
        timestamp: Date.now(),
        threshold: this.thresholds.recoveryFailureRate,
        current: failureRate,
      });
    }

    // Check recovery latency
    if (metrics.averageRecoveryLatencyMs > this.thresholds.slowRecoveryMs) {
      newAlerts.push({
        type: 'SLOW_RECOVERY',
        severity: 'warning',
        message: `Slow recovery latency: ${metrics.averageRecoveryLatencyMs}ms (threshold: ${this.thresholds.slowRecoveryMs}ms)`,
        timestamp: Date.now(),
        threshold: this.thresholds.slowRecoveryMs,
        current: metrics.averageRecoveryLatencyMs,
      });
    }

    // Check circuit breaker trips
    if (metrics.circuitBreakerTrips > 5) {
      newAlerts.push({
        type: 'CIRCUIT_OPEN',
        severity: 'critical',
        message: `Circuit breaker trips detected: ${metrics.circuitBreakerTrips}`,
        timestamp: Date.now(),
        current: metrics.circuitBreakerTrips,
      });
    }

    this.alerts = newAlerts;
    return newAlerts;
  }

  getAlerts(): HealthAlert[] {
    return [...this.alerts];
  }

  clearAlerts(): void {
    this.alerts = [];
  }

  hasAnyAlerts(): boolean {
    return this.alerts.length > 0;
  }

  hasCriticalAlerts(): boolean {
    return this.alerts.some((a) => a.severity === 'critical');
  }
}

/**
 * Recovery dashboard data aggregator
 */
export class RecoveryDashboard {
  constructor(
    private metrics: ErrorMetrics,
    private monitor: HealthMonitor
  ) {}

  getData() {
    const metrics = this.metrics.getMetrics();
    const alerts = this.monitor.checkHealth(metrics);
    const categoryMetrics = this.getCategoryBreakdown();

    return {
      summary: {
        totalErrors: metrics.totalErrors,
        recoverySuccessRate: metrics.recoverySuccessRate,
        averageLatencyMs: metrics.averageRecoveryLatencyMs,
        currentErrorRate: metrics.currentErrorRate,
        circuitBreakerTrips: metrics.circuitBreakerTrips,
      },
      alerts: alerts.map((a) => ({
        type: a.type,
        severity: a.severity,
        message: a.message,
        timestamp: new Date(a.timestamp).toISOString(),
      })),
      categories: categoryMetrics,
      health: {
        status: this.getHealthStatus(alerts),
        criticalAlerts: alerts.filter((a) => a.severity === 'critical').length,
        warningAlerts: alerts.filter((a) => a.severity === 'warning').length,
      },
    };
  }

  private getCategoryBreakdown(): CategoryMetrics[] {
    const categories: ErrorCategory[] = ['TRANSIENT', 'PERMANENT', 'AGENT_SPECIFIC', 'SYSTEM', 'USER'];
    return categories.map((cat) => this.metrics.getCategoryMetrics(cat)).filter((m) => m.count > 0);
  }

  private getHealthStatus(
    alerts: HealthAlert[]
  ): 'healthy' | 'degraded' | 'critical' {
    if (alerts.some((a) => a.severity === 'critical')) return 'critical';
    if (alerts.some((a) => a.severity === 'error')) return 'degraded';
    return 'healthy';
  }

  getMetricsJSON() {
    const data = this.getData();
    const output = `**Auto-Approval Metrics:**
- Approvals (this minute): ${data.summary.totalErrors}
- Successful recoveries: ${data.summary.recoverySuccessRate}%
- Average latency: ${data.summary.averageLatencyMs}ms
- Error rate: ${data.summary.currentErrorRate}/min
- Circuit trips: ${data.summary.circuitBreakerTrips}

**Health Status:** ${data.health.status}
- Critical alerts: ${data.health.criticalAlerts}
- Warning alerts: ${data.health.warningAlerts}

**Top Error Categories:**
${data.categories.map((c) => `- ${c.category}: ${c.count} (${c.recoveryRate}% recovery rate)`).join('\n')}

${data.alerts.length > 0 ? `**Active Alerts:**\n${data.alerts.map((a) => `- [${a.severity}] ${a.message}`).join('\n')}` : ''}`;
    return output;
  }
}

/**
 * Logging utilities with [error-recovery-*] tags
 */
export class RecoveryLogger {
  static recordError(category: ErrorCategory, error: Error, context?: string): void {
    console.log(
      `[error-recovery-error] ${category}${context ? ` [${context}]` : ''}: ${error.message}`
    );
  }

  static recordRecoveryAttempt(action: RecoveryActionType, attempt: number): void {
    console.log(`[error-recovery-attempt] Recovery action: ${action} (attempt ${attempt})`);
  }

  static recordRecoverySuccess(action: RecoveryActionType, latencyMs: number): void {
    console.log(`[error-recovery-success] Action succeeded: ${action} (${latencyMs}ms)`);
  }

  static recordRecoveryFailure(reason: string): void {
    console.log(`[error-recovery-failure] Recovery failed: ${reason}`);
  }

  static recordCircuitBreakerEvent(event: 'open' | 'half-open' | 'closed'): void {
    console.log(`[error-recovery-circuit] Circuit breaker: ${event}`);
  }

  static recordAlert(type: string, severity: string, message: string): void {
    console.log(`[error-recovery-alert-${severity}] ${type}: ${message}`);
  }

  static recordMetrics(metrics: ReturnType<ErrorMetrics['getMetrics']>): void {
    console.log(
      `[error-recovery-metrics] Success rate: ${metrics.recoverySuccessRate}%, Avg latency: ${metrics.averageRecoveryLatencyMs}ms, Errors: ${metrics.totalErrors}`
    );
  }
}

/**
 * Create monitoring system from config
 */
export function createRecoveryMonitoring(config: any) {
  const metrics = new ErrorMetrics();
  const monitor = new HealthMonitor(config.errorRecovery?.monitoring?.thresholds);
  const dashboard = new RecoveryDashboard(metrics, monitor);

  return { metrics, monitor, dashboard };
}
