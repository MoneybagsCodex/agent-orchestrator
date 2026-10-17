import { describe, it, expect } from 'vitest';
import { createCapabilityRegistry, type AgentRegistryConfig } from './capability-registry';

const config: AgentRegistryConfig = {
  capabilityTTL: 60000,
  maxAgents: 3,
  maxListItems: 5,
};

const make = (clock = { t: 1_000_000 }) => ({ reg: createCapabilityRegistry(config, () => clock.t), clock });

describe('capability registry', () => {
  it('registers an agent and returns it with lowercased lists', () => {
    const { reg } = make();
    const r = reg.register({ name: 'w1', bash: true, fileOps: false, languages: ['TS'], tools: ['Vitest'] });
    expect(r.ok).toBe(true);
    expect(reg.getAllAgents()).toEqual([
      expect.objectContaining({ name: 'w1', bash: true, fileOps: false, languages: ['ts'], tools: ['vitest'], stale: false }),
    ]);
  });

  it('refreshing an agent replaces its capabilities instead of duplicating it', () => {
    const { reg } = make();
    reg.register({ name: 'w1', bash: true, fileOps: false });
    reg.register({ name: 'w1', bash: false, fileOps: true });
    const all = reg.getAllAgents();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ bash: false, fileOps: true });
  });

  it('rejects malformed input with a reason', () => {
    const { reg } = make();
    expect(reg.register(null)).toMatchObject({ ok: false });
    expect(reg.register({ name: 'bad name!', bash: true, fileOps: true })).toMatchObject({ ok: false });
    expect(reg.register({ name: 'w1', bash: 'yes', fileOps: true })).toMatchObject({ ok: false, error: 'bash must be boolean' });
    expect(reg.register({ name: 'w1', bash: true, fileOps: true, languages: 'ts' })).toMatchObject({ ok: false });
    expect(reg.register({ name: 'w1', bash: true, fileOps: true, tools: ['has space'] })).toMatchObject({ ok: false });
    expect(reg.register({ name: 'w1', bash: true, fileOps: true, tools: Array(6).fill('x') })).toMatchObject({ ok: false });
  });

  it('caps the number of agents, but still allows refreshing an existing one', () => {
    const { reg } = make();
    for (const n of ['a', 'b', 'c']) reg.register({ name: n, bash: true, fileOps: true });
    expect(reg.register({ name: 'd', bash: true, fileOps: true })).toMatchObject({ ok: false, error: 'registry is full (3 agents)' });
    expect(reg.register({ name: 'a', bash: false, fileOps: true }).ok).toBe(true);
  });

  it('marks agents stale after the TTL and excludes them from routing', () => {
    const { reg, clock } = make();
    reg.register({ name: 'w1', bash: true, fileOps: true });
    clock.t += 60000;
    expect(reg.getAllAgents()[0].stale).toBe(false);
    expect(reg.getAgentsByCapability('bash')).toHaveLength(1);
    clock.t += 1;
    expect(reg.getAllAgents()[0].stale).toBe(true);
    expect(reg.getAgentsByCapability('bash')).toEqual([]);
    expect(reg.satisfies('w1', 'bash')).toBe(false);
  });

  it('a refresh brings a stale agent back', () => {
    const { reg, clock } = make();
    reg.register({ name: 'w1', bash: true, fileOps: true });
    clock.t += 120000;
    reg.register({ name: 'w1', bash: true, fileOps: true });
    expect(reg.satisfies('w1', 'bash')).toBe(true);
  });

  it('matches shorthand and object requirements, requiring every listed item', () => {
    const { reg } = make();
    reg.register({ name: 'ts-runner', bash: true, fileOps: false, languages: ['ts'], tools: ['vitest'] });
    reg.register({ name: 'py-only', bash: false, fileOps: true, languages: ['py'] });

    const names = (req: Parameters<typeof reg.getAgentsByCapability>[0]) => reg.getAgentsByCapability(req).map((a) => a.name);
    expect(names('bash')).toEqual(['ts-runner']);
    expect(names('fileOps')).toEqual(['py-only']);
    expect(names('language:TS')).toEqual(['ts-runner']);
    expect(names('tool:vitest')).toEqual(['ts-runner']);
    expect(names({ languages: ['ts', 'py'] })).toEqual([]);
    expect(names({ bash: true, tools: ['vitest'] })).toEqual(['ts-runner']);
  });

  it('rejects unknown shorthand and bad object requirements', () => {
    const { reg } = make();
    expect(reg.normalize('deploy')).toMatchObject({ ok: false });
    expect(reg.normalize({ bash: 'yes' })).toMatchObject({ ok: false });
    expect(reg.normalize(42)).toMatchObject({ ok: false });
    expect(reg.getAgentsByCapability('deploy')).toEqual([]);
  });
});
