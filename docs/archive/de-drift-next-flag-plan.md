# De-Drift Next Flag Plan: Planning Depth

Date: 2026-07-03

## Decision

Promote exactly one flag next: `MYSHELL_PLANNING_DEPTH` / `experimentalPlanningDepth`.

This is the safest remaining validate-first promotion because it is bounded to post-turn goal planning and already has deterministic unit coverage around the risky paths: depth selection, call-budget shedding, warm/cold grounding, fail-soft fallback, and multi-brain selection entitlement. It does not read account stores, mutate session-open UI, or take over central turn routing.

This is not a recommendation to promote every remaining validate-first flag. `MYSHELL_SEMANTIC_PREFLIGHT_V1`, `MYSHELL_SUBSCRIPTIONS`, and `MYSHELL_GOAL_STEWARD` should stay gated until their validation gates pass.

## Sources Read

- `docs/DE-DRIFT-AUDIT.md`
- `docs/DEDRIFT-EXECUTION-PLAN.md`
- `CHANGELOG.md` entries for `MYSHELL_PLANNING_DEPTH` and planning selection
- `docs/r7-item8-semantic-preflight-contract.md`
- `docs/slice1-opencode-accounts-spec.md`
- `docs/subscription-management-design.md`
- `src/interface/ui/planning-depth-flag.ts`
- `src/interface/ui/goal-steward-flag.ts`
- `src/interface/ui/semantic-preflight-flag.ts`
- `src/interface/ui/subscriptions-flag.ts`
- `src/interface/menu.ts`
- `src/interface/auto-stage.ts`
- `src/infra/config.ts`
- `test/unit/planning-depth-flag.test.ts`
- `test/unit/autonomy.test.ts`
- `test/unit/menu-flow.test.ts`

## Why This Flag

`MYSHELL_PLANNING_DEPTH` is lower blast radius than the other remaining validate-first flags:

- It affects only the goal-planning path created by `createAutoStageEngine`, wired from `src/interface/menu.ts`.
- The normal answer path still runs before post-turn planning; this is already asserted in `test/unit/menu-flow.test.ts`.
- Optional depth is governed by cheap deterministic signals: route classification, repo presence, resolved intensity, mode/plan budget, and pressure.
- The expensive path is bounded: cold L2 grounding uses the existing understanding generator with an 8-second timeout, and multi-brain planning selection is allowed only at high intensity, sufficient budget, panel eligibility, and at least two authenticated providers.
- Failures degrade to the existing ungrounded planner path.
- The validation can be done with fake providers and captured prompts, without live provider accounts or subjective terminal review.

The alternatives are riskier:

- `MYSHELL_SEMANTIC_PREFLIGHT_V1` owns route, intent, risk, and evidence policy. It is a central turn-routing path and must pass an end-to-end equivalence suite before promotion. It also gates removal of `MYSHELL_UNIFY_PREFLIGHT`, `MYSHELL_RISK_SIGNALS`, `MYSHELL_REQUIRED_INVESTIGATION`, and `MYSHELL_PREFLIGHT_GUARD`; do not promote it casually.
- `MYSHELL_SUBSCRIPTIONS` reads account/subscription stores and changes account-aware UI/dependencies. Its real risks are privacy, corrupt store handling, no-account fallback, and account isolation. That needs account-store canaries before promotion.
- `MYSHELL_GOAL_STEWARD` runs at session/conversation open and can create visible prompts/noise or latency. The user has not live-validated baseline startup behavior, so do not promote this autonomously.

## Promotion Meaning

Promote `MYSHELL_PLANNING_DEPTH` to unconditional product behavior.

Concrete implementation:

- In `src/interface/menu.ts`, remove `planningDepthEnabled` import.
- In `src/interface/menu.ts`, replace `const planningDepthOn = planningDepthEnabled(process.env, mutableCtx.config);` with unconditional `const planningDepthOn = true;`.
- Delete `src/interface/ui/planning-depth-flag.ts`.
- Remove `experimentalPlanningDepth?: boolean` from `AppConfig` in `src/infra/config.ts`.
- Delete `test/unit/planning-depth-flag.test.ts`.
- Update `test/unit/menu-flow.test.ts` cases that currently set `experimentalPlanningDepth: true` so they rely on the default product path.
- Replace the old gate-off preservation test with default-on preservation canaries for common cases.
- Update docs/changelog references that call the feature default-off, at minimum `CHANGELOG.md` or the release note for this de-drift slice.

Do not keep `MYSHELL_PLANNING_DEPTH=0`, `experimentalPlanningDepth:false`, or another hidden opt-out. The rollback is a normal git revert of the promotion commit.

## Validation Canary Plan

Add or update canaries before the promotion commit is accepted. These should use fake providers and existing menu-flow harnesses, not live provider calls.

### Pure Policy Canaries

File: `test/unit/autonomy.test.ts`

Keep and, if needed, expand coverage for:

- `planningDepthCap`: quick/explain always stay at depth 1 for all intensity/budget combinations.
- `planningDepthCap`: build/decide/risky/investigate only reach depth 2 when intensity and call budget allow it.
- `planningSelectionEntitlement`: unlocked only when intensity is 4-5, call budget is 3, panel is allowed, and at least two providers are authenticated.
- `shouldRunPlanningSelection`: no selection for quick/explain, non-hard goals, clarify/none judgments, no-deficiency plans, or no-verification-only gaps.
- `choosePlannerTier`: manager-tier planner only when strong planning is needed and intensity is 4-5.

### Menu-Flow Canaries

File: `test/unit/menu-flow.test.ts`

Required canaries:

- Absent env/config plus low-risk trivial task such as `build a birdhouse` produces exactly one planner call, no understanding grounding call, no adjudicator call, and no `Planning deeper` notice.
- Absent env/config plus cost-saver hard task stays L1: no blocking grounding notice and no planning-selection disclosure.
- Absent env/config plus quality-first hard task answers the user first, then may run the post-turn grounding/planner sequence.
- Cold hard quality-first task grounds the planner with one existing understanding pass and never blocks the primary answer path.
- Warm `SystemModel` is reused by the next planner without another synchronous understanding pass.
- Understanding failure or timeout falls through to one ungrounded planner call and writes the existing honest fallback notice.
- High-intensity, two-provider, deficient hard plan runs the exact bounded selection path: candidate A, candidate B, adjudicator, no fourth planning/understanding call in that selection path.
- One authenticated provider, cost-saver mode, or complete candidate A locks selection and keeps the one-planner path.
- Old explicit-off inputs are ignored after promotion: `MYSHELL_PLANNING_DEPTH=0` and `experimentalPlanningDepth:false` do not disable the default product path. This proves there is no surviving hidden off state.

### Latency/Call-Budget Canary

Add one deterministic timing-style test around fake delayed understanding:

- The first user-facing provider response is emitted before any post-turn planning-depth wait.
- The L2 grounding timeout remains capped at 8 seconds in the code path by asserting the generated understanding pass receives `8_000`.
- Under pressure/cost-saver budget, optional depth sheds before producing a blocking grounding notice.

### Full Verification Commands

Run these before merging the promotion:

```powershell
npm run test -- test/unit/autonomy.test.ts test/unit/menu-flow.test.ts
npm test
npm run typecheck
npm run lint
npm run knip
```

If this slice edits docs or changelog only beyond code, no UI screenshot validation is required. If the implementation touches Ink rendering or visible menu layout unexpectedly, stop and re-scope because that is outside the planning-depth promotion.

## Acceptance Criteria

- `rg "MYSHELL_PLANNING_DEPTH|experimentalPlanningDepth|planningDepthEnabled|planning-depth-flag" src test` returns no live code/test references after intentional docs/changelog references are accounted for.
- With env/config absent, the default path exercises planning-depth behavior.
- Small/common tasks remain one silent planner call.
- Cost-saver and pressure still shed optional depth.
- Hard quality-first tasks can use grounded planning, but the normal answer path still returns first.
- Multi-brain plan selection remains bounded to the existing entitlement and deficiency gates.
- No account-store, semantic-preflight, or goal-steward behavior changes are included in the same PR.

## Rollback

Rollback is `git revert <planning-depth-promotion-commit>`.

Because the promotion must delete the helper/config field instead of adding a new off switch, operational rollback is the source-control revert. Old user config files containing `experimentalPlanningDepth` remain harmless because unknown config keys are tolerated by the loader.

## Explicit Non-Promotions

Do not promote these before their gates pass:

- `MYSHELL_SEMANTIC_PREFLIGHT_V1`: requires route/intent/evidence equivalence and latency proof.
- `MYSHELL_SUBSCRIPTIONS`: requires account-store corruption/privacy/no-account canaries.
- `MYSHELL_GOAL_STEWARD`: requires startup/session-open latency and noise validation.

If the user wants no visible behavior change of any kind before live baseline validation, then stop after this plan and hand off. Among the remaining flags, `MYSHELL_PLANNING_DEPTH` is the only one I would consider autonomously promotable after deterministic canaries pass.
