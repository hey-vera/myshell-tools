# Item 17 contract - verification to completion, with folded delivery-quality gate

Status: delegation-ready implementation contract, grounded at repository head `7203c85` on 2026-07-02.

This document is controlling for Round-7 Item 17. Candidate Item 20 is folded into this contract as the Delivery-Quality Gate and must not be implemented as a separate later terminal authority. Item 8 semantic preflight may create objective, done-condition, and before-completion obligations; Item 5 may reserve verification work; Item 17 alone owns the final completion truth consumed by chat, goals, resume, and UI.

At document creation the worktree was not clean: `docs/ROADMAP-STATUS.md` was modified and `docs/vision-alignment-5.6.md` was untracked. Those are pre-existing local changes for this authoring turn and are not part of this contract edit.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_COMPLETION_RESULT_V1` is explicitly enabled, every terminal foreground turn produces exactly one `CompletionResultV1`. That result is the single terminal truth for:

- the chat final event and receipt;
- goal done/blocked/needs-user settlement;
- resume and exactly-once replay decisions;
- UI labels and trust receipts;
- future work-state reconstruction.

`CompletionResultV1` is not another receipt line. It is the typed settlement object that says what terminal state was earned, what evidence supports it, what is excluded, what remains unresolved, and whether the user-visible delivery passes the final quality gate.

This item does **not**:

- replace the honest four-state verification engine in `src/core/verify.ts`;
- loosen the rule that `passing` requires executed green tests;
- treat `reviewed` as test-verified;
- make Item 8 default-on or reinterpret Item 8 evidence obligations as completed;
- build Item 10's durable exactly-once state machine, but it must give Item 10 a terminal replay decision;
- build Item 13's goal DAG, but it must give Item 13 a single goal-settlement input;
- invent provider capability, quota, or test evidence;
- allow delivery-quality self-review to override verification evidence;
- make user-visible default behavior change before the dark flag and eval gate pass.

The current implementation is honest but fragmented. `VerifyOutcome`, trust receipt lines, evidence receipts, work-state snapshots, and final events all carry pieces of truth. The smaller contract here binds those pieces into one result and adds a last user-visible delivery check **after** verification. Verification answers "is it evidenced?" Delivery quality answers "is the user's need satisfied by what they see?" The two stages stay distinct.

## 2. Current-state evidence and invariants

All citations below are current at `7203c85`; workers must re-run `nl -ba` or equivalent before editing and record drift rather than silently relying on stale line ranges.

- `src/core/verify.ts` defines the four honest states at `src/core/verify.ts:49`, the injected `VerifyPort` at `src/core/verify.ts:101-116`, the `VerifyOutcome` evidence shape at `src/core/verify.ts:180-214`, and the fail-soft `unverified(...)` helper at `src/core/verify.ts:217-218`.
- Verification already treats an empty diff as no verification and maps missing test command to an unverified state through the port contract at `src/core/verify.ts:55-66,101-115`.
- `buildVerifyReceipt` emits the user-facing verification line from the real outcome at `src/core/verify.ts:238-268`; `composeVerifiedState` keeps tests authoritative and maps critic-only work to `reviewed`, not `passing`, at `src/core/verify.ts:387-398`.
- `src/core/accept-stage.ts` has the bounded repair constant at `src/core/accept-stage.ts:18`, carries candidate data and verification settings at `src/core/accept-stage.ts:35-49`, classifies verification into `passing|failing|unverified` at `src/core/accept-stage.ts:52-95`, and builds repair evidence from the real failed outcome at `src/core/accept-stage.ts:103-115`.
- Accept-stage emits either the trust receipt or the bare verification receipt before final output at `src/core/accept-stage.ts:126-150`.
- Evidence receipt V2 is attached to terminal finals only when `deps.evidenceReceiptV2` is enabled; the attachment point is `src/core/accept-stage.ts:182-214`, and final construction is still a `CoreEvent.final` rather than a completion authority at `src/core/accept-stage.ts:217-260`.
- The accept-stage repair loop verifies, emits evidence, attempts one bounded repair on failing/revise evidence, then verifies again at `src/core/accept-stage.ts:325-366`; exhausted repair produces a failing final path at `src/core/accept-stage.ts:369-397`.
- `src/core/evidence-receipt.ts` is a pure proof-of-done receipt over existing data, not a terminal authority, at `src/core/evidence-receipt.ts:1-8`. Its schema is V2 and maps `VerifyOutcome` to receipt terminal/verdict at `src/core/evidence-receipt.ts:14-38,81-92,170-208`.
- `CoreEvent.final` currently carries `success`, `output`, `tier`, cost, attempts, optional cancellation, optional best-effort, optional blocked record, and optional receipt at `src/core/types.ts:1281-1325`; it does not carry one versioned completion object.
- `OrchestrateDeps` already has `evidenceReceiptV2` and receipt ledger hooks at `src/core/types.ts:371-380`, verification injection at `src/core/types.ts:940-965`, evidence sink hooks at `src/core/types.ts:967-986`, and trust surface configuration at `src/core/types.ts:988-1002`.
- Semantic evidence obligations are currently carried into the turn directive but cannot settle completion at `src/core/orchestrate.ts:1247-1283`.
- Work-call receives the existing call ledger, trust flag, and brain confidence before the accept path at `src/core/orchestrate.ts:2369-2388`; Item 17 must use the same terminal path rather than adding a second final emitter.
- `src/core/trust-receipt.ts` composes only real signals. Its input shape is `TrustSignals` at `src/core/trust-receipt.ts:52-91`; confidence tiers are derived only when verification exists at `src/core/trust-receipt.ts:116-127`; confidence grounds list real files/tests/reviews at `src/core/trust-receipt.ts:133-194`; self-audit gaps name missing tests/cross-checks at `src/core/trust-receipt.ts:226-284`; final receipt composition is at `src/core/trust-receipt.ts:342-390`.
- `src/core/work-state.ts` already refuses to infer done from prose. `WorkStateSnapshot` exposes `verifiedDone` and `claimedNext` separately at `src/core/work-state.ts:43-61`; `GOAL_COMPLETE` is only explicit evidence at `src/core/work-state.ts:70,95-111`; reconstruction populates `verifiedDone` only from done roadmap items, reviewer approval, and GOAL_COMPLETE at `src/core/work-state.ts:138-195`; rendering says "none yet" when evidence is absent at `src/core/work-state.ts:215-239`.
- `src/core/work-contract.ts` mirrors `VerifiedState` for roadmap item verdicts at `src/core/work-contract.ts:16-29`, validates the allowed states at `src/core/work-contract.ts:136-175`, and fail-safes malformed review verdicts to non-approval at `src/core/work-contract.ts:426-466`.
- The existing goal-completion flag helper is inconsistent in comments: early comments describe default-off at `src/interface/ui/truly-complete-flag.ts:14-21`, while the actual function defaults true unless explicitly off at `src/interface/ui/truly-complete-flag.ts:35-57`. Item 17 must not build on that ambiguity; it gets a new explicit default-off flag.
- `src/infra/config.ts` documents `experimentalTrulyComplete` as goal-specific and tied to `MYSHELL_TRULY_COMPLETE` at `src/infra/config.ts:475-490`; Item 17 needs its own config mirror rather than overloading that field.

Baseline at this head:

| surface | current source of truth | Item-17 requirement |
|---|---|---|
| verification | `VerifyOutcome` and `buildVerifyReceipt` | preserved as evidence input, never widened |
| accept/repair | `runCandidateQualityGate` and final event | emits one `CompletionResultV1` before final |
| evidence receipt | `EvidenceReceiptV2` attached optionally | either derived from or embedded under completion, not authoritative |
| trust receipt | pure lines over real signals | reads completion evidence, never overclaims |
| work state | derives `verifiedDone` conservatively | consumes completion result instead of scanning weaker terminal prose |
| goals | goal-specific verified-done gate | consumes completion goal settlement; no model-said-so done |
| resume | not yet one terminal replay decision | receives completion replay policy from 17 -> 10 |
| delivery quality | not a distinct terminal gate | runs after verification and before user-visible final |

## 3. Shared typed contract

Slice 17a must export these names from `src/core/accept-stage.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them. This deliberately uses an existing accept-point module as the single source for Item 17; workers must not create a second completion schema elsewhere.

```ts
export type CompletionResultVersion = 1;

export type CompletionTerminal =
  | 'done'
  | 'answered'
  | 'needs-user'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type CompletionEvidenceStatus =
  | 'verified'
  | 'reviewed'
  | 'unverified'
  | 'failing'
  | 'not-applicable';

export type CompletionScope =
  | 'code-change'
  | 'repo-analysis'
  | 'external-factual'
  | 'conversation'
  | 'goal-work'
  | 'mixed';

export type CompletionRuleCode =
  | 'tests-passing'
  | 'critic-reviewed-no-tests'
  | 'no-test-repo'
  | 'tests-failing'
  | 'tests-timeout-or-error'
  | 'no-diff'
  | 'dirty-baseline-excluded'
  | 'user-edit-conflict'
  | 'repair-exhausted'
  | 'factual-claims-grounded'
  | 'factual-claims-unverified'
  | 'delivery-quality-failed'
  | 'cancelled'
  | 'not-applicable';

export type WorktreeBaselineState =
  | 'clean'
  | 'dirty-known'
  | 'dirty-overlap'
  | 'unknown';

export interface WorktreeBaselineEntry {
  readonly path: string;
  readonly status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown';
  readonly owner: 'pre-existing' | 'assistant' | 'concurrent-user' | 'unknown';
}

export interface CompletionWorktreeState {
  readonly baseline: WorktreeBaselineState;
  readonly baselineEntries: readonly WorktreeBaselineEntry[];
  readonly changedByAssistant: readonly string[];
  readonly excludedPreExisting: readonly string[];
  readonly concurrentUserEdits: readonly string[];
  readonly conflictPaths: readonly string[];
}

export interface CompletionTestEvidence {
  readonly status:
    | 'not-needed'
    | 'detected-not-run'
    | 'no-test-repo'
    | 'green'
    | 'red'
    | 'timeout'
    | 'errored';
  readonly command?: string;
  readonly durationMs?: number;
  readonly outputExcerpt?: string;
}

export interface CompletionRepairEvidence {
  readonly attempted: boolean;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly retestedAfterLastRepair: boolean;
  readonly finalAttemptChangedPaths: readonly string[];
}

export interface CompletionFactualClaimEvidence {
  readonly claimId: string;
  readonly kind: 'local-code' | 'external-source' | 'command-output' | 'test-result' | 'user-provided';
  readonly status: 'grounded' | 'explicitly-unverified' | 'missing' | 'not-required';
  readonly references: readonly string[];
}

export interface CompletionVerification {
  readonly status: CompletionEvidenceStatus;
  readonly verifyOutcome?: VerifyOutcome;
  readonly testEvidence: CompletionTestEvidence;
  readonly repair: CompletionRepairEvidence;
  readonly factualClaims: readonly CompletionFactualClaimEvidence[];
  readonly obligationsSatisfied: readonly string[];
  readonly obligationsUnmet: readonly string[];
  readonly ruleCodes: readonly CompletionRuleCode[];
}

export type DeliveryQualityStatus = 'passed' | 'failed' | 'skipped';

export interface DeliveryQualityIssue {
  readonly code:
    | 'missing-user-answer'
    | 'scope-mismatch'
    | 'overclaim'
    | 'missing-evidence-summary'
    | 'missing-next-action'
    | 'unsafe-or-confusing'
    | 'format-broken';
  readonly message: string;
}

export interface DeliveryQualityResult {
  readonly status: DeliveryQualityStatus;
  readonly checked: boolean;
  readonly issues: readonly DeliveryQualityIssue[];
  readonly nextActionNamed: boolean;
  readonly userVisibleSummary: string;
}

export interface CompletionGoalSettlement {
  readonly allowed: boolean;
  readonly state: 'done' | 'blocked' | 'active' | 'needs-user' | 'none';
  readonly reason: string;
}

export interface CompletionReplayPolicy {
  readonly replay: 'forbidden-already-settled' | 'allowed-idempotent' | 'repair-only' | 'needs-user' | 'unknown';
  readonly reason: string;
}

export interface CompletionResultV1 {
  readonly version: 1;
  readonly id: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly scope: CompletionScope;
  readonly terminal: CompletionTerminal;
  readonly objective: string;
  readonly doneCondition: string | null;
  readonly output: string;
  readonly success: boolean;
  readonly bestEffort: boolean;
  readonly verification: CompletionVerification;
  readonly deliveryQuality: DeliveryQualityResult;
  readonly worktree: CompletionWorktreeState;
  readonly goalSettlement: CompletionGoalSettlement;
  readonly replayPolicy: CompletionReplayPolicy;
  readonly receipt: {
    readonly lines: readonly string[];
    readonly evidenceReceiptV2?: import('./evidence-receipt.js').EvidenceReceiptV2;
  };
  readonly upstream: {
    readonly intentVersionId?: string;
    readonly semanticPreflightVersion?: 1;
    readonly turnPlanId?: string;
  };
}
```

Caps are part of the contract: objective 120 characters; done condition 200; output is the already bounded final output, not duplicated or expanded by completion parsing; delivery issue message 180; user-visible summary 240; replay/goal reason 180; output excerpts 2,000; at most 64 changed/excluded/concurrent/conflict paths each; at most 32 baseline entries in the user-visible receipt but all entries remain in structured test fixtures; at most 16 factual claims; at most 16 obligations satisfied/unmet; at most 12 rule codes; at most 12 receipt lines. IDs must match `/^[a-z][a-z0-9_-]{0,63}$/`. Paths are repo-relative POSIX strings. Extra JSON keys are ignored only by a dedicated parser; constructors must not accept unknown enum values.

Completion construction is pure and exact:

- `version` is always `1`.
- `terminal` is derived from verification, hard-state rules, cancellation, blocked records, and delivery-quality result. It is not copied from `CoreEvent.final.success`.
- `success` is true only for `terminal='done'`, `terminal='answered'`, or `terminal='needs-user'` when the system is honestly asking for user input rather than hiding failure.
- `bestEffort` is true whenever evidence is `unverified`, an obligation is unmet, repair is exhausted, or delivery-quality passes only with explicit limitations. It is never true for `failing`.
- `goalSettlement.allowed` is true only when `terminal='done'` and evidence is `verified` or `reviewed`, with no dirty-overlap or user-edit conflict.
- `replayPolicy.replay='forbidden-already-settled'` only when the completion result is terminally done and mutation evidence is not ambiguous. Otherwise resume receives `repair-only`, `needs-user`, `allowed-idempotent`, or `unknown`.
- `receipt.lines` is derived from real verification, trust, hard-state, and delivery-quality signals. It must not contain a positive test, file, source, or completion claim absent from the structured fields.

## 4. Hard-state completion rules

These rules are load-bearing. A worker may add helper names, but may not change the truth table without amending this contract.

### Dirty Worktree Baseline

Rule: a dirty baseline is not failure by itself, but it limits what Item 17 can claim.

- Capture a baseline before foreground work mutates files. The baseline must include repo-relative path, status, and owner where known.
- Pre-existing dirty paths are excluded from assistant completion evidence unless the assistant explicitly read and intentionally modified that same path after the baseline.
- If the assistant changes only paths that were clean at baseline, completion may be `done` when verification and delivery-quality pass; `excludedPreExisting` must list unrelated dirty paths.
- If the assistant modifies a path that was dirty at baseline and no ownership check proves that overlap was intended, `baseline='dirty-overlap'`, the path enters `conflictPaths`, and completion cannot be `done`.
- If baseline capture fails, `baseline='unknown'`. Code mutation may not be `verified`; at best it can be `reviewed` with a receipt that says the baseline was unknown.

### Concurrent Or Pre-Existing User Edits

Rule: user work is never swallowed into assistant completion.

- Pre-existing edits are those present before work starts. Concurrent edits are changes to paths not opened by the assistant or whose content changed between baseline and completion outside the assistant's captured diff.
- Disjoint concurrent edits are recorded in `concurrentUserEdits` and excluded from claims; they do not block completion.
- Overlapping concurrent edits make completion `needs-user` or `blocked`, never `done`, because the assistant cannot prove which content it completed.
- Verification commands may still run after disjoint edits, but the receipt must say the tests ran against a dirty worktree with named exclusions.
- Goal settlement is false whenever `conflictPaths.length > 0`.

### No-Test Repositories

Rule: no-test is an honest state, not an excuse to fabricate verification.

- If no test command is detected for a code mutation, `testEvidence.status='no-test-repo'`.
- `verification.status` cannot be `verified` in a no-test repo.
- If a diff-scoped critic or equivalent review actually ran and did not request revision, status may be `reviewed`.
- If no test and no review ran, status is `unverified`; code mutation can produce `answered` or `needs-user`, not `done`, unless the user explicitly asked for a draft-only change and delivery-quality labels it as unverified.
- Non-code turns use `testEvidence.status='not-needed'`; they are governed by factual-claim evidence instead.

### Repair And Retest Policy

Rule: the last mutation owns the final evidence.

- The default repair budget remains one bounded repair, matching `MAX_REVISE_RETRIES` at `src/core/accept-stage.ts:18`.
- Repair may start only from negative evidence: failing tests or a parsed critic `revise`.
- After repair changes any path, completion cannot reuse the pre-repair green/red/review result as final evidence. It must rerun the required test/review path or mark `retestedAfterLastRepair=false`.
- If the post-repair test is green, status may become `verified`.
- If the post-repair test is red, completion is `failed` or `blocked`; it is never best-effort done.
- If repair exhausts without decisive evidence, rule code includes `repair-exhausted`, terminal is `blocked` or `answered` with `bestEffort=true`, and the next action must name the failing evidence.

### Non-Code Factual Claims

Rule: claims about current external facts or repo facts require observed evidence or explicit uncertainty.

- A claim about the current repo requires local-code evidence from files actually read, command output, or a prior accepted completion result that names the path.
- A fresh/current external claim requires external-source evidence. Local cache or model memory is not enough.
- A non-code factual answer with all required claims grounded may be `answered` with `verification.status='not-applicable'` and factual claim statuses `grounded`.
- If an unsupported claim is still useful and is explicitly labeled `Unverified:`, the claim status is `explicitly-unverified`, terminal may be `answered`, and `bestEffort=true`.
- If an unsupported factual claim is presented without that label, delivery-quality fails for overclaim and the terminal result cannot be emitted as successful until the response is repaired or blocked.

## 5. Folded Delivery-Quality Gate

Delivery-quality is a distinct stage after verification and before the user-visible final is emitted.

Verification answers: **is the work evidenced?**

Delivery-quality answers: **is the user's need satisfied in what they see?**

The gate checks only the response/work-product the user sees. It does not rerun tests, reinterpret diffs, or upgrade evidence. It reads the candidate output plus `CompletionVerification`, `CompletionWorktreeState`, objective, done condition, and blocked/cancelled state.

It must check:

- scope: the answer addresses the user's actual request and does not substitute adjacent work;
- completeness: the answer includes the material result, not just a vague status;
- evidence alignment: it names tests/review/unverified/failing state consistently with structured evidence;
- non-overclaiming: it never says "done", "verified", "fixed", "safe", or "green" beyond the evidence;
- hard-state disclosure: dirty baseline exclusions, user-edit conflicts, no-test status, repair exhaustion, and unverified factual claims are surfaced when relevant;
- next action: for `blocked`, `failed`, `needs-user`, `unverified`, or `reviewed-no-tests`, the visible response names the concrete next action or limitation;
- format: text is not empty, not internally contradictory, and not dominated by receipts at the expense of the answer.

Pass/fail states:

- `passed`: all checks pass, or only limitations already named in the response remain.
- `failed`: one or more issues would mislead the user or leave the requested need unanswered.
- `skipped`: allowed only for cancellation before any user-visible work product, or for a terminal structured question where the question itself is the product.

Failure policy:

- Delivery-quality cannot turn failing/unverified evidence into completion.
- If the issue is response-only and deterministic repair is possible, rewrite the final response from structured facts and rerun the delivery-quality check once.
- If the issue requires new evidence or a new mutation, do not patch prose around it. Terminal becomes `blocked` or `needs-user` with the missing evidence named.
- A `failed` delivery-quality result may be present in `CompletionResultV1` only when the terminal itself is not successful.

## 6. Shared rollout, fixture, worktree, eval, and rollback rules

The runtime flag is `MYSHELL_COMPLETION_RESULT_V1`; the config mirror is `experimentalCompletionResultV1?: boolean`. Both are default false. The folded delivery-quality gate is included under the same flag and must not receive a separate default-on path.

When the flag is off, current verification, trust, evidence receipt, goal, resume, and UI behavior remains byte-for-byte current except for tests that inject pure constructors directly. When the flag is on, the accept point constructs one completion result and downstream consumers read it instead of deriving terminal truth from prose, receipts, or `success` alone.

Rollback is: unset `MYSHELL_COMPLETION_RESULT_V1`, set `experimentalCompletionResultV1:false`, restart the process, and confirm terminal `CoreEvent.final` payloads no longer contain `completionResult`. Existing optional evidence receipts remain additive and readable. No migration may be required for rollback.

Every implementation slice must begin with:

```bash
git status --short
git diff --name-only
npm run typecheck
```

Record pre-existing paths and do not edit them unless the slice contract names them. A slice is rejected if `git diff --name-only` contains a path outside that slice's maximum set. No generated eval artifact under `.tmp/` is committed.

Every slice must include success, failure, cancellation, and injected-crash fixtures unless the slice is pure and explicitly marks cancellation/crash N/A. "Injected crash" means a dependency throws at the named boundary. Do not use `process.exit`, kill the test runner, or add sleeps.

### Eval and acceptance gate

Default-on is not authorized by this contract. Dark implementation is accepted only when the Item-17 eval artifact passes all thresholds:

- at least 60 fixtures: 15 code-change, 10 no-test, 10 dirty/concurrent-edit, 10 repair/retest, 10 non-code factual, 5 cancellation/blocked;
- 100% terminal truth accuracy against expected `CompletionTerminal`;
- 100% no-overclaim accuracy: no fixture with missing/failing evidence may emit a successful done/verified claim;
- 100% goal-settlement accuracy for done/blocked/active/needs-user;
- 100% replay-policy accuracy for already-settled, repair-only, and needs-user cases;
- delivery-quality catches every seeded overclaim and missing-next-action case;
- flag-off snapshots are unchanged for current terminal finals, receipts, and goal behavior.

The eval command is added by the implementation slice and writes an uncommitted JSON artifact under `.tmp/completion-result-v1/`. The promotion receipt must include fixture count, artifact path, hash, date, git head, and exact commands.

## 7. Ordered slices

### P1-17a - `COMPLETION-DOMAIN`

**One invariant:** a completion result is complete, versioned, parseable, capped, and cannot express a successful `done` state without evidence and delivery-quality permission.

**Preconditions/dependencies:** existing `VerifyOutcome`, `EvidenceReceiptV2`, `CoreEvent.final`, and `BlockedRecord` types. No runtime wiring.

**Maximum file set (exhaustive):**

- `src/core/accept-stage.ts`
- `test/unit/accept-stage.test.ts`
- `test/unit/completion-result.test.ts` (new)

**Behavioral diff:** add the shared `CompletionResultV1` types, parser, cap helpers, `completionFromVerifiedCandidate(...)`, `completionFromBlockedFinal(...)`, and `completionFromCancellation(...)`. Existing final emission remains unchanged unless the helper is called by tests.

**Named tests:**

- `builds a complete V1 result from passing verification`
- `rejects missing version terminal verification delivery quality or replay policy`
- `caps objective reasons claims paths receipt lines and delivery issues`
- `failing verification cannot construct terminal done`
- `unverified code mutation becomes answered or blocked not done`
- `reviewed no-test mutation is reviewed not verified`
- `delivery-quality failure prevents successful terminal`
- `parse ignores extra keys but rejects unknown enums`

**Fixtures:** success = passing tests; failure = red tests/unverified code; cancellation = pure helper for cancelled final; injected crash = parser inputs that throw on property access must return a rejected parse, not throw.

**Per-slice verification receipt:** exact commands, changed files, and assertions proving no runtime caller exists. Required:

```bash
npm run typecheck && npm run lint -- src/core/accept-stage.ts test/unit/accept-stage.test.ts test/unit/completion-result.test.ts && npx vitest run test/unit/accept-stage.test.ts test/unit/completion-result.test.ts
```

### P1-17b - `WORKTREE-BASELINE-AND-USER-EDITS`

**One invariant:** completion distinguishes assistant work from pre-existing or concurrent user edits before it claims done.

**Preconditions/dependencies:** 17a. Existing verification port remains fail-soft.

**Maximum file set (exhaustive):**

- `src/core/verify.ts`
- `src/core/accept-stage.ts`
- `src/infra/verify-port.ts`
- `test/unit/verify.test.ts`
- `test/unit/verify-port.test.ts`
- `test/unit/completion-result.test.ts`

**Behavioral diff:** extend captured verification input to carry a pre-work baseline and post-work changed-path ownership. The pure completion helper maps clean, dirty-known, dirty-overlap, unknown, disjoint concurrent edit, and overlapping concurrent edit states to the hard-state rules. Existing `VerifyOutcome` semantics stay compatible; any new fields are optional and ignored off-flag.

**Named tests:**

- `clean baseline plus green tests may complete done`
- `pre-existing unrelated dirty path is excluded but does not block`
- `assistant overlap with dirty baseline blocks goal settlement`
- `disjoint concurrent user edit is named and excluded`
- `overlapping concurrent edit returns needs-user not done`
- `baseline capture failure cannot claim verified code completion`
- `flag-off verify receipt remains unchanged`

**Fixtures:** success = clean and dirty-disjoint; failure = dirty-overlap and overlapping concurrent edit; cancellation = abort before post-work capture; injected crash = baseline port throws and completion degrades to unknown/unverified.

**Per-slice verification receipt:** include before/after fixture table for every worktree state and proof that flag-off receipt strings are unchanged.

### P1-17c - `COMPLETION-RULES-IN-ACCEPT-STAGE`

**One invariant:** accept-stage emits one completion result after verification/repair and before any final event when the flag is injected.

**Preconditions/dependencies:** 17a-17b. Existing repair loop and receipt events remain ordered.

**Maximum file set (exhaustive):**

- `src/core/accept-stage.ts`
- `src/core/types.ts`
- `src/core/evidence-receipt.ts`
- `test/unit/accept-stage.test.ts`
- `test/unit/evidence-receipt.test.ts`
- `test/unit/completion-result.test.ts`

**Behavioral diff:** add optional `completionResult?: CompletionResultV1` to terminal final events under injected flag. The accept-stage repair loop records repair attempts, retest-after-repair state, final evidence, and hard-state rule codes. EvidenceReceiptV2 is nested under `completionResult.receipt.evidenceReceiptV2` when both flags are on; the old final receipt remains present for flag-off compatibility.

**Named tests:**

- `one completion result is attached to successful final after green tests`
- `repair changes require retest before verified completion`
- `post-repair red tests produce failed or blocked completion`
- `repair exhaustion names next action and bestEffort`
- `reviewed critic-only result cannot say tests passed`
- `evidence receipt and completion agree on verdict`
- `receipt callback crash cannot suppress completion construction`
- `flag off final payload is snapshot-equal`

**Fixtures:** success = green first try and green after repair; failure = red after repair, critic revise after repair; cancellation = candidate cancelled before verify; injected crash = evidence receipt builder throws or repair generator throws.

**Per-slice verification receipt:** include exact final event snapshots with and without the flag and a reconciliation table: `VerifyOutcome.verified -> CompletionEvidenceStatus -> CompletionTerminal`.

### P1-17d - `NON-CODE-FACTUAL-COMPLETION`

**One invariant:** non-code factual answers are completed by grounded claims or explicit unverified labels, never by model confidence.

**Preconditions/dependencies:** 17c and Item 8 evidence receipt wiring where present. No new retrieval policy is created here.

**Maximum file set (exhaustive):**

- `src/core/orchestrate.ts`
- `src/core/accept-stage.ts`
- `src/core/trust-receipt.ts`
- `test/unit/orchestrate-evidence-sensitive.test.ts`
- `test/unit/trust-receipt.test.ts`
- `test/unit/completion-result.test.ts`

**Behavioral diff:** thread observed local/web evidence and semantic before-completion obligations into completion construction for lookup/analysis/decision turns. Factual claims are categorized as grounded, explicitly-unverified, missing, or not-required. Trust receipts may mention unverified claim gaps only when completion structured fields prove them.

**Named tests:**

- `repo claim grounded by actual read path completes answered`
- `invented repo path fails delivery quality`
- `fresh external claim requires external receipt`
- `explicit Unverified external claim may answer bestEffort`
- `missing factual evidence blocks overclaim`
- `semantic before-completion obligation remains unmet until verified`
- `conversation without factual claims is not forced through evidence`

**Fixtures:** success = local read and external source; failure = missing evidence and invented reference; cancellation = abort during evidence collection; injected crash = evidence receipt accessor throws.

**Per-slice verification receipt:** list claim fixture IDs, expected claim statuses, and emitted user-visible wording for every unverified case.

### P1-17e - `DELIVERY-QUALITY-GATE`

**One invariant:** the final response the user sees is scoped, complete, evidence-aligned, non-overclaiming, and names the next action when completion is not cleanly done.

**Preconditions/dependencies:** 17c-17d. Runs after verification; does not open a provider stream.

**Maximum file set (exhaustive):**

- `src/core/accept-stage.ts`
- `src/core/trust-receipt.ts`
- `test/unit/accept-stage.test.ts`
- `test/unit/trust-receipt.test.ts`
- `test/unit/completion-result.test.ts`

**Behavioral diff:** add pure `evaluateDeliveryQuality(...)` and one deterministic response-repair pass for response-only failures. The gate reads completion evidence and the candidate final text. It may fail a response for overclaiming, missing next action, missing evidence summary, scope mismatch, or empty/broken output. It cannot upgrade evidence.

**Named tests:**

- `passing tests but vague final fails missing user answer`
- `red tests with done wording fails overclaim`
- `no-test reviewed final passes only when it says no tests ran`
- `blocked final passes when it names the next action`
- `unverified factual answer passes only with explicit Unverified label`
- `deterministic response repair runs once and preserves evidence`
- `delivery-quality skipped only for cancellation or structured question`

**Fixtures:** success = scoped final with correct evidence; failure = seeded overclaims and missing next action; cancellation = cancelled final skips; injected crash = quality evaluator throws and completion degrades to blocked with issue recorded.

**Per-slice verification receipt:** include a table of before/after visible final text for repaired response-only cases and proof no model calls were added.

### P1-17f - `DOWNSTREAM-CONSUMERS`

**One invariant:** chat, goals, resume, work-state, and UI read terminal truth from `CompletionResultV1`, not from prose or a receipt line.

**Preconditions/dependencies:** 17e. Item 10 is not implemented; this slice only exposes the replay policy to current resume surfaces.

**Maximum file set (exhaustive):**

- `src/core/types.ts`
- `src/core/work-state.ts`
- `src/core/goal-manager.ts`
- `src/core/goal-steward.ts`
- `src/core/scheduler.ts`
- `src/core/history.ts`
- `src/interface/render.ts`
- `src/interface/menu-render.ts`
- `src/interface/menu-goal-review.ts`
- `test/unit/work-state.test.ts`
- `test/unit/goal-manager.test.ts`
- `test/unit/goal-steward.test.ts`
- `test/unit/run.test.ts`
- `test/unit/menu-render.test.ts`
- `test/unit/resume-transcript.test.ts`
- `test/unit/completion-result.test.ts`

**Behavioral diff:** downstream consumers prefer `completionResult` when present. Work-state `verifiedDone` is populated from `goalSettlement.allowed` and evidence status, not from final prose. Goals can mark done only through `goalSettlement.allowed`. Resume transcript surfaces `replayPolicy` but does not implement Item 10's durable state machine.

**Named tests:**

- `goal done requires completion goalSettlement allowed`
- `goal remains active on unverified code completion`
- `work-state ignores final prose done when completion says answered`
- `resume transcript names repair-only replay policy`
- `UI label says reviewed not verified for critic-only no-test work`
- `chat final keeps existing output while receipt comes from completion`
- `flag-off consumers keep legacy behavior`

**Fixtures:** success = done/answered/needs-user; failure = prose says done but completion says blocked; cancellation = cancelled completion; injected crash = renderer cannot format receipt and falls back to safe output.

**Per-slice verification receipt:** include consumer matrix proving every downstream terminal decision reads `completionResult` when present.

### P1-17g - `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag composes CompletionResult V1 across interactive, one-shot, and REPL entry points, and rollback restores legacy finals.

**Preconditions/dependencies:** 17f and green Item 8/9/5 guard suites where applicable.

**Maximum file set (exhaustive):**

- `src/infra/config.ts`
- `src/interface/menu.ts`
- `src/interface/run.ts`
- `src/interface/repl.ts`
- `src/core/types.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `test/unit/global-call-budget-receipt.test.ts`
- `test/unit/completion-result.test.ts`
- `test/unit/completion-result-flag.test.ts` (new)

**Behavioral diff:** add `experimentalCompletionResultV1?: boolean`, parse `MYSHELL_COMPLETION_RESULT_V1`, pass `completionResultV1:true` to core only when explicit env/config true, and keep all existing final event shapes when absent/false/garbage. Delivery-quality is included under the same flag.

**Named tests:**

- `completion result flag defaults false for absent false zero and garbage`
- `explicit env or config true enables completion result`
- `interactive one-shot and REPL flag off finals match legacy snapshots`
- `flag on emits exactly one completion result per terminal foreground turn`
- `flag on cancellation emits cancelled completion result`
- `receipt callback throw remains fail-soft`
- `rollback by unsetting flag restores legacy final shape`

**Fixtures:** success = each entry point; failure = malformed completion construction; cancellation = user interrupt; injected crash = flag parser or receipt callback throws.

**Per-slice verification receipt:** include flag-off snapshot hashes and flag-on terminal result counts by entry point.

### P1-17h - `EVAL-AND-AUTHORITY-GUARDS`

**One invariant:** no default-on, goal-settlement, resume, or UI path can bypass the versioned completion result when the flag is on.

**Preconditions/dependencies:** 17g. Default remains off.

**Maximum file set (exhaustive):**

- `src/core/accept-stage.ts`
- `test/arch/completion-result-authority-guard.test.ts` (new)
- `test/unit/completion-result.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `docs/r7-item17-completion-contract.md`

**Behavioral diff:** add an authority guard that rejects new terminal `done`/goal-settlement/replay decisions under the flag unless they consume `CompletionResultV1`. Add the eval fixture runner required by section 6. Record the dark implementation acceptance receipt in this document only after artifacts pass; until then leave this section unfilled.

**Named tests:**

- `terminal done decisions under flag reference completion result`
- `goal settlement under flag references completion goalSettlement`
- `resume replay labels under flag reference completion replayPolicy`
- `delivery-quality overclaim eval fixtures all fail`
- `flag-off snapshots remain unchanged`

**Fixtures:** success = 60+ eval fixtures; failure = synthetic bypass and overclaim; cancellation = cancelled terminal fixture; injected crash = truncated eval artifact fails closed.

**Per-slice verification receipt:** artifact path and hash, fixture counts, exact commands, guard output, and no-default-change proof.

## 8. Named upstream and downstream contract edges

### Edge `8k->17` - semantic obligations into completion

Producer: Item 8 semantic preflight and evidence investigation.

Payload consumed by Item 17:

- semantic objective and done condition;
- `EvidenceDecision.beforeCompletion`;
- observed `EvidenceReceiptV1` values;
- explicit unverified factual-claim labels.

Rule: Item 17 may satisfy, carry, or fail those obligations from real verification/evidence. It must not silently drop them or mark them complete because Item 8 predicted them.

### Edge `17->10` - completion replay policy into exactly-once resume

Producer: `CompletionResultV1.replayPolicy`.

Consumer: Item 10 durable execution/resume state machine.

Rule: Item 10 may forbid replay, allow idempotent replay, restrict to repair-only, require user input, or mark unknown only from this field plus its own durable work-unit state. It must not infer replay safety from final prose or tests alone.

### Edge `17->13` - goal settlement into goal stewardship

Producer: `CompletionResultV1.goalSettlement`.

Consumer: Item 13 goal stewardship and multi-goal DAG.

Rule: a goal node may advance dependent nodes only when `goalSettlement.allowed=true` and `state='done'`. Blocked, needs-user, answered, reviewed-only-with-unmet-obligations, dirty-overlap, or unverified states keep the goal active/blocked according to the structured reason.

## 9. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npm run typecheck
npx vitest run test/unit/accept-stage.test.ts test/unit/verify.test.ts test/unit/trust-receipt.test.ts test/unit/work-state.test.ts test/unit/evidence-receipt.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A Vitest pass with missing hard-state fixtures, no cancellation/crash case, or no flag-off snapshot is not acceptance.

Item 17 is implemented dark when 17h is green. It is **not** default-promoted by this contract. The implementation satisfies Item 17 only if all of the following are simultaneously true:

- every terminal foreground turn under the flag has exactly one `CompletionResultV1`;
- chat, goals, resume, work-state, and UI consume that result rather than deriving terminal truth independently;
- dirty baseline, pre-existing edits, concurrent edits, no-test repos, repair/retest, and non-code factual claims have explicit rule-coded outcomes;
- `passing` still means tests executed green, and `reviewed` never reads as test-verified;
- post-repair evidence comes from the post-repair state, not a stale pre-repair result;
- delivery-quality runs after verification and cannot upgrade evidence;
- successful visible responses are scoped, complete, non-overclaiming, and name the next action when completion is not cleanly done;
- flag-off rollback restores legacy final payloads and goal behavior without migration;
- the eval gate in section 6 passes with recorded artifact hashes;
- named edges `8k->17`, `17->10`, and `17->13` are represented in tests and receipts.

## 10. Adversarial self-challenge and fixes

**Challenge 1: could this create more ceremony while users still see the same weak answer?** Yes, if `CompletionResultV1` is attached but renderers keep reading `success` and prose. Fix: 17f and 17h make downstream consumption and authority guards mandatory. A completion object not consumed by chat/goals/resume/UI is not Item 17.

**Challenge 2: could delivery-quality become a second verifier and blur evidence?** Yes, if it tries to judge correctness from prose. Fix: delivery-quality can only fail or repair response wording; it cannot upgrade evidence, rerun proof, or convert reviewed/unverified into verified.

**Challenge 3: could dirty worktree handling block too much useful work?** Yes, if any dirty baseline becomes automatic failure. Fix: disjoint pre-existing/concurrent edits are excluded and disclosed, not blocked. Only overlap or unknown ownership prevents done.

**Challenge 4: could no-test repos never complete anything?** Yes, if "verified" is the only acceptable state. Fix: code changes in no-test repos may complete as `reviewed` when a real review ran and delivery-quality names the limitation. They may not claim test verification.

**Challenge 5: could repair hide failed work by returning best-effort prose?** Yes, if repair exhaustion still sets success. Fix: post-repair red tests are failed/blocked, not best-effort done; unverified exhaustion must name next action and set `bestEffort=true` only on non-done terminal states.

**Challenge 6: could factual claim grounding overreach into every casual answer?** Yes, if every sentence becomes an evidence obligation. Fix: only current repo facts, current external facts, and semantic evidence obligations require claim evidence. Ordinary conversation and clearly subjective guidance use `not-applicable`.

## 11. North-star drift check

Does this move toward "one chat, elite pro" or add ceremony?

It moves toward the north-star if implemented as the single terminal truth. A professional assistant knows the difference between done, answered, reviewed, unverified, blocked, and failed; protects user edits; does not fake tests; and hands resume/goals one durable answer.

It adds ceremony if downstream consumers ignore the result, if delivery-quality becomes another vague model opinion, or if receipts get longer without changing terminal decisions. The guardrail is concrete: one object, one flag, one eval gate, one rollback, and downstream consumers must delete their independent completion guesses.
