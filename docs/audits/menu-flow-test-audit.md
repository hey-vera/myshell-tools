# Menu Flow Test Audit

Intended path: `docs/audits/menu-flow-test-audit.md`  
Repo: `myshell-tools`  
Date: 2026-06-29

## Executive Summary

Current 44 failures classify as:

| classification | count |
|---|---:|
| `real-regression` | 14 |
| `fixture-or-env` | 12 |
| `stale-behavior-assertion` | 12 |
| `stale-menu-assertion` | 6 |

Top shared root causes:

- `fixture-or-env`: `withStateHome()` sets `HOME`, but `defaultStateHome()` ultimately uses `os.homedir()` on Windows, so goal-store tests leak real `~/.myshell-tools` state. This explains the `4536`, `4532`, `13`, and wrong `goal_fake7` results.
- `stale-menu-assertion`: `[e]` is now **Library**, and Manage is under Library. Old `e -> p/r/x` scripts must become `e -> m -> p/r/x`.
- `stale-behavior-assertion`: explicit `/goal` now enters the default-on scheduler/decomposer path unless `experimentalScheduler:false` or `MYSHELL_SCHEDULER=0`.
- `real-regression`: optional preflight/governor budget appears able to consume the only model-call budget before the core work call, so provider seams are never invoked in rank-7/9/10, inline re-login, retry/edit, and some normal-work tests. The core answer is supposed to be un-sheddable.
- Additional source bug found: `src/interface/menu.ts:4037` maps Claude’s available models into `avail['grok']` inside `researchWebSearch`.

Vitest recommendation: **NO-GO now**. First get this suite green on `node:test`, then migrate against that known-good baseline. Estimated migration: 2-4 focused agent passes for a compatibility shim/pilot, 25-45 person-hours for full conversion.

---

## Section 1: Failure Classification

| # | failing test | classification | root cause | exact fix direction |
|---:|---|---|---|---|
| 1 | `shifts an IC turn by weighted session consumption and leaves a fresh conversation neutral` | `stale-behavior-assertion` | Routing/capacity behavior changed with v3.159/v3.160 multi-subscription + Auto-smart routing. Current fixture selects `codex` for the fresh run. Code paths: `src/interface/menu.ts:2369`, `src/core/capacity-allocator.ts:250`. | Update expected fresh call to `['codex']`, or pin the old baseline by disabling vendor-neutral/capacity routing in this test. |
| 2 | `/goal ask_user stops autonomous loop and surfaces selector` | `stale-behavior-assertion` | Explicit `/goal` now goes through default-on scheduler/decomposer before the legacy free goal loop. Code: `src/interface/menu.ts:4535`, flag default in `src/interface/ui/scheduler-flag.ts`. | If the test is for legacy ask_user loop, add `experimentalScheduler:false`. If testing current behavior, assert scheduler/decomposer prompts and eventual selector handling. |
| 3 | `/goal work contract threading` | `stale-behavior-assertion` | Same scheduler/decomposer path means the old free-loop `GOAL_CONTINUE` contract prompt is not the first/main observable. | Add `experimentalScheduler:false` for this legacy contract test, or rewrite around scheduler goal-phase events. |
| 4 | `[Start all] on a MULTI-goal plan runs EVERY goal sequentially to verified-done` | `stale-behavior-assertion` | Current implementation may route through scheduler/decompose/verification instead of old sequential prompt text. Code: `src/interface/menu.ts:4535`, `src/interface/menu.ts:5750` area. | Update to assert goal IDs/events/state transitions, not old `Goal:` prompt text; or explicitly disable scheduler. |
| 5 | `flag ON: a fork PARKS that one item...` | `fixture-or-env` | Goal store is reading real Windows state; expected `2`, got `4532`. Root: `test/unit/menu-flow.test.ts:70-82`, `src/infra/state-dir.ts:42`. | Fix harness: pass explicit `homeDir` to `createFileGoalStore`, or make `withStateHome` isolate `USERPROFILE`/`APPDATA` on Windows, not just `HOME`. |
| 6 | `flag OFF: same fork STOPS the cycle` | `fixture-or-env` | Same goal-store contamination; assertions inspect the wrong data layer. | Same harness fix; rerun before touching source. |
| 7 | `single goal cap 1, one phase` | `stale-behavior-assertion` | Default scheduler/decomposer path changes what counts as a “goal-work phase”; old prompt-count assertion no longer maps to product behavior. | Assert scheduler phase events or disable scheduler for this legacy cap test. |
| 8 | `with autoGoal off, manager-tier task stays on single runTask path` | `real-regression` | Normal model-needed chat should pass through `runTaskWithInputHooks`; provider call count is `0`. Gate is at `src/interface/menu.ts:6053`; budget/preflight starvation likely prevents the core answer. | Fix source so `experimentalAutoGoal:false` and `intentEngine:false` still run one core work call. Add a regression test that asserts provider called once before any optional post-turn machinery. |
| 9 | `clear actionable chat answers first, then auto-stages one goal` | `real-regression` | Test expected answer-first worker call; provider was not called. Likely same core-answer starvation/diversion. | Fix source so auto-stage remains post-turn and never suppresses the normal answer. Then keep the answer-first assertion. |
| 10 | `substantial confident goal stages PARKED...` | `fixture-or-env` | Expected `1`, got `4536`; leaked real goal store. | Harness state isolation fix. |
| 11 | `go-when-confident preference is recorded...` | `stale-behavior-assertion` | v3.160 activation semantics now allow “go when confident” to mark a confident staged goal `running`. | Update expected state to `running` and assert no blocking of user reply; or change the prompt to avoid the activation override. |
| 12 | `always-plan-first preference parks a trivial confident goal immediately` | `fixture-or-env` | Actual `running` likely comes from leaked first goal row, not the newly staged goal. | Harness state isolation fix, then reassess. Source should still park under always-plan-first. |
| 13 | `confident-but-unverifiable goal stages PARKED` | `fixture-or-env` | Expected `1`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 14 | `hasWorkIntent=false skips planner and creates no goal` | `fixture-or-env` | Expected `0`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 15 | `planner clarify asks one post-turn question...` | `fixture-or-env` | Expected `0`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 16 | `experimentalAutoGoal:false preserves ordinary chat path...` | `fixture-or-env` | Expected `0`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 17 | `planning-depth gate off preserves single ungrounded planner call` | `stale-behavior-assertion` | Planning-depth/Auto-smart call graph changed; old call-count expectation no longer matches default-on governor/planner behavior. Code: `src/interface/auto-stage.ts:298-327`. | Update to current call-budget semantics, or explicitly disable modern governor/planning flags for legacy assertion. |
| 18 | `planning-depth gate on keeps low-risk birdhouse at one silent planner call` | `stale-behavior-assertion` | Same planning-depth/governor behavior drift. | Same fix direction. |
| 19 | `cold hard post-turn planning answers first, then grounds...` | `stale-behavior-assertion` | Understanding pass is now cache-ahead/background and may not appear synchronously in the old sequence. Code: `src/interface/menu.ts:4260` comments, `src/interface/auto-stage.ts`. | Assert eventual warm-cache state, not strict synchronous sequence. |
| 20 | `warm SystemModel is reused...` | `stale-behavior-assertion` | Warm understanding cache behavior changed; old exact count `2` is stale. | Update to assert “no second blocking understanding pass” rather than exact two planner calls. |
| 21 | `understanding failure falls through...` | `stale-behavior-assertion` | Same background/fail-soft understanding path. | Update sequence assertion to current fail-soft behavior. |
| 22 | `cost-saver call budget caps hard turn at L1...` | `stale-behavior-assertion` | Governor/Auto-smart budget semantics changed. Code: `src/core/governor.ts:695-704`, `src/interface/auto-stage.ts:298-327`. | Update expected sequence/budget, or pin old flags. |
| 23 | `post-turn staged goals sync persisted goalId...` | `fixture-or-env` | Expected `1`, got `4538`; leaked goal store. | Harness state isolation fix. |
| 24 | `rank-7 unify=false router preflight prompt fires` | `real-regression` | Work call count is `0`; optional preflight appears to consume/avoid the core work provider request. Core answer should survive. Code: `src/interface/menu.ts:2240` comment, `src/core/work-call.ts:687`, `src/core/orchestrate.ts:1807`. | Fix budget accounting so preflight calls cannot exhaust the core answer call. Keep assertion that task prompt runs once. |
| 25 | `rank-7 unify=true router preflight suppressed` | `real-regression` | Same as #24. | Same source fix. |
| 26 | `rank-9 requiredInvestigation=false` | `real-regression` | No non-intent work request exists. Same core-answer starvation. | Same source fix; then assert no `LOCAL INVESTIGATION` when flag off. |
| 27 | `rank-9 requiredInvestigation=true` | `real-regression` | Same; work request missing entirely. Also source typo at `src/interface/menu.ts:4037` can break research web provider routing. | Fix core-answer budget; fix `avail['grok']` to `avail['claude']`. |
| 28 | `rank-10 preflightGuard=false` | `real-regression` | Work request missing; guard should govern model preflight overhead, not suppress local retrieval or core answer. | Fix budget/guard accounting. |
| 29 | `rank-10 preflightGuard=true` | `real-regression` | Same as #28. | Same source fix. |
| 30 | `pins conversation 1 via manage screen` | `stale-menu-assertion` | `[e]` now opens Library; Manage is inside Library. Code: `src/interface/menu-render.ts:156`, `src/interface/menu.ts:7148-7165`. | Change script from `e,p,1,...` to `e,m,p,1,...`. |
| 31 | `renames conversation via manage screen` | `stale-menu-assertion` | Same Library nesting. | `e,m,r,1,New name,...`. |
| 32 | `deletes conversation via manage screen` | `stale-menu-assertion` | Same Library nesting. | `e,m,x,1,y,...`. |
| 33 | `manage screen with no conversations shows appropriate message` | `stale-menu-assertion` | Same Library nesting; old test never opens manage. | `e,m,...`; expected text may now be Library/Manage wording. |
| 34 | `shows single mode prompt with all three modes inline` | `stale-menu-assertion` | Welcome mode picker is now 5-level Auto-smart: `Auto (smart)`, `Budget`, `Balanced`, `High`, `Max`; not old `Efficient/Balanced/Max` 3-mode prompt. Code: `src/interface/menu-welcome.ts:161-205`. | Assert `Mode: Auto (smart) is on by default`, `[1] Auto (smart)`, `[2] Budget`, `[3] Balanced`, `[4] High`, `[5] Max`, `Press Enter to keep Auto`. |
| 35 | `first main screen shows FRESH status after onboarding signed in` | `stale-menu-assertion` | Source re-detects after onboarding at `src/interface/menu.ts:6869`; test splits on first `Accounts`, discarding provider header where `claude: signed in` now appears. | Assert against full first frame/header, or split on a more specific section marker. |
| 36 | `user answers y -> login is called with failing provider` | `real-regression` | Provider/auth failure path is never reached because provider request count is `0`; same core work call starvation. Inline login source is at `src/interface/menu.ts:6135-6177`. | After fixing core-answer budget, login seam should be called with `claude`. Keep test. |
| 37 | `user answers y -> runTask is retried` | `real-regression` | Provider called `0`; retry path cannot execute. | Same source fix; keep expectation `>=2` provider calls. |
| 38 | `no real login subprocess spawned` | `real-regression` | Login seam not invoked because auth failure never surfaced. | Same source fix; keep seam assertion. |
| 39 | `after re-login, retry uses fresh env` | `real-regression` | Re-login path not reached; source refresh exists at `src/interface/menu.ts:6164`. | Same source fix; keep detect-after-login assertion. |
| 40 | `/retry regenerates last answer` | `real-regression` | Re-run provider call is skipped; likely same budget/preflight starvation on regenerated turn. Slash command code around `src/interface/menu.ts` retry/edit region, normal dispatch at `src/interface/menu.ts:6053`. | Ensure `/retry` bypasses optional preflight starvation and always executes one core work call when provider is authenticated. |
| 41 | `/edit picks prior message and re-runs` | `real-regression` | Same: edited re-run does not produce new assistant output. | Same source fix. |
| 42 | `/todo parks a goal...` | `fixture-or-env` | Expected `1`, got `13`; leaked goal store. | Harness state isolation fix. |
| 43 | `/goals go promotes THROUGH runGoalLoop` | `fixture-or-env` | `/goals go 1` can select an old leaked parked goal, not the one just created. Provider prompt assertion then misses. | Harness state isolation fix; after that, if scheduler changes prompt text, assert provider called and goal state changed rather than old `Goal:` substring. |
| 44 | `/goals cancel terminates tree...` | `fixture-or-env` | Output cancels `goal_fake7 — Build the birdhouse`, not the test-created `goal_fake1 — cancel root`; leaked goal store. | Harness state isolation fix. |

### Shared Root Causes

1. **Windows state-home isolation is broken in tests.**  
   `withStateHome()` only sets `HOME` (`test/unit/menu-flow.test.ts:70-82`). Production `defaultStateHome()` calls `homedir()` (`src/infra/state-dir.ts:42-57`), which on Windows is not reliably controlled by `HOME`. Any `createFileGoalStore({ clock })` without explicit home reads real user state. Fix the harness first before touching goal-store assertions.

2. **Library IA moved Manage.**  
   Home now renders `[e] Library` (`src/interface/menu-render.ts:156`), with Manage under `e -> m` (`src/interface/menu.ts:7148-7165`). All old `e -> manage action` scripts are stale.

3. **Default-on scheduler/decomposer changed `/goal`.**  
   Scheduler is smart-default-on (`src/interface/ui/scheduler-flag.ts`), and `runGoalLoop` chooses scheduler when not explicitly off (`src/interface/menu.ts:4535`). Legacy free-loop tests should set `experimentalScheduler:false`.

4. **Core answer can be starved by optional preflight/governor budget.**  
   Failures with “provider request was made” false should be treated as source regressions. The source comments promise the core answer survives shedding, but `turnCallBudget`/preflight accounting appears to allow zero core work calls. Inspect `src/core/work-call.ts:687`, `src/core/orchestrate.ts:1807`, and `src/interface/menu.ts:2240`.

5. **Research web-search model map typo.**  
   `src/interface/menu.ts:4037` sets `avail['grok'] = mutableCtx.env.grok.availableModels` inside the Claude branch. Fix to `avail['claude'] = mutableCtx.env.claude.availableModels`.

---

## Section 2: Vitest Migration Assessment

### Quantitative Surface

Measured with `rg` over `test/`:

| item | count |
|---|---:|
| test files | 263 |
| files importing `node:test` | 256 |
| `assert.*` call sites | 12,719 |
| `describe` / `it` / `test` blocks | 7,519 |
| hook calls (`before`, `after`, `beforeEach`, `afterEach`) | 123 |
| `node:test` mock/timer/TestContext-like hits | 14 |
| skip/todo-ish hits | 59 |

Current scripts in `package.json` use `node --import tsx/esm --test`; no Vitest dependency or config exists.

### Current Vitest Capability Notes

Vitest v4.1.7 docs show:

- `test`/`it` supports options including `timeout`, `skip`, `todo`, `fails`, and `retry`; object-form retry with `count`, `delay`, and `condition` is available since Vitest 4.1. Source: <https://vitest.dev/api/test>.
- Vitest has `vi.mock`, `vi.doMock`, and `vi.hoisted`, but module mocks are hoisted and ESM-specific caveats matter. Source: <https://vitest.dev/api/vi.html>.
- Vitest supports object-form skip and contextual `context.skip()`, so most `node:test` skip patterns have analogs. Source: <https://vitest.dev/api/test>.
- Vitest includes fake timers through `vi.useFakeTimers`/timer APIs, but this repo currently has direct `node:test` `mock.timers` use in `status-block`, `render`, and `spinner` tests.

### Blockers / Risks For This Repo

- **Baseline is red.** Migrating while `menu-flow.test.ts` has 44 failures would mix semantic failures with runner failures.
- **The largest file is already high-risk.** `test/unit/menu-flow.test.ts` is about 10k lines and uses long-running integration-style flows. Moving it first would be a poor pilot.
- **Subprocess-heavy tests.** Several tests spawn `git`, Node, and provider-like child processes. Vitest’s worker isolation, environment variables, and watch mode can change timing and process inheritance behavior.
- **ESM/tsx loader interplay.** Current suite runs directly through Node with `--import tsx/esm`. Vitest uses Vite’s module runner/transform pipeline, so import timing, hoisted mocks, and TS transform behavior need validation.
- **Windows behavior is already a failure mode.** The state-home leak and constrained PowerShell profile noise show Windows needs careful env isolation before adding a new runner.
- **`node:test` timer APIs.** `mock.timers` call sites need conversion to `vi.useFakeTimers`/`vi.advanceTimersByTime`/`vi.useRealTimers`.

### Upside

- **Retries for Windows flakiness.** Vitest’s per-test `retry` option is useful for a few environment-sensitive tests, but it should not mask deterministic product regressions.
- **Better developer loop.** Watch mode, filtering, richer reporters, and better diffs are real quality-of-life wins.
- **Mock ergonomics.** `vi.fn`/`vi.spyOn`/`vi.mock` could simplify some fake-provider or module-boundary tests.
- **Potential speed.** Vitest may improve many small unit tests, but the 100s `menu-flow.test.ts` file is dominated by app-level async behavior and is unlikely to become fast just by switching runners.

### Recommendation

**NO-GO for immediate migration.**

Sequence:

1. Fix source regressions and fixture leaks until `node --import tsx/esm --test test/unit/menu-flow.test.ts </dev/null` is green.
2. Add a small Vitest pilot for pure unit tests only, not `menu-flow.test.ts`.
3. Convert timer tests from `mock.timers` to `vi.useFakeTimers`.
4. Add `vitest.config.ts` with explicit Node environment, no globals unless deliberately chosen, and conservative worker settings.
5. Migrate `menu-flow.test.ts` last, after the rest of the suite proves runner parity.

Effort estimate:

| scope | estimate |
|---|---:|
| green `menu-flow.test.ts` on node:test | 1-2 focused agent passes |
| Vitest pilot on pure tests | 4-8 hours |
| convert timers/hooks/imports across suite | 12-24 hours |
| migrate subprocess/integration tests safely | 8-16 hours |
| migrate `menu-flow.test.ts` last | 6-12 hours |

Overall: **25-45 person-hours / 3-6 agent passes**, after the Node baseline is green.
tokens used
270,020
Could not write `docs/audits/menu-flow-test-audit.md` because this session is read-only. Full audit doc follows.

# Menu Flow Test Audit

Intended path: `docs/audits/menu-flow-test-audit.md`  
Repo: `myshell-tools`  
Date: 2026-06-29

## Executive Summary

Current 44 failures classify as:

| classification | count |
|---|---:|
| `real-regression` | 14 |
| `fixture-or-env` | 12 |
| `stale-behavior-assertion` | 12 |
| `stale-menu-assertion` | 6 |

Top shared root causes:

- `fixture-or-env`: `withStateHome()` sets `HOME`, but `defaultStateHome()` ultimately uses `os.homedir()` on Windows, so goal-store tests leak real `~/.myshell-tools` state. This explains the `4536`, `4532`, `13`, and wrong `goal_fake7` results.
- `stale-menu-assertion`: `[e]` is now **Library**, and Manage is under Library. Old `e -> p/r/x` scripts must become `e -> m -> p/r/x`.
- `stale-behavior-assertion`: explicit `/goal` now enters the default-on scheduler/decomposer path unless `experimentalScheduler:false` or `MYSHELL_SCHEDULER=0`.
- `real-regression`: optional preflight/governor budget appears able to consume the only model-call budget before the core work call, so provider seams are never invoked in rank-7/9/10, inline re-login, retry/edit, and some normal-work tests. The core answer is supposed to be un-sheddable.
- Additional source bug found: `src/interface/menu.ts:4037` maps Claude’s available models into `avail['grok']` inside `researchWebSearch`.

Vitest recommendation: **NO-GO now**. First get this suite green on `node:test`, then migrate against that known-good baseline. Estimated migration: 2-4 focused agent passes for a compatibility shim/pilot, 25-45 person-hours for full conversion.

---

## Section 1: Failure Classification

| # | failing test | classification | root cause | exact fix direction |
|---:|---|---|---|---|
| 1 | `shifts an IC turn by weighted session consumption and leaves a fresh conversation neutral` | `stale-behavior-assertion` | Routing/capacity behavior changed with v3.159/v3.160 multi-subscription + Auto-smart routing. Current fixture selects `codex` for the fresh run. Code paths: `src/interface/menu.ts:2369`, `src/core/capacity-allocator.ts:250`. | Update expected fresh call to `['codex']`, or pin the old baseline by disabling vendor-neutral/capacity routing in this test. |
| 2 | `/goal ask_user stops autonomous loop and surfaces selector` | `stale-behavior-assertion` | Explicit `/goal` now goes through default-on scheduler/decomposer before the legacy free goal loop. Code: `src/interface/menu.ts:4535`, flag default in `src/interface/ui/scheduler-flag.ts`. | If the test is for legacy ask_user loop, add `experimentalScheduler:false`. If testing current behavior, assert scheduler/decomposer prompts and eventual selector handling. |
| 3 | `/goal work contract threading` | `stale-behavior-assertion` | Same scheduler/decomposer path means the old free-loop `GOAL_CONTINUE` contract prompt is not the first/main observable. | Add `experimentalScheduler:false` for this legacy contract test, or rewrite around scheduler goal-phase events. |
| 4 | `[Start all] on a MULTI-goal plan runs EVERY goal sequentially to verified-done` | `stale-behavior-assertion` | Current implementation may route through scheduler/decompose/verification instead of old sequential prompt text. Code: `src/interface/menu.ts:4535`, `src/interface/menu.ts:5750` area. | Update to assert goal IDs/events/state transitions, not old `Goal:` prompt text; or explicitly disable scheduler. |
| 5 | `flag ON: a fork PARKS that one item...` | `fixture-or-env` | Goal store is reading real Windows state; expected `2`, got `4532`. Root: `test/unit/menu-flow.test.ts:70-82`, `src/infra/state-dir.ts:42`. | Fix harness: pass explicit `homeDir` to `createFileGoalStore`, or make `withStateHome` isolate `USERPROFILE`/`APPDATA` on Windows, not just `HOME`. |
| 6 | `flag OFF: same fork STOPS the cycle` | `fixture-or-env` | Same goal-store contamination; assertions inspect the wrong data layer. | Same harness fix; rerun before touching source. |
| 7 | `single goal cap 1, one phase` | `stale-behavior-assertion` | Default scheduler/decomposer path changes what counts as a “goal-work phase”; old prompt-count assertion no longer maps to product behavior. | Assert scheduler phase events or disable scheduler for this legacy cap test. |
| 8 | `with autoGoal off, manager-tier task stays on single runTask path` | `real-regression` | Normal model-needed chat should pass through `runTaskWithInputHooks`; provider call count is `0`. Gate is at `src/interface/menu.ts:6053`; budget/preflight starvation likely prevents the core answer. | Fix source so `experimentalAutoGoal:false` and `intentEngine:false` still run one core work call. Add a regression test that asserts provider called once before any optional post-turn machinery. |
| 9 | `clear actionable chat answers first, then auto-stages one goal` | `real-regression` | Test expected answer-first worker call; provider was not called. Likely same core-answer starvation/diversion. | Fix source so auto-stage remains post-turn and never suppresses the normal answer. Then keep the answer-first assertion. |
| 10 | `substantial confident goal stages PARKED...` | `fixture-or-env` | Expected `1`, got `4536`; leaked real goal store. | Harness state isolation fix. |
| 11 | `go-when-confident preference is recorded...` | `stale-behavior-assertion` | v3.160 activation semantics now allow “go when confident” to mark a confident staged goal `running`. | Update expected state to `running` and assert no blocking of user reply; or change the prompt to avoid the activation override. |
| 12 | `always-plan-first preference parks a trivial confident goal immediately` | `fixture-or-env` | Actual `running` likely comes from leaked first goal row, not the newly staged goal. | Harness state isolation fix, then reassess. Source should still park under always-plan-first. |
| 13 | `confident-but-unverifiable goal stages PARKED` | `fixture-or-env` | Expected `1`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 14 | `hasWorkIntent=false skips planner and creates no goal` | `fixture-or-env` | Expected `0`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 15 | `planner clarify asks one post-turn question...` | `fixture-or-env` | Expected `0`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 16 | `experimentalAutoGoal:false preserves ordinary chat path...` | `fixture-or-env` | Expected `0`, got `4536`; leaked goal store. | Harness state isolation fix. |
| 17 | `planning-depth gate off preserves single ungrounded planner call` | `stale-behavior-assertion` | Planning-depth/Auto-smart call graph changed; old call-count expectation no longer matches default-on governor/planner behavior. Code: `src/interface/auto-stage.ts:298-327`. | Update to current call-budget semantics, or explicitly disable modern governor/planning flags for legacy assertion. |
| 18 | `planning-depth gate on keeps low-risk birdhouse at one silent planner call` | `stale-behavior-assertion` | Same planning-depth/governor behavior drift. | Same fix direction. |
| 19 | `cold hard post-turn planning answers first, then grounds...` | `stale-behavior-assertion` | Understanding pass is now cache-ahead/background and may not appear synchronously in the old sequence. Code: `src/interface/menu.ts:4260` comments, `src/interface/auto-stage.ts`. | Assert eventual warm-cache state, not strict synchronous sequence. |
| 20 | `warm SystemModel is reused...` | `stale-behavior-assertion` | Warm understanding cache behavior changed; old exact count `2` is stale. | Update to assert “no second blocking understanding pass” rather than exact two planner calls. |
| 21 | `understanding failure falls through...` | `stale-behavior-assertion` | Same background/fail-soft understanding path. | Update sequence assertion to current fail-soft behavior. |
| 22 | `cost-saver call budget caps hard turn at L1...` | `stale-behavior-assertion` | Governor/Auto-smart budget semantics changed. Code: `src/core/governor.ts:695-704`, `src/interface/auto-stage.ts:298-327`. | Update expected sequence/budget, or pin old flags. |
| 23 | `post-turn staged goals sync persisted goalId...` | `fixture-or-env` | Expected `1`, got `4538`; leaked goal store. | Harness state isolation fix. |
| 24 | `rank-7 unify=false router preflight prompt fires` | `real-regression` | Work call count is `0`; optional preflight appears to consume/avoid the core work provider request. Core answer should survive. Code: `src/interface/menu.ts:2240` comment, `src/core/work-call.ts:687`, `src/core/orchestrate.ts:1807`. | Fix budget accounting so preflight calls cannot exhaust the core answer call. Keep assertion that task prompt runs once. |
| 25 | `rank-7 unify=true router preflight suppressed` | `real-regression` | Same as #24. | Same source fix. |
| 26 | `rank-9 requiredInvestigation=false` | `real-regression` | No non-intent work request exists. Same core-answer starvation. | Same source fix; then assert no `LOCAL INVESTIGATION` when flag off. |
| 27 | `rank-9 requiredInvestigation=true` | `real-regression` | Same; work request missing entirely. Also source typo at `src/interface/menu.ts:4037` can break research web provider routing. | Fix core-answer budget; fix `avail['grok']` to `avail['claude']`. |
| 28 | `rank-10 preflightGuard=false` | `real-regression` | Work request missing; guard should govern model preflight overhead, not suppress local retrieval or core answer. | Fix budget/guard accounting. |
| 29 | `rank-10 preflightGuard=true` | `real-regression` | Same as #28. | Same source fix. |
| 30 | `pins conversation 1 via manage screen` | `stale-menu-assertion` | `[e]` now opens Library; Manage is inside Library. Code: `src/interface/menu-render.ts:156`, `src/interface/menu.ts:7148-7165`. | Change script from `e,p,1,...` to `e,m,p,1,...`. |
| 31 | `renames conversation via manage screen` | `stale-menu-assertion` | Same Library nesting. | `e,m,r,1,New name,...`. |
| 32 | `deletes conversation via manage screen` | `stale-menu-assertion` | Same Library nesting. | `e,m,x,1,y,...`. |
| 33 | `manage screen with no conversations shows appropriate message` | `stale-menu-assertion` | Same Library nesting; old test never opens manage. | `e,m,...`; expected text may now be Library/Manage wording. |
| 34 | `shows single mode prompt with all three modes inline` | `stale-menu-assertion` | Welcome mode picker is now 5-level Auto-smart: `Auto (smart)`, `Budget`, `Balanced`, `High`, `Max`; not old `Efficient/Balanced/Max` 3-mode prompt. Code: `src/interface/menu-welcome.ts:161-205`. | Assert `Mode: Auto (smart) is on by default`, `[1] Auto (smart)`, `[2] Budget`, `[3] Balanced`, `[4] High`, `[5] Max`, `Press Enter to keep Auto`. |
| 35 | `first main screen shows FRESH status after onboarding signed in` | `stale-menu-assertion` | Source re-detects after onboarding at `src/interface/menu.ts:6869`; test splits on first `Accounts`, discarding provider header where `claude: signed in` now appears. | Assert against full first frame/header, or split on a more specific section marker. |
| 36 | `user answers y -> login is called with failing provider` | `real-regression` | Provider/auth failure path is never reached because provider request count is `0`; same core work call starvation. Inline login source is at `src/interface/menu.ts:6135-6177`. | After fixing core-answer budget, login seam should be called with `claude`. Keep test. |
| 37 | `user answers y -> runTask is retried` | `real-regression` | Provider called `0`; retry path cannot execute. | Same source fix; keep expectation `>=2` provider calls. |
| 38 | `no real login subprocess spawned` | `real-regression` | Login seam not invoked because auth failure never surfaced. | Same source fix; keep seam assertion. |
| 39 | `after re-login, retry uses fresh env` | `real-regression` | Re-login path not reached; source refresh exists at `src/interface/menu.ts:6164`. | Same source fix; keep detect-after-login assertion. |
| 40 | `/retry regenerates last answer` | `real-regression` | Re-run provider call is skipped; likely same budget/preflight starvation on regenerated turn. Slash command code around `src/interface/menu.ts` retry/edit region, normal dispatch at `src/interface/menu.ts:6053`. | Ensure `/retry` bypasses optional preflight starvation and always executes one core work call when provider is authenticated. |
| 41 | `/edit picks prior message and re-runs` | `real-regression` | Same: edited re-run does not produce new assistant output. | Same source fix. |
| 42 | `/todo parks a goal...` | `fixture-or-env` | Expected `1`, got `13`; leaked goal store. | Harness state isolation fix. |
| 43 | `/goals go promotes THROUGH runGoalLoop` | `fixture-or-env` | `/goals go 1` can select an old leaked parked goal, not the one just created. Provider prompt assertion then misses. | Harness state isolation fix; after that, if scheduler changes prompt text, assert provider called and goal state changed rather than old `Goal:` substring. |
| 44 | `/goals cancel terminates tree...` | `fixture-or-env` | Output cancels `goal_fake7 — Build the birdhouse`, not the test-created `goal_fake1 — cancel root`; leaked goal store. | Harness state isolation fix. |

### Shared Root Causes

1. **Windows state-home isolation is broken in tests.**  
   `withStateHome()` only sets `HOME` (`test/unit/menu-flow.test.ts:70-82`). Production `defaultStateHome()` calls `homedir()` (`src/infra/state-dir.ts:42-57`), which on Windows is not reliably controlled by `HOME`. Any `createFileGoalStore({ clock })` without explicit home reads real user state. Fix the harness first before touching goal-store assertions.

2. **Library IA moved Manage.**  
   Home now renders `[e] Library` (`src/interface/menu-render.ts:156`), with Manage under `e -> m` (`src/interface/menu.ts:7148-7165`). All old `e -> manage action` scripts are stale.

3. **Default-on scheduler/decomposer changed `/goal`.**  
   Scheduler is smart-default-on (`src/interface/ui/scheduler-flag.ts`), and `runGoalLoop` chooses scheduler when not explicitly off (`src/interface/menu.ts:4535`). Legacy free-loop tests should set `experimentalScheduler:false`.

4. **Core answer can be starved by optional preflight/governor budget.**  
   Failures with “provider request was made” false should be treated as source regressions. The source comments promise the core answer survives shedding, but `turnCallBudget`/preflight accounting appears to allow zero core work calls. Inspect `src/core/work-call.ts:687`, `src/core/orchestrate.ts:1807`, and `src/interface/menu.ts:2240`.

5. **Research web-search model map typo.**  
   `src/interface/menu.ts:4037` sets `avail['grok'] = mutableCtx.env.grok.availableModels` inside the Claude branch. Fix to `avail['claude'] = mutableCtx.env.claude.availableModels`.

---

## Section 2: Vitest Migration Assessment

### Quantitative Surface

Measured with `rg` over `test/`:

| item | count |
|---|---:|
| test files | 263 |
| files importing `node:test` | 256 |
| `assert.*` call sites | 12,719 |
| `describe` / `it` / `test` blocks | 7,519 |
| hook calls (`before`, `after`, `beforeEach`, `afterEach`) | 123 |
| `node:test` mock/timer/TestContext-like hits | 14 |
| skip/todo-ish hits | 59 |

Current scripts in `package.json` use `node --import tsx/esm --test`; no Vitest dependency or config exists.

### Current Vitest Capability Notes

Vitest v4.1.7 docs show:

- `test`/`it` supports options including `timeout`, `skip`, `todo`, `fails`, and `retry`; object-form retry with `count`, `delay`, and `condition` is available since Vitest 4.1. Source: <https://vitest.dev/api/test>.
- Vitest has `vi.mock`, `vi.doMock`, and `vi.hoisted`, but module mocks are hoisted and ESM-specific caveats matter. Source: <https://vitest.dev/api/vi.html>.
- Vitest supports object-form skip and contextual `context.skip()`, so most `node:test` skip patterns have analogs. Source: <https://vitest.dev/api/test>.
- Vitest includes fake timers through `vi.useFakeTimers`/timer APIs, but this repo currently has direct `node:test` `mock.timers` use in `status-block`, `render`, and `spinner` tests.

### Blockers / Risks For This Repo

- **Baseline is red.** Migrating while `menu-flow.test.ts` has 44 failures would mix semantic failures with runner failures.
- **The largest file is already high-risk.** `test/unit/menu-flow.test.ts` is about 10k lines and uses long-running integration-style flows. Moving it first would be a poor pilot.
- **Subprocess-heavy tests.** Several tests spawn `git`, Node, and provider-like child processes. Vitest’s worker isolation, environment variables, and watch mode can change timing and process inheritance behavior.
- **ESM/tsx loader interplay.** Current suite runs directly through Node with `--import tsx/esm`. Vitest uses Vite’s module runner/transform pipeline, so import timing, hoisted mocks, and TS transform behavior need validation.
- **Windows behavior is already a failure mode.** The state-home leak and constrained PowerShell profile noise show Windows needs careful env isolation before adding a new runner.
- **`node:test` timer APIs.** `mock.timers` call sites need conversion to `vi.useFakeTimers`/`vi.advanceTimersByTime`/`vi.useRealTimers`.

### Upside

- **Retries for Windows flakiness.** Vitest’s per-test `retry` option is useful for a few environment-sensitive tests, but it should not mask deterministic product regressions.
- **Better developer loop.** Watch mode, filtering, richer reporters, and better diffs are real quality-of-life wins.
- **Mock ergonomics.** `vi.fn`/`vi.spyOn`/`vi.mock` could simplify some fake-provider or module-boundary tests.
- **Potential speed.** Vitest may improve many small unit tests, but the 100s `menu-flow.test.ts` file is dominated by app-level async behavior and is unlikely to become fast just by switching runners.

### Recommendation

**NO-GO for immediate migration.**

Sequence:

1. Fix source regressions and fixture leaks until `node --import tsx/esm --test test/unit/menu-flow.test.ts </dev/null` is green.
2. Add a small Vitest pilot for pure unit tests only, not `menu-flow.test.ts`.
3. Convert timer tests from `mock.timers` to `vi.useFakeTimers`.
4. Add `vitest.config.ts` with explicit Node environment, no globals unless deliberately chosen, and conservative worker settings.
5. Migrate `menu-flow.test.ts` last, after the rest of the suite proves runner parity.

Effort estimate:

| scope | estimate |
|---|---:|
| green `menu-flow.test.ts` on node:test | 1-2 focused agent passes |
| Vitest pilot on pure tests | 4-8 hours |
| convert timers/hooks/imports across suite | 12-24 hours |
| migrate subprocess/integration tests safely | 8-16 hours |
| migrate `menu-flow.test.ts` last | 6-12 hours |

Overall: **25-45 person-hours / 3-6 agent passes**, after the Node baseline is green.
