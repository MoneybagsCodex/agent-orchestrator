import { describe, it, expect } from 'vitest';
import { hasRunningAgents } from './insights';

describe('hasRunningAgents (listener alert gate)', () => {
  it('is false when only idle sessions exist, so the "listener stuck" alert stays quiet', () => {
    expect(hasRunningAgents([{ state: 'IDLE' }, { state: 'IDLE' }])).toBe(false);
  });

  it('is false with no agents at all', () => {
    expect(hasRunningAgents([])).toBe(false);
  });

  it('is true while an agent is working', () => {
    expect(hasRunningAgents([{ state: 'IDLE' }, { state: 'WORKING' }])).toBe(true);
  });

  it('is true while an agent is blocked on a prompt, where approvals are expected', () => {
    expect(hasRunningAgents([{ state: 'BLOCKED' }])).toBe(true);
  });
});
