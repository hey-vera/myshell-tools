# ROADMAP-STATUS

Compact current-state record. Product north star + long-horizon plan: `CLAUDEPLAN.md`.  
**Active external-ship sequence:** `docs/EXTERNAL-READINESS-PLAN.md` (U0–U14).

_Updated 2026-07-15. Baseline: `main@003c836` / package **3.173.0** (residual completion on tip; npm `latest` still **3.170.0** — owner publish only). Active next: **U1 detached account parity** → docs honesty → multichat smoke → owner human smoke + **npm publish**._

Wave summary receipt: `docs/receipts/actualization-wave-complete.md` (historical; residuals partially superseded by `#219`–`#222`).  
Release receipt: `docs/receipts/release-3.173.0.md` (prior: `docs/receipts/release-3.172.0.md`).  
External readiness plan: `docs/EXTERNAL-READINESS-PLAN.md`.

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence (main tip)

- GitHub `main@9ec7c40` tip: fenced goal-job leases (`#222`); residual completion `#219`–`#222` on main; package **3.173.0** release metadata on `release/3.173.0`.
- Actualization wave R-1 through R9.1, product wave **M1–M3 / A1–A2 / D1 / OS1**, and residual completion **mouse / probe / freeloop / leases** are **landed** on `main` (see tables below).

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

### Slice map — residual completion (DONE; in 3.173.0)

| Slice | What landed | PRs |
| --- | --- | --- |
| **Accounts mouse** | Optional mouse click-to-open on accounts list rows | `#219` |
| **Live per-account model probe** | Env-scoped detect / `accountEnv` isolation | `#220` |
| **Detached free-loop multi-turn** | Up to 8 turns with continue checkpoints; honest park/fail | `#221` |
| **Fenced goal-job leases** | Renewable leases (3m TTL + generation); reclaim without PID-alone trust | `#222` |

Notes:

- R0 docs advance to R1: `#190` (between harness and R1).
- R1 progress docs: `#194` (partial lanes) before `#195`–`#197`.
- **M3** advances the former R6 shared-executor residual: real detached work after shell exit, not park-only. Free-loop multi-turn + fenced leases landed in residual completion (`#221`, `#222`).
- **D1** ships user-facing Effort/Speed on top of mode + intensity storage (supersedes the pre-wave “no Effort/Speed on main” claim from R8.1 docs era).
- Provisional `availableModelsByAccount` wiring (`#218`) precedes the live probe (`#220`).

## Honest residuals (not product-complete)

These are **known gaps**. Green CI + landed slices do **not** mean every headline is fully actualized end-to-end. Tracked as **U\*** in `docs/EXTERNAL-READINESS-PLAN.md`.

1. ~~**Free-loop detached multi-turn**~~ **Done** (`#221`). Residual: FG menu chrome parity (U post-ship / optional).
2. ~~**Fenced leases**~~ **Done** (`#222`).
3. ~~**Accounts mouse**~~ **Done** (`#219`).
4. ~~**R1 live per-account probe**~~ **Done on menu enrich** (`#220`). **Gap:** detached `productionDeps` still thinner — **U1**.
5. **U1 — Detached/worker account brain parity** (active): probe + managed accounts + no ambient fallthrough on worker path.
6. **R9 — full multi-OS packed golden journey** beyond pack smoke (U5/U6 hermetic; live = owner).
7. **npm publish** — owner-only; registry still **3.170.0** while tip is **3.173.0** (U13).
8. **Docs honesty** — README/support matrix vs tip (U2/U3/U4).

### Narrow deferred items (still honest)

- Catalog-drift as first-class scenario; suite duration segmentation; R3.2 schema lock/CAS; mid-chat refresh UX redesign; multi-account OS isolation proofs matrix; FG free-loop chrome parity.

## Active sequence

Prior waves R-1…R9 + M/A/D/OS + residual `#219`–`#222`: **Done** (tables above).

**External readiness (U0–U14)** — see `docs/EXTERNAL-READINESS-PLAN.md`:

1. **U0** Freeze plan + ROADMAP pointer (this edit).
2. **U1** Detached account parity (highest code leverage).
3. **U2–U4** README + support matrix + dial honesty.
4. **U5–U6** Hermetic multichat / pack honesty.
5. **U7–U9** Bounded UX polish.
6. **U10–U14** Version/quality → **owner human smoke** → **owner npm publish**.

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
