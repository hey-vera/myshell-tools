# ROADMAP-STATUS

Compact current-state record. The user-designated implementation authority is `CLAUDEPLAN.md`.

_Updated 2026-07-15. Baseline: `main@58f766c` (R9.1 packed install smoke `#207`); active next: residual R6 polish **or** user release publish._

Wave summary receipt: `docs/receipts/actualization-wave-complete.md`.

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence (main tip)

- GitHub `main@58f766c` tip: R9.1 real packed tarball install smoke (`#207`).
- R-1 through R9.1 actualization slices are **landed** on `main` (see table below). This is a **docs status sync** PR: no `src/` / `test/` / version bump.

### Slice map (DONE with PR numbers)

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
| **R8.1** | Honest Mode + Intensity dial claims (no Effort/Speed fantasy) | `#206` | `docs/receipts/r8-dial-honesty.md` |
| **R9.1** | Real packed tarball install smoke on package-check | `#207` | `docs/receipts/r9-packed-install-smoke.md` |

Notes:

- R0 docs advance to R1: `#190` (between harness and R1).
- R1 progress docs: `#194` (partial lanes) before `#195`–`#197`.
- **R6** was **not** a full actualization merge in this wave — see residuals (detached worker remains skeleton / park-first; shared FG/detached executor + fenced leases not fully productized). Daemon-lite / multi-conversation process registry earlier on main (`#172`–`#174`) is partial substrate, not R6-complete.

## Honest residuals (not product-complete)

These are **known gaps**. Green CI + landed slices do **not** mean every CLAUDEPLAN headline is fully actualized end-to-end.

1. **R6 — detached / unified lifecycle residual**  
   Detached worker path remains skeleton / park-first. Full foreground + detached **shared executor** and **fenced leases** are **not** fully actualized. Treat remaining R6 polish as open product work, not done-by-adjacency to `#172`–`#174`.

2. **R1 — live per-account CLI model probe**  
   Structural inventory (`availableModelsByAccount` / lane APIs) is on main. A live per-account **CLI model probe** wired end-to-end is **not**.

3. **R9 — full multi-OS packed golden journey**  
   R9.1 proves real `npm pack` → empty install → bins `--help`/`--version` → actionable no-provider failure on **package-check** (ubuntu / Node 22 first). Full multi-OS packed golden journey (auth handoff, interactive chat, resume, cancel, expanded pack matrix) is **beyond** package-check ubuntu smoke.

4. **Feature branch two-dial orchestration-profile**  
   `feature/two-dial-orchestration-profile` remains preserved (historically `97ade64` era) with unmerged commits. **Not** merged wholesale. R8.1 narrowed main product claims to shipped **Mode** + **Intensity**; Effort/Speed two-dial fantasy stays off main.

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
8. **R6 residual (open):** shared FG/detached executor + fenced leases; detached worker beyond skeleton/park-first.
9. ~~R7.1: progress invariant / stall honesty.~~ **Done** (`#205`).
10. ~~R8.1: prove or narrow two-dial product claims.~~ **Done** (`#206`); two-dial branch not merged wholesale.
11. ~~R9.1: packed-artifact install smoke.~~ **Done** (`#207`). Residual: multi-OS full golden journey.
12. **Active next:** residual **R6 polish** **or** user **release publish** (version bump is a **separate** release PR; npm publication remains manual).

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
