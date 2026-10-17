import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBridge, type Bridge, type HttpBridgeConfig } from './http-bridge';

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-routing-test-'));

const config: HttpBridgeConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  maxTaskChars: 100,
  maxTasks: 50,
  maxReportChars: 50,
  tokenFile: path.join(tokenDir, 'bridge.token'),
};

const registryConfig = { capabilityTTL: 60000, maxAgents: 10, maxListItems: 10 };

let bridge: Bridge;
let server: Server;
let base: string;
let token: string;

// Sends with the shared token unless the caller passes its own headers (used by the auth test).
const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers ?? { 'X-Orch-Token': token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

beforeAll(async () => {
  bridge = createBridge(config, undefined, registryConfig);
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

// The registry has no delete, so earlier agents are reset to no capabilities. That keeps each test's routing candidates isolated.
beforeEach(() => {
  bridge.tasks.length = 0;
  for (const a of bridge.registry.getAllAgents()) bridge.registry.register({ name: a.name, bash: false, fileOps: false });
});

describe('POST /capability and GET /capability', () => {
  it('requires the token', async () => {
    const r = await call('POST', '/capability', { name: 'w1', bash: true, fileOps: true }, { 'X-Orch-Token': 'wrong' });
    expect(r.status).toBe(401);
    expect(r.status).toBe(401);
  });

  it('registers an agent and lists it with full data', async () => {
    const r = await call('POST', '/capability', { name: 'cap-list', bash: true, fileOps: false, languages: ['ts'], tools: ['vitest'] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, name: 'cap-list', expiresInMs: 60000 });

    const list = await call('GET', '/capability');
    const found = list.json.agents.find((a: any) => a.name === 'cap-list');
    expect(found).toMatchObject({ bash: true, fileOps: false, languages: ['ts'], tools: ['vitest'], stale: false });
  });

  it('returns 400 with a reason for invalid capability bodies', async () => {
    const r = await call('POST', '/capability', { name: 'w1', bash: 'yes', fileOps: true });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/bash must be boolean/);
  });
});

describe('POST /task with requiresCapability', () => {
  it('routes to the capable agent when agent is omitted', async () => {
    await call('POST', '/capability', { name: 'only-bash', bash: true, fileOps: false });
    await call('POST', '/capability', { name: 'only-files', bash: false, fileOps: true });

    const r = await call('POST', '/task', { task: 'run the suite', requiresCapability: 'bash' });
    expect(r.status).toBe(201);
    expect(r.json.agent).toBe('only-bash');
  });

  it('picks the least-loaded capable agent', async () => {
    await call('POST', '/capability', { name: 'busy', bash: true, fileOps: false });
    await call('POST', '/capability', { name: 'idle', bash: true, fileOps: false });
    await call('POST', '/task', { agent: 'busy', task: 'existing work' });

    const r = await call('POST', '/task', { task: 'new work', requiresCapability: 'bash' });
    expect(r.json.agent).toBe('idle');
  });

  it('returns 400 when no agent has the required capability', async () => {
    await call('POST', '/capability', { name: 'no-deploy', bash: true, fileOps: false });
    const r = await call('POST', '/task', { task: 'deploy it', requiresCapability: { bash: true, tools: ['kubectl'] } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('no agent has required capability');
  });

  it('rejects an explicit agent that lacks the capability', async () => {
    await call('POST', '/capability', { name: 'no-files', bash: true, fileOps: false });
    const r = await call('POST', '/task', { agent: 'no-files', task: 'edit a file', requiresCapability: 'fileOps' });
    expect(r.status).toBe(400);
  });

  it('accepts an explicit agent that has the capability', async () => {
    await call('POST', '/capability', { name: 'has-files', bash: false, fileOps: true });
    const r = await call('POST', '/task', { agent: 'has-files', task: 'edit a file', requiresCapability: 'fileOps' });
    expect(r.status).toBe(201);
    expect(r.json.agent).toBe('has-files');
  });

  it('rejects a malformed requiresCapability', async () => {
    const r = await call('POST', '/task', { task: 'x', requiresCapability: 'teleport' });
    expect(r.status).toBe(400);
  });
});

describe('POST /task without requiresCapability (unchanged behavior)', () => {
  it('still requires an explicit agent', async () => {
    const r = await call('POST', '/task', { task: 'no agent given' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/agent must be/);
  });

  it('still assigns to the named agent regardless of registry state', async () => {
    const r = await call('POST', '/task', { agent: 'never-registered', task: 'plain task' });
    expect(r.status).toBe(201);
    expect(r.json.agent).toBe('never-registered');
  });
});
