/**
 * Error Recovery Integration - Phase 2 + Phase 3
 * Connects error categorization with retry & backoff strategies
 */

import {
  categorizeError,
  ErrorCategory,
  getRetryPolicy as getErrorRetryPolicy,
  type ErrorCategorization,
} from './error-recovery';
import {
  RetryStrategy,
  RetryStrategyRegistry,
  RetryPolicy,
  type RetryStrategyConfig,
} from './retry-backoff';

/**
 * Error recovery executor: categorizes errors and applies appropriate retry strategy
 */
export class ErrorRecoveryExecutor {
  private strategies: RetryStrategyRegistry;

  constructor(policies: Map<ErrorCategory, RetryPolicy>) {
    this.strategies = new RetryStrategyRegistry();

    for (const [category, policy] of policies) {
      this.strategies.register(category, policy);
    }
  }

  /**
   * Execute operation with automatic error handling and retry
   */
  async execute<T>(
    operation: () => Promise<T>,
    onRetry?: (attempt: number, delay: number, category: ErrorCategory, error: Error) => void
  ): Promise<{
    success: boolean;
    result?: T;
    category?: ErrorCategory;
    attempts: number;
    error?: Error;
  }> {
    let lastError: Error | undefined;
    let lastCategory: ErrorCategory | undefined;

    try {
      // First attempt without retry
      const result = await operation();
      return { success: true, result, attempts: 1 };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const categorization = categorizeError(lastError);
      lastCategory = categorization.category;

      // Get retry policy for this error category
      const policy = this.strategies.get(categorization.category);
      if (!policy) {
        return {
          success: false,
          category: categorization.category,
          attempts: 1,
          error: lastError,
        };
      }

      // Execute with retry strategy
      const result = await policy.execute(
        operation,
        (attempt, delay) => {
          onRetry?.(attempt, delay, categorization.category, lastError!);
        }
      );

      return {
        success: result.success,
        result: result.result,
        category: categorization.category,
        attempts: result.attempts,
        error: result.lastError,
      };
    }
  }

  /**
   * Execute operation with logging
   */
  async executeWithLogging<T>(
    operationName: string,
    operation: () => Promise<T>
  ): Promise<{
    success: boolean;
    result?: T;
    category?: ErrorCategory;
    attempts: number;
  }> {
    console.log(`[error-recovery] Starting operation: ${operationName}`);

    const result = await this.execute(operation, (attempt, delay, category, error) => {
      console.log(
        `[error-recovery] Retry ${attempt} for ${operationName} (${category}): waiting ${delay}ms after ${error.message}`
      );
    });

    if (result.success) {
      console.log(`[error-recovery] ✓ ${operationName} succeeded after ${result.attempts} attempt(s)`);
    } else {
      console.log(
        `[error-recovery] ✗ ${operationName} failed after ${result.attempts} attempt(s): ${result.category} - ${result.error?.message}`
      );
    }

    return result;
  }

  /**
   * Get recovery recommendations for error
   */
  getRecoveryRecommendation(
    error: Error
  ): {
    category: ErrorCategory;
    shouldRetry: boolean;
    message: string;
  } {
    const categorization = categorizeError(error);
    const policy = this.strategies.get(categorization.category);

    const shouldRetry = policy ? policy.getDelaySequence().length > 0 : false;
    const messages: Record<ErrorCategory, string> = {
      TRANSIENT: 'Transient error (network, timeout, rate limit) - retrying with exponential backoff',
      PERMANENT: 'Permanent error (not found, permission denied) - no retry, escalate to user',
      AGENT_SPECIFIC: 'Agent-specific error - slower retry, may need state changes',
      SYSTEM: 'System error (out of memory, disk full) - single retry with manual intervention option',
      USER: 'User-caused error (ambiguous input, missing parameter) - no retry, ask for clarification',
    };

    return {
      category: categorization.category,
      shouldRetry,
      message: messages[categorization.category],
    };
  }

  /**
   * Get circuit breaker state for monitoring
   */
  getCircuitState(category: ErrorCategory) {
    const strategy = this.strategies.get(category);
    return strategy ? strategy.getCircuitState() : null;
  }

  /**
   * Reset circuit breaker for a category
   */
  resetCircuit(category: ErrorCategory): void {
    const strategy = this.strategies.get(category);
    if (strategy) {
      strategy.resetCircuit();
    }
  }
}

/**
 * Create executor from orchestrator config
 */
export function createErrorRecoveryExecutor(config: any): ErrorRecoveryExecutor {
  const policies = new Map<ErrorCategory, RetryPolicy>();

  // Build policies from config.errorRecovery.retryPolicies
  const retryPolicies = config.errorRecovery?.retryPolicies || {};

  const categories: ErrorCategory[] = ['TRANSIENT', 'PERMANENT', 'AGENT_SPECIFIC', 'SYSTEM', 'USER'];

  for (const category of categories) {
    const policyConfig = retryPolicies[category];
    if (policyConfig) {
      policies.set(category as ErrorCategory, {
        maxRetries: policyConfig.maxRetries,
        backoff: {
          baseMs: policyConfig.backoffMs,
          multiplier: policyConfig.backoffMultiplier,
          maxMs: policyConfig.maxBackoffMs,
          jitterFactor: policyConfig.jitterFactor,
        },
        circuitBreaker: {
          enabled: config.errorRecovery?.circuitBreaker?.enabled ?? true,
          failureThreshold: config.errorRecovery?.circuitBreaker?.failureThreshold ?? 5,
          failureWindow: config.errorRecovery?.circuitBreaker?.failureWindow ?? 60000,
          recoveryTimeout: config.errorRecovery?.circuitBreaker?.recoveryTimeout ?? 30000,
        },
        timeoutMs: policyConfig.timeoutMs,
      });
    }
  }

  return new ErrorRecoveryExecutor(policies);
}

/**
 * Example usage in agent-orchestrator
 */
export async function exampleUsage() {
  // In actual code, load from orchestrator.config.json
  const config = {
    errorRecovery: {
      retryPolicies: {
        TRANSIENT: {
          maxRetries: 4,
          backoffMs: 500,
          backoffMultiplier: 2,
          maxBackoffMs: 32000,
          jitterFactor: 0.3,
          timeoutMs: 30000,
        },
        PERMANENT: {
          maxRetries: 0,
          backoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
          jitterFactor: 0,
          timeoutMs: 30000,
        },
        AGENT_SPECIFIC: {
          maxRetries: 2,
          backoffMs: 1000,
          backoffMultiplier: 1.5,
          maxBackoffMs: 10000,
          jitterFactor: 0.2,
          timeoutMs: 15000,
        },
        SYSTEM: {
          maxRetries: 1,
          backoffMs: 2000,
          backoffMultiplier: 1,
          maxBackoffMs: 2000,
          jitterFactor: 0,
          timeoutMs: 60000,
        },
        USER: {
          maxRetries: 0,
          backoffMs: 0,
          backoffMultiplier: 1,
          maxBackoffMs: 0,
          jitterFactor: 0,
          timeoutMs: 30000,
        },
      },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 5,
        failureWindow: 60000,
        recoveryTimeout: 30000,
      },
    },
  };

  const executor = createErrorRecoveryExecutor(config);

  // Usage: auto-approve safe operations
  const result = await executor.executeWithLogging('auto-approve git commit', async () => {
    // Simulate operation
    return true;
  });

  if (result.success) {
    console.log('Auto-approval succeeded');
  }
}
