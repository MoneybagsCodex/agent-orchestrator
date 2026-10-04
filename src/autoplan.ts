// Auto-planning: detect work an agent says still needs doing ("we need X", "next is Y", "should add Z") in its own messages.
// Pure functions only (no I/O) so the patterns can be tested directly; server.ts does the scanning and the plan writes.

export interface Detected { title: string; pattern: string }

// Each pattern captures the work description in group 1. Order matters: the first pattern that matches a sentence wins.
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'we-need', re: /\b(?:we|i)(?:'ll| will)? (?:still )?need to\s+(.+)/i },
  { name: 'we-need-noun', re: /\b(?:we|i)(?:'ll| will)? (?:still )?need\s+(?!to\b)(?:a |an |the |some )?(.+)/i },
  { name: 'next-is', re: /\bnext(?: up| step)?(?:,)? (?:is|are|up is|would be)\s+(?:to\s+)?(.+)/i },
  { name: 'next-colon', re: /^\W*next(?: up| steps?)?\s*[:\-–—]\s*(.+)/i },
  { name: 'next-we', re: /\bnext,? (?:we|i)(?:'ll| will| should| need to| must)?\s+(.+)/i },
  { name: 'should', re: /\b(?:we|i) (?:should|ought to|must)\s+(?:also |then |still )?((?:add|build|create|implement|write|fix|wire|document|test|refactor|handle|support|remove|migrate|update|extend|verify|ship)\b.+)/i },
  { name: 'should-add', re: /\bshould (?:also )?((?:add|build|create|implement|write|fix|wire|document|test|refactor|handle|support|remove|migrate|update|extend|verify)\b.+)/i },
  { name: 'todo', re: /^\W*(?:todo|to-do|follow[- ]?up|remaining|still to do)\s*[:\-–—]\s*(.+)/i },
  { name: 'left-to-do', re: /\b(?:what's|what is|still) left(?: to do)?(?: is|:)\s+(.+)/i },
];

// A sentence that negates or hedges the need is not work to plan.
const NEGATED = /\b(?:don't|do not|doesn't|does not|didn't|no longer|never|without|not) (?:really )?need|\bno need\b|\bnothing (?:left|more) to\b|\bif (?:we|you|needed)\b|\bwhether\b|\bmight need\b|\bmaybe\b/i;
// A title that says nothing concrete: pronouns, filler, or a bare verb.
const VAGUE_WORDS = new Set(['it', 'that', 'this', 'them', 'those', 'these', 'something', 'stuff', 'things', 'thing', 'more', 'work', 'some', 'else', 'anything', 'everything', 'improvements', 'changes', 'fixes', 'cleanup', 'more work', 'a few things', 'to', 'the', 'a', 'an', 'and', 'then', 'also', 'again', 'now', 'later', 'here', 'there']);
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'in', 'on', 'with', 'is', 'are', 'be', 'we', 'i', 'it', 'that', 'this', 'also', 'then', 'so', 'as', 'at', 'by', 'from']);

export const MIN_TITLE_CHARS = 12;
export const MIN_TITLE_WORDS = 3;
export const MAX_PER_MESSAGE = 3;

/** Strip fenced and inline code and blockquotes so only the agent's own prose is scanned. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, (m) => m.slice(1, -1)).replace(/^\s*>.*$/gm, ' ');
}

function sentences(text: string): string[] {
  return prose(text)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z"'`*\-•])/)
    .map((s) => s.replace(/^[\s>*\-•\d.)#]+/, '').replace(/\*\*|__/g, '').trim())
    .filter((s) => s.length > 0 && !s.endsWith('?'));
}

function clean(raw: string): string {
  let t = raw.trim().split(/\b(?:because|since|so that|which means|but then)\b|[;(]|\s[-–—]\s|\.\s|:\s/i)[0].trim();
  t = t.replace(/[.!,:\s]+$/, '').replace(/^(?:to|also|then|still)\s+/i, '').replace(/\s+/g, ' ');
  if (!t) return '';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 100 ? t.slice(0, 99).replace(/\s+\S*$/, '') + '…' : t;
}

export function isVague(title: string): boolean {
  const words = title.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  if (title.length < MIN_TITLE_CHARS || words.length < MIN_TITLE_WORDS) return true;
  const content = words.filter((w) => !STOP.has(w) && !VAGUE_WORDS.has(w));
  return content.length < 2;
}

/** Work descriptions found in one agent message, deduplicated within the message, at most MAX_PER_MESSAGE. */
export function detectWork(text: string): Detected[] {
  const out: Detected[] = [];
  for (const s of sentences(String(text))) {
    if (NEGATED.test(s)) continue;
    for (const p of PATTERNS) {
      const m = s.match(p.re);
      if (!m) continue;
      const title = clean(m[1]);
      if (title && !isVague(title) && !out.some((d) => sameWork(d.title, title))) out.push({ title, pattern: p.name });
      break;
    }
    if (out.length >= MAX_PER_MESSAGE) break;
  }
  return out;
}

const tokens = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map((w) => w.replace(/(?:ing|ed|es|s)$/, '')));

/** Two titles describe the same work when most of the smaller one's words appear in the other (containment, so "Add retry" matches "Add retry to the spawn path"). */
export function sameWork(a: string, b: string): boolean {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return false;
  let hit = 0; for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size) >= 0.7 && hit >= 2;
}
