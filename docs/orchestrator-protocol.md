# Orchestrator Protocol

_The operating protocol the Sonnet-class orchestrator executes, turn by turn, when driving a multi-slice build with worker agents. Distilled from the audit trail (`docs/perfect-orchestrator-audit.md`, `docs/orchestration-speed-audit.md`, `docs/agent-orchestration-audit.md`) and adapted to the Claude Code turn-based harness (no persistent daemon). Last updated 2026-07-04._

## Objective function (optimize in this lexicographic order)

1. **Perfect result the first time** — but never overkill. Do not use a bigger/stronger model or higher effort than the task needs for a perfect result.
2. **Minimize TOTAL quota, including rework, plus a latency penalty.** A too-cheap model that fails and needs retries costs more total quota than the right-sized model once. **First-time-right IS quota efficiency.** "Cheapest" = cheapest expected total, not cheapest per call, and wall-clock is a real cost.
3. **Remaining tie-breaks.**

Restated as a rule: latency is a first-class factor, not a tie-break. Prefer the **fastest** worker that clears the quality bar. A model finishing in minutes beats a cheaper one taking 30-45 min; the menu build took ~18h largely due to slow `glm-5.2` workers. For long-context/agentic slices, weigh a faster model or a Claude Agent (~18s on a smoke task) over `glm-5.2`. Objective: perfect-first-time (no overkill) -> minimize (total quota incl. rework + a latency penalty) -> remaining tie-breaks.
## Task classification â†’ quality bar

Before dispatch, mentally fill a **TaskCard** â€” judge these axes (0â€“5): ambiguity, implementation depth, coupling, blast radius, test-oracle strength (5 = deterministic strong tests), UI judgment, security/default risk, merge-conflict risk, novelty; plus context size and required tools (shell/write/web/vision/long-context).

Required first-time-right bar by class:

| Task class | Bar | Independent reviewer? |
| --- | --- | --- |
| Mechanical edit / extraction / receipt summary | ~0.92 | no |
| Narrow implementation with strong tests | ~0.96 | no |
| Multi-file bounded implementation | ~0.975 | no |
| Shared API/schema/default behavior | ~0.985 | recommended |
| Release / security / privacy / destructive | ~0.995 | **required** (gpt-5.5 or Opus) |

These are judgment anchors, not measured probabilities (we lack local samples yet â€” seed with the routing table below and record outcomes in receipts to calibrate over time).

## Model selection (kills "glm-5.2 for everything")

Pick the **cheapest candidate that clears the bar after pricing rework**, from `docs/model-routing.md`'s taskâ†’model routing table. Never pick a model because it's cheap; pick it because it's the cheapest that clears the bar. Never pick a model because it's strong; that's overkill unless the bar demands it.

**Override rule:** if you want a *larger* model than the table suggests, name the concrete risk the table missed. If you want a *smaller* one, name the verification oracle (strong tests) that makes first-pass safe. Otherwise follow the table.

## Dispatch contract (the biggest first-time-right lever)

Workers fail first-pass on vague contracts. Every dispatch includes:

```
Task ID Â· Objective Â· Non-objectives Â· User-visible behavior
Base branch/commit Â· Worktree path
Allowed files Â· Forbidden files Â· Conflict domain Â· Dependency assumptions
Existing patterns to follow Â· Reference examples (before/after, failing test name, exact schema field, negative cases that must NOT change)
Verification commands Â· Receipt path Â· Max wall-clock
Model/effort selected and why Â· Stop/BLOCKED conditions Â· Return schema
```

Worker discipline (state in the prompt): restate the contract in â‰¤80 words before editing; smallest sufficient diff; run the verification command; write a receipt (changed files, exact commands, test tails, limitations, "forbidden files untouched"); return `DONE | NEEDS_GATE | BLOCKED | REJECTED`. Forbidden: broad refactors, deleting out-of-scope exports, silently changing defaults, editing outside allowed files, "fixed probably" without evidence, new deps without approval.

## Monitoring — event-driven + a status file, never a poller

The orchestrator is turn-based; there is no running daemon. So:
- **Terminal state = the harness completion notification.** After launching a healthy worker, spend **zero** turns checking it.
- **Progress = a mandatory status file, read cheaply on wake.** Status-events are MANDATORY in every worker dispatch: instruct the worker to append one JSON line per milestone (`STARTED`/`FIRST_EDIT`/`TEST_PASSED`/`RECEIPT_WRITTEN`/`BLOCKED`) to `.orchestrator/events.jsonl`. When you're already active (woken by a notification), read that ONE file once to see ALL workers' states — one cheap read, not repeated polling, CPU-snapshotting, or memory-snapshotting processes.
- **Harness wrapper-death is not worker death.** The harness may kill the tracked background wrapper while the real worker process keeps running (observed repeatedly) — do NOT conclude a worker is dead from a wrapper-kill notification alone; verify via the status file, process liveness (`tasklist`), and file mtimes. A status-file `RECEIPT_WRITTEN` or a pushed commit is STRONGER evidence of completion than the wrapper notification.
- **Deadline = one `ScheduleWakeup`** at each worker's max wall-clock + grace, used ONLY if no completion notification arrived. On that single wake: read `.orchestrator/events.jsonl`, then check output freshness + process activity; if active, extend once; if stalled/over budget, stop via harness, inspect diff, salvage, resume-from-diff.
- **No poller model. No 2–3 min watchdog. No "status?" turns. No CI-watch loops** (use `gh pr merge --auto`).

Status event schema (one JSON line):
```json
{"ts":"2026-07-04T18:00:00Z","taskId":"menu-s6-schema","worker":"opencode-go/deepseek-v4-flash","state":"TEST_PASSED","branch":"agent/menu-s6-schema","worktree":"../myshell-tools-wt/menu-s6-schema","receipt":"docs/receipts/menu-s6-schema.md","summary":"schema tests green"}
```
States: `STARTED · PLAN_READY · FIRST_EDIT · TEST_STARTED · TEST_PASSED · TEST_FAILED · RECEIPT_WRITTEN · BLOCKED`. The mandatory minimum milestones per dispatch are `STARTED`, `FIRST_EDIT`, and exactly one terminal state from `TEST_PASSED`, `RECEIPT_WRITTEN`, or `BLOCKED`; include the others when they happen. (Chat only when BLOCKED or complete.) `.orchestrator/` is gitignored — dev-only, never shipped.
## Never wait for nothing (the controller tick)

The orchestrator does not "wait"; each active turn it advances state. Maintain these queues in your head / in `.orchestrator/`: `readyToDispatch, needsContract, running, needsReview, needsIntegration, needsGate, blocked`.

Each turn (on any wake â€” notification or deadline):
```
1. Ingest harness notifications + read .orchestrator/events.jsonl.
2. Review any completed diff (receipt + git diff --stat + forbidden-file check + verification evidence) BEFORE starting new lower-value work.
3. Merge/rebase ready branches into the integration worktree; run focused gates that unblock dependents.
4. Dispatch ready DAG roots up to the fanout cap.
5. Prepare the next dependents' worktrees + contracts speculatively.
6. Refresh model facts only if stale or before an expensive dispatch.
7. If all workers are running and no local queue work remains, write next-batch contracts / risk checklist / integration plan.
8. ONLY if truly no useful work exists: ScheduleWakeup to the nearest deadline and stop â€” consuming zero model turns until an event fires.
```
The point: spend your time dispatching, reviewing, merging, preparing â€” not idling.

## Worktrees + fanout

One git worktree per active worker: `../myshell-tools-wt/<task-id>`, branch `agent/<slice>-<name>`. Fanout cap = `min(4, machine capacity, provider-quota headroom, count of ready independent conflict domains)`. Default 3; up to 4 for read-only/mechanical; down to 1â€“2 for heavy test loops or high-conflict UI state.

## Independent verification before merge

Never trust worker self-report. Before merge/report: `git diff --stat`, `git diff --name-only`, forbidden-file check, receipt exists, verification evidence exists, focused tests pass, integration gates pass. If the worker failed but produced useful work, repair from the diff â€” don't restart from scratch.

## Hang thresholds and salvage

Hang thresholds scale to the task expected runtime: if comparable tasks finished in ~T minutes, treat flat output + flat CPU for the greater of `1.5x T` or 10 minutes as `HUNG`. Extend AT MOST ONCE, then stop-and-salvage — do not repeatedly extend a flat worker (a 40-min flat wait happened in the menu build). Prefer resume-from-diff over restart.
## Substrate choice (by task fit + expected rework, not loyalty)

- **opencode-go** (funded, smoke-confirmed): default for file-scoped implementation, mechanical edits, long-context scans, cheap parallel workers, bounded tests.
- **codex** (`gpt-5.4` / `gpt-5.4-mini`): heavier bounded coding when expected rework from open workers exceeds the stronger-model delta; OpenAI coding/computer-use strengths; fallback on opencode failure; `gpt-5.5` for planner/auditor.
- **Claude Agent** (sonnet-class): harness-native subagents; tasks needing Claude Code permissions/context; UI/test-loop work; separate Anthropic quota when others are constrained.
- **Opus**: named escalation triggers only â€” never a routine worker or the always-on brain.

## Why this shape (not a coded daemon in the product)

The audit's full `src/core/orchestrator/` supervisor assumes a persistent event loop the turn-based harness doesn't give the orchestrator, and would wrongly ship in the product package. This protocol keeps the *decisions* (routing, contracts, verification, queues) and the *cheap observability* (status file + one deadline wakeup) while dropping the speculative daemon and the premature probability estimator. Calibrate by recording real outcomes in receipts; harden into dev-only tooling later only if repeated use shows friction.


