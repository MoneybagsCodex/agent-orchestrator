# Cost control: what the orchestrator spends and how it limits itself

Written 2026-10-04 from the real usage log (`orchestrator-sessions/usage-log.jsonl`, 433 calls over about 7.4 hours) and from the lead session's own transcript. Tools: `orch-cost`, `GET /costs`, `GET|POST /costs/budgets`.

## 1. The accounting was wrong (fixed)

`GET /costs` reported **$1,255** for the chat. The real figure is about **$4.36**. The headless orchestrator's `total_cost_usd` is the running total of the whole process, and a resumed session starts from its history, so adding one per turn counted the same dollars hundreds of times. The chat's cost is now estimated from each turn's own token counts; one-shot summary jobs still use the per-call cost they report (that one is correct). Rows now record the model.

Prices are known only for Haiku 4.5 ($1 / $5 per million tokens in/out, cache read $0.10, cache write $1.25). A chat turn on any other model is estimated at those rates and `/costs` says so, because the real cost would be higher.

## 2. Where the orchestrator's money goes (real, last 7.4 h)

| Feature | Cost | Share | Calls | Per call |
|---|---|---|---|---|
| Chat (the persistent orchestrator) | $4.36 | 59% | 129 | $0.034 |
| Decide/issues summaries | $2.06 | 28% | 175 | $0.012 |
| Done ledger | $0.51 | 7% | 39 | $0.013 |
| "Working on" headlines | $0.27 | 4% | 58 | $0.005 |
| Finished outcomes | $0.16 | 2% | 32 | $0.005 |
| **Total** | **$7.35** | | 433 | about $1 per hour |

- **Context is the cost.** 98% of the chat's tokens are cache reads: each turn re-reads the whole conversation. Its context is now **466k tokens**, so every turn costs about $0.05 before it writes a word, and that grows with every message.
- **Restarts cost real money.** Each restart (a deploy, a model switch) writes about 150k tokens back into the cache. There were 7 in 24 hours, most from shipping code changes today.
- **Decide/issues is the second cost** and the most wasteful: 175 calls, about 1,750 output tokens each, recomputed whenever any of an agent's last six exchanges changed.

## 3. Cheaper models

Nothing left to downshift in the orchestrator: every background summary already runs on Haiku 4.5, the cheapest model, and the chat defaults to Haiku. The control is the other direction: switching the chat to a larger model multiplies the per-turn cost of an already large context, so `/costs` flags unpriced models and the chat budget warns before it grows.

## 4. Controls now in place

| Control | Behaviour |
|---|---|
| Hourly budgets (hard) | Per background feature, in USD: decide-issues 0.30, working-on 0.10, finished-outcome 0.10, done-ledger 0.20. At the cap the job is skipped, counted in `skippedForBudget`, and the last summary stays on screen. |
| Throttling | A "stand" summary is recomputed at most every 3 minutes per agent and a headline every 2 minutes; the previous text is shown meanwhile. The first summary for an agent is never delayed. |
| Chat (soft) | Never blocked, since stopping the user's own conversation would be worse. Warnings: over $1.50 in an hour, own context over 200k tokens, 3 or more restarts in 24 hours, daily spend over 80% of $12. |
| Self-report | `orch-cost` prints spend by feature, own context size, budgets and warnings. The orchestrator's role prompt tells it to run it when asked about cost or before bulk reads, and to prefer one `orch-status` digest over reading several terminals. |
| Tuning | `POST /costs/budgets {"hourlyUsd":{"decide-issues":0.5},"chatHourlyUsd":2,"dailyUsd":20,"contextWarnTokens":300000}` (stored in `budgets.json`). |

Tested with a synthetic log: over-budget feature blocked, other features and unknown features not, the chat's cumulative cost ignored, warnings produced. The throttle was reviewed but not observed end to end on live agents.

## 5. The lead session (this Claude Code session)

This is not in the usage log, so it was measured from its transcript (958 responses; relative cost units using Haiku-style weights, because I do not know the price of the model this session runs on). Shares are of the whole session, which spans several compactions.

| Operation | Share | Responses |
|---|---|---|
| Bash calls | 61% | 531 |
| Browser testing | 12% | 133 |
| Writing and editing files | 11% | 112 |
| Replies with no tool call | 10% | 99 |
| Reading and searching | 3% | 41 |
| Artifact tool | 1% | 11 |

- 70% of the cost is cache reads, 16% cache writes, 14% output. **The number of tool calls matters more than which tool**, because each call re-reads the context, which grew from about 40k to 218k tokens. Bash is first only because it is called most.
- **Artifact creation is cheap** (11 responses). Writing the HTML counts under file writes.
- By request, the heaviest were work driven by another session's messages (23%) and a goal-loop that kept re-running turns until it was satisfied (11.5%). Plan restructuring took about 2.5%.
- The largest single costs were cache rewrites of 340k to 450k tokens after the cache expired or a compaction.

**What would help:** batch independent commands into one call, compact earlier rather than at 200k, and hand broad searches to a Haiku subagent so the big reads stay out of this context. These are habits, not enforced controls: the server cannot limit a Claude Code session's own spending.

## 6. Not done

- No automatic compaction or fresh session for the orchestrator. Sending `/compact` to a headless session is untested, so it only warns.
- Chat is not capped. A model switch is not blocked.
- Output-length limits on summaries rely on the prompt wording; the CLI has no token cap flag.
- The throttle and budgets use the log's own costs, so they are only as good as the price table above.

## Auto-compaction and live token visibility

**Auto-compaction.** The host (`src/host.ts`) tracks the real context size: the input plus cache tokens of the latest model call (a logged turn sums every call in it, so it overstates). When a turn ends, the orchestrator is idle and the context is at or over `contextCompactTokens` (default 150000, `POST /costs/budgets`; 0 turns it off), the host writes `/compact` to the session itself. Guards: never mid-turn, never twice in 10 minutes (a summary still over the line would otherwise loop), the flag clears if the compact fails. The CLI's `compact_boundary` event gives before and after sizes, which are saved to `compactions.json`, shown as a notice in the chat, and logged as an estimated `orchestrator-compact` cost row (the `/compact` result itself reports no usage). Measured live: 168k to 3k tokens in 48 s, about $0.03. `POST /orchestrator/compact` (and the dashboard button) does it on demand.

`--disable-slash-commands` was removed from the headless process: with it the session answers "/compact isn't available". The model still has no Skill tool.

**Visibility.** `GET /orchestrator/tokens` (also `orchestrator` inside `/status` and `/overview`): cumulative input, output, cache read and dollars; the last turn; tokens and dollars in the last hour; average dollars per turn; context against the compact line with the dollar cost of re-reading it each turn; compaction count and last before/after. Shown as the "Orchestrator (me)" card in the dashboard, at the top of `orch-overview`, and in `orch-cost`. Cost questions, and any turn taken at 80% or more of the line, get a one-line `[self: ...]` status put in front of the message, so the orchestrator reads its own live numbers rather than guessing.

Limits: dollar figures assume Haiku 4.5 rates unless the model is priced; a restart shows the last known size until the first reply; a turn's "tokens" sums its calls, so per-turn cache read is higher than the context.
