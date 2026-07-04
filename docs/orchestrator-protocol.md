# Orchestrator Protocol

_The operating protocol the Sonnet-class orchestrator executes, turn by turn, when driving a multi-slice build with worker agents. Distilled from the audit trail (`docs/perfect-orchestrator-audit.md`, `docs/orchestration-speed-audit.md`, `docs/agent-orchestration-audit.md`) and adapted to the Claude Code turn-based harness (no persistent daemon). Last updated 2026-07-04._

## Objective function (optimize in this lexicographic order)

1. **Perfect result the first time** — but never overkill. Do not use a bigger/stronger model or higher effort than the task needs for a perfect result.
2. **Minimum TOTAL quota, including rework.** A too-cheap model that fails and needs retries costs more total quota than the right-sized model once. **First-time-right IS quota efficiency.** "Cheapest" = cheapest expected total, not cheapest per call.
3. **Speed / parallelism / latency.**

Restated as a rule: for each task, pick the **smallest** model+effort whose expected first-time-right probability clears the task's quality bar; among those, minimize expected total quota (incl. rework); then latency.

## Task classification → quality bar

Before dispatch, mentally fill a **TaskCard** — judge these axes (0–5): ambiguity, implementation depth, coupling, blast radius, test-oracle strength (5 = deterministic strong tests), UI judgment, security/default risk, merge-conflict risk, novelty; plus context size and required tools (shell/write/web/vision/long-context).

Required first-time-right bar by class:

| Task class | Bar | Independent reviewer? |
| --- | --- | --- |
| Mechanical edit / extraction / receipt summary | ~0.92 | no |
| Narrow implementation with strong tests | ~0.96 | no |
| Multi-file bounded implementation | ~0.975 | no |
| Shared API/schema/default behavior | ~0.985 | recommended |
| Release / security / privacy / destructive | ~0.995 | **required** (gpt-5.5 or Opus) |

These are judgment anchors, not measured probabilities (we lack local samples yet — seed with the routing table below and record outcomes in receipts to calibrate over time).

## Model selection (kills "glm-5.2 for everything")

Pick the **cheapest candidate that clears the bar after pricing rework**, from `docs/model-routing.md`'s task→model routing table. Never pick a model because it's cheap; pick it because it's the cheapest that clears the bar. Never pick a model because it's strong; that's overkill unless the bar demands it.

**Override rule:** if you want a *larger* model than the table suggests, name the concrete risk the table missed. If you want a *smaller* one, name the verification oracle (strong tests) that makes first-pass safe. Otherwise follow the table.

## Dispatch contract (the biggest first-time-right lever)

Workers fail first-pass on vague contracts. Every dispatch includes:

```
Task ID · Objective · Non-objectives · User-visible behavior
Base branch/commit · Worktree path
Allowed files · Forbidden files · Conflict domain · Dependency assumptions
Existing patterns to follow · Reference examples (before/after, failing test name, exact schema field, negative cases that must NOT change)
Verification commands · Receipt path · Max wall-clock
Model/effort selected and why · Stop/BLOCKED conditions · Return schema
```

Worker discipline (state in the prompt): restate the contract in ≤80 words before editing; smallest sufficient diff; run the verification command; write a receipt (changed files, exact commands, test tails, limitations, "forbidden files untouched"); return `DONE | NEEDS_GATE | BLOCKED | REJECTED`. Forbidden: broad refactors, deleting out-of-scope exports, silently changing defaults, editing outside allowed files, "fixed probably" without evidence, new deps without approval.

## Monitoring — event-driven + a status file, never a poller

The orchestrator is turn-based; there is no running daemon. So:
- **Terminal state = the harness completion notification.** After launching a healthy worker, spend **zero** turns checking it.
- **Progress = a status file, read cheaply on wake.** Workers append one JSON line per milestone to `.orchestrator/events.jsonl` (schema below). When you're already active (woken by a notification), read that file once to see ALL workers' states — one cheap read, not repeated polling.
- **Deadline = one `ScheduleWakeup`** at each worker's max wall-clock + grace, used ONLY if no completion notification arrived. On that single wake: check output freshness + process activity; if active, extend once; if stalled/over budget, stop via harness, inspect diff, salvage, resume-from-diff.
- **No poller model. No 2–3 min watchdog. No "status?" turns. No CI-watch loops** (use `gh pr merge --auto`).

Status event schema (one JSON line):
```json
{"ts":"2026-07-04T18:00:00Z","taskId":"menu-s6-schema","worker":"opencode-go/deepseek-v4-flash","state":"TEST_PASSED","branch":"agent/menu-s6-schema","worktree":"../myshell-tools-wt/menu-s6-schema","receipt":"docs/receipts/menu-s6-schema.md","summary":"schema tests green"}
```
States: `STARTED · PLAN_READY · FIRST_EDIT · TEST_STARTED · TEST_PASSED · TEST_FAILED · RECEIPT_WRITTEN · BLOCKED`. (Chat only when BLOCKED or complete.) `.orchestrator/` is gitignored — dev-only, never shipped.

## Never wait for nothing (the controller tick)

The orchestrator does not "wait"; each active turn it advances state. Maintain these queues in your head / in `.orchestrator/`: `readyToDispatch, needsContract, running, needsReview, needsIntegration, needsGate, blocked`.

Each turn (on any wake — notification or deadline):
```
1. Ingest harness notifications + read .orchestrator/events.jsonl.
2. Review any completed diff (receipt + git diff --stat + forbidden-file check + verification evidence) BEFORE starting new lower-value work.
3. Merge/rebase ready branches into the integration worktree; run focused gates that unblock dependents.
4. Dispatch ready DAG roots up to the fanout cap.
5. Prepare the next dependents' worktrees + contracts speculatively.
6. Refresh model facts only if stale or before an expensive dispatch.
7. If all workers are running and no local queue work remains, write next-batch contracts / risk checklist / integration plan.
8. ONLY if truly no useful work exists: ScheduleWakeup to the nearest deadline and stop — consuming zero model turns until an event fires.
```
The point: spend your time dispatching, reviewing, merging, preparing — not idling.

## Worktrees + fanout

One git worktree per active worker: `../myshell-tools-wt/<task-id>`, branch `agent/<slice>-<name>`. Fanout cap = `min(4, machine capacity, provider-quota headroom, count of ready independent conflict domains)`. Default 3; up to 4 for read-only/mechanical; down to 1–2 for heavy test loops or high-conflict UI state.

## Independent verification before merge

Never trust worker self-report. Before merge/report: `git diff --stat`, `git diff --name-only`, forbidden-file check, receipt exists, verification evidence exists, focused tests pass, integration gates pass. If the worker failed but produced useful work, repair from the diff — don't restart from scratch.

## Substrate choice (by task fit + expected rework, not loyalty)

- **opencode-go** (funded, smoke-confirmed): default for file-scoped implementation, mechanical edits, long-context scans, cheap parallel workers, bounded tests.
- **codex** (`gpt-5.4` / `gpt-5.4-mini`): heavier bounded coding when expected rework from open workers exceeds the stronger-model delta; OpenAI coding/computer-use strengths; fallback on opencode failure; `gpt-5.5` for planner/auditor.
- **Claude Agent** (sonnet-class): harness-native subagents; tasks needing Claude Code permissions/context; UI/test-loop work; separate Anthropic quota when others are constrained.
- **Opus**: named escalation triggers only — never a routine worker or the always-on brain.

## Why this shape (not a coded daemon in the product)

The audit's full `src/core/orchestrator/` supervisor assumes a persistent event loop the turn-based harness doesn't give the orchestrator, and would wrongly ship in the product package. This protocol keeps the *decisions* (routing, contracts, verification, queues) and the *cheap observability* (status file + one deadline wakeup) while dropping the speculative daemon and the premature probability estimator. Calibrate by recording real outcomes in receipts; harden into dev-only tooling later only if repeated use shows friction.
