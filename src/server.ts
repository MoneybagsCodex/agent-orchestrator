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
const ORCHESTRATOR_ROLE = `You are the master orchestration agent for a developer's terminal environment.

Your job is to:
1. Understand the developer's requests and goals
2. Use helper scripts to inspect and control their live agent terminals
3. Send commands to the right agents and report back what happens
4. Engage in multi-turn conversation to refine, clarify, or execute follow-up work

Available helper scripts (use via bash):
- orch-list: Shows all live terminal sessions with agent names, working directories, and status
- orch-send <label|sid> <text>: Send input to a specific terminal (use label or session ID)
- orch-read <label|sid> [count]: Read the last N messages from a terminal's transcript (default: 10)

Examples:
- "What agents do I have running?" → run \`orch-list\` and report
- "Tell the architect to deploy v2.0" → find the architect's terminal, run \`orch-send architect "deploy v2.0"\`, wait a moment, then \`orch-read architect 5\` to see results
- "Check on test results" → run \`orch-read test-runner\` to see the latest output

CRITICAL:
- Always confirm destructive commands (deletes, deploys, force-pushes) with the user before executing
- If a command fails, read the error and propose a fix
- Be concise; report what you did and what happened, not excessive verbosity
- For long-running tasks, check status periodically and report progress
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
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Spawn the Claude CLI process with --resume to maintain session
  const started = fs.existsSync(STARTED_FILE);
  const claudeArgs = [
    '-p',  // non-interactive
    '--verbose',  // required for stream-json output format
    '--output-format', 'stream-json',
    ...(started ? ['--resume', orchestratorSid] : ['--session-id', orchestratorSid]),
    '--model', selectedModel,
    // Only the three helper scripts; the orchestrator can't touch files or run anything else.
    '--allowedTools', 'Bash(orch-list:*)', 'Bash(orch-send:*)', 'Bash(orch-read:*)',
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
            let text = '';
            if (block.type === 'text') text = block.text + '\n\n';
            else if (block.type === 'tool_use') text = `→ ${block.input?.command ?? block.name}\n`;
            if (!text) continue;
            isFirstChunk = false;
            res.write(`data: ${JSON.stringify(text)}\n\n`);
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
    else if (isFirstChunk) res.write(`data: ${JSON.stringify(`❌ claude exited with code ${code}`)}\n\n`);
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
      res.write(`data: ${JSON.stringify(`\n\n❌ Error: ${err.message}`)}\n\n`);
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
