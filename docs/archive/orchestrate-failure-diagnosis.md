# Orchestration failure diagnosis: good answer reported as "● Failed"

## The observed defect (live)

A one-shot `run` on a real codebase — *"summarize the socials page + top gaps,
reading 3 specific files"* — produced **3 good, complete reports** (it re-read the
files each attempt and each time produced a solid answer), yet the run ended:

```
● Failed — tier: ic, 160.7k tokens, attempts: 3, session: cecfc1f6-…
```

So it (a) stayed at the IC tier, (b) ran 3 attempts (= default `maxAttempts`),
(c) burned ~160k tokens re-doing the same expensive investigation, and
(d) reported **FAILURE while throwing away good work**.

## Root cause

### Primary bug — the loop discards a usable answer as `success:false`

`src/core/orchestrate.ts`, the loop-exhaustion final (was **line 1339**, the final
statement after `mainLoop`). When `while (attempts < maxAttempts)` runs out, the
function unconditionally yielded:

```ts
yield { type: 'final', success: false, output: lastOutput, tier: currentTier, … };
```

This fires **even when a fully-successful provider run produced a substantive
answer**. The good output is sitting in `lastOutput` / `acceptedRun` (an
`AcceptedRunSessionData` that is set **only on an errorless run**, line 783–795),
but the exhaustion path reports `success:false` and the renderer
(`src/interface/render.ts:842`) prints the red **"Failed"** banner. The good work
is discarded and never appended to the session.

### The path that fired for `tier:ic, attempts:3, good-output`

The only way to reach loop exhaustion **without escalating tier and without
accepting** is the **cross-vendor review `revise` verdict**:

1. The task classifies at **IC** (`"summarize … reading 3 files"` → ic).
2. Each IC attempt produces a good answer but **honestly hedges**: a low-confidence
   envelope with `needs_review:true` (e.g. *"unclear from these files alone"*).
   `assess()` parses it faithfully (`src/core/assess.ts`).
3. `shouldReview(...)` (orchestrate.ts:71) returns **true** because
   `assessment.needsReview === true` (under the default `reviewPolicy:'auto'`).
4. The cross-vendor reviewer runs and returns **`revise`**
   (`parseReviewVerdict`, `src/core/review.ts`).
5. The `revise` branch (was orchestrate.ts:1200–1203) did:
   ```ts
   if (verdict.verdict === 'revise') { managerNotes = verdict.notes; continue mainLoop; }
   ```
   It **stays on the same tier** and re-runs — with **no cap on how many times**.
   `reviewedAttempts` only prevents reviewing the *same attempt index* twice; it
   does **not** bound total revise cycles. So each new attempt re-runs the full
   investigation, gets reviewed again, and gets `revise` again.
6. After attempt 3, `3 < 3` is false → the loop exits → the exhaustion final
   yields `success:false` with the good `lastOutput` **discarded as Failed**.

That is why it **stayed at IC** (revise never escalates the tier), ran **exactly
`maxAttempts`** times, and burned **~160k tokens** (each revise re-runs the entire
expensive file-reading investigation from scratch).

> Note on the confidence path: a *low-confidence-without-review* turn does **not**
> exhaust the loop. When confidence escalation is denied (`escalateTo === null`)
> the code falls through to the **accept** path (orchestrate.ts §4) and returns
> `success:true`. Only the **`revise`** verdict produces a same-tier, non-accepting
> `continue` — so the `revise` loop is the firing path, confirmed by reproduction.

### Reproduction (unit-level, deterministic)

A fake IC provider that always returns a good answer with a low-confidence,
`needs_review:true` envelope, plus a fake cross-vendor reviewer that always returns
`revise`, drives the loop to exhaustion. Before the fix this asserted the buggy
shape: **`final.success === false` with a non-empty `output`** (the good answer),
`attempts: 3`, and 3 IC runs. See the new tests in
`test/unit/orchestrate.test.ts` (`describe('orchestrate — best-effort on loop
exhaustion …')`).

## The fix (surgical, principled)

Two changes in `src/core/orchestrate.ts`, one type field, one honest render line.

### 1. Never discard a usable answer as "Failed" (the cardinal rule)

The loop-exhaustion final now distinguishes **answered** from **genuinely failed**:

```ts
if (acceptedRun !== undefined && acceptedRun.content.trim().length > 0) {
  await appendAcceptedAssistant(deps, acceptedRun);          // persist the work
  const memoryProposal = memoryProposalFor(acceptedRun.content);
  yield { type:'final', success:true, output:acceptedRun.content,
          tier:currentTier, …, bestEffort:true, …(memoryProposal ? {memoryProposal} : {}) };
  return;
}
// else: no usable output → the existing success:false failing final (unchanged)
```

`acceptedRun` is set **only on an errorless provider run** with non-empty content,
so it is the precise "we have a real answer" signal. A best-effort success is
persisted to the session like any accepted turn, carries any model-proposed
memory, and is flagged `bestEffort:true`. `success:false` is now reserved for
**genuine** no-output failures (auth/timeout/empty — all of which already returned
earlier with their own honest finals; the only way to reach exhaustion with **no**
`acceptedRun` is the `break mainLoop` on an execution error with no untried vendor,
which correctly still fails).

### 2. Bound the wasteful re-execution (don't blind-loop the heavy work)

The `revise` branch now allows **one** revise re-run (apply the reviewer's notes
once), then stops blind re-execution:

- If a **stronger tier** is admissible, escalate to it (a better model is the right
  response to persistent dissatisfaction — not re-running the same model).
- If escalation is blocked (top tier, or admission denied — e.g. Efficient /
  free-plan veto), **accept the best answer we already have** as a flagged
  best-effort success, with an honest notice.

This caps the runaway at ~2 heavy runs instead of `maxAttempts`, directly
addressing the ~160k-token burn, while still letting the reviewer's first round of
notes improve the answer.

### 3. Honest surfacing

- `src/core/types.ts`: new optional `readonly bestEffort?: true` on the `final`
  event (documented; absent on a normal fully-accepted success).
- `src/interface/render.ts`: on a `bestEffort` success, a yellow line —
  *"Best-effort answer — reached the attempt limit without a fully-confident
  result; treat the above as unverified."* — so the user is never misled into
  treating it as a clean success. Genuine failures still render the red "Failed"
  banner unchanged.

## What is preserved (no regressions)

- The **`ask_user` / question short-circuit** (orchestrate.ts §0) is untouched.
- Every existing **accept** path (normal accept, review-approve, ceiling-accept)
  is untouched.
- **Genuine failure reporting** is untouched: auth, timeout, cancellation, and
  no-output error breaks still yield `success:false` with their existing
  categories/notices.
- `menu.ts` input/raw-mode internals were not touched.

## New tests (`test/unit/orchestrate.test.ts`)

1. **low-confidence-but-answered at the attempt ceiling returns the answer (best-effort),
   NOT Failed** — IC keeps answering with low confidence + `needs_review`, reviewer
   keeps saying `revise`, never-auto admission pins it at IC. Asserts:
   `success:true`, `bestEffort:true`, the good output is returned, `tier:'ic'`, the
   answer is appended to the session, and **at most 2 IC runs** (re-execution
   bounded).
2. **a genuinely-errored turn (no usable output) still fails** — the only provider
   errors every attempt with no untried/authed vendor. Asserts `success:false` and
   `bestEffort !== true` — best-effort never masks a real failure.

## Final gate result

Run under Node 22.19.0:

- `typecheck` — clean (`tsc --noEmit`)
- `lint` — clean (`eslint src test`)
- `test` — **2985 pass / 0 fail / 0 skipped** (was 2983; +2 new tests)
- `build` — clean (`tsc`)

## Residual uncertainty

- The exact live envelope wasn't captured, so whether the live run reached the
  `revise` loop specifically via `needs_review:true` or via a high-risk
  classification is inferred (both routes hit the same unbounded `revise` →
  exhaustion → discard path; the reproduction uses `needs_review:true`, the
  cheapest trigger). The **defect and fix are tier/trigger-agnostic**: any path
  that exhausts `maxAttempts` with a substantive `acceptedRun` now returns the
  answer rather than discarding it.
- The `MAX_REVISE_RETRIES = 1` cap is a judgement call (one round of reviewer
  notes, then escalate-or-accept). It is deliberately conservative; if real usage
  shows a second revise round routinely improves answers, the constant is the one
  knob to revisit.
