# PR5 Evidence Receipt + Native Sessions Promote Plan

## 1. Goal And Off Guarantees

Implement two independent, default-off capabilities:

- `MYSHELL_EVIDENCE_RECEIPT_V2`: attach a structured proof-of-done receipt to terminal work finals. The receipt reports what changed, what verification ran, whether the result is truly verified or merely answered, and the existing PR1/PR2 cost/cache/aux ledger facts.
- `MYSHELL_NATIVE_SESSIONS_PROMOTE`: promote already-wired native provider sessions for interactive conversations and emit telemetry proving the savings.

Off guarantees:

- If `MYSHELL_EVIDENCE_RECEIPT_V2` is off, no receipt is assembled, no receipt field is added to `CoreEvent.final`, no receipt rendering occurs, no ledger wrapper is installed, and terminal output is byte-identical to current main.
- If `MYSHELL_NATIVE_SESSIONS_PROMOTE` is off, `config.nativeSessions` behavior remains exactly current main: no env-driven native plan, no telemetry, no native-session notice/rendering. Existing user-enabled `config.nativeSessions === true` continues unchanged.
- The flags are independent. Turning on one must not enable or require the other.
- Do not weaken verification. The receipt reports truth; it never upgrades `unverified`, `reviewed`, best-effort, or answered work to verified.
- Preserve all existing quarantine/stale-session safeguards. Savings never outrank correctness.
- No new model calls.

## 2. Receipt Data Model And Assembly

Add `src/core/evidence-receipt.ts` as a pure module, statically imported by `src/core/accept-stage.ts` and `src/core/work-call.ts`.

```ts
export type ReceiptTerminal = 'done' | 'blocked' | 'failed' | 'answered';
export type ReceiptVerdict =
  | 'verified'
  | 'reviewed'
  | 'unverified'
  | 'failing'
  | 'answered';

export interface EvidenceReceiptV2 {
  readonly version: 2;
  readonly terminal: ReceiptTerminal;
  readonly verdict: ReceiptVerdict;
  readonly changedFiles?: readonly string[];
  readonly commandsRun?: readonly {
    readonly command: string;
    readonly outcome: 'success' | 'failed' | 'skipped';
    readonly durationMs?: number;
  }[];
  readonly testsResult?: {
    readonly command: string;
    readonly outcome: 'green' | 'red' | 'timeout' | 'errored';
    readonly durationMs: number;
  };
  readonly verifyVerdict: import('./verify.js').VerifiedState | 'not-run';
  readonly costUsd: number;
  readonly cacheAdjustedUsd?: number;
  readonly auxCalls?: {
    readonly count: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens?: number;
    readonly usd: number;
  };
  readonly intentVersionId?: string;
}
```

Field sources, existing data only:

- `changedFiles`: `VerifyOutcome.changedPaths` from `src/core/verify.ts:180`.
- `commandsRun`: `VerifyOutcome.testCommand` + `VerifyOutcome.testRun` from `src/core/verify.ts:165-166`.
- `testsResult`: same `VerifyOutcome.testCommand/testRun`.
- `verifyVerdict`: `VerifyOutcome.verified`; use `'not-run'` when verification was unarmed or skipped before a `VerifyOutcome` exists.
- `costUsd`: terminal final `totalCostUsd` / `CandidateResult.totalCostUsd` from `src/core/accept-stage.ts:27-30`.
- `cacheAdjustedUsd`: sum `LedgerEntry.usd` from this turn’s captured ledger entries only when `deps.cacheAccountingV2 === true`.
- `auxCalls`: entries where `entry.stage !== undefined && entry.stage !== 'work'`, using PR2 fields at `src/core/types.ts:181-196`.
- `intentVersionId`: `deps.intentVersionId` when present from PR2/PR3.

Verified-vs-answered rule:

- `VerifyOutcome.verified === 'passing'` => `verdict: 'verified'`.
- `VerifyOutcome.verified === 'reviewed'` => `verdict: 'reviewed'`; never call this verified.
- `VerifyOutcome.verified === 'failing'` => `verdict: 'failing'`.
- `VerifyOutcome.verified === 'unverified'` or no outcome => `verdict: 'unverified'`.
- Structured question finals and non-work answers use `verdict: 'answered'` only if a receipt is attached; do not render them as done.

Assembly point:

- Primary assembly is the accept terminal path in `src/core/accept-stage.ts`:
  - `finalizeAcceptedCandidate` at `src/core/accept-stage.ts:178`.
  - failing verification final inside `runCandidateQualityGate` at `src/core/accept-stage.ts:365`.
- For direct work-call failure finals that bypass `accept-stage.ts`, use the same helper from `src/core/work-call.ts` before yielding final events. Keep this minimal: timeout/provider failures get a receipt with `verifyVerdict: 'not-run'`, no changed files, and `terminal: 'failed'` or `blocked` if PR4 blocked record exists.
- Do not add receipts to clarification question finals.

Ledger capture for receipt:

- Add `receiptLedgerSnapshot?: () => readonly LedgerEntry[]` to `OrchestrateDeps`.
- In composition roots, when `MYSHELL_EVIDENCE_RECEIPT_V2` is on, wrap the existing `LedgerWriter` for that turn:
  - Push each `LedgerEntry` into a local array.
  - Delegate to the real `ledger.record(entry)`.
  - Pass `receiptLedgerSnapshot: () => entries`.
- Off path must pass the original ledger object unchanged.
- This captures the exact existing ledger entries without reading files, adding model calls, or racing concurrent sessions.

## 3. Native Session Promotion

Current mechanism already exists:

- `ProviderRequest.sessionId/resume`: `src/providers/port.ts:50-54`.
- Claude flags: `src/providers/claude.ts:151-155`.
- Codex flags: `src/providers/codex.ts:127-128`.
- Grok flags: `src/providers/grok.ts:117-121`.
- Planner: `src/core/native-session.ts:92-114`.
- Work-call history omission and backstop: `src/core/work-call.ts:1205-1281`.
- Menu composition: `src/interface/menu.ts:2241`.

Promotion flag behavior:

- Add `MYSHELL_NATIVE_SESSIONS_PROMOTE`, default off.
- In interactive `menu.ts`, native sessions are enabled when:
  - `mutableCtx.config.nativeSessions === true`, current behavior, or
  - `nativeSessionsPromoteEnabled(process.env) === true`.
- In one-shot `cli.ts`, do not promote native sessions unless a conversation id/history exists. Current one-shot behavior remains unchanged.
- If promotion is on, still call the same `planNativeSession`; do not create a new planner.
- Fallbacks remain:
  - disabled or no conversation id => no plan, history replay.
  - quarantined history policy => no plan, history replay.
  - provider mismatch => no session request, history replay.
  - Codex without captured thread id => no Codex plan, history replay.
  - provider/adaptor failure => normal existing failover/error path.

Telemetry:

Add `src/core/native-session-telemetry.ts`, pure and statically imported by `src/core/work-call.ts`.

Record a structured sample on resumed same-provider runs:

```ts
export interface NativeSessionTelemetry {
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly usedNative: boolean;
  readonly fallbackReason?: 'disabled' | 'no-plan' | 'provider-mismatch' | 'quarantined';
  readonly historyReplayEstimatedTokens: number;
  readonly actualInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number;
  readonly inputTokenDropVsColdEstimate: number;
}
```

Measurement rule:

- `historyReplayEstimatedTokens = estimateInputTokens([historyContext])` using existing `src/core/orchestrate-signals.ts:115`.
- On native path, `inputTokenDropVsColdEstimate = historyReplayEstimatedTokens`; this estimates the cold replay avoided by omitting `CONVERSATION SO FAR`.
- `actualInputTokens`, `cachedInputTokens`, `cacheWriteInputTokens` come from provider `Usage`.
- Emit telemetry only when `MYSHELL_NATIVE_SESSIONS_PROMOTE` is on. Existing `config.nativeSessions` without the new flag remains byte-identical.

## 4. File-By-File Changes

### `src/interface/ui/evidence-receipt-flag.ts` new

Mirror `src/interface/ui/blocked-state-flag.ts:12`.

Export:

```ts
export function evidenceReceiptV2Enabled(env: NodeJS.ProcessEnv | undefined): boolean
```

Default false. Accept only `1`, `true`, `on`, `yes`. Explicit off and ambiguous values return false. Catch returns false.

Static imports required from `src/interface/menu.ts` and `src/cli.ts`.

### `src/interface/ui/native-sessions-promote-flag.ts` new

Same pattern.

Export:

```ts
export function nativeSessionsPromoteEnabled(env: NodeJS.ProcessEnv | undefined): boolean
```

Also export pure helper for tests:

```ts
export function nativeSessionsEffectiveEnabled(input: {
  readonly configNativeSessions?: boolean;
  readonly promoted: boolean;
}): boolean
```

Return `input.configNativeSessions === true || input.promoted === true`.

Static imports required from `src/interface/menu.ts` and `src/cli.ts`.

### `src/core/evidence-receipt.ts` new

Pure module. Export:

- `EvidenceReceiptV2`
- `ReceiptTerminal`
- `ReceiptVerdict`
- `buildEvidenceReceipt(input)`
- `summarizeReceiptLedger(entries)`

`buildEvidenceReceipt` inputs:

```ts
{
  terminal: ReceiptTerminal;
  success: boolean;
  bestEffort?: true;
  blocked?: import('./blocked.js').BlockedRecord;
  verifyOutcome?: import('./verify.js').VerifyOutcome;
  totalCostUsd: number;
  cacheAccountingV2?: boolean;
  ledgerEntries: readonly import('./types.js').LedgerEntry[];
  intentVersionId?: string;
}
```

Rules:

- Omit optional fields when empty.
- `cacheAdjustedUsd` only when `cacheAccountingV2 === true`.
- `auxCalls` only when at least one non-work staged entry exists.
- Never throw.
- Do not import from `infra`.

Static imports: `accept-stage.ts` and `work-call.ts`.

### `src/core/native-session-telemetry.ts` new

Pure module. Export:

- `NativeSessionTelemetry`
- `buildNativeSessionTelemetry(input)`
- `renderNativeSessionTelemetry(sample)`

Use existing `estimateInputTokens` via static import from `./orchestrate-signals.js`.

Static import: `work-call.ts`.

### `src/core/types.ts`

Anchors:

- `LedgerEntry`: `src/core/types.ts:181`.
- `OrchestrateDeps`: `src/core/types.ts:347`.
- `nativeSession`: `src/core/types.ts:432`.
- `tier-done`: `src/core/types.ts:1109`.
- `final`: `src/core/types.ts:1144`.

Changes:

- Add to `OrchestrateDeps`:

```ts
readonly evidenceReceiptV2?: boolean;
readonly receiptLedgerSnapshot?: () => readonly LedgerEntry[];
readonly nativeSessionsPromote?: boolean;
```

- Add to `CoreEvent.tier-done`:

```ts
readonly nativeSessionTelemetry?: import('./native-session-telemetry.js').NativeSessionTelemetry;
```

- Add to `CoreEvent.final`:

```ts
readonly receipt?: import('./evidence-receipt.js').EvidenceReceiptV2;
```

Off guard: fields absent unless the corresponding flag is on.

### `src/core/accept-stage.ts`

Anchors:

- Imports at top.
- `finalizeAcceptedCandidate`: `src/core/accept-stage.ts:178`.
- `runCandidateQualityGate`: `src/core/accept-stage.ts:300`.
- failing final: `src/core/accept-stage.ts:365`.

Changes:

- Static import `buildEvidenceReceipt`.
- Add local helper:

```ts
function receiptForFinal(
  deps: OrchestrateDeps,
  final: Extract<CoreEvent, { type: 'final' }>,
  verifyOutcome: VerifyOutcome | undefined,
): Pick<Extract<CoreEvent, { type: 'final' }>, 'receipt'> | {}
```

- Return `{}` unless `deps.evidenceReceiptV2 === true`.
- Use `deps.receiptLedgerSnapshot?.() ?? []`.
- Attach receipt in `finalizeAcceptedCandidate`.
- Attach receipt to verification-failed blocked/failure final in `runCandidateQualityGate`.
- Keep evidence snapshot emission unchanged.

### `src/core/work-call.ts`

Anchors:

- Native decision: `src/core/work-call.ts:1205-1210`.
- Request session args: `src/core/work-call.ts:1273-1281`.
- ledger write: `src/core/work-call.ts:1385`.
- `tier-done`: immediately after ledger write.
- direct final paths include timeout at `src/core/work-call.ts:1612`, loop failure at `src/core/work-call.ts:2257`.

Changes:

- Static import `buildEvidenceReceipt`.
- Static import `buildNativeSessionTelemetry` and `renderNativeSessionTelemetry`.
- Compute native fallback reason at the existing native decision:
  - quarantined => `quarantined`
  - no matching plan => `provider-mismatch` if plans exist for another provider, else `no-plan`
  - native used => no fallback.
- When `deps.nativeSessionsPromote === true`, after provider usage is known:
  - build telemetry from `nativePlan`, `useNative`, `historyContext`, and `usage`.
  - attach it to `tier-done`.
  - emit an info `notice` using `renderNativeSessionTelemetry(sample)` only when `sample.usedNative && sample.resume`.
- Attach minimal receipts to direct terminal failure finals only when `deps.evidenceReceiptV2 === true`; use `verifyOutcome: undefined`.

Do not modify the existing quarantine check or session request logic except to observe it.

### `src/interface/render.ts`

Anchors:

- final case starts at `src/interface/render.ts:881`.
- blocked render at `src/interface/render.ts:910`.
- best-effort render at `src/interface/render.ts:978`.
- normal done line at `src/interface/render.ts:1008`.

Changes:

- Render `ev.receipt` after blocked/best-effort notice and before the success/failure completion line, only when present.
- Keep quiet mode quiet.
- Suggested normal rendering:

```txt
Receipt
  Verdict: verified | reviewed | unverified | failing | answered
  Files: src/a.ts, src/b.ts
  Commands: npm test (green, 1234ms)
  Cost: $0.0123
  Cache-adjusted: $0.0045
  Aux: 2 calls, 1.2k tokens
  Intent: <id>
```

- For `verdict: 'verified'`, text may say `Verified`.
- For all other verdicts, text must explicitly avoid “verified”; use `Reviewed`, `Unverified`, `Failing`, or `Answered`.
- Do not change rendering when `receipt` is absent.

### `src/interface/ui/core-event.ts`, `src/interface/ui/reduce.ts`, `src/interface/ui/state.ts`

If TypeScript requires exhaustiveness updates for `tier-done.nativeSessionTelemetry` or `final.receipt`, preserve current UI behavior by ignoring these fields unless already rendering final metadata. Off path remains unchanged.

### `src/interface/menu.ts`

Anchors:

- imports near `src/interface/menu.ts:234-236`.
- global flag values near `src/interface/menu.ts:1359-1365`.
- native planning at `src/interface/menu.ts:2241`.
- per-turn `intentVersionId` at `src/interface/menu.ts:2383`.
- returned deps near `src/interface/menu.ts:2389`.
- `nativeSession` spread currently near `src/interface/menu.ts:2527`.

Changes:

- Import both new flag helpers.
- Compute:

```ts
const evidenceReceiptOn = evidenceReceiptV2Enabled(process.env);
const nativeSessionsPromoteOn = nativeSessionsPromoteEnabled(process.env);
```

- In each `buildDeps` call, create a per-turn ledger wrapper only when `evidenceReceiptOn`:

```ts
const receiptLedgerEntries: LedgerEntry[] = [];
const turnLedger = evidenceReceiptOn
  ? {
      async record(entry: LedgerEntry): Promise<void> {
        receiptLedgerEntries.push(entry);
        await accountingLedger.record(entry);
      },
    }
  : accountingLedger;
```

- Use `turnLedger` everywhere inside that `buildDeps`, including route classifier and intent extractor aux deps.
- Native session planning uses:

```ts
enabled: nativeSessionsEffectiveEnabled({
  configNativeSessions: mutableCtx.config.nativeSessions,
  promoted: nativeSessionsPromoteOn,
})
```

- Return deps:

```ts
ledger: turnLedger,
...(evidenceReceiptOn
  ? {
      evidenceReceiptV2: true,
      receiptLedgerSnapshot: () => receiptLedgerEntries,
    }
  : {}),
...(nativeSessionsPromoteOn ? { nativeSessionsPromote: true } : {}),
```

- Do not enable `accountAux` or `cacheAccountingV2` implicitly.

### `src/cli.ts`

Anchors:

- imports near `src/cli.ts:91-93`.
- `buildDeps`: `src/cli.ts:225`.
- ledger/session construction around `src/cli.ts:304`.

Changes:

- Import `evidenceReceiptV2Enabled` and `nativeSessionsPromoteEnabled`.
- For one-shot runs, wrap ledger only for receipt capture. This allows receipts to include work-call ledger entries.
- Do not plan native sessions in one-shot CLI unless a future caller provides conversation history/id; set only `nativeSessionsPromote: true` for tests if harmless, but no `nativeSession` plans are created here.

### `src/infra/config.ts`

Add comments only if needed. Do not add a config field for `MYSHELL_NATIVE_SESSIONS_PROMOTE`; this PR’s promotion path is env-gated, default off. Existing `nativeSessions?: boolean` remains user setting.

## 5. Tests

Add:

- `test/unit/evidence-receipt-flag.test.ts`
  - `evidenceReceiptV2Enabled absent env returns false`
  - `evidenceReceiptV2Enabled accepts trimmed case-insensitive opt-in values`
  - `evidenceReceiptV2Enabled returns false for opt-out and ambiguous values`
  - `evidenceReceiptV2Enabled never throws and defaults false on hostile env`

- `test/unit/evidence-receipt.test.ts`
  - `buildEvidenceReceipt returns undefined-equivalent absent optional data only when caller does not call it`
  - `passing tests produce verdict verified with changedFiles commandsRun testsResult`
  - `reviewed produce verdict reviewed not verified`
  - `unverified and no outcome produce unverified not verified`
  - `best effort produces unverified receipt`
  - `summarizes aux staged ledger entries and omits auxCalls when none exist`
  - `cacheAdjustedUsd appears only when cacheAccountingV2 is true`
  - `intentVersionId is preserved when supplied`

- `test/unit/accept-stage.test.ts`
  - `evidenceReceiptV2 off leaves final without receipt`
  - `evidenceReceiptV2 on attaches verified receipt after passing verification`
  - `evidenceReceiptV2 on marks reviewed as reviewed not verified`
  - `evidenceReceiptV2 on marks unverified accepted answer as unverified`
  - `evidenceReceiptV2 on attaches blocked receipt to verification failed final`
  - update existing `appends only after verification and immediately before final` to keep order: verify, receipt notice, append, final-with-receipt.

- `test/unit/render.test.ts`
  - `renderStream renders receipt when final.receipt is present`
  - `renderStream does not render receipt when absent`
  - `renderStream labels reviewed/unverified without the word verified`

- `test/unit/native-sessions-promote-flag.test.ts`
  - `nativeSessionsPromoteEnabled absent env returns false`
  - `nativeSessionsPromoteEnabled accepts opt-in values`
  - `nativeSessionsPromoteEnabled rejects off and ambiguous values`
  - `nativeSessionsEffectiveEnabled preserves config nativeSessions and adds promotion`

- `test/unit/native-session-telemetry.test.ts`
  - `buildNativeSessionTelemetry estimates omitted history tokens on resumed native path`
  - `buildNativeSessionTelemetry records actual input and cache reads`
  - `renderNativeSessionTelemetry reports resumed provider session and token drop estimate`
  - `fallback telemetry records provider mismatch without claiming savings`

- `test/unit/native-session.test.ts`
  - keep existing quarantine tests.
  - add `promotion does not bypass quarantine` if the effective-enabled helper is passed into `planNativeSession`.

- `test/unit/orchestrate.test.ts`
  - extend native session block around `src/unit/orchestrate.test.ts:3115`:
    - `nativeSessionsPromote telemetry emitted when native plan resumes`
    - `promotion fallback provider mismatch replays history and emits no savings claim`
    - existing `no history replay, sessionId passed` must still pass.

- `test/arch/guards.test.ts`
  - no changes expected; new modules must pass no-orphan via static imports.

## 6. Verification Commands

Run from repo root:

```powershell
npm run typecheck
node --import tsx/esm --test test/unit/evidence-receipt-flag.test.ts test/unit/evidence-receipt.test.ts test/unit/accept-stage.test.ts test/unit/render.test.ts
node --import tsx/esm --test test/unit/native-sessions-promote-flag.test.ts test/unit/native-session-telemetry.test.ts test/unit/native-session.test.ts test/unit/orchestrate.test.ts
node --import tsx/esm --test test/arch/guards.test.ts
```

Success criteria:

- `npm run typecheck` passes.
- All targeted tests pass.
- `test/arch/guards.test.ts` passes; no new orphan modules.
- Broad-suite policy: zero NEW failures by exact test-name diff vs `main`; do not compare raw counts. Known baseline is 33 failing names / roughly 57 flaky-Windows failures.
- Native-session measurement: on a resumed same-provider Claude turn with `MYSHELL_NATIVE_SESSIONS_PROMOTE=1`, telemetry shows:
  - `usedNative: true`
  - `resume: true`
  - provider request has `sessionId` and `resume`
  - prompt omits `CONVERSATION SO FAR`
  - `inputTokenDropVsColdEstimate` approximately equals `historyReplayEstimatedTokens`
  - `cachedInputTokens` is recorded from provider usage when available, expected to rise on Claude resumed turns.

Manual smoke for measurement:

```powershell
$env:MYSHELL_CACHE_ACCOUNTING_V2='1'
$env:MYSHELL_ACCOUNT_AUX='1'
$env:MYSHELL_EVIDENCE_RECEIPT_V2='1'
$env:MYSHELL_NATIVE_SESSIONS_PROMOTE='1'
myshell-tools
```

In one conversation, run a Claude-routed task, then a follow-up. Confirm receipt appears on finish and native telemetry reports the resumed session on the follow-up.

## 7. Ordered Checklist

1. Add the two flag helpers and flag tests.
2. Add `EvidenceReceiptV2` pure module and unit tests.
3. Add `NativeSessionTelemetry` pure module and unit tests.
4. Extend `CoreEvent.final`, `CoreEvent.tier-done`, and `OrchestrateDeps` with optional fields.
5. Wire the per-turn receipt ledger wrapper in `menu.ts` and `cli.ts`; off path keeps the original ledger object.
6. Attach receipts in `accept-stage.ts` for clean, best-effort, and verification-failed terminals.
7. Attach minimal receipts in `work-call.ts` for direct terminal failures.
8. Wire native promotion in `menu.ts` using existing `planNativeSession`.
9. Add native telemetry in `work-call.ts` without changing session selection logic.
10. Render receipts in `render.ts`; preserve output when absent.
11. Run targeted tests and `test/arch/guards.test.ts`.
12. Run `npm run typecheck`.
13. If broad tests are run, compare failing test names against `main`, not counts.

## 8. Risks And Safe Defaults

- Never mark unverified work as verified. Only `VerifyOutcome.verified === 'passing'` may produce `verdict: 'verified'`.
- `reviewed` is a weak signal, not verified. Render it as reviewed.
- If receipt assembly lacks ledger entries, still emit a truthful receipt from final + verify data; omit `auxCalls` and `cacheAdjustedUsd`.
- If `cacheAccountingV2` is off, omit `cacheAdjustedUsd`; do not pretend naive cost is cache-adjusted.
- If native session plan is stale, quarantined, provider-mismatched, or missing, replay history exactly as today.
- Do not add API-native cache controls, semantic caches, tokenizer dependencies, or model calls.
- Any new `src/*.ts` module must be statically imported by another `src` file. Dynamic `await import()` does not satisfy the no-orphan guard.