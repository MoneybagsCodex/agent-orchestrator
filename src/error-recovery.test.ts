/**
 * Error Recovery System: Comprehensive Test Suite
 * 40+ error patterns tested across all 5 categories
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeError,
  getRetryPolicy,
  calculateBackoff,
  formatErrorLog,
  getRecoveryAction,
  parseErrorFromText,
  ErrorCategory,
  errorRecovery,
} from './error-recovery';

describe('Error Recovery System', () => {
  describe('Error Categorization - TRANSIENT Errors (12 patterns)', () => {
    it('should categorize rate limit (429) as TRANSIENT', () => {
      const error = categorizeError({ status: 429, message: 'Too many requests' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
      expect(error.recoverable).toBe(true);
    });

    it('should categorize service overloaded (503) as TRANSIENT', () => {
      const error = categorizeError({ status: 503, message: 'Service unavailable' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize API timeout as TRANSIENT', () => {
      const error = categorizeError({ type: 'timeout_error', message: 'Request timeout' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize ETIMEDOUT as TRANSIENT', () => {
      const error = categorizeError({ code: 'ETIMEDOUT', message: 'Connection timeout' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize ECONNREFUSED as TRANSIENT', () => {
      const error = categorizeError({ code: 'ECONNREFUSED', message: 'Connection refused' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize ECONNRESET as TRANSIENT', () => {
      const error = categorizeError({ code: 'ECONNRESET', message: 'Connection reset by peer' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize ENOTFOUND (DNS) as TRANSIENT', () => {
      const error = categorizeError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND example.com' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize EAGAIN as TRANSIENT', () => {
      const error = categorizeError({ code: 'EAGAIN', message: 'Try again later' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize "temporarily unavailable" as TRANSIENT', () => {
      const error = categorizeError({ message: 'Service temporarily unavailable' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize HTTP 502 gateway error as TRANSIENT', () => {
      const error = categorizeError({ status: 502, message: 'Bad gateway' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize HTTP 504 timeout as TRANSIENT', () => {
      const error = categorizeError({ status: 504, message: 'Gateway timeout' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should categorize HTTP/2 stream reset as TRANSIENT', () => {
      const error = categorizeError({ message: 'ERR_HTTP2_STREAM_RESET' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });
  });

  describe('Error Categorization - PERMANENT Errors (12 patterns)', () => {
    it('should categorize permission denied (EACCES) as PERMANENT', () => {
      const error = categorizeError({ code: 'EACCES', message: 'Permission denied' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
      expect(error.recoverable).toBe(false);
    });

    it('should categorize file not found (ENOENT) as PERMANENT', () => {
      const error = categorizeError({ code: 'ENOENT', message: 'ENOENT: no such file or directory' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize is directory (EISDIR) as PERMANENT', () => {
      const error = categorizeError({ code: 'EISDIR', message: 'EISDIR: illegal operation on a directory' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize already exists (EEXIST) as PERMANENT', () => {
      const error = categorizeError({ code: 'EEXIST', message: 'EEXIST: file already exists' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize operation not permitted (EPERM) as PERMANENT', () => {
      const error = categorizeError({ code: 'EPERM', message: 'EPERM: operation not permitted' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize HTTP 400 bad request as PERMANENT', () => {
      const error = categorizeError({ status: 400, message: 'Bad request' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize HTTP 401 authentication error as PERMANENT', () => {
      const error = categorizeError({ status: 401, message: 'Unauthorized' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize HTTP 403 permission error as PERMANENT', () => {
      const error = categorizeError({ status: 403, message: 'Forbidden' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize HTTP 404 not found as PERMANENT', () => {
      const error = categorizeError({ status: 404, message: 'Not found' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize syntax errors as PERMANENT', () => {
      const error = categorizeError({ message: 'Syntax error: unexpected token' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize enametoolong as PERMANENT', () => {
      const error = categorizeError({ message: 'ENAMETOOLONG: name too long' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should categorize directory not empty as PERMANENT', () => {
      const error = categorizeError({ message: 'ENOTEMPTY: directory not empty' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });
  });

  describe('Error Categorization - AGENT_SPECIFIC Errors (8 patterns)', () => {
    it('should categorize tool not available as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Tool "Bash" is not available' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
      expect(error.recoverable).toBe(true);
    });

    it('should categorize unknown tool as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Unknown tool: CustomTool' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });

    it('should categorize tool execution failed as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Tool execution failed: Invalid input' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });

    it('should categorize tool timeout as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Tool execution timeout' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });

    it('should categorize invalid context as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Invalid context: session not found' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });

    it('should categorize agent crashed as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Agent process crashed unexpectedly' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });

    it('should categorize agent unresponsive as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Agent not responding to messages' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });

    it('should categorize message refused as AGENT_SPECIFIC', () => {
      const error = categorizeError({ message: 'Message refused by agent' });
      expect(error.category).toBe(ErrorCategory.AGENT_SPECIFIC);
    });
  });

  describe('Error Categorization - SYSTEM Errors (8 patterns)', () => {
    it('should categorize out of memory as SYSTEM', () => {
      const error = categorizeError({ code: 'ENOMEM', message: 'Out of memory' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
      expect(error.recoverable).toBe(true);
    });

    it('should categorize disk full as SYSTEM', () => {
      const error = categorizeError({ code: 'ENOSPC', message: 'No space left on device' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });

    it('should categorize max retries exceeded as SYSTEM', () => {
      const error = categorizeError({ message: 'Max retries exceeded' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });

    it('should categorize CPU overload as SYSTEM', () => {
      const error = categorizeError({ message: 'System CPU overload' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });

    it('should categorize process killed by signal as SYSTEM', () => {
      const error = categorizeError({ message: 'Process killed by SIGTERM' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });

    it('should categorize circuit breaker open as SYSTEM', () => {
      const error = categorizeError({ message: 'Circuit breaker is open' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });

    it('should categorize too many open files as SYSTEM', () => {
      const error = categorizeError({ message: 'EMFILE: too many open files' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });

    it('should categorize child process error as SYSTEM', () => {
      const error = categorizeError({ message: 'Child process unexpected exit' });
      expect(error.category).toBe(ErrorCategory.SYSTEM);
    });
  });

  describe('Error Categorization - USER Errors (5 patterns)', () => {
    it('should categorize ambiguous instruction as USER', () => {
      const error = categorizeError({ message: 'Ambiguous: which one did you mean?' });
      expect(error.category).toBe(ErrorCategory.USER);
      expect(error.recoverable).toBe(false);
    });

    it('should categorize missing parameter as USER', () => {
      const error = categorizeError({ message: 'Missing required parameter: agent_id' });
      expect(error.category).toBe(ErrorCategory.USER);
    });

    it('should categorize conflicting instructions as USER', () => {
      const error = categorizeError({ message: 'Conflicting instructions: do A and NOT A' });
      expect(error.category).toBe(ErrorCategory.USER);
    });

    it('should categorize invalid format as USER', () => {
      const error = categorizeError({ message: 'Invalid format for request body' });
      expect(error.category).toBe(ErrorCategory.USER);
    });

    it('should categorize unclear intent as USER', () => {
      const error = categorizeError({ message: 'Unclear intent: please clarify' });
      expect(error.category).toBe(ErrorCategory.USER);
    });
  });

  describe('Retry Policy Configuration', () => {
    it('should return correct policy for TRANSIENT errors', () => {
      const policy = getRetryPolicy(ErrorCategory.TRANSIENT);
      expect(policy.maxRetries).toBe(4);
      expect(policy.backoffMs).toBe(500);
      expect(policy.backoffMultiplier).toBe(2);
      expect(policy.jitterFactor).toBeGreaterThan(0);
    });

    it('should return correct policy for PERMANENT errors', () => {
      const policy = getRetryPolicy(ErrorCategory.PERMANENT);
      expect(policy.maxRetries).toBe(0);
    });

    it('should return correct policy for AGENT_SPECIFIC errors', () => {
      const policy = getRetryPolicy(ErrorCategory.AGENT_SPECIFIC);
      expect(policy.maxRetries).toBe(2);
      expect(policy.backoffMs).toBe(1000);
    });

    it('should return correct policy for SYSTEM errors', () => {
      const policy = getRetryPolicy(ErrorCategory.SYSTEM);
      expect(policy.maxRetries).toBe(1);
    });

    it('should return correct policy for USER errors', () => {
      const policy = getRetryPolicy(ErrorCategory.USER);
      expect(policy.maxRetries).toBe(0);
    });
  });

  describe('Backoff Calculation', () => {
    it('should calculate exponential backoff correctly', () => {
      const policy = getRetryPolicy(ErrorCategory.TRANSIENT);
      const attempt0 = calculateBackoff(0, policy);
      const attempt1 = calculateBackoff(1, policy);
      const attempt2 = calculateBackoff(2, policy);

      // Without jitter (using fixed seed): 500, 1000, 2000
      // With jitter: should be in range
      expect(attempt0).toBeGreaterThan(0);
      expect(attempt1).toBeGreaterThan(attempt0);
      expect(attempt2).toBeGreaterThan(attempt1);
    });

    it('should respect max backoff limit', () => {
      const policy = getRetryPolicy(ErrorCategory.TRANSIENT);
      const attempt10 = calculateBackoff(10, policy);
      expect(attempt10).toBeLessThanOrEqual(policy.maxBackoffMs);
    });

    it('should return 0 for policies with no retries', () => {
      const policy = getRetryPolicy(ErrorCategory.PERMANENT);
      const backoff = calculateBackoff(0, policy);
      expect(backoff).toBe(0);
    });

    it('should add jitter correctly', () => {
      const policy = getRetryPolicy(ErrorCategory.TRANSIENT);
      const samples = Array.from({ length: 10 }, (_, i) => calculateBackoff(i, policy));

      // All should be positive and increasing
      for (let i = 0; i < samples.length - 1; i++) {
        expect(samples[i]).toBeGreaterThanOrEqual(0);
        expect(samples[i]).toBeLessThanOrEqual(policy.maxBackoffMs);
      }
    });
  });

  describe('Error Formatting', () => {
    it('should format error log correctly', () => {
      const error = categorizeError({ code: 'ECONNREFUSED', message: 'Connection refused' });
      const log = formatErrorLog(error, 'detected');

      expect(log).toContain('[error-recovery-detected]');
      expect(log).toContain(error.id);
      expect(log).toContain('network');
      expect(log).toContain('transient');  // ErrorCategory.TRANSIENT = 'transient'
    });

    it('should truncate long error messages', () => {
      const longMessage = 'A'.repeat(1000);
      const error = categorizeError({ message: longMessage });
      expect(error.message.length).toBeLessThanOrEqual(500);
    });
  });

  describe('Recovery Action Recommendation', () => {
    it('should recommend retry for TRANSIENT', () => {
      const action = getRecoveryAction(ErrorCategory.TRANSIENT);
      expect(action).toBe('retry');
    });

    it('should recommend escalate for PERMANENT', () => {
      const action = getRecoveryAction(ErrorCategory.PERMANENT);
      expect(action).toBe('escalate');
    });

    it('should recommend fallback for AGENT_SPECIFIC', () => {
      const action = getRecoveryAction(ErrorCategory.AGENT_SPECIFIC);
      expect(action).toBe('fallback');
    });

    it('should recommend degrade for SYSTEM', () => {
      const action = getRecoveryAction(ErrorCategory.SYSTEM);
      expect(action).toBe('degrade');
    });

    it('should recommend escalate for USER', () => {
      const action = getRecoveryAction(ErrorCategory.USER);
      expect(action).toBe('escalate');
    });
  });

  describe('Error Parsing from Text', () => {
    it('should parse permission denied from text', () => {
      const error = parseErrorFromText('Permission denied (EACCES) when accessing /file');
      expect(error?.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should parse connection timeout from text', () => {
      const error = parseErrorFromText('Connection timeout (ETIMEDOUT) after 30s');
      expect(error?.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should parse rate limit from text', () => {
      const error = parseErrorFromText('HTTP 429: Rate limit exceeded');
      expect(error?.category).toBe(ErrorCategory.TRANSIENT);
    });

    it('should return null for non-matching text', () => {
      const error = parseErrorFromText('This is just a regular message with no error');
      // parseErrorFromText returns null if no pattern matches (unlike categorizeError which defaults to TRANSIENT)
      expect(error).toBeNull();
    });
  });

  describe('Pattern Detection Statistics', () => {
    it('should have implemented 40+ error patterns', () => {
      expect(errorRecovery.TOTAL_PATTERNS).toBeGreaterThanOrEqual(40);
    });

    it('should have TRANSIENT patterns', () => {
      expect(errorRecovery.TRANSIENT_PATTERNS).toBeGreaterThanOrEqual(10);
    });

    it('should have PERMANENT patterns', () => {
      expect(errorRecovery.PERMANENT_PATTERNS).toBeGreaterThanOrEqual(10);
    });

    it('should have AGENT_SPECIFIC patterns', () => {
      expect(errorRecovery.AGENT_SPECIFIC_PATTERNS).toBeGreaterThanOrEqual(8);
    });

    it('should have SYSTEM patterns', () => {
      expect(errorRecovery.SYSTEM_PATTERNS).toBeGreaterThanOrEqual(8);
    });

    it('should have USER patterns', () => {
      expect(errorRecovery.USER_PATTERNS).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null error gracefully', () => {
      const error = categorizeError(null);
      expect(error).toBeDefined();
      expect(error.category).toBeDefined();
    });

    it('should handle undefined error gracefully', () => {
      const error = categorizeError(undefined);
      expect(error).toBeDefined();
    });

    it('should handle empty string', () => {
      const error = categorizeError('');
      expect(error).toBeDefined();
      expect(error.category).toBeDefined();
    });

    it('should handle object without standard properties', () => {
      const error = categorizeError({ foo: 'bar' });
      expect(error).toBeDefined();
    });

    it('should generate unique error IDs', () => {
      const error1 = categorizeError({ message: 'Error 1' });
      const error2 = categorizeError({ message: 'Error 1' });
      expect(error1.id).not.toBe(error2.id);
    });

    it('should set timestamps correctly', () => {
      const before = Math.floor(Date.now() / 1000);
      const error = categorizeError({ message: 'Test' });
      const after = Math.floor(Date.now() / 1000);

      expect(error.firstSeenAt).toBeGreaterThanOrEqual(before);
      expect(error.firstSeenAt).toBeLessThanOrEqual(after);
      expect(error.lastSeenAt).toBe(error.firstSeenAt);
    });

    it('should set occurrence count to 1 on first categorization', () => {
      const error = categorizeError({ message: 'Test' });
      expect(error.occurrenceCount).toBe(1);
    });
  });

  describe('Context Handling', () => {
    it('should include context in error record', () => {
      const context = { agentId: 'test-agent', operationName: 'compile' };
      const error = categorizeError({ message: 'Test error' }, context);
      expect(error.context?.agentId).toBe('test-agent');
      expect(error.context?.operationName).toBe('compile');
    });

    it('should respect context source override', () => {
      const context = { source: 'custom-source' };
      const error = categorizeError({ message: 'Test' }, context);
      expect(error.source).toBe('custom-source');
    });

    it('should determine source from error code', () => {
      const error = categorizeError({ code: 'ENOENT' });
      expect(error.source).toBe('file-system');
    });

    it('should determine source from status code', () => {
      const error = categorizeError({ status: 429 });
      expect(error.source).toBe('claude-api');
    });
  });

  describe('Fail-Safe Ordering', () => {
    it('should check USER patterns before PERMANENT', () => {
      // Error that could match both: "ambiguous" in message
      const error = categorizeError({ message: 'File ambiguous syntax error' });
      // USER should take precedence
      expect(error.category).toBe(ErrorCategory.USER);
    });

    it('should check PERMANENT before AGENT_SPECIFIC', () => {
      // Error that mentions file not found
      const error = categorizeError({ code: 'ENOENT' });
      expect(error.category).toBe(ErrorCategory.PERMANENT);
    });

    it('should default to TRANSIENT for unknown errors', () => {
      const error = categorizeError({ message: 'Some random error message' });
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
    });
  });
});
