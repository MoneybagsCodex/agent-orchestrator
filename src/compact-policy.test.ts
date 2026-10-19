import { describe, it, expect } from 'vitest';
import { decideCompact, COMPACT_WATCHDOG_MS, COMPACT_MAX_DEFER_MS, COMPACT_RETRY_GAP_MS, type CompactInputs } from './compact-policy';

const NOW = 10_000_000_000;
const base: CompactInputs = {
  ctxTokens: 151_000, threshold: 150_000, compacting: false, compactingSince: 0,
  hasProc: true, busy: false, busySince: 0, lastTry: 0, now: NOW,
};

describe('decideCompact', () => {
  it('does nothing when the threshold is disabled or there is no process', () => {
    expect(decideCompact({ ...base, threshold: 0 })).toBe('none');
    expect(decideCompact({ ...base, hasProc: false })).toBe('none');
  });

  it('does nothing below the threshold', () => {
    expect(decideCompact({ ...base, ctxTokens: 149_999 })).toBe('none');
  });

  it('compacts at once when over the threshold and idle, which the turn-end check alone never did while busy', () => {
    expect(decideCompact(base)).toBe('compact-idle');
  });

  it('waits while busy, then forces a compact after the defer limit', () => {
    expect(decideCompact({ ...base, busy: true, busySince: NOW - 60_000 })).toBe('none');
    expect(decideCompact({ ...base, busy: true, busySince: NOW - COMPACT_MAX_DEFER_MS })).toBe('compact-deferred');
  });

  it('does not defer when the busy start time is not yet recorded', () => {
    expect(decideCompact({ ...base, busy: true, busySince: 0 })).toBe('none');
  });

  it('leaves an in-progress compact alone until the watchdog limit', () => {
    expect(decideCompact({ ...base, compacting: true, compactingSince: NOW - 60_000 })).toBe('none');
    expect(decideCompact({ ...base, compacting: true, compactingSince: NOW - COMPACT_WATCHDOG_MS - 1 })).toBe('clear-stuck');
  });

  it('keeps the retry gap after an attempt, so a no-op compact cannot loop', () => {
    expect(decideCompact({ ...base, lastTry: NOW - 60_000 })).toBe('none');
    expect(decideCompact({ ...base, lastTry: NOW - COMPACT_RETRY_GAP_MS })).toBe('compact-idle');
  });
});
