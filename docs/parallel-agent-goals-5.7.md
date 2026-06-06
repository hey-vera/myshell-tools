# Parallel-Agent Goal Orchestration 5.7

Design doc only. No source changes.

This design closes the product gap behind the user intent:

> it can automatically manage goals; the user should see their goals working, and how many AGENTS and tokens are being spent on it

and:

> lets get parallel agents on this, strategically manage.

`myshell-tools` is a subscription-auth CLI. The design must keep using the user's signed-in Claude Code / Codex / OpenCode OAuth sessions through the existing provider CLIs. No API keys, embeddings, Vertex, metered model APIs, or bypasses around auth, sandbox, quota, cooldown, or tier admission.

## 1. Gap Analysis

### What `/goal` does today

The autonomous goal loop is real, but sequential.

`src/core/goal.ts` owns the pure goal primitives:

- `buildGoalTask(goal, iteration, contract?)` builds one autonomous turn prompt.
- `parseGoalSignal(output)` trusts only trailing `GOAL_COMPLETE` / `GOAL_CONTINUE`.
- `parseGoalContinueText(output)` extracts the model-stated next step.
- `decideGoalNext(opts)` stops or continues from the parsed signal, success flag, `GoalCeilings`, and spend.
- `DEFAULT_MAX_GOAL_ITERATIONS` bounds the loop at 8 turns.
- `formatGoalProgress(opts)` already renders objective, progress, elapsed, real ledger tokens, and accepts `parallelModels`; it only shows "N models in parallel" when that value is explicitly passed.

`src/interface/menu.ts` contains the actual `runGoalLoop` closure. It initializes `goalContract = capContract({ version: 1, objective: goalText })`, prints a progress line via `formatGoalProgress`, builds one `buildGoalTask`, calls the normal turn machinery with `{ workContract: goalContract, goalTurn: true }`, parses one `GOAL_*` marker, appends a checkpoint from `GOAL_CONTINUE`, then repeats. The loop reloads history each turn and computes tokens-this-goal from real `readLedger` + `summarizeSpend` deltas.

That means the user can watch one autonomous worker advance, but there is no honest way today to show "agents: 3" for `/goal`. The loop runs one turn at a time.

Real-run verification:

- Existing unit coverage in `test/unit/goal.test.ts` proves `formatGoalProgress` does not fabricate a parallel count.
- Existing menu-flow coverage proves `/goal` threads a contract and grows checkpoints from `GOAL_CONTINUE`.
- A live `/goal` run should currently show one progress line per sequential turn and no agent count unless the caller explicitly passes a parallel value.

### What the Parallel Subscription Panel already proves

`src/core/ensemble.ts` is the existing concurrency pattern to generalize, not replace.

`planPanel(opts)` gates panel formation by `panelPolicy`, risk, authenticated providers, and `maxPanelProviders`. A real panel needs at least two authenticated providers. It computes `cap = Math.max(2, maxPanelProviders)`, slices authenticated providers to that cap, and returns a `PanelPlan` with `candidates` and a deterministic `synthesizer`.

`runPanel(task, deps, plan, signal, historyContext)` then runs candidate providers concurrently with `Promise.all`, records each candidate's real usage and cost to `deps.ledger.record`, handles partial candidate failure, and runs a synthesizer through the same provider path. The comments explicitly state the event contract: emit `tier-start` for every candidate before awaiting concurrency, then `tier-done` with real metrics after completion.

This is useful but not the same as parallel goals. The panel runs several providers on one same turn, then synthesizes one answer. Parallel goals need several independent subtasks from one goal to run concurrently, each as its own agent run, then merge progress back into the goal state.

Real-run verification:

- Existing `test/unit/ensemble.test.ts` covers `planPanel` gating, cap behavior, concurrent `runPanel`, partial failure, and ledger recording with fake providers.
- A live panel turn already surfaces real provider/model starts and records real ledger entries per concurrent provider run.

### What the Work Contract gives us

`src/core/work-contract.ts` is the natural decomposition substrate:

```ts
export interface WorkContract {
  readonly version: 1;
  readonly objective: string;
  readonly vision?: string;
  readonly roadmap?: readonly RoadmapItem[];
  readonly checkpoints?: readonly Checkpoint[];
  readonly verification?: ContractVerification;
}
```

`RoadmapItem` is already `{ id, text, status }`, with status capped to `pending | active | done | blocked`. `capContract` caps roadmap items to `ROADMAP_LIMIT = 8` and checkpoints to `CHECKPOINT_LIMIT = 6`. `renderContractForPrompt` renders objective, vision, roadmap, and recent steps into provider prompts.

The gap is that `RoadmapItem` has no dependency metadata, no write scope, no subtask ownership, and no verified completion artifact. Checkpoints are explicitly "model-stated next action", not verified completion. AP2-B work-state can derive state from persisted `workTrace`, but it cannot infer independent parallel branches.

Real-run verification:

- Existing `test/unit/work-contract.test.ts` verifies capping and materialization gates.
- Existing `src/core/work-state.ts` derives truthful state from persisted `workTrace`; no future parallel state should be treated as done unless it is persisted as trace/evidence, not just described in prose.

### Existing gates that must remain authoritative

`src/core/orchestrate.ts` is the turn pipeline and must remain the provider execution path. It already:

- classifies each task;
- skips the extra intent extractor inside `goalTurn`;
- builds capability task signals and passes `CapabilityRouteContext` to `route()` when `deps.capabilityRegistry` is present;
- forms panels before hedges;
- uses `authorizeTier` / `admitManager` before manager-tier access;
- records ledger entries with real provider usage;
- persists `workTrace` on accepted assistant entries.

`src/core/flagship.ts` `authorizeTier` is the manager admission gate. Parallel goals must never route around it.

`src/core/cooldown.ts` `availableAfterCooldown` is the per-conversation rate-limit memory. Parallel goals should prefer providers not in cooldown and must never strand the user if all providers are cooling down.

`src/infra/ledger.ts` and `src/infra/insights.ts` are the source of truth for tokens and spend. Agent panels must display real ledger deltas, not estimates.

The capability registry and routing work from 3.21-3.23 already lets `route()` account for provider/model capabilities, task kind, model outcome order, available models, authenticated providers, and reasoning effort. Parallel subtasks should pass task-specific signals through the same route path.

Real-run verification:

- Any parallel-goal implementation must be testable with fake `OrchestrateDeps`, fake providers, fake ledger, and fake clock.
- Any live run must leave ledger JSONL entries for every provider call. The live panel's token total must equal the `readLedger` / `summarizeSpend` delta for the goal run.

## 2. Architecture

### Core concept

A parallel goal run is a bounded DAG of roadmap items executed in waves.

An **agent** is one concurrent subtask run in flight: a single provider/model execution through the existing orchestration/provider machinery, assigned to one concrete roadmap item or bounded subtask. The count shown to the user is the number of these agent runs currently in flight. It is never inferred from ambition, planned work, available providers, or historical runs.

One goal can therefore have:

- `plannedAgents`: the number of eligible ready subtasks in the current wave after caps.
- `runningAgents`: the real count of subtask runs currently executing.
- `completedAgents`: finished subtask runs in this wave.
- `totalTokens`: real ledger delta since goal start.

Only `runningAgents` is displayed as the live "agents" count.

Real-run verification:

- A fake-provider test with three delayed providers must show `runningAgents = 3` while all three promises are unresolved, then decrement as each settles.
- A single-provider or all-cooldown run must show `agents: 1` or omit the parallel line; it must not show a planned count as if it were running.

### Decomposition: Work Contract roadmap -> dependency plan

Add a new pure planning shape conceptually owned near `src/core/goal.ts` or a sibling pure module:

```ts
interface ParallelGoalItem {
  id: string;
  roadmapId?: string;
  label: string;
  prompt: string;
  dependsOn: readonly string[];
  status: 'pending' | 'running' | 'done' | 'blocked' | 'failed';
  writeScope?: readonly string[];
  taskKind: TaskKind;
}

interface ParallelGoalPlan {
  objective: string;
  items: readonly ParallelGoalItem[];
  waves: readonly (readonly string[])[];
  reason: string;
}
```

The actual type can differ, but the invariants matter:

- It is capped. Use the existing `WorkContract` roadmap cap as the hard upper bound; never more than 8 initial items.
- It is dependency-first. Every item has explicit `dependsOn`; no dependency means eligible for wave 1.
- It is conservative. If independence is unclear, mark the item dependent or serialize it.
- It is honest. Do not invent roadmap items beyond the user's objective and the current `WorkContract.roadmap`. If the roadmap is absent or too vague, run a cheap planning pass to create a capped roadmap and dependency labels, then cap it again.
- It is general. The planner reasons about dependencies, outputs, and write scopes, not domain-specific project assumptions.

Planner input:

- current `WorkContract` (`objective`, optional `vision`, optional `roadmap`, `checkpoints`);
- current environment/work-state context already available to `orchestrate`;
- authenticated providers after cooldown;
- max parallel guard from policy/config;
- current mode/policy.

Planner output:

- a bounded list of subtasks with dependency edges;
- the first executable wave;
- every item either maps to an existing `roadmapId` or explains why it was created by the planning pass;
- every item has a short label for the live panel.

Cheap planning pass:

- Use subscription CLI execution through existing provider machinery, not an API-key model.
- Prefer worker or IC tier unless the existing classifier/`authorizeTier` admits manager.
- Use read-only sandbox for planning.
- Ask for strict JSON with item ids, labels, dependencies, and write scopes; parse defensively.
- On parse failure, ambiguous dependencies, or no useful roadmap, fall back to sequential `/goal` rather than pretending there is parallel work.

DAG/wave construction:

1. Start from `contract.roadmap` when present.
2. Cap to at most 8 items through `capContract`.
3. Ask the planner to mark dependencies and independence; it may split only when each split has a clear, bounded completion condition.
4. Validate the DAG locally:
   - every dependency id exists;
   - no cycles;
   - every wave has at least one item;
   - no wave exceeds the effective concurrency cap;
   - items with overlapping write scopes are not placed in the same wave unless isolation is enabled.
5. If validation fails, serialize the roadmap in original order.

Real-run verification:

- Unit: planning parser rejects cycles, unknown dependency ids, duplicate ids, and over-cap outputs.
- Unit: ambiguous dependency labels serialize rather than parallelize.
- Integration with fake providers: a three-item plan where A and B have no deps and C depends on both yields waves `[[A, B], [C]]`.
- Live dry-run: `/goal` with two clearly independent read-only research subtasks shows wave 1 with two agents only when two authenticated providers are available.

### Concurrent execution: bounded agent waves

The future coordinator sits above `orchestrate`, alongside today's `runGoalLoop`, and dispatches one wave at a time.

Effective concurrency:

```text
effectiveMaxAgents =
  min(
    readyItems.length,
    authenticatedProvidersAfterCooldown.length,
    policy.parallelGoalMaxAgents ?? policy.maxPanelProviders ?? 2,
    absoluteSafetyMax
  )
```

Recommended `absoluteSafetyMax`: 4. This is deliberately below `ROADMAP_LIMIT`; the planner may produce 8 items, but the executor should run them in small waves to protect rate-limit headroom and avoid workspace merge chaos.

Provider assignment:

- Choose distinct authenticated providers for each concurrent agent when possible.
- Apply `availableAfterCooldown(authenticatedProviders, cooldownUntil, nowMs)` before assignment.
- If every provider is cooling down, fall back to the full authenticated list exactly like `availableAfterCooldown`; do not strand the goal.
- Run each agent through the same route/capability path as ordinary turns. For a fixed provider assignment, restrict that agent's route pool to the assigned provider, mirroring how `runPanel` routes each candidate against `[candidate]`.
- Pass task-specific capability signals: implementation/debug/review/architecture/large-context as appropriate for the subtask label and prompt. Reuse the 3.21-3.23 capability registry; do not create a second router.

Agent task prompt:

- Render the shared `WorkContract`.
- Identify the specific subtask id, dependencies already completed, and allowed scope.
- Instruct the provider to complete only that subtask.
- Use the existing goal marker discipline for subtask completion:
  - `GOAL_COMPLETE` means this subtask is complete and verified.
  - `GOAL_CONTINUE: ...` means this subtask needs another bounded attempt.
- Explicitly forbid claiming the whole user goal is complete from inside an agent.

Concurrency mechanics:

- Use the `runPanel` pattern: announce all agents, start all provider runs, await with `Promise.allSettled`, record each result, then aggregate.
- One agent failure does not cancel siblings unless the user aborts.
- User abort cancels all in-flight agent `AbortController`s.
- Each provider run still emits and records its own `tier-start`, provider events, `tier-done`, `final`, usage, and ledger entry through the existing path.

Retries:

- Each item gets at most one retry by default.
- Retries run in a later wave, not immediately inside the same wave, unless the failure is a transient timeout and no file writes occurred.
- Rate-limit errors update cooldown via the existing menu-layer `noteRateLimit` pattern and future agent events must preserve provider attribution.
- Parse failure of a marker is a failed item, not completion.

Subscription-cost discipline:

- There is no dollar budget fiction. The hard budgets are iterations/waves, max agents, max attempts per item, provider timeout, cooldown, and manager admission.
- Use OAuth provider CLIs only.
- Never launch more concurrent agents than authenticated/cooldown-available providers unless the user explicitly enables same-provider fanout in a later advanced mode.
- Default off or guarded behind a new experimental config, same posture as `panel` and `hedge`.

Real-run verification:

- Unit: effective cap respects authenticated provider count, cooldown-filtered count, config max, and absolute max.
- Unit: with one authenticated provider, the executor runs sequentially and reports one running agent.
- Integration: fake providers with staggered delays prove sibling failure does not cancel successful siblings.
- Live: with two signed-in providers, a read-only two-item wave produces two ledger entries and `agents: 2` only while both are running.

### Aggregation and loop advancement

After a wave settles, the coordinator folds results into the goal state.

For each item:

- success + `GOAL_COMPLETE` -> mark item `done`;
- success + `GOAL_CONTINUE` -> keep item `pending` or `blocked` depending on the reason, append a checkpoint with the next step;
- timeout -> retry later if retry budget remains, otherwise `blocked`;
- provider/rate-limit failure -> retry on another provider if available, otherwise `blocked`;
- missing marker -> failed/blocked honestly; do not infer progress from prose;
- ask_user final -> pause the entire goal loop and surface the structured selector, matching current `/goal` behavior.

Aggregation rules:

- Completed independent items are merged into `WorkContract.roadmap` as `done`.
- Active wave items are `active` while running.
- Failed items become `blocked` with evidence.
- `checkpoints` remain bounded and should include agent id / roadmap id in the summary.
- A wave summary is persisted as `workTrace` on the accepted assistant entry so AP2-B work-state can derive truthful state later.
- The outer goal is complete only when all items are `done` and a final verifier turn returns `GOAL_COMPLETE`, or when a single serialized fallback turn returns `GOAL_COMPLETE` under the existing semantics.

Why require a final verifier:

- Parallel agents can complete local pieces but miss integration defects.
- A final sequential verifier through `orchestrate` preserves today's `decideGoalNext` honesty and prevents "all branches finished" from being treated as "the whole goal is verified."
- The verifier can be a normal goal turn using `buildGoalTask` with the updated `WorkContract`, so it reuses existing `parseGoalSignal` / `decideGoalNext`.

Wave loop:

1. Build or refresh `ParallelGoalPlan`.
2. Pick ready items whose dependencies are done.
3. Run up to `effectiveMaxAgents`.
4. Aggregate results and update `WorkContract`.
5. If all items done, run final verifier.
6. If verifier returns `GOAL_COMPLETE`, stop complete.
7. If verifier returns `GOAL_CONTINUE`, append checkpoint and either plan the next wave or fall back to sequential turns.
8. Stop on `GoalCeilings`, user abort, missing goal signal, repeated blocked state, or no runnable item.

Real-run verification:

- Unit: aggregation never marks an item done without `success === true` and parsed `GOAL_COMPLETE`.
- Unit: an all-items-done plan still requires final verifier completion.
- Integration: A/B finish, C depends on both; C does not start until A and B are marked done.
- Live: ledger token delta after each wave equals the displayed cumulative token count.

### Isolation strategy for file writes

Parallel file-writing agents are the main systems risk. The default path should make parallelism real without corrupting the workspace.

Stage 1 isolation: read-only / analysis-only parallel waves

- Run parallel decomposition, research, codebase inspection, test planning, and review subtasks in read-only sandbox.
- Let write tasks serialize through the existing `/goal` loop.
- This immediately gives honest agents/tokens visibility and validates orchestration without merge risk.

Stage 2 isolation: scoped writes

- Allow parallel writes only when the planner declares non-overlapping `writeScope` paths and the executor validates no overlap.
- Add a per-path lock in the coordinator; tasks with overlapping paths are placed in different waves.
- If an agent writes outside its declared scope, mark the item failed and require serial repair.

Stage 3 isolation: per-agent git worktree

- For full parallel implementation agents, create one temporary git worktree per agent from the same base commit.
- Each agent runs in its own worktree `cwd`, through the same provider adapter sandbox and permission model.
- After the wave, compute diffs and merge back serially into the main workspace in deterministic roadmap order.
- If a patch conflicts, mark that item blocked and leave siblings' successful patches intact.
- If the repository is absent, not git, or dirty in conflicting paths, fall back to scoped writes or serial execution.

Recommended default:

- Use read-only parallelism first.
- Use worktrees for broad write tasks once real-run tests prove patch collection and merge behavior.
- Never run unisolated concurrent writes to the same working tree.

Real-run verification:

- Unit: write-scope overlap checker serializes conflicting paths.
- Integration: two fake agents in separate temp git worktrees edit separate files; merge succeeds and final verifier runs.
- Integration: two agents edit the same file; merge conflict blocks one item and does not discard the other.
- Live: a dirty workspace with overlapping write scopes falls back to sequential and says why in the panel.

## 3. Live Visibility Panel

The user's explicit ask is a live, truthful panel: objective, current wave/step, running agents, per-agent status, cumulative tokens, elapsed.

Extend `formatGoalProgress`, do not invent a separate display contract. It already has the right honesty posture and token formatting. The future shape should add optional fields such as:

```ts
interface GoalAgentProgress {
  id: string;
  label: string;
  provider?: ProviderId;
  model?: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'retrying';
  tokens?: number;
}
```

and:

```ts
formatGoalProgress({
  turn,
  maxTurns,
  elapsedMs,
  tokensThisRun,
  contract,
  wave: { index, total },
  runningAgents,
  agents,
})
```

Display requirements:

- Objective: from `WorkContract.objective`, capped like today.
- Current wave/step: `wave 1/3` and current active roadmap labels.
- Running agents: real count of agent runs currently in flight.
- Per-agent short label/status: `A1 codex running: audit auth`, `A2 claude done: update docs`, etc.
- Tokens: cumulative real ledger delta from `readLedger` + `summarizeSpend`, same baseline method as today's `runGoalLoop`.
- Elapsed: wall-clock from injected `Clock`.
- Failures: show blocked/failed item labels without claiming the whole goal failed until aggregation decides.
- Completion: only show complete when `decideGoalNext` returns `complete` after the final verifier.

Example panel line:

```text
goal: ship auth cleanup · steps 2/6 done · wave 2/4 · current: tests + docs · agents 2 running · 84.3k tokens · 9m 12s
  A3 codex/gpt-5.5 running: add focused tests
  A4 claude/sonnet running: update auth docs
```

Honesty rules:

- `agents 2 running` means two provider runs are currently executing.
- Queued items do not count as agents.
- Finished items do not count as running agents.
- A panel inside one agent, if ever allowed, is not counted as multiple goal agents unless each panel candidate is surfaced as a distinct concurrent subtask run. The first implementation should not nest panels inside parallel goal agents.
- If provider usage is missing, record/display zero for that provider entry as existing `runPanel` does; do not estimate.

Real-run verification:

- Unit: `formatGoalProgress` omits agent count when `runningAgents` is absent or zero.
- Unit: `formatGoalProgress` shows `agents N running` only from the explicit real count.
- Integration: fake ledger entries during a wave update the displayed cumulative token delta.
- Live: start two slow fake or real read-only agents; the panel shows `agents 2 running`, then `agents 1 running`, then no running count as they finish.

## 4. Staged Build Plan

### Stage 1: Pure DAG planner + honest read-only parallel wave

This is the highest-leverage first stage.

Why first:

- It proves the core product promise: decomposition, real concurrent agents, real token panel.
- It reuses the `ensemble.ts` concurrency pattern without touching file-write isolation yet.
- It is easy to test with fake providers and safe to run live.
- It establishes the vocabulary and event stream the rest of the system will depend on.

Scope:

- Add a pure planner/validator for `WorkContract.roadmap -> ParallelGoalPlan`.
- Add a coordinator that can run read-only independent items concurrently.
- Cap agents by authenticated providers, cooldown, config max, and absolute max.
- Extend `formatGoalProgress` to show wave and real running-agent details.
- Persist aggregated `workTrace`.
- Fall back to sequential `/goal` when the planner cannot prove independence.

Real-run test:

1. Sign into at least two providers.
2. Run a read-only goal with obviously independent subtasks, for example: inspect two unrelated modules and summarize risks.
3. Confirm the panel shows `agents 2 running` only while both provider runs are live.
4. Confirm `.myshell-tools/ledger.jsonl` gained one entry per provider run and the panel token count equals the ledger delta.
5. Confirm no files changed.

Automated verification:

- `npm test -- test/unit/parallel-goal-planner.test.ts` style pure tests for DAG validation.
- Fake-provider integration where two delayed read-only agents run concurrently and one later verifier turn completes.

### Stage 2: Failure handling, retries, and blocked-state semantics

Scope:

- Add one retry per failed/timeout/rate-limited item.
- Preserve sibling successes when one item fails.
- Add blocked-state aggregation into `WorkContract.roadmap`.
- Stop honestly when no runnable items remain.
- Surface ask_user pauses exactly like today's `/goal`.

Real-run test:

- Use fake providers where one agent times out, one succeeds, and one returns missing marker.
- Confirm successful items remain done, failed/missing items are blocked or retried within budget, and the goal does not claim completion.

### Stage 3: Capability-aware subtask routing

Scope:

- Derive per-subtask task kind and estimated context.
- Reuse `CapabilityRouteContext`, `modelOutcomeOrderByTaskKind`, `availableModels`, authenticated providers, and learned provider order.
- Do not introduce a second routing stack.
- Keep `authorizeTier` authoritative for manager use.

Real-run test:

- A mixed goal with review + implementation + large-context subtasks should route each agent through the existing capability-aware `route()` path.
- Ledger entries should carry the actual provider/model/tier/taskKind used.

### Stage 4: Scoped writes with serialization fallback

Scope:

- Permit parallel writes only when `writeScope` is declared and non-overlapping.
- Add local validation of modified files after each agent.
- Serialize conflicting write scopes.
- Block out-of-scope modifications.

Real-run test:

- Two agents edit two distinct temp files; both changes survive.
- Two agents request the same file; they run in separate waves or fall back to sequential.

### Stage 5: Per-agent git worktrees for broad implementation goals

Scope:

- Create temp worktree per writing agent.
- Run provider CLI in that worktree.
- Collect diffs and merge serially into the main workspace.
- Preserve user dirty changes; never reset or discard unowned work.
- Conflict -> block the item, continue with non-conflicting siblings.

Real-run test:

- Temp git repo, two worktrees, independent edits merge cleanly.
- Deliberate conflict produces a blocked item and leaves the main worktree coherent.

### Stage 6: Product polish and config

Scope:

- Add experimental config toggle, likely `parallelGoals`.
- Add max agents setting, default 2, absolute max 4.
- Add first-touch explainer analogous to existing `FirstTouchKey` patterns.
- Decide how `/goal` chooses between sequential and parallel: default to planner-driven auto, with fallback to existing sequential loop.

Real-run test:

- Toggle off -> byte-identical sequential `/goal`.
- Toggle on with one provider -> sequential behavior plus honest "1 agent" or no parallel panel.
- Toggle on with two providers -> read-only parallel wave when planner proves independence.

## 5. Risks and What Not to Build

### Risks

Over-parallelization:

- The planner may be tempted to split work that is actually dependent.
- Mitigation: unknown dependency means serial. Cap items and agents. Require final verifier.

Workspace corruption:

- Concurrent writes in one working tree can clobber files.
- Mitigation: start read-only; then scoped writes; then worktrees. Never unisolated broad writes.

Quota and cooldown pressure:

- Parallel runs spend rate-limit headroom faster.
- Mitigation: cap by authenticated providers after cooldown, default max 2, absolute max 4, no same-provider fanout initially.

False progress:

- A subtask can produce convincing prose without doing work.
- Mitigation: require `GOAL_COMPLETE`, captured evidence, ledger-backed run records, and final verifier. Missing markers stop or block.

Auth/tier bypass:

- Direct provider spawning could accidentally skip `authorizeTier`, route policy, sandbox, or provider adapter constraints.
- Mitigation: every agent run goes through the existing `orchestrate`/route/provider path or a shared executor factored from `ensemble.ts` that preserves the same gates.

Nested concurrency:

- Running a panel inside every parallel goal agent could multiply provider calls unexpectedly.
- Mitigation: disable panel/hedge inside parallel goal agents for the first version, or count and cap nested candidates explicitly before enabling.

State drift:

- Agents can solve local subtasks but diverge from the objective.
- Mitigation: every prompt renders `WorkContract`; aggregation persists `workTrace`; final verifier checks the whole objective.

### What not to build

- Do not build API-key or metered backends.
- Do not add embeddings, vector DBs, or external planning services.
- Do not bypass `authorizeTier`, `route()`, capability routing, provider auth detection, sandbox, or cooldown.
- Do not display planned agents as running agents.
- Do not show token estimates as real tokens.
- Do not parallelize when there is only one authenticated provider unless same-provider fanout is explicitly designed and capped later.
- Do not run unisolated concurrent writes in the same workspace.
- Do not make domain-specific decomposers. The planner must work for arbitrary goals.
- Do not replace `/goal`; preserve the sequential loop as fallback and control.
- Do not treat all roadmap items done as goal completion without a final verifier.

## Executive Summary

1. Today `/goal` is autonomous but sequential: one `buildGoalTask` -> `orchestrate` -> `parseGoalSignal` -> `decideGoalNext` loop.
2. The UI cannot honestly show multiple agents today because no concurrent goal subtasks exist.
3. `ensemble.ts` already proves the right concurrency pattern: gated authenticated providers, capped fanout, `Promise.all`, real ledger usage.
4. Parallel goals should decompose `WorkContract.roadmap` into a capped dependency DAG and run ready items in waves.
5. An agent is exactly one concurrent subtask provider run in flight, not a plan, estimate, or model marketing label.
6. Effective agent count is capped by ready subtasks, authenticated providers after cooldown, config max, and an absolute safety max.
7. Every subtask still runs through existing routing, capability selection, OAuth provider CLIs, sandbox, ledger, and `authorizeTier`.
8. Aggregation marks items done only on successful runs with parsed `GOAL_COMPLETE`; missing markers never imply progress.
9. The whole goal completes only after all items are done and a final verifier returns `GOAL_COMPLETE`.
10. The live panel extends `formatGoalProgress` with wave, real running-agent count, per-agent status, elapsed, and ledger-token delta.
11. File-writing parallelism starts read-only, then scoped writes, then per-agent git worktrees once merge behavior is proven.
12. The highest-leverage first stage is a pure DAG planner plus read-only parallel wave with a real-run test showing two live agents and matching ledger tokens.
