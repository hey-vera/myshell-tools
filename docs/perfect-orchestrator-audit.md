# Perfect Orchestrator Audit

Date: 2026-07-04

Scope: `CLAUDE.md`, `docs/orchestration-speed-audit.md`, `docs/agent-orchestration-audit.md`, `docs/model-routing.md`, `docs/model-capability-research.md`, and current public model-routing / multi-agent / workflow-orchestration evidence.

## Verdict

The current approach is halfway right and still too soft.

The right architecture is **not** "a Sonnet brain vibes over workers." The perfect orchestrator is a **code-driven workflow supervisor with a Sonnet-class policy brain**. Sonnet owns intent, risk classification, dispatch-contract quality, adversarial review, and human-facing synthesis. Code owns state, liveness, routing math, deadlines, worktree lifecycle, queues, and gates.

That is the single best design because the user's objective is lexicographic:

1. Perfect first result.
2. Lowest total quota including rework.
3. Speed.

Pure LLM judgment violates that objective. It forgets prices, overuses favorite models, underestimates rework, and polls because chat agents hate silence. Pure code also fails because feature-slice ambiguity and blast-radius judgment are semantic. The winning split is: **LLM classifies the work; deterministic code selects and supervises the cheapest candidate whose measured first-pass probability clears the bar.**

## Prior Docs: What Is Wrong

`docs/orchestration-speed-audit.md` is right about parallel DAG roots and wrong by omission: it treats model choice as a side issue. That misses the user's biggest quota sink. A fast DAG filled with oversized models is waste; a cheap DAG filled with underpowered models is retry debt.

`docs/agent-orchestration-audit.md` is right that nested detachment broke observability. Its older watchdog cadence was wrong; `CLAUDE.md` has since moved to event-driven monitoring. Keep the event-driven rule. Delete any instinct to "check in" from Sonnet turns.

`docs/model-routing.md` is useful but still class-based, not task-calibrated. "opencode-go first" is not enough. `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2`, `kimi-k2.7-code`, `qwen3.7-max`, `gpt-5.4-mini`, `gpt-5.4`, Sonnet Agent, and Opus are not interchangeable workers. The router must pick **model plus effort** from a task vector.

`docs/model-capability-research.md` contains a live contradiction: its executive read says `opencode-go` is unfunded, while `CLAUDE.md` and `docs/model-routing.md` say `opencode-go` was smoke-confirmed funded on 2026-07-04. That proves the rule: prose docs are not authority for availability. **Live provider probes and a timestamped registry are authority; stale prose is evidence only.**

The `10/10` vision docs over-romanticize "model is the logic." That is the wrong abstraction for orchestration. Strong models should think; code should remember, meter, rank, supervise, and enforce.

## Objective Function

The orchestrator optimizes this exact function:

```text
For each task T, choose candidate C = (provider, model, effort, substrate, mode)

Hard reject C if:
  unavailable, unfunded, missing required tools/context/modality,
  cannot write in the required substrate,
  cannot fit required context/output,
  or violates a governance/safety rule.

Among remaining candidates:
  accept only candidates whose P(first_time_right | T, C) >= required_quality(T)

Pick the accepted candidate with minimum expected total quota:
  EQuota(C) =
    launch_overhead(C)
    + expected_prompt_tokens(T,C)
    + expected_output_tokens(T,C)
    + P(fail | T,C) * expected_rework_quota(T,C)
    + P(hang | T,C) * expected_salvage_quota(T,C)

Tie-break:
  lower wall-clock latency,
  lower merge-conflict risk,
  better quota-bucket balance,
  deterministic stable hash.
```

Required quality thresholds:

| Task class | Required first-time-right probability |
| --- | ---: |
| Mechanical edit / extraction | 0.92 |
| Narrow implementation with strong tests | 0.96 |
| Multi-file bounded implementation | 0.975 |
| Shared API/schema/default behavior | 0.985 |
| Release/security/privacy/destructive behavior | 0.995 plus strong independent reviewer |

No candidate gets picked because it is "cheap." It gets picked because it is the cheapest candidate that clears the quality threshold after expected rework is priced in.

## A. Intelligent Model Selection

### The Design

Build a deterministic router around a live model registry. Sonnet fills a `TaskCard`; code scores candidates; Sonnet can only override by writing a receipt that names the missing fact in the registry.

The `TaskCard`:

```ts
type TaskCard = {
  id: string;
  objective: string;
  class:
    | 'mechanical'
    | 'narrow-implementation'
    | 'multi-file-implementation'
    | 'planner-audit'
    | 'integration-gate'
    | 'release-security-default';
  axes: {
    ambiguity: 0|1|2|3|4|5;
    implementationDepth: 0|1|2|3|4|5;
    coupling: 0|1|2|3|4|5;
    blastRadius: 0|1|2|3|4|5;
    testOracleStrength: 0|1|2|3|4|5; // 5 = deterministic strong tests
    repoContextTokens: number;
    outputBudgetTokens: number;
    uiJudgment: 0|1|2|3|4|5;
    securityOrDefaultRisk: 0|1|2|3|4|5;
    mergeConflictRisk: 0|1|2|3|4|5;
    novelty: 0|1|2|3|4|5;
  };
  hardRequirements: {
    writeAccess: boolean;
    shell: boolean;
    browser: boolean;
    webSearch: boolean;
    vision: boolean;
    longContext: boolean;
    maxWallClockMinutes: number;
  };
  allowedFiles: string[];
  forbiddenFiles: string[];
  verification: string[];
};
```

The `ModelRegistry`:

```ts
type ModelCandidate = {
  provider: 'opencode-go' | 'codex' | 'claude-agent' | 'claude-opus';
  model: string;
  effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  substrate: 'opencode-run' | 'codex-exec' | 'claude-agent';
  availability: 'confirmed' | 'unknown' | 'failed';
  lastSmokeAt: string;
  contextTokens: number;
  maxOutputTokens: number;
  supports: { shell: boolean; browser: boolean; vision: boolean; webSearch: boolean };
  quotaBucket: string;
  pricePerMTok: { input: number; output: number } | null;
  latencyClass: 1|2|3|4|5; // 1 fastest
  reliabilityPriors: Record<TaskCard['class'], number>;
  hangRate: number;
  retryableFailureRate: number;
  firstPassHistory: {
    attempts: number;
    passRate: number;
    medianRepairQuota: number;
  };
  sourceRefs: string[];
};
```

The scoring procedure:

1. Probe live availability for any candidate that is stale or mission-critical.
2. Drop candidates that fail hard requirements.
3. Estimate first-pass quality:

```text
P = registry_prior(task.class, candidate)
    + effort_bonus
    + test_oracle_bonus
    + substrate_fit_bonus
    - ambiguity_penalty
    - coupling_penalty
    - blast_radius_penalty
    - novelty_penalty
    - stale_registry_penalty
    - recent_failure_penalty
```

4. Convert historical outcomes into priors by task class. Until there are 20+ local samples, seed with conservative curated priors from public evidence and manual receipts.
5. Choose the smallest accepted candidate by expected total quota. "Smallest" means quota-adjusted expected cost, not model name.
6. If no candidate clears the threshold, escalate planning or split the task until one does. Never send a low-probability monolith to a cheap worker.

### Committed Routing Table

| Task | First route | Escalate when |
| --- | --- | --- |
| Pure mechanical edits, formatting, receipt summarization | `opencode-go/deepseek-v4-flash` low/no extra effort; fallback `gpt-5.4-mini` low | Fails verification once, touches unexpected files, or needs semantic judgment |
| Large read-only scan / extraction | `deepseek-v4-flash`, `mimo-v2.5`, `minimax-m3`, or `qwen3.7-plus` by live cost/context | Needs architecture judgment or conflicting evidence |
| Narrow implementation with strong tests | `deepseek-v4-flash` if coupling <=2 and tests strong; otherwise `deepseek-v4-pro` or `kimi-k2.7-code` | One failed attempt, weak tests, or cross-module contract |
| Coding-heavy bounded implementation | `kimi-k2.7-code`, `deepseek-v4-pro`, or `glm-5.2` based on live registry and prior pass rate | Shared defaults/schema/release behavior, or broad UI state |
| Long-context agentic refactor | `glm-5.2`, `qwen3.7-max`, `mimo-v2.5-pro`, or `gpt-5.4` high | If expected rework exceeds stronger-model delta, choose `gpt-5.4` first |
| UI/test-loop implementation where harness integration matters | Claude Sonnet Agent high | If quota pressure is Anthropic-heavy, use `gpt-5.4` high |
| Architecture/audit/root-cause/policy | `gpt-5.5` high as a planner/auditor, not worker | Opus only on named safety/default/release/conflict triggers |
| Security/privacy/destructive/default/release risk | Strong implementer plus independent `gpt-5.5` or Opus reviewer | Never handled by cheap open worker alone |

This kills the bad habit "use `glm-5.2` for everything." `glm-5.2` is a strong long-horizon coding worker, not a receipt summarizer, not a trivial patcher, and not the cheapest first route for bounded low-risk edits.

### Data The Router Needs

The registry must store:

- live model IDs from `opencode models --verbose`, Codex detection, and Claude model config;
- context/output limits;
- supported effort levels;
- provider/substrate capabilities: shell, browser, file write, background mode, structured output, web search, vision;
- public price or subscription quota bucket;
- local smoke status and timestamp;
- local first-pass outcomes by task class;
- verification pass/fail, rework attempts, hang/stall events, and repair quota;
- source citations and freshness date.

Public priors as of 2026-07-04:

- OpenAI positions `gpt-5.5` as strongest for complex coding, computer use, knowledge work, and research; `gpt-5.4-mini` is the faster/lower-cost choice for lighter coding and subagents. Source: https://developers.openai.com/codex/models
- OpenAI pricing shows `gpt-5.5` materially above `gpt-5.4`, and `gpt-5.4-mini` far cheaper than both. Source: https://developers.openai.com/api/docs/pricing
- Anthropic launched Sonnet 5 as a cheaper agentic model near Opus 4.8 capability at lower price; Opus 4.8 remains the expensive escalation tier. Source: https://www.anthropic.com/news/claude-sonnet-5
- DeepSeek V4 has Pro and Flash variants with 1M context; Pro is the stronger variant and Flash is the fast/economical variant. Source: https://api-docs.deepseek.com/news/news260424
- DeepSeek API docs list `deepseek-v4-pro` and `deepseek-v4-flash` as API model parameters. Source: https://api-docs.deepseek.com/updates
- Z.ai positions GLM-5.2 for long-horizon coding tasks with selectable reasoning modes. Source: https://z.ai/blog/glm-5.2
- Kimi K2.7 Code is Moonshot's coding-focused model, stronger than K2.6 for instruction compliance and long-horizon coding. Source: https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart
- Qwen3.7-Max is a flagship agent-centric model for coding/productivity/long-horizon execution with 1M context on OpenRouter's public listing; Alibaba's Qwen blog says it is available via Model Studio and coding assistants. Sources: https://openrouter.ai/qwen/qwen3.7-max and https://qwen.ai/blog?id=qwen3.7

Routing literature:

- RouteLLM formalizes quality/cost routing and reports large cost reductions while preserving most strong-model quality. Source: https://arxiv.org/abs/2406.18665 and https://www.lmsys.org/blog/2024-07-01-routellm/
- Dynamic routing/cascading literature frames the task as task-specific evaluation plus cost-constrained routing. Source: https://arxiv.org/html/2603.04445v1
- OpenAI's Agents SDK explicitly says code-driven orchestration is more deterministic and predictable for speed, cost, and performance. Source: https://openai.github.io/openai-agents-python/multi_agent/

### Router Code Sketch

```ts
export function selectCandidate(task: TaskCard, registry: ModelCandidate[]): ModelCandidate {
  const requiredP = qualityThreshold(task);
  const candidates = registry
    .filter(c => c.availability === 'confirmed')
    .filter(c => satisfiesHardRequirements(task, c))
    .map(c => {
      const pFirst = estimateFirstPass(task, c);
      const quota = expectedQuota(task, c, pFirst);
      return { c, pFirst, quota, latency: c.latencyClass };
    })
    .filter(x => x.pFirst >= requiredP)
    .sort((a, b) =>
      a.quota - b.quota ||
      a.latency - b.latency ||
      stableHash(`${task.id}:${a.c.provider}:${a.c.model}:${a.c.effort}`)
        .localeCompare(stableHash(`${task.id}:${b.c.provider}:${b.c.model}:${b.c.effort}`))
    );

  if (!candidates.length) {
    throw new NoCapableCandidateError(splitOrEscalateAdvice(task, registry));
  }
  return candidates[0]!.c;
}
```

## B. Monitoring / Heartbeat

### The Pick

Use a hybrid, but not the mushy kind:

1. **Harness completion notification is terminal-state authority.**
2. **A coded supervisor owns a task table, status files, process metadata, and one durable deadline timer.**
3. **Workers write structured status events to `docs/receipts/orchestrator/events.jsonl` or `.orchestrator/events.jsonl`.**
4. **No poller model. No Sonnet polling. No foreground-streaming worker as fake heartbeat.**

This is the most reliable and quota-efficient answer. Polling with a cheap model still burns quota and adds a new failure mode. Foreground-streaming one worker biases the orchestrator toward the loudest worker and blocks clean pipeline scheduling. Status files alone cannot prove process death. Harness notifications alone can miss rich progress. The correct design is **event-driven completion + local coded observability + one deadline timer**.

GitHub's webhook docs state the principle cleanly: webhooks deliver data as events happen instead of polling an API. Source: https://docs.github.com/en/webhooks/about-webhooks

Claude Code background tasks expose output files and unique IDs for tracking/retrieval. Source: https://code.claude.com/docs/en/interactive-mode

Claude Code Agent View is explicitly for seeing what is running, needs input, and is done. Source: https://code.claude.com/docs/en/agent-view

Temporal's durable-execution model is the right mental model: persisted state, retries, task queues, signals, and timers. Source: https://temporal.io/

### Worker Status Protocol

Each worker receives:

```text
Write one JSON line to .orchestrator/events.jsonl at:
  STARTED
  PLAN_READY
  FIRST_EDIT
  TEST_STARTED
  TEST_PASSED
  TEST_FAILED
  RECEIPT_WRITTEN
  BLOCKED

Never chat status unless blocked or complete.
Never write secrets.
Event schema:
{
  "ts": "2026-07-04T18:00:00.000Z",
  "taskId": "menu-s6-schema",
  "workerId": "opencode-go/deepseek-v4-flash",
  "state": "TEST_PASSED",
  "worktree": "../myshell-tools-s6-schema",
  "branch": "agent/menu-s6-schema",
  "summary": "Focused conversation schema tests passed",
  "receipt": "docs/receipts/menu-s6-schema.md"
}
```

The local supervisor tracks:

```ts
type WorkerRun = {
  taskId: string;
  pid?: number;
  harnessTaskId?: string;
  provider: string;
  model: string;
  worktree: string;
  branch: string;
  receipt: string;
  allowedFiles: string[];
  verification: string[];
  startedAt: string;
  deadlineAt: string;
  state: 'queued'|'running'|'notified-done'|'failed'|'hung'|'reviewing'|'merged';
  lastOutputAt?: string;
  lastStatusAt?: string;
  extendedOnce: boolean;
};
```

Deadline behavior:

- When a worker launches, set `deadlineAt = maxWallClock + grace`.
- Until a harness notification arrives, Sonnet spends zero turns checking it.
- At `deadlineAt`, code inspects process existence, output freshness, status-event freshness, CPU if available, and receipt presence.
- If active, extend once.
- If dead/stale, stop through the harness/supervisor, inspect diff, salvage, and resume from partial work.

### Supervisor Code Sketch

```ts
import { watch } from 'node:fs';

class OrchestratorSupervisor {
  private runs = new Map<string, WorkerRun>();

  launch(contract: DispatchContract, candidate: ModelCandidate) {
    const run = createRun(contract, candidate);
    this.runs.set(run.taskId, run);
    appendEvent({ taskId: run.taskId, state: 'STARTED', ts: new Date().toISOString() });
    startHarnessBackgroundTask(actualWorkerCommand(contract, candidate));
    setTimeout(() => this.deadlineCheck(run.taskId), msUntil(run.deadlineAt));
  }

  onHarnessNotification(taskId: string, status: 'completed'|'failed'|'stopped') {
    const run = mustGet(this.runs, taskId);
    run.state = status === 'completed' ? 'notified-done' : 'failed';
    enqueueReview(taskId);
  }

  deadlineCheck(taskId: string) {
    const run = mustGet(this.runs, taskId);
    if (run.state !== 'running') return;
    const live = inspectLiveness(run);
    if (live.healthy && !run.extendedOnce) {
      run.extendedOnce = true;
      run.deadlineAt = addMinutes(new Date(), contractGrace(run)).toISOString();
      setTimeout(() => this.deadlineCheck(taskId), msUntil(run.deadlineAt));
      return;
    }
    stopViaHarness(run);
    run.state = 'hung';
    enqueueSalvage(taskId);
  }
}

watch('.orchestrator/events.jsonl', () => ingestStatusEvents());
```

## C. Never Wait For Nothing

### The Design

The orchestrator is a controller with queues. It does not "wait"; it transitions state.

Queues:

- `readyToDispatch`: DAG roots whose dependencies are met.
- `needsContract`: upcoming tasks that need dispatch contracts.
- `running`: active workers.
- `needsReview`: completed worker runs.
- `needsIntegration`: branches ready to merge into integration worktree.
- `needsGate`: test/typecheck/build/CI gates.
- `blocked`: tasks needing user or escalation.

Main loop:

```text
while objective not done:
  ingest harness notifications and status events
  review any completed diff before launching lower-value new work
  merge/rebase ready branches in integration worktree
  run focused gates that unblock dependents
  dispatch ready DAG roots up to fanout cap
  prepare contracts/worktrees for next likely dependents
  refresh model registry only when stale or before expensive dispatch
  if all workers running and no local queue work:
    write next-batch contracts, risk checklist, integration plan, or final gate plan
  if truly no useful work exists:
    sleep until event/deadline, consuming zero model turns
```

The "human intuition to keep going" becomes code:

1. After dispatch, immediately prepare the next worktree and contract for the nearest dependent.
2. If a completed diff arrives, review it before starting speculative work.
3. If a predecessor is coherent but not merged, launch a dependent on a stacked branch only when its contract names the speculative base.
4. Keep one integration worktree hot.
5. Run focused tests per branch and broad tests only at merge barriers.
6. Use `gh pr merge --auto` for CI instead of CI polling.

### Worktree Protocol

Every worker uses a separate worktree. Git officially supports multiple working trees attached to one repository, letting separate branches be checked out at once. Source: https://git-scm.com/docs/git-worktree

Worktree layout:

```text
../myshell-tools-wt/<goal>/<task-id>
.orchestrator/runs/<task-id>.json
.orchestrator/events.jsonl
docs/receipts/<task-id>.md
```

Dispatch order for a multi-slice feature:

1. Build DAG from file ownership, APIs, schema/defaults, UX state, fixtures, and verification boundaries.
2. Launch all independent roots up to fanout cap.
3. Prepare contracts for dependents while roots run.
4. On completion notification, review receipt, diff, and verification.
5. Merge to integration worktree or requeue with a targeted repair contract.
6. Launch newly unblocked dependents.
7. Run final integration gate only after all branch-local gates pass.

The fanout cap is dynamic:

```text
fanout = min(
  4,
  physical_capacity_cap,
  provider_quota_cap,
  count(ready independent conflict domains)
)
```

Default fanout is 3. Raise to 4 for read-only/research/mechanical tasks. Drop to 1-2 for heavy test loops or high-conflict UI state.

## D. First-Time-Right

### Dispatch Contract

Workers fail first-pass when they receive vague contracts. The perfect contract is strict enough that a smaller model can succeed.

Required fields:

```text
Task ID:
Objective:
Non-objectives:
User-visible behavior:
Base branch/commit:
Worktree:
Allowed files:
Forbidden files:
Conflict domain:
Dependency assumptions:
Existing patterns to follow:
Reference examples:
Edge cases:
Verification commands:
Receipt path:
Max wall-clock:
Model/effort selected and why:
Stop/BLOCKED conditions:
Return schema:
```

The contract must include examples when behavior has shape:

- before/after CLI output;
- expected UI flow;
- failing test name;
- exact schema field;
- negative cases that must not change.

### Worker Self-Verification

Every worker must:

1. Restate the contract in no more than 80 words before editing.
2. Inspect only the required local context plus named dependencies.
3. Make the smallest sufficient diff.
4. Run the verification command.
5. Write a receipt with:
   - changed files;
   - exact commands;
   - test result tails;
   - known limitations;
   - whether forbidden files were untouched.
6. Return `DONE`, `NEEDS_GATE`, `BLOCKED`, or `REJECTED`.

Forbidden:

- broad refactors unless explicitly contracted;
- deleting exports outside scope;
- silently changing defaults;
- editing outside allowed files;
- "fixed probably" without command evidence;
- adding new dependencies without approval.

### Orchestrator Verification

The Sonnet brain does not trust worker self-report. It checks:

```text
git diff --stat
git diff --name-only
forbidden-file check
receipt exists
verification evidence exists
focused tests pass
integration worktree gates pass before merge/report
```

If the worker failed but produced useful work, repair from the diff. Do not restart from scratch.

## Substrate Decision: opencode-go vs Codex vs Claude Agent

The best default worker substrate is **opencode-go** when funded and smoke-confirmed, because it gives the largest cheap worker pool and includes models that are correctly sized below frontier. But it is not the best substrate for every task.

Use opencode-go for:

- file-scoped implementation;
- mechanical edits;
- long-context scans;
- cheap parallel workers;
- open-model challenge passes;
- bounded tests where the CLI path is reliable.

Use Codex for:

- heavier bounded coding when expected rework from open workers exceeds the stronger-model delta;
- tasks that need OpenAI's coding/computer-use strengths;
- fallback when opencode-go has quota/auth/transient failures;
- planner/auditor work with `gpt-5.5`.

Use Claude Agent for:

- harness-native background subagents;
- tasks likely to need Claude Code permissions/context;
- UI/test-loop work where Claude's local tool behavior is the fit;
- separate Anthropic quota when Codex/opencode is constrained.

Do not use Opus as a routine worker or orchestrator. Use Opus only for named escalation triggers.

## Exact CLAUDE.md Edits

Do not paste model tables into always-loaded memory. Add only operating rules; keep volatile model facts in `docs/model-routing.md` or a generated registry.

Patch:

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@
 ## Model Routing
 
-Model availability + funding are volatile - verify before relying (`codex exec -m <model>` runs on ChatGPT billing, independent of opencode; `opencode models </dev/null` for opencode). Class-based routing:
+Model availability, funding, and quality are volatile. Routing is task-calibrated, not provider-class-only. Before dispatch, build a `TaskCard` from complexity, ambiguity, coupling, blast radius, test-oracle strength, context size, security/default risk, and required tools. Use the live model registry plus recent receipts to choose the smallest model+effort whose estimated first-time-right probability clears the task's quality threshold. Then minimize expected total quota including rework, then latency.
@@
-- **Workers (bounded execution):** primary = funded opencode-go via `opencode run -m opencode-go/<model>` because it is the cheapest capable worker. Retry transient opencode-go failures with capped exponential backoff, then fall back to codex `gpt-5.4` (heavier bounded work), `gpt-5.4-mini` (cheap/mechanical), or Claude sonnet-class `Agent` workers only on real unavailability, quota/auth failure, repeated transient failure, or poor task fit.
+- **Workers (bounded execution):** use funded opencode-go first only when the selected opencode-go model is the cheapest candidate that clears the first-time-right threshold. Use `deepseek-v4-flash`-class models for mechanical/low-risk work, stronger opencode-go coding models (`deepseek-v4-pro`, `kimi-k2.7-code`, `glm-5.2`, `qwen3.7-max`, or current registry winner) for bounded coding, Codex `gpt-5.4-mini` for cheap fallback/mechanical work, Codex `gpt-5.4` for heavier bounded work, and Claude sonnet-class `Agent` workers when harness-native subagents, permissions, UI/test loops, or quota balancing make them the best fit.
@@
 Dated capability notes + current funding state live in `docs/model-routing.md`, not always-loaded memory.
+
+Routing override rule: if Sonnet wants a larger model than the deterministic router selected, it must name the concrete risk the registry missed. If Sonnet wants a smaller model, it must name the verification oracle that makes first-pass quality safe. Otherwise use the router result.
@@
 ## Worker Dispatch and Liveness
 
+The orchestrator must use a coded run table for background workers: task id, harness task id/PID if exposed, worktree, branch, model, start time, deadline, receipt, allowed files, verification, and state. Workers should write structured status events to `.orchestrator/events.jsonl` or the contracted receipt path, but chat status is forbidden unless blocked or complete.
+
 - **Monitor event-driven, NOT by polling.** Rely on the harness completion notification for terminal state. After launching a healthy background worker, spend **zero** turns asking for status. Schedule at most **one** fallback wakeup for hang detection, at the slice's max wall-clock **plus grace** - used only if no completion notification arrived. No 60-90s check, no 2-3 min watchdog loop, no "status?" turns to healthy workers, no repeated CI-watch loops (use `--auto`).
@@
 ## Auto Parallel Orchestration
 
 **Default to parallel dispatch for independent DAG roots - serial is the exception that must name its blocker.** Before any multi-slice build, make a dependency DAG from file sets, API/schema/state/UX dependencies, shared fixtures/defaults, and verification boundaries.
+
+Never wait for nothing: maintain explicit queues for ready dispatch, contract preparation, running workers, review, integration, gates, and blocked tasks. While workers run, prepare next contracts/worktrees, review completed diffs, merge into the integration worktree, run gates, or refresh only the stale model facts needed for the next dispatch. If all useful queues are empty, sleep until a harness event or deadline without spending a model turn.
```

## Tooling To Build

Build three small pieces, in this order:

1. `src/core/orchestrator/task-card.ts`
   - `classifyTaskCard(input): TaskCard`
   - schema validation;
   - thresholds;
   - tests for obvious classes.

2. `src/core/orchestrator/model-router.ts`
   - consumes live provider inventory plus curated registry;
   - implements hard-requirement filtering, first-pass estimate, expected quota, stable tie-break;
   - records selected candidate and rejected stronger/weaker alternatives in the receipt.

3. `src/core/orchestrator/supervisor.ts`
   - task table;
   - status JSONL ingestion;
   - harness notification ingestion;
   - one deadline timer;
   - review/integration queues;
   - no LLM polling path.

Minimal code shape:

```ts
export async function dispatchSlice(slice: SliceSpec, dag: Dag, registry: ModelRegistry) {
  const task = await classifyTaskCard(slice);
  const candidate = selectCandidate(task, registry.candidates);
  const contract = buildDispatchContract(task, candidate);
  const worktree = await ensureWorktree(contract);
  const run = await supervisor.launch(contract, candidate, worktree);
  ledger.recordDispatch({ task, candidate, contract, run });
}

export async function controllerTick() {
  await supervisor.ingestEvents();
  await reviewQueue.drainReady();
  await integrationQueue.mergeReady();
  await gateQueue.runUnblocked();
  await dispatchQueue.launchReadyWithinFanout();
  await contractQueue.prepareNext();
  await supervisor.sleepUntilNextEventOrDeadlineIfIdle();
}
```

Tests:

- `deepseek-v4-flash` wins mechanical work over `glm-5.2`.
- `glm-5.2` or equivalent strong open model wins long-context coding when cheap models fail the threshold.
- `gpt-5.4` wins when expected rework from open workers exceeds cost delta.
- security/default tasks require independent reviewer.
- unknown/unprobed models are worker-floor only and cannot win planner/security tasks.
- no background worker can be launched without receipt, deadline, allowed files, and verification command.
- no status polling model path exists.

## Final Architecture

The perfect orchestrator is:

```text
Sonnet 5 brain
  -> TaskCard semantic classifier
  -> deterministic model router
  -> dispatch contract builder
  -> coded supervisor / queues / event loop
  -> opencode-go / Codex / Claude Agent workers
  -> receipt + verification gates
  -> integration worktree
  -> final synthesis
```

Sonnet 5 is the right always-on brain because it is strong enough for semantic orchestration at materially lower cost than Opus, and Anthropic now positions Sonnet 5 for agentic work near Opus 4.8 at lower price. But Sonnet 5 is not the whole orchestrator. If model selection and monitoring remain free-form LLM behavior, the system will drift back into overkill, underkill, and poll-waiting.

The best substrate is opencode-go first for bounded workers when funded, with Codex and Claude Agents selected by task fit and expected rework, not loyalty. The best monitoring is event-driven harness notification plus coded status/deadline supervision. The best speed protocol is a queue-driven DAG controller that always has review, integration, contract prep, or gates to do. The best first-time-right discipline is a strict dispatch contract plus independent verification.

That is the design that satisfies the user's objective function without pretending cheap is efficient when it causes rework or pretending strong is quality when it is unnecessary.
