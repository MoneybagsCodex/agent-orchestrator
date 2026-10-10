/**
 * Recovery Actions Tests - Phase 4
 * 25+ test cases covering all recovery action types and combinations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ActionExecutor,
  RecoveryActionType,
  FallbackStrategy,
  RollbackStrategy,
  EscalationStrategy,
  RecoveryContext,
  RecoveryPlanBuilder,
  type AnyRecoveryAction,
} from './recovery-actions';

describe('FallbackStrategy', () => {
  it('returns fallback function result on success', async () => {
    const fallback = new FallbackStrategy(
      async () => 'fallback-value',
      undefined,
      undefined,
      'default'
    );

    const result = await fallback.execute();

    expect(result.success).toBe(true);
    expect(result.value).toBe('fallback-value');
    expect(result.source).toBe('fallback');
  });

  it('returns cached value when available', async () => {
    const cache = new Map([['cache-key', 'cached-value']]);

    const fallback = new FallbackStrategy(
      async () => 'fallback-value',
      'cache-key',
      cache,
      'default'
    );

    const result = await fallback.execute();

    expect(result.success).toBe(true);
    expect(result.value).toBe('cached-value');
    expect(result.source).toBe('cache');
  });

  it('falls back to default when function fails', async () => {
    const fallback = new FallbackStrategy(
      async () => {
        throw new Error('Fallback failed');
      },
      undefined,
      undefined,
      'default-value'
    );

    const result = await fallback.execute();

    expect(result.success).toBe(true);
    expect(result.value).toBe('default-value');
    expect(result.source).toBe('default');
  });

  it('returns no value when all strategies fail', async () => {
    const fallback = new FallbackStrategy(
      async () => {
        throw new Error('Fallback failed');
      },
      undefined,
      undefined,
      undefined
    );

    const result = await fallback.execute();

    expect(result.success).toBe(false);
    expect(result.source).toBe('none');
  });

  it('caches fallback result', async () => {
    const cache = new Map();
    let callCount = 0;

    const fallback = new FallbackStrategy(
      async () => {
        callCount++;
        return `value-${callCount}`;
      },
      'my-cache',
      cache,
      'default'
    );

    // First call caches result
    const result1 = await fallback.execute();
    expect(result1.value).toBe('value-1');
    expect(cache.get('my-cache')).toBe('value-1');

    // Second call returns cached value
    const result2 = await fallback.execute();
    expect(result2.value).toBe('value-1');
    expect(result2.source).toBe('cache');
    expect(callCount).toBe(1); // Only called once
  });

  it('prefers cache over fallback function', async () => {
    const cache = new Map([['cache-key', 'cached-value']]);

    const fallback = new FallbackStrategy(
      async () => 'fallback-value',
      'cache-key',
      cache,
      'default'
    );

    const result = await fallback.execute();

    expect(result.source).toBe('cache');
    expect(result.value).toBe('cached-value');
  });
});

describe('RollbackStrategy', () => {
  it('executes rollback function successfully', async () => {
    let rollbackCalled = false;

    const rollback = new RollbackStrategy(async () => {
      rollbackCalled = true;
    });

    const result = await rollback.execute();

    expect(result.success).toBe(true);
    expect(rollbackCalled).toBe(true);
  });

  it('handles rollback failure', async () => {
    const rollback = new RollbackStrategy(async () => {
      throw new Error('Rollback failed');
    });

    const result = await rollback.execute();

    expect(result.success).toBe(false);
    expect(result.message).toContain('Rollback failed');
  });

  it('handles missing rollback function', async () => {
    const rollback = new RollbackStrategy(undefined as any);

    const result = await rollback.execute();

    expect(result.success).toBe(true);
    expect(result.message).toContain('completed successfully');
  });
});

describe('EscalationStrategy', () => {
  it('executes escalation with warning severity', () => {
    const escalation = new EscalationStrategy('warning', true, 'warn', true);
    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = escalation.execute(context);

    expect(result.success).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it('executes escalation with error severity', () => {
    const escalation = new EscalationStrategy('error', false, 'error', false);
    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'PERMANENT',
      attempt: 1,
    };

    const result = escalation.execute(context);

    expect(result.success).toBe(true);
  });

  it('executes escalation with critical severity', () => {
    const escalation = new EscalationStrategy('critical', true, 'critical', true);
    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Critical error'),
      errorCategory: 'SYSTEM',
      attempt: 1,
    };

    const result = escalation.execute(context);

    expect(result.success).toBe(true);
    expect(result.actions).toContain('user notification queued');
    expect(result.actions).toContain('alert triggered: critical');
  });

  it('includes actions for user notification', () => {
    const escalation = new EscalationStrategy('error', true, 'error', false);
    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'USER',
      attempt: 1,
    };

    const result = escalation.execute(context);

    expect(result.actions).toContain('user notification queued');
  });

  it('includes actions for alert trigger', () => {
    const escalation = new EscalationStrategy('error', false, 'error', true);
    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'SYSTEM',
      attempt: 1,
    };

    const result = escalation.execute(context);

    expect(result.actions.some((a) => a.includes('alert triggered'))).toBe(true);
  });
});

describe('ActionExecutor', () => {
  let executor: ActionExecutor;

  beforeEach(() => {
    executor = new ActionExecutor();
  });

  it('registers and retrieves actions', () => {
    const action: AnyRecoveryAction = {
      type: RecoveryActionType.IGNORE,
      description: 'Test action',
      priority: 5,
      enabled: true,
      defaultValue: 'test',
    };

    executor.registerActions('TRANSIENT', [action]);
    const actions = executor.getActions('TRANSIENT');

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe(RecoveryActionType.IGNORE);
  });

  it('returns empty array for unregistered category', () => {
    const actions = executor.getActions('SYSTEM');

    expect(actions).toEqual([]);
  });

  it('sorts actions by priority (descending)', () => {
    const actions: AnyRecoveryAction[] = [
      {
        type: RecoveryActionType.IGNORE,
        description: 'Low priority',
        priority: 1,
        enabled: true,
        defaultValue: 'low',
      },
      {
        type: RecoveryActionType.SKIP,
        description: 'High priority',
        priority: 10,
        enabled: true,
        reason: 'test',
        continueWorkflow: true,
      },
      {
        type: RecoveryActionType.IGNORE,
        description: 'Mid priority',
        priority: 5,
        enabled: true,
        defaultValue: 'mid',
      },
    ];

    executor.registerActions('TRANSIENT', actions);
    const sorted = executor.getActions('TRANSIENT');

    expect(sorted[0].priority).toBe(10);
    expect(sorted[1].priority).toBe(5);
    expect(sorted[2].priority).toBe(1);
  });

  it('executes IGNORE action successfully', async () => {
    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.IGNORE,
        description: 'Ignore error',
        priority: 5,
        enabled: true,
        defaultValue: 'ignored-result',
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.IGNORE);
    expect(result.success).toBe(true);
    expect(result.result).toBe('ignored-result');
  });

  it('executes SKIP action successfully', async () => {
    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.SKIP,
        description: 'Skip operation',
        priority: 5,
        enabled: true,
        reason: 'Test skip',
        continueWorkflow: true,
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.SKIP);
    expect(result.success).toBe(true);
  });

  it('executes FALLBACK action successfully', async () => {
    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.FALLBACK,
        description: 'Use fallback',
        priority: 5,
        enabled: true,
        fallbackFn: async () => 'fallback-result',
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.FALLBACK);
    expect(result.success).toBe(true);
    expect(result.result).toBe('fallback-result');
  });

  it('executes ROLLBACK action successfully', async () => {
    let rollbackCalled = false;

    executor.registerActions('PERMANENT', [
      {
        type: RecoveryActionType.ROLLBACK,
        description: 'Rollback operation',
        priority: 5,
        enabled: true,
        rollbackFn: async () => {
          rollbackCalled = true;
        },
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'PERMANENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.ROLLBACK);
    expect(result.success).toBe(true);
    expect(rollbackCalled).toBe(true);
  });

  it('executes ESCALATE action successfully', async () => {
    executor.registerActions('SYSTEM', [
      {
        type: RecoveryActionType.ESCALATE,
        description: 'Escalate error',
        priority: 5,
        enabled: true,
        severity: 'critical',
        notifyUser: true,
        logLevel: 'critical',
        triggerAlert: true,
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'SYSTEM',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.ESCALATE);
    expect(result.escalated).toBe(true);
    expect(result.requiresUserAction).toBe(true);
  });

  it('tries next action when current action fails', async () => {
    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.FALLBACK,
        description: 'Fallback 1',
        priority: 10,
        enabled: true,
        fallbackFn: async () => {
          throw new Error('Fallback 1 failed');
        },
        defaultValue: undefined,
      },
      {
        type: RecoveryActionType.IGNORE,
        description: 'Fallback 2',
        priority: 5,
        enabled: true,
        defaultValue: 'success',
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    // Should try first action, fail, then try second action
    expect(result.success).toBe(true);
    expect(result.actionTaken).toBe(RecoveryActionType.IGNORE);
    expect(result.result).toBe('success');
  });

  it('skips disabled actions', async () => {
    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.IGNORE,
        description: 'Disabled action',
        priority: 10,
        enabled: false,
        defaultValue: 'disabled',
      },
      {
        type: RecoveryActionType.SKIP,
        description: 'Enabled action',
        priority: 5,
        enabled: true,
        reason: 'test',
        continueWorkflow: true,
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    // Should skip disabled action and use enabled action
    expect(result.actionTaken).toBe(RecoveryActionType.SKIP);
  });

  it('escalates when no actions configured', async () => {
    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.ESCALATE);
    expect(result.escalated).toBe(true);
    expect(result.requiresUserAction).toBe(true);
  });

  it('escalates when all actions fail', async () => {
    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.FALLBACK,
        description: 'Fallback',
        priority: 5,
        enabled: true,
        fallbackFn: async () => {
          throw new Error('Fallback failed');
        },
        defaultValue: undefined,
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'test-op',
      error: new Error('Test error'),
      errorCategory: 'TRANSIENT',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.actionTaken).toBe(RecoveryActionType.ESCALATE);
    expect(result.escalated).toBe(true);
  });
});

describe('RecoveryPlanBuilder', () => {
  it('builds recovery plan with multiple actions', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('TRANSIENT')
      .addRetry(10, 3, 100)
      .addFallback(5, async () => 'fallback')
      .done()
      .forCategory('PERMANENT')
      .addEscalate(10, 'error', { notifyUser: true })
      .done()
      .build();

    const transientActions = executor.getActions('TRANSIENT');
    const permanentActions = executor.getActions('PERMANENT');

    expect(transientActions.length).toBe(2);
    expect(permanentActions.length).toBe(1);
  });

  it('builds plan with retry action', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('TRANSIENT')
      .addRetry(10, 4, 500)
      .done()
      .build();

    const actions = executor.getActions('TRANSIENT');

    expect(actions[0].type).toBe(RecoveryActionType.RETRY);
  });

  it('builds plan with fallback action', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('TRANSIENT')
      .addFallback(8, async () => 'cached', { cacheKey: 'my-cache' })
      .done()
      .build();

    const actions = executor.getActions('TRANSIENT');

    expect(actions[0].type).toBe(RecoveryActionType.FALLBACK);
  });

  it('builds plan with rollback action', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('AGENT_SPECIFIC')
      .addRollback(8, async () => {})
      .done()
      .build();

    const actions = executor.getActions('AGENT_SPECIFIC');

    expect(actions[0].type).toBe(RecoveryActionType.ROLLBACK);
  });

  it('builds plan with escalate action', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('SYSTEM')
      .addEscalate(10, 'critical', { notifyUser: true, triggerAlert: true })
      .done()
      .build();

    const actions = executor.getActions('SYSTEM');

    expect(actions[0].type).toBe(RecoveryActionType.ESCALATE);
  });

  it('builds plan with ignore action', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('TRANSIENT')
      .addIgnore(3, 'default-value')
      .done()
      .build();

    const actions = executor.getActions('TRANSIENT');

    expect(actions[0].type).toBe(RecoveryActionType.IGNORE);
  });

  it('builds plan with skip action', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('USER')
      .addSkip(5, 'User provided invalid input')
      .done()
      .build();

    const actions = executor.getActions('USER');

    expect(actions[0].type).toBe(RecoveryActionType.SKIP);
  });

  it('supports fluent chaining across multiple categories', () => {
    const executor = new RecoveryPlanBuilder()
      .forCategory('TRANSIENT')
      .addRetry(10, 3, 100)
      .addFallback(5, async () => 'fallback')
      .done()
      .forCategory('PERMANENT')
      .addEscalate(10, 'error')
      .done()
      .forCategory('USER')
      .addIgnore(3, null)
      .done()
      .build();

    expect(executor.getActions('TRANSIENT')).toHaveLength(2);
    expect(executor.getActions('PERMANENT')).toHaveLength(1);
    expect(executor.getActions('USER')).toHaveLength(1);
  });
});

describe('Integration scenarios', () => {
  it('handles complex recovery with fallback and cache', async () => {
    const cache = new Map();
    const executor = new ActionExecutor();

    executor.registerActions('TRANSIENT', [
      {
        type: RecoveryActionType.FALLBACK,
        description: 'Use cached or default',
        priority: 5,
        enabled: true,
        fallbackFn: async () => 'live-fallback',
        cacheKey: 'data',
        defaultValue: 'default-value',
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'fetch-data',
      error: new Error('Network timeout'),
      errorCategory: 'TRANSIENT',
      attempt: 2,
      cache,
    };

    const result = await executor.execute(context);

    expect(result.success).toBe(true);
    expect(result.result).toBe('live-fallback');
  });

  it('handles cascading recovery actions', async () => {
    const executor = new ActionExecutor();

    executor.registerActions('AGENT_SPECIFIC', [
      {
        type: RecoveryActionType.ROLLBACK,
        description: 'Rollback transaction',
        priority: 10,
        enabled: true,
        rollbackFn: async () => {
          // Rollback succeeds
        },
      },
      {
        type: RecoveryActionType.ESCALATE,
        description: 'Notify ops',
        priority: 5,
        enabled: true,
        severity: 'error',
        notifyUser: true,
        logLevel: 'error',
        triggerAlert: false,
      },
    ]);

    const context: RecoveryContext = {
      operationName: 'update-agent',
      error: new Error('Agent crashed'),
      errorCategory: 'AGENT_SPECIFIC',
      attempt: 1,
    };

    const result = await executor.execute(context);

    expect(result.success).toBe(true);
    expect(result.actionTaken).toBe(RecoveryActionType.ROLLBACK);
  });
});
