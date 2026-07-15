# ROADMAP-STATUS

Compact current-state record. The user-designated implementation authority is `CLAUDEPLAN.md`.

_Updated 2026-07-14. Baseline: `main@5a178ef` (R1.5); active next: R2.1 turn-lane freeze then R2 remainder._

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence

- GitHub `main@5a178ef` tip: R1.5 per-account model inventory on execution lanes (`#197`).
- R-1 authority reconciliation: `#177` (receipt: `docs/receipts/r-minus-1-authority-reconciliation.md`).
- R0 quality gate + four-provider fake harness + UI in CI: `#178`–`#189` (receipt: `docs/receipts/r0-complete.md`).
- **R1 core complete** (`#191`–`#197`; receipt: `docs/receipts/r1-complete.md`):
  - R1.1 atomic work-call lane: `#191`
  - R1.2 strong-meta live lane: `#192`
  - R1.3a hedge atomic lanes: `#193`
  - R1.3b inventory generation: `#195`
  - R1.4 progressive admission: `#196`
  - R1.5 per-account model inventory foundation: `#197`
- The previous `feature/two-dial-orchestration-profile` branch remains preserved at `97ade64` with 13 unmerged commits (not release-ready; later slices absorb proven pieces).
- `CLAUDEPLAN.md` remains the sole active implementation authority.

### Deferred / out of R0 (honest narrow)

- **Catalog-drift as a first-class scenario:** only partial coverage via protocol/error fixtures; not a dedicated end-to-end catalog-drift product scenario.
- **Suite duration segmentation:** quality remains a full sequential gate; long-suite segmentation and hang/handle accounting are not fully closed as a separate product claim.
- **Packed-tarball journey:** R9 territory, not R0.

### R1 residuals (honest — not claimed product-complete)

R1 **core** (structural lanes + generation + admission + per-account inventory API) is done. Still open as follow-ons:

- **Live per-account CLI model probe** — structural-ready (`availableModelsByAccount`); probe not yet.
- **Multi-account OS isolation proofs** — deferred (compatibility matrix, not R1 foundation).

## Active sequence

1. ~~R-1: reconcile documentation authority and freeze truth.~~ **Done** (`#177`).
2. ~~R0: green baseline and deterministic provider harness.~~ **Done** (`#178`–`#189`; see `docs/receipts/r0-complete.md`).
3. ~~R1: atomic execution-lane inventory foundation.~~ **Done** (`#191`–`#197`; see `docs/receipts/r1-complete.md`). Residuals: live per-account probe, OS isolation proofs.
4. **R2 (active next): same-chat hot adaptation and coherence**
   - **R2.1:** freeze one lane snapshot (inventory + generation) per dispatched turn; mid-turn mutation does not change in-flight lane; next turn may adopt new inventory at a safe boundary.
   - R2.2+: A→B→A continuity bridge, mid-chat refresh redesign, native session resume lineage (non-goals of R2.1).
5. R3–R4: safe account selection, provider-owned credentials, and state security.
6. R5–R7: context/quota/acceptance contract, unified lifecycle, durable truth, and stall recovery.
7. R8: prove or narrow the two-dial product claims.
8. R9: generated support matrix and real packed-artifact golden journeys.
9. Merge clean/green slices, verify `main`, make a separate bump PR, and stop for the user's manual npm publication.

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
