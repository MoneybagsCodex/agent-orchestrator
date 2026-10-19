/**
 * Decides when the orchestrator's context is compacted. Pure: no clock, process, or file access,
 * so the rules are testable without a live Claude session.
 *
 * Why this exists: auto-compact used to run only at a turn end. A busy orchestrator never reaches
 * one, so context grew past the threshold with no compaction. The watchdog covers the other failure:
 * a compact that never reports back leaves the in-progress flag stuck, which blocks every later try.
 */

/** A compact still in progress after this long is treated as stuck and cleared. */
export const COMPACT_WATCHDOG_MS = 7 * 60_000;
/** Once over the threshold while busy for this long, compact even though a turn is running. */
export const COMPACT_MAX_DEFER_MS = 10 * 60_000;
/** Minimum gap between compact attempts (a failed or no-op compact must not loop). */
export const COMPACT_RETRY_GAP_MS = 10 * 60_000;

export interface CompactInputs {
  /** Latest real context size in tokens. */
  ctxTokens: number;
  /** Auto-compact line from budgets. 0 disables the feature. */
  threshold: number;
  /** A compact was sent and has not reported back yet. */
  compacting: boolean;
  /** When the current compact was sent (ms). Only meaningful while compacting. */
  compactingSince: number;
  /** A session process exists. */
  hasProc: boolean;
  /** A turn is running. */
  busy: boolean;
  /** When the current busy stretch started (ms), or 0 if idle. */
  busySince: number;
  /** When the last compact attempt was sent (ms), or 0. */
  lastTry: number;
  now: number;
}

export type CompactAction = 'none' | 'clear-stuck' | 'compact-idle' | 'compact-deferred';

export function decideCompact(s: CompactInputs): CompactAction {
  if (!s.threshold || !s.hasProc) return 'none';
  if (s.compacting) return s.now - s.compactingSince > COMPACT_WATCHDOG_MS ? 'clear-stuck' : 'none';
  if (s.ctxTokens < s.threshold) return 'none';
  if (s.lastTry && s.now - s.lastTry < COMPACT_RETRY_GAP_MS) return 'none';
  if (!s.busy) return 'compact-idle';
  if (s.busySince && s.now - s.busySince >= COMPACT_MAX_DEFER_MS) return 'compact-deferred';
  return 'none';
}
