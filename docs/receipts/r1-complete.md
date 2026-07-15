# R1 complete — atomic execution lanes + inventory foundation

R1 core (lanes on primary call sites, inventory generation, progressive
admission, per-account model inventory API) is **done** on main via
`#191`–`#197`.

## Evidence table

| Slice | PR | Title | Receipt |
| --- | --- | --- | --- |
| R1.1 | [#191](https://github.com/hey-vera/myshell-tools/pull/191) | Atomic work-call execution lane | `docs/receipts/r1-execution-lane-select.md` |
| R1.2 | [#192](https://github.com/hey-vera/myshell-tools/pull/192) | Strong-meta live lane (no dated bypass) | `docs/receipts/r1-pick-strong-meta-lane.md` |
| R1.3a | [#193](https://github.com/hey-vera/myshell-tools/pull/193) | Hedge primary/speculative atomic lanes | `docs/receipts/r1-hedge-execution-lane.md` |
| R1.3b | [#195](https://github.com/hey-vera/myshell-tools/pull/195) | Inventory generation on lane snapshot | `docs/receipts/r1-inventory-generation.md` |
| R1.4 | [#196](https://github.com/hey-vera/myshell-tools/pull/196) | Progressive model admission | (admission tests / main) |
| R1.5 | [#197](https://github.com/hey-vera/myshell-tools/pull/197) | Per-account model inventory foundation | `docs/receipts/r1-per-account-model-inventory.md` |

Partial progress notes: `docs/receipts/r1-progress.md` (historical; predates R1.3b–R1.5).

## What R1 delivered

- **Atomic lane** = provider + account + model selected together (`selectExecutionLane`).
- Managed accounts: no ambient credential fallthrough when inventory blocks a provider.
- **Inventory generation** tags every ok lane (explicit counter or content-derived `ig-…`).
- **Progressive admission** filters models by capability/registry ranks.
- **Per-account model inventory** API so mismatched entitlements cannot be cross-paired.

## Residuals (honest — not claimed done)

- **Live per-account CLI model probe** — structural/deps path ready
  (`availableModelsByAccount`); production probe that fills it from each account’s
  CLI is **not** yet wired.
- **Multi-account OS isolation proofs** — per-provider home isolation matrix
  (Windows/macOS/Linux concurrent accounts) deferred (R1 foundation scope only).
- Full mid-chat refresh + A→B→A continuity bridge → **R2** (see R2.1+).

## Active next

**R2** — same-chat hot adaptation: freeze one lane inventory per dispatched turn
(R2.1), then continuity bridge / safe refresh (R2.2+). Authority: `CLAUDEPLAN.md`.
