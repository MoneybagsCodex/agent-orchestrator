/**
 * Retry & Backoff System - Phase 3
 * Exponential backoff with jitter, circuit breaker, and retry strategies
 */

export interface BackoffConfig {
  baseMs: number;
  multiplier: number;
  maxMs: number;
  jitterFactor: number; // 0-1, fraction of delay to randomize
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number; // failures before opening
  failureWindow: number; // ms to count failures within
  recoveryTimeout: number; // ms before half-open attempt
}

export interface RetryPolicy {
  maxRetries: number;
  backoff: BackoffConfig;
  circuitBreaker: CircuitBreakerConfig;
  timeoutMs: number;
}

/**
 * Exponential backoff with jitter to prevent thundering herd
 * Formula: delay = min(baseMs * (multiplier ^ attempt), maxMs) * (1 ± jitterFactor)
 */
export class ExponentialBackoff {
  private config: BackoffConfig;

  constructor(config: BackoffConfig) {
    this.config = config;
  }

  /**
   * Calculate delay for a given attempt number (0-indexed)
   */
  calculateDelay(attempt: number): number {
    if (attempt < 0) return 0;

    const exponentialDelay = this.config.baseMs * Math.pow(this.config.multiplier, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxMs);
    const jitterRange = cappedDelay * this.config.jitterFactor;
    const jitter = (Math.random() - 0.5) * 2 * jitterRange; // Random in [-jitterRange, +jitterRange]

    return Math.max(0, Math.round(cappedDelay + jitter));
  }

  /**
   * Get all delays for a sequence of retries
   */
  getDelaySequence(maxRetries: number): number[] {
    return Array.from({ length: maxRetries }, (_, i) => this.calculateDelay(i));
  }
}

/**
 * Circuit breaker pattern: prevents cascading failures
 * States: CLOSED (normal) -> OPEN (failing, reject requests) -> HALF_OPEN (test recovery)
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  lastAttemptTime: number | null;
  successCount: number; // in half-open state
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;
  private name: string;

  constructor(config: CircuitBreakerConfig, name: string = 'default') {
    this.config = config;
    this.name = name;
    this.state = {
      state: CircuitState.CLOSED,
      failureCount: 0,
      lastFailureTime: null,
      lastAttemptTime: null,
      successCount: 0,
    };
  }

  /**
   * Check if the circuit allows a request
   */
  canExecute(): boolean {
    if (!this.config.enabled) return true;

    if (this.state.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state.state === CircuitState.OPEN) {
      const timeSinceOpen = Date.now() - (this.state.lastFailureTime || 0);
      if (timeSinceOpen > this.config.recoveryTimeout) {
        this.state.state = CircuitState.HALF_OPEN;
        this.state.successCount = 0;
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow one request
    return true;
  }

  /**
   * Record a successful execution
   */
  recordSuccess(): void {
    if (!this.config.enabled) return;

    if (this.state.state === CircuitState.CLOSED) {
      // Reset failure count on success in closed state
      this.state.failureCount = 0;
    } else if (this.state.state === CircuitState.HALF_OPEN) {
      this.state.successCount++;
      // Successfully recovered, close circuit
      this.state.state = CircuitState.CLOSED;
      this.state.failureCount = 0;
      this.state.successCount = 0;
    }
  }

  /**
   * Record a failed execution
   */
  recordFailure(): void {
    if (!this.config.enabled) return;

    this.state.lastFailureTime = Date.now();
    this.state.failureCount++;

    if (this.state.state === CircuitState.CLOSED) {
      const timeSinceOldestFailure = Date.now() - (this.state.lastFailureTime || 0);
      const failuresInWindow =
        timeSinceOldestFailure < this.config.failureWindow ? this.state.failureCount : 1;

      if (failuresInWindow >= this.config.failureThreshold) {
        this.state.state = CircuitState.OPEN;
      }
    } else if (this.state.state === CircuitState.HALF_OPEN) {
      // Failure in half-open state means recovery failed
      this.state.state = CircuitState.OPEN;
      this.state.successCount = 0;
    }
  }

  /**
   * Get current state for monitoring/debugging
   */
  getState(): Readonly<CircuitBreakerState> {
    return Object.freeze({ ...this.state });
  }

  /**
   * Reset circuit to closed state (manual intervention)
   */
  reset(): void {
    this.state.state = CircuitState.CLOSED;
    this.state.failureCount = 0;
    this.state.successCount = 0;
    this.state.lastFailureTime = null;
    this.state.lastAttemptTime = null;
  }
}

/**
 * Retry strategy combining backoff and circuit breaker
 */
export class RetryStrategy {
  private backoff: ExponentialBackoff;
  private circuitBreaker: CircuitBreaker;
  private policy: RetryPolicy;
  private name: string;

  constructor(policy: RetryPolicy, name: string = 'default') {
    this.policy = policy;
    this.name = name;
    this.backoff = new ExponentialBackoff(policy.backoff);
    this.circuitBreaker = new CircuitBreaker(policy.circuitBreaker, name);
  }

  /**
   * Execute with retry logic
   * Returns { success, result, lastError, attempts }
   */
  async execute<T>(
    fn: () => Promise<T>,
    onRetry?: (attempt: number, delay: number, error: Error) => void
  ): Promise<{
    success: boolean;
    result?: T;
    lastError?: Error;
    attempts: number;
  }> {
    let lastError: Error | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= this.policy.maxRetries; attempt++) {
      attempts++;

      // Check circuit breaker
      if (!this.circuitBreaker.canExecute()) {
        lastError = new Error(
          `[${this.name}] Circuit breaker OPEN - too many failures, backing off`
        );
        break;
      }

      try {
        const result = await this.executeWithTimeout(fn);
        this.circuitBreaker.recordSuccess();
        return { success: true, result, attempts };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.circuitBreaker.recordFailure();

        // Don't retry after last attempt
        if (attempt < this.policy.maxRetries) {
          const delay = this.backoff.calculateDelay(attempt);
          onRetry?.(attempt + 1, delay, lastError);

          // Sleep before retry
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return { success: false, lastError, attempts };
  }

  /**
   * Execute with timeout enforcement
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`[${this.name}] Timeout after ${this.policy.timeoutMs}ms`)),
          this.policy.timeoutMs
        )
      ),
    ]);
  }

  /**
   * Get circuit breaker state for monitoring
   */
  getCircuitState() {
    return this.circuitBreaker.getState();
  }

  /**
   * Manual circuit reset
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Get retry delays for this strategy
   */
  getDelaySequence(): number[] {
    return this.backoff.getDelaySequence(this.policy.maxRetries);
  }
}

/**
 * Registry of retry strategies by error category
 */
export class RetryStrategyRegistry {
  private strategies = new Map<string, RetryStrategy>();

  register(category: string, policy: RetryPolicy): void {
    this.strategies.set(category, new RetryStrategy(policy, category));
  }

  get(category: string): RetryStrategy | undefined {
    return this.strategies.get(category);
  }

  getOrDefault(category: string, defaultPolicy: RetryPolicy): RetryStrategy {
    return this.strategies.get(category) || new RetryStrategy(defaultPolicy, category);
  }

  all(): Map<string, RetryStrategy> {
    return new Map(this.strategies);
  }
}
