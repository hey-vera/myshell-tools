# ROADMAP-STATUS

Compact current-state record. The user-designated implementation authority is `CLAUDEPLAN.md`.

_Updated 2026-07-15. Baseline: `main@9c02738` / package **3.172.0** (product wave M/A/D/OS shipped: multi-chat workers, accounts UX, Effort/Speed dials, multi-OS packed smoke). Active next: residual free-loop multi-turn / fenced leases / live model probe **or** owner **npm publish**._

Wave summary receipt: `docs/receipts/actualization-wave-complete.md`.  
Release receipt: `docs/receipts/release-3.172.0.md`.

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence (main tip)

- GitHub `main@9c02738` tip: OS1 multi-OS packed install smoke win/mac (`#216`); package **3.172.0** release metadata on `release/3.172.0`.
- Actualization wave R-1 through R9.1 **and** product wave **M1–M3 / A1–A2 / D1 / OS1** are **landed** on `main` (see tables below).

### Slice map — actualization (DONE with PR numbers)

| Slice | What landed | PRs | Receipt |
| --- | --- | --- | --- |
| **R-1** | Authority reconciliation; `CLAUDEPLAN.md` sole active plan | `#177` | `docs/receipts/r-minus-1-authority-reconciliation.md` |
| **R0** | Quality gate, four-provider fake harness, Node 20, UI in CI | `#178`–`#189` | `docs/receipts/r0-complete.md` |
| **R1** | Atomic execution-lane inventory foundation | `#191`–`#197` | `docs/receipts/r1-complete.md` |
| **R1.1** | Work-call atomic lane | `#191` | `docs/receipts/r1-execution-lane-select.md` |
| **R1.2** | Strong-meta live lane | `#192` | `docs/receipts/r1-pick-strong-meta-lane.md` |
| **R1.3a** | Hedge atomic lanes | `#193` | `docs/receipts/r1-hedge-execution-lane.md` |
| **R1.3b** | Inventory generation | `#195` | `docs/receipts/r1-inventory-generation.md` |
| **R1.4** | Progressive admission | `#196` | (in r1-complete) |
| **R1.5** | Per-account model inventory foundation | `#197` | `docs/receipts/r1-per-account-model-inventory.md` |
| **R2.1** | Freeze one turn-lane inventory snapshot at dispatch | `#198` | `docs/receipts/r2-turn-lane-snapshot.md` |
| **R2.2** | Native session lineage gate (A→B→A continuity) | `#199` | `docs/receipts/r2-native-lineage-gate.md` |
| **R3.1** | Never silently pick cooling subscription accounts | `#200` | `docs/receipts/r3-cooldown-no-strand.md` |
| **R4.1** | Official Claude CLI auth default; legacy token opt-in | `#201` | `docs/receipts/r4-legacy-token-opt-in.md` |
| **R4.2** | Minimal child env allowlist for provider adapters | `#202` | `docs/receipts/r4-child-env-allowlist.md` |
| **R4.3** | Grok positive auth signature + secure prompt files | `#203` | `docs/receipts/r4-grok-auth-prompt.md` |
| **R5.1** | Enforce `TurnCallBudget` on live chat path | `#204` | `docs/receipts/r5-enforce-turn-budget.md` |
| **R7.1** | Progress invariant stops manager auto-continue | `#205` | `docs/receipts/r7-progress-invariant.md` |
| **R8.1** | Honest Mode + Intensity dial claims (pre–D1) | `#206` | `docs/receipts/r8-dial-honesty.md` |
| **R9.1** | Real packed tarball install smoke on package-check | `#207` | `docs/receipts/r9-packed-install-smoke.md` |

### Slice map — product wave M/A/D/OS (DONE; in 3.172.0)

| Slice | What landed | PRs |
| --- | --- | --- |
| **M1** | Home multi-chat live work status on Recent | `#210` |
| **M2** | Exit handoff honesty (release TUI jobs, ensure worker) | `#212` |
| **M3** | Shared detached goal executor (real work after shell exit, not park-only) | `#213` |
| **A1** | Accounts list arrow / Enter / digit nav | `#211` |
| **A2** | Accounts rename label `[l]` | `#214` |
| **D1** | Effort + Speed dials (mode + intensity storage; user-facing Effort/Speed) | `#215` |
| **OS1** | Multi-OS packed smoke (win/mac) without renaming required ubuntu package-check | `#216` |

Notes:

- R0 docs advance to R1: `#190` (between harness and R1).
- R1 progress docs: `#194` (partial lanes) before `#195`–`#197`.
- **M3** advances the former R6 shared-executor residual: real detached work after shell exit, not park-only. Free-loop multi-turn and fenced leases remain open (see residuals).
- **D1** ships user-facing Effort/Speed on top of mode + intensity storage (supersedes the pre-wave “no Effort/Speed on main” claim from R8.1 docs era).

## Honest residuals (not product-complete)

These are **known gaps**. Green CI + landed slices do **not** mean every headline is fully actualized end-to-end.

1. **Free-loop detached / multi-turn free loop**  
   Free-loop detached is still **one turn then park**. Full menu-parity multi-turn free loop is **not** done.

2. **Fenced leases**  
   Shared FG/detached leasing fences are **not** fully productized.

3. **Accounts mouse**  
   Mouse interaction on accounts list is **not** claimed.

4. **R1 — live per-account CLI model probe**  
   Structural inventory is on main. A live per-account **CLI model probe** wired end-to-end is **not**.

5. **R9 — full multi-OS packed golden journey**  
   OS1 adds win/mac packed smoke alongside required ubuntu package-check. Full multi-OS packed golden journey (auth handoff, interactive chat, resume, cancel, expanded pack matrix) remains beyond current smoke.

6. **npm publish**  
   Owner-only; agents do not publish.

### Narrow deferred items (still honest)

- **Catalog-drift as first-class scenario:** partial via protocol/error fixtures only.
- **Suite duration segmentation / hang accounting:** quality is still a full sequential gate.
- **R3.2+** subscriptions schema lock/CAS (if still planned): not claimed by R3.1.
- **R2 mid-chat refresh redesign** beyond freeze + lineage gate: not claimed complete as a UX redesign wave.
- **Multi-account OS isolation proofs:** compatibility matrix territory, not R1 foundation.

## Active sequence

1. ~~R-1: reconcile documentation authority and freeze truth.~~ **Done** (`#177`).
2. ~~R0: green baseline and deterministic provider harness.~~ **Done** (`#178`–`#189`).
3. ~~R1: atomic execution-lane inventory foundation.~~ **Done** (`#191`–`#197`). Residual: live per-account probe; OS isolation proofs.
4. ~~R2: turn-lane freeze + native lineage gate.~~ **Done** (`#198`–`#199`). Residual: fuller mid-chat refresh redesign if still desired.
5. ~~R3.1: safe cooling-account selection.~~ **Done** (`#200`).
6. ~~R4.1–R4.3: provider-owned credentials / child env / Grok auth.~~ **Done** (`#201`–`#203`).
7. ~~R5.1: turn budget on live chat path.~~ **Done** (`#204`).
8. ~~M3 / R6-class shared detached executor (real work after exit).~~ **Done** (`#213`). Residual: free-loop multi-turn; fenced leases.
9. ~~R7.1: progress invariant / stall honesty.~~ **Done** (`#205`).
10. ~~R8.1: dial honesty (Mode + Intensity era).~~ **Done** (`#206`); **D1** Effort/Speed user-facing dials **Done** (`#215`).
11. ~~R9.1: packed-artifact install smoke.~~ **Done** (`#207`). ~~OS1 multi-OS win/mac smoke.~~ **Done** (`#216`). Residual: full multi-OS golden journey.
12. ~~Product wave M1/M2/A1/A2.~~ **Done** (`#210`–`#212`, `#211`, `#214`).
13. **Active next:** residual free-loop multi-turn / fenced leases / live model probe / accounts mouse **or** owner **npm publish** of **3.172.0** (version bump is this release PR; publication remains manual).

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
