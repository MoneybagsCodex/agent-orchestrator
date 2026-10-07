/**
 * Error Recovery System: Error Categorization & Classification
 *
 * Provides intelligent error detection and categorization across:
 * - Claude API errors
 * - File system errors
 * - Network errors
 * - Agent communication errors
 * - System infrastructure errors
 * - User input errors
 *
 * Maps each error to a category (TRANSIENT, PERMANENT, AGENT_SPECIFIC, SYSTEM, USER)
 * and determines the appropriate recovery strategy.
 */

import { createHash } from 'crypto';

// ================================================================ Error Categories & Types
export enum ErrorCategory {
  TRANSIENT = 'transient',
  PERMANENT = 'permanent',
  AGENT_SPECIFIC = 'agent-specific',
  SYSTEM = 'system',
  USER = 'user',
}

export interface ErrorRecord {
  id: string;                         // Unique error instance ID (UUID)
  category: ErrorCategory;
  code?: string;                      // Error code if available (e.g., "ECONNREFUSED", "429")
  message: string;                    // Error message (first 500 chars)
  source: string;                     // Where error originated
  context?: {
    agentId?: string;
    operationName?: string;
    commandLine?: string;
    filePath?: string;
    statusCode?: number;
    retryable?: boolean;
  };
  firstSeenAt: number;
  lastSeenAt: number;
  occurrenceCount: number;
  recoverable: boolean;
  suggestedAction: string;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
  maxBackoffMs: number;
  timeoutMs: number;
}

// ================================================================ Error Detection Patterns

// TRANSIENT Error Patterns (10+)
const TRANSIENT_PATTERNS = [
  { test: (e: any) => e?.status === 'rate_limit_exceeded' || e?.status === 429, desc: 'Rate limit exceeded' },
  { test: (e: any) => e?.status === 'overloaded' || e?.status === 503, desc: 'Service overloaded' },
  { test: (e: any) => e?.status === 'timeout' || e?.type === 'timeout_error', desc: 'API timeout' },
  { test: (e: any) => e?.code === 'ETIMEDOUT' || /timeout/i.test(String(e?.message)), desc: 'Connection timeout' },
  { test: (e: any) => e?.code === 'ECONNREFUSED' || /connection refused/i.test(String(e?.message)), desc: 'Connection refused' },
  { test: (e: any) => e?.code === 'ECONNRESET' || /connection reset/i.test(String(e?.message)), desc: 'Connection reset by peer' },
  { test: (e: any) => e?.code === 'ENOTFOUND' || /getaddrinfo|not found/i.test(String(e?.message)), desc: 'DNS resolution failed' },
  { test: (e: any) => e?.code === 'EAGAIN' || /try again/i.test(String(e?.message)), desc: 'Try again later' },
  { test: (e: any) => /temporarily unavailable|temporarily_unavailable|service unavailable/i.test(String(e?.message)), desc: 'Temporarily unavailable' },
  { test: (e: any) => e?.status === 502 || e?.status === 504, desc: 'Gateway or gateway timeout' },
  { test: (e: any) => /ERR_HTTP2_STREAM_RESET|stream.*reset/i.test(String(e?.message)), desc: 'HTTP/2 stream reset' },
  { test: (e: any) => /EHOSTUNREACH|host.*unreachable/i.test(String(e?.message)), desc: 'Host unreachable' },
];

// PERMANENT Error Patterns (10+)
const PERMANENT_PATTERNS = [
  { test: (e: any) => e?.code === 'EACCES' || /permission denied/i.test(String(e?.message)), desc: 'Permission denied' },
  { test: (e: any) => e?.code === 'ENOENT' || /no such file|ENOENT|file.*not found|path.*not found/i.test(String(e?.message)), desc: 'File or directory not found' },
  { test: (e: any) => e?.code === 'EISDIR' || /is a directory/i.test(String(e?.message)), desc: 'Is a directory (wrong type)' },
  { test: (e: any) => e?.code === 'EEXIST' || /already exists/i.test(String(e?.message)), desc: 'File already exists' },
  { test: (e: any) => e?.code === 'EPERM' || /operation not permitted/i.test(String(e?.message)), desc: 'Operation not permitted' },
  { test: (e: any) => e?.status === 400 || e?.status === 'invalid_request_error', desc: 'Invalid request' },
  { test: (e: any) => e?.status === 401 || e?.status === 'authentication_error', desc: 'Authentication failed' },
  { test: (e: any) => e?.status === 403 || e?.status === 'permission_error', desc: 'Forbidden (insufficient permissions)' },
  { test: (e: any) => e?.status === 404 || e?.status === 'not_found_error', desc: 'Resource not found' },
  { test: (e: any) => /syntax error|parse error|invalid json/i.test(String(e?.message)), desc: 'Syntax or parse error' },
  { test: (e: any) => /enametoolong|name too long/i.test(String(e?.message)), desc: 'File path too long' },
  { test: (e: any) => /directory not empty|enotempty/i.test(String(e?.message)), desc: 'Directory not empty' },
];

// AGENT_SPECIFIC Error Patterns (8+)
// Note: These must be more specific than PERMANENT patterns to avoid false matches
const AGENT_SPECIFIC_PATTERNS = [
  { test: (e: any) => /tool.*not available|unknown tool/i.test(String(e?.message)), desc: 'Tool not available' },
  { test: (e: any) => /invalid tool|tool.*error|tool.*failed/i.test(String(e?.message)), desc: 'Tool execution failed' },
  { test: (e: any) => /tool.*timeout|execution.*timeout/i.test(String(e?.message)), desc: 'Tool timeout' },
  // Match "Invalid context" explicitly to avoid matching on just "invalid"
  { test: (e: any) => /invalid\s+context|context\s+error|lost\s+context|session\s+not\s+found/i.test(String(e?.message)), desc: 'Invalid or lost context' },
  { test: (e: any) => /agent.*crashed|agent.*died|process.*exited/i.test(String(e?.message)), desc: 'Agent process crashed' },
  { test: (e: any) => /agent.*unresponsive|agent.*not responding|agent.*no reply/i.test(String(e?.message)), desc: 'Agent not responding' },
  // Match "message refused" or "refused by agent" but require "message" or "agent" context
  { test: (e: any) => /message.*refused|refused.*message|refused\s+by\s+agent/i.test(String(e?.message)), desc: 'Agent refused message' },
  { test: (e: any) => /agent.*output|output.*error|malformed.*response/i.test(String(e?.message)), desc: 'Agent output invalid' },
];

// SYSTEM Error Patterns (8+)
const SYSTEM_PATTERNS = [
  { test: (e: any) => e?.code === 'ENOMEM' || /out of memory|enomem/i.test(String(e?.message)), desc: 'Out of memory' },
  { test: (e: any) => e?.code === 'ENOSPC' || /disk full|no space left/i.test(String(e?.message)), desc: 'Disk full' },
  { test: (e: any) => /max retries exceeded|retry limit/i.test(String(e?.message)), desc: 'Max retries exceeded' },
  { test: (e: any) => /cpu.*overload|system load/i.test(String(e?.message)), desc: 'CPU overload' },
  { test: (e: any) => /killed|SIGKILL|SIGTERM|signal/i.test(String(e?.message)), desc: 'Process killed by signal' },
  { test: (e: any) => /circuit breaker.*open|fallback fail/i.test(String(e?.message)), desc: 'Circuit breaker open' },
  { test: (e: any) => /emfile|too many open files/i.test(String(e?.message)), desc: 'Too many open files' },
  { test: (e: any) => /child process.*exit|eof|unexpected end/i.test(String(e?.message)), desc: 'Child process error' },
];

// USER Error Patterns (5+)
const USER_PATTERNS = [
  { test: (e: any) => /ambiguous|unclear|which one|multiple.*match/i.test(String(e?.message)), desc: 'Ambiguous instruction' },
  { test: (e: any) => /incomplete|missing.*parameter|required.*missing/i.test(String(e?.message)), desc: 'Missing required parameter' },
  { test: (e: any) => /conflicting|contradiction|mutually exclusive/i.test(String(e?.message)), desc: 'Conflicting instructions' },
  { test: (e: any) => /invalid.*format|malformed|bad.*syntax/i.test(String(e?.message)), desc: 'Invalid format or syntax' },
  { test: (e: any) => /clarif|explain|help me understand|not clear/i.test(String(e?.message)), desc: 'Unclear intent' },
];

// ================================================================ Core Categorization Logic

/**
 * Generates a unique ID for an error instance
 */
function generateErrorId(): string {
  return `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Test a pattern detector against an error
 */
function testPattern(pattern: { test: (e: any) => boolean; desc: string }, error: any): boolean {
  try {
    return pattern.test(error);
  } catch {
    return false;
  }
}

/**
 * Extract error code from various error formats
 */
function extractCode(error: any): string | undefined {
  if (typeof error?.code === 'string') return error.code;
  if (typeof error?.errno === 'number') return String(error.errno);
  if (typeof error?.status === 'number') return String(error.status);
  return undefined;
}

/**
 * Extract error message from various error formats
 */
function extractMessage(error: any): string {
  if (typeof error === 'string') return error.slice(0, 500);
  if (typeof error?.message === 'string') return error.message.slice(0, 500);
  if (typeof error?.error === 'string') return error.error.slice(0, 500);
  if (error?.response?.data?.error?.message) return String(error.response.data.error.message).slice(0, 500);
  try { return JSON.stringify(error).slice(0, 500); } catch { return String(error ?? '').slice(0, 500); }
}

/**
 * Determine error source from error properties and context
 */
function determineSource(error: any, context?: any): string {
  if (context?.source) return context.source;
  // Check network errors first (before file-system, since ECONNREFUSED starts with E)
  if (error?.code?.includes('CONN') || error?.code?.includes('HOST') || error?.code?.includes('NOTFOUND')) return 'network';
  if (error?.code?.startsWith('E')) return 'file-system';
  if (error?.status === 429 || error?.status === 503) return 'claude-api';
  if (error?.type === 'timeout_error') return 'claude-api';
  if (error?.signal) return 'process';
  if (context?.agentId) return 'agent-communication';
  return 'unknown';
}

/**
 * Categorize an error into one of five categories
 * Primary: Scan patterns in order (fail-safe: USER before PERMANENT)
 */
export function categorizeError(error: any, context?: any): ErrorRecord {
  const id = generateErrorId();
  const code = extractCode(error);
  const message = extractMessage(error);
  const source = determineSource(error, context);
  const now = Math.floor(Date.now() / 1000);

  // Check USER patterns first (fail-safe: user errors should be caught early)
  for (const pattern of USER_PATTERNS) {
    if (testPattern(pattern, error) || testPattern(pattern, message)) {
      return {
        id, category: ErrorCategory.USER, code, message, source, context, firstSeenAt: now, lastSeenAt: now,
        occurrenceCount: 1, recoverable: false, suggestedAction: pattern.desc,
      };
    }
  }

  // Check PERMANENT patterns (fail-safe: permanent errors take precedence over transient)
  for (const pattern of PERMANENT_PATTERNS) {
    if (testPattern(pattern, error) || testPattern(pattern, message)) {
      return {
        id, category: ErrorCategory.PERMANENT, code, message, source, context, firstSeenAt: now, lastSeenAt: now,
        occurrenceCount: 1, recoverable: false, suggestedAction: pattern.desc,
      };
    }
  }

  // Check AGENT_SPECIFIC patterns
  for (const pattern of AGENT_SPECIFIC_PATTERNS) {
    if (testPattern(pattern, error) || testPattern(pattern, message)) {
      return {
        id, category: ErrorCategory.AGENT_SPECIFIC, code, message, source, context, firstSeenAt: now, lastSeenAt: now,
        occurrenceCount: 1, recoverable: true, suggestedAction: pattern.desc,
      };
    }
  }

  // Check SYSTEM patterns
  for (const pattern of SYSTEM_PATTERNS) {
    if (testPattern(pattern, error) || testPattern(pattern, message)) {
      return {
        id, category: ErrorCategory.SYSTEM, code, message, source, context, firstSeenAt: now, lastSeenAt: now,
        occurrenceCount: 1, recoverable: true, suggestedAction: pattern.desc,
      };
    }
  }

  // Check TRANSIENT patterns
  for (const pattern of TRANSIENT_PATTERNS) {
    if (testPattern(pattern, error) || testPattern(pattern, message)) {
      return {
        id, category: ErrorCategory.TRANSIENT, code, message, source, context, firstSeenAt: now, lastSeenAt: now,
        occurrenceCount: 1, recoverable: true, suggestedAction: pattern.desc,
      };
    }
  }

  // Default: Unknown error → categorize as TRANSIENT (safer to retry once than escalate immediately)
  return {
    id, category: ErrorCategory.TRANSIENT, code, message, source, context, firstSeenAt: now, lastSeenAt: now,
    occurrenceCount: 1, recoverable: true, suggestedAction: 'Unknown error; will retry once before escalation',
  };
}

/**
 * Get retry policy for a given error category
 */
export function getRetryPolicy(category: ErrorCategory): RetryPolicy {
  const policies: Record<ErrorCategory, RetryPolicy> = {
    [ErrorCategory.TRANSIENT]: {
      maxRetries: 4,
      backoffMs: 500,
      backoffMultiplier: 2,
      jitterFactor: 0.3,
      maxBackoffMs: 32000,
      timeoutMs: 30000,
    },
    [ErrorCategory.PERMANENT]: {
      maxRetries: 0,
      backoffMs: 0,
      backoffMultiplier: 1,
      jitterFactor: 0,
      maxBackoffMs: 0,
      timeoutMs: 30000,
    },
    [ErrorCategory.AGENT_SPECIFIC]: {
      maxRetries: 2,
      backoffMs: 1000,
      backoffMultiplier: 1.5,
      jitterFactor: 0.2,
      maxBackoffMs: 10000,
      timeoutMs: 15000,
    },
    [ErrorCategory.SYSTEM]: {
      maxRetries: 1,
      backoffMs: 2000,
      backoffMultiplier: 1,
      jitterFactor: 0,
      maxBackoffMs: 2000,
      timeoutMs: 60000,
    },
    [ErrorCategory.USER]: {
      maxRetries: 0,
      backoffMs: 0,
      backoffMultiplier: 1,
      jitterFactor: 0,
      maxBackoffMs: 0,
      timeoutMs: 30000,
    },
  };
  return policies[category] || policies[ErrorCategory.TRANSIENT];
}

/**
 * Calculate backoff time with exponential increase and jitter
 * Prevents thundering herd when multiple processes retry simultaneously
 */
export function calculateBackoff(attempt: number, policy: RetryPolicy): number {
  if (policy.maxRetries === 0) return 0;

  // Exponential backoff: base * (multiplier ^ attempt)
  const exponential = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt);
  const capped = Math.min(exponential, policy.maxBackoffMs);

  // Add jitter: ±(jitterFactor * capped), cap result at maxBackoffMs
  if (policy.jitterFactor === 0) return Math.round(capped);
  const jitter = capped * policy.jitterFactor * (Math.random() - 0.5) * 2;
  return Math.max(0, Math.min(policy.maxBackoffMs, Math.round(capped + jitter)));
}

/**
 * Format error for logging with [error-recovery-*] tag
 */
export function formatErrorLog(error: ErrorRecord, tag: string): string {
  return `[error-recovery-${tag}] ${error.id}: ${error.source}/${error.category} code=${error.code ?? 'N/A'} "${error.message.slice(0, 80)}"`;
}

/**
 * Get recovery action recommendation for an error category
 */
export function getRecoveryAction(category: ErrorCategory): string {
  const actions: Record<ErrorCategory, string> = {
    [ErrorCategory.TRANSIENT]: 'retry',
    [ErrorCategory.PERMANENT]: 'escalate',
    [ErrorCategory.AGENT_SPECIFIC]: 'fallback',
    [ErrorCategory.SYSTEM]: 'degrade',
    [ErrorCategory.USER]: 'escalate',
  };
  return actions[category];
}

/**
 * Parse error patterns from a large text blob (e.g., stderr output)
 * Returns first matching error or null
 */
export function parseErrorFromText(text: string): ErrorRecord | null {
  if (!text || typeof text !== 'string') return null;

  // Try to extract HTTP status codes or error codes from text
  const statusMatch = text.match(/HTTP\s+(\d{3})|status[:\s]+(\d{3})/i);
  const statusCode = statusMatch ? parseInt(statusMatch[1] || statusMatch[2]) : undefined;

  const errorObj: any = { message: text };
  if (statusCode) errorObj.status = statusCode;

  // Quick scan through all patterns
  for (const pattern of [...PERMANENT_PATTERNS, ...USER_PATTERNS, ...AGENT_SPECIFIC_PATTERNS, ...SYSTEM_PATTERNS, ...TRANSIENT_PATTERNS]) {
    try {
      if (pattern.test(errorObj)) {
        return categorizeError(errorObj);
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ================================================================ Exports

export const errorRecovery = {
  categorizeError,
  getRetryPolicy,
  calculateBackoff,
  formatErrorLog,
  getRecoveryAction,
  parseErrorFromText,
  ErrorCategory,
  TRANSIENT_PATTERNS: TRANSIENT_PATTERNS.length,
  PERMANENT_PATTERNS: PERMANENT_PATTERNS.length,
  AGENT_SPECIFIC_PATTERNS: AGENT_SPECIFIC_PATTERNS.length,
  SYSTEM_PATTERNS: SYSTEM_PATTERNS.length,
  USER_PATTERNS: USER_PATTERNS.length,
  TOTAL_PATTERNS: TRANSIENT_PATTERNS.length + PERMANENT_PATTERNS.length + AGENT_SPECIFIC_PATTERNS.length + SYSTEM_PATTERNS.length + USER_PATTERNS.length,
};
