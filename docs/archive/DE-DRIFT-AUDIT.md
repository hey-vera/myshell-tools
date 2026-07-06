# DE-DRIFT AUDIT

Date: 2026-07-03

Scope: `rg -o "MYSHELL_[A-Z0-9_]+" src` found **59 distinct `MYSHELL_*` tokens** in `src/`. Of those, **56 are actionable environment/config/runtime flags**. The remaining 3 are protocol boundary strings in `src/core/untrusted-content.ts`, not environment flags:

- `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_`
- `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_BEGIN`
- `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_END`

Verdict totals for the 56 actionable flags:

- **PROMOTE:** 32
- **REMOVE:** 10
- **KEEP-RUNTIME:** 14

Audit principle: no feature stays permanently hidden behind an env flag. A product feature either becomes the unconditional product path and the flag is deleted, or the feature and flag are removed. `KEEP-RUNTIME` is reserved for true runtime/user/operator controls, shell integration protocol, or external environment facts.

## Flag Inventory

| flag | current default | what it gates | verdict | one-line vision justification | risk/effort to execute |
|---|---:|---|---|---|---|
| `MYSHELL_ACCOUNT_AUX` | on unless explicit off | Auxiliary-model ledger accounting and intent-version correlation. | PROMOTE | Cost/evidence accounting is part of coherent multi-provider work, not an experiment. | Low: delete resolver/env checks and keep ledger fields unconditional. |
| `MYSHELL_ACCOUNT_PARALLELISM` | off; also requires subscriptions | Account-level hedge/fan-out when subscription accounts exist. | PROMOTE | High-performance provider use should exploit real account capacity when available. | High: validate account cooldown, duplicate spend, and fairness behavior before promotion. |
| `MYSHELL_AUTO_BRAIN` | effectively on at composition root; low helper defaults off | Per-turn rung fusion and objective-evidence escalation. | PROMOTE | The chat should choose effort intelligently without env flipping. | Medium: remove resolver indirection; preserve rollback/basic removal order. |
| `MYSHELL_AUTO_GOAL` | on unless explicit off | Post-turn goal planner/auto-stage into parked goals. | PROMOTE | Goal creation is central to one coherent work chat. | Medium: confirm no over-trigger regressions; then delete opt-out path. |
| `MYSHELL_AUTO_SMART` | off | Absent `config.mode` becomes a smart auto policy instead of fixed plan-derived preset. | PROMOTE | A single chat should default to adaptive firepower, not require a hidden env. | Medium: validate mode display, budget ceilings, and governor interaction. |
| `MYSHELL_BASIC` | off | Global escape hatch that disables many intelligence subsystems. | REMOVE | A permanent all-off product mode recreates drift; use specific runtime controls or rollback only. | Medium-high: remove from `experimentalEnabledByDefault`, migrate docs/help, ensure no tests depend on all-off semantics. |
| `MYSHELL_BLOCKED_STATE_V1` | on unless explicit off | Distinct blocked terminal state instead of treating blocked as failed. | PROMOTE | Honest blocked outcomes are required for goal stewardship and coherent recovery. | Low: delete flag resolver and wire blocked state unconditionally. |
| `MYSHELL_BOARD` | on unless explicit off | Persistent goal board and suppression of fake per-turn goal card. | PROMOTE | The product vision needs durable visible work state. | Low-medium: promote with Ink board path; remove legacy fake-card toggle. |
| `MYSHELL_BYPRODUCT_FALLBACK` | off | Text fallback when structured intent/byproduct parsing returns nothing. | PROMOTE | Intent extraction should fail soft inside the product, not behind a hidden lever. | Medium: validate false-positive rate before removing the gate. |
| `MYSHELL_CACHE_ACCOUNTING_V2` | on unless explicit off | Cache-aware effective cost accounting. | PROMOTE | Accurate cost/evidence is core provider hygiene. | Low: make V2 accounting the only path. |
| `MYSHELL_CLOUD_WORKSPACE` | off unless env present | Cloud workspace state-layout detection and workspace key override. | KEEP-RUNTIME | This is an external deployment fact, not feature scaffolding. | Low: keep, document as deployment/runtime contract. |
| `MYSHELL_COMMIT` | unset fallback | Commit/version metadata fallback when `GITHUB_SHA` is absent. | KEEP-RUNTIME | Build provenance is runtime metadata, not a product feature gate. | Low: keep or rename only if build pipeline changes. |
| `MYSHELL_CONTROL_PANEL` | off | Fullscreen Ink control panel and keybindings. | REMOVE | A hidden panel fragments the one-chat UX unless it becomes the main shipped surface. | Medium: delete panel gate and dead UI if not selected as primary UX. |
| `MYSHELL_CORRECTION_FORK_V1` | on unless explicit off; requires intent store | Correction detection, child intent versions, and superseding invalid descendants. | PROMOTE | Correction-fork is explicitly in the vision for coherent recovery. | Medium: promote after intent-store promotion; keep dependency ordering. |
| `MYSHELL_DEBUG` | off | Debug/classifier metadata and verbose render details. | KEEP-RUNTIME | Developer diagnostics are legitimate runtime controls. | Low: keep; ensure it never gates product behavior. |
| `MYSHELL_DRAFT_GOALS` | effectively on via default-on resolver | Draft goal skeleton materialization from intent frames. | PROMOTE | Goal capture from chat is core, as long as parked/non-destructive. | Medium: validate duplicate goal suppression and delete resolver. |
| `MYSHELL_EVIDENCE_RECEIPT_V2` | on unless explicit off | Proof-of-done evidence receipt from ledger/session data. | PROMOTE | Evidence is part of the product contract, not optional scaffolding. | Low-medium: make receipt V2 unconditional and remove V1/off branches. |
| `MYSHELL_GOAL_STEWARD` | off | Deterministic goal audit at session/conversation open. | PROMOTE | Goal-steward is named in the vision and should not be dark. | Medium-high: validate session-open latency and noisy audit behavior first. |
| `MYSHELL_GOALS_PANEL` | off | Fullscreen goals panel and keybindings. | REMOVE | Persistent board plus chat should be the coherent goal surface; hidden alternate panels add drift. | Medium: remove panel code or fold useful affordances into the main board. |
| `MYSHELL_GOVERNOR` | effectively on via default-on resolver | Performance governor, pressure, budget ceiling, and admission coordination. | PROMOTE | High-performance chat needs automatic budget and pressure governance. | Medium: delete flag while preserving conservative pressure behavior. |
| `MYSHELL_INK` | on unless explicit off | Ink chat UI vs. legacy render/menu fallback. | KEEP-RUNTIME | Renderer selection is a legitimate runtime compatibility toggle. | Low-medium: keep as renderer fallback until legacy path is gone. |
| `MYSHELL_INTENT_STORE_V1` | on unless explicit off | Intent-version persistence. | PROMOTE | Durable intent continuity is central to coherent work and correction-fork. | Medium: promote before correction-fork; verify migration/cleanup semantics. |
| `MYSHELL_ITEM_PARK` | off | Per-item park-and-continue behavior in manager-cycle forks. | PROMOTE | A goal cycle should park one blocked item and continue useful work. | Medium-high: validate roadmap mutation and blocked-item recovery before promotion. |
| `MYSHELL_JUDGMENT` | effectively on via default-on resolver | Push-back/judgment layer and ask-vs-proceed calibration. | PROMOTE | Judgment is a core partner behavior for avoiding bad work. | Medium: promote while retaining narrow grounded-reason gates. |
| `MYSHELL_LEVEL_DIAL` | off | Five-level firepower profile scaffold. | REMOVE | The code comments say orchestrate does not consume it; scaffold-only flags should be deleted. | Medium: remove resolver/types or finish as product config in a separate design. |
| `MYSHELL_LOADED` | set by shell integration | Autoload recursion guard. | KEEP-RUNTIME | Shell integration needs a runtime sentinel to avoid repeated launch loops. | Low: keep as shell protocol. |
| `MYSHELL_MANAGER` | on unless explicit off | Per-goal manager cycle driving roadmap to-dos and verification. | PROMOTE | Manager-driven to-do execution is core goal stewardship. | Medium-high: delete opt-out after validating foreground/background goal runs. |
| `MYSHELL_NATIVE_SESSIONS_PROMOTE` | on unless explicit off | Native session promotion/telemetry and effective native-session enablement. | PROMOTE | Provider session continuity supports one coherent chat across tools. | Medium: validate provider-specific session behavior; promote telemetry path. |
| `MYSHELL_NIX_STORE_ROOT` | unset | Installer override for Nix store root. | KEEP-RUNTIME | Packaging/install location is an external runtime/install fact. | Low: keep; document as installer override. |
| `MYSHELL_NO_MARKDOWN` | markdown on unless set | Disables markdown rendering on color TTY. | KEEP-RUNTIME | Output-format preference is a legitimate runtime display toggle. | Low: keep. |
| `MYSHELL_NO_UPDATE` | updates allowed unless set | Disables update checks/menu display. | KEEP-RUNTIME | Update policy is a user/operator runtime choice. | Low: keep. |
| `MYSHELL_OVERSIGHT` | `checkpoint` | Runtime autonomy level: review-all, checkpoint, autonomous. | KEEP-RUNTIME | Execution autonomy is a real user preference, not dev scaffolding. | Low: keep and expose via settings/docs. |
| `MYSHELL_PARALLEL` | alias only for scheduler explicit-off | Legacy alias for scheduler/parallel behavior. | REMOVE | Alias flags multiply product states without adding a user-facing concept. | Low: remove after checking docs/scripts for usage. |
| `MYSHELL_PLAIN` | off | Plain output mode, drops structural markers/colors. | KEEP-RUNTIME | Plain rendering is a valid runtime compatibility/accessibility mode. | Low: keep. |
| `MYSHELL_PLANNING_DEPTH` | off | Effort-governed preflight planning depth. | PROMOTE | Planning depth should be selected by task/governor, not a hidden flag. | Medium-high: validate latency and effort choices before unconditional use. |
| `MYSHELL_PREFLIGHT_GUARD` | off; disabled when semantic preflight is on | Aggregate preflight-overhead guard. | REMOVE | Standalone rank-10 guard is superseded by the semantic preflight path. | Medium: fold useful budget guard into promoted semantic preflight, then delete flag. |
| `MYSHELL_PROVIDER_EFFORT` | off | Threads normalized reasoning effort into Claude/Grok CLI args. | PROMOTE | Provider capability utilization is core to high-performance provider routing. | Medium-high: validate current Claude/Grok CLI flags and error behavior first. |
| `MYSHELL_REQUIRED_INVESTIGATION` | off; disabled when semantic preflight is on | Enforced local-investigation directive before execution. | REMOVE | Keep investigation as semantic-preflight policy, not a separate permanent env gate. | Medium: migrate behavior into semantic preflight validation suite. |
| `MYSHELL_RESEARCH` | off | Second-angle web research move in research-until-confident. | PROMOTE | Current external facts should be invoked by task semantics, not env. | High: validate provider web-search support, cost/latency budget, and citation quality. |
| `MYSHELL_RISK_SIGNALS` | off; disabled when semantic preflight is on | Intent-derived risk/blast-radius/freshness hints. | REMOVE | Risk signals belong inside the promoted semantic preflight frame. | Medium: fold into semantic preflight and delete standalone flag. |
| `MYSHELL_ROLES` | off | Logical role mapping scaffold for chat/ghost/execution. | REMOVE | Comments state orchestrate does not consume it; scaffold-only role substrate is drift. | Medium: delete or replace with real provider registry product work. |
| `MYSHELL_ROLLBACK` | off | Emergency rollback kill-switch for selected intelligence surfaces/no-write form. | KEEP-RUNTIME | Operational rollback is a legitimate emergency runtime control, not a feature default-off. | Low-medium: keep narrow, documented, and avoid adding new feature semantics. |
| `MYSHELL_SCHEDULER` | on unless explicit off | Bounded concurrent multi-goal scheduler and explicit sequential override. | PROMOTE | Goal execution should automatically parallelize when safe. | Medium: remove flag while preserving internal smart/sequential decision logic. |
| `MYSHELL_SEMANTIC_PREFLIGHT_V1` | off | Semantic preflight ownership of route/intent/evidence path. | PROMOTE | Semantic preflight is explicitly in the vision and should become the one path. | High: validate before promotion; it conflicts with older preflight flags. |
| `MYSHELL_SKIP` | off unless user sets | Autoload opt-out in installed shell hooks. | KEEP-RUNTIME | Shell autoload opt-out is a real runtime user control. | Low: keep. |
| `MYSHELL_STARTUP_INPUT_B64` | unset; consumed/deleted at startup | Self-update/restart startup input handoff. | KEEP-RUNTIME | Process handoff protocol is runtime plumbing, not feature scaffolding. | Low: keep internal and documented. |
| `MYSHELL_SUBSCRIPTIONS` | off | Subscription/account store reads and account-aware deps. | PROMOTE | Provider/account awareness is part of high-performance one-chat routing. | High: validate account-store corruption, auth privacy, and no-account fallback. |
| `MYSHELL_TASTE` | effectively on via default-on resolver | Learned taste ledger recall/recording. | PROMOTE | User preference learning improves coherent ask-vs-act behavior. | Medium: promote while preserving fail-soft empty-ledger behavior. |
| `MYSHELL_THEME` | derived from config; dark unless light set | Runtime light-theme rendering. | KEEP-RUNTIME | Theme is a legitimate display preference. | Low: keep config-derived env bridge or replace with direct config plumbing later. |
| `MYSHELL_TRIBUNAL` | effectively on via default-on resolver | Rival tribunal cross-vendor build-off. | PROMOTE | For load-bearing implementations, evidence-backed alternative evaluation fits the vision. | High: validate worktree isolation, provider availability, and latency before final promotion. |
| `MYSHELL_TRULY_COMPLETE` | on unless explicit off | Verified-done goal completion gate. | PROMOTE | Goals must close on evidence, not model assertion. | Medium: delete opt-out after validating no-test-project behavior. |
| `MYSHELL_TRUST` | effectively on via default-on resolver | Consolidated trust/confidence receipt. | PROMOTE | Trust/evidence surface is central to coherent developer work. | Medium: promote with verify dependency intact. |
| `MYSHELL_UNDERSTANDING` | on unless explicit off | Whole-picture understanding cache/pass and prompt context. | PROMOTE | Real work needs system understanding before planning and execution. | Medium-high: validate cache latency/staleness and prompt-size pressure. |
| `MYSHELL_UNIFY_PREFLIGHT` | off; disabled when semantic preflight is on | Collapses route classifier into intent extraction on affected turns. | REMOVE | This is an older granular preflight flag superseded by semantic preflight. | Medium: preserve any proven consolidation behavior inside semantic preflight. |
| `MYSHELL_VENDOR_NEUTRAL_ROUTER` | on unless explicit off; config default true | Vendor-neutral routing engine vs. legacy static provider order. | PROMOTE | Provider-neutral routing is foundational for one chat across providers. | Medium: remove legacy fallback after provider regression tests. |
| `MYSHELL_VERIFY` | effectively on via default-on resolver | Verify port, test runner, evidence sink/snapshot, accept-stage verification. | PROMOTE | Verification is core evidence for real developer work. | Medium-high: validate project-shape coverage and command safety before deleting opt-out. |

## Non-env Grep Hits

These are `MYSHELL_*` tokens in `src/`, but they are not env flags and should not be counted in the promote/remove/keep totals.

| token | location | treatment |
|---|---|---|
| `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_` | `src/core/untrusted-content.ts` regex/pattern text | Keep as protocol string; do not audit as env flag. |
| `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_BEGIN` | `src/core/untrusted-content.ts` untrusted-data boundary | Keep as prompt-injection boundary token. |
| `MYSHELL_UNTRUSTED_DATA_V1_7F3A9C2D_END` | `src/core/untrusted-content.ts` untrusted-data boundary | Keep as prompt-injection boundary token. |

## Ordered Execution Worklist

### 1. Safest Promotions First

1. Promote default-on accounting/ledger primitives:
   `MYSHELL_CACHE_ACCOUNTING_V2`, `MYSHELL_ACCOUNT_AUX`, `MYSHELL_EVIDENCE_RECEIPT_V2`.
   Dependency: evidence receipt uses ledger/session data, but the flags can be removed in one PR if tests cover empty-ledger fallback.

2. Promote default-on durable state primitives:
   `MYSHELL_INTENT_STORE_V1`, `MYSHELL_BLOCKED_STATE_V1`, then `MYSHELL_CORRECTION_FORK_V1`.
   Dependency: correction-fork requires intent-store and goal-store.

3. Promote default-on visible goal/work surfaces:
   `MYSHELL_BOARD`, `MYSHELL_AUTO_GOAL`, `MYSHELL_DRAFT_GOALS`.
   Dependency: draft goals need intent frames; board should stay synced after any goal mutation.

4. Promote default-on evidence and completion surfaces:
   `MYSHELL_VERIFY`, `MYSHELL_TRUST`, `MYSHELL_TRULY_COMPLETE`.
   Dependency: trust depends on verify/evidence signals; truly-complete depends on verify behavior in no-test repos.

5. Promote default-on intelligence:
   `MYSHELL_GOVERNOR`, `MYSHELL_JUDGMENT`, `MYSHELL_TASTE`, `MYSHELL_AUTO_BRAIN`.
   Dependency: governor should continue to feed verify/research/tribunal budget choices.

6. Promote default-on routing/session features:
   `MYSHELL_VENDOR_NEUTRAL_ROUTER`, `MYSHELL_NATIVE_SESSIONS_PROMOTE`.
   Dependency: validate provider fallback before deleting legacy routing branch.

7. Promote default-on goal execution:
   `MYSHELL_SCHEDULER`, `MYSHELL_UNDERSTANDING`, `MYSHELL_MANAGER`.
   Dependency: manager relies on roadmap integrity, verify, board sync, and oversight.

### 2. Removals

1. Remove global drift/aliases:
   `MYSHELL_BASIC`, `MYSHELL_PARALLEL`.

2. Remove scaffold-only provider/mode substrate:
   `MYSHELL_ROLES`, `MYSHELL_LEVEL_DIAL`.
   Reason: current comments say orchestrate does not consume them; a non-working scaffold should not survive as a flag.

3. Remove hidden alternate panels:
   `MYSHELL_CONTROL_PANEL`, `MYSHELL_GOALS_PANEL`.
   Reason: fold any proven affordance into the main chat/board surface; do not keep separate dark panels.

4. Remove granular preflight flags after semantic preflight is validated:
   `MYSHELL_UNIFY_PREFLIGHT`, `MYSHELL_RISK_SIGNALS`, `MYSHELL_REQUIRED_INVESTIGATION`, `MYSHELL_PREFLIGHT_GUARD`.
   Dependency: their useful behavior should be inside promoted `MYSHELL_SEMANTIC_PREFLIGHT_V1`, not separate toggles.

### 3. Judgment-Call Promotions Requiring Validation

1. `MYSHELL_SEMANTIC_PREFLIGHT_V1`: promote only after proving it replaces route/intent/evidence composition without extra latency or lost risk signals.

2. `MYSHELL_RESEARCH`: promote only after validating provider web-search behavior, source quality, and budget shedding.

3. `MYSHELL_PROVIDER_EFFORT`: promote only after verifying current Claude/Grok CLIs accept the emitted effort args for all supported models.

4. `MYSHELL_SUBSCRIPTIONS` and `MYSHELL_ACCOUNT_PARALLELISM`: promote subscription awareness first; promote account parallelism only after account isolation/cooldown validation.

5. `MYSHELL_GOAL_STEWARD`: promote after session-open latency/noise validation.

6. `MYSHELL_ITEM_PARK`: promote after manager-cycle recovery validation for parked blocked items.

7. `MYSHELL_PLANNING_DEPTH`, `MYSHELL_AUTO_SMART`, `MYSHELL_BYPRODUCT_FALLBACK`: promote after targeted canaries for latency, mode policy, and parse false positives.

8. `MYSHELL_TRIBUNAL`: promote after worktree isolation and multi-provider availability validation.

### 4. Keep Runtime Contracts

Keep, but document and keep them out of feature rollout logic:

- Display/diagnostics: `MYSHELL_DEBUG`, `MYSHELL_INK`, `MYSHELL_NO_MARKDOWN`, `MYSHELL_PLAIN`, `MYSHELL_THEME`.
- User/operator controls: `MYSHELL_NO_UPDATE`, `MYSHELL_OVERSIGHT`, `MYSHELL_ROLLBACK`, `MYSHELL_SKIP`.
- Shell/process/install/deployment protocol: `MYSHELL_LOADED`, `MYSHELL_STARTUP_INPUT_B64`, `MYSHELL_COMMIT`, `MYSHELL_CLOUD_WORKSPACE`, `MYSHELL_NIX_STORE_ROOT`.

## Dependency Map

- `MYSHELL_CORRECTION_FORK_V1` depends on `MYSHELL_INTENT_STORE_V1` and a goal store.
- `MYSHELL_TRUST` and `MYSHELL_TRULY_COMPLETE` depend on verify/evidence behavior.
- `MYSHELL_DRAFT_GOALS` depends on intent frames/byproduct capture.
- `MYSHELL_ACCOUNT_PARALLELISM` depends on `MYSHELL_SUBSCRIPTIONS`.
- `MYSHELL_GOAL_STEWARD`, `MYSHELL_MANAGER`, `MYSHELL_ITEM_PARK`, and `MYSHELL_BOARD` all depend on goal-store correctness and board sync.
- `MYSHELL_TRIBUNAL` depends on governor budget decisions, worktree isolation, and at least two distinct authenticated providers.
- `MYSHELL_RESEARCH` depends on provider web-search support and preflight/governor budget controls.
- `MYSHELL_PROVIDER_EFFORT` depends on provider capability registry and actual Claude/Grok CLI support.
- `MYSHELL_SEMANTIC_PREFLIGHT_V1` supersedes `MYSHELL_UNIFY_PREFLIGHT`, `MYSHELL_RISK_SIGNALS`, `MYSHELL_REQUIRED_INVESTIGATION`, and `MYSHELL_PREFLIGHT_GUARD`; do not promote both sets as independent product switches.
- `MYSHELL_BASIC` currently intersects many default-on features; remove it after individual promotions/removals so the migration does not mask behavior changes.

## Needs Validation Before Promote

The following gated code cannot be confidently declared working from static inspection alone:

- `MYSHELL_ACCOUNT_PARALLELISM`: needs live account/cooldown validation and duplicate-spend checks.
- `MYSHELL_AUTO_SMART`: needs mode-policy regression tests for absent `config.mode`.
- `MYSHELL_BYPRODUCT_FALLBACK`: needs false-positive and malformed-output canaries.
- `MYSHELL_GOAL_STEWARD`: needs session-open UX/noise/latency validation.
- `MYSHELL_ITEM_PARK`: needs manager-cycle blocked-item recovery tests.
- `MYSHELL_PLANNING_DEPTH`: needs latency and effort-selection validation.
- `MYSHELL_PROVIDER_EFFORT`: needs real Claude/Grok CLI argument compatibility tests.
- `MYSHELL_RESEARCH`: needs provider web-search/citation/budget validation.
- `MYSHELL_SEMANTIC_PREFLIGHT_V1`: needs end-to-end preflight equivalence and latency validation.
- `MYSHELL_SUBSCRIPTIONS`: needs account-store corruption/privacy/no-account fallback validation.
- `MYSHELL_TRIBUNAL`: needs multi-provider, worktree-isolation, and failure-degrade validation.

Additionally, these removal targets are not worth validating as product features before deletion because the source comments already identify them as scaffold-only or superseded: `MYSHELL_ROLES`, `MYSHELL_LEVEL_DIAL`, `MYSHELL_UNIFY_PREFLIGHT`, `MYSHELL_RISK_SIGNALS`, `MYSHELL_REQUIRED_INVESTIGATION`, `MYSHELL_PREFLIGHT_GUARD`.
