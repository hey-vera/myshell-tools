# myshell-tools — The Definitive Master Plan (10/10+)

> Capstone synthesis. Design only — no source edited. Brutally honest, grounded in the
> real code (file:line) and 2026 state of the art. Reconciles the four prior passes
> (`docs/quota-efficiency-audit.md`, `docs/quota-plan-v2.md`, `docs/quota-plan-final.md`,
> `docs/architecture-faithful-partner.md`) into one coherent program, then pushes past
> "a better agent CLI" into the categorically higher form the product can take.
>
> Ground rules carried through every recommendation: each step is **flag-gated, default-off
> = byte-identical**; **ship-green** = `tsc --noEmit` + targeted tests + **zero NEW failures
> by name-diff vs `main`** (≈57–92 pre-existing flaky/Windows failures exist — compare by
> NAME, not count); **reuse existing code** before adding; **efficiency is the servant, not
> the product**; **smallest verified win first**.

---

## 0. Executive summary (the spine, in one screen)

**The UFO leap.** myshell-tools stops being "a CLI that wraps coding agents" and becomes a
**Personal Work OS: one durable relationship that never needs a new chat and never asks you
to manage an agent.** Underneath it is a single append-only **Intent Ledger** — git for your
intentions — where every goal, work unit, and dollar exists *because of* a versioned intent,
is closed by *evidence*, and a correction surgically invalidates only its descendants; the
user just talks, and the system organizes, parallelizes, verifies, and remembers — forever.

**The single most important correction across all four docs:** the docs describe the
intelligence layer (auto-brain Layer A/B, governor, draft goals) as *built-but-dark/unfed* —
**that is now stale.** PRs #8/#11/#14/#17/#18 wired Layer A **and** Layer B and turned them
**on by default** (`src/interface/menu.ts:2407`, `src/core/orchestrate.ts:898`,
`src/core/work-call.ts:1012`). The brain is **live and unmeasured**. So the real gap is no
longer "turn the brain on" — it is **"the live brain is flying blind"**: it routes,
escalates, and parks goals with **no honest record of what those decisions cost or whether
they paid off** (no cache-write accounting, no aux accounting — `src/core/types.ts:176`).
**Instrumentation, not activation, is now job #1.**

- **Batter (core) = 10/10 in one line:** a durable **Intent Ledger** (versioned intent →
  evidence-bound work units → reversible correction) fused with **verified-work-per-quota**
  so "done" provably means done and every spend is attributable to an intent.
- **Icing (polish) = 10/10 in one line:** **one continuous relationship** — no "new chat,"
  no agent management; a legible live worklog + an honest **DONE-with-evidence / BLOCKED-for-
  a-correct-reason** receipt, and `"wait, you missed my point"` is a lossless one-tap fork.

**Top-5 build order (batter before icing; each flag-gated, default-off, ship-green):**
1. **`MYSHELL_CACHE_ACCOUNTING_V2`** — honest cache-write + effective-$ accounting (the
   blind brain gets eyes). *Smallest verified win.*
2. **`MYSHELL_ACCOUNT_AUX`** — ledger the route/intent/auto-stage/escalation calls the live
   brain already makes; add `intentVersionId` + `stage` tags (becomes the Intent Ledger seam).
3. **`MYSHELL_INTENT_STORE_V1`** — append-only intent-version store; thread `intentVersionId`
   into goals, work contracts, ledger, evidence (the load-bearing primitive).
4. **`MYSHELL_CORRECTION_FORK_V1` + `MYSHELL_BLOCKED_STATE_V1`** — reversible correction +
   honest terminal states (the partner feel; trust under vagueness).
5. **`MYSHELL_EVIDENCE_RECEIPT_V2` + `MYSHELL_NATIVE_SESSIONS_PROMOTE`** — proof-of-done
   receipt and server-resident continuity (verified-work-per-quota, made visible; quota PRs
   land here as the servant).

Full detail below.

---

## 1. The 10/10+ vision in one page

### What the user experiences
You open myshell-tools once and you **never open a "new chat" again.** There is one
relationship. You talk to it the way you'd brief a trusted senior colleague — loosely,
mid-thought, across days. It:

- **Hears what you actually mean.** On anything substantial it mirrors intent back in one
  compact line ("Objective: X. I'll assume Y. Done when Z.") and proceeds — no ceremony on
  trivial turns, one sharp question only when the answer changes the work.
- **Organizes itself.** Real work becomes legible, dependency-aware **goals** you never have
  to file, name, or babysit. Independent goals **parallelize themselves.** You never "manage
  agents" — the agents are an implementation detail of the goals, and the goals are an
  implementation detail of your intent.
- **Remembers forever.** Context **compounds**: decisions, constraints, taste, and prior
  verified work persist as durable state, not as a fragile scrollback you must re-paste.
- **Proves it's done.** "Done" arrives with a **receipt** — files changed, commands run,
  tests passed, reviewer verdict, and the *cost*. When it can't finish, it returns **BLOCKED
  with one real reason and one next action**, never a confident hallucination.
- **Lets you change your mind for free.** "Wait, that's not what I meant" **forks the
  intent**, keeps every still-valid piece of work, and discards only what your correction
  actually invalidated. No re-explaining. No lost progress.
- **Saves you money on purpose.** It stops replaying itself (native sessions + provider
  caches) and spends the saved quota on the only things that improve outcomes: verification,
  scoped retries, and continuity.

The feeling: **"I'm saving so much time and money — one simple system keeps all my work
organized so I never juggle chats or agents again, and I have a real work partner I can think
out loud with all day."**

### The category-defining promise
> **Say what you mean, loosely, forever. I make the intended work explicit, preserve that
> intent through execution, verify the result against reality, let you correct me at any
> point without losing valid work — and I never make you start over or manage me.**

### The UFO leap — what NO current agent tool is
Today's frontier (GitHub **Agent HQ** "mission control," multi-agent orchestrators, Cursor/
Claude Code/Codex) is converging on the **same** answer to agent sprawl: *a dashboard to
manage more agents.* That is the **car**, polished. It accepts sprawl as inevitable and sells
you a control plane for it.

The UFO is the opposite move: **abolish the management surface entirely.** Not "mission
control for your agents" — **no agents to control.** One relationship; goals that file,
schedule, and parallelize themselves; an **Intent Ledger** that makes the relationship's
entire history queryable, attributable, and correctable like a git history of *what you meant*
and *what it cost.* The leap is from **"orchestrate many conversations"** to **"there is only
one conversation, and it is your durable Personal Work OS."** Sprawl isn't tamed — it never
forms.

This is feasible *on this codebase specifically* because the organs already exist (intent
frames, auto-stage goals, work contracts, four-state verify, native sessions, governor,
ledger). They are not yet wired to a single durable spine. The leap is **integration and
provenance, not new agents.**

---

## 2. Reconciliation of the four prior docs

### Lineage
1. `quota-efficiency-audit.md` (the GPT-5.5 audit) — caching/efficiency findings.
2. `quota-plan-v2.md` (adversarial Opus review) — corrects the audit's mechanism.
3. `quota-plan-final.md` — synthesizes, demotes per-user RL, names the real differentiator.
4. `architecture-faithful-partner.md` — the product architecture (durable intent).

### Where they AGREE (carry forward as settled)
- **`cache_control` breakpoint wiring is a trap.** All later docs agree the providers are CLI
  subprocesses (`src/providers/port.ts:34`, `claude.ts:269`); there is no place to attach raw
  API `cache_control`. The audit's PR3 is **deleted.** ✔ (Verified: still true.)
- **Measurement before optimization.** Cache accounting is lossy: `cache_creation_input_tokens`
  is parsed but dropped (`src/providers/claude-parse.ts`), `LedgerEntry` has only
  `cachedInputTokens` reads (`src/core/types.ts:176`), and local pricing charges all input at
  list price. Fix accounting *first*. ✔ (Verified: `types.ts:167-202` still has no
  cache-write field.)
- **Per-user RL is correctly demoted.** A single user cannot generate enough stationary,
  clean outcome data; verification beats learning. Keep local Bayesian updates as **slow
  tie-breakers only.** ✔
- **The differentiator is VERIFIED WORK PER QUOTA UNIT.** Efficiency is the servant that buys
  cheap intent confirmation, re-planning, continuity, verification, and correction. ✔
- **Native session reuse is real and already plumbed** (`req.sessionId`/`resume` in
  `port.ts:51`, `claude.ts:151`, `codex.ts:127`, `grok.ts:117`; `native-session.ts:92`). It
  is the token-replay killer for the Claude pool — validate and promote, don't rebuild. ✔

### Where they CONTRADICT — and the resolution
| Tension | v1 audit | later docs | **Resolution** |
|---|---|---|---|
| Is the persona resent at full cost? | "probably resent full-price most turns" | v2: false on DeepSeek/OpenAI auto-prefix-cache pools; true only on Claude `-p` | **Both, by pool.** Claude `-p` recomputes our tail; DeepSeek/Codex auto-cache the token-0 persona. → measure per-pool (`MYSHELL_CACHE_ACCOUNTING_V2`), then Claude session reuse. |
| DeepSeek "token-0 / 1024-tok unit" exactness | v2 asserts it | final: 2026 docs softened phrasing | **Don't hard-code the unit.** Treat auto-prefix-caching as real but provider-defined; rely on reported hit/miss usage fields, not assumed boundaries. |
| Is the intelligence layer dark? | n/a | v2/final/arch: "built-but-dark/unfed," governor is the live brain | **STALE — see §3.** Auto-brain Layer A+B are now wired ON by default. The gap moved from *activation* to *instrumentation*. |
| Headline bet | efficiency | final: verified-work-per-quota; arch: durable intent | **Both, layered.** Durable intent is the *batter*; verified-work-per-quota is *how you prove it*; efficiency *funds* it. One system (§4). |

### What NONE of them saw (the gaps this plan closes)
1. **The brain went live between the writing of these docs and now.** Every doc reasons about
   a dark/ungated brain; the code has moved (PRs #8/#11/#14/#17). The docs' own roadmaps
   (e.g. arch §9 step "promote auto-brain," final's shadow-mode RL) are partly **already
   shipped** — and the live brain is **emitting unaccounted aux calls today.** This *raises*
   the urgency of the accounting PRs: they are no longer "nice telemetry," they are the only
   thing standing between a live autonomous router and a quota leak nobody can see.
2. **Doc-drift inside the source is now a trust hazard.** `src/core/auto-brain.ts:35-48` still
   says "LAYER B … stubbed, not yet wired" and "DEFAULT OFF"; `menu.ts:2401-2406` still says
   "SCAFFOLDING ONLY: orchestrate does NOT read autoBrainRungTuple" — **both false now.** In a
   trust product, comments that lie about whether an autonomous router is live are a defect.
3. **The agent/conversation-sprawl pain is the product's true north — and the market is
   solving it backwards.** Every 2026 sprawl solution (Agent HQ, orchestration platforms) is
   an *enterprise governance dashboard*. **Nobody is building the "no management surface,
   one durable relationship" answer for the individual.** That is white space the four docs
   treated as a footnote; this plan makes it the headline (§1, §4C).
4. **The Intent Ledger and the cost ledger are the same ledger.** The arch doc designs an
   intent/work/correction store; the quota docs design an aux/cache ledger. **Unify them:**
   one append-only provenance log where each entry carries `intentVersionId`, `stage`,
   evidence refs, *and* tokens/cache/$. That single fusion makes correction free, "done"
   provable, and spend attributable — in one substrate (§4).
5. **Self-parallelizing goals are within reach and unclaimed.** Goals already carry `deps`
   and states (`src/core/goal-todo.ts`); native sessions give per-goal continuity. A
   dependency-aware scheduler that runs independent goals concurrently — with the user never
   managing them — is the concrete mechanism behind "never manage agents again." No doc
   designed it.

---

## 3. Honest current-state map (real / live-but-blind / stale-doc / missing)

Cited to current `main`. Verified by reading the files, not the prior docs.

### REAL and working
- **Typed intent frames + extractor port.** `IntentFrame` models goal, non-goals,
  constraints, forks, doneWhen, confidence, risk hints, draft-goal byproduct
  (`src/core/intent.ts:45-107`); gated model extractor (`src/core/intent-extractor.ts`).
- **Unified preflight path exists** (one call instead of route+intent) and is unit-tested;
  still flag-gated (`src/core/orchestrate.ts` router seam; `src/core/router.ts`
  `unifiedPreflightApplies`).
- **Auto-stage goals default-ON** (`src/interface/ui/auto-goal-flag.ts:33`) — post-turn
  judge stages parked goals or asks one question.
- **Draft-goal byproduct default-ON** (PR #18) — build turns emit a parked draft goal
  skeleton (`src/core/intent.ts:88-106`).
- **Work contracts** model objective/roadmap/checkpoints/verification with evidence-only
  item verdicts (`src/core/work-contract.ts`).
- **Four-state verification, honest, refuses fake-green** (`src/core/verify.ts`); diff-scoped
  critic reviews the actual diff.
- **Native sessions** plumbed + hardened for stale history across Claude/Codex/Grok
  (`src/core/native-session.ts`, provider `--resume`/`--session-id`).
- **Governor** allocates budget and runs active verification (`src/core/governor.ts`).
- **Goal store** enforces evidence-only verdict writes; replan/cancel preserve verified work
  (`src/infra/goal-store.ts`, `src/core/goal-replan.ts`).
- **Ledger** records work/review/poll/tribunal with `taskKind` + `reasoningEffort`
  (`src/core/types.ts:167-202`).

### LIVE-BUT-BLIND  *(this is the corrected category — was called "dark/unfed")*
- **Auto-brain Layer A (rung-fusion routing) is ON by default.** Injected via
  `experimentalEnabledByDefault(..., 'MYSHELL_AUTO_BRAIN', ...)` at
  `src/interface/menu.ts:2407-2428`; consumed at `src/core/orchestrate.ts:898` and used as
  the starting-tier override at `orchestrate.ts:1808`. (PR #11 activated, PR #14 defaulted on.)
- **Auto-brain Layer B (objective-evidence escalate-and-retry) is wired.** Live gate at
  `src/core/work-call.ts:1012-1064`; enabled whenever Layer A committed a rung
  (`orchestrate.ts:1950-1953`). (PR #17.)
- **The blindness:** none of these decisions are accounted. `LedgerEntry` has **no
  cache-write field** (`types.ts:176`); route-classifier has **no usage/ledger path**;
  intent-extractor captures usage but orchestrate drops it (`.frame`). So the live router
  spends quota on aux + escalation calls **that never appear in any ledger or receipt.** A
  live autonomous router with no cost telemetry is the single highest-risk state in the repo.

### STALE-DOC (source comments that now lie — fix as part of the relevant PR)
- `src/core/auto-brain.ts:35-42` "LAYER B … stubbed, not yet wired" — **wired** (PR #17).
- `src/core/auto-brain.ts:48` & `auto-brain-flag.ts:6-20` "DEFAULT OFF / never consumed" —
  **on by default & consumed.** (The *pure helper* `autoBrainEnabled` still returns false for
  neutrality tests; the *composition root* turns it on — both true, but the prose misleads.)
- `src/interface/menu.ts:2401-2406` "SCAFFOLDING ONLY: orchestrate does NOT read
  autoBrainRungTuple" — **orchestrate reads it** (`orchestrate.ts:898`).
- `src/core/governor.ts` header (per arch doc §8) claims verification inactive while the body
  runs it — confirm and correct.

### FAKE / ASPIRATIONAL / MISSING (the real build surface)
- **No durable intent-version store.** `IntentFrame` is per-turn control data, not an
  accepted, persisted, parent-linked contract. *The central missing primitive.*
- **No correction DAG.** "Wait, you missed my intention" cannot fork from a divergence point
  or compute invalidated descendants; reuse is manual.
- **Goal provenance is source-level, not intent-version-level** (`goal-todo.ts` has
  `source`/`parentGoalId`, not `intentVersionId`).
- **No first-class BLOCKED terminal.** Loop exhaustion returns best-effort success-shaped
  output (`work-call.ts` final path); usable-partial vs verified-done is not distinguished.
- **No cache-write / aux accounting** (above) → effective-$ and honest receipts impossible.
- **No durable, queryable worklog.** Events exist (`CoreEvent` in `types.ts:972+`) but aren't
  persisted/queryable against intent/work-unit IDs.
- **No self-parallelizing goal scheduler.** Goals have `deps` but nothing runs independent
  ones concurrently.
- **`verify`-required-for-done is not enforced** universally (verification is optional via
  `verifyPort`).

---

## 4. The unified architecture — one coherent system

Four threads the prior docs kept separate are **one substrate**. The spine is a single
append-only **Provenance Ledger** (the Intent Ledger and the cost ledger, fused).

```
            ┌────────────────────────── ONE DURABLE RELATIONSHIP ──────────────────────────┐
 USER  ──▶  │  INTENT MIRROR ──▶ INTENT VERSION (vN) ──▶ GOAL DAG ──▶ WORK UNITS            │
 (loose)    │        ▲                  │                   │ self-schedules    │            │
            │        │ correction       │ cites vN          │ parallel deps     │ cites vN   │
            │        └── FORK (vN→vN+1) ┘                   ▼                   ▼            │
            │                              EVIDENCE  ◀── VERIFY (4-state) ── tools/tests     │
            │                                 │                                 │            │
            │            PROVENANCE LEDGER  ◀──┴── tokens · cache r/w · $ · stage · vN ──────│
            │                                 │                                              │
            │                          RECEIPT: DONE-with-evidence  |  BLOCKED-for-a-reason  │
            └──────────────────────────────────────────────────────────────────────────────┘
```

**A. Durable intent provenance (the load-bearing primitive — "git for intentions").**
Append-only `IntentVersion` store (arch doc §5 data model): immutable, parent-linked,
carrying objective / non-goals / assumptions / constraints / doneWhen / risk / confidence /
confirmationPolicy / acceptedAt. Every goal, work contract, evidence snapshot, ledger entry,
and receipt carries `intentVersionId`. *Validated externally by the 2026 spec-driven-
development trend (versioned structured specs as source of truth) and "Git Context
Controller" (manage agent context like git).* This makes the next three threads possible.

**B. Faithful-partner loop (the behavior).** `USER → MIRROR → INTENT VERSION → GOAL DAG →
WORK UNITS → EVIDENCE → VERIFY → RECEIPT → CORRECT/FORK` (arch §5). The existing organs slot
in: auto-stage = goal birth; work-contract = the per-goal plan; verify = the done gate;
trust-receipt = proof; governor = spend discipline; correction = a normal lossless branch.

**C. Agent/conversation-sprawl elimination (the differentiator made mechanical).** *No new
chat, ever:* the relationship is the unit; turns append to it; native sessions keep context
server-resident (`native-session.ts`) so continuity is real, not a re-pasted scrollback.
*No agent management, ever:* goals are the only object the user sees; a **dependency-aware
scheduler** runs independent goals concurrently and serializes dependents (goals already
carry `deps`/states in `goal-todo.ts`); "agents" are an invisible implementation detail.
*Nothing to organize:* auto-stage files goals; the Intent Ledger is the searchable history.
This is the deliberate inversion of Agent HQ's "mission control" — **abolish the management
surface instead of building one.**

**D. Verified-work-per-quota (the proof + the economics).** "Done" requires evidence
(`verify` passing/reviewed) — enforced, not optional. Every spend is attributed to an
`intentVersionId` and a `stage` in the Provenance Ledger, priced **cache-aware** so the
receipt tells the truth. The saved quota (native sessions + provider auto-cache) is
**re-invested** in verification, scoped retries, and continuity — never in replaying the
persona. The live auto-brain (Layer A/B) becomes *trustworthy* precisely because its routing
and escalation are now **measured against realized cost-adjusted outcome**, not slogans.

**Coherence rule (one mind, not stitched parts):** every user-visible state — mirror, goal,
worklog line, receipt, block — derives from the **same** Provenance Ledger entries. There is
no second source of truth. That is what makes the whole thing feel like a single colleague
rather than a pile of features.

---

## 5. CORE (batter) 10/10 and POLISH (icing) 10/10 — explicit, and how they cohere

### The batter — 10/10 core spec (must be right ingredients, right amounts)
1. **Intent as a versioned operational object**, not prompt prose. Every substantial action
   cites an intent version; every version has explicit assumptions + done criteria; every
   assumption is confirmed, overridable, or verifier-checkable.
2. **Evidence-bound work.** No work unit is "done" without machine-checkable evidence
   (tests/typecheck/lint/diff/command output/approval). Reuse `verify.ts` four states; make
   `verify`-required-for-done the universal gate.
3. **Reversible correction.** A correction forks intent and invalidates *only* descendants
   whose dependency tags the changed fields touched; valid work is preserved with a one-line
   explanation ("Re-steered v3→v4: kept the parser + tests; discarded the UI copy").
4. **Honest terminal states.** `DONE` (evidence-backed) or `BLOCKED` (one reason from a fixed
   taxonomy + one next action + preserved work). Never confident-but-unverified success.
5. **Attributable economics.** One Provenance Ledger; cache-aware pricing; aux + escalation
   calls accounted; the live auto-brain's decisions measured against realized outcome×cost.
6. **Continuity over replay.** Native sessions default for single-provider conversations;
   stop replaying the compacted history block; context compounds instead of truncating.

*Right amounts (anti-gold-plating guardrails):* no per-user RL headline; no semantic response
cache (exact-hash only); no `cache_control` refactor; no persona-shrinking; no second
state store. Add complexity **only** where it measurably improves verified-work-per-quota.

### The icing — 10/10 polish/feel spec (the magic the user feels)
1. **Zero ceremony, infinite memory.** One relationship; no "new chat"; the system never asks
   you to repeat context it already holds.
2. **The Intent Mirror.** On substantial turns, one calm line: *"Objective X. Assuming Y.
   Done when Z. (say 'wait…' to steer.)"* — tap/enter to proceed. Trivial turns: nothing.
3. **Legible live worklog.** A compact operational trace (current hypothesis, active tool,
   verification plan, blockers) — not spinner prose, not thought-dumping. Persisted +
   queryable, tied to intent/work-unit IDs.
4. **The receipt.** Every finish: files changed · commands run · tests/verdict · open risks ·
   **cost & cache savings**. "Done" *looks* done.
5. **`wait…` is sacred.** Correction is a first-class one-tap control flow, never an error,
   never a re-explanation.
6. **Recommend once, then comply** (and approval gates for irreversible/secret/high-risk —
   matching EU AI Act Art. 14 human-oversight expectations, enforceable Aug 2026). The
   partner collaborates, never argues.
7. **Self-organizing surface.** Goals appear, parallelize, and resolve themselves; the user
   sees progress, never a management console.

### How they cohere
The icing is **literally a rendering of the batter.** The mirror renders the pending
`IntentVersion`; the worklog renders ledger events; the receipt renders evidence + cost
entries; `wait…` writes a `Correction` that forks the intent graph. Because every surface
reads the **one** Provenance Ledger, the experience is a single coherent mind. A weak core
would make the icing lie (pretty receipts over unverified work); weak icing would bury a
great core (provenance the user can't see or steer). Both must ship together per spine slice.

---

## 6. Ranked ground-shattering bets (transformative impact × feasibility)

Honest framing: most "10x" agent claims are vaporware on a single-user CLI. These are ranked
by **step-change × feasibility on THIS code**, with the vaporware called out.

| # | Bet | Impact | Feasibility (this code) | Verdict |
|---|---|---|---|---|
| **1** | **Provenance Ledger = Intent Ledger ⊕ Cost Ledger.** One append-only log; every entry carries `intentVersionId` + `stage` + evidence + tokens/cache/$. | **Highest** — makes correction free, "done" provable, spend attributable, and the live brain measurable, all in one substrate. | **High** — `LedgerEntry`/`CoreEvent` already exist; this is additive columns + a store, not new agents. | **BUILD FIRST.** The keystone; every other bet rides it. |
| **2** | **No-new-chat, no-management relationship** (continuity + self-parallelizing goals). | **Highest** — directly kills the owner's named pain; the actual category leap. | **Med-High** — native sessions plumbed; goals carry `deps`; needs a scheduler + relationship-scoped session state. | **BUILD** after #1. The UFO, made of parts that exist. |
| **3** | **Verified-work-per-quota as enforced contract** (`verify`-required-for-done + cache-aware receipt + re-invest saved quota in verification). | **High** — turns the differentiator from slogan into guarantee. | **High** — `verify.ts` + governor + ledger present. | **BUILD** alongside #1/#2. |
| **4** | **Reversible correction DAG** ("git for intentions" forks). | **High** — trust-under-vagueness; nobody else has lossless mid-flight re-steer. | **Med** — needs intent store (#1) + dependency tagging of work units. | **BUILD** after #1. |
| **5** | **Native-session continuity as default substrate** (server-resident context, no lossy 6k-char compaction). | **High** (cost + coherence) | **Med-High** — plumbed; risk is mid-conversation tier/provider switch + stale-session quarantine. | **PROMOTE** after #1 proves it. |
| **6** | **Cost/outcome priors for the live auto-brain** (route/escalate on realized cost-adjusted value per taskKind). | **Med-High** — the brain is already live; this makes it *smart*. | **Med** — needs #1's data; keep **shadow-mode for a long time**; single-user data is thin. | **BUILD LATE, shadow-first.** Not the headline (RL stays demoted). |
| **7** | **Governor runtime budget** (enforce measured per-turn $ caps; gate poll/tribunal/panel by marginal value/$). | **Med** | **Med** — gates exist; budgets advisory today. | **BUILD LAST**, log-only first; can degrade quality if mistuned. |

**Honest non-bets / vaporware (do NOT build):**
- ✗ Per-user RL/bandit as the headline — insufficient stationary single-user data (final doc's
  math: ~160–650 obs/arm; a heavy user does 20–50 turns/week). Keep as slow tie-breaker only.
- ✗ Semantic/embedding response cache — a wrong fuzzy hit is worse than a miss; exact-hash only.
- ✗ `cache_control` breakpoint wiring / "structured prompt parts" refactor — unreachable via CLIs.
- ✗ Persona-shrinking — trades the product's voice for pennies auto-caching already saves.
- ✗ Request batching — Batch API is async/offline; this is an interactive CLI.
- ✗ Cross-user aggregation as a core claim — it's a privacy product; opt-in, coarse, later.

---

## 7. The coherent build order (batter before icing; flag-gated; ship-green)

Every step: **default-off ⇒ byte-identical**; gate with `tsc --noEmit` + targeted tests +
**zero NEW failures by name-diff vs `main`**; reuse existing code; smallest verified win
first. The quota PRs are folded in **as the servant** at the points where they unblock the
spine. Ordered so each step de-risks the next.

> **Step 0 (free, do immediately, no flag): fix the lying comments.** Correct the stale
> headers in `auto-brain.ts:35-48`, `auto-brain-flag.ts:6-20`, `menu.ts:2401-2406`,
> `governor.ts` header to state that Layer A/B are **live and on by default**. Doc-only,
> zero behavior change, removes a trust hazard in an autonomous router. *This is the cheapest
> 10/10 move in the whole plan.*

### Phase I — Give the live brain eyes (instrumentation; the batter's foundation)
1. **`MYSHELL_CACHE_ACCOUNTING_V2`** — add `cacheCreationInputTokens?` to `Usage`
   (`port.ts:28`) and `cacheWriteInputTokens?` to `LedgerEntry` (`types.ts:167`); map Claude
   `cache_creation_input_tokens` (`claude-parse.ts`) and OpenCode `cache.write`
   (`opencode-parse.ts`); cache-aware effective-$ beside `calculateCost` (`pricing.ts:219`);
   new lines in `cost.ts`. **Validate against provider `total_cost_usd`.** *Smallest verified
   win; absent ⇒ byte-identical.* (Quota PR1.)
2. **`MYSHELL_ACCOUNT_AUX`** — ledger **stage entries** for route-classifier, intent-extractor
   (stop dropping `.frame` usage at `orchestrate.ts`), re-extract, recap, understanding,
   auto-stage, **and the now-live Layer-A/B routing + escalation calls.** Tag with `stage` so
   they don't pollute work-call learning. **This is also the first Provenance-Ledger seam:
   add an optional `intentVersionId` column now** (absent today ⇒ no change). (Quota PR2 +
   bet #1 seam.) *Proves what the live brain actually spends — the highest-urgency gap.*

### Phase II — Lay the spine (durable intent; the load-bearing primitive)
3. **`MYSHELL_INTENT_MIRROR_V1`** — pure `IntentMirror` builder from `IntentFrame`; render on
   substantial/ambiguous/high-risk turns only; no persistence yet. (Arch step 1.)
4. **`MYSHELL_INTENT_STORE_V1`** — append-only `IntentVersion` store; thread `intentVersionId`
   into goal creation, work contracts, and the ledger column from step 2. *The keystone
   (bet #1).* (Arch step 2.)
5. **`MYSHELL_WORKLOG_V1`** — persist typed work events keyed by intent/goal/work-unit IDs;
   render the compact live status from the same events. (Arch step 3.)

### Phase III — Make the partner faithful (the trust behaviors)
6. **`MYSHELL_BLOCKED_STATE_V1`** — first-class `BlockedReason` terminal (fixed taxonomy) for
   goals/work units; replace best-effort success-shaped exhaustion with `partial_result +
   blocked_reason + next_action + preserved_work`. (Arch step 6.)
7. **`MYSHELL_VERIFY_REQUIRED_FOR_DONE`** — a goal can't reach `done` unless goal-level verdict
   is `passing`/`reviewed` (matches existing evidence-only rules `goal-todo.ts`). *Makes
   verified-work-per-quota a contract, not a hope.* (Arch step 7 / bet #3.)
8. **`MYSHELL_CORRECTION_FORK_V1`** — detect "wait/actually/you missed/not that" + `/correct`;
   fork intent, compute invalidation by dependency tags, preserve unaffected evidence. *Trust
   under vagueness (bet #4).* (Arch step 5.)

### Phase IV — Verified continuity + the receipt (the icing, on a proven batter)
9. **`MYSHELL_EVIDENCE_RECEIPT_V2`** — promote the turn-level receipt to an async **goal
   receipt**: changed files, commands, test results, verifier state, reviewer, **cache-aware
   cost** (from Phase I), preserved/invalidated work. *The icing that renders the batter.*
10. **`MYSHELL_NATIVE_SESSIONS_PROMOTE`** — promote native-session reuse after Phase I
    telemetry proves lower replay cost + no stale-state regression; omit replayed history on
    resumed turns. Includes the already-built **`MYSHELL_UNIFY_PREFLIGHT`** flip (one call
    instead of route+intent — logic + tests exist) and **`MYSHELL_PREFLIGHT_CACHE`**
    (exact-hash aux memo). (Quota PR2/PR3/PR4, landed where they pay off.)

### Phase V — Self-organization + disciplined spend (the leap completes)
11. **`MYSHELL_GOAL_SCHEDULER_V1`** — dependency-aware concurrent execution of independent
    goals (uses `goal-todo.ts` `deps` + per-goal native sessions). *Mechanizes "never manage
    agents again" (bet #2).* Start with parallelism=1 (byte-identical), then raise.
12. **`MYSHELL_OUTCOME_PRIORS_SHADOW`** — feed the live auto-brain realized cost-adjusted
    outcome per taskKind from the Provenance Ledger; **shadow/log-only** ("would route
    differently") for a long calibration period before any auto-reroute (bet #6).
13. **`MYSHELL_GOVERNOR_RUNTIME_BUDGET`** — enforce measured per-turn budgets; gate
    poll/tribunal/panel by marginal value/$; **log-only first**, then active (bet #7).

**Why this order:** you cannot trust a live autonomous router you can't measure (Phase I
before anything), you cannot make correction free or "done" provable without the intent spine
(Phase II), the trust behaviors need that spine (Phase III), the icing must render a real
batter (Phase IV), and self-organization + learned spend need the full ledger + a calibration
window (Phase V). Each phase ships a **complete, user-visible slice** of one coherent mind.

---

## 8. Sources

**Codebase (verified, current `main`):** `src/core/auto-brain.ts:35-90`,
`src/interface/menu.ts:2401-2428`, `src/core/orchestrate.ts:880-918,1800-1953`,
`src/core/work-call.ts:1012-1064`, `src/core/types.ts:167-202`,
`src/interface/ui/auto-brain-flag.ts`, `src/interface/ui/auto-goal-flag.ts`,
`src/core/intent.ts:45-107`, `src/core/work-contract.ts`, `src/core/verify.ts`,
`src/core/native-session.ts`, `src/core/governor.ts`, `src/infra/goal-store.ts`,
`src/core/goal-todo.ts`, `src/providers/port.ts:34-53`; git history PRs #5–#19
(`git log --oneline`).

**Prior design passes:** `docs/quota-efficiency-audit.md`, `docs/quota-plan-v2.md`,
`docs/quota-plan-final.md`, `docs/architecture-faithful-partner.md`.

**2026 state of the art (web):**
- AI agent memory as a dedicated architectural component; compounding cross-session context —
  https://mem0.ai/blog/state-of-ai-agent-memory-2026 ; https://www.cognee.ai/blog/guides/ai-coding-agent-persistent-codebase-memory ; https://blog.cloudflare.com/introducing-agent-memory/
- "Git Context Controller: Manage the Context of LLM-based Agents like Git" (validates
  git-for-intentions) — https://arxiv.org/pdf/2508.00031
- Spec-driven development as 2026 source-of-truth answer to vibe-coding intent drift —
  https://thebcms.com/blog/spec-driven-development ; https://www.augmentcode.com/tools/best-spec-driven-development-tools ; "Intent Debt" — https://arxiv.org/pdf/2603.22106
- Human-in-the-loop correction UX; corrections as signal; EU AI Act Art. 14 (Aug 2026) —
  https://galileo.ai/blog/human-in-the-loop-agent-oversight ; https://callsphere.ai/blog/ai-agent-human-in-the-loop-patterns-critical-decisions
- Agent sprawl as a named 2026 problem; the market's "mission control" answer (GitHub Agent
  HQ) — https://www.ibm.com/think/topics/ai-agent-sprawl ; https://scopir.com/posts/multi-agent-orchestration-parallel-coding-2026/ ; https://www.gosearch.ai/blog/ai-agent-sprawl/
- Verification / ground-truth: golden datasets, calibrated LLM-judge, CI gates, ≥500 cases —
  https://www.digitalapplied.com/blog/ai-agent-evaluation-pipeline-2026-testing-methodology ; https://www.confident-ai.com/knowledge-base/compare/best-ci-cd-tools-testing-ai-agents-before-production-2026
- Provider caching ground truth (carried from prior docs): Anthropic prompt caching &
  Claude Code auto-cache/sessions; OpenAI & DeepSeek automatic prefix caching —
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching ; https://code.claude.com/docs/en/prompt-caching ; https://openai.com/index/api-prompt-caching/ ; https://api-docs.deepseek.com/guides/kv_cache
