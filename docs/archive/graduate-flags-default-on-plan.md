# Graduate Flags Default-On Plan

## Goal

Graduating the 7 shipped intelligence-spine flags from default-off opt-in to default-on opt-out.

New contract: absent, empty, ambiguous, or hostile env means ON. Return `false` only when the env value is explicitly one of `0`, `false`, `off`, `no`, trimmed and case-insensitive. The legacy byte-identical path remains available by setting the relevant env var to an explicit opt-out value.

Do not change feature behavior. Change only defaults, stale comments, launcher scripts, and tests.

## Flag Helper Changes

Apply the same logic to each helper:

```ts
const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function flagEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['FLAG_NAME'];
    if (typeof raw === 'string') {
      const cleaned = raw.trim().toLowerCase();
      if (OFF.has(cleaned)) return false;
      if (ON.has(cleaned)) return true;
    }
    return true;
  } catch {
    return true;
  }
}
```

Update these files:

- `src/interface/ui/cache-accounting-flag.ts`
- `src/interface/ui/account-aux-flag.ts`
- `src/interface/ui/intent-store-flag.ts`
- `src/interface/ui/correction-fork-flag.ts`
- `src/interface/ui/blocked-state-flag.ts`
- `src/interface/ui/evidence-receipt-flag.ts`
- `src/interface/ui/native-sessions-promote-flag.ts`

For `nativeSessionsEffectiveEnabled`, keep existing behavior:

```ts
return input.configNativeSessions === true || input.promoted === true;
```

Do not add config fields in this PR.

Update stale comments in `src/interface/menu.ts` and helper headers from `DEFAULT OFF` / `explicit opt-IN` to default-on / explicit opt-out. Keep `correctionForkOn = correctionForkV1Enabled(process.env) && intentStoreOn` unchanged in both `src/cli.ts` and `src/interface/menu.ts`.

## Test Reconciliation

Update direct flag tests:

- `test/unit/cache-accounting-flag.test.ts`
- `test/unit/account-aux-flag.test.ts`
- `test/unit/intent-store-flag.test.ts`
- `test/unit/correction-fork-flag.test.ts`
- `test/unit/blocked-state-flag.test.ts`
- `test/unit/evidence-receipt-flag.test.ts`
- `test/unit/native-sessions-promote-flag.test.ts`

Expected assertions:

- `undefined`, `{}`, `''`, `'garbage'`, `'2'`, and hostile getter all return `true`.
- `'1'`, `'true'`, `'on'`, `'yes'`, with trim/case variants, return `true`.
- `'0'`, `'false'`, `'off'`, `'no'`, with trim/case variants, return `false`.

Likely break areas and fixes:

- Cache accounting: `test/unit/cost.test.ts`, `test/unit/work-call-prior-cost.test.ts`.
  Update default entry-point expectations to include cache accounting. Keep legacy tests by explicitly setting `MYSHELL_CACHE_ACCOUNTING_V2='0'`.

- Account aux ledger: `test/unit/route-classifier.test.ts`, `test/unit/intent-extractor.test.ts`, `test/unit/recap-generator.test.ts`, `test/unit/understanding-generator.test.ts`, `test/unit/goal-plan-generator.test.ts`, `test/unit/orchestrate-account-aux.test.ts`, `test/unit/work-call-prior-cost.test.ts`.
  Tests of default entry-point behavior should expect stage and `intentVersionId`. Tests asserting old no-stage/no-id behavior must opt out with `MYSHELL_ACCOUNT_AUX='0'`.

- Intent store: `test/unit/orchestrate-intent-store.test.ts`, `test/unit/goal-plan-autostage.test.ts`, `test/unit/menu-flow.test.ts`.
  Default entry-point behavior should expect `intent-versions.jsonl` and linked `intentVersionId`. Legacy tests must set `MYSHELL_INTENT_STORE_V1='0'`.

- Correction fork: `test/unit/orchestrate-correction-fork.test.ts`, `test/unit/correction-fork.test.ts`, `test/unit/menu-flow.test.ts`.
  Preserve the dependency: correction fork is active only when its flag and intent store are both on. Add/keep a test where `MYSHELL_INTENT_STORE_V1='0'` proves correction fork is inert even though correction fork defaults on. For explicit legacy fork-off behavior, use `MYSHELL_CORRECTION_FORK_V1='0'`.

- Blocked state: `test/unit/accept-stage.test.ts`, `test/unit/work-call-blocked-state.test.ts`, `test/unit/render.test.ts`, blocked/failing assertions in `test/unit/menu-flow.test.ts`.
  Default behavior should expect `blocked` terminal where the feature says blocked. Legacy failed-terminal tests must set `MYSHELL_BLOCKED_STATE_V1='0'`.

- Evidence receipt: `test/unit/evidence-receipt.test.ts`, `test/unit/accept-stage.test.ts`, `test/unit/render.test.ts`, `test/unit/menu-flow.test.ts`.
  Default terminal finals should include receipt when routed through entry points. Tests for no receipt must opt out with `MYSHELL_EVIDENCE_RECEIPT_V2='0'` or construct core deps without `evidenceReceiptV2`.

- Native sessions promote: `test/unit/native-sessions-promote-flag.test.ts`, `test/unit/native-session-telemetry.test.ts`, native-session areas in `test/unit/menu-flow.test.ts`.
  Default entry-point behavior should plan/promote native sessions when eligible. Legacy no-promotion tests must set `MYSHELL_NATIVE_SESSIONS_PROMOTE='0'`.

In broad `menu-flow` tests not about this spine, add a scoped env helper that sets all seven flags to `'0'`. Do not scatter unscoped `process.env` mutations. Add at least one dedicated default-on chat-spine test with no opt-outs that proves normal chat wires the spine.

## Delete Launcher Scripts

Delete:

- `scripts/test-all-on.ps1`
- `scripts/test-all-on.sh`

Also remove any references to those scripts if found.

## Verification

Run:

```sh
npm run typecheck
find test/unit test/arch test/contract -name '*.test.ts' | sort | xargs node --import tsx/esm --test
```

Before edits, capture baseline failing test names on `main`. After edits, capture failing test names again. Success is exact name-diff equality: only the pre-existing roughly 33 failures remain, with zero new failing names.

Do not compare raw counts. Compare test names.

## Ordered Checklist

1. Capture baseline full-suite failing test names.
2. Flip the seven helper defaults to true-on-absent/ambiguous/catch.
3. Update helper comments and stale `DEFAULT OFF` comments in touched runtime files.
4. Confirm `src/cli.ts` and `src/interface/menu.ts` still gate correction fork with `&& intentStoreOn`.
5. Delete both `scripts/test-all-on.*` launchers.
6. Update the seven helper truth-table tests.
7. Run targeted tests around cache, aux, intent store, correction fork, blocked state, receipt, native sessions.
8. Reconcile failures: update new default expectations, or add explicit env opt-out only for legacy/off tests.
9. Ensure every flag has at least one explicit opt-out legacy test.
10. Run `npm run typecheck`.
11. Run the full suite and compare failing names to baseline.
12. Keep the diff minimal; do not delete or weaken tests.

## Risks

- Correction fork must stay conservative. Do not broaden correction detection while making it default-on.
- Intent-store opt-out must disable correction fork through the existing composition gate.
- Hostile env access must never throw; catch returns `true`.
- Do not convert core optional-dep tests into product-default tests unless they call CLI/menu/cost helpers.
- Never “fix” the suite by loosening assertions. Update expectations to the new shipped default, or explicitly opt out when testing legacy behavior.