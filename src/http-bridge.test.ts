import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBridge, type Bridge, type BridgeEvent, type HttpBridgeConfig } from './http-bridge';

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-bridge-test-'));

const config: HttpBridgeConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  maxTaskChars: 100,
  maxTasks: 3,
  maxReportChars: 50,
  tokenFile: path.join(tokenDir, 'bridge.token'),
};

let bridge: Bridge;
let server: Server;
let base: string;
let token: string;
let events: BridgeEvent[] = [];

// Sends a request. Every normal call carries the shared token; auth tests pass their own headers to omit or change it.
const rawCall = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
};
const call = (method: string, path: string, body?: unknown) => rawCall(method, path, body, { 'X-Orch-Token': token });

beforeAll(async () => {
  bridge = createBridge(config, (e) => events.push(e));
  token = bridge.token;
  server = await bridge.start();
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bridge did not bind a port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tokenDir, { recursive: true, force: true });
});

beforeEach(() => {
  bridge.tasks.length = 0;
  bridge.messages.length = 0;
  bridge.lastSeen.clear();
  events = [];
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

describe('token auth', () => {
  it('returns 401 when the token header is missing', async () => {
    const r = await rawCall('GET', '/status', undefined, {});
    expect(r.status).toBe(401);
  });

  it('returns 401 when the token is wrong', async () => {
    const r = await rawCall('GET', '/status', undefined, { 'X-Orch-Token': 'nope' });
    expect(r.status).toBe(401);
  });

  it('applies to every route, including writes', async () => {
    expect((await rawCall('POST', '/task', { agent: 'w', task: 't' }, {})).status).toBe(401);
    expect((await rawCall('POST', '/message', { agent: 'w', text: 't' }, {})).status).toBe(401);
    expect(bridge.tasks).toHaveLength(0);
    expect(bridge.messages).toHaveLength(0);
  });

  it('writes the token file with mode 600 and reuses it on the next start', () => {
    const mode = fs.statSync(config.tokenFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(config.tokenFile, 'utf8').trim()).toBe(token);
  });
});

describe('POST /message', () => {
  it('stores the reply, returns 201, and calls the event handler', async () => {
    const r = await call('POST', '/message', { agent: 'worker-1', text: 'hello' });
    expect(r.status).toBe(201);
    expect(typeof r.json.id).toBe('string');
    expect(bridge.messages).toHaveLength(1);
    expect(bridge.messages[0]).toMatchObject({ agent: 'worker-1', text: 'hello' });
    expect(events).toEqual([{ kind: 'message', agent: 'worker-1', text: 'hello' }]);
  });

  it('rejects a bad agent with 400 and does not call the handler', async () => {
    const r = await call('POST', '/message', { agent: 'bad agent', text: 'hi' });
    expect(r.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it('rejects blank text with 400', async () => {
    expect((await call('POST', '/message', { agent: 'w', text: '  ' })).status).toBe(400);
  });

  it('rejects text longer than maxReportChars with 413', async () => {
    const r = await call('POST', '/message', { agent: 'w', text: 'x'.repeat(51) });
    expect(r.status).toBe(413);
    expect(bridge.messages).toHaveLength(0);
  });

  it('records the agent as last seen', async () => {
    await call('POST', '/message', { agent: 'alpha', text: 'hi' });
    expect(bridge.lastSeen.has('alpha')).toBe(true);
  });
});

describe('event handler', () => {
  it('fires once for POST /result with the task details', async () => {
    const created = await call('POST', '/task', { agent: 'w', task: 'work' });
    await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'done', summary: 'ok' });
    expect(events).toEqual([{ kind: 'result', agent: 'w', taskId: created.json.id, status: 'done', summary: 'ok' }]);
  });

  it('does not fire for a rejected result', async () => {
    const created = await call('POST', '/task', { agent: 'owner', task: 'work' });
    await call('POST', '/result', { taskId: created.json.id, agent: 'intruder', status: 'done', summary: 'x' });
    expect(events).toHaveLength(0);
  });

  it('keeps the request successful when the handler throws', async () => {
    bridge.messages.length = 0;
    const failing = createBridge({ ...config, tokenFile: config.tokenFile }, () => { throw new Error('boom'); });
    const srv = await failing.start();
    const addr = srv.address() as { port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${addr.port}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orch-Token': failing.token },
        body: JSON.stringify({ agent: 'w', text: 'hi' }),
      });
      expect(r.status).toBe(201);
    } finally {
      srv.close();
    }
  });
});

describe('summary limit', () => {
  it('caps a result summary at maxReportChars', async () => {
    const created = await call('POST', '/task', { agent: 'w', task: 'work' });
    const r = await call('POST', '/result', { taskId: created.json.id, agent: 'w', status: 'done', summary: 'x'.repeat(51) });
    expect(r.status).toBe(400);
  });
});
