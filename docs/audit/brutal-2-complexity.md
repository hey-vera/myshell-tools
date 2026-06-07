# Brutal Complexity Audit 2

Scope: `myshell-tools` complexity, bloat, over-engineering, dead code, test value, and maintainability risk.

## CRITICAL

### 1. The turn pipeline is no longer one pipeline; it is an accreting control stack

The nominal flow in `orchestrate.ts` still claims a simple `classify -> route -> run -> review -> assess -> escalate/retry/accept` loop (`src/core/orchestrate.ts:4`). That comment is obsolete as architecture documentation. The real path now composes model-brained route classification, intent extraction, engagement planning, TurnDirective compilation, work-state reconstruction, vision triage, capability registry routing, panel branching, hedge branching, native session policy, discovery-driven escalation, output validators, history quarantine, memory proposal parsing, and work-contract persistence.

The first sign is the import list: `orchestrate.ts` pulls in routing, capability selection, flagship admission, panel, hedge, work contracts, intent, engagement, TurnDirective, work-state, vision triage, and discovery (`src/core/orchestrate.ts:30`). Then it builds engagement and web-search desire from `EngagementPlan` (`src/core/orchestrate.ts:509`, `src/core/orchestrate.ts:525`), compiles a `TurnDirective` (`src/core/orchestrate.ts:589`), branches on panel (`src/core/orchestrate.ts:854`) and hedge (`src/core/orchestrate.ts:881`), manages flagship admission (`src/core/orchestrate.ts:975`), applies vision tier floors (`src/core/orchestrate.ts:1007`), runs output validation/repair (`src/core/orchestrate.ts:1290`), runs review (`src/core/orchestrate.ts:1552`), and finally discovery escalation (`src/core/orchestrate.ts:1934`).

This is not coherent enough for a new engineer. It is a maze of partial authorities that all say they are "bounded" and "same gate" while still adding decision points. The repeated assurances are a smell: if the code needs that many "never bypasses" comments, the control model is too complicated.

Delete/simplify:

- Collapse `EngagementPlan`, `TurnDirective.requiredBeforeAnswer`, and `vision-triage` into one `TurnPlan` owned by one module. One input, one output, one consumer.
- Make `orchestrate.ts` consume a precomputed `TurnPlan` and stop deriving plan fragments internally.
- Remove advisory prompt-only actions that are duplicated by enforced validators. Keep enforced behavior or prompt guidance, not both.
- Publish a single routing/turn state diagram and enforce it with one integration test that exercises the actual CLI path.

### 2. `orchestrate.ts` and `menu.ts` have crossed the maintainability cliff

`src/interface/menu.ts` is 5,682 lines and 249KB. `src/core/orchestrate.ts` is 2,063 lines and 94KB. The giant tests mirror the giant files: `test/unit/menu-flow.test.ts` is 6,715 lines and `test/unit/orchestrate.test.ts` is 3,993 lines. This is not "well-tested"; it is a symptom that responsibilities have not been split.

`menu.ts` owns settings, config preservation, update toggles, provider login flows, chat loop input, recap generation, capability refresh, quota shedding, native-session planning, route classifier construction, intent extractor construction, tool-state construction, work-state rendering, memory injection, and the final `OrchestrateDeps` assembly (`src/interface/menu.ts:2383`, `src/interface/menu.ts:2631`, `src/interface/menu.ts:3488`, `src/interface/menu.ts:3533`, `src/interface/menu.ts:3585`, `src/interface/menu.ts:4316`, `src/interface/menu.ts:4377`, `src/interface/menu.ts:4406`, `src/interface/menu.ts:4422`, `src/interface/menu.ts:4442`, `src/interface/menu.ts:4457`, `src/interface/menu.ts:4477`).

The shape is especially bad around `buildDeps`: the chat UI constructs provider auth lists, plan infos, native sessions, route classifier, intent extractor, tool-state, learned routing, sleep ports, memory, work-state, environment context, and capability registry in one closure (`src/interface/menu.ts:4316`). This means the UI layer is now the dependency-injection container, feature flag resolver, policy composer, and state coordinator.

Delete/simplify:

- Extract `chat-deps.ts`: one pure-ish assembler for `OrchestrateDeps` from `env`, `config`, `history`, and session facts.
- Extract `settings.ts`: all config toggles and preservation logic out of `menu.ts`.
- Extract `chat-input.ts`: slash command parsing, queued input, question/memory post-turn flow.
- Split `orchestrate.ts` into `turn-prep.ts`, `sequential-runner.ts`, `review-runner.ts`, `acceptance.ts`, and `provider-run.ts`. If that is too hard, that proves the current module is too coupled.

### 3. Multiple overlapping "ask/investigate/plan/recommend" mechanisms compete

There are at least four mechanisms trying to decide whether to ask, investigate, plan, recommend, or escalate:

- Intent frame: stores goal, forks, constraints, done-when (`src/core/intent.ts:43`).
- Engagement plan: decides actions like `ASK_CLARIFYING`, `PLAN_FIRST`, `INVESTIGATE_CONTEXT`, `WEB_RESEARCH`, `DISCUSS_OPTIONS` (`src/core/engagement.ts:37`).
- TurnDirective: reinterprets the engagement plan into terminal questions, validators, history policy, vision triage, and substantial-turn gating (`src/core/turn-directive.ts:110`).
- Vision triage: decomposes task text and forks into `SOLID`, `DISCUSS`, `MIGRATE_REARCHITECT`, and `INVESTIGATE_THEN_PROPOSE` (`src/core/vision-triage.ts:48`).

Then `orchestrate.ts` adds more behavior on top: derived asks if the model did not ask (`src/core/orchestrate.ts:1372`), generic-menu repair (`src/core/orchestrate.ts:1290`), grounded-recommendation fallback (`src/core/orchestrate.ts:1342`), review correction (`src/core/orchestrate.ts:1552`), discovery escalation (`src/core/orchestrate.ts:1934`).

This is redundant and risky. A future bug fix will need to answer "which layer owns asking?" The current answer is "several." That is how regressions happen.

Delete/simplify:

- Delete `renderEngagementBlock` or demote it to debug-only. Enforced behavior belongs in `TurnDirective`/`TurnPlan`, not a prompt suggestion.
- Move `deriveAskFromForks` into the single turn-plan compiler. It should not be called from both engagement and orchestrate.
- Make vision triage an optional field on intent extraction only if it materially outperforms simple fork/task heuristics. Otherwise delete `vision-triage.ts`.
- Remove the "substantial grounded recommendation" validator unless real failure data proves it catches frequent defects. It is a regex policy engine over prose, not reliable program logic.

### 4. Routing has too many layers for too little strategic gain

Routing has static policy order (`src/core/policy.ts:43`), model-brained route classification (`src/core/router.ts:9`), provider auth preference (`src/core/route.ts:98`), learned provider order (`src/core/route.ts:122`), capability hard-requirement pre-pass (`src/core/route.ts:283`), within-provider capability rerank (`src/core/route.ts:192`), model outcome tie-break (`src/core/route.ts:57`), flagship admission (`src/core/policy.ts:23`), and reasoning-effort selection (`src/core/route.ts:633`).

The model capability registry is three systems glued together: declarative facts (`src/core/model-capabilities.ts:1`), dynamic refresh (`src/core/model-capability-refresh.ts:1`), and rendered self-awareness/tool state (`src/core/tool-state.ts:65`). Some facts are explicitly non-routable provider-native inventory (`src/core/model-capabilities.ts:97`, `src/core/tool-state.ts:348`), which means code exists to tell the model about features myshell deliberately does not use.

This is too much mechanism for a product that still routes all tiers by the same provider order: Claude, Codex, OpenCode (`src/core/policy.ts:43`). Capability fit only changes provider on hard requirements like vision/large-context (`src/core/route.ts:292`), and otherwise mostly tweaks model/effort after the provider is already chosen.

Delete/simplify:

- Keep one route decision path: rules/model classifier -> policy gate -> provider/model.
- Delete provider-native feature inventory until myshell actually invokes those features. "Facts for self-awareness only" is bloat (`src/core/model-capabilities.ts:97`).
- Delete model-level outcome learning unless there is production evidence it changes decisions materially. It is default-off, cold-started, and threads yet another optional order through `route()`.
- Merge capability summary and capability routing data into one smaller shape. Do not maintain separate "for prompt awareness" and "for route" views unless required.

## HIGH

### 5. Default-off experimental features are consuming core complexity

Several heavy features are built but off by default:

- Native sessions: config says experimental default-off (`src/infra/config.ts:45`), menu toggle shows off unless explicit true (`src/interface/menu.ts:2645`), and policy must quarantine history to avoid server-side stale context (`src/core/native-session.ts:46`).
- Panel: experimental default-off (`src/infra/config.ts:53`), branches before the sequential engine (`src/core/orchestrate.ts:854`), has its own executor (`src/core/ensemble.ts`), and renderer phase events (`src/core/types.ts:619`).
- Hedge: experimental default-off (`src/infra/config.ts:65`), branches before the sequential engine (`src/core/orchestrate.ts:881`), needs an injected sleep port (`src/core/types.ts:581`), and adds cancellation/race semantics.
- Learn routing: experimental default-off (`src/infra/config.ts:101`) and threads learned provider/model order through deps (`src/core/types.ts:540`, `src/core/types.ts:556`).
- Auto-goal: experimental default-off (`src/infra/config.ts:113`).

Default-off is not free. The code still has to be understood, tested, and kept compatible with the core path. Panel and hedge are especially expensive because they replace the main execution path, not just decorate it.

Delete/simplify:

- Pick one concurrency story: panel or hedge. Delete the other until there is real user demand.
- If native sessions stay experimental, isolate them outside `orchestrate.ts`; pass either `historyContext` or `sessionId`, not both plus quarantine backstops.
- Remove `learnRouting` until the ledger has enough real production outcome data to justify routing changes.

### 6. History quarantine is a patch over an earlier behavioral bug, not a clean abstraction

`turn-directive.ts` quarantines prior assistant generic-menu prose (`src/core/turn-directive.ts:555`) and then widens quarantine based on engine behavior version markers (`src/core/turn-directive.ts:558`). `native-session.ts` must know about that policy because provider-native server-side state can reintroduce poisoned prose (`src/core/native-session.ts:46`). `orchestrate.ts` repeats the backstop and refuses native session use when quarantined (`src/core/orchestrate.ts:1088`).

That is three places carrying the same scar tissue. It may be necessary short-term, but it should not become permanent architecture.

Delete/simplify:

- Put all transcript sanitation in `history.ts`; it should return sanitized replay plus a `canUseNativeSession` boolean.
- Delete version widening after one migration window. Old history should not shape the architecture indefinitely.
- Remove duplicate quarantine logic from `menu.ts` and `orchestrate.ts`; one owner only.

### 7. Work-state duplicates memory, recap, work-contract, and session history concepts

`work-state.ts` says it is not memory and is derived only from `workTrace` (`src/core/work-state.ts:6`). But the system already has session history, recap, work contracts, and memory injection. Now there is another prompt block with objective, done, next, and blocked (`src/core/work-state.ts:219`).

The problem is not that work-state is useless. The problem is that it is another state projection over the same conversation, with its own truthfulness rules, caps, and rendering. `menu.ts` derives it (`src/interface/menu.ts:4457`) and `orchestrate.ts` re-derives it when absent (`src/core/orchestrate.ts:556`). That duplication is unnecessary.

Delete/simplify:

- Make `WorkContract` the only task-state structure. Render it directly if needed.
- Delete `work-state.ts` or reduce it to a renderer over `WorkContract`.
- Stop deriving work-state in both `menu.ts` and `orchestrate.ts`.

### 8. Regex policy engines are being used as behavioral guarantees

Important behavior depends on lexicons:

- Engagement irreversibility, vision, investigable context, generic-menu forks, and web research (`src/core/engagement.ts:104`, `src/core/engagement.ts:121`, `src/core/engagement.ts:188`, `src/core/engagement.ts:255`, `src/core/engagement.ts:313`).
- TurnDirective generic-menu detection and grounded-recommendation detection (`src/core/turn-directive.ts:212`, `src/core/turn-directive.ts:275`, `src/core/turn-directive.ts:290`, `src/core/turn-directive.ts:329`).
- Vision triage migration/investigation splitting (`src/core/vision-triage.ts:111`, `src/core/vision-triage.ts:128`, `src/core/vision-triage.ts:138`).
- Discovery escalation (`src/core/discovery.ts:89`, `src/core/discovery.ts:111`, `src/core/discovery.ts:127`, `src/core/discovery.ts:147`, `src/core/discovery.ts:160`).

Regexes are acceptable for hints. They are brittle as enforcement. Here they drive provider retries, tier floors, review triggers, web-search flags, escalation reasons, and output repair.

Delete/simplify:

- Restrict regex systems to advisory labels and low-cost prompt context.
- Do not trigger extra provider calls or tier changes from prose regexes unless backed by explicit structured model output.
- Delete `discovery.ts` or make it debug telemetry until false-positive/false-negative rates are measured on real transcripts.

### 9. The test suite looks big, but much of it is not high-confidence behavior coverage

The suite is large by count, but much of it is fake-driven and assertion-heavy. `menu-flow.test.ts` explicitly uses scripted input with no real readline, no TTY, and no live providers (`test/unit/menu-flow.test.ts:4`). `orchestrate.test.ts` states all dependencies are faked in-memory with no network, filesystem, or child processes (`test/unit/orchestrate.test.ts:5`). `turn-directive-orchestrate.test.ts` does the same for APE wiring (`test/unit/turn-directive-orchestrate.test.ts:14`).

There is value in pure tests, but this suite is vulnerable to theater:

- It validates internal event choreography more than user-visible correctness.
- It locks in prompt substrings and implementation details.
- It inflates confidence in paths that real CLIs, real TTY behavior, real auth state, provider quirks, and native sessions can break.
- The largest production files have the largest fake harnesses, which often means tests are compensating for un-decomposed design.

The test command also does not run in this workspace as configured: `package.json` requires `node --experimental-strip-types` (`package.json:14`) while `engines` allows Node `>=20.0.0` (`package.json:9`). Node 20.20.0 rejects that flag. That is a basic operability failure, not a theoretical concern.

Delete/simplify:

- Fix the test runner first: either require a Node version that supports strip-types or use a loader consistently.
- Add a small number of real integration tests covering `myshell-tools` CLI -> provider adapter invocation with fake binaries on PATH. That is more valuable than hundreds of internal event assertions.
- Cut tests that only assert exact prompt prose or duplicated branch choreography after modules are decomposed.
- Measure mutation coverage or bug-regression density before citing "3464 tests" as evidence.

## MEDIUM

### 10. `knip` already reports unused exports; the config hides some product dead code

`knip` reports unused exports such as `decideSubstantial` (`src/core/turn-directive.ts:666`), `runQuestionSelector` (`src/interface/menu.ts:3401`), constants in user memory (`src/core/user-memory.ts:94`, `src/core/user-memory.ts:95`, `src/core/user-memory.ts:706`), and `resolveCodexHome` (`src/infra/model-capability-port.ts:38`). Some are used internally but exported unnecessarily; others are used only by tests.

The `knip` config uses tests as entries (`knip.json:3`) and project as `src/**/*.ts` (`knip.json:4`). That catches some unused exports, but it also normalizes "exported for tests" as acceptable API surface. Production dead code can hide behind tests importing internals.

Delete/simplify:

- Stop exporting functions only tests need. Test through public module behavior or colocate non-exported helper tests through smaller modules.
- Run a product-entry dead-code pass from `src/cli.ts`, not just test entries.
- Delete exported types that exist only as design-doc residue.

### 11. The capability-budget module is mostly documentation-as-code

`capability-budget.ts` declares a budget table with exact "added calls" and "added dollars" (`src/core/capability-budget.ts:57`) and says tests enforce that no future feature adds a second blocking call (`src/core/capability-budget.ts:51`). But this does not actually meter the turn pipeline. It is manually maintained data plus a shed function. The real added calls are spread through recap generation (`src/interface/menu.ts:3515`), route classifier (`src/interface/menu.ts:4406`), intent extractor (`src/interface/menu.ts:4422`), panel, hedge, review, and provider retries.

The module creates a false sense of governance. A table saying "1 blocking call" does not prove the orchestration path only added one blocking call.

Delete/simplify:

- Replace the static budget table with instrumentation around actual model-call sites.
- Track per-turn added calls at runtime in tests.
- Delete `addedDollars: 0`; it is product positioning, not engineering control.

### 12. Surface capability matrix is process ceremony

`surface-capabilities.ts` maintains a matrix so menu and REPL divergence is explicit (`src/core/surface-capabilities.ts:1`). It is mostly documentation and guard tests. The REPL uses `replCapabilities()` in `cli.ts` (`src/cli.ts:631`), but the matrix is not the real architecture boundary. The actual capabilities are determined by `OrchestrateDeps` assembly and what the UI can render.

Delete/simplify:

- Replace with direct feature flags in the two builders.
- Keep a short doc if needed. Do not keep a code matrix unless it directly drives behavior.

### 13. Provider registry still registers installed-but-unauthenticated providers

`buildProviders` registers providers when installed, not authenticated (`src/providers/registry.ts:5`, `src/providers/registry.ts:36`). The comment says auth is known at call time (`src/providers/registry.ts:6`). Later layers compensate by passing `authenticatedProviders` into route and failover. This is another example of work pushed downstream.

Delete/simplify:

- Build two maps: installed adapters and runnable authenticated adapters.
- Route only over runnable providers. Keep installed-only state for UI/login, not execution.

## LOW

### 14. Comment volume is masking design churn

Many modules are dominated by design-history comments: "Stage 1", "Stage 3", "AP2-F", "byte-for-byte unchanged", "fail-soft", "never bypass" (`src/core/turn-directive.ts:1`, `src/core/vision-triage.ts:1`, `src/core/model-capability-refresh.ts:1`, `src/interface/menu.ts:3533`). The comments are not wrong, but they read like migration notes embedded permanently in code.

Delete/simplify:

- Move stage history into docs.
- Keep comments that explain current invariants only.
- Delete repeated "no model call/no I/O/no bypass" boilerplate once architecture is enforced by types and tests.

### 15. Design docs outnumber stabilized architecture

There are docs for parallel goals, provider capability utilization, model registry, adaptive partner v2, codebase awareness, memory, intent engine, and more. The implementation contains matching stage labels. This indicates a roadmap-first codebase where design documents are becoming implementation scaffolding rather than being retired into simpler architecture.

Delete/simplify:

- Mark speculative docs as archived or obsolete.
- Keep one current architecture doc for routing/turn lifecycle.
- Delete design references from code comments after implementation stabilizes.

## What Should Be Deleted First

1. Delete one concurrency path: `hedge` or `panel`. Keeping both default-off paths is unjustifiable.
2. Delete or fold `vision-triage.ts` into the turn-plan compiler. It overlaps with intent forks and engagement actions.
3. Delete provider-native capability self-awareness until myshell invokes those features.
4. Delete exported-for-test helper APIs reported by `knip`; make them internal after decomposition.
5. Delete the static capability budget table or replace it with actual per-turn call accounting.
6. Delete duplicate work-state derivation; render directly from `WorkContract`.

## What Should Be Simplified First

1. Create a single `TurnPlan` compiler that owns ask/investigate/plan/recommend/escalate-prep decisions.
2. Make `orchestrate.ts` a runner, not a planner.
3. Move `OrchestrateDeps` assembly out of `menu.ts`.
4. Collapse routing to fewer layers: static/model classifier + policy gate + capability hard requirements. Remove learned/model-outcome tie-breaks until proven.
5. Replace fake-heavy mega-tests with fewer integration tests against fake provider binaries and real process boundaries.

## Bottom Line

This is heading for trouble. The codebase is not yet unmaintainable, but it is on the wrong side of the complexity curve: too many default-off features, too many overlapping planners, too many regex policy engines, too much UI-owned orchestration assembly, and too much confidence from fake-heavy tests. A new engineer could learn it, but they would be learning sediment, not architecture. Without deletion and consolidation, the next fast feature cycle will turn this from complicated into fragile.
