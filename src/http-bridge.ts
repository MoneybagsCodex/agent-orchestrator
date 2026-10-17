/**
 * HTTP Orchestrator Bridge
 *
 * Parallel infrastructure for orchestrated workflows. Agents coordinate through
 * a small REST API instead of cross-session messages, so task assignment and
 * result reporting do not depend on the session's message channel.
 *
 * Endpoints:
 *   POST /task      {agent, task}                    orchestrator assigns work
 *   GET  /task      ?agent=<id>                      agent claims its oldest pending task
 *   POST /result    {taskId, agent, status, summary} agent reports completion
 *   GET  /status    ?agent=<id> (optional)           counts and agent last-seen times
 *
 * State is held in memory. It is lost when the process restarts.
 * Bound to 127.0.0.1 only.
 */

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Server } from 'http';

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'failed';

export interface BridgeTask {
  id: string;
  agent: string;
  task: string;
  status: TaskStatus;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  result?: { status: 'done' | 'failed'; summary: string; reportedBy: string };
}

export interface HttpBridgeConfig {
  enabled: boolean;
  host: string;
  port: number;
  maxTaskChars: number;
  maxTasks: number;
  /** Max length of a reply (POST /message) or a result summary (POST /result). */
  maxReportChars: number;
  /** File holding the shared secret. Created with mode 600 on first start. A leading ~ is expanded. */
  tokenFile: string;
}

export interface BridgeMessage { id: string; agent: string; text: string; createdAt: string }

/** Called after a reply or result is stored. Errors thrown here are logged and do not fail the request. */
export type BridgeEvent =
  | { kind: 'message'; agent: string; text: string }
  | { kind: 'result'; agent: string; taskId: string; status: 'done' | 'failed'; summary: string };

const DEFAULTS: HttpBridgeConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 5001,
  maxTaskChars: 10000,
  maxTasks: 500,
  maxReportChars: 4000,
  tokenFile: '~/.operator-state/bridge.token',
};

const AGENT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/** Reads the httpBridge section of orchestrator.config.json. Missing values fall back to defaults. */
export function loadBridgeConfig(configPath?: string): HttpBridgeConfig {
  const file = configPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'orchestrator.config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = { ...DEFAULTS, ...(raw.httpBridge ?? {}) };
    return { ...merged, tokenFile: expandHome(merged.tokenFile) };
  } catch {
    return { ...DEFAULTS, tokenFile: expandHome(DEFAULTS.tokenFile) };
  }
}

/** Returns the shared secret, creating it (32 random bytes, mode 600) if the file does not exist. Never logs it. */
export function loadOrCreateToken(tokenFile: string): string {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch { /* not created yet */ }
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
  return token;
}

export interface Bridge {
  app: express.Express;
  tasks: BridgeTask[];
  messages: BridgeMessage[];
  lastSeen: Map<string, string>;
  token: string;
  start(): Promise<Server>;
}

export function createBridge(config: HttpBridgeConfig = loadBridgeConfig(), onEvent?: (e: BridgeEvent) => void): Bridge {
  const app = express();
  const tasks: BridgeTask[] = [];
  const messages: BridgeMessage[] = [];
  const lastSeen = new Map<string, string>();
  const token = loadOrCreateToken(config.tokenFile);
  const tokenBuf = Buffer.from(token);

  app.use(express.json({ limit: `${Math.max(config.maxTaskChars, config.maxReportChars) + 2000}b` }));

  // Every route needs the shared secret. A localhost port alone is not enough, because the reply text is
  // fed into a model's context.
  app.use((req, res, next) => {
    const given = Buffer.from(String(req.header('x-orch-token') ?? ''));
    if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
      return res.status(401).json({ error: 'missing or wrong X-Orch-Token' });
    }
    next();
  });

  const notify = (e: BridgeEvent) => {
    try { onEvent?.(e); } catch (err) { console.error('[http-bridge] event handler failed:', (err as Error).message); }
  };

  const touch = (agent: string) => lastSeen.set(agent, new Date().toISOString());

  const validAgent = (v: unknown): v is string => typeof v === 'string' && AGENT_ID.test(v);

  // Evict the oldest finished tasks once the cap is reached. Pending and claimed tasks are kept.
  const enforceCap = () => {
    while (tasks.length > config.maxTasks) {
      const idx = tasks.findIndex((t) => t.status === 'done' || t.status === 'failed');
      if (idx === -1) break;
      tasks.splice(idx, 1);
    }
  };

  app.post('/task', (req, res) => {
    const { agent, task } = req.body ?? {};
    if (!validAgent(agent)) return res.status(400).json({ error: 'agent must be 1-64 chars of letters, digits, _ or -' });
    if (typeof task !== 'string' || task.trim() === '') return res.status(400).json({ error: 'task must be a non-empty string' });
    if (task.length > config.maxTaskChars) return res.status(413).json({ error: `task exceeds ${config.maxTaskChars} chars` });

    const created: BridgeTask = {
      id: randomUUID(),
      agent,
      task,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    tasks.push(created);
    enforceCap();
    res.status(201).json({ id: created.id, status: created.status });
  });

  app.get('/task', (req, res) => {
    const agent = req.query.agent;
    if (!validAgent(agent)) return res.status(400).json({ error: 'agent query parameter is required and must be valid' });
    touch(agent);

    const next = tasks.find((t) => t.agent === agent && t.status === 'pending');
    if (!next) return res.json({ task: null });

    next.status = 'claimed';
    next.claimedAt = new Date().toISOString();
    res.json({ task: next });
  });

  app.post('/result', (req, res) => {
    const { taskId, agent, status, summary } = req.body ?? {};
    if (typeof taskId !== 'string') return res.status(400).json({ error: 'taskId is required' });
    if (!validAgent(agent)) return res.status(400).json({ error: 'agent must be valid' });
    if (status !== 'done' && status !== 'failed') return res.status(400).json({ error: "status must be 'done' or 'failed'" });
    if (typeof summary !== 'string' || summary.length > config.maxReportChars) {
      return res.status(400).json({ error: `summary must be a string up to ${config.maxReportChars} chars` });
    }

    const found = tasks.find((t) => t.id === taskId);
    if (!found) return res.status(404).json({ error: 'unknown taskId' });
    if (found.agent !== agent) return res.status(403).json({ error: 'task is assigned to a different agent' });
    if (found.status === 'done' || found.status === 'failed') return res.status(409).json({ error: 'task already reported' });

    touch(agent);
    found.status = status;
    found.completedAt = new Date().toISOString();
    found.result = { status, summary, reportedBy: agent };
    notify({ kind: 'result', agent, taskId: found.id, status, summary });
    res.json({ id: found.id, status: found.status });
  });

  // A free-text reply from an agent, for the orchestrator to read. Not tied to a task.
  app.post('/message', (req, res) => {
    const { agent, text } = req.body ?? {};
    if (!validAgent(agent)) return res.status(400).json({ error: 'agent must be 1-64 chars of letters, digits, _ or -' });
    if (typeof text !== 'string' || text.trim() === '') return res.status(400).json({ error: 'text must be a non-empty string' });
    if (text.length > config.maxReportChars) return res.status(413).json({ error: `text exceeds ${config.maxReportChars} chars` });

    touch(agent);
    const stored: BridgeMessage = { id: randomUUID(), agent, text, createdAt: new Date().toISOString() };
    messages.push(stored);
    while (messages.length > config.maxTasks) messages.shift();
    notify({ kind: 'message', agent, text });
    res.status(201).json({ id: stored.id });
  });

  app.get('/status', (req, res) => {
    const agent = req.query.agent;
    const scoped = agent === undefined ? tasks : tasks.filter((t) => t.agent === agent);
    if (agent !== undefined && !validAgent(agent)) return res.status(400).json({ error: 'agent must be valid' });

    const counts: Record<TaskStatus, number> = { pending: 0, claimed: 0, done: 0, failed: 0 };
    for (const t of scoped) counts[t.status] += 1;

    res.json({
      ok: true,
      counts,
      agents: Object.fromEntries(lastSeen),
      total: scoped.length,
    });
  });

  return {
    app,
    tasks,
    messages,
    lastSeen,
    token,
    start: () =>
      new Promise<Server>((resolve, reject) => {
        const server = app.listen(config.port, config.host, () => resolve(server));
        server.on('error', reject);
      }),
  };
}
