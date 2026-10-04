/**
 * Copilot layer: everything that turns raw agent state into something a person can act on.
 *  - per-agent turn summaries (extracted from transcripts: deterministic, no model, no invention)
 *  - the "needs you" list, with Approve/Deny actions
 *  - proactive notifications when an agent finishes, gets stuck, or loops
 *  - quick actions on an agent (compact, stop, retest)
 *  - standing instructions the orchestrator keeps applying
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OrchestratorHost, SentMessage } from './host';

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.operator-state');
const ORCH_DIR = path.join(STATE_DIR, 'orchestrator-sessions');
const HOOK_RE = /(^|\n)\[[^\]]{8,}\]:/;

// ---------------------------------------------------------------- transcripts → turns
export interface TurnSummary {
  asked: string; said: string; tools: Record<string, number>; files: string[];
  commands: number; errors: number; startedAt: number; endedAt: number; inProgress: boolean;
  loop?: { count: number; goal: string };
  saidLong?: string;   // longer copy of the final message, used for the status summary
  question?: string;   // the question the agent's final message ends by asking the user, if any
}

export function transcriptFor(pid: number, sid: string): string | null {
  const projects = path.join(HOME, '.claude', 'projects');
  const ids: string[] = [];
  try { ids.push(JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'sessions', `${pid}.json`), 'utf-8')).sessionId); } catch { /* process gone */ }
  ids.push(sid);
  try {
    const dirs = fs.readdirSync(projects);
    for (const id of ids) {
      const d = dirs.find((x) => fs.existsSync(path.join(projects, x, `${id}.jsonl`)));
      if (d) return path.join(projects, d, `${id}.jsonl`);
    }
  } catch { /* none */ }
  return null;
}

const turnCache = new Map<string, { key: string; turns: TurnSummary[]; doing: string }>();

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return '';
}

export function turnsFor(file: string, busy: boolean): { turns: TurnSummary[]; doing: string } {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}-${st.size}-${busy}`;
  const hit = turnCache.get(file);
  if (hit && hit.key === key) return hit;

  // Only the tail: transcripts can be many MB, and the last few turns are all we show.
  const len = Math.min(st.size, 700_000);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, st.size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf-8').split('\n');
  if (st.size > len) lines.shift(); // first line is cut off

  const turns: TurnSummary[] = [];
  let cur: (TurnSummary & { hook?: boolean }) | null = null;
  let lastTool = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const ts = e.timestamp ? Math.floor(Date.parse(e.timestamp) / 1000) : 0;
    const c = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(c) && c.some((b: any) => b.type === 'tool_result')) {
        for (const b of c) if (b.type === 'tool_result' && b.is_error && cur) cur.errors++;
        continue;
      }
      const text = textOf(c).trim();
      if (!text || (text.startsWith('<') && !text.startsWith('<cross-session-message'))) continue;   // command echoes, caveats, system reminders
      // An incoming peer message is wrapped in a tag; show who it was from and what it said.
      const pm = text.match(/<cross-session-message[^>]*from-name="([^"]*)"[^>]*>\s*([\s\S]*?)\s*(<\/cross-session-message>|$)/);
      const shown = pm ? `Message from ${pm[1] || 'another session'}: ${pm[2]}` : text;
      cur = { asked: shown.replace(/\s+/g, ' ').slice(0, 200), said: '', tools: {}, files: [], commands: 0, errors: 0,
              startedAt: ts, endedAt: ts, inProgress: false, hook: HOOK_RE.test(text) && !pm };
      turns.push(cur);
    } else if (cur && Array.isArray(c)) {
      cur.endedAt = ts || cur.endedAt;
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) {
          cur.said = b.text.replace(/\s+/g, ' ').trim().slice(0, 240);
          cur.saidLong = b.text.replace(/\s+/g, ' ').trim().slice(0, 700);
          // Does the message end by asking the user something? Take the last sentence that is a question.
          const tail = b.text.replace(/\s+/g, ' ').trim().slice(-500);
          const sentences = tail.split(/(?<=[.!?])\s+/);
          const lastQ = [...sentences].reverse().find((x) => x.trim().endsWith('?'));
          cur.question = lastQ && sentences.indexOf(lastQ) >= sentences.length - 2 ? lastQ.trim().slice(0, 160) : undefined;
        }
        else if (b.type === 'tool_use') {
          cur.tools[b.name] = (cur.tools[b.name] ?? 0) + 1;
          lastTool = `${b.name} ${b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.to ?? ''}`.trim().slice(0, 100);
          const fp = b.input?.file_path;
          if (fp && /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name)) { const f = path.basename(fp); if (!cur.files.includes(f)) cur.files.push(f); }
          if (b.name === 'Bash') cur.commands++;
        }
      }
    }
  }

  // Collapse runs of /goal-loop feedback turns into one line: they are the same turn repeated.
  const out: TurnSummary[] = [];
  for (const t of turns as Array<TurnSummary & { hook?: boolean }>) {
    const prev = out[out.length - 1];
    if (t.hook) {
      const goal = t.asked.match(/\[([^\]]{8,})\]/)?.[1] ?? 'goal loop';
      if (prev?.loop) { prev.loop.count++; prev.endedAt = t.endedAt; prev.said = t.said || prev.said; }
      else out.push({ ...t, asked: `Goal loop: ${goal}`, loop: { count: 1, goal } });
    } else out.push(t);
  }
  const last = out[out.length - 1];
  if (last && busy) last.inProgress = true;
  const res = { key, turns: out.slice(-6), doing: busy ? lastTool : '' };
  turnCache.set(file, res);
  return res;
}


// ---------------------------------------------------------------- "Working on" headlines (model-written, cached)
const HEADLINES_FILE = path.join(ORCH_DIR, 'headlines.json');
const headlines: Record<string, string> = readJson<Record<string, string>>(HEADLINES_FILE, {});
const headlineQueue: Array<{ key: string; prompt: string; apply?: (out: string) => void }> = [];
const headlineQueued = new Set<string>();

/** What the user is asking this agent to accomplish, in one short line. Cached; computed in the background. */
function headlineFor(sid: string, asked: string[], said: string): string | null {
  if (!asked.length) return null;
  const key = `${sid}|goal|${createHash('sha1').update(asked.join('\n')).digest('hex').slice(0, 12)}`;
  if (headlines[key]) return headlines[key];
  queueSummary(key, `Below are the most recent requests a person made to a coding agent, oldest first. In ONE short line (at most 14 words) say what the agent is working toward right now, as a goal that starts with a verb like "Adding", "Fixing", "Designing", "Deciding". Weight the most recent request most, and use earlier ones only to understand what it refers to. Do not quote them. Output only that line, nothing else.\n\n${asked.map((t, i) => `${i + 1}. ${t.slice(0, 300)}`).join('\n')}`);
  return null;
}

/** What the agent says it just accomplished, in one short past-tense line, from its own final message. */
function outcomeFor(sid: string, asked: string, said: string, files: string[]): string | null {
  if (!said) return null;
  const key = `${sid}|done|${createHash('sha1').update(asked + '\n' + said).digest('hex').slice(0, 12)}`;
  if (headlines[key]) return headlines[key];
  queueSummary(key, `A coding agent was asked: "${asked.slice(0, 300)}"\nIts final message was: "${said.slice(0, 600)}"${files.length ? `\nFiles it edited: ${files.join(', ')}` : ''}\n\nIn ONE short line (at most 16 words), in the past tense, say what it accomplished or concluded, using only what its final message says. If it did not actually finish or only asked a question, say what it is waiting for. Output only that line, nothing else.`);
  return null;
}

export interface Stand { decisions: string[]; issues: string[]; done: string[] }

/** Where the agent stands: what is waiting on a decision, what is broken or blocked, what is finished. */
function standFor(sid: string, turns: TurnSummary[]): Stand | null {
  const recent = turns.filter((t) => !t.loop && t.asked).slice(-6);
  if (!recent.length) return null;
  const body = recent.map((t, i) => `Exchange ${i + 1}\n  The person asked: ${t.asked.slice(0, 220)}\n  The agent's final message: ${(t.saidLong || t.said || '(no text reply)').slice(0, 700)}${t.errors ? `\n  Tool errors during this exchange: ${t.errors}` : ''}${t.files.length ? `\n  Files it edited: ${t.files.join(', ')}` : ''}`).join('\n\n');
  const key = `${sid}|stand|${createHash('sha1').update(body).digest('hex').slice(0, 12)}`;
  const hit = headlines[key];
  if (hit) { try { const j = JSON.parse(hit); return { decisions: j.decisions ?? [], issues: j.issues ?? [], done: j.done ?? [] }; } catch { return null; } }
  queueSummary(key, `You are summarizing where a coding agent's work stands, for a person who supervises several agents. Below are its recent exchanges, oldest first. Reply with ONLY a JSON object, no other text, in exactly this shape: {"decisions":[],"issues":[],"done":[]}
- decisions: things still waiting on the person to decide or answer, including choices the agent put to them. Max 3, each at most 14 words. Only if still unresolved after the last exchange.
- issues: problems that are still unresolved after the last exchange: bugs, blockers, errors, things not working yet. Max 3, each at most 14 words.
- done: concrete things already completed in this body of work, past tense. Max 5, each at most 12 words.
Use only what the text says; never guess or add anything. Anything that was fixed or decided in a later exchange must not appear as pending. If a list has nothing, use [].

${body}`);
  return null;
}

function queueSummary(key: string, prompt: string, apply?: (out: string) => void) {
  if (headlineQueued.has(key)) return;
  headlineQueued.add(key); headlineQueue.push({ key, prompt, apply }); void runHeadlines();
}

const SUMMARY_WORKERS = 3;      // summaries run a few at a time so a long history is read in minutes, not an hour
let activeSummaries = 0;

function runHeadlines() {
  while (activeSummaries < SUMMARY_WORKERS && headlineQueue.length) {
    const job = headlineQueue.shift()!;
    activeSummaries++;
    void runJob(job).finally(() => { activeSummaries--; runHeadlines(); });
  }
}

async function runJob(job: { key: string; prompt: string; apply?: (out: string) => void }) {
  try {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(cleanEnv)) if (k.startsWith('CLAUDE_CODE_')) delete cleanEnv[k];
    const out = await run('claude', ['-p', '--model', 'claude-haiku-4-5-20251001', '--tools', '', '--permission-mode', 'dontAsk',
      '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', job.prompt],
      { ...cleanEnv, PWD: '/tmp' }, 90000, '/tmp');
    if (job.apply) { job.apply(out); return; }
    let line = out.split('\n').map((l) => l.trim()).find((l) => l && !/^\*\*?tokens/i.test(l) && !l.startsWith('#')) ?? '';
    if (job.key.includes('|stand|')) {
      const m = out.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
      try { line = m ? JSON.stringify(JSON.parse(m[0])) : ''; } catch { line = ''; }
    }
    const clean = job.key.includes('|stand|') ? line : line.replace(/^["'`\-\*\s]+|["'`\s]+$/g, '').slice(0, 140);
    if (clean) { headlines[job.key] = clean; fs.mkdirSync(ORCH_DIR, { recursive: true }); fs.writeFileSync(HEADLINES_FILE, JSON.stringify(headlines, null, 2)); }
  } catch (e) { console.error('[headline]', (e as Error).message.slice(0, 160)); }
  finally { headlineQueued.delete(job.key); }
}

// ---------------------------------------------------------------- digest + status
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 15000, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env, timeout, cwd, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out)));
    child.stdin?.end();   // nothing is piped in; without this the CLI waits ~3s for stdin before it starts
  });
}

export interface Deps { host: OrchestratorHost; binDir: string; bridgeUrl: string }
let deps: Deps;
const env = () => ({ ...process.env, PATH: `${deps.binDir}:${process.env.PATH}`, BRIDGE_URL: deps.bridgeUrl });

let digestCache: { at: number; agents: any[] } | null = null;
export async function getAgents(): Promise<any[]> {
  if (digestCache && Date.now() - digestCache.at < 2000) return digestCache.agents;
  const out = await run(path.join(deps.binDir, 'orch-status'), ['--json'], env());
  const agents = JSON.parse(out);
  digestCache = { at: Date.now(), agents };
  return agents;
}

function readJson<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; } }

export interface NeedItem {
  id: string; kind: 'blocked' | 'held' | 'stalled' | 'approval' | 'usage';
  title: string; detail: string; sid?: string; actions: Array<'approve' | 'deny'>;
}

function pendingApprovals(): any[] {
  const dir = path.join(STATE_DIR, 'approvals', 'pending');
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson<any>(path.join(dir, f), null)).filter(Boolean); } catch { return []; }
}

export async function buildStatus() {
  const agents = await getAgents();
  const ledger = deps.host.readMessages();
  const tasks = readJson<any[]>(path.join(ORCH_DIR, 'tasks.json'), []);
  const now = Date.now() / 1000;

  const enriched = agents.map((a: any) => {
    let turns: TurnSummary[] = [], doing = '';
    const tr = transcriptFor(a.pid, a.sid);
    if (tr) { try { ({ turns, doing } = turnsFor(tr, a.state === 'WORKING')); } catch { /* unreadable */ } }
    let doneLog = { items: [] as DoneItem[], total: 0, read: 0, of: 0 };
    if (tr) {
      try { ensureDone(a.sid, tr, a.state === 'WORKING'); } catch { /* unreadable */ }
      const l = readLedger(a.sid);
      doneLog = { items: [...l.items].sort((x, y) => y.at - x.at).slice(0, 1500), total: l.items.length, read: l.processed.length, of: coverage.get(a.sid)?.total ?? l.processed.length };
    }
    const recentAsks = turns.filter((t) => !t.loop && t.asked).slice(-3).map((t) => t.asked);
    const headline = headlineFor(a.sid, recentAsks, turns.at(-1)?.said ?? '');
    const lastDone = [...turns].reverse().find((t) => !t.loop && !t.inProgress && t.said);
    const outcome = lastDone ? outcomeFor(a.sid, lastDone.asked, lastDone.said, lastDone.files) : null;
    return {
      ...a, turns, doing, headline, outcome, stand: standFor(a.sid, turns), doneLog, lastSaid: lastDone?.said ?? '', asking: lastDone?.question ?? '',
      messages: ledger.filter((m) => m.to === a.peer || (!!a.name && m.to === a.name)).slice(-4).reverse(),
      tasks: tasks.filter((t) => t.sid === a.sid).slice(-3).reverse().map((t) => ({ text: String(t.text).slice(0, 140), status: t.status, sentAt: t.sentAt, reply: t.reply ?? '' })),
    };
  });

  const recent = [...ledger.filter((m) => now - m.sentAt < 3600).map((m) => m.state), ...tasks.filter((t) => now - t.sentAt < 3600).map((t) => t.status)];
  const summary = {
    total: recent.length,
    waiting: recent.filter((s) => s === 'waiting' || s === 'sent' || s === 'released').length,
    held: recent.filter((s) => s === 'held').length,
    replied: recent.filter((s) => s === 'seen' || s === 'reported' || s === 'answered').length,
    stalled: recent.filter((s) => ['stalled', 'lost', 'expired', 'denied', 'refused'].includes(s)).length,
  };

  const needs: NeedItem[] = [];
  for (const a of enriched) {
    if (a.state === 'BLOCKED') needs.push({ id: `blocked:${a.sid}`, kind: 'blocked', sid: a.sid, title: a.topic || a.label,
      detail: a.prompt ? `Waiting on a permission prompt: ${a.prompt}` : 'Waiting on a permission prompt (the question itself is not readable from here)', actions: ['approve', 'deny'] });
  }
  for (const m of ledger.filter((x) => x.state === 'held')) {
    const a = enriched.find((x: any) => x.peer === m.to || x.name === m.to);
    needs.push({ id: `held:${m.msgId}`, kind: 'held', sid: a?.sid, title: `Message to ${a?.topic || m.to} is on hold`,
      detail: `"${m.text.slice(0, 120)}": the receiving agent's user must approve it in that terminal.`, actions: [] });
  }
  for (const t of tasks.filter((x) => x.status === 'stalled')) needs.push({ id: `stalled:${t.id}`, kind: 'stalled', sid: t.sid, title: t.title || 'An agent', detail: `No reply to: "${String(t.text).slice(0, 100)}"`, actions: [] });
  for (const ap of pendingApprovals()) needs.push({ id: `approval:${ap.id}`, kind: 'approval', title: `${ap.agentId}: ${ap.riskLevel ?? ''} risk`, detail: String(ap.action ?? ''), actions: ['approve', 'deny'] });
  const rl: any = deps.host.rateLimit;
  const usage = rl ? { status: rl.status, resetsAt: rl.resetsAt, type: rl.rateLimitType, asOf: deps.host.rateLimitAt } : null;
  if (usage && usage.status && usage.status !== 'allowed') needs.push({ id: 'usage', kind: 'usage', title: 'Usage limit', detail: `Status: ${usage.status}${usage.resetsAt ? ` (resets ${new Date(usage.resetsAt * 1000).toLocaleTimeString()})` : ''}`, actions: [] });

  return { agents: enriched, summary, needsYou: needs, usage };
}



// ---------------------------------------------------------------- "Done" ledger: every accomplishment across the whole session
// Exhaustive by design. Every finished exchange in the entire transcript is read (newest first, in the background), the model
// sees ALL of the agent's messages in the exchange plus the actions it took, and is told to list every distinct accomplishment
// with no cap. Results are cached per exchange, so nothing is read twice and the list only ever grows.
const DONE_DIR = path.join(ORCH_DIR, 'done');
const LEDGER_VERSION = 2;       // bump to rebuild every ledger with a changed method
interface DoneItem { text: string; at: number }
interface DoneLedger { version: number; items: DoneItem[]; processed: number[] }
const BATCH = 4;                // small batches: bigger ones make the model compress and merge items
const MAX_PENDING_PER_AGENT = 6;

const ledgerFile = (sid: string) => path.join(DONE_DIR, `${sid}.json`);
function readLedger(sid: string): DoneLedger {
  const l = readJson<DoneLedger | null>(ledgerFile(sid), null);
  return l && l.version === LEDGER_VERSION ? l : { version: LEDGER_VERSION, items: [], processed: [] };
}
function writeLedger(sid: string, l: DoneLedger) { fs.mkdirSync(DONE_DIR, { recursive: true }); fs.writeFileSync(ledgerFile(sid), JSON.stringify(l)); }

interface FlatTurn { at: number; asked: string; said: string; did: string[] }

/** Finished exchanges across the WHOLE transcript, oldest first: the request, everything the agent said, and what it did. */
function flatTurns(file: string, busy: boolean): FlatTurn[] {
  const items = parseConversation(file);
  const turns: FlatTurn[] = [];
  let cur: (FlatTurn & { texts: string[] }) | null = null;
  const flush = () => { if (cur) { cur.said = cur.texts.join(' ').replace(/\s+/g, ' ').slice(0, 1400); turns.push(cur); } };
  for (const it of items) {
    if (it.role === 'user' || it.role === 'recv') {
      flush();
      cur = { at: it.at, asked: (it.role === 'recv' ? `From ${it.who}: ` : '') + it.text.replace(/\s+/g, ' ').slice(0, 260), said: '', did: [], texts: [] };
    } else if (cur && it.role === 'assistant') cur.texts.push(it.text);
    else if (cur && (it.role === 'tool' || it.role === 'sent') && cur.did.length < 12) {
      const line = it.role === 'sent' ? `Messaged ${it.who}` : it.text.replace(/\s+/g, ' ').slice(0, 90);
      if (!cur.did.includes(line)) cur.did.push(line);
    }
  }
  flush();
  // The newest exchange may still be running: leave it until it is finished.
  const done = turns.filter((t) => t.said);
  return busy && done.length && turns[turns.length - 1] === done[done.length - 1] ? done.slice(0, -1) : done;
}

const doneInflight = new Map<string, Set<string>>();     // sid -> job keys currently queued/running
const lastEnsure = new Map<string, number>();
const coverage = new Map<string, { total: number }>();

function summarizeBatch(sid: string, batch: FlatTurn[]) {
  const key = `${sid}|ledger2|${createHash('sha1').update(batch.map((t) => t.at + t.asked).join('|')).digest('hex').slice(0, 12)}`;
  const body = batch.map((t, i) => `Exchange ${i + 1}\n  The person asked: ${t.asked}\n  What the agent said: ${t.said}${t.did.length ? `\n  Actions it took: ${t.did.join('; ')}` : ''}`).join('\n\n');
  const jobs = doneInflight.get(sid) ?? new Set<string>(); jobs.add(key); doneInflight.set(sid, jobs);
  queueSummary(key, `Below are exchanges between a person and a coding agent, oldest first. List EVERY distinct thing that was completed in them: features added, bugs fixed, files created or changed, deployments and releases, decisions that were made and settled, and checks that passed. One item per distinct accomplishment; do not merge or summarize several into one; when unsure whether to include something that was done, include it. Do not list questions, plans, intentions, or anything the agent says is still broken, unfinished, or was undone. Use only what the text says; never guess. Past tense, at most 14 words each, no limit on how many items.\nReply with ONLY a JSON array of objects like [{"exchange":1,"item":"Fixed the rocket launcher spawn timing"}], or [] if nothing was completed.\n\n${body}`, (out) => {
    try {
      const m = out.replace(/```(?:json)?/g, '').match(/\[[\s\S]*\]/);
      const arr: any[] = m ? JSON.parse(m[0]) : [];
      const l = readLedger(sid);
      const seen = new Set(l.items.map((x) => x.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
      for (const r of Array.isArray(arr) ? arr : []) {
        const text = String(typeof r === 'string' ? r : r?.item ?? '').trim().slice(0, 150);
        const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const ex = Math.min(Math.max(Number(typeof r === 'object' ? r?.exchange : 1) || 1, 1), batch.length);
        if (text && !seen.has(norm)) { seen.add(norm); l.items.push({ text, at: batch[ex - 1].at }); }
      }
      for (const t of batch) if (!l.processed.includes(t.at)) l.processed.push(t.at);   // only after a successful read
      writeLedger(sid, l);
    } catch { /* not marked processed: it will be retried on a later pass */ }
    jobs.delete(key);
  });
}

/** Queue reading for exchanges not yet in the ledger, newest first, a few batches at a time. */
function ensureDone(sid: string, file: string, busy: boolean) {
  const now = Date.now();
  if (now - (lastEnsure.get(sid) ?? 0) < 12000) return;       // a big transcript is not re-scanned on every poll
  lastEnsure.set(sid, now);
  const turns = flatTurns(file, busy);
  coverage.set(sid, { total: turns.length });
  const l = readLedger(sid);
  const seenAt = new Set(l.processed);
  const todo = turns.filter((t) => !seenAt.has(t.at));
  const room = MAX_PENDING_PER_AGENT - (doneInflight.get(sid)?.size ?? 0);
  if (!todo.length || room <= 0) return;
  const newestFirst = [...todo].reverse();
  for (let i = 0; i < room; i++) {
    const batch = newestFirst.slice(i * BATCH, (i + 1) * BATCH).reverse();     // oldest first inside the batch
    if (batch.length) summarizeBatch(sid, batch);
  }
}

/** Kept for the older UI button: reading the whole history is automatic now. */
export async function backfillDone(_sid: string): Promise<{ ok: boolean; message: string }> {
  return { ok: true, message: 'The whole history is read automatically; the count in the Done header shows progress.' };
}

// ---------------------------------------------------------------- full conversation view
export interface ConvItem { i: number; role: 'user' | 'assistant' | 'tool' | 'error' | 'system' | 'recv' | 'sent'; text: string; at: number; who?: string }
const convCache = new Map<string, { key: string; items: ConvItem[] }>();

function parseConversation(file: string): ConvItem[] {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}-${st.size}`;
  const hit = convCache.get(file);
  if (hit && hit.key === key) return hit.items;
  const items: ConvItem[] = [];
  const add = (role: ConvItem['role'], text: string, at: number, who?: string) => { if (text.trim()) items.push({ i: items.length, role, text, at, who }); };
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const at = e.timestamp ? Math.floor(Date.parse(e.timestamp) / 1000) : 0;
    const c = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(c) && c.some((b: any) => b.type === 'tool_result')) {
        for (const b of c) if (b.type === 'tool_result' && b.is_error) add('error', `Tool error: ${(Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join(' ') : String(b.content ?? '')).replace(/\s+/g, ' ').slice(0, 300)}`, at);
        continue;
      }
      const text = textOf(c).trim();
      if (!text) continue;
      if (text.startsWith('<command-name>') || text.startsWith('<local-command')) { add('system', text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200), at); continue; }
      if (text.startsWith('<') && !text.startsWith('<cross-session-message')) continue;
      const pm = text.match(/<cross-session-message[^>]*from-name="([^"]*)"[^>]*>\s*([\s\S]*?)\s*<\/cross-session-message>/);
      if (pm) { add('recv', pm[2].slice(0, 2000), at, pm[1] || 'another session'); continue; }
      if (HOOK_RE.test(text)) { add('system', `Goal-loop feedback: ${text.replace(/\s+/g, ' ').slice(0, 200)}`, at); continue; }
      add('user', text.slice(0, 4000), at);
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) add('assistant', b.text.slice(0, 6000), at);
        else if (b.type === 'tool_use' && b.name === 'SendMessage') add('sent', String(b.input?.message ?? '').slice(0, 2000), at, String(b.input?.to ?? ''));
        else if (b.type === 'tool_use') add('tool', `${b.name}  ${b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.to ?? ''}`.trim().slice(0, 240), at);
      }
    } else if (e.type === 'system' && (e.subtype === 'local_command' || e.subtype === 'informational')) {
      const t = String(e.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) add('system', t.slice(0, 200), at);
    }
  }
  convCache.set(file, { key, items });
  return items;
}

/** A page of an agent's full conversation, newest last. `before` is an item index: pass the first index you have to load earlier ones. */
export async function conversationFor(sid: string, before?: number, limit = 150) {
  const a = (await getAgents()).find((x: any) => x.sid === sid || (sid.length >= 6 && x.sid.startsWith(sid)));
  if (!a) return { ok: false as const, message: 'That agent is no longer running.' };
  const tr = transcriptFor(a.pid, a.sid);
  if (!tr) return { ok: false as const, message: 'This agent has no transcript yet.' };
  const all = parseConversation(tr);
  const end = before === undefined ? all.length : Math.max(0, Math.min(before, all.length));
  const start = Math.max(0, end - limit);
  return { ok: true as const, title: a.topic || a.label, sid: a.sid, total: all.length, start, items: all.slice(start, end) };
}

// ---------------------------------------------------------------- decisions & quick actions
const KEYS = { approve: 'enter', deny: 'esc' } as const;

async function currentState(sid: string) { return (await getAgents()).find((a: any) => a.sid === sid || (sid.length >= 6 && a.sid.startsWith(sid))); }

export async function decide(id: string, decision: 'approve' | 'deny'): Promise<{ ok: boolean; message: string }> {
  const [kind, ref] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'blocked') {
    digestCache = null;
    const a = await currentState(ref);
    if (!a) return { ok: false, message: 'That agent is no longer running.' };
    if (a.state !== 'BLOCKED') return { ok: false, message: 'That agent is no longer waiting on a prompt, so nothing was pressed.' };
    if (/trust (this|the) folder/i.test(a.prompt || '')) return { ok: false, message: 'That is a folder-trust prompt whose default answer is No. Answer it in the terminal.' };
    await run(path.join(deps.binDir, 'orch-send'), [ref.slice(0, 8), '--key', KEYS[decision]], env());
    digestCache = null;
    return { ok: true, message: `${decision === 'approve' ? 'Approved' : 'Denied'}: pressed ${KEYS[decision]} on "${a.topic || a.label}" [${a.sid.slice(0, 8)}].` };
  }
  if (kind === 'approval') {
    const pend = path.join(STATE_DIR, 'approvals', 'pending', `${ref}.json`);
    const rec = readJson<any>(pend, null);
    if (!rec) return { ok: false, message: 'That approval is no longer pending.' };
    const dest = path.join(STATE_DIR, 'approvals', decision === 'approve' ? 'approved' : 'rejected');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, `${ref}.json`), JSON.stringify({ ...rec, status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date().toISOString(), decisionNotes: 'Decided from the orchestrator cockpit' }, null, 2));
    fs.unlinkSync(pend);
    return { ok: true, message: `${decision === 'approve' ? 'Approved' : 'Rejected'} approval ${ref}.` };
  }
  return { ok: false, message: 'This item has no decision to make here.' };
}

export async function quickAction(sid: string, action: 'compact' | 'stop' | 'retest'): Promise<{ ok: boolean; message: string }> {
  digestCache = null;
  const a = await currentState(sid);
  if (!a) return { ok: false, message: 'That agent is no longer running.' };
  const who = `"${a.topic || a.label}" [${a.sid.slice(0, 8)}]`;
  if (action === 'stop') {
    await run(path.join(deps.binDir, 'orch-send'), [sid.slice(0, 8), '--key', 'esc'], env());
    return { ok: true, message: `Sent Esc (interrupt) to ${who}.` };
  }
  if (a.state === 'BLOCKED') return { ok: false, message: `${who} is waiting on a decision; resolve that first.` };
  if (action === 'compact') {
    await run(path.join(deps.binDir, 'orch-send'), [sid.slice(0, 8), '--confirmed', '/compact'], env(), 30000);
    return { ok: true, message: `Sent /compact to ${who}.` };
  }
  await run(path.join(deps.binDir, 'orch-send'), [sid.slice(0, 8), 'Please re-run the project\'s tests or checks now and tell me exactly what passed and what failed.'], env(), 30000);
  return { ok: true, message: `Asked ${who} to re-run its tests and report.` };
}

// ---------------------------------------------------------------- standing instructions
export interface Standing { id: string; text: string; createdAt: number; active: boolean }
const STANDING_FILE = path.join(ORCH_DIR, 'standing.json');
export const readStanding = (): Standing[] => readJson<Standing[]>(STANDING_FILE, []);
const writeStanding = (l: Standing[]) => { fs.mkdirSync(ORCH_DIR, { recursive: true }); fs.writeFileSync(STANDING_FILE, JSON.stringify(l, null, 2)); };

function announceStanding() {
  const act = readStanding().filter((s) => s.active);
  deps.host.sendSystem(act.length
    ? `[standing-instructions] The user's standing instructions are now:\n${act.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}\nKeep applying them. When an [event] message arrives about an agent, check whether any instruction applies and act on it; any state-changing step still needs the user's explicit yes naming the target.`
    : '[standing-instructions] The user has no standing instructions now.');
}
export function addStanding(text: string): Standing {
  const list = readStanding();
  const s = { id: Math.random().toString(36).slice(2, 10), text: text.trim().slice(0, 400), createdAt: Math.floor(Date.now() / 1000), active: true };
  list.push(s); writeStanding(list); announceStanding();
  return s;
}
export function removeStanding(id: string) { writeStanding(readStanding().filter((s) => s.id !== id)); announceStanding(); }

// ---------------------------------------------------------------- proactive watcher
interface Seen { state: string; since: number; loop: boolean; notifiedBlocked: boolean }
const seen = new Map<string, Seen>();
const notifiedHeld = new Set<string>();
const notifiedStalled = new Set<string>();
const notifiedUnanswered = new Set<string>();
const reportedLedger = new Set<string>();
let notifiedUsage = '';

function notify(level: 'info' | 'warn', title: string, text: string, sid?: string, forModel = true) {
  deps.host.notify({ level, title, text, sid });
  // Only wake the orchestrator's model when the user has standing instructions to apply: otherwise it costs nothing.
  if (forModel && readStanding().some((s) => s.active)) deps.host.sendSystem(`[event] ${title}: ${text}`);
}

async function watch() {
  try {
    const status = await buildStatus();
    const now = Date.now() / 1000;
    for (const a of status.agents) {
      const label = `"${a.topic || a.label}" [${a.sid.slice(0, 8)}]`;
      const prev = seen.get(a.sid);
      if (!prev) { seen.set(a.sid, { state: a.state, since: now, loop: !!a.hasGoalLoop, notifiedBlocked: a.state === 'BLOCKED' }); continue; }
      if (a.state !== prev.state) {
        const workedFor = now - prev.since;
        if (prev.state === 'WORKING' && a.state === 'IDLE' && workedFor >= 25 && !a.hasGoalLoop)
          notify('info', `${a.topic || a.label} finished`, a.turns?.at(-1)?.said || 'It is idle now.', a.sid);
        if (a.state === 'BLOCKED') notify('warn', `${a.topic || a.label} needs you`, a.prompt ? `Waiting on: ${a.prompt}` : 'It is stopped at a permission prompt.', a.sid);
        prev.state = a.state; prev.since = now;
      }
      if (a.hasGoalLoop && !prev.loop) notify('warn', `${a.topic || a.label} is looping`, `A goal loop keeps restarting it${a.goal ? `: "${String(a.goal).slice(0, 100)}"` : ''}. ${label}`, a.sid);
      prev.loop = !!a.hasGoalLoop;
    }
    for (const m of deps.host.readMessages()) {
      if (m.state === 'held' && !notifiedHeld.has(m.msgId)) { notifiedHeld.add(m.msgId); notify('warn', 'A message is on hold', `"${m.text.slice(0, 100)}" needs approval in the receiving agent's terminal.`); }
    }
    for (const t of readJson<any[]>(path.join(ORCH_DIR, 'tasks.json'), [])) {
      if (t.status === 'stalled' && !notifiedStalled.has(t.id)) { notifiedStalled.add(t.id); notify('warn', `${t.title || 'An agent'} has not replied`, `No answer to: "${String(t.text).slice(0, 100)}"`, t.sid); }
    }
    // An agent that finished the turn handling our message but never messaged back (a person-driven session, or an agent
    // that forgot): report what it said ourselves, so the user is never left waiting in silence.
    for (const m of deps.host.readMessages()) {
      if ((m.state !== 'sent' && m.state !== 'released') || now - m.sentAt < 20) continue;
      const a: any = status.agents.find((x: any) => x.peer === m.to || (x.name && x.name === m.to));
      if (!a) continue;
      if (now - m.sentAt > 600 && !notifiedUnanswered.has(m.msgId)) {
        notifiedUnanswered.add(m.msgId);
        notify('warn', `${a.topic || a.label} has not replied`, `No answer in 10 minutes to: "${m.text.slice(0, 100)}"`, a.sid, false);
      }
      if (a.state !== 'IDLE' || reportedLedger.has(m.msgId)) continue;
      const needle = m.text.slice(0, 30);
      const t = [...(a.turns || [])].reverse().find((x: any) => !x.inProgress && x.endedAt >= m.sentAt && x.said && x.asked.includes(needle));
      if (!t) continue;
      reportedLedger.add(m.msgId);
      deps.host.markDone(m.msgId, t.said);
      deps.host.sendSystem(`[agent-reply] "${a.topic || a.label}" [${a.sid.slice(0, 8)}] finished the turn handling your message ("${m.text.slice(0, 120)}") but did not message you back. Its last message was: "${t.said}". Tell the user what it said, in plain words, naming the agent. Do not message any agent now.`);
    }
    const u = status.usage;
    if (u && u.status && u.status !== 'allowed' && notifiedUsage !== u.status) { notifiedUsage = u.status; notify('warn', 'Usage limit', `Status: ${u.status}`, undefined, false); }
  } catch (e) { console.error('[insights watch]', (e as Error).message); }
}

export function startInsights(d: Deps) {
  deps = d;
  setInterval(watch, 5000);
}
