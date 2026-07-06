# Vision Alignment Audit - 2026-07-06

## Part 1 - PR #99 Adjudication

Range audited: `git diff 2574030 905492b`, current `main` at `ee2029e`.

Commands run:

- `npx vitest run test/unit/durable-context.test.ts test/unit/accept-finalize.test.ts test/unit/durable-prompt-seam.test.ts test/unit/repo-map.test.ts` -> PASS, 4 files / 59 tests.
- `npm run build` -> PASS.
- `MYSHELL_COMPLETION_RESULT_V1=1 node dist/cli.js --help` -> starts, but only prints help. It proves no crash, not runtime completion binding.
- `node -e "import('./dist/infra/config.js')..."` after build prints `{}` for completion-result config fields: no default, no env parsing, no config mirror exists.

### 1A. Flag Default And Flag-Off Behavior

Verdict: PARTIAL.

Evidence:

- `src/infra/config.ts:34-404` defines `AppConfig`. There is no `experimentalCompletionResultV1` field.
- `src/infra/config.ts:410-422` defines `DEFAULTS`; no completion flag appears. Therefore the effective default is absent/false.
- `src/core/types.ts:378-383` documents `completionResultV1?: boolean` as dark/default false on `OrchestrateDeps`.
- `src/core/accept-stage.ts:483-489` attaches `completionResult` only when `deps.completionResultV1 === true`; false/undefined returns `{ final }`.
- `test/unit/accept-finalize.test.ts:15-21` covers injected false/undefined at the pure seam.

But the anti-drift claim "flag-off = byte-identical legacy behavior" is overstated:

- `src/cli.ts:219` changed user-facing help text to claim "durable map context + CompletionResultV1" even when the feature is not wired.
- `src/interface/menu.ts:742-744` changed comments only, no behavior.
- `src/core/orchestrate.ts:1918-1920` calls `makeCompletionResultEvent(...)` on the no-provider path and discards the result. This is behavior-neutral today, but it is unconditional dead code and not a real event append.

Conclusion: runtime final-event shape remains gated in accept-stage, but PR #99 did not implement the documented env/config flag, and it changed visible help text to advertise dark/unreachable capability.

### 1B. Flag-On Runtime Path

Verdict: THEATER for normal CLI/TUI runtime.

Trace:

- `src/cli.ts:885-889` checks `(config as { completionResultV1?: boolean }).completionResultV1`, not `MYSHELL_COMPLETION_RESULT_V1` and not `experimentalCompletionResultV1`. If true, it calls `buildEnvironmentContextFromRecon(null, [])` and discards the empty result.
- `src/cli.ts:943-970` composes preflight deps and builds `depsWithPreflight`; no `completionResultV1` is added.
- `src/interface/menu.ts:2398-2419` composes preflight deps for chat.
- `src/interface/menu.ts:2421-2555` returns the rich `OrchestrateDeps`; it includes receipts, native sessions, semantic preflight, unify/risk/required investigation, learned order, memory/taste, etc., but no `completionResultV1`.
- `rg` finds no `MYSHELL_COMPLETION_RESULT_V1` implementation outside comments/tests/docs.
- `src/interface/preflight-deps.ts:114-167` properly wires semantic preflight from env/config; there is no equivalent completion-result flag helper.

So the named flag cannot turn the feature on through the normal entry points. A direct test can inject `deps.completionResultV1: true`, but users cannot enable it with the documented env var.

### 1C. Component Verdicts

| Component | Verdict | Evidence |
|---|---:|---|
| Config / flag resolver | THEATER | No `experimentalCompletionResultV1` in `src/infra/config.ts:34-404`; no default in `src/infra/config.ts:410-422`; no env parser for `MYSHELL_COMPLETION_RESULT_V1`. |
| CLI one-shot wiring | THEATER | `src/cli.ts:885-889` checks a non-schema `config.completionResultV1`, calls recon with `null`, discards result; `src/cli.ts:943-1007` never adds `completionResultV1` to deps. |
| Menu/chat wiring | THEATER | `src/interface/menu.ts:2421-2555` rich deps object has no `completionResultV1`; `src/interface/menu.ts:6084-6117` sends those deps into `orchestrate`. |
| Durable context pure substrate | PARTIAL/REAL | Real pure constructors/hash/validators exist: `src/core/durable-context.ts:181-219`, `223-258`, `277-314`. Env snapshot/recon exists at `src/core/durable-context.ts:343-475`. But file header admits no storage/runtime callers at `src/core/durable-context.ts:4-6`; reconstruction has placeholder blocks at `src/core/durable-context.ts:425-436`; `makeCompletionResultEvent` is a stub at `src/core/durable-context.ts:491-494`. |
| CompletionResultV1 type shape | PARTIAL | Types are real at `src/core/types.ts:1345-1518`. But they are only additive structure, not single terminal truth in runtime. |
| CompletionResultV1 construction/accept binding | PARTIAL | `src/core/accept-stage.ts:474-553` can build and attach a result when deps are injected. It is skeletal: `evaluateDeliveryQualitySkeleton` only checks empty output at `src/core/accept-stage.ts:413-429`; orientation is hard-coded empty at `src/core/accept-stage.ts:522`; worktree baseline is guessed from verify paths at `src/core/accept-stage.ts:432-445`. |
| Patch apply layer | THEATER/RISK | `src/core/patch-apply.ts:79-105` captures git diff; `src/core/patch-apply.ts:141-164` re-applies a patch to the same cwd after worktree validation; `src/core/patch-apply.ts:169-177` commits. `src/core/accept-stage.ts:563-570` fires this asynchronously and swallows errors. On already-applied provider edits it usually fails/no-ops; if ever reachable it is unsafe policy for a hidden completion flag. |
| Repo-map symbols | REAL | `src/core/repo-map.ts:220-260` extracts symbols; `src/core/repo-map.ts:311-328` preserves path-only ranking shape when symbols absent; `src/core/repo-map.ts:516-545` renders symbols when available; `src/core/repo-map.ts:683-697` extracts from read source files. Tests passed. |
| History reconstruction hook | PARTIAL/THEATER | `src/core/history.ts:284-296` fabricates an environment snapshot with empty `stateHash`, fixed ids, and no persistence. Useful compatibility helper, not durable history. |
| Orchestrate hook | THEATER | `src/core/orchestrate.ts:1918-1920` constructs a fake completion event on the no-provider path and discards it. No append, no durable log, no final binding. |
| Tests | PARTIAL | Focused tests pass. But `test/unit/accept-finalize.test.ts:23-54` injects deps directly, bypassing real config/CLI/menu wiring. `test/unit/durable-context.test.ts:122-183` exercises pure reconstruction from synthetic snapshots, not runtime gather -> durable append -> recon. |
| Receipts/docs | OVERCLAIM | `docs/receipts/phase2-r717-completion-map-binding.md:77-83` claims no cli/menu/default edits and durable event/snapshot binding; actual PR did edit `cli.ts` and `menu.ts`, and runtime binding is not live. |

### Part-1 Verdict

Overall verdict for #99: HARDEN, not keep-as-is.

Do not treat #99 as shipped durable completion. It is a mixed PR: keep the real repo-map symbol work and the pure durable/type scaffolding if they are useful, but harden before any default flip or product claim.

Required hardening:

1. Remove `%TMPF%` from repo root.
2. Remove or correct the help text in `src/cli.ts:219`; it currently advertises unshipped behavior.
3. Add a real `completionResultV1Enabled()` resolver for `MYSHELL_COMPLETION_RESULT_V1` plus `experimentalCompletionResultV1?: boolean`.
4. Wire `completionResultV1: true` through both CLI and menu deps when explicitly enabled.
5. Delete the `buildEnvironmentContextFromRecon(null, [])` void call; replace with actual snapshot creation from the existing repo-map facts or no code.
6. Emit exactly one real terminal completion result from all foreground terminal paths, including no-provider, success, failed, cancelled, needs-user, panel, hedge, and goal paths.
7. Persist durable events/snapshots in a real append/read store, then reconstruct from that store. Pure synthetic snapshots are not enough.
8. Remove `attachCompletionIfFlag`'s fire-and-forget patch auto-apply/commit or put it behind explicit user acceptance and awaited error handling. Completion truth must not secretly mutate git.
9. Add integration tests that enable the real env flag through CLI/menu composition and assert final events contain `completionResult` and durable reconstruction uses a non-null snapshot.

If those hardening steps are not desired, revert the completion/durable portions of #99 and keep only repo-map symbol changes.

## Part 2 - Vision Alignment

Current shipped reality: about 55-60% of the "one chat to rule them all" vision is real in code, depending on whether default-off/gated features count. Counting only default-on, user-visible behavior, I would call it closer to 45-50%.

Real shipped strengths:

- Multi-provider substrate exists: Claude/Codex/OpenCode/Grok detection and provider adapters.
- Interactive menu/workspace UX from the 12-slice build is real and recently verified.
- Routing is non-trivial: deterministic tiering, authenticated-provider preference, capability-aware selection, vendor-neutral routing in interactive, reasoning-effort selection, learned success/latency ordering, and subscription-account selection exist. `docs/product-routing-grounding.md:126-138`.
- Verify/evidence/trust machinery is real in sequential paths, with honest non-green states.
- Memory, repo-map, tool-state, work-state, rules, goals, auto-stage, and conversation stores are real enough to matter.

Stubbed/gated/missing:

- CompletionResultV1 is not the terminal truth. #99 made scaffolding, not runtime authority.
- Durable provider-neutral context is not a real append/read/reconstruct runtime store.
- Exactly-once execution/resume and durable multi-goal DAG are not live.
- CLI and menu still diverge materially. Prior audit names unified deps builder as a critical gap at `docs/10of10-plan.md:57`.
- Context architecture is heavy and flat, not curated per goal/lane. `docs/10of10-plan.md:39,59`.
- Goal completion is partial: goal planner/manager pieces exist, but JIT decomposition, lifecycle reconciliation, and evidence-bound goal settlement are not coherent. `docs/10of10-plan.md:41,58`.
- Ghost text/chat completion is unbuilt. `docs/10of10-plan.md:48,60,143-154`.
- Product routing optimizer is not implemented: current routing is smart, but not "cheapest candidate that clears a task-specific quality bar." `docs/product-routing-grounding.md:140-156`.
- Semantic preflight, subscriptions, and goal steward are real gated paths, not promoted product defaults.
- The docs still overclaim. `docs/ROADMAP-STATUS.md:30` says r7 contracts had no implementation as of 2026-07-02; #99 partially changes that but receipts overstate runtime completeness.

Biggest gaps to "one chat to rule them all":

1. One terminal truth: real CompletionResultV1 across every terminal path.
2. One durable context/work log: append-only events, snapshots, replay, invalidation, and reconstruction used by both CLI and menu.
3. One dependency builder: no product split between one-shot and interactive.
4. One routing objective: task-quality threshold plus cost/quota optimization, using existing capability/routing memory/pricing.
5. One goal lifecycle: goal skeleton -> JIT todos -> execution -> verification -> durable settlement.
6. One chat UX: compact goal state, board heartbeat, local-first ghost text, clear bg/fg execution state.
7. One flag policy: validate/promote or cut remaining dark flags, no permanent shadow product.

## Part 3 - Consolidated Roadmap

| Priority | Item | Keep/Fix/Cut | Effort | Dependencies | Notes |
|---:|---|---|---:|---|---|
| P0 | Remove `%TMPF%` | Fix | XS | none | Junk file committed to main; content is an ad hoc repo-map smoke. Delete. |
| P0 | Correct #99 claims/help text | Fix | XS | none | Remove "durable map context + CompletionResultV1" from help until runtime true. |
| P0 | CompletionResultV1 hardening | Fix | M-L | accept-stage, cli/menu deps, render tests | Implement real flag resolver/config, wire both surfaces, exact-one terminal result for all foreground paths, no hidden patch apply. |
| P0 | Durable context runtime store | Fix | L | CompletionResultV1 terminal events | Append/read durable events and snapshots under state dir/conversation; reconstruct prompts from persisted state, not synthetic/null snapshots. |
| P0 | Shared deps builder | Fix | L | flag policy, menu/cli parity | Create shared dependency assembly so CLI and menu do not drift. This is prerequisite for credible routing/completion tests. |
| P1 | Validate `SEMANTIC_PREFLIGHT_V1` | Keep if validation passes | M | shared deps builder | Run route/intent/evidence equivalence suite across simple chat, code edit, high-risk, freshness, ambiguous, no-op. Promote only if no lost risk signals and no call-budget regression; otherwise cut and keep legacy preflight. |
| P1 | Validate `SUBSCRIPTIONS` | Keep if validation passes | M | account fixtures | Test corrupt stores, no-account fallback, privacy/no-secret rendering, account isolation, 429 cooldown. Promote only if account routing is stable. |
| P1 | Validate `GOAL_STEWARD` | Keep if low-noise | S-M | goal store fixtures | Test startup latency, idempotence, no surprise mutation, no repeated nagging. If noisy, keep manual `/goals audit` and cut session-open prompt. |
| P1 | Product routing optimizer | Keep/fix | L | shared deps builder, semantic preflight optional, pricing/capability registry | Enhance vendor-neutral route to choose cheapest candidate that clears a task-specific quality bar. Use existing capabilities, pricing, routing memory, cooldown, auth, subscriptions. Do not create a second router. |
| P1 | Routing explanation/receipts | Keep | M | routing optimizer | Add concise per-turn reason: quality bar, chosen candidate, cheaper rejected candidates, capability constraints. This is needed to make optimizer trustable. |
| P1 | Goal lifecycle chain | Fix | XL | durable context, CompletionResultV1 | Wire goal skeleton -> JIT decomposition -> manager todos -> verify evidence -> durable settlement. This is the real "living plans" path. |
| P2 | Chat UX compact goal/menu state | Keep | M | goal lifecycle minimally stable | Collapse parked-goal clutter, make board/goal state readable, expose running fg/bg state. |
| P2 | Ghost text local-first | Keep | M | chat input seams | Implement history/slash/path/recent cache completions first. No model calls initially. |
| P2 | Ghost text model fallback | Keep later | M-L | local ghost, routing optimizer | Add tiny model fallback only after local ghost is proven; budgeted and disableable. |
| P2 | Background execution + durable resume | Keep | L-XL | durable store, exactly-once | Needed for "one chat" at professional scale. Should bind to durable work ids, not loose async jobs. |
| P3 | Grok audit ideas: context bloat and docs-to-code fidelity | Keep | S-M ongoing | none | The valuable part is the adversarial inventory: central-file bloat, docs overclaiming, default-off drift. Keep as acceptance criteria. |
| P3 | Grok audit ideas: broad new architecture names / speculative phases | Cut | n/a | none | Do not add more named layers until CompletionResultV1 + durable store + shared deps are real. |

Sequencing rule: do not promote more defaults until P0 is done. The product has enough dark machinery; the next work should reduce drift, not add more.
