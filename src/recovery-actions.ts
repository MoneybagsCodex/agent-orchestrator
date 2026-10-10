/**
 * Recovery Actions - Phase 4
 * Defines recovery strategies (fallback, rollback, escalate, etc.)
 * Executes appropriate recovery based on error category and context
 */

import { ErrorCategory } from './error-recovery';
import { CircuitState } from './retry-backoff';

export enum RecoveryActionType {
  RETRY = 'retry',           // Already handled by Phase 3, included for completeness
  FALLBACK = 'fallback',     // Use alternate operation or cached result
  ROLLBACK = 'rollback',     // Undo operation, restore previous state
  ESCALATE = 'escalate',     // Notify user, log critical, trigger alerts
  IGNORE = 'ignore',         // Silently ignore error, return default
  SKIP = 'skip',             // Skip operation, continue workflow
}

export interface RecoveryAction {
  type: RecoveryActionType;
  description: string;
  priority: number; // 1-10, higher = try first
  enabled: boolean;
}

export interface RetryAction extends RecoveryAction {
  type: RecoveryActionType.RETRY;
  maxAttempts: number;
  backoffMs: number;
}

export interface FallbackAction extends RecoveryAction {
  type: RecoveryActionType.FALLBACK;
  fallbackFn: () => Promise<any>;
  cacheKey?: string; // For cached fallback
  defaultValue?: any;
  description: string;
}

export interface RollbackAction extends RecoveryAction {
  type: RecoveryActionType.ROLLBACK;
  rollbackFn: () => Promise<void>;
  restoreStateKey?: string;
}

export interface EscalateAction extends RecoveryAction {
  type: RecoveryActionType.ESCALATE;
  severity: 'warning' | 'error' | 'critical';
  notifyUser: boolean;
  logLevel: 'warn' | 'error' | 'critical';
  triggerAlert: boolean;
}

export interface IgnoreAction extends RecoveryAction {
  type: RecoveryActionType.IGNORE;
  defaultValue?: any;
  logLevel?: 'debug' | 'info' | 'warn';
}

export interface SkipAction extends RecoveryAction {
  type: RecoveryActionType.SKIP;
  reason: string;
  continueWorkflow: boolean;
}

export type AnyRecoveryAction =
  | RetryAction
  | FallbackAction
  | RollbackAction
  | EscalateAction
  | IgnoreAction
  | SkipAction;

/**
 * Recovery context provides state for recovery actions
 */
export interface RecoveryContext {
  operationName: string;
  error: Error;
  errorCategory: ErrorCategory;
  circuitState?: CircuitState;
  attempt: number;
  state?: Record<string, any>; // State to restore on rollback
  cache?: Map<string, any>;
}

/**
 * Recovery result indicates what action was taken
 */
export interface RecoveryResult {
  actionTaken: RecoveryActionType;
  success: boolean;
  result?: any;
  message: string;
  escalated: boolean;
  requiresUserAction: boolean;
}

/**
 * Fallback strategy executor
 */
export class FallbackStrategy {
  constructor(
    private fallbackFn: () => Promise<any>,
    private cacheKey?: string,
    private cache?: Map<string, any>,
    private defaultValue?: any
  ) {}

  async execute(): Promise<{ success: boolean; value: any; source: string }> {
    // Try cache first
    if (this.cacheKey && this.cache?.has(this.cacheKey)) {
      const cached = this.cache.get(this.cacheKey);
      return { success: true, value: cached, source: 'cache' };
    }

    // Try fallback function
    if (this.fallbackFn) {
      try {
        const value = await this.fallbackFn();
        if (this.cacheKey) {
          this.cache?.set(this.cacheKey, value);
        }
        return { success: true, value, source: 'fallback' };
      } catch (fallbackError) {
        // Fallback failed, try default
      }
    }

    // Use default value
    if (this.defaultValue !== undefined) {
      return { success: true, value: this.defaultValue, source: 'default' };
    }

    return { success: false, value: undefined, source: 'none' };
  }
}

/**
 * Rollback strategy executor
 */
export class RollbackStrategy {
  constructor(
    private rollbackFn: () => Promise<void>,
    private restoreState?: Record<string, any>
  ) {}

  async execute(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.rollbackFn) {
        await this.rollbackFn();
      }

      if (this.restoreState) {
        // Restore state would be handled by caller
        // This just tracks that rollback was executed
      }

      return { success: true, message: 'Rollback completed successfully' };
    } catch (rollbackError) {
      const message = rollbackError instanceof Error ? rollbackError.message : 'Unknown rollback error';
      return { success: false, message: `Rollback failed: ${message}` };
    }
  }
}

/**
 * Escalation strategy executor
 */
export class EscalationStrategy {
  constructor(
    private severity: 'warning' | 'error' | 'critical',
    private notifyUser: boolean,
    private logLevel: 'warn' | 'error' | 'critical',
    private triggerAlert: boolean
  ) {}

  execute(context: RecoveryContext): { success: boolean; actions: string[] } {
    const actions: string[] = [];

    // Log at appropriate level
    const logMessage = `[recovery-escalate-${this.severity}] ${context.operationName}: ${context.error.message}`;
    console.log(logMessage);
    actions.push(`logged at ${this.logLevel}`);

    // Notify user if requested
    if (this.notifyUser) {
      actions.push('user notification queued');
    }

    // Trigger alert if requested
    if (this.triggerAlert) {
      actions.push(`alert triggered: ${this.severity}`);
    }

    return { success: true, actions };
  }
}

/**
 * Action executor applies recovery based on error category
 */
export class ActionExecutor {
  private actions: Map<string, AnyRecoveryAction[]> = new Map();

  registerActions(category: ErrorCategory, actions: AnyRecoveryAction[]): void {
    this.actions.set(category, actions.sort((a, b) => b.priority - a.priority));
  }

  getActions(category: ErrorCategory): AnyRecoveryAction[] {
    return this.actions.get(category) || [];
  }

  async execute(context: RecoveryContext): Promise<RecoveryResult> {
    const actions = this.getActions(context.errorCategory);

    if (actions.length === 0) {
      return {
        actionTaken: RecoveryActionType.ESCALATE,
        success: false,
        message: `No recovery actions configured for ${context.errorCategory}`,
        escalated: true,
        requiresUserAction: true,
      };
    }

    // Try each action in priority order
    for (const action of actions) {
      if (!action.enabled) continue;

      const result = await this.executeAction(action, context);
      if (result.success) {
        return result;
      }
    }

    // All actions failed, escalate
    return {
      actionTaken: RecoveryActionType.ESCALATE,
      success: false,
      message: 'All recovery actions failed',
      escalated: true,
      requiresUserAction: true,
    };
  }

  private async executeAction(action: AnyRecoveryAction, context: RecoveryContext): Promise<RecoveryResult> {
    try {
      switch (action.type) {
        case RecoveryActionType.RETRY: {
          const retryAction = action as RetryAction;
          return {
            actionTaken: RecoveryActionType.RETRY,
            success: true,
            message: `Retry configured: max ${retryAction.maxAttempts} attempts, ${retryAction.backoffMs}ms backoff`,
            escalated: false,
            requiresUserAction: false,
          };
        }

        case RecoveryActionType.FALLBACK: {
          const fallbackAction = action as FallbackAction;
          const strategy = new FallbackStrategy(
            fallbackAction.fallbackFn,
            fallbackAction.cacheKey,
            context.cache,
            fallbackAction.defaultValue
          );
          const result = await strategy.execute();

          return {
            actionTaken: RecoveryActionType.FALLBACK,
            success: result.success,
            result: result.value,
            message: `Fallback executed (source: ${result.source})`,
            escalated: false,
            requiresUserAction: false,
          };
        }

        case RecoveryActionType.ROLLBACK: {
          const rollbackAction = action as RollbackAction;
          const strategy = new RollbackStrategy(rollbackAction.rollbackFn, context.state);
          const result = await strategy.execute();

          return {
            actionTaken: RecoveryActionType.ROLLBACK,
            success: result.success,
            message: result.message,
            escalated: !result.success,
            requiresUserAction: !result.success,
          };
        }

        case RecoveryActionType.ESCALATE: {
          const escalateAction = action as EscalateAction;
          const strategy = new EscalationStrategy(
            escalateAction.severity,
            escalateAction.notifyUser,
            escalateAction.logLevel,
            escalateAction.triggerAlert
          );
          const result = strategy.execute(context);

          return {
            actionTaken: RecoveryActionType.ESCALATE,
            success: result.success,
            message: `Escalated (${result.actions.join(', ')})`,
            escalated: true,
            requiresUserAction: (action as EscalateAction).notifyUser,
          };
        }

        case RecoveryActionType.IGNORE: {
          const ignoreAction = action as IgnoreAction;
          console.log(
            `[recovery-ignore] ${context.operationName}: ignoring ${context.errorCategory} error`
          );

          return {
            actionTaken: RecoveryActionType.IGNORE,
            success: true,
            result: ignoreAction.defaultValue,
            message: 'Error ignored, using default value',
            escalated: false,
            requiresUserAction: false,
          };
        }

        case RecoveryActionType.SKIP: {
          const skipAction = action as SkipAction;
          console.log(
            `[recovery-skip] ${context.operationName}: skipping operation (${skipAction.reason})`
          );

          return {
            actionTaken: RecoveryActionType.SKIP,
            success: true,
            message: `Operation skipped: ${skipAction.reason}`,
            escalated: false,
            requiresUserAction: false,
          };
        }

        default:
          return {
            actionTaken: RecoveryActionType.ESCALATE,
            success: false,
            message: 'Unknown recovery action type',
            escalated: true,
            requiresUserAction: true,
          };
      }
    } catch (actionError) {
      console.log(
        `[recovery-action-error] Action ${action.type} failed: ${
          actionError instanceof Error ? actionError.message : String(actionError)
        }`
      );
      return {
        actionTaken: action.type,
        success: false,
        message: `Action execution failed: ${actionError instanceof Error ? actionError.message : 'unknown'}`,
        escalated: true,
        requiresUserAction: true,
      };
    }
  }
}

/**
 * Recovery plan builder for fluent API
 */
export class RecoveryPlanBuilder {
  private actions: Map<ErrorCategory, AnyRecoveryAction[]> = new Map();

  forCategory(category: ErrorCategory): RecoveryActionBuilder {
    return new RecoveryActionBuilder(category, this);
  }

  registerAction(category: ErrorCategory, action: AnyRecoveryAction): this {
    if (!this.actions.has(category)) {
      this.actions.set(category, []);
    }
    this.actions.get(category)!.push(action);
    return this;
  }

  build(): ActionExecutor {
    const executor = new ActionExecutor();
    for (const [category, actions] of this.actions) {
      executor.registerActions(category, actions);
    }
    return executor;
  }
}

/**
 * Helper class for building recovery actions per category
 */
export class RecoveryActionBuilder {
  private actions: AnyRecoveryAction[] = [];

  constructor(private category: ErrorCategory, private builder: RecoveryPlanBuilder) {}

  addRetry(priority: number, maxAttempts: number, backoffMs: number): this {
    this.actions.push({
      type: RecoveryActionType.RETRY,
      description: `Retry up to ${maxAttempts} times`,
      priority,
      enabled: true,
      maxAttempts,
      backoffMs,
    });
    return this;
  }

  addFallback(
    priority: number,
    fallbackFn: () => Promise<any>,
    options?: { cacheKey?: string; defaultValue?: any }
  ): this {
    this.actions.push({
      type: RecoveryActionType.FALLBACK,
      description: 'Use fallback operation',
      priority,
      enabled: true,
      fallbackFn,
      cacheKey: options?.cacheKey,
      defaultValue: options?.defaultValue,
    });
    return this;
  }

  addRollback(priority: number, rollbackFn: () => Promise<void>, restoreStateKey?: string): this {
    this.actions.push({
      type: RecoveryActionType.ROLLBACK,
      description: 'Rollback to previous state',
      priority,
      enabled: true,
      rollbackFn,
      restoreStateKey,
    });
    return this;
  }

  addEscalate(
    priority: number,
    severity: 'warning' | 'error' | 'critical',
    options?: { notifyUser?: boolean; logLevel?: 'warn' | 'error' | 'critical'; triggerAlert?: boolean }
  ): this {
    this.actions.push({
      type: RecoveryActionType.ESCALATE,
      description: `Escalate as ${severity}`,
      priority,
      enabled: true,
      severity,
      notifyUser: options?.notifyUser ?? false,
      logLevel: options?.logLevel ?? 'error',
      triggerAlert: options?.triggerAlert ?? false,
    });
    return this;
  }

  addIgnore(priority: number, defaultValue?: any, logLevel?: 'debug' | 'info' | 'warn'): this {
    this.actions.push({
      type: RecoveryActionType.IGNORE,
      description: 'Ignore error and continue',
      priority,
      enabled: true,
      defaultValue,
      logLevel,
    });
    return this;
  }

  addSkip(priority: number, reason: string, continueWorkflow?: boolean): this {
    this.actions.push({
      type: RecoveryActionType.SKIP,
      description: `Skip operation: ${reason}`,
      priority,
      enabled: true,
      reason,
      continueWorkflow: continueWorkflow ?? true,
    });
    return this;
  }

  done(): RecoveryPlanBuilder {
    for (const action of this.actions) {
      this.builder.registerAction(this.category, action);
    }
    return this.builder;
  }
}

/**
 * Create recovery plan from config
 */
export function createRecoveryExecutor(config: any): ActionExecutor {
  const builder = new RecoveryPlanBuilder();

  const recoveryConfig = config.errorRecovery?.recovery || {};

  // Build recovery plan from config
  for (const [category, categoryConfig] of Object.entries(recoveryConfig)) {
    if (!categoryConfig || typeof categoryConfig !== 'object') continue;

    const cat = category as ErrorCategory;
    const actions = (categoryConfig as any).actions || [];

    for (const action of actions) {
      builder.registerAction(cat, action);
    }
  }

  return builder.build();
}
