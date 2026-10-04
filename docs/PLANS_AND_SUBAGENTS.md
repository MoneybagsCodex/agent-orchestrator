# Plans, routing and subagents

How work is tracked on the orchestrator dashboard (:4000). Written 2026-10-04. Applies to the lead session, the master
orchestrator and every agent it coordinates.

## 1. One plan per domain

A plan is a dependency graph of steps for ONE domain. They are stored as `~/.operator-state/orchestrator-sessions/plans/<id>.json`.

| Plan id | Domain | Whose work lands here |
|---|---|---|
| `orb-brawl` | The Orb Brawl game | The video game agent |
| `orchestrator` | Orchestrator infrastructure: server, host, helper commands, dashboard behavior | The lead session (cockpit upgrade agent) and its subagents |
| `ui` | Dashboard visual design, when it is long-running work of its own | Reserved. Empty plans are hidden on the dashboard |

There is **no default plan**. Every command that touches a plan must name it, and a message that cannot be routed is
refused with a message, never filed somewhere "close enough". (A shared default is how orchestrator work ended up in the
game roadmap.)

## 2. How a task finds its plan (routing)

`routing.json` maps an agent (first 8 characters of its session id) to a plan:

```
orch-plan assign eee2648b orb-brawl        # video game agent -> game plan
orch-plan assign 985c4a10 orchestrator     # lead session     -> orchestrator plan
orch-plan plans                            # shows plans and who is routed where
```

When a task starting with `Step N: <description>` is sent to an agent, by **either** path:

1. `orch-send` (typed into the terminal), or
2. the orchestrator's `SendMessage` tool,

the server looks up the target agent's route and then:

- adds (or updates) step `<agent>-sN` **in that agent's plan**, owned by the agent, status `active`;
- chains it after that agent's previous lower-numbered step (chains never cross agents or plans);
- if the agent is **not routed**, the step is NOT added and the caller is told how to fix it:
  `NOT ADDED: agent 985c4a10 is not routed to any plan. Route it with: orch-plan assign ...`.
  `orch-overview` also lists unrouted agents.

Rules of thumb: new long-lived agent -> `orch-plan assign` it before sending it numbered steps. A new domain -> `orch-plan new <id> "<title>"`
first. Never put one domain's work in another domain's plan; move it instead (edit the plan files via `orch-plan set`).

Statuses: `todo`, `active`, `done`, `blocked`, `decide`. Sending the next step does not complete the previous one. A step becomes `done` when an agent reports finishing it (section 9 detects that automatically) or the lead verifies it.

## 3. Subagents

A **subagent** is a bounded worker the lead session spawns (the Agent tool), as opposed to a **peer agent**, a separate
long-lived Claude session with its own terminal (such as the video game agent).

| Use a subagent when | Use a peer agent when |
|---|---|
| The job is bounded and ends in a result to review | You want something long-lived you can talk to |
| It should not grow its own re-read context | It needs its own terminal and state |
| It can work in an isolated git worktree | It works in the live tree |

### The pattern every subagent follows

1. **Register it, and give it a plan step.** Immediately after spawning:
   ```
   POST /workers {"id":"<slug>","label":"<name>","kind":"subagent in a git worktree",
                  "plan":"<the PARENT agent's plan>","parent":"<the parent's step id>",
                  "stepTitle":"<what it delivers>","note":"<scope>"}
   ```
   The step is created in the **parent agent's plan, nested under the parent's step** (the dashboard draws it indented under
   that step with a dotted rail). It is never a separate plan. `parent` must be a step in the same plan, else the request fails.
2. **Isolate it.** Code work uses a git worktree so it cannot collide with the lead.
3. **Brief it fully and with guardrails**: goal, files, hooks that must not break, what it must not touch (ports, other agents'
   processes), and the exact report format. A subagent knows nothing but its brief.
4. **Track its lifecycle in the registry**; the nested plan step follows it automatically:

   | Worker status | Plan step | Meaning |
   |---|---|---|
   | `running` | active | working |
   | `review` | active, note "awaiting lead review" | it reported back; the lead has not verified it yet |
   | `done` | done | the lead reviewed, tested and merged or accepted it |
   | `failed` | blocked, note = reason | needs the user or a retry |
   | `cancelled` | todo | abandoned |

   Status changes to `review`, `done` and `failed` also raise a notification on the dashboard.
5. **Review gate.** A subagent's report is a claim, not a result. The lead reads the diff (especially any logic, not just
   styling), runs it against live data, and only then merges and sets `done`.
6. **Clean up**: remove the worktree and merged branch; mark the worker `done`/`cancelled`.

### What the user sees

- **Plan graph:** the subagent's step, nested under its parent step in the parent agent's plan.
- **Notifications:** when it reaches review, finishes or fails.
- **`orch-overview`** (what the orchestrator reads): a "DELEGATED WORKERS" section.
- **Not shown as tiles.** A subagent has no terminal, tokens or context of its own to display. Tiles are for peer agents.
  Reporting back invisibly is the failure mode this pattern exists to prevent: a subagent without a registry entry and a
  plan step is a bug.

## 4. Command reference

```
orch-plan plans | new <plan> "<title>" | show [plan] | set <plan> '<json>' | clear <plan>
orch-plan node [plan/]<id> <status> [note]      orch-plan owner [plan/]<id> <agent|none>
orch-plan comments <plan>                       notes kept on a plan (retrospectives, decisions); stored as plan.comments
orch-plan assign <agent-id> <plan|none>
orch-overview                                   everything in one view (agents, plans, workers, unrouted agents)
GET /plans   GET /plan?plan=   GET|POST /routing   GET|POST /workers   GET /overview
```

## 5. Swarm safety rules (added 2026-10-04)

A review of the subagent lifecycle found it trusted every caller completely. These rules are now enforced by `POST /workers` and `POST /plan/node`:

| Gap found | Rule now |
|---|---|
| Any status could follow any other, so a late or duplicate report could reopen work already merged | Moves are checked. `done` and `cancelled` are final; `failed` may go back to `running` (retry); `review` may go back to `running` (rework). Anything else returns 409 with the allowed moves. |
| Nothing limited how many subagents run at once | At most 5 unfinished workers (`ORCH_MAX_WORKERS` changes it). The 6th registration returns 429. |
| A worker that stopped reporting looked "running" forever | Derived health: `running` with no update for 20 min (per-worker `staleMinutes`, 1-240) or `review` untouched for 60 min is flagged `stalled`, shown by `orch-overview`, and raises one warning notification. |
| Re-posting the same status raised the notification again | Notifications fire only when the status actually changes. |
| `workers.json` kept only the last 30 entries, which could drop a running worker its plan step still points at | Every unfinished worker is kept; only the 30 most recent finished ones are retained. |
| A finished worker's git worktree could be left on disk | `worktreeLeft` is reported for finished workers whose worktree path still exists. |
| A parent step could be marked done while its subagent steps were still open | `POST /plan/node` refuses `done` with unfinished sub-steps (409) unless `force:true`. |

Health fields (`stalled`, `quietMinutes`, `worktreeLeft`) are computed on read and never stored, so they cannot go stale.

### Not done (deliberately)
- A stalled worker is only reported; nothing kills it. Subagents are launched by the lead's Agent tool, which the server cannot cancel from outside.
- There is no automatic retry. A failed worker blocks its step and notifies; the lead decides.
- The registry is still "report your own status". A subagent that never calls `/workers` is invisible, which is why the lead registers it at spawn time (section 3).

## 6. Tool-error reporting

A shell call that exits 1 after printing real output (a chained `grep`/`ls`/`diff` finding nothing in one step) is usually not a failure. Error lines now name the command and mark such cases as "likely a no-match ... not a real failure", and the summarizer is told not to list them as issues. This came from a real false report: a harmless exit 1 on a grep chain was summarized as a "notify function conflict" bug at `src/host.ts:166`; `notify()` itself was correct.

## 7. Burndown and swimlanes (dashboard)

The "Velocity & workload" panel under the plan graphs is computed in the browser from the steps' own timestamps; there is no extra endpoint.

- **Step timestamps:** `createdAt` (set when a step joins a plan; older steps fall back to `startedAt`), `startedAt`, `doneAt`. `doneAt` is now cleared when a step leaves `done`, so a reopened step stops counting as finished.
- **Burndown:** two step lines over time, cumulative done (solid) and total scope (dashed); the shaded gap is what remains. Velocity is steps finished in the last hour; the finish estimate is shown only when there is a pace to project from. Steps that predate `createdAt` appear at their first known time, so early scope is approximate.
- **Swimlanes:** one lane per agent (a subagent gets its own lane, unrouted work goes to "Unassigned"). Bars run from start to finish, or to now while active; overlapping steps stack on sub-rows. Colours follow step status, and an agent's live state overrides a stale "active" the same way the plan graph does.


## 8. Auto-planning from agent messages

When a routed agent *says* work still needs doing, the server turns it into a plan step so it is not lost in scrollback. This sits beside, and never replaces, numbered `Step N:` messages (section 2).

**How it runs:** every 20 s the server reads each routed agent's new prose (not tool output, not code blocks). The first time it sees an agent it only records where the transcript ends, so history is never backfilled. Each step is owned by the agent, status `todo`, marked `auto:true`, id `<agent>-a<k>`, and chained after that agent's latest step. It never edits an existing step.

**Patterns detected** (one sentence at a time; the first matching pattern wins):

| Pattern | Example |
|---|---|
| we/I need (to) | "We need to add retry logic to the spawn path" |
| next is / next up / next: | "Next is wiring the legend into the theme tokens" |
| next we/I ... | "Next, I'll write the docs" |
| we/I should/must + an action verb, "should add ..." | "We should add a stale-worker kill switch" |
| TODO / follow-up / remaining: | "TODO: handle expired tokens" |
| what's left is | "What's left is the migration" |

**Edge cases handled:**

| Case | Behaviour |
|---|---|
| Already planned | Skipped if most of the shorter title's words appear in any existing step of the plan (so "Add retry" matches "Add retry logic to the spawn path"). Logged as `skipped: already planned as <id>`. |
| Vague ("we need it", "do something", "more work") | Skipped: title under 12 characters or 2 words, or fewer than 2 meaningful words. |
| Negated or hedged ("we don't need", "if we need", "maybe", "might need") | Skipped. |
| Questions | Skipped (sentence ends with `?`). |
| Code blocks, quotes, table rows, "quoted examples" | Ignored. Inline code keeps its text. |
| Floods | At most 3 per message, 6 per agent per hour, and nothing once the plan holds 36 of its 40 steps. |
| Agent not routed | Nothing is added (same rule as section 2). |

**Controls:** `POST /plan/detect {"text":"...","sid":"<agent>"}` is a dry run showing what would be added or skipped; add `"apply":true` to write. `POST /plan/auto-config {"enabled":false}` turns the scanner off. State is in `orchestrator-sessions/autoplan.json` (cursors, hourly counts, switch). Patterns live in `src/autoplan.ts`.

**Known limits:** it is regex, not understanding; a phrasing outside the table is missed and a rare hedge can slip through, so auto steps are `todo` and need a human or lead to promote or delete them. Completion detection (section 9) only closes `active` steps, never these `todo` ones.

## 9. Completion detection (auto-marking steps done)

When a routed agent reports finishing work, the same 20 s scanner (section 8) marks that agent's own active plan step `done`, sets `doneAt`, and records `autoDone:true` plus a note quoting the sentence that triggered it.

**Which step closes:** the step the message names ("step 8 is done"); otherwise the agent's latest `active` numbered step (highest step number). Only the owner's steps are considered; `todo`, `blocked`, `decide` and auto-planned (`-aN`) steps are never closed this way.

**Phrases** (one sentence at a time, after code, quotes and table rows are stripped):

| Strength | Pattern | Examples |
|---|---|---|
| strong | published/released/deployed (optionally a version) | "Published v67." |
| strong | shipped | "Shipped.", "We've shipped it" |
| strong | step N + done/complete/finished | "Step 8 is done and committed" |
| strong | all/everything/the task/work/step/feature/fix + is done/complete | "Everything is complete" |
| weak | I/we completed, finished, wrapped up, merged, pushed | "I finished the audit" |
| weak | is/was/now/been + done/complete/finished | "The refactor is complete" |
| weak | a bare "Done." / "Complete." / "Finished." (sentence-initial) | "Done. Tests pass." |

**Guards:**

| Case | Behaviour |
|---|---|
| Negated, hedged or future ("not done", "almost done", "once it's done", "will ship", "when complete", "if", "yet to") | Ignored. Questions are ignored. |
| Weak phrase while the agent is still working | Probably about a sub-task: the scanner holds its place and re-reads when the agent is idle (gives up after 10 minutes). Strong phrases act immediately. |
| Named step is already done, or the agent has no such step | Ignored; the reason is logged as `completion ignored: ...`. |
| Step has unfinished sub-steps | Ignored (same rule as `POST /plan/node`), so a parent never closes ahead of its subagents. |
| No active step | Ignored. |
| Old messages | Never. Only messages new since the scanner first saw the agent are read. |

`POST /plan/detect` also reports `completion` and what it would close (`closed`); add `"apply":true` to really close it. `POST /plan/auto-config {"enabled":false}` turns off both detectors. Closing is undone like any step change: `orch-plan node <plan>/<id> active`.

**Known limit:** it trusts the agent's wording, the same as numbered steps did before. An agent that says "done" about only part of a step will close it early; weak phrases while working are held, but a strong phrase ("shipped") about a sub-part is not.
