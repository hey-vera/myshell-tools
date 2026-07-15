# ROADMAP-STATUS

Compact current-state record. The user-designated implementation authority is `CLAUDEPLAN.md`.

_Updated 2026-07-14. Baseline: `main@3af24a3`; active next: R1 remaining (per-account inventory / progressive admission), then R2._

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence

- GitHub `main@3af24a3` tip includes R1 partial lane progress: work-call atomic lanes (`#191`), strong-meta live lane (`#192`), hedge atomic lanes (`#193`); prior tip UI ghost flake harden (`#189`) with `test:ui` in required CI and `node: [20, 22, 24]`.
- R-1 authority reconciliation merged: `#177` (receipt: `docs/receipts/r-minus-1-authority-reconciliation.md`).
- R0 quality gate: `#178` — `npm run quality` / `prepublishOnly` sequential release path (receipt: `docs/receipts/r0-quality-command.md`).
- R0 fake adapters (Codex/OpenCode and related fixture/timeout slices): `#179`–`#184` (receipts under `docs/receipts/r0-fake-*`, `r0-provider-fixture-matrix.md`).
- R0 Claude fake harness: `#186` (receipt: `docs/receipts/r0-fake-claude-adapter.md`).
- R0 Node 20 CI matrix: `#185` — engines alignment with Node 20/22/24 (receipt: `docs/receipts/r0-node20-ci.md`).
- R0 Grok fake harness: `#187` (receipt: `docs/receipts/r0-fake-grok-adapter.md`).
- R0 UI tests in required CI: `#188` (receipt: `docs/receipts/r0-ci-ui-tests.md`); ghost flake harden: `#189`.
- Four-provider deterministic fake harness on main: Codex, OpenCode, Claude, Grok — built-adapter paths without live quota.
- Completion writeup: `docs/receipts/r0-complete.md`.
- **R1 partial (lanes on primary call sites):**
  - R1.1 atomic work-call execution lane: `#191` (receipt: `docs/receipts/r1-execution-lane-select.md`).
  - R1.2 strong-meta live lane (no dated model bypass): `#192` (receipt: `docs/receipts/r1-pick-strong-meta-lane.md`).
  - R1.3a hedge primary/speculative atomic lanes: `#193` (receipt: `docs/receipts/r1-hedge-execution-lane.md`).
  - Progress summary: `docs/receipts/r1-progress.md`.
- The previous `feature/two-dial-orchestration-profile` branch remains preserved at `97ade64` with 13 unmerged commits (not release-ready; later slices absorb proven pieces).
- `CLAUDEPLAN.md` remains the sole active implementation authority.

### Deferred / out of R0 (honest narrow)

- **Catalog-drift as a first-class scenario:** only partial coverage via protocol/error fixtures; not a dedicated end-to-end catalog-drift product scenario.
- **Suite duration segmentation:** quality remains a full sequential gate; long-suite segmentation and hang/handle accounting are not fully closed as a separate product claim.
- **Packed-tarball journey:** R9 territory, not R0.

### R1 still open (honest partial)

R1 is **not complete**. Merged so far is structural atomic selection on work-call, strong-meta, and hedge arms. Still open for R1:

- **Per-account model inventory** — true entitlement isolation (not provider-global inventory paired after the fact).
- **Progressive admission** — capability/auth/health as supported / unsupported / unknown / temporarily_unavailable with source, freshness, and inventory generation.
- **Inventory generation freeze** for all call sites that still route or attach outside the atomic lane path.
- **Remaining ambient / dated bypass audit** — any leftover call sites that still hard-code models or fall through to ambient credentials when managed accounts exist.

## Active sequence

1. ~~R-1: reconcile documentation authority and freeze truth.~~ **Done** (`#177`).
2. ~~R0: green baseline and deterministic provider harness.~~ **Done** (`#178`–`#189`; see `docs/receipts/r0-complete.md`).
3. **R1–R2 (active next: finish R1 remaining, then R2):** atomic execution-lane inventory and safe same-chat adaptation.
   - ~~R1.1 work-call atomic lane~~ **Done** (`#191`).
   - ~~R1.2 strong-meta live lane~~ **Done** (`#192`).
   - ~~R1.3a hedge atomic lanes~~ **Done** (`#193`).
   - **R1 remaining:** per-account inventory, progressive admission, inventory-generation freeze, ambient/dated bypass audit.
4. R3–R4: safe account selection, provider-owned credentials, and state security.
5. R5–R7: context/quota/acceptance contract, unified lifecycle, durable truth, and stall recovery.
6. R8: prove or narrow the two-dial product claims.
7. R9: generated support matrix and real packed-artifact golden journeys.
8. Merge clean/green slices, verify `main`, make a separate bump PR, and stop for the user's manual npm publication.

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
