# R1 partial progress — lanes on work-call / meta / hedge

Status snapshot after `#191`–`#193` on `main@3af24a3`. R1 is **not complete**; this receipt records partial delivery only.

## Evidence table

| Slice | PR | Title | Merged | Slice receipt |
| --- | --- | --- | --- | --- |
| R1.1 | [#191](https://github.com/hey-vera/myshell-tools/pull/191) | feat(core): atomic execution-lane selection on work-call path (R1.1) | 2026-07-15 | `docs/receipts/r1-execution-lane-select.md` |
| R1.2 | [#192](https://github.com/hey-vera/myshell-tools/pull/192) | feat(core): route strong meta through live lane inventory (R1.2) | 2026-07-15 | `docs/receipts/r1-pick-strong-meta-lane.md` |
| R1.3a | [#193](https://github.com/hey-vera/myshell-tools/pull/193) | feat(core): atomic execution lanes on hedge path (R1.3a) | 2026-07-15 | `docs/receipts/r1-hedge-execution-lane.md` |

Main tip after merge train: `3af24a3` (`feat(core): hedge arms select atomic execution lanes (R1.3a) (#193)`).

## What landed

- **Work-call** selects provider + model + account as one atom via `selectExecutionLane` (no post-route ambient attach when managed accounts exist).
- **Strong-meta** uses live inventory + atomic lane selection; dated hard-coded model IDs removed from menu meta path.
- **Hedge** primary/speculative arms (when account-parallelism is armed) use the same atomic lane path.

## Later slices (post-#193)

| Slice | Title | Notes |
| --- | --- | --- |
| R1.3b | Inventory generation on lane snapshot | `docs/receipts/r1-inventory-generation.md` |
| R1.4 | Progressive model admission | merged on main (`#196`) |
| R1.5 | Per-account model inventory foundation | `docs/receipts/r1-per-account-model-inventory.md` |

## What remains for R1

- Live per-account CLI model probe (plumb detect → `availableModelsByAccount`).
- Remaining ambient / dated bypass audit beyond work-call, strong-meta, and hedge.
- Full multi-account OS isolation matrix (out of R1 foundation scope).

## Active next

Wire **live per-account probe** into `availableModelsByAccount`, then **R2**
(safe same-chat adaptation). Authority: `CLAUDEPLAN.md`. Status: `docs/ROADMAP-STATUS.md`.
