# DEDRIFT EXECUTION PLAN

Date: 2026-07-03

Scope: current `src/` inventory only. `rg -o "MYSHELL_[A-Z0-9_]+" src` returns 54 distinct tokens. The panel/nav flags are gone from `src/` and are not part of this plan.

Owner principle: default-on product behavior is not drift. `src/interface/ui/experimental-default.ts` intentionally makes several low-level default-false helpers behave as shipped-on product paths at the composition root, with only explicit opt-out and `MYSHELL_BASIC` as escape hatches. The dedrift goal is therefore not "turn experiments on"; it is to remove permanent alternate off paths. A feature is either always on because it is the product, or removed.

Counts:

- A. KEEP-RUNTIME: 17
- B. DELETE-NOW-SAFE: 20
- C. REMOVE-DEAD: 5
- D. VALIDATE-FIRST: 12
- Unsure: 0

Important ordering correction: a strict B -> C -> D sequence is not mechanically sound for two C items. The four legacy preflight flags must not be deleted until `MYSHELL_SEMANTIC_PREFLIGHT_V1` has passed its validation gate, and `MYSHELL_BASIC` must be deleted last after all per-feature opt-out promotions are complete. The executable order is:

1. Do bucket B first, batched by subsystem.
2. Validate `MYSHELL_SEMANTIC_PREFLIGHT_V1`, then delete the four legacy preflight flags in bucket C.
3. Run the remaining bucket D validation gates and promote/delete each flag only after its gate passes.
4. Delete `MYSHELL_BASIC` last.

## A. KEEP-RUNTIME

These are legitimate runtime, display, install, deployment, process-handoff, or safety protocol controls. Do not dedrift these as product feature flags.

| token | source | reason to keep |
|---|---|---|
| `MYSHELL_CLOUD_WORKSPACE` | `src/infra/state-layout.ts` | External deployment fact that selects cloud workspace state layout / workspace key. Not a feature rollout. |
| `MYSHELL_COMMIT` | `src/cli.ts` | Build provenance fallback when `GITHUB_SHA` is absent. Runtime metadata, not behavior drift. |
| `MYSHELL_DEBUG` | `src/interface/render.ts`, `src/interface/ui/core-event.ts`, UI reducer/state files | Developer diagnostics and verbose classifier/render metadata. Valid runtime debug control. |
| `MYSHELL_INK` | `src/interface/ui/flag.ts`, Ink component comments, `src/infra/config.ts` | Renderer compatibility switch between Ink path and legacy fallback. Keep until the legacy renderer is actually removed. |
| `MYSHELL_LOADED` | `src/commands/install.ts` | Shell autoload recursion guard. Required protocol sentinel for installed shell hooks. |
| `MYSHELL_NIX_STORE_ROOT` | `src/commands/install.ts` | Installer/package location override. External install fact. |
| `MYSHELL_NO_MARKDOWN` | `src/interface/render.ts`, `src/interface/ui/run-stream.ts` | User display preference for raw prose on color TTYs. |
| `MYSHELL_NO_UPDATE` | `src/interface/menu-display.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | User/operator policy to suppress update checks and menu update display. |
| `MYSHELL_OVERSIGHT` | `src/interface/ui/oversight.ts`, `src/infra/config.ts` | Runtime autonomy posture: review-all, checkpoint, autonomous. This is a real operator control. |
| `MYSHELL_PLAIN` | `src/ui/theme.ts`, `src/interface/render.ts`, `src/interface/ui/Stream.tsx` | Compatibility/accessibility output mode that drops structural/color markers. |
| `MYSHELL_ROLLBACK` | `src/core/rollback-flag.ts`, `src/cli.ts`, `src/ui/help.ts`, `src/infra/config.ts` | Emergency no-write / safety rollback for selected surfaces. Keep narrow and documented. |
| `MYSHELL_SKIP` | `src/commands/install.ts` | Per-shell autoload opt-out. Real shell integration control. |
| `MYSHELL_STARTUP_INPUT_B64` | `src/interface/startup-input.ts` | Process restart/self-update input handoff carrier. Internal protocol plumbing. |
| `MYSHELL_THEME` | `src/cli.ts`, `src/ui/theme.ts`, `src/interface/menu-settings.ts`, `src/infra/config.ts` | Runtime display preference bridge for light theme. |
| `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_` | `src/core/untrusted-content.ts` | Regex/pattern fragment for prompt-injection boundary encoding. Not an env flag. |
| `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_BEGIN` | `src/core/untrusted-content.ts` | Fixed untrusted-data begin sentinel. Required safety protocol string. |
| `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_END` | `src/core/untrusted-content.ts` | Fixed untrusted-data end sentinel. Required safety protocol string. |

## B. DELETE-NOW-SAFE

These are already default-on shipped behavior. Deleting the env/config opt-out changes no observable default behavior. It does remove explicit off behavior, which is the desired dedrift. For each item, the helper can be inlined to always-on at its call sites, except `MYSHELL_VERIFY`, `MYSHELL_JUDGMENT`, and `MYSHELL_TRUST`, which should remain always-on unless the kept runtime `MYSHELL_ROLLBACK` is engaged.

### Accounting and Evidence

| flag | current usage | delete work | reasoning |
|---|---|---|---|
| `MYSHELL_ACCOUNT_AUX` | `src/interface/ui/account-aux-flag.ts`; wired in `src/interface/menu.ts`, `src/cli.ts`, `src/interface/preflight-deps.ts`; domain comments in `src/core/aux-ledger.ts`, `src/core/orchestrate.ts` | Delete helper/imports; replace `accountAuxEnabled(process.env)` with `true`; always pass `accountAux`, `intentVersionId`, and ledger correlation plumbing where currently conditional. | Default-on helper already returns true unless explicit off. Auxiliary ledger correlation is product accounting, not a rollout surface. |
| `MYSHELL_CACHE_ACCOUNTING_V2` | `src/interface/ui/cache-accounting-flag.ts`; wired in `src/interface/menu.ts`, `src/cli.ts`, `src/commands/cost.ts`; type comments in `src/core/types.ts` | Delete helper/imports; replace conditional `cacheAccountingV2` spreads with unconditional V2 accounting; update cost command to format V2 unconditionally. | Default-on cache-aware accounting is established and only improves cost accuracy. |
| `MYSHELL_EVIDENCE_RECEIPT_V2` | `src/interface/ui/evidence-receipt-flag.ts`; wired in `src/interface/menu.ts`, `src/cli.ts`; render/type comments | Delete helper/imports; always pass `evidenceReceiptV2`, receipt ledger snapshot, cooldown/session receipt fields when available; remove V1/off comments. | Proof-of-done receipt is default-on evidence plumbing. Removing the off path preserves default behavior. |

### Durable State and Recovery

| flag | current usage | delete work | reasoning |
|---|---|---|---|
| `MYSHELL_INTENT_STORE_V1` | `src/interface/ui/intent-store-flag.ts`; wired in `src/interface/menu.ts`, `src/cli.ts`; domain comments in `src/core/intent-version.ts`, `src/core/orchestrate.ts`, `src/infra/intent-store.ts` | Delete helper/imports; always create/pass intent store at entry points; remove opt-out comments. | Default-on persistence is the spine for correction/recovery. The flag is only an escape hatch now. |
| `MYSHELL_BLOCKED_STATE_V1` | `src/interface/ui/blocked-state-flag.ts`; wired in `src/interface/menu.ts`, `src/cli.ts`; consumed/rendered across blocked, scheduler, goal todo, UI state/render | Delete helper/imports; always pass `blockedState: true` / blocked-state dependencies; remove conditional render language. | Distinct blocked terminal state is already the default honest outcome path. |
| `MYSHELL_CORRECTION_FORK_V1` | `src/interface/ui/correction-fork-flag.ts`; wired in `src/interface/menu.ts` behind intent store; domain comments in correction/goal/intent files | Delete helper/imports; after intent store is unconditional, always enable correction fork deps. | Default-on correction branching is dependent on intent store; promote immediately after `MYSHELL_INTENT_STORE_V1`. |

### Goal and Work Surfaces

| flag | current usage | delete work | reasoning |
|---|---|---|---|
| `MYSHELL_BOARD` | `src/interface/ui/board-flag.ts`; wired in `src/interface/menu.ts`; `experimentalBoard` in `src/infra/config.ts` | Delete helper/imports and `experimentalBoard`; always sync/render persistent board; remove fake-card opt-out path. | Persistent board is shipped-on and the panel/nav work is complete. The hidden off path now recreates UI drift. |
| `MYSHELL_AUTO_GOAL` | `src/interface/ui/auto-goal-flag.ts`; wired in `src/interface/menu.ts`; `experimentalAutoGoal` in config | Delete helper/imports and config opt-out; always run the post-turn parked-goal planning path under its existing internal confidence gates. | Default-on auto-staging creates parked goals only; the opt-out is a vestigial legacy slot. |
| `MYSHELL_DRAFT_GOALS` | `src/interface/ui/draft-goals-flag.ts`; default-on via `experimentalEnabledByDefault` in `src/interface/menu.ts`; `experimentalDraftGoals` in config | Delete helper/imports and config field; replace resolver call with unconditional `draftGoals: true`; keep parked-only materialization rules. | The composition root already ships this on. The low-level pure helper can be inlined to always-on. |
| `MYSHELL_SCHEDULER` | `src/interface/ui/scheduler-flag.ts`; wired in `/goal` scheduler logic in `src/interface/menu.ts`; `experimentalScheduler` in config | Delete helper/imports and config field; remove `schedulerExplicitlyOff`; always use the existing smart scheduler decision. | Scheduler is default-on and already bounded/pressure-aware. Keeping an env-forced sequential path is product drift. |

### Verification, Trust, and Judgment

| flag | current usage | delete work | reasoning |
|---|---|---|---|
| `MYSHELL_VERIFY` | `src/interface/ui/verify-flag.ts`; default-on via resolver in `src/interface/menu.ts`, `src/cli.ts`; scanner mention in `src/core/untrusted-content.ts`; config field | Delete helper/imports and `experimentalVerify`; inject verify port/evidence deps unconditionally unless `MYSHELL_ROLLBACK` is engaged; keep the untrusted-content scanner rule if it remains useful as injection detection text. | Verification is shipped-on. The only legitimate off switch is rollback, not a permanent per-feature opt-out. |
| `MYSHELL_TRUST` | `src/interface/ui/trust-flag.ts`; default-on via resolver in `src/interface/menu.ts`, `src/cli.ts`; config field | Delete helper/imports and `experimentalTrust`; always emit trust surface when signals exist unless rollback is engaged. | Trust receipt is pure composition from real signals and default-on already. |
| `MYSHELL_JUDGMENT` | `src/core/judgment-flag.ts`; default-on via resolver in `src/interface/menu.ts`; config field | Delete helper/imports and `experimentalJudgment`; always provide judgment capability unless rollback is engaged; keep the internal grounded-reason gate. | Judgment is default-on but internally narrow. The env off path is drift; the product guard is the grounded-reason predicate. |
| `MYSHELL_TRULY_COMPLETE` | `src/interface/ui/truly-complete-flag.ts`; wired through goal-completion behavior; `experimentalTrulyComplete` in config | Delete helper/imports and config opt-out; always require evidence-backed done semantics. | Verified-done is the product completion rule. The old model-said-done branch should not survive. |

### Intelligence, Routing, and Sessions

| flag | current usage | delete work | reasoning |
|---|---|---|---|
| `MYSHELL_GOVERNOR` | `src/interface/ui/governor-flag.ts`; default-on via resolver in `src/interface/menu.ts`; `experimentalGovernor` in config | Delete helper/imports and config field; always pass `governorEnabled`, pressure, and budget ceiling inputs. | Governor is shipped-on admission/budget coordination. Existing pressure/budget checks remain the real safety controls. |
| `MYSHELL_AUTO_BRAIN` | `src/interface/ui/auto-brain-flag.ts`; default-on via resolver in `src/interface/preflight-deps.ts`; `experimentalAutoBrain` in config | Delete helper/imports and config field; always compute/pass `autoBrainRungTuple` when preflight deps are built. | Composition root already ships rung fusion on. Pure helper can be inlined to always-on. |
| `MYSHELL_TASTE` | `src/core/taste-flag.ts`; default-on via resolver in `src/interface/menu.ts`; `experimentalTaste` in config and settings toggle | Delete helper/imports, config opt-out, and the settings-level off toggle; always attempt fail-soft taste recall/recording. | Learned taste is no-token, fail-soft, default-on preference memory. A permanent off setting creates another product state. |
| `MYSHELL_UNDERSTANDING` | `src/interface/ui/understanding-flag.ts`; wired in `src/interface/menu.ts`; `experimentalUnderstanding` in config | Delete helper/imports and config opt-out; always run/cache-ahead understanding under existing fail-soft behavior. | This is already default-on and cache-ahead. The opt-out is a legacy branch. |
| `MYSHELL_VENDOR_NEUTRAL_ROUTER` | `src/core/route-types.ts`; wired in `src/interface/menu.ts`, `src/core/understanding-generator.ts`; `experimentalVendorNeutralRouter` config default true | Delete resolver and config opt-out; always use vendor-neutral routing where capability registry exists; remove legacy static-order fallback only after existing provider tests pass. | Router default is already true. The opt-out preserves old routing drift. |
| `MYSHELL_NATIVE_SESSIONS_PROMOTE` | `src/interface/ui/native-sessions-promote-flag.ts`; wired in `src/interface/menu.ts`, `src/cli.ts`, `src/core/work-call.ts`; type comments | Delete helper/imports; treat promotion telemetry as unconditional; preserve `config.nativeSessions` as the real user-facing enablement fact if still needed. | Native session promotion is default-on metadata/telemetry around provider session continuity. |

## C. REMOVE-DEAD

These are not product toggles to promote. Delete the flag and the superseded feature path. Dependency order matters.

| flag | source | remove work | dependency/order |
|---|---|---|---|
| `MYSHELL_UNIFY_PREFLIGHT` | `src/core/router.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Delete `preflightUnifyEnabled`, `experimentalUnifyPreflight`, imports, and `unifyPreflight` dep plumbing. Preserve any proven consolidation behavior only inside semantic preflight. | Remove only after `MYSHELL_SEMANTIC_PREFLIGHT_V1` validation passes. |
| `MYSHELL_RISK_SIGNALS` | `src/core/router.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Delete `preflightRiskSignalsEnabled`, `experimentalRiskSignals`, imports, and `riskSignals` dep plumbing. Fold risk raising into semantic preflight. | Remove with the legacy preflight batch after semantic validation. |
| `MYSHELL_REQUIRED_INVESTIGATION` | `src/core/router.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Delete `preflightRequiredInvestigationEnabled`, `experimentalRequiredInvestigation`, imports, and `requiredInvestigation` dep plumbing. Semantic preflight owns required investigation policy. | Remove with the legacy preflight batch after semantic validation. |
| `MYSHELL_PREFLIGHT_GUARD` | `src/core/router.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Delete `preflightOverheadGuardEnabled`, `experimentalPreflightGuard`, imports, and guard dep plumbing. Keep only a semantic-preflight-internal budget guard if validation proves it is needed. | Remove with the legacy preflight batch after semantic validation. |
| `MYSHELL_BASIC` | `src/interface/ui/experimental-default.ts`, `src/interface/menu.ts`, `src/infra/config.ts`, comments in verify/trust/judgment helpers | Delete `basicModeEnabled`, `BASIC_ON`, `experimentalBasic`, menu/help text, and resolver handling. | Must go last, after B promotions and D validations/promotions, because it currently masks many default-on features. |

## D. VALIDATE-FIRST

These are behavior-risky. Do not promote to unconditional and do not delete the opt-out until the exact validation below passes.

| flag | source | why risky | validation gate |
|---|---|---|---|
| `MYSHELL_SUBSCRIPTIONS` | `src/interface/ui/subscriptions-flag.ts`, `src/interface/menu-render.ts`, account menu paths, `src/infra/config.ts` | Reads subscription/account stores and changes account-aware UI/deps. Privacy, auth, corruption, and no-account behavior matter. | Run account-store canaries covering missing store, corrupt JSON, unauthenticated providers, multiple accounts, and cloud/local state paths. Confirm no secret leakage in rendered account summaries or receipts. Confirm no-account users see identical provider behavior except harmless menu availability. |
| `MYSHELL_ACCOUNT_PARALLELISM` | `src/interface/ui/account-parallelism-flag.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Fan-out can duplicate spend and stress account cooldown/fairness. Also depends on subscriptions. | After subscriptions pass: run live/fake mixed account canaries proving per-account cooldown isolation, no duplicate work submission for a single required answer, fair account selection, graceful fallback with one account, and bounded concurrency under 429 pressure. |
| `MYSHELL_PROVIDER_EFFORT` | `src/providers/provider-effort-flag.ts`, `src/providers/claude.ts`, `src/providers/grok.ts`, `src/providers/registry.ts`, `src/infra/config.ts` | Adds CLI args to Claude/Grok. Bad flags can break provider calls. | Verify current Claude and Grok CLIs accept the emitted effort argv for every supported model/effort combination. Include unsupported-model cases and prove they omit/degrade rather than fail. Keep argv unit tests for off/default and on behavior. |
| `MYSHELL_RESEARCH` | `src/core/research-flag.ts`, `src/interface/menu.ts`, `src/core/brain.ts`, `src/core/orchestrate.ts`, `src/infra/config.ts` | Adds external web research moves with cost, latency, and citation quality risk. | Live canary current-facts tasks across available providers. Require source-bearing summaries, budget shedding under pressure, no web move when local context is enough, timeout/failure fail-soft behavior, and no fabricated citation claims. |
| `MYSHELL_TRIBUNAL` | `src/interface/ui/tribunal-flag.ts`, `src/interface/menu.ts`, `src/core/tribunal.ts`, `src/infra/config.ts` | Multi-provider build-off touches worktrees, latency, cost, and provider availability. It is default-on via resolver today, but the blast radius is high enough to keep the opt-out until live proof exists. | Run load-bearing implementation canaries with at least two authenticated vendors. Prove isolated worktree creation/cleanup, no cross-worktree file bleed, deterministic winner selection from tests/review evidence, graceful fallback with one provider, and bounded latency/cost receipts. |
| `MYSHELL_GOAL_STEWARD` | `src/interface/ui/goal-steward-flag.ts`, `src/interface/menu-goal-review-wiring.ts`, `src/infra/config.ts` | Session/conversation-open audit can be noisy or slow, and can mutate goal review posture. | Measure session-open latency on empty, small, and large goal stores. Prove idempotent audit output, no surprise goal mutation without explicit review action, correct stale/blocked/done classification, and no repeated nagging across launches. |
| `MYSHELL_MANAGER` | `src/interface/ui/manager-flag.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Per-goal manager cycle drives roadmap to-dos and verification. Wrong behavior can loop, over-edit, or block normal goal runs. | End-to-end canaries for explicit goal activation with roadmap, no-roadmap fallback, foreground and background runs, verify passing/failing/unverified outcomes, bounded max iterations, fix-it to-do depth, and interruption/resume behavior. |
| `MYSHELL_ITEM_PARK` | `src/interface/ui/item-park-flag.ts`, `src/interface/menu.ts`, `src/interface/ui/scheduler-flag.ts`, `src/infra/config.ts` | Changes manager-cycle blocked-item semantics from stopping to parking and continuing. Can lose recovery context if wrong. | Manager-cycle canary where one roadmap item blocks, is parked with evidence, later items continue, persisted state survives restart, and the parked item can be resumed/retried without duplicating or dropping to-dos. |
| `MYSHELL_SEMANTIC_PREFLIGHT_V1` | `src/interface/ui/semantic-preflight-flag.ts`, `src/interface/menu.ts`, `src/interface/preflight-deps.ts`, `src/infra/config.ts` | Supersedes route/intent/evidence composition and disables the older granular preflight flags. This is a central turn-routing seam. | End-to-end equivalence suite comparing legacy route+intent vs semantic preflight across simple chat, code edit, high-risk, freshness-required, ambiguous, and no-op turns. Require no lost risk signals, no extra blocking calls beyond budget, correct evidence policy, receipt parity, and explicit proof that it subsumes unify/risk/required-investigation/guard behavior before C deletion. |
| `MYSHELL_PLANNING_DEPTH` | `src/interface/ui/planning-depth-flag.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Adds effort-governed planning depth. Can over-plan small tasks or add latency. | Canaries for tiny, medium, high-risk, and multi-step tasks. Require latency within budget, no extra planning for trivial turns, correct effort/depth selection, and governor budget interaction that sheds optional depth under pressure. |
| `MYSHELL_AUTO_SMART` | `src/interface/ui/auto-smart-flag.ts`, `src/interface/auto-stage.ts`, `src/interface/menu-render.ts`, `src/interface/menu.ts`, `src/infra/config.ts` | Changes absent `config.mode` from fixed plan-derived preset to smart policy. This can alter budget, display, and governor behavior. | Regression suite for absent mode, persisted explicit mode, menu display reason, budget ceilings, provider capacity allocation, and governor pressure. Must prove explicit user mode remains authoritative. |
| `MYSHELL_BYPRODUCT_FALLBACK` | `src/interface/ui/byproduct-fallback-flag.ts`, `src/interface/preflight-deps.ts`, `src/interface/menu.ts`, `src/core/intent-extractor.ts`, `src/core/byproduct-parse.ts`, `src/infra/config.ts` | Text fallback can create false-positive intent/byproduct frames when structured parse fails. | Parse canary corpus with malformed model output, ordinary prose, code blocks, adversarial text, and valid structured frames. Require primary-parse success unchanged, fallback only after primary failure, lower false-positive rate than rules fallback, and no draft/goal side effects from ambiguous prose. |

## Ordered Worklist

### 1. Bucket B, Safe Batches

1. Accounting/evidence batch: `MYSHELL_ACCOUNT_AUX`, `MYSHELL_CACHE_ACCOUNTING_V2`, `MYSHELL_EVIDENCE_RECEIPT_V2`.
2. Durable state/recovery batch: `MYSHELL_INTENT_STORE_V1`, `MYSHELL_BLOCKED_STATE_V1`, then `MYSHELL_CORRECTION_FORK_V1`.
3. Goal/work surface batch: `MYSHELL_BOARD`, `MYSHELL_AUTO_GOAL`, `MYSHELL_DRAFT_GOALS`, `MYSHELL_SCHEDULER`.
4. Verification/trust/judgment batch: `MYSHELL_VERIFY`, `MYSHELL_TRUST`, `MYSHELL_JUDGMENT`, `MYSHELL_TRULY_COMPLETE`. Keep `MYSHELL_ROLLBACK` behavior for verify/trust/judgment.
5. Intelligence/routing batch: `MYSHELL_GOVERNOR`, `MYSHELL_AUTO_BRAIN`, `MYSHELL_TASTE`, `MYSHELL_UNDERSTANDING`, `MYSHELL_VENDOR_NEUTRAL_ROUTER`.
6. Session continuity batch: `MYSHELL_NATIVE_SESSIONS_PROMOTE`.

Verification for each B batch: run the existing unit/architecture suite, plus targeted smoke for the touched subsystem. The assertion is default-behavior preservation with the env/config absent, not preservation of explicit-off behavior.

### 2. Preflight Dead-Flag Removal

Prerequisite: `MYSHELL_SEMANTIC_PREFLIGHT_V1` validation gate passes.

Then delete, as one preflight cleanup batch:

1. `MYSHELL_UNIFY_PREFLIGHT`
2. `MYSHELL_RISK_SIGNALS`
3. `MYSHELL_REQUIRED_INVESTIGATION`
4. `MYSHELL_PREFLIGHT_GUARD`

Do not leave compatibility aliases. If semantic preflight needs a budget guard or risk floor, make that internal semantic-preflight policy, not a separate env flag.

### 3. Bucket D Promotion Gates

Run and promote one gate at a time:

1. `MYSHELL_SUBSCRIPTIONS`
2. `MYSHELL_ACCOUNT_PARALLELISM` after subscriptions
3. `MYSHELL_PROVIDER_EFFORT`
4. `MYSHELL_RESEARCH`
5. `MYSHELL_TRIBUNAL`
6. `MYSHELL_GOAL_STEWARD`
7. `MYSHELL_MANAGER`
8. `MYSHELL_ITEM_PARK` after manager-cycle validation
9. `MYSHELL_SEMANTIC_PREFLIGHT_V1` before the preflight C batch above
10. `MYSHELL_PLANNING_DEPTH`
11. `MYSHELL_AUTO_SMART`
12. `MYSHELL_BYPRODUCT_FALLBACK`

For each, the promotion PR should include the validation receipt or artifact path, then delete the env helper and config field in the same change. Do not convert these into new hidden config toggles.

### 4. Final Global Drift Removal

Delete `MYSHELL_BASIC` last:

- Remove `basicModeEnabled`, `BASIC_ON`, and basic-mode handling from `src/interface/ui/experimental-default.ts`.
- Remove `experimentalBasic` from `src/infra/config.ts`.
- Remove menu/help text advertising `MYSHELL_BASIC`.
- Update comments in verify/trust/judgment helpers if those helpers still exist at that point; otherwise no-op.

After this, the only kept off-style runtime control for intelligence safety should be `MYSHELL_ROLLBACK`, scoped to emergency rollback rather than permanent product drift.
