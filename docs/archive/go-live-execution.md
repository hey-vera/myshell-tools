# Go-Live Execution Plan — myshell-tools

> Concrete, worker-executable plan to ship the "one chat to rule them all" as the
> product (ON by default, NO experimental flags). Verified on
> `docs/commit-auto-mode-design` = `origin/main` + 1 docs commit
> (`git rev-list --left-right --count origin/main...HEAD` → `0  1`). Every claim is
> `file:line`-cited. This is execution, not re-litigation: the strategic call
> (auto-brain wins, governor demoted, tribunal/verify become a depth) is already made.

---

## 0. The premise correction that changes everything (read first)

The direction-audit said "everything dark by default; the vision is unfalsified."
**That is half-wrong, and the wrong half is load-bearing.** Two flag *populations*
exist with OPPOSITE defaults:

| Population | Resolver | Default | Members |
|---|---|---|---|
| **v9 subsystems** | `experimentalEnabledByDefault` (`experimental-default.ts:95`) | **ON** | `governor`, `verify`, `trust`, `tribunal`, `taste`, `judgment` |
| **v-redesign + tail** | pure opt-in helpers (`autoBrainEnabled` etc., default `false`) | **OFF** | `autoBrain`, `levelDial`, `draftGoals`, `roles`, + ~14 others |

Wiring proof (menu.ts default-ON sites): verify `:2300`, governor `:2544`, trust
`:2605`, tribunal `:2627`, taste `:3761`, judgment `:3774`. Auto-brain is pure
opt-in (`menu.ts:2408` `if (!autoBrainEnabled(...)) return {}`).

**Consequence: the SHIPPED product today runs `governor` as its live per-turn brain,
and `auto-brain` is dark.** The strategic decision ("auto-brain is THE brain") is
therefore *not* "turn on the winner" — it is "**replace the brain that is already
live in production**." Every slice below must respect that the floor is governor-on,
not nothing-on. This is the single most important correction to the prior plan.

---

## 1. Governor ⇄ auto-brain interaction (do both run? who wins?)

**When both flags are on, both run, on DIFFERENT axes — they do not currently
collide on a single decision, because auto-brain only consumes ONE of its six dials.**

### What auto-brain actually drives today
`fuseRung` is re-run inside orchestrate with full signals (`orchestrate.ts:903-916`),
but **only `rung.modelRung` is consumed** (`orchestrate.ts:917`
`autoBrainTier = autoBrainResult.rung.modelRung`). That tier becomes the *starting*
tier at `orchestrate.ts:1808`
(`currentTier = autoBrainTier !== undefined ? autoBrainTier : classification.tier`).
The other five RungTuple dials (`effort`, `verifyDepth`, `decompDepth`, `concurrency`,
`reviewPolicy` — defined `mode-levels.ts:343-357`) are **computed and thrown away**.
The receipt (`orchestrate.ts:1080`) is display-only.

### What governor actually drives today
`governorPlan = allocate(...)` once per turn (`orchestrate.ts:1664-1683`) and is
authoritative for, all consumed live:

| Governor output | Consumed at | Replaceable by an auto-brain dial? |
|---|---|---|
| `tierRequest` (oracle gate) | `orchestrate.ts:1909` `governorWantsOracle` | YES — `modelRung` already does tier |
| `verify` (verify level) | `orchestrate.ts:1972-1973` (fallback `deps.verifyLevel` when off, `:1974`) | YES — `verifyDepth` dial |
| `roundBudget` (investigation depth) | `orchestrate.ts:1950-1953` | YES — `decompDepth`/effort dial |
| `verbosity` | prompt shaping | YES — `effort`/level |
| `panelAllowed` | `orchestrate.ts:1695` | partial — needs a gate |
| `pollAllowed` | `orchestrate.ts:1185-1200` (conservative fallback `:1185` else-branch) | partial — `verifyDepth:'cross-vendor'` |
| `tribunalAllowed` | `orchestrate.ts:1326-1341` (conservative fallback exists) | partial — `verifyDepth:'cross-vendor'` |
| **`turnCallBudget`** (hard 1–3 per-turn call cap, shrunk by quota pressure) | threaded to panel/hedge/work-call (`:1721,:1769,:1952`) | **NO — auto-brain has no budget concept** |

### Who wins
Nobody overrides anybody today, because their consumed surfaces are disjoint:
auto-brain owns the **start tier**, governor owns **everything else (budget + levers)**.
The latent conflict: auto-brain can set `currentTier='manager'` directly (`:1808`),
while `governorPlan.tierRequest='ic'` only gates the *oracle escalation* (`:1909`) —
so with both on, auto-brain can seat a higher start tier than governor's budget
"wanted." This is benign today (admission gates at `:1802-1804` still cap manager
access) but is exactly the "two brains" hazard the sequence below must never ship.

### Does governor do anything auto-brain doesn't? — YES, one thing.
**`turnCallBudget` + quota-pressure shrinking** (`governor.ts:331-383`,
`effectiveBudget = max(1, base − pressure)`) is a genuine capacity/admission
capability with **no equivalent in auto-brain**. It is the single hard cap that stops
cross-vendor levers (critic + poll + tribunal) from multiplicatively blowing quota in
one turn. Everything else governor does is either (a) tier/shape decision that
*duplicates* `fuseRung`, or (b) cross-vendor lever admission that **already has a
conservative built-in fallback** when governor is off (`pollPermittedConservative`
`governor.ts:580`, `tribunalPermittedConservative` `:646`, `verifyLevel` fallback
`orchestrate.ts:1974`).

### Verdict: DEMOTE, not DELETE (and be honest about what delete loses)
`allocate()` fuses two separable jobs:
- **Job A — the second brain:** `classifyTaskShape` (`governor.ts:141`), `tierRequest`,
  `roundBudget`, `verbosity`. This **duplicates `fuseRung`** and is the brain to KILL.
- **Job B — budget/admission:** `turnCallBudget` + pressure (`governor.ts:331-383`)
  and the poll/tribunal/critic mutual-exclusion under one budget (`:736-830`).

Deleting governor outright **loses Job B's hard call cap and the coherent
single-budget mutual-exclusion** — the conservative built-ins approximate the gating
but do NOT coordinate three levers against one counter. So:

> **Demote:** kill Job A (the shape→tier→verbosity brain). Extract Job B's ~50-line
> budget/pressure core into a tiny pure `turn-budget.ts` admission helper that feeds
> auto-brain as its `capacityCeiling`/budget input (the seam already exists:
> `FuseRungInput.capacityCeiling` `auto-brain.ts:275`). Wire auto-brain's
> `verifyDepth`/`effort`/`decompDepth` dials so they REPLACE governor's verify/round
> outputs. Once those dials are consumed and the budget helper is extracted,
> `governor.ts` (886 lines) is deletable; `allocate`/`classifyTaskShape` go with it.

---

## 2. Flag classification (all 26 `experimental*`)

Legend: **PROMOTE** = becomes permanent default behavior, delete flag + scaffolding ·
**KEEP** = legitimate product/operational config · **DELETE** = dead/superseded path.

| # | Flag (`config.ts`) | Default | Disposition | Why |
|---|---|---|---|---|
| 1 | `experimentalBasic` `:232` | n/a | **KEEP** | The single legitimate global kill-switch ("plain mode"). A real product needs one panic opt-out. Rename to a stable `basicMode`. |
| 2 | `experimentalGovernor` `:256` | ON | **DELETE** | The losing brain (Job A). Job B extracted to `turn-budget.ts` first (§1). |
| 3 | `experimentalAutoBrain` `:522` | OFF | **PROMOTE** | THE brain. Promote to default-on, delete the flag. |
| 4 | `experimentalVerify` `:271` | ON | **PROMOTE** | Already stable/default-on; verification *is* the product. Collapse to always-on; keep `MYSHELL_VERIFY=0`/basic opt-out only. |
| 5 | `experimentalTrust` `:285` | ON | **PROMOTE** | The legibility receipt (non-negotiable #6). Default-on already; make permanent. |
| 6 | `experimentalJudgment` `:314` | ON | **PROMOTE** | Grounded push-back, zero-cost, default-on. Make permanent. |
| 7 | `experimentalTaste` `:299` | ON | **PROMOTE** | Feeds `memoryBias` into `fuseRung` (`auto-brain.ts:269`). Permanent; keep a privacy opt-out (see #26 note). |
| 8 | `experimentalTribunal` `:375` | ON | **KEEP (gated)** | Cross-vendor build-off. NOT a flag — becomes a **verification depth** auto reaches for (`verifyDepth:'cross-vendor'` on high/max + ≥2 vendors). Keep an operational opt-out, delete the standalone flag. |
| 9 | `experimentalScheduler` `:243` | OFF | **PROMOTE** | Multi-goal scheduler is core to /goal. Promote; keep `MYSHELL_SCHEDULER=0` operational opt-out. |
| 10 | `experimentalLevelDial` `:489` | OFF | **PROMOTE** | The 5-level dial (non-negotiable #7). Promote to the user-facing firepower control. |
| 11 | `experimentalDraftGoals` `:504` | OFF | **PROMOTE** | "chat → draft goal" (non-negotiable #3). Promote with the confirm gate. |
| 12 | `experimentalRoles` `:477` | OFF | **PROMOTE** | Provider-agnostic role layer (non-negotiable #4). Promote (pure substrate; consume it). |
| 13 | `experimentalProviderEffort` `:555` | OFF | **PROMOTE** | Effort is the 1-model lever (non-negotiable #4/#5). Promote after a live-run validation slice. |
| 14 | `experimentalUnifyPreflight` `:327` | OFF | **PROMOTE** | Removes one serial worker call, never adds one. Pure win; promote. |
| 15 | `experimentalRiskSignals` `:339` | OFF | **PROMOTE** | Monotonic risk raise from byproduct; feeds `fuseRung` hardness. Promote. |
| 16 | `experimentalByproductFallback` `:538` | OFF | **PROMOTE** | Robustness for byproduct parse; additive. Promote. |
| 17 | `experimentalRequiredInvestigation` `:350` | OFF | **PROMOTE** | Grounds investigate turns; part of the spine. Promote. |
| 18 | `experimentalManager` `:465` | OFF | **PROMOTE** | Per-goal manager cycle — needed for real goal execution. Promote. |
| 19 | `experimentalTrulyComplete` `:450` | OFF | **PROMOTE** | Verified-done gate (anti-fabrication). Promote with verify. |
| 20 | `experimentalBoard` `:397` | OFF | **PROMOTE** | Persistent goal board UI. Promote (UI only). |
| 21 | `experimentalAutoGoal` `:409` | OFF | **PROMOTE** | Post-turn staging; pairs with draft-goals. Promote. |
| 22 | `experimentalInk` `:219` | OFF | **KEEP (interim)** | New UI renderer mid-migration. Legitimately incomplete — keep until the Ink path reaches parity, then flip + delete. Do NOT block flag-removal on it. |
| 23 | `experimentalUnderstanding` `:422` | OFF | **DELETE-or-defer** | Manager-tier read-only system map before staging. Expensive, unproven, not on the spine. Defer (leave flag) OR delete; do not promote in go-live. |
| 24 | `experimentalResearch` `:387` | OFF | **DELETE-or-defer** | Second-angle web re-research. Off-spine, cost risk. Defer; not part of go-live. |
| 25 | `experimentalPreflightGuard` `:361` | OFF | **DELETE** | Superseded by the `turn-budget.ts` extracted from governor (§1) — same job (shed avoidable calls under budget). Fold its intent into the budget helper, delete the flag. |
| 26 | `experimentalPlanningDepth` `:424` / `experimentalItemParking` `:433` | OFF | **DELETE** | Internal half-wired rollout gates ("dark until D5 wiring"). Either finish into manager-cycle promotion (#18) or delete the dead switches. |

Plus `experimentalRollback` (the rollback kill-switch, `rollback-flag.ts`): **KEEP** —
a genuine operational kill-switch is what a real product *should* expose; it scopes to
verify/judgment/trust only (`experimental-default.ts:41`).

**Summary: 16 PROMOTE · 4 KEEP (basic, tribunal-as-depth, ink-interim, rollback) ·
4 DELETE (governor, preflightGuard, planningDepth, itemParking) · 2 DEFER
(understanding, research).** Most are PROMOTE or DELETE, as expected.

---

## 3. Execution as worker-sized slices (never two brains live)

Each slice ships green: `typecheck · lint · knip · test/arch/guards.test.ts · vitest`.
Ordering invariant: **at no commit do `governor` (Job A) and `auto-brain` both decide
a tier.** We make auto-brain capable of everything governor does *before* we let it
win, then retire governor.

### Slice 1 — Consume auto-brain's full RungTuple (capability parity, still flag-off)
- **Goal:** wire `verifyDepth`, `effort`, `decompDepth` from `autoBrainResult.rung`
  into orchestrate so auto-brain can produce governor's lever outputs. Still behind
  `autoBrainEnabled` (default off) — zero shipped change.
- **Files:** `orchestrate.ts:903-918` (read more dials), `:1950-1976` (feed verifyLevel
  from `rung.verifyDepth` when auto-brain on), `mode-levels.ts` (confirm dial values).
- **Breaks + mitigation:** verifyLevel currently sourced from `governorPlan` (`:1972`).
  Add an auto-brain branch ABOVE it; keep governor branch intact (both flags can be on
  in test). Guard with the existing OFF-neutrality suites.
- **Done test:** new unit asserting `verifyDepth:'cross-vendor'` → `verifyLevel` chosen;
  flag-off neutrality suite byte-identical; `guards.test.ts` green.
- **Size:** S.

### Slice 2 — Extract `turn-budget.ts` (Job B) from governor
- **Goal:** lift `baseBudgetForMode`+`effectiveBudget`+pressure (`governor.ts:331-383`)
  into a new pure `src/core/turn-budget.ts`. Governor imports it (no behavior change);
  auto-brain gains a `turnCallBudget` input/output seam.
- **Files:** new `src/core/turn-budget.ts`; `governor.ts` (delegate); `auto-brain.ts`
  (`FuseRungInput` already has `capacityCeiling:275` — add `turnCallBudget` pass-through).
- **Breaks + mitigation:** knip may flag the new module until consumed — consume it from
  governor immediately so it is not an orphan. Pure module → `guards.test.ts` applies.
- **Done test:** budget math unit moved + green; governor output unchanged
  (characterization suite byte-identical).
- **Size:** S.

### Slice 3 — Finish Layer B (objective-evidence escalation), flag-off
- **Goal:** wire `shouldEscalate`/`shouldDeEscalate` (`auto-brain.ts:543,586`, currently
  STUB per `:492`) into the work loop using verify results as the objective signal.
- **Files:** `orchestrate.ts` work-call/retry seam (where verify verdict lands),
  `auto-brain.ts` (constants `:529-530`).
- **Breaks + mitigation:** escalation re-runs cost quota — clamp with the Slice-2
  `turnCallBudget`. Hysteresis constants stay conservative; tune on `core/eval/` later.
- **Done test:** escalation fires on ≥2 objective failures, never on self-confidence
  (assert the banned path); de-escalation on clean-todo margin. New unit + eval dim.
- **Size:** M.

### Slice 4 — PICK THE BRAIN: auto-brain default-on, governor demoted to budget-only
- **Goal:** the irreversible swap. `autoBrain` → default-on (move to
  `experimentalEnabledByDefault` or make unconditional). In the SAME commit, strip
  governor's Job A: `governorPlan.tierRequest`/`roundBudget`/`verbosity` no longer
  consumed; governor reduced to supplying `turnCallBudget` via `turn-budget.ts`.
- **Files:** `menu.ts:2408` (flip auto-brain wiring to default-on), `:2544` (reduce
  governor wiring to budget), `orchestrate.ts:1664-1683` (allocate → budget-only),
  `:1909` (oracle gate now from `modelRung`), `:1950-1976` (levers from auto-brain).
- **Breaks + mitigation:** THIS is the single-brain cutover. Risk: routing distribution
  shifts. Mitigation: keep `MYSHELL_BASIC` and rollback switch live; ship behind a
  short canary (author dogfood) before tagging. Verify-level fallback `:1974` still
  protects the verify stage.
- **Done test:** only ONE code path sets tier; grep proves `tierRequest`/`roundBudget`/
  `verbosity` unreferenced; full suite green; manual smoke (greeting→budget, big
  refactor→high/max, see receipt).
- **Size:** L. **This is the keystone — do not split the default-flip from the demote.**

### Slice 5 — In-chat cost receipt (non-negotiable #6)
- **Goal:** surface the per-turn rung + spend in chat (auto-brain receipt
  `auto-brain.ts:471` already built at `orchestrate.ts:1080` but display-wired weakly).
  Add live spend from the ledger.
- **Files:** `menu.ts` status/receipt render; `orchestrate.ts:1080`; ledger read
  (`menu.ts:121,1281`).
- **Done test:** every turn prints one receipt line with rung + cost tier; snapshot test.
- **Size:** S.

### Slice 6 — Promote the spine flags + delete dead scaffolding
- **Goal:** PROMOTE rows 4-21 of §2 to unconditional/default-on; DELETE governor.ts,
  preflightGuard, planningDepth, itemParking flags + resolvers + `*-flag.ts`.
- **Files:** `config.ts:219-555` (remove promoted keys), `src/interface/ui/*-flag.ts`,
  `src/core/*-flag.ts`, `experimental-default.ts`, `menu.ts` wiring sites.
- **Breaks + mitigation:** knip will flag removed resolvers — delete tests with them.
  Do in dependency order (delete consumer wiring before the helper).
- **Done test:** `grep experimental` shows only KEEP set (basic, ink, rollback,
  tribunal-opt-out); knip green; suite green.
- **Size:** L (mechanical but wide).

### Slice 7 — `menu.ts` decomposition (7,037 lines → thin composition root)
- **Goal:** extract the now-stable wiring into composable modules.
- **Files:** `menu.ts` → `menu/wiring/*.ts`.
- **Done test:** `menu.ts` < ~2,000 lines; no behavior change; suite green.
- **Size:** L.

### Slice 8 — Windows health
- **Goal:** validate worktree/tribunal git-isolation + path handling on win32.
- **Done test:** tribunal-as-depth smoke on Windows; CI green on windows runner.
- **Size:** M.

---

## 4. Genuine risks

- **The cutover is a production brain SWAP, not a launch (§0).** Today governor routes
  every shipped turn. Slice 4 replaces the live router. Regression surface = the entire
  routing distribution, not "a new feature." Author must dogfood Slice 4 before tag.
- **`turnCallBudget` is the one capability that dies if governor is deleted carelessly.**
  Slice 2 MUST land before Slice 4, or cross-vendor levers lose their single hard cap
  and can multiplicatively spend (critic+poll+tribunal). This is the real quota risk.
- **Auto-brain's five unconsumed dials are untested *as consumed*.** `verifyDepth`/
  `effort`/`decompDepth` are produced (`mode-levels.ts:361-401`) but never read, so
  there is **zero coverage of their live effect**. Slice 1 must add it before Slice 4
  trusts them. This is the biggest coverage gap.
- **Layer B is a stub** (`auto-brain.ts:492-540`); shipping predict-and-commit without
  evidence-escalation ships half the thesis. Slice 3 is non-optional for "ready for
  real users," not a nice-to-have.
- **`menu.ts` decomposition: AFTER flag removal, not before.** Decomposing 7,037 lines
  while the flag wiring is still churning doubles the merge surface. Slice 6 deletes
  ~17 `*-flag.ts` imports and their menu sites first; Slice 7 then moves a *smaller,
  stable* file. Doing 7 before 6 means decomposing code you are about to delete.
- **Verify-level coupling:** verify (default-on) reads its level from governor
  (`orchestrate.ts:1972`) with a built-in fallback (`:1974`). The fallback de-risks the
  swap, but Slice 1 must route verify-level from `verifyDepth` or verify silently drops
  to the conservative default after governor demotion.
- **Single user-facing regression to watch:** auto-brain's non-hard path lets a trivial
  turn route *below* the classify floor to `budget` (`auto-brain.ts:371-399`). Governor
  never does that (it floors at the shape budget). Expect some "felt cheaper/dumber"
  turns; the receipt (Slice 5) is the mitigation — make the spend legible so it reads as
  intent, not degradation.

---

## 5. THE FIRST SLICE TO RUN

**Slice 1 — consume auto-brain's full RungTuple (`verifyDepth`/`effort`/`decompDepth`)
behind the still-off `autoBrainEnabled` flag.** It is the smallest reversible step, ships
byte-identical (flag off), and is the prerequisite that lets every later slice trust
auto-brain to do governor's job. Concretely: in `orchestrate.ts:903-918` read the extra
dials off `autoBrainResult.rung`, and at `:1972` add an auto-brain branch that sources
`verifyLevel` from `rung.verifyDepth` (above the existing governor branch). Add a unit
proving the mapping and confirm the flag-off neutrality suite is byte-identical.
