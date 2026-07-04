# Orchestration Speed Audit

Date: 2026-07-04

Scope read first: `CLAUDE.md`, `docs/menu-build-spec-final.md`, `docs/model-routing.md`.

## Brutal Diagnosis

The current orchestrator is slow because the operating rules accidentally reward passivity.

The observed behavior is not a mysterious model failure. A cheap Sonnet-class orchestrator was given a vague "Auto Parallel Orchestration" rule that starts with "Parallelize only when..." and immediately teaches the model a long list of reasons to serialize. A cautious control-plane model will read that as: serial is safe, parallel is exceptional. That is exactly what happened.

The liveness rule is worse. It says "Rely on harness completion notifications" and then orders a check at 60-90 seconds and every 2-3 minutes. That converts the orchestrator into a polling loop. If a worker takes 15-30 minutes, those watchdog turns are pure overhead unless there is evidence of a stall. The user paid Sonnet turns to ask "are we there yet?" while a healthy worker was already being supervised by the harness.

The menu plan also has real dependencies, but they were over-applied. Slices 4-11 are not one indivisible train. There is a navigation/input lane, a workspace data/model lane, a workspace execution lane, and a final release lane. The workspace data/model lane can run while the navigation/input lane runs. It did not.

The current failure mode:

- serial dispatch by habit, not by proved dependency
- active polling of healthy background workers
- no worktree-per-slice fanout
- no stacked/speculative dispatch of dependents while review/merge is happening
- no distinction between "same broad feature" and "same conflict domain"
- over-grounding small dispatch decisions after the spec already locked the work

The fix is not "use Opus as orchestrator." The fix is a stricter control-plane protocol: build a DAG, launch independent roots by default, stop polling, pipeline review/merge with next dispatch, and require a named serialization edge when the orchestrator refuses to parallelize.

## Why It Was Serial Despite The Rule

`CLAUDE.md` currently says:

> Parallelize only when slices are independent by files and conflict domain.

That wording makes parallelism a permission to be earned. The following sentence then lists serialization cases. A conservative model sees risk everywhere, especially when many slices mention `src/interface/menu.ts` and `test/unit/menu-flow.test.ts`.

What the rule should say instead:

- Default to parallel dispatch for independent DAG roots.
- Serial execution requires an explicit dependency edge.
- Same project, same milestone, or same release gate is not enough to serialize.
- Shared final verification is not enough to serialize if each worker has a local verification command and the integration lane can reconcile tests.
- If the orchestrator chooses serial, it must name the exact blocker: same implementation file ownership, API/schema dependency, UX state dependency, shared fixture/default mutation, or non-decomposable verification.

That moves the burden of proof to serialization.

## Slice Dependency Analysis: Remaining Slices 4-11

Source: `docs/menu-build-spec-final.md`, "Ordered Implementation Slices".

### Slice Domains

| Slice | Domain | Main files | Parallel safety |
| --- | --- | --- | --- |
| 4 - ESC Exit + Left Back Stack | Navigation/input semantics | `src/interface/menu.ts`, key/readline/UI input files, submenu modules, menu flow/UI tests | Root slice. High conflict with 5, 8, 9, 10 because they all touch menu dispatch/input tests. |
| 5 - `!` Shell Passthrough | Conversation input command routing | `src/interface/menu.ts`, new shell helper, `src/core/command-gate.ts`, menu-flow tests | Can run after 4. Do not run concurrently with 4 or 9 at full-slice granularity because of `menu.ts` and input semantics. |
| 6 - Workspace Schema | Conversation metadata persistence | `src/infra/conversation-store.ts`, `src/infra/conversations.ts`, conversation tests | Independent root. Run immediately in parallel with 4. |
| 7 - Workspace Resolver + Candidate Model | Workspace resolving/ranking | new workspace module, `src/infra/repo-scan.ts`, completion/ranking tests | Independent root if contract is fixed to `workspaceRoot?: string | null`. Can run with 4 and 6 if forbidden from editing store create/mutation behavior. |
| 8 - New Conversation Flow + Picker | Workspace selection UI | `src/interface/menu.ts`, new new-conversation/picker modules, menu-flow/picker tests | Depends on 4, 6, 7, and should follow 9 for honest workspace execution. Conflicts with 10 in `menu.ts`/menu-flow. |
| 9 - CWD Threading Through Chat Execution | Execution correctness | `src/interface/menu.ts`, preflight deps, core types if needed, ledger/audit/evidence/verify call sites, broad tests | Depends on 6. Should run after 5 at full-slice granularity because both touch `menu.ts` and chat input/execution flow. |
| 10 - Workspace-Aware Recent List | Home recent list rendering/open order | `menu-render.ts`, `menu-display.ts`, `menu.ts`, render/menu-flow tests | Depends on 6, 7, 9. Do not run concurrently with 8 unless manually sub-sliced because both touch main menu state/dispatch. |
| 11 - Final Release Gate, Docs, PTY | Final docs/smokes/gates | README, changelog, PTY scripts, integration/render/UI tests | Terminal slice. Depends on all. |

### Concrete DAG

```text
4 -> 5 -> 9 -> 8 -> 10 -> 11
6 --------^    ^    ^     ^
7 -------------^    ^-----^
```

More explicitly:

- `4 -> 5`: both own input semantics in `menu.ts` and menu-flow tests.
- `4 -> 8`: picker/back behavior needs the new stack semantics.
- `5 -> 9`: full slices collide in conversation input/execution areas; after 5 lands, 9 can thread active cwd through shell passthrough cleanly.
- `6 -> 9`: `runChatLoop` needs `ConversationMeta.workspaceRoot`.
- `6 -> 8`: new conversation creation must stamp `workspaceRoot`.
- `6 -> 10`: Recent list needs workspace metadata.
- `7 -> 8`: picker uses resolver/candidate model.
- `7 -> 10`: label/order logic uses workspace label/candidate helpers.
- `9 -> 8`: spec says workspace picker stays hidden until execution cwd is honest.
- `9 -> 10`: workspace-labelled Recent must not ship before actual execution uses workspace cwd.
- `8 -> 10`: both touch main menu dispatch/state at full-slice granularity. This can be sub-sliced later, but not safely parallel as whole slices.
- `10 -> 11`: final docs/PTY/gates need final UI.

### Parallel Batches By Full Slice

This is the safe full-slice schedule for remaining work:

```text
Batch 1, launch immediately in separate worktrees:
  - Slice 4: navigation/back/ESC
  - Slice 6: workspace schema
  - Slice 7: workspace resolver/candidate model

Batch 2, launch as soon as Slice 4 is reviewed enough to stack on:
  - Slice 5: ! shell passthrough

Batch 3, launch as soon as Slice 5 and Slice 6 are available; Slice 7 should be merged or stable:
  - Slice 9: cwd threading

Batch 4:
  - Slice 8: new conversation flow + picker

Batch 5:
  - Slice 10: workspace-aware Recent list

Batch 6:
  - Slice 11: final release gate/docs/PTY
```

This is not perfect parallelism because the menu/input lane is genuinely shared. But it still removes the worst waste: Slice 6 and Slice 7 should have been running while Slice 4 was underway. If each slice is 15-30 minutes, Batch 1 alone saves roughly 30-60 minutes of wall-clock versus naive serial.

### Aggressive Variant: Sub-Slice For More Parallelism

If the user wants maximum throughput and accepts a slightly more complex merge train, split the big full slices:

- `5a`: shell-passthrough helper + command-gate tests, no `menu.ts` integration. Can run in Batch 1 with 4/6/7.
- `9a`: non-menu cwd plumbing in infra/evidence/audit/verify call sites behind injected `activeCwd`. Can run after 6 while 5 is active.
- `8a`: picker module and pure picker tests. Can run after 7 while 9 is active.
- `10a`: pure render ordering helpers/tests. Can run after 6/7 while 8 is active.

Then leave only the `menu.ts` wiring and menu-flow tests as a short serial integration lane. This is the fastest route, but it requires better dispatch contracts than the current harness has been using.

## Event-Driven Monitoring Model: Kill The Polling

The harness already auto-notifies when a background task completes. Therefore a healthy worker needs zero active polling.

New model:

1. Launch the real worker process as a harness background task. Record task id, branch/worktree, slice, allowed files, forbidden files, verification command, receipt path, start time, and max wall-clock.
2. After launch, do not spend Sonnet turns checking it.
3. Wait for the harness completion notification.
4. Schedule at most one fallback wakeup for hang detection, at the slice's max wall-clock plus grace, not at 60-90 seconds.
5. On completion notification, inspect receipt, diff, and verification. Then review/merge or retry.
6. On the single fallback wakeup only, inspect output freshness and process activity. If there is fresh output or active CPU, extend once by an explicit budget. If no output for the stall window and near-flat CPU, mark `HUNG`, stop through the harness, salvage diff/receipt, and resume-from-diff.

State machine:

```text
DISPATCHED
  -> RUNNING_UNOBSERVED
  -> NOTIFIED_DONE -> REVIEW -> MERGE/RETRY
  -> NOTIFIED_FAILED -> SALVAGE -> RETRY/FALLBACK
  -> FALLBACK_WAKEUP_DUE -> HUNG_CHECK
       -> STILL_HEALTHY_EXTENDED_ONCE
       -> HUNG_STOPPED_SALVAGED
```

Forbidden:

- no "watchdog check" every 2-3 minutes
- no "status?" messages to healthy workers
- no polling just because the orchestrator is idle
- no repeated CI watch loops; use GitHub-native auto-merge where applicable

Use event-driven notifications the way GitHub and Argo CD use webhooks: a completion event should wake the controller; polling is a fallback for missing events, not the primary loop. GitHub documents subscribing only to needed webhook events to limit requests, and Argo CD documents webhooks specifically to eliminate polling delay. See Sources.

## Pipelined Execution Protocol

### Worktree Layout

Use one git worktree per active worker:

```text
../myshell-tools-slice4-nav
../myshell-tools-slice6-schema
../myshell-tools-slice7-workspace
../myshell-tools-slice5-shell
../myshell-tools-slice9-cwd
../myshell-tools-slice8-picker
../myshell-tools-slice10-recent
```

Branch naming:

```text
agent/menu-s4-nav
agent/menu-s6-schema
agent/menu-s7-workspace
agent/menu-s5-shell
agent/menu-s9-cwd
agent/menu-s8-picker
agent/menu-s10-recent
agent/menu-s11-final
```

Git worktrees are the right primitive because Git officially supports multiple working trees attached to the same repository, with separate `HEAD` and index state. That gives workers isolated editable trees without copying the repository.

### Dispatch Contract

Every worker gets:

- objective
- base branch/commit
- worktree path
- allowed files/modules
- forbidden files/modules
- conflict domain
- dependency assumptions
- verification command
- receipt path
- max wall-clock
- required final receipt format

Example for Slice 6:

```text
Objective: implement Slice 6 workspace schema.
Allowed: src/infra/conversation-store.ts, src/infra/conversations.ts, test/unit/conversations.test.ts.
Forbidden: src/interface/menu.ts, render/display files, workspace picker UI.
Conflict domain: conversation metadata persistence only.
Verification: npm test -- test/unit/conversations.test.ts
Receipt: docs/receipts/menu-s6-schema.md
Max wall-clock: 30m.
```

### Pipeline Rules

1. Build the DAG before dispatch.
2. Launch all independent roots immediately, capped by provider quota and local machine capacity. For this project, start with concurrency 3: S4, S6, S7.
3. When a predecessor finishes, launch its dependent on a stacked branch before final review if the diff is coherent and tests are plausibly green. Mark it speculative.
4. Review/merge completed branches while downstream workers run.
5. Keep one integration worktree that only merges worker branches and runs combined gates.
6. If a predecessor changes during review, rebase the stacked dependent once. If rebase is ugly, stop and salvage; do not keep speculative chains alive at any cost.
7. Use cheap/mechanical models for docs/tests/final copy updates. Reserve stronger workers for Slice 9 and high-blast-radius menu wiring.
8. Run local focused tests per worker; run broader integration gates only at merge barriers and final release.

### Practical Timeline

Naive serial at 15-30 minutes per slice for eight remaining slices is roughly 2-4 hours before review overhead.

Full-slice DAG with polling removed:

```text
T0:     launch S4, S6, S7
T+20m:  S6/S7 likely complete; review/merge data lane
T+30m:  S4 complete; launch S5 stacked on S4 while reviewing S4
T+45m:  S5 complete; launch S9 stacked on S4+S5+S6(+S7)
T+75m:  S9 complete; launch S8
T+95m:  S8 complete; launch S10
T+115m: S10 complete; launch S11 final gate/docs/PTY
```

The exact numbers will vary, but the shape matters: the orchestrator should spend its time dispatching, reviewing, and merging, not waiting awake.

## Modern Practice To Adopt

- Use orchestrator-worker parallelism where the work decomposes. Anthropic's production research system uses a lead agent that spawns subagents to explore different aspects simultaneously; they explicitly found sequential search painfully slow and added parallel subagents plus parallel tool calls for speed. They also warn that multi-agent systems burn tokens and are a bad fit when dependencies are tight. That maps exactly to this menu build: parallelize independent lanes, do not pretend every `menu.ts` slice is independent.
- Use code-driven orchestration for deterministic build pipelines. OpenAI's Agents SDK docs distinguish LLM-driven orchestration from code-driven orchestration and note that code orchestration is more predictable for speed, cost, and performance; they include running multiple independent agents in parallel via primitives like `asyncio.gather`.
- Use structured observability, not chat polling. OpenAI's Agents SDK tracing records workflow runs, model calls, tool calls, handoffs, guardrails, and custom spans. For this repo, the equivalent is worker task id, branch, receipt, verification command, and traceable state transitions.
- Use events over polling. GitHub webhooks deliver event payloads for subscribed events; Argo CD documents webhooks as the way to eliminate a three-minute polling delay. The Claude harness completion notification should be treated the same way.
- Use durable workflow thinking for long-running agents. Temporal's durable execution model persists workflow state, supports timers/signals, and resumes after failure. The harness does not need Temporal, but it should copy the pattern: durable task table, one fallback timer, event-driven state transitions, and resume-from-diff after failure.
- Use worktree isolation. Git worktrees are designed to support multiple working trees attached to one repository and separate branch/index state. This is the simplest local isolation layer for concurrent code agents.

## Exact CLAUDE.md Edits

Apply this patch to make parallel-when-safe the default and remove polling overhead.

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@
 ## Auto Parallel Orchestration
 
-Parallelize only when slices are independent by files and conflict domain. For concurrent workers or any code/test/config edit, each worker needs: objective, allowed files/modules, forbidden files/modules, verification command, and conflict domain. Serialize when one slice defines an API/schema/state/UX flow another consumes, when shared fixtures/state/defaults are involved, or when combined verification is the first meaningful test. If a worker path is unavailable, fall back per Model Routing (balance gpt/claude workers); only pause to ask before spending frontier (gpt-5.5) or Opus quota on execution.
+Default to parallel dispatch for independent DAG roots. Before any multi-slice build, make a dependency DAG from file sets, API/schema/state/UX dependencies, shared fixtures/defaults, and verification boundaries. If two slices do not share implementation-file ownership, do not define contracts consumed by each other, and can be verified locally before integration, launch them concurrently in separate git worktrees. Serial execution is the exception and must name the exact dependency edge or conflict domain that blocks parallelism.
+
+For every concurrent worker or any code/test/config edit, provide: objective, base branch/commit, worktree path, allowed files/modules, forbidden files/modules, conflict domain, dependency assumptions, verification command, receipt path, and max wall-clock. Same milestone, same broad feature, or eventual combined verification is not enough to serialize. Shared test files are a merge concern, not a serialization blocker, unless the test fixture/default itself is the shared state being changed.
+
+Use a practical fanout cap based on machine capacity and provider quota, normally 2-4 active workers. If a worker path is unavailable, fall back per Model Routing (balance gpt/claude workers); only pause to ask before spending frontier (gpt-5.5) or Opus quota on execution.
@@
-- **Monitor event-driven plus watchdog.** Rely on harness completion notifications for terminal state, and use Monitor/ScheduleWakeup only as a stall watchdog: first check at 60-90 seconds, then every 2-3 minutes while active. No 20-minute blind check-ins.
+- **Monitor event-driven, not by polling.** Rely on harness completion notifications for terminal state. After a healthy background worker is launched, spend zero Sonnet turns asking for status. Schedule at most one fallback wakeup for hang detection at the slice max wall-clock plus grace; use it only if no completion notification arrived. No 60-90 second check, no 2-3 minute watchdog loop, no "status?" turns to healthy workers.
 - **Liveness = output freshness plus process activity**, not "process still exists." No new output for ~5-10 minutes with near-flat CPU, or a wall-clock budget breach, is `HUNG`.
-- **On stall or budget exceeded:** stop it through the harness/supervisor, inspect the working-tree diff and receipt/output, then resume-from-diff or retry the same provider per Model Routing. Do not restart from scratch if useful work landed.
+- **On the single fallback wakeup:** inspect output freshness and process activity. If there is fresh output or meaningful CPU, extend once with an explicit new deadline and wait for notification again. If stalled or budget exceeded, stop it through the harness/supervisor, inspect the working-tree diff and receipt/output, then resume-from-diff or retry the same provider per Model Routing. Do not restart from scratch if useful work landed.
```

## Sources

- Anthropic Engineering, "How we built our multi-agent research system" (published 2025-06-13): orchestrator-worker pattern, parallel subagents, speed gains from parallelization, and token/dependency caveats. https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI Agents SDK, "Agent orchestration": code-driven orchestration is more deterministic for speed/cost/performance; independent agents can run in parallel via primitives like `asyncio.gather`. https://openai.github.io/openai-agents-python/multi_agent/
- OpenAI API docs, "Agents SDK" and "Integrations and observability": server-owned orchestration/state/approvals, tracing of runs/model calls/tool calls/handoffs/guardrails/custom spans. https://developers.openai.com/api/docs/guides/agents and https://developers.openai.com/api/docs/guides/agents/integrations-observability
- Git documentation, `git-worktree`: multiple working trees attached to one repository, with separate worktree metadata and branch/index state. https://git-scm.com/docs/git-worktree
- GitHub Docs, "Webhook events and payloads": subscribe to specific events and receive delivery payloads instead of repeatedly polling broad state. https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Argo CD docs, "Webhook Configuration": webhooks eliminate the delay from polling Git/OCI/Helm repositories every three minutes. https://argo-cd.readthedocs.io/en/latest/operator-manual/webhook/
- Temporal, durable execution overview: durable state, retries, task queues, signals, and timers for long-running workflows. https://temporal.io/
