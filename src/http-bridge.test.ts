import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import { createBridge, type Bridge, type HttpBridgeConfig } from './http-bridge';

const config: HttpBridgeConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  maxTaskChars: 100,
  maxTasks: 3,
};

let bridge: Bridge;
let server: Server;
let base: string;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};

beforeAll(async () => {
  bridge = createBridge(config);
  server = await bridge.start();
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bridge did not bind a port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  bridge.tasks.length = 0;
  bridge.lastSeen.clear();
});

describe('POST /task', () => {
  it('creates a pending task and returns 201 with an id', async () => {
    const r = await call('POST', '/task', { agent: 'worker-1', task: 'Step 1: do it' });
    expect(r.status).toBe(201);
    expect(r.json.status).toBe('pending');
    expect(typeof r.json.id).toBe('string');
    expect(bridge.tasks).toHaveLength(1);
    expect(bridge.tasks[0].agent).toBe('worker-1');
  });

  it('rejects an invalid agent id with 400', async () => {
    const r = await call('POST', '/task', { agent: 'bad agent!', task: 'x' });
    expect(r.status).toBe(400);
    expect(bridge.tasks).toHaveLength(0);
  });

  it('rejects a missing or blank task with 400', async () => {
    expect((await call('POST', '/task', { agent: 'worker-1' })).status).toBe(400);
    expect((await call('POST', '/task', { agent: 'worker-1', task: '   ' })).status).toBe(400);
  });

  it('rejects a task longer than maxTaskChars with 413', async () => {
    const r = await call('POST', '/task', { agent: 'worker-1', task: 'x'.repeat(101) });
    expect(r.status).toBe(413);
    expect(bridge.tasks).toHaveLength(0);
  });

  it('evicts the oldest finished task when over maxTasks', async () => {
    const first = await call('POST', '/task', { agent: 'w', task: 'a' });
    await call('GET', '/task?agent=w');
    await call('POST', '/result', { taskId: first.json.id, agent: 'w', status: 'done', summary: 'ok' });
    await call('POST', '/task', { agent: 'w', task: 'b' });
    await call('POST', '/task', { agent: 'w', task: 'c' });
    await call('POST', '/task', { agent: 'w', task: 'd' });
    expect(bridge.tasks.map((t) => t.task)).toEqual(['b', 'c', 'd']);
  });
});

describe('GET /task', () => {
  it('returns task null when nothing is pending for the agent', async () => {
    const r = await call('GET', '/task?agent=nobody');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ task: null });
  });

  it('requires a valid agent query parameter', async () => {
    expect((await call('GET', '/task')).status).toBe(400);
    expect((await call('GET', '/task?agent=bad%20id')).status).toBe(400);
  });

  it('claims the oldest pending task once and marks it claimed', async () => {
    await call('POST', '/task', { agent: 'w', task: 'first' });
    await call('POST', '/task', { agent: 'w', task: 'second' });

    const r1 = await call('GET', '/task?agent=w');
    expect(r1.json.task.task).toBe('first');
    expect(r1.json.task.status).toBe('claimed');
    expect(typeof r1.json.task.claimedAt).toBe('string');

    const r2 = await call('GET', '/task?agent=w');
    expect(r2.json.task.task).toBe('second');

    const r3 = await call('GET', '/task?agent=w');
    expect(r3.json).toEqual({ task: null });
  });

  it('does not hand one agent a task addressed to another', async () => {
    await call('POST', '/task', { agent: 'alpha', task: 'for alpha' });
    const r = await call('GET', '/task?agent=beta');
    expect(r.json).toEqual({ task: null });
  });
});

describe('POST /result', () => {
  it('marks the task done with the summary and reporter', async () => {
    const created = await call('POST', '/task', { agent: 'w', task: 'work' });
    await call('GET', '/task?agent=w');
    const r = await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'done', summary: 'finished' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: created.json.id, status: 'done' });
    const stored = bridge.tasks[0];
    expect(stored.status).toBe('done');
    expect(stored.result).toEqual({ status: 'done', summary: 'finished', reportedBy: 'w' });
    expect(typeof stored.completedAt).toBe('string');
  });

  it('accepts status failed', async () => {
    const created = await call('POST', '/task', { agent: 'w', task: 'work' });
    const r = await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'failed', summary: 'broke' });
    expect(r.status).toBe(200);
    expect(bridge.tasks[0].status).toBe('failed');
  });

  it('returns 404 for an unknown task id', async () => {
    const r = await call('POST', '/result', { taskId: 'nope', agent: 'w', status: 'done', summary: 's' });
    expect(r.status).toBe(404);
  });

  it('returns 403 when a different agent reports the task', async () => {
    const created = await call('POST', '/task', { agent: 'owner', task: 'work' });
    const r = await call('POST', '/result', { taskId: created.json.id, agent: 'intruder', status: 'done', summary: 's' });
    expect(r.status).toBe(403);
    expect(bridge.tasks[0].status).toBe('pending');
  });

  it('returns 409 when the task was already reported', async () => {
    const created = await call('POST', '/task', { agent: 'w', task: 'work' });
    await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'done', summary: 's' });
    const r = await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'done', summary: 's2' });
    expect(r.status).toBe(409);
  });

  it('rejects a status other than done or failed with 400', async () => {
    const created = await call('POST', '/task', { agent: 'w', task: 'work' });
    const r = await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'maybe', summary: 's' });
    expect(r.status).toBe(400);
  });

  it('rejects a missing taskId with 400', async () => {
    const r = await call('POST', '/result', { agent: 'w', status: 'done', summary: 's' });
    expect(r.status).toBe(400);
  });
});

describe('GET /status', () => {
  it('reports zero counts when empty', async () => {
    const r = await call('GET', '/status');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.counts).toEqual({ pending: 0, claimed: 0, done: 0, failed: 0 });
    expect(r.json.total).toBe(0);
  });

  it('counts tasks by status across the whole store', async () => {
    const a = await call('POST', '/task', { agent: 'w', task: 'a' });
    await call('POST', '/task', { agent: 'w', task: 'b' });
    await call('GET', '/task?agent=w');
    await call('POST', '/result', { taskId: a.json.id, agent: 'w', status: 'done', summary: 's' });
    const r = await call('GET', '/status');
    expect(r.json.counts).toEqual({ pending: 1, claimed: 0, done: 1, failed: 0 });
    expect(r.json.total).toBe(2);
  });

  it('scopes counts to one agent when asked', async () => {
    await call('POST', '/task', { agent: 'alpha', task: 'a' });
    await call('POST', '/task', { agent: 'beta', task: 'b' });
    const r = await call('GET', '/status?agent=alpha');
    expect(r.json.total).toBe(1);
    expect(r.json.counts.pending).toBe(1);
  });

  it('records last-seen times for agents that polled or reported', async () => {
    await call('GET', '/task?agent=alpha');
    const r = await call('GET', '/status');
    expect(Object.keys(r.json.agents)).toContain('alpha');
    expect(typeof r.json.agents.alpha).toBe('string');
  });

  it('rejects an invalid agent query with 400', async () => {
    expect((await call('GET', '/status?agent=bad%20id')).status).toBe(400);
  });
});
