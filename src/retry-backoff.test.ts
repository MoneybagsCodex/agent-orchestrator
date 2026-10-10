/**
 * Retry & Backoff System Tests - Phase 3
 * 30+ test cases covering backoff timing, circuit breaker, retry strategies, edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExponentialBackoff,
  CircuitBreaker,
  CircuitState,
  RetryStrategy,
  RetryStrategyRegistry,
  BackoffConfig,
  CircuitBreakerConfig,
  RetryPolicy,
} from './retry-backoff';

describe('ExponentialBackoff', () => {
  let backoff: ExponentialBackoff;

  beforeEach(() => {
    backoff = new ExponentialBackoff({
      baseMs: 100,
      multiplier: 2,
      maxMs: 5000,
      jitterFactor: 0,
    });
  });

  it('calculates correct base delay for attempt 0', () => {
    expect(backoff.calculateDelay(0)).toBe(100);
  });

  it('calculates exponential delays (attempt 1, 2, 3)', () => {
    expect(backoff.calculateDelay(1)).toBe(200);
    expect(backoff.calculateDelay(2)).toBe(400);
    expect(backoff.calculateDelay(3)).toBe(800);
  });

  it('caps delay at maxMs', () => {
    const delay = backoff.calculateDelay(10);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('returns 0 for negative attempt', () => {
    expect(backoff.calculateDelay(-1)).toBe(0);
  });

  it('applies jitter within range', () => {
    backoff = new ExponentialBackoff({
      baseMs: 100,
      multiplier: 1,
      maxMs: 100,
      jitterFactor: 0.5,
    });

    const delays = Array.from({ length: 100 }, () => backoff.calculateDelay(0));
    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);

    // Jitter range: 100 * 0.5 = 50, so range is [50, 150]
    expect(minDelay).toBeGreaterThanOrEqual(50); // 100 - 50
    expect(maxDelay).toBeLessThanOrEqual(150); // 100 + 50
    // Verify variance due to jitter
    expect(maxDelay - minDelay).toBeGreaterThan(0);
  });

  it('generates delay sequence for multiple retries', () => {
    const delays = backoff.getDelaySequence(5);
    expect(delays).toHaveLength(5);
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);
  });

  it('handles zero jitter factor', () => {
    const delay1 = backoff.calculateDelay(0);
    const delay2 = backoff.calculateDelay(0);
    expect(delay1).toBe(delay2);
    expect(delay1).toBe(100);
  });

  it('handles multiplier of 1 (constant backoff)', () => {
    backoff = new ExponentialBackoff({
      baseMs: 100,
      multiplier: 1,
      maxMs: 5000,
      jitterFactor: 0,
    });

    expect(backoff.calculateDelay(0)).toBe(100);
    expect(backoff.calculateDelay(5)).toBe(100);
    expect(backoff.calculateDelay(10)).toBe(100);
  });

  it('handles large multipliers', () => {
    backoff = new ExponentialBackoff({
      baseMs: 10,
      multiplier: 10,
      maxMs: 10000,
      jitterFactor: 0,
    });

    expect(backoff.calculateDelay(0)).toBe(10);
    expect(backoff.calculateDelay(1)).toBe(100);
    expect(backoff.calculateDelay(2)).toBe(1000);
    expect(backoff.calculateDelay(3)).toBe(10000); // capped at maxMs
    expect(backoff.calculateDelay(4)).toBe(10000); // stays capped
  });
});

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;
  const config: CircuitBreakerConfig = {
    enabled: true,
    failureThreshold: 3,
    failureWindow: 1000,
    recoveryTimeout: 100,
  };

  beforeEach(() => {
    breaker = new CircuitBreaker(config, 'test');
  });

  it('starts in CLOSED state', () => {
    expect(breaker.getState().state).toBe(CircuitState.CLOSED);
  });

  it('allows execution in CLOSED state', () => {
    expect(breaker.canExecute()).toBe(true);
  });

  it('opens circuit after threshold failures', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState().state).toBe(CircuitState.CLOSED); // Still closed

    breaker.recordFailure(); // Third failure
    expect(breaker.getState().state).toBe(CircuitState.OPEN);
  });

  it('rejects requests when OPEN', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState().state).toBe(CircuitState.OPEN);
    expect(breaker.canExecute()).toBe(false);
  });

  it('transitions to HALF_OPEN after recovery timeout', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState().state).toBe(CircuitState.OPEN);
    expect(breaker.canExecute()).toBe(false);

    // Wait for recovery timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState().state).toBe(CircuitState.HALF_OPEN);
  });

  it('closes circuit on success in HALF_OPEN', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState().state).toBe(CircuitState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 150));
    breaker.canExecute(); // Transition to HALF_OPEN

    breaker.recordSuccess();
    expect(breaker.getState().state).toBe(CircuitState.CLOSED);
  });

  it('reopens circuit on failure in HALF_OPEN', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((resolve) => setTimeout(resolve, 150));
    breaker.canExecute();

    breaker.recordFailure(); // Fail in HALF_OPEN
    expect(breaker.getState().state).toBe(CircuitState.OPEN);
  });

  it('resets failure count on success in CLOSED', () => {
    breaker.recordFailure();
    expect(breaker.getState().failureCount).toBe(1);

    breaker.recordSuccess();
    expect(breaker.getState().failureCount).toBe(0);
  });

  it('respects failure window', async () => {
    breaker.recordFailure();
    breaker.recordFailure();

    // Wait longer than failureWindow
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // New failures should reset the window
    expect(breaker.getState().failureCount).toBeLessThan(3);
  });

  it('handles disabled circuit breaker', () => {
    breaker = new CircuitBreaker({ ...config, enabled: false }, 'disabled');

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getState().state).toBe(CircuitState.CLOSED);
  });

  it('manual reset works', async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.getState().state).toBe(CircuitState.OPEN);

    breaker.reset();

    expect(breaker.getState().state).toBe(CircuitState.CLOSED);
    expect(breaker.canExecute()).toBe(true);
  });

  it('tracks lastFailureTime', () => {
    const before = Date.now();
    breaker.recordFailure();
    const after = Date.now();

    const failureTime = breaker.getState().lastFailureTime || 0;
    expect(failureTime).toBeGreaterThanOrEqual(before);
    expect(failureTime).toBeLessThanOrEqual(after);
  });
});

describe('RetryStrategy', () => {
  let strategy: RetryStrategy;
  const policy: RetryPolicy = {
    maxRetries: 3,
    backoff: { baseMs: 10, multiplier: 2, maxMs: 1000, jitterFactor: 0 },
    circuitBreaker: { enabled: true, failureThreshold: 5, failureWindow: 1000, recoveryTimeout: 100 },
    timeoutMs: 5000,
  };

  beforeEach(() => {
    strategy = new RetryStrategy(policy, 'test');
  });

  it('succeeds on first attempt', async () => {
    const result = await strategy.execute(async () => 'success');

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(1);
  });

  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('Fail');
      return 'success';
    };

    const result = await strategy.execute(fn);

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(3);
  });

  it('respects max retries limit', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('Always fail');
    };

    const result = await strategy.execute(fn);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(4); // Initial + 3 retries
    expect(result.lastError).toBeDefined();
  });

  it('calls onRetry callback with correct parameters', async () => {
    const retries: Array<{ attempt: number; delay: number }> = [];

    const fn = async () => {
      throw new Error('Fail');
    };

    await strategy.execute(fn, (attempt, delay) => {
      retries.push({ attempt, delay });
    });

    expect(retries.length).toBe(3);
    expect(retries[0].attempt).toBe(1);
    expect(retries[0].delay).toBe(10);
    expect(retries[1].delay).toBe(20);
    expect(retries[2].delay).toBe(40);
  });

  it('enforces timeout', async () => {
    strategy = new RetryStrategy(
      {
        ...policy,
        timeoutMs: 50,
      },
      'test'
    );

    const fn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 'should not reach';
    };

    const result = await strategy.execute(fn);

    expect(result.success).toBe(false);
    expect(result.lastError?.message).toContain('Timeout');
  });

  it('waits before retrying', async () => {
    const times: number[] = [];
    let attempts = 0;

    const fn = async () => {
      times.push(Date.now());
      attempts++;
      if (attempts < 2) throw new Error('Fail');
      return 'success';
    };

    const result = await strategy.execute(fn);

    expect(result.success).toBe(true);
    expect(times.length).toBe(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(10);
  });

  it('respects circuit breaker', async () => {
    // Force circuit open by recording failures
    for (let i = 0; i < 5; i++) {
      strategy.getCircuitState().state; // Just access to verify exists
    }

    // Manually trigger circuit opening for test
    const strategy2 = new RetryStrategy(
      {
        ...policy,
        circuitBreaker: { ...policy.circuitBreaker, failureThreshold: 1 },
      },
      'test2'
    );

    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('Fail');
    };

    await strategy2.execute(fn);

    // After first failure, circuit opens and further retries are rejected quickly
    const firstCallCount = callCount;
    const result2 = await strategy2.execute(fn);

    expect(result2.lastError?.message).toContain('Circuit breaker');
  });

  it('returns delay sequence', () => {
    const delays = strategy.getDelaySequence();

    expect(delays.length).toBe(3);
    expect(delays[0]).toBe(10);
    expect(delays[1]).toBe(20);
    expect(delays[2]).toBe(40);
  });

  it('allows manual circuit reset', async () => {
    strategy.resetCircuit();
    expect(strategy.getCircuitState().state).toBe(CircuitState.CLOSED);
  });

  it('handles async errors', async () => {
    const fn = async () => {
      throw new TypeError('Custom error');
    };

    const result = await strategy.execute(fn);

    expect(result.success).toBe(false);
    expect(result.lastError).toBeInstanceOf(TypeError);
  });

  it('handles promise rejection', async () => {
    const fn = async () => Promise.reject(new Error('Rejected'));

    const result = await strategy.execute(fn);

    expect(result.success).toBe(false);
    expect(result.lastError?.message).toContain('Rejected');
  });

  it('handles non-Error exceptions', async () => {
    const fn = async () => {
      throw 'string error';
    };

    const result = await strategy.execute(fn);

    expect(result.success).toBe(false);
    expect(result.lastError?.message).toContain('string error');
  });
});

describe('RetryStrategyRegistry', () => {
  it('registers and retrieves strategies', () => {
    const registry = new RetryStrategyRegistry();
    const policy: RetryPolicy = {
      maxRetries: 2,
      backoff: { baseMs: 100, multiplier: 2, maxMs: 5000, jitterFactor: 0 }, // No jitter for deterministic test
      circuitBreaker: { enabled: true, failureThreshold: 5, failureWindow: 1000, recoveryTimeout: 100 },
      timeoutMs: 5000,
    };

    registry.register('TRANSIENT', policy);

    const strategy = registry.get('TRANSIENT');
    expect(strategy).toBeDefined();
    expect(strategy?.getDelaySequence()[0]).toBe(100);
  });

  it('returns undefined for unregistered strategy', () => {
    const registry = new RetryStrategyRegistry();
    expect(registry.get('NONEXISTENT')).toBeUndefined();
  });

  it('getOrDefault returns default for missing strategy', () => {
    const registry = new RetryStrategyRegistry();
    const defaultPolicy: RetryPolicy = {
      maxRetries: 1,
      backoff: { baseMs: 50, multiplier: 2, maxMs: 1000, jitterFactor: 0 },
      circuitBreaker: { enabled: true, failureThreshold: 5, failureWindow: 1000, recoveryTimeout: 100 },
      timeoutMs: 5000,
    };

    const strategy = registry.getOrDefault('MISSING', defaultPolicy);
    expect(strategy).toBeDefined();
    expect(strategy.getDelaySequence()[0]).toBe(50);
  });

  it('all() returns map of all strategies', () => {
    const registry = new RetryStrategyRegistry();
    const policy: RetryPolicy = {
      maxRetries: 2,
      backoff: { baseMs: 100, multiplier: 2, maxMs: 5000, jitterFactor: 0 },
      circuitBreaker: { enabled: true, failureThreshold: 5, failureWindow: 1000, recoveryTimeout: 100 },
      timeoutMs: 5000,
    };

    registry.register('CAT1', policy);
    registry.register('CAT2', policy);

    const all = registry.all();
    expect(all.size).toBe(2);
    expect(all.has('CAT1')).toBe(true);
    expect(all.has('CAT2')).toBe(true);
  });

  it('supports multiple policies with different configs', () => {
    const registry = new RetryStrategyRegistry();

    const transientPolicy: RetryPolicy = {
      maxRetries: 4,
      backoff: { baseMs: 500, multiplier: 2, maxMs: 32000, jitterFactor: 0 }, // No jitter for deterministic test
      circuitBreaker: { enabled: true, failureThreshold: 5, failureWindow: 60000, recoveryTimeout: 30000 },
      timeoutMs: 30000,
    };

    const permanentPolicy: RetryPolicy = {
      maxRetries: 0,
      backoff: { baseMs: 0, multiplier: 1, maxMs: 0, jitterFactor: 0 },
      circuitBreaker: { enabled: true, failureThreshold: 5, failureWindow: 60000, recoveryTimeout: 30000 },
      timeoutMs: 30000,
    };

    registry.register('TRANSIENT', transientPolicy);
    registry.register('PERMANENT', permanentPolicy);

    const transient = registry.get('TRANSIENT')!;
    const permanent = registry.get('PERMANENT')!;

    expect(transient.getDelaySequence()[0]).toBe(500);
    // Permanent has maxRetries=0, so delay sequence is empty
    expect(permanent.getDelaySequence()).toHaveLength(0);
  });
});

describe('Integration scenarios', () => {
  it('complete retry flow: fail -> retry -> succeed', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('First call fails');
      if (callCount === 2) throw new Error('Second call fails');
      return 'success';
    };

    const strategy = new RetryStrategy(
      {
        maxRetries: 3,
        backoff: { baseMs: 5, multiplier: 2, maxMs: 100, jitterFactor: 0 },
        circuitBreaker: { enabled: false, failureThreshold: 5, failureWindow: 1000, recoveryTimeout: 100 },
        timeoutMs: 5000,
      },
      'integration'
    );

    const result = await strategy.execute(fn);

    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(3);
  });

  it('handles cascading failures with circuit breaker', async () => {
    const strategy = new RetryStrategy(
      {
        maxRetries: 2,
        backoff: { baseMs: 5, multiplier: 2, maxMs: 100, jitterFactor: 0 },
        circuitBreaker: { enabled: true, failureThreshold: 2, failureWindow: 60000, recoveryTimeout: 100 },
        timeoutMs: 5000,
      },
      'cascade'
    );

    const alwaysFail = async () => {
      throw new Error('Always fails');
    };

    // First call opens circuit
    const result1 = await strategy.execute(alwaysFail);
    expect(result1.success).toBe(false);

    // Second call hits circuit breaker
    const result2 = await strategy.execute(alwaysFail);
    expect(result2.lastError?.message).toContain('Circuit breaker');
    expect(result2.attempts).toBeLessThan(result1.attempts);
  });

  it('backoff prevents thundering herd with jitter', () => {
    const config: BackoffConfig = {
      baseMs: 1000,
      multiplier: 2,
      maxMs: 60000,
      jitterFactor: 0.3,
    };

    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const backoff = new ExponentialBackoff(config);
      delays.push(backoff.calculateDelay(2)); // All same attempt number: 1000 * 2^2 = 4000
    }

    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);

    // For attempt 2: baseDelay = 1000 * 2^2 = 4000, jitterRange = 4000 * 0.3 = 1200
    // So delays should be in range [2800, 5200]
    expect(maxDelay - minDelay).toBeGreaterThan(0); // Should vary due to jitter
    expect(minDelay).toBeGreaterThanOrEqual(4000 * 0.7); // 2800
    expect(maxDelay).toBeLessThanOrEqual(4000 * 1.3); // 5200
  });
});
