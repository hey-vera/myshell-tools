# Adjudication: `cannot-ground` Evidence Decisions

## Ruling

`cannot-ground` must PROCEED, not hard-block, but only as an explicitly unverified turn.

The correct contract is:

- actionable pre-work obligations still block: `user-input`, `local`, and `web` with `mayStartWork:false` must stop until the user answers or the available collector has produced a real receipt;
- `cannot-ground` means the orchestrator has determined evidence is needed but this runtime cannot gather it, so the turn may run, persist the semantic intent row, and call work;
- the result must be labeled honestly and must not be counted as verified or complete for the missing evidence.

This rules in favor of the R7-P1-08f persistence expectation on whether work proceeds, and against the R7-P1-08i zero-work hard-stop expectation for missing capability. It does not allow silent fallthrough.

## Why

The north-star is "one chat that gets work done" and "never fake." A hard stop on missing grounding capability satisfies "never fake" only by refusing to work. That is the wrong default shape for an assistant that is meant to remain useful across entry points and degraded capability configurations.

This matters especially because Item 8k intends semantic preflight to become default-on. If default-on semantic preflight hard-blocks `cannot-ground`, then a normal user whose entry point has no `researchPort` wired will see ordinary codebase analysis/change turns terminate before the provider is called. In this checkout, deterministic evidence floors can synthesize `DET_LOCAL` for code claims/changes and `DET_WEB` for current external facts. With no research port, those become `cannot-ground`. Blocking there would convert a missing helper capability into a product-wide refusal mode.

Proceeding is acceptable only because Item 17 honesty rules separate work execution from verified completion. The verification vocabulary in this codebase is explicit: `passing` requires real green tests, `reviewed` is weaker than passing, `failing` is negative evidence, and `unverified` is the honest default when verification/evidence did not run or crashed. The Item 8 handoff says evidence obligations can be pending or unmet but never silently complete. Therefore `cannot-ground` is not "grounded enough"; it is "work may continue, but the missing evidence remains unmet/unverified."

## Interpretation Of The Evidence Model

`decideEvidenceInvestigation` has two different categories of `mayStartWork:false`:

1. An actionable blocker: `beforeWork` is `user-input`, `local`, or `web`. The system knows what must happen before work and has the user or capability path to attempt it. These should block, gather, ask, or stop after failed/cancelled collection.
2. A non-actionable grounding gap: `beforeWork` is `cannot-ground`. The system believes evidence is needed, but there is no available collector or policy path to obtain it in this runtime.

Those categories should not share the same hard-stop behavior. `cannot-ground` must preserve the gap rather than pretend it was satisfied.

## Judgment On The Worker Fix

The worker's guard change is directionally correct but incomplete.

Changing:

```ts
if (!evidenceDecision.mayStartWork)
```

to:

```ts
if (evidenceDecision.beforeWork !== 'cannot-ground' && !evidenceDecision.mayStartWork)
```

is the right control-flow split for "do we call work?" It is not a complete contract implementation. As currently shaped, it can let `cannot-ground` proceed with no receipt, no rendered evidence gap, no warning, and no guarantee that the final answer is labeled `Unverified:`. The rewritten 08i test that only asserts `p.calls === 1` is too weak and would green a silent fake-grounding regression.

The fix needs additional assertions and code so the result is not "run work and pretend it is verified."

## Required Behavior

For `cannot-ground`:

- append the intent version row, including the semantic preflight evidence need and done condition;
- run the work call;
- carry an explicit prompt block into work, e.g. `UNVERIFIED EVIDENCE GAP`, with the decision reason and the relevant required evidence need if available;
- emit a warning/notice or otherwise surface the gap before or in the final answer;
- require unsupported factual/current/codebase claims to be labeled with a sentence beginning `Unverified:`;
- if no observed receipt exists for a lookup/analysis/decision grounding requirement, `require_observed_grounding` must not become a no-op merely because `evidenceReceipts` is empty;
- completion/receipt state must be `unverified` or pending/unmet, never `passing`, never `reviewed`, and never goal-done solely from provider prose.

For actionable blockers:

- `user-input` remains a pre-provider ask/final with zero work calls until a real user-turn observation exists;
- `local` and `web` run the collector when available;
- cancellation remains cancelled with zero work calls;
- failed/missing collector receipts do not become obtained evidence and should stop or repair according to the actionable evidence path, not silently proceed as grounded.

## User-Facing Labeling

The final answer must be honest in Item 17 terms.

Acceptable examples:

- `Unverified: I could not read the local repository evidence required for this claim because no local read capability is available. Based on the prompt alone, ...`
- `Unverified: I could not look up current external facts because web search is unavailable. Treat the version/status claim below as unverified. ...`
- `I made the requested change, but verification is unverified: the required local evidence/test obligation could not run in this environment.`

Unacceptable examples:

- `Verified`, `confirmed`, `tests pass`, `I inspected src/...`, or `done` when the only basis is model prose;
- a codebase/current-fact answer with no observed receipt and no `Unverified:` label;
- marking an Item 17 completion obligation complete without a versioned completion result backed by real evidence.

The work may be useful and the `CoreEvent.final.success` may remain true for an accepted best-effort answer, but the evidence/completion verdict must remain `unverified` and the obligation must remain pending/unmet. Goal completion must not advance to done from this state.

## Test Contract

The corrected 08i test should assert more than `p.calls === 1`:

- work is called exactly once for `cannot-ground`;
- the prompt contains the missing evidence/gap reason or an evidence obligation block;
- the final output starts with or contains an explicit `Unverified:` label when it makes the unsupported claim;
- no observed receipt is fabricated;
- any receipt/completion/goal verdict exposed for the turn is `unverified` or pending/unmet, not `passing`, `reviewed`, or done.

The persistence test remains valid: inability to preflight-ground must not prevent the intent row from being appended or the turn from doing useful work.

## Note On Referenced Docs

`docs/r7-item17-completion-contract.md` is not present in this checkout. This ruling uses the Item 17 handoff language in `docs/r7-item8-semantic-preflight-contract.md` plus the implemented honesty vocabulary in `src/core/verify.ts`, `src/core/accept-stage.ts`, and the verified-done gate tests.
