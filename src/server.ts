#!/usr/bin/env node
/**
 * Master Orchestrator Agent Server
 *
 * Runs as a persistent Claude session that can:
 * - List your live terminal sessions
 * - Send input to terminals
 * - Read terminal output
 * - Orchestrate multi-turn conversations
 *
 * Endpoint: POST /chat {message, model}
 * Response: Server-Sent Events (text/event-stream)
 *
 * Start:
 *   npm run server
 */

import express from 'express';
import { spawn, execFile } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';

const app = express();
const PORT = parseInt(process.env.ORCH_PORT ?? '3003', 10);
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://localhost:3002';

const STATE_DIR = path.join(os.homedir(), '.operator-state');
const SESSIONS_DIR = path.join(STATE_DIR, 'orchestrator-sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

app.use(express.json());

// The UI on :4000 calls this directly from the browser, which sends a CORS preflight.
// Local-only: restrict to localhost origins.
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Persistent orchestrator session. Claude requires a real UUID: the first turn
// creates it with --session-id, later turns continue it with --resume.
const SID_FILE = path.join(SESSIONS_DIR, 'orchestrator.sid');
const STARTED_FILE = path.join(SESSIONS_DIR, 'orchestrator.started');

function getOrchestratorSid(): string {
  if (fs.existsSync(SID_FILE)) return fs.readFileSync(SID_FILE, 'utf-8').trim();
  const sid = randomUUID();
  fs.writeFileSync(SID_FILE, sid, 'utf-8');
  fs.rmSync(STARTED_FILE, { force: true });
  return sid;
}

const orchestratorSid = getOrchestratorSid();
const BIN_DIR = path.resolve(import.meta.dirname, '../bin');

// The system prompt for the orchestrator agent
const ORCHESTRATOR_ROLE = `You are the user's master orchestrator. The user talks to you in plain language (voice or text); you coordinate their live agent terminals (Claude Code sessions) on their behalf, and report back in plain, concise language.

You can ONLY act through these commands (run them with Bash, exactly as written):
- orch-status                        START HERE for "what's going on / what is X doing". One digest per agent: state (WORKING / IDLE / BLOCKED on a decision), what it last said, what it was last asked, and notes (e.g. a /goal loop makes idle/busy flicker; that is normal for that agent, not a fault). Report these in plain words; never dump raw output at the user.
- orch-list                          quick list of live terminals: label, short id, uptime
- orch-read <id|title> [entries]     what that agent has said/done recently (last 8 conversation entries by default), with a header saying whether it is WORKING or idle. If the header says "no transcript yet", you only get a short snippet of its live screen: enough to see a permission prompt or whether it is busy, not enough to read its replies. Say so plainly rather than guessing.
- orch-send <id|title> "<text>"      type text into a terminal and press Enter (this is how you give that agent an instruction). Slash commands (/compact, /clear, /goal ...) are refused unless you add --confirmed: orch-send <id|title> --confirmed "/compact"
- orch-send <id|title> --key <k>     press a key (enter esc up down y n tab ctrl-c), e.g. to answer a permission or trust prompt
- orch-wait <id|title> [seconds]     block until that terminal goes quiet after you sent something; then orch-read it

How to work:
1. If the user refers to an agent, run orch-list first and match by label/id. If the match is ambiguous or none fits, ask which one they mean. Never guess.
2. To delegate: orch-send the instruction, orch-wait, orch-read, then tell the user what that agent said or did, in your own words (not a raw screen dump). If it is still busy after the wait, say so and offer to check again.
3. Many questions need no terminal at all (planning, clarifying, deciding what to ask which agent). Answer those directly and conversationally; keep earlier turns in mind.
4. IDENTIFY TERMINALS BY CONVERSATION TITLE AND SESSION ID, never by panel label. Each terminal has a conversation title (what it is actually working on) and a short session id; the panel label is only a hint and may be wrong or swapped. Always refer to an agent as "<title>" [id], and mention the panel label only if it matters. Pass the session id (or the title) to the orch-* commands. If the user uses a panel label, map it to a title yourself with orch-status and say which terminal you took it to be; if the label and the conversation seem mismatched, say so. Before any slash command or other state-changing/irreversible action, tell the user "<title> [id]", wait for an explicit yes naming that target, and only then run it with --confirmed. If the user's words could match more than one terminal, ask.
4b. Before sending anything destructive or hard to undo (deploys, deletes, force-push, spending money, messaging people), state exactly what you will send and to whom, and wait for the user to say yes.
5. Permission prompts: if orch-list/orch-read shows a terminal waiting on a prompt (permission question, "Esc to cancel", "Enter to confirm"), NEVER type text into it; orch-send will refuse anyway. Tell the user exactly what it is asking and wait for their decision, then answer with orch-send --key. A pending prompt also means that agent is blocked, so say so when summarising. Don't send instructions to a blocked agent until the prompt is resolved.
6. Keep replies short: what you did, what came back, what you suggest next. Always say which agent (by its label) you mean, and for every message you send say whether orch-send confirmed delivery ("delivered", "queued behind its current work", or "not confirmed"); never imply an agent got something unless orch-send says so.
7. The user may send follow-up messages while you are waiting on an agent. Treat each as new context for the same task, and adjust what you are doing rather than starting over.
`;

let turnBusy = false;
let currentKill: (() => void) | null = null;
const waiting: Array<() => void> = [];

/**
 * POST /chat {message, model}
 *
 * Sends a message to the orchestrator Claude session with a chosen model.
 * Streams the response as Server-Sent Events.
 *
 * The session persists across calls, so multi-turn conversations work naturally.
 */
app.post('/chat', (req, res) => {
  const { message, model } = req.body as { message?: string; model?: string };

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const selectedModel = model ?? 'claude-haiku-4-5-20251001';

  // Set up SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // One conversation = one Claude session, so only one turn can run at a time. Messages sent while a
  // turn is running wait in a queue (the browser sees {queued:n}) and run next, in order.
  // Browser refreshes/disconnects must not cancel the work: keep running, just stop writing to the dead socket.
  const write = (chunk: string) => { if (!res.destroyed && !res.writableEnded) res.write(chunk); };
  let kill: () => void = () => {};
  const start = () => {
  turnBusy = true;
  // Spawn the Claude CLI process with --resume to maintain session
  const started = fs.existsSync(STARTED_FILE);
  const claudeArgs = [
    '-p',  // non-interactive
    '--verbose',  // required for stream-json output format
    '--output-format', 'stream-json',
    ...(started ? ['--resume', orchestratorSid] : ['--session-id', orchestratorSid]),
    '--model', selectedModel,
    // Lock the orchestrator down: Bash is its only tool, only the orch-* helpers (plus harmless text
    // filters) may run, and everything else is denied outright. User-level settings are ignored because
    // their broad allow rules would otherwise widen this; no MCP servers, no skills.
    '--tools', 'Bash',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--allowedTools', 'Bash(orch-status:*)', 'Bash(orch-list:*)', 'Bash(orch-send:*)', 'Bash(orch-read:*)', 'Bash(orch-wait:*)',
    'Bash(sleep:*)', 'Bash(cut:*)', 'Bash(tail:*)', 'Bash(head:*)', 'Bash(grep:*)',
    '--append-system-prompt', ORCHESTRATOR_ROLE,
    '--', message
  ];

  console.log(`[${new Date().toISOString()}] Orchestrator: ${selectedModel} ${started ? 'resume' : 'new'} ${orchestratorSid}`);
  console.log(`[${new Date().toISOString()}] User: ${message.slice(0, 80)}${message.length > 80 ? '...' : ''}`);

  const proc = spawn('claude', claudeArgs, {
    cwd: path.dirname(BIN_DIR),
    env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}`, BRIDGE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  kill = () => { if (proc.exitCode === null) proc.kill(); };
  currentKill = kill;

  let buffer = '';
  let isFirstChunk = true;

  // Parse stream-json output
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');

    // Split by newlines and parse complete JSON objects
    const lines = buffer.split('\n');
    buffer = lines[lines.length - 1]; // Keep incomplete last line

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const event = JSON.parse(line);

        // stream-json (--verbose) emits whole messages: {type:"assistant", message:{content:[{type:"text"|"tool_use",...}]}}
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            let payload: { text?: string; tool?: string } | null = null;
            if (block.type === 'text') payload = { text: block.text };
            else if (block.type === 'tool_use') payload = { tool: block.input?.command ?? block.name };
            if (!payload) continue;
            isFirstChunk = false;
            write(`data: ${JSON.stringify(payload)}\n\n`);
          }
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error(`[Claude stderr] ${chunk.toString('utf-8')}`);
  });

  proc.on('close', (code, signal) => {
    if (code === 0) fs.writeFileSync(STARTED_FILE, '1', 'utf-8');
    else if (signal) write(`data: ${JSON.stringify({ text: '(stopped)' })}\n\n`);
    else if (isFirstChunk) write(`data: ${JSON.stringify({ text: `❌ claude exited with code ${code}` })}\n\n`);
    if (!isFirstChunk) {
      write('event: end\n');
      write('data: ""\n\n');
    }
    res.end();
    console.log(`[${new Date().toISOString()}] Orchestrator: closed with code ${code}`);
    turnBusy = false;
    currentKill = null;
    waiting.shift()?.();
  });

  proc.on('error', (err) => {
    console.error(`[Claude spawn error] ${err.message}`);
    write(`data: ${JSON.stringify({ text: `❌ Error: ${err.message}` })}\n\n`);
    res.end();
    turnBusy = false;
    currentKill = null;
    waiting.shift()?.();
  });
  };

  // Only POST /stop cancels a turn. A page refresh leaves it running; /history shows the result.

  if (turnBusy) {
    waiting.push(start);
    write(`data: ${JSON.stringify({ queued: waiting.length })}\n\n`);
  } else {
    start();
  }
});

/** GET /status — the per-agent digest (same data the orchestrator reads via orch-status). */
let statusCache: { at: number; body: unknown } | null = null;
app.get('/status', (req, res) => {
  // Several tabs poll this; the digest takes ~0.5s, so serve a result up to 2s old.
  if (statusCache && Date.now() - statusCache.at < 2000) return res.json(statusCache.body);
  execFile(path.join(BIN_DIR, 'orch-status'), ['--json'], { env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH}`, BRIDGE_URL }, timeout: 15000 },
    (err, stdout) => {
      if (err) return res.status(503).json({ error: `status unavailable: ${err.message}` });
      try {
        const body = { agents: JSON.parse(stdout) };
        statusCache = { at: Date.now(), body };
        res.json(body);
      } catch { res.status(500).json({ error: 'bad status output' }); }
    });
});

/**
 * GET /history — the orchestrator conversation rebuilt from its Claude transcript, so the UI can
 * restore the chat after a page refresh: [{role:'user',text} | {role:'assistant',steps:[],text}].
 */
app.get('/history', (_req, res) => {
  try {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    const dir = fs.readdirSync(projects).find((d) => fs.existsSync(path.join(projects, d, `${orchestratorSid}.jsonl`)));
    if (!dir) return res.json({ messages: [] });
    const out: Array<{ role: 'user' | 'assistant'; text: string; steps?: string[] }> = [];
    for (const line of fs.readFileSync(path.join(projects, dir, `${orchestratorSid}.jsonl`), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue;
      const c = e.message?.content;
      if (e.type === 'user') {
        const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : '');
        if (text.trim() && !text.startsWith('<')) out.push({ role: 'user', text });
      } else if (Array.isArray(c)) {
        let cur = out[out.length - 1];
        if (!cur || cur.role !== 'assistant') { cur = { role: 'assistant', text: '', steps: [] }; out.push(cur); }
        for (const b of c) {
          if (b.type === 'text' && b.text?.trim()) cur.text += (cur.text ? '\n\n' : '') + b.text;
          else if (b.type === 'tool_use') cur.steps!.push(b.input?.command ?? b.name);
        }
      }
    }
    res.json({ messages: out.filter((m) => m.role === 'user' || m.text || m.steps?.length), busy: turnBusy });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /stop — cancel the turn that is currently running (queued messages still run afterwards). */
app.post('/stop', (req, res) => {
  const wasRunning = turnBusy;
  currentKill?.();
  res.json({ stopped: wasRunning });
});

/**
 * GET /health
 * Check if the orchestrator is running
 */
/**
 * GET /terminals?tail=N
 * The bridge's live sessions with human labels merged in (cockpit panel names, then session
 * metadata). Older bridges don't know labels, so the UI reads this instead of the bridge.
 */
app.get('/terminals', async (req, res) => {
  const tail = parseInt(String(req.query.tail ?? '200'), 10) || 200;
  try {
    let r = await fetch(`${BRIDGE_URL}/terminals?tail=${tail}`);
    if (!r.ok) r = await fetch(`${BRIDGE_URL}/terminals`); // old bridge: no ?tail=
    const { sessions } = (await r.json()) as { sessions: Record<string, any>[] };

    const names: Record<string, string> = {};
    try {
      const metaDir = path.join(STATE_DIR, 'session-metadata');
      for (const f of fs.readdirSync(metaDir)) {
        const m = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
        if (m.sessionId && m.name) names[m.sessionId] = m.name;
      }
    } catch { /* no metadata */ }
    try {
      for (const a of JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'active-sessions.json'), 'utf-8'))) {
        if (a.sid && a.label) names[a.sid] = a.label; // later entries win
      }
    } catch { /* no active-sessions */ }

    // Older bridges return the raw pty tail; strip escape codes (column/forward moves stand in for spaces).
    const clean = (t: string) =>
      t.replace(/\x1b\[\d*[CG]/g, ' ').replace(/\x1b\[[0-9;?>]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

    res.json({
      sessions: sessions.map((s) => ({
        ...s,
        label: names[s.sid] || s.label || s.agent || String(s.sid).slice(0, 8),
        bufferTail: clean(String(s.bufferTail ?? '')),
      })),
    });
  } catch (e) {
    res.status(503).json({ error: `bridge unreachable: ${(e as Error).message}` });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    orchestratorSid,
    bridgeUrl: BRIDGE_URL,
  });
});

app.listen(PORT, () => {
  console.log(`🎯 Orchestrator running on http://localhost:${PORT}`);
  console.log(`   Bridge at ${BRIDGE_URL}`);
  console.log(`   Session ID: ${orchestratorSid}`);
  console.log(`   POST /chat {message, model} — stream response as SSE`);
});
