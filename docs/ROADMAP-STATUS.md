# ROADMAP-STATUS

Compact current-state record. The user-designated implementation authority is `CLAUDEPLAN.md`.

_Updated 2026-07-14. Baseline: `main@e52e1cd`; active next: R1 runtime lane inventory._

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence

- GitHub `main@e52e1cd` includes R-1 and R0 merge train; tip carries UI ghost flake harden (`#189`) with `test:ui` in required CI and `node: [20, 22, 24]`.
- R-1 authority reconciliation merged: `#177` (receipt: `docs/receipts/r-minus-1-authority-reconciliation.md`).
- R0 quality gate: `#178` — `npm run quality` / `prepublishOnly` sequential release path (receipt: `docs/receipts/r0-quality-command.md`).
- R0 fake adapters (Codex/OpenCode and related fixture/timeout slices): `#179`–`#184` (receipts under `docs/receipts/r0-fake-*`, `r0-provider-fixture-matrix.md`).
- R0 Claude fake harness: `#186` (receipt: `docs/receipts/r0-fake-claude-adapter.md`).
- R0 Node 20 CI matrix: `#185` — engines alignment with Node 20/22/24 (receipt: `docs/receipts/r0-node20-ci.md`).
- R0 Grok fake harness: `#187` (receipt: `docs/receipts/r0-fake-grok-adapter.md`).
- R0 UI tests in required CI: `#188` (receipt: `docs/receipts/r0-ci-ui-tests.md`); ghost flake harden: `#189`.
- Four-provider deterministic fake harness on main: Codex, OpenCode, Claude, Grok — built-adapter paths without live quota.
- Completion writeup: `docs/receipts/r0-complete.md`.
- The previous `feature/two-dial-orchestration-profile` branch remains preserved at `97ade64` with 13 unmerged commits (not release-ready; later slices absorb proven pieces).
- `CLAUDEPLAN.md` remains the sole active implementation authority.

### Deferred / out of R0 (honest narrow)

- **Catalog-drift as a first-class scenario:** only partial coverage via protocol/error fixtures; not a dedicated end-to-end catalog-drift product scenario.
- **Suite duration segmentation:** quality remains a full sequential gate; long-suite segmentation and hang/handle accounting are not fully closed as a separate product claim.
- **Packed-tarball journey:** R9 territory, not R0.

## Active sequence

1. ~~R-1: reconcile documentation authority and freeze truth.~~ **Done** (`#177`).
2. ~~R0: green baseline and deterministic provider harness.~~ **Done** (`#178`–`#189`; see `docs/receipts/r0-complete.md`).
3. **R1–R2 (active next: R1):** atomic execution-lane inventory and safe same-chat adaptation.
4. R3–R4: safe account selection, provider-owned credentials, and state security.
5. R5–R7: context/quota/acceptance contract, unified lifecycle, durable truth, and stall recovery.
6. R8: prove or narrow the two-dial product claims.
7. R9: generated support matrix and real packed-artifact golden journeys.
8. Merge clean/green slices, verify `main`, make a separate bump PR, and stop for the user's manual npm publication.

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
