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
import { spawn } from 'child_process';
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
- orch-list                          list live terminals: label, short id, uptime, last visible line
- orch-read <label|id> [entries]     what that agent has said/done recently (last 8 conversation entries by default), with a header saying whether it is WORKING or idle. If the header says "no transcript yet", you only get a short snippet of its live screen: enough to see a permission prompt or whether it is busy, not enough to read its replies. Say so plainly rather than guessing.
- orch-send <label|id> "<text>"      type text into a terminal and press Enter (this is how you give that agent an instruction)
- orch-send <label|id> --key <k>     press a key (enter esc up down y n tab ctrl-c), e.g. to answer a permission or trust prompt
- orch-wait <label|id> [seconds]     block until that terminal goes quiet after you sent something; then orch-read it

How to work:
1. If the user refers to an agent, run orch-list first and match by label/id. If the match is ambiguous or none fits, ask which one they mean. Never guess.
2. To delegate: orch-send the instruction, orch-wait, orch-read, then tell the user what that agent said or did, in your own words (not a raw screen dump). If it is still busy after the wait, say so and offer to check again.
3. Many questions need no terminal at all (planning, clarifying, deciding what to ask which agent). Answer those directly and conversationally; keep earlier turns in mind.
4. Before sending anything destructive or hard to undo (deploys, deletes, force-push, spending money, messaging people), state exactly what you will send and to whom, and wait for the user to say yes.
5. Permission prompts: if orch-list/orch-read shows a terminal waiting on a prompt (permission question, "Esc to cancel", "Enter to confirm"), NEVER type text into it; orch-send will refuse anyway. Tell the user exactly what it is asking and wait for their decision, then answer with orch-send --key. A pending prompt also means that agent is blocked, so say so when summarising. Don't send instructions to a blocked agent until the prompt is resolved.
6. Keep replies short: what you did, what came back, what you suggest next.
`;

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

  const selectedModel = model ?? 'claude-opus-5-5';

  // Set up SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Spawn the Claude CLI process with --resume to maintain session
  const started = fs.existsSync(STARTED_FILE);
  const claudeArgs = [
    '-p',  // non-interactive
    '--verbose',  // required for stream-json output format
    '--output-format', 'stream-json',
    ...(started ? ['--resume', orchestratorSid] : ['--session-id', orchestratorSid]),
    '--model', selectedModel,
    // Only the three helper scripts; the orchestrator can't touch files or run anything else.
    '--allowedTools', 'Bash(orch-list:*)', 'Bash(orch-send:*)', 'Bash(orch-read:*)', 'Bash(orch-wait:*)',
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
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

  proc.on('close', (code) => {
    if (code === 0) fs.writeFileSync(STARTED_FILE, '1', 'utf-8');
    else if (isFirstChunk) res.write(`data: ${JSON.stringify({ text: `❌ claude exited with code ${code}` })}\n\n`);
    if (!isFirstChunk) {
      res.write('event: end\n');
      res.write('data: ""\n\n');
    }
    res.end();
    console.log(`[${new Date().toISOString()}] Orchestrator: closed with code ${code}`);
  });

  proc.on('error', (err) => {
    console.error(`[Claude spawn error] ${err.message}`);
    if (!isFirstChunk) {
      res.write(`data: ${JSON.stringify({ text: `❌ Error: ${err.message}` })}\n\n`);
    }
    res.end();
  });

  // Kill claude only if the browser goes away mid-stream. (req 'close' fires as soon as
  // the body is read, so it must be the response that we watch.)
  res.on('close', () => {
    if (proc.exitCode === null) proc.kill();
  });
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
