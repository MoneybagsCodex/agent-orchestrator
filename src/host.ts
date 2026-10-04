/**
 * OrchestratorHost: the persistent orchestrator.
 *
 * One long-lived headless Claude process (stream-json in and out) that stays alive between turns, so it
 * holds a peer-messaging inbox: agents can answer it at any time and it wakes up on its own. (Verified in
 * the Phase 0 spike: it receives peer messages while idle, replies via SendMessage, and can be interrupted.)
 *
 * Responsibilities:
 *  - spawn/resume the process, feed it user messages, interrupt it
 *  - turn its stdout into small normalized events for the UI
 *  - follow its own transcript for incoming peer messages and delivery/idle notices
 *  - keep a ledger of every message it sent to an agent and what happened to it
 */
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type MessageState = 'sent' | 'held' | 'released' | 'answered' | 'denied' | 'expired' | 'refused';

export interface SentMessage {
  msgId: string;
  to: string;           // peer address, e.g. uds:/tmp/cc-socks/1234.sock, or a name
  text: string;
  sentAt: number;       // unix seconds
  state: MessageState;
  updatedAt: number;
}

export type HostEvent =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; command: string }
  | { kind: 'turn'; state: 'start' | 'end' }
  | { kind: 'peer'; from: string; fromName: string; text: string }
  | { kind: 'notice'; state: MessageState | 'idle'; msgId?: string; text: string }
  | { kind: 'notify'; level: 'info' | 'warn'; title: string; text: string; sid?: string }
  | { kind: 'error'; text: string };

export type SeqEvent = HostEvent & { seq: number; at: number };

interface HostOptions {
  sid: string;
  startedFile: string;
  messagesFile: string;
  role: string;
  cwd: string;
  binDir: string;
  bridgeUrl: string;
  model: string;
}

const ALLOWED = [
  'ListAgents', 'SendMessage', 'ToolSearch',
  'Bash(orch-status:*)', 'Bash(orch-list:*)', 'Bash(orch-send:*)', 'Bash(orch-read:*)', 'Bash(orch-wait:*)',
  'Bash(sleep:*)', 'Bash(cut:*)', 'Bash(tail:*)', 'Bash(head:*)', 'Bash(grep:*)',
];

export class OrchestratorHost extends EventEmitter {
  private proc: ChildProcess | null = null;
  private opts: HostOptions;
  private active = 0;                   // commands in flight (user turns and peer-triggered turns)
  private seq = 0;
  private ring: SeqEvent[] = [];
  private pendingSends = new Map<string, { to: string; text: string }>();
  private restarting = false;
  rateLimit: Record<string, unknown> | null = null;

  constructor(opts: HostOptions) {
    super();
    this.opts = opts;
  }

  get busy() { return this.active > 0; }
  get model() { return this.opts.model; }
  get sid() { return this.opts.sid; }

  /** Events newer than `since`, for SSE replay after a reconnect. */
  eventsSince(since: number): SeqEvent[] { return this.ring.filter((e) => e.seq > since); }
  get lastSeq() { return this.seq; }

  private push(e: HostEvent) {
    const full = { ...e, seq: ++this.seq, at: Date.now() } as SeqEvent;
    this.ring.push(full);
    if (this.ring.length > 300) this.ring.shift();
    this.emit('event', full);
  }

  // ---------- process lifecycle ----------
  start() {
    if (this.proc) return;
    const started = fs.existsSync(this.opts.startedFile);
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', this.opts.model,
      // A stable name: agents reply to a NAME, and the auto-generated one changes every restart, which sends their replies nowhere.
      '--name', 'master-orchestrator',
      ...(started ? ['--resume', this.opts.sid] : ['--session-id', this.opts.sid]),
      // Locked down: only these tools, anything else is denied outright; user-level settings (with their
      // broad allow rules) are ignored; no MCP servers, no skills.
      '--tools', 'Bash,ListAgents,SendMessage,ToolSearch',
      '--permission-mode', 'dontAsk',
      '--setting-sources', 'project',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--allowedTools', ...ALLOWED,
      '--append-system-prompt', this.opts.role,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${this.opts.binDir}:${process.env.PATH}`, BRIDGE_URL: this.opts.bridgeUrl };
    // If the server was itself started from a Claude session, don't let the child think it is nested.
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_')) delete env[k];

    const p = spawn('claude', args, { cwd: this.opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.active = 0;
    let buf = '';
    p.stdout!.on('data', (d) => {
      buf += d.toString('utf-8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    p.stderr!.on('data', (d) => console.error('[host stderr]', d.toString('utf-8').slice(0, 300)));
    p.on('exit', (code, signal) => {
      this.proc = null;
      this.active = 0;
      if (!this.restarting) this.push({ kind: 'error', text: `Orchestrator process exited (${signal ?? code}). It restarts on your next message.` });
      this.restarting = false;
    });
    this.tailInbox();
    console.log(`[host] started pid=${p.pid} model=${this.opts.model} ${started ? 'resume' : 'new'} ${this.opts.sid}`);
  }

  /** Switch model: the process restarts on the same session (conversation is kept). */
  setModel(model: string) {
    if (model === this.opts.model) return;
    this.opts.model = model;
    if (this.proc) { this.restarting = true; this.proc.kill(); this.proc = null; }
    this.start();
  }

  send(text: string) {
    this.start();
    this.push({ kind: 'user', text });
    if (this.active++ === 0) this.push({ kind: 'turn', state: 'start' });
    this.proc!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  }

  /** Tell the orchestrator's model something without it appearing as something the user typed. */
  sendSystem(text: string) {
    this.start();
    if (this.active++ === 0) this.push({ kind: 'turn', state: 'start' });
    this.proc!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  }

  /** A proactive update for the UI (no model involved). */
  notify(n: { level: 'info' | 'warn'; title: string; text: string; sid?: string }) {
    this.push({ kind: 'notify', ...n });
  }

  interrupt() {
    if (!this.proc) return false;
    this.proc.stdin!.write(JSON.stringify({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
    return true;
  }

  stop() { if (this.proc) { this.restarting = true; this.proc.kill(); } }

  // ---------- stdout parsing ----------
  private onLine(line: string) {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }

    if (e.type === 'command_lifecycle') {
      // Turns triggered by an incoming peer message announce themselves here; user-sent turns do not (send() counts those).
      if (e.state === 'started') { if (this.active++ === 0) this.push({ kind: 'turn', state: 'start' }); }
    } else if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) this.push({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') {
          this.push({ kind: 'tool', command: b.input?.command ?? b.input?.to ?? b.name });
          if (b.name === 'SendMessage') this.pendingSends.set(b.id, { to: String(b.input?.to ?? ''), text: String(b.input?.message ?? '') });
        }
      }
    } else if (e.type === 'user') {
      // Result of a SendMessage call: it carries the message id we use to track the later notices.
      for (const b of e.message?.content ?? []) {
        if (b.type !== 'tool_result' || !this.pendingSends.has(b.tool_use_id)) continue;
        const raw = Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join(' ') : String(b.content ?? '');
        const m = raw.match(/"msg_id"\s*:\s*"([0-9a-f-]+)"/);
        const info = this.pendingSends.get(b.tool_use_id)!;
        this.pendingSends.delete(b.tool_use_id);
        if (m) {
          this.upsertMessage({ msgId: m[1], to: info.to, text: info.text.slice(0, 300), sentAt: Math.floor(Date.now() / 1000), state: 'sent' });
          this.push({ kind: 'notice', state: 'sent', msgId: m[1], text: info.to });
        }
      }
    } else if (e.type === 'result') {
      if (e.subtype === 'success') { try { fs.writeFileSync(this.opts.startedFile, '1'); } catch { /* ignore */ } }
      // Every turn, whoever started it, ends with a result event.
      if (this.active > 0 && --this.active === 0) this.push({ kind: 'turn', state: 'end' });
    } else if (e.type === 'rate_limit_event') {
      this.rateLimit = e.rate_limit_info ?? null;
    }
  }

  // ---------- message ledger ----------
  readMessages(): SentMessage[] {
    try { return JSON.parse(fs.readFileSync(this.opts.messagesFile, 'utf-8')); } catch { return []; }
  }
  private writeMessages(list: SentMessage[]) {
    fs.mkdirSync(path.dirname(this.opts.messagesFile), { recursive: true });
    fs.writeFileSync(this.opts.messagesFile, JSON.stringify(list.slice(-200), null, 2));
  }
  private upsertMessage(m: Omit<SentMessage, 'updatedAt'> & { updatedAt?: number }) {
    const list = this.readMessages();
    const i = list.findIndex((x) => x.msgId === m.msgId);
    const full: SentMessage = { ...m, updatedAt: Math.floor(Date.now() / 1000) };
    if (i >= 0) list[i] = { ...list[i], ...full, text: list[i].text, to: list[i].to, sentAt: list[i].sentAt }; else list.push(full);
    this.writeMessages(list);
  }
  /** The agent has effectively answered (we saw its finished turn), even if it did not message back. */
  markDone(msgId: string) { this.setState(msgId, 'answered'); }
  private setState(msgId: string, state: MessageState) {
    const list = this.readMessages();
    const m = list.find((x) => x.msgId === msgId);
    if (m && m.state !== 'answered') { m.state = state; m.updatedAt = Math.floor(Date.now() / 1000); this.writeMessages(list); }
  }
  private markAnswered(fromAddr: string, fromName: string) {
    const list = this.readMessages();
    let changed = false;
    for (const m of list) {
      if (m.state === 'answered' || m.state === 'denied' || m.state === 'expired' || m.state === 'refused') continue;
      if (m.to === fromAddr || (fromName && m.to === fromName)) { m.state = 'answered'; m.updatedAt = Math.floor(Date.now() / 1000); changed = true; }
    }
    if (changed) this.writeMessages(list);
  }

  // ---------- inbox: follow our own transcript ----------
  private recentNotices = new Map<string, number>();
  private inboxTimer: NodeJS.Timeout | null = null;
  private inboxFile = '';
  private inboxOffset = -1;

  private tailInbox() {
    if (this.inboxTimer) return;
    this.inboxTimer = setInterval(() => {
      try {
        if (!this.inboxFile) {
          const projects = path.join(os.homedir(), '.claude', 'projects');
          const dir = fs.readdirSync(projects).find((d) => fs.existsSync(path.join(projects, d, `${this.opts.sid}.jsonl`)));
          if (!dir) return;
          this.inboxFile = path.join(projects, dir, `${this.opts.sid}.jsonl`);
        }
        const size = fs.statSync(this.inboxFile).size;
        if (this.inboxOffset < 0) { this.inboxOffset = size; return; }   // only what arrives from now on
        if (size <= this.inboxOffset) return;
        const fd = fs.openSync(this.inboxFile, 'r');
        const buf = Buffer.alloc(size - this.inboxOffset);
        fs.readSync(fd, buf, 0, buf.length, this.inboxOffset);
        fs.closeSync(fd);
        this.inboxOffset = size;
        for (const line of buf.toString('utf-8').split('\n')) if (line.trim()) this.onTranscriptLine(line);
      } catch { /* transient */ }
    }, 1500);
  }

  private onTranscriptLine(line: string) {
    // Peer messages and notices are recorded as text inside entries of varying type; match on the text.
    let text = line;
    try { text = JSON.stringify(JSON.parse(line)).replace(/\\n/g, '\n').replace(/\\"/g, '"'); } catch { /* raw */ }

    const peer = text.match(/<cross-session-message from="([^"]+)"(?: from-name="([^"]*)")?[^>]*>\s*([\s\S]*?)\s*<\/cross-session-message>/);
    if (peer) {
      const [, from, fromName = '', body] = peer;
      this.markAnswered(from, fromName);
      this.push({ kind: 'peer', from, fromName, text: body.slice(0, 600) });
    }
    // Real notices only: the SendMessage tool result also contains the phrase "[Cross-session delivery notice]"
    // in its help text ("a notice follows if ..."), which must not be read as an outcome.
    const notice = text.match(/\[Cross-session (delivery|idle) notice\]\s*(Your message to another session|"[^"]+", which you asked)([\s\S]{0,500})/);
    if (notice) {
      const body = notice[2] + notice[3];
      const id = body.match(/msg_id: ([0-9a-f-]{16,})/)?.[1];
      let state: MessageState | 'idle' | null = null;
      if (notice[1] === 'idle') state = 'idle';
      else if (/was approved and released/i.test(body)) state = 'released';
      else if (/was held by that session/i.test(body)) state = 'held';
      else if (/denied|declined/i.test(body)) state = 'denied';
      else if (/expired/i.test(body)) state = 'expired';
      else if (/not accepting|refus/i.test(body)) state = 'refused';
      const key = `${state}|${id ?? body.slice(0, 80)}`;
      const nowMs = Date.now();
      if (state && !(this.recentNotices.get(key) && nowMs - this.recentNotices.get(key)! < 60000)) {
        this.recentNotices.set(key, nowMs);
        if (id && state !== 'idle') this.setState(id, state as MessageState);
        this.push({ kind: 'notice', state, msgId: id, text: body.replace(/\s+/g, ' ').trim().slice(0, 220) });
      }
    }
  }
}
