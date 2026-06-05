# Whole-Tool Finish 5.5 — The Cross-Cutting Product Layer (Phase 9)

Scope: design only. **No `src/` or `test/` changes are made here.** This doc owns the
five whole-tool gaps the final quality gate named as gating a genuine 10/10
([`final-gate-5.5.md` §6](./final-gate-5.5.md), items 1–5) — the product layer that the
seven feature docs deliberately leave out because a 10 is *the tool*, not seven features
that each work alone. It slots into the master plan as **Phase 9 — Whole-tool finish**
(`final-gate-5.5.md` §7, last phase; depends on 0→2→3→4→{5,6}→7→8 all landing first).

Sibling 5.5 docs (do not edit — owned elsewhere): `memory-architecture-5.5.md`,
`partner-and-memory-design-5.5.md`, `MASTER-PLAN-5.5.md` are written by a parallel agent.
This doc cross-references but never mutates them.

Two non-negotiable throughlines, asserted once here and assumed in every section:

- **Subscription-aware.** The user pays a flat subscription (OAuth, not API-key). Our
  added overhead spends *quota + latency*, never dollars. The user must **never hit a wall
  because of our overhead** — when quota is pressured we shed *our* features first and the
  core answer always survives (§3).
- **Fail-soft throughout.** Every new surface degrades to "the tool still answers" on any
  failure. Nothing we add can block, throw to the user, or turn a working turn into a
  failed one. This mirrors the discipline already proven in `route-classifier.ts` and the
  memory store's corrupt-index recovery (`conversations.ts:84-92`).

---

## 0. The shared primitives this layer introduces

These three small primitives are referenced by every section below. They are the only
genuinely *new* cross-cutting machinery; each is pure or near-pure and independently
tested.

### 0.1 `firstTouch` state — "show this once, ever"

The new surfaces each need a one-line, dismissible, *shown-once* first-touch explanation
(§1). Tracking lives in `AppConfig` (not conversation meta — first-touch is per-user, not
per-conversation), as one additive key, consistent with the existing additive-key pattern
that `loadConfig` merges over defaults (`config.ts:147-149`, unknown/new keys always
present):

```ts
// AppConfig (config.ts:18-104), additive — merged over DEFAULTS, never throws on absence
interface AppConfig {
  // ...existing + memory keys from memory-architecture-5.5.md §9...
  /**
   * Per-user "I have shown the first-touch explainer for feature X" flags.
   * Absent → nothing shown yet. Each key flips to true the first time that
   * surface is encountered. Forward-compatible: unknown keys are preserved by
   * loadConfig's merge (config.ts:147-149), so a downgrade then re-upgrade is safe.
   */
  seen?: Partial<Record<FirstTouchKey, true>>;
}

type FirstTouchKey =
  | 'memorySave'      // first memory Save/Skip approval selector
  | 'intentReflect'   // first "here's what I understand" intent reflection
  | 'panelWaiting'    // first "Waiting on N models" panel status
  | 'recap'           // first ※ recap on resume
  | 'apeEngage';      // first time APE visibly chose to ask/plan/investigate
```

Pure decision seam (exported, table-tested), so the *policy* is testable without any TTY:

```ts
// src/core/first-touch.ts (new, pure)
export function shouldShowFirstTouch(key: FirstTouchKey, seen: AppConfig['seen']): boolean {
  return seen?.[key] !== true;
}
export function markSeen(key: FirstTouchKey, cfg: AppConfig): AppConfig {
  return { ...cfg, seen: { ...cfg.seen, [key]: true } };
}
```

The *rendering* of a first-touch line is one tiny helper in the interface layer that
gates on `shouldShowFirstTouch`, prints a dimmed one-liner (via the existing `dim()` /
`out.color` seam, `theme.ts:17`), and persists `markSeen` through `saveConfig`. The save is
**best-effort and fire-and-forget** — a failed `saveConfig` only risks showing the line
once more, never blocks the turn (fail-soft).

### 0.2 `teach()` — the one "error that teaches" formatter

A single shared formatter (§2) so every new feature's *surfaced* failure reads the same
way: **what happened · what the tool did · what you can do**. Pure, returns a string;
honors `out.color` exactly like the theme helpers (so it degrades to plain text off-TTY /
`NO_COLOR`, `cli.ts:191-192`):

```ts
// src/core/teach.ts (new, pure) — no I/O, returns the formatted block
export interface TeachNotice {
  what: string;            // what happened, in plain language ("Memory was busy")
  did: string;             // what the tool did about it ("answered without it")
  you?: string;            // optional: what the user can do ("/memory to inspect")
  severity: 'info' | 'warn';
}
export function teach(n: TeachNotice, color: boolean): string;
// renders e.g.  ⚠ Memory was busy — I answered without your saved preferences this turn.
//                  You can retry, or run /memory to check what's stored.
```

`severity:'info'` is dim; `severity:'warn'` is yellow (`theme.ts:37`). Never red — red is
reserved for a *terminal core failure* (the turn itself failed), which is the existing
renderer's job, not ours. Our features failing is never red, because the answer survived.

### 0.3 `CapabilityBudget` — the one place the overhead is summed

A single typed table (§3) that names, per turn-class, the worst-case *added* calls and
tokens, and the shed order. It is **data, not behavior** — a constant the shed policy reads
— so it is trivially testable and reviewable. Lives in `src/core/capability-budget.ts`.

---

## 1. Onboarding / First-Run for the NEW surfaces

**Decision: progressive, just-in-time, once-each — NOT a bigger setup wizard.** `runWelcome`
(`menu.ts:1296-1405`) is already a careful ~30-second flow (install → sign-in → mode). It is
explicitly orientation-light ("a few questions, ~30 seconds", `menu.ts:1323`) and we must
not bloat it. Five new concepts cannot all be front-loaded there — a user who has not yet
*seen* a memory approval cannot understand an explainer about it. So onboarding for the new
surfaces is **deferred to first encounter**, with exactly two things added at setup time and
the rest taught in-context.

### 1.1 What `runWelcome` gains (setup-time, minimal)

Exactly **one** new line, after the mode prompt (`menu.ts:1411-1414`), before the config is
saved (`menu.ts:1417`):

> `Memory is on — I'll remember preferences you approve. Turn it off or see what's stored anytime with /memory.`

Rationale: of the five surfaces, **only memory is "always-on and writes durable state about
the user."** A 10/10 tool that quietly turns on memory is creepy; the gate's §6.1 explicitly
demands a *"memory is on; here's how to turn it off"* moment. The other four (intent
reflection, panel status, recap, APE engagement) are *visible ephemeral behaviors* the user
sees happen — they self-explain better in-context than in a setup wall. So memory gets the
one setup-time sentence; the rest get just-in-time first-touch lines.

This line is gated on `!cfg.onboarded` (it only ever runs inside `runWelcome`), so it is
structurally once-only and needs no `seen` flag. It writes through the existing `out.write`
+ `dim` seam and respects `out.color`.

### 1.2 First-touch lines (just-in-time, once each)

Each of the four visible surfaces prints a single dimmed line the **first time** it occurs,
gated by `shouldShowFirstTouch` (§0.1) and then `markSeen` + best-effort `saveConfig`:

| Surface | Hooks where | First-touch line (dim, one line, dismissible by just continuing) |
|---|---|---|
| Memory Save/Skip approval | the post-turn slot's approval selector (chat-ux Phase 0 `decidePostTurn`; memory §8) — printed immediately *above* the first selector | `I can remember this for next time. Save keeps it; Skip forgets it. Manage anytime with /memory.` |
| Intent reflection | `renderStream` when the first `intent` CoreEvent renders (intent §5; presentation Q4 event) | `(I restate what I understood before working — correct me if I'm off.)` |
| "Waiting on N models" panel | `renderStream` panel state machine, first time it enters panel mode (presentation §4.2) | `Running your signed-in models in parallel and combining their answers — costs no extra on your plan.` |
| ※ recap on resume | the resume path that replaces the tail-echo (`menu.ts:2347`; recap §289) — printed once above the first ※ line | `※ marks a short recap of where we left off.` |
| APE visible engagement | when APE's chosen action surfaces a visible posture change (ask / plan / investigate) for the first time (APE engagement render) | `(I chose to <ask/plan/investigate> here because the task warranted it — type to steer me.)` |

Design rules for these lines:
- **Once each, ever.** `seen` is per-key, per-user. A user who has used the tool for a week
  never sees them again, even across upgrades (the `seen` map is preserved by config merge).
- **Dismissible = no interaction.** They are printed inline and the user simply continues;
  none of them block, prompt, or require acknowledgement. (The memory one prints *above* a
  selector that the user was going to interact with anyway — it adds no new interaction.)
- **Degrade:** all route through `dim()`/`out.color`; under `NO_COLOR`/off-TTY they are plain
  text, never suppressed (they are informational, not decorative — unlike the `●` glyph which
  `MYSHELL_PLAIN` may drop, presentation §3). They are *short* so a plain terminal stays calm.
- **Quota/cost:** zero model calls. Pure local string + one best-effort config write.

### 1.3 Unified `/help` update (covers all five)

There are **two** `/help` surfaces and they must not diverge (this is the §4 concern in
miniature). The menu-chat help (`menu.ts:2527-2534`) is the full one; the REPL help
(`repl.ts:24-30`) is the lean one. Phase 9 rewrites the menu-chat `/help` to a grouped block
that introduces every new surface in one place:

```
  Just type to chat — I pick the right model for each message.
  /goal <text>   — work autonomously until the goal is done (Ctrl+C to stop)
  /mode          — quality vs speed (Efficient / Balanced / Max)
  /memory        — see, edit, export, or delete what I remember (/forget to remove)
  /recap         — short recap of where this conversation left off
  /style         — how forward I am: ask-first vs just-do-it
  /back, /exit   — return to the main menu
  /help          — show this help

  About what you'll see:
    ※              a recap of where we left off (on resume)
    "what I understood…"   I restate the task before big work — correct me anytime
    "Waiting on N models"  your models running in parallel (no extra cost on your plan)
    Save / Skip            I asked to remember something — Save keeps it
```

The REPL `/help` (`repl.ts:24-30`) gets **one** added pointer line, honestly stating the
asymmetry rather than pretending parity (§4):

```
  <task>    Run a task (any other non-empty line)
  (The full chat experience — memory, recap, /style — lives in the menu chat.)
```

### 1.4 The explicit "memory is on; how to turn it off / see it" moment

Three reinforcing touchpoints, no nagging:
1. **Setup line** (§1.1) — stated once at onboarding.
2. **First memory approval first-touch line** (§1.2) — names `/memory` exactly when relevant.
3. **`/help`** — always lists `/memory` with "see, edit, export, or delete."

`/memory off` (or Settings "Memory: on/off", memory §9) flips `memory:false`, after which
retrieval injects nothing and capture no-ops, but `/memory` still lists existing facts for
export/delete (memory §9 kill-switch). This is the honest, reversible posture a 10 needs.

### 1.5 Tests (pure seams)

- `first-touch.test.ts`: `shouldShowFirstTouch` true when key absent, false after `markSeen`;
  `markSeen` is immutable and preserves other keys and the rest of config.
- `config.test.ts` (extend): a config with an unknown future `seen` key round-trips through
  load→save without loss (forward-compat).
- `help.test.ts` / `menu.test.ts`: the menu-chat `/help` string contains `/memory`, `/recap`,
  `/style`, `※`, and "Waiting on N"; the REPL `/help` contains the asymmetry pointer.
- A render-level test that a first-touch line is emitted once and not on the second occurrence
  (drive the pure gate with a `seen` map mutated between calls — no TTY needed).

---

## 2. Unified Error / Teach-on-Failure UX

**Decision: one shared `teach()` format (§0.2), one transient-vs-terminal rule, one
silent-vs-surfaced rule.** The GOLDEN-PLAN tenet is "error messages that teach"
(`GOLDEN-PLAN.md:320`); each feature doc handles *its own* failure but no doc unifies the
voice. Phase 9 does.

### 2.1 The shared "error that teaches" shape

Every *surfaced* feature failure is rendered with `teach({ what, did, you?, severity })`
(§0.2): **what happened (plain language) · what the tool did about it · what you can do.**
Never a stack trace, never a raw error string, never red (our features failing never fails
the turn — §0.2).

### 2.2 Transient vs terminal

- **Transient** (lock contention, timeout, a slow worker, a momentary parse glitch): the tool
  **retries-or-skips silently and proceeds**. If it skips a *user-visible* capability the user
  was relying on, it emits one `severity:'info'` `teach` line; otherwise silent (§2.4).
- **Terminal** (corrupt index, unreadable store, repeated failure): the tool **recovers to a
  safe state once** and emits one `severity:'warn'` `teach` line telling the user what is now
  true and how to inspect. Terminal-for-a-feature is still never terminal-for-the-turn.

### 2.3 Per-feature failure handling (the matrix)

| Failure | Class | Surfaced? | What the tool does | `teach` line (if surfaced) |
|---|---|---|---|---|
| **Memory store lock contention** | transient | **silent** | retrieval/capture is best-effort; on lock timeout, this turn proceeds with no injection / the proposal is dropped. The `withLock` whole-transaction is already the design (memory RC-4). | — (silent: the answer is unaffected; surfacing noise on a 50ms lock would be worse than the miss) |
| **Corrupt memory index** | terminal | **warn (once)** | rebuild index from `facts/*.json`, preserve the corrupt copy as `index.json.corrupt` (memory §238, mirrors `conversations.ts` corrupt recovery) | `Memory index was damaged — I rebuilt it from your saved facts (a backup was kept). Run /memory to verify.` |
| **Intent extractor timeout / parse error** | transient | **silent** | fall back to `rulesIntentFrame` (intent §5.5, §382) — the turn proceeds with no added latency. **Silent by design:** intent is an internal sharpening, not a promised output; surfacing "I couldn't infer intent" teaches nothing and erodes trust. | — |
| **Recap generation failure** | transient | **silent** | show the last cached recap if any; else fall back to the old tail-echo (`menu.ts:2347`); else nothing (recap §309 "stale line is cosmetic"). Recap is orientation, not content. | — |
| **`remember_user` approval interrupted mid-failure** (user picked Save but the write failed, or the selector was ESC/Ctrl-C'd mid-write) | transient→terminal | **info (once)** | the write is atomic (`atomicWrite`, memory §10) so a partial write cannot corrupt; either it landed or it didn't. On a confirmed failure to persist an *approved* save, surface it — the user asked for durability and we owe them honesty. | `I couldn't save that just now — nothing was stored. You can ask me to remember it again.` |
| **APE acting on a bad signal** (e.g. it chose to investigate/plan on a turn that didn't warrant it) | transient | **steerable, not an error** | APE's actions are *bounded and decoupled* (APE §93, decisiveness-as-feature); a wrong posture is corrected by the user typing (the first-touch line §1.2 invites exactly this: "type to steer me"). No `teach` line — it isn't a failure, it's a judgment the user can override. | — (the steer affordance IS the recovery) |

### 2.4 What stays silent (the fail-soft floor)

Silence is the default for any failure that **does not change a result the user was promised
or relying on.** Specifically silent: memory lock misses, intent fallback, recap fallback,
panel-status glitches, first-touch save misses. Surfaced only when (a) durable user-approved
state was at stake (the approved-save failure) or (b) the user must know a new persistent
truth (index rebuilt). This keeps the tool calm: a 10/10 does not narrate its own plumbing.

### 2.5 Tests (pure seams)

- `teach.test.ts`: format is stable; `info` is dim, `warn` is yellow, never red; `you?`
  omitted renders cleanly; `color:false` strips ANSI (off-TTY parity).
- For each surfaced failure: a unit test that the failing path *returns a value / yields a
  fallback and does not throw* (the fail-soft contract), and that the `teach` line is emitted
  exactly once. These reuse each feature's existing fault-injection seam (the corrupt-index
  fixture pattern from `conversations` tests; the null-returning worker port from
  `route-classifier`/intent tests).
- One guard test asserting **no new feature path can call `process.exit` or throw to the chat
  loop** — i.e. each new core module's public entry returns a result type, never rejects.

---

## 3. Cumulative Cost / Latency Budget + Quota-Shed Policy

**Decision: one budget statement summing all features per turn-class, plus one ordered
shed policy; the core answer is the last thing standing.** Individually each feature is
disciplined (intent gates to ≤1 call on substantial turns, intent §5.5; recap regenerates
only every ≥3 turns in the background, recap §227; memory injects deterministically with no
LLM at query time, memory PASS in gate §4). **No sibling doc sums them — this is that sum.**

### 3.1 The budget statement (worst-case ADDED overhead, per turn-class)

"Added" = on top of the core answer the user pays for anyway. Turn-classes match the
router's own notion (trivial / normal / substantial ≈ route tier + risk).

| Turn class | Added model **calls** (worst case) | Added **tokens** (injected, worst case) | Added **latency** (worst case, fail-soft floor 0) |
|---|---|---|---|
| **Trivial** ("what's 2+2", "ls") | **0** — intent gate skips (router rules confident, no call, `router.ts:207-209`); memory *preference* injection gated off by the inject-time gate (gate §3.3); recap not triggered (needs ≥3 turns + idle, recap §35) | ~0–80 (only always-include identity/constraints, if any) | ~0 |
| **Normal** (a question, a small edit) | **0–1** — intent may run 1 cheap-tier call if ambiguous; memory = pure I/O (no call); recap background-only | ~80–600 (scored-and-filled within the 12-fact / 1200-char budget, memory RC-3) | intent call ~5–10s *only on ambiguous turns*, else ~0 |
| **Substantial** ("rebuild this module", `/goal`) | **1** intent call (rides the same cheap-tier seam) **+ 1** background recap call *if* idle-stale, both reusing the router's injected provider port — **never 2 blocking calls** | ~600–1200 (full memory budget) + ~200 INTENT block + ~80 ENGAGEMENT block (APE — no extra call), all bounded together by the `assembleContextBlocks` total cap | intent ~5–10s (blocking, gated); recap is **background** (non-blocking, recap §44); memory I/O ~ms |

Key invariants the budget enforces:
- **At most ONE blocking added call per turn** (the intent pass). Recap is always background;
  memory makes **zero** model calls (deterministic Jaccard retrieval, memory gate §4). APE
  rides the *existing* intent frame — it consumes the signal, it does not add a call (APE §46
  "the conductor that consumes the signals," not a new brain).
- **Dollar cost added = $0** on a flat-rate subscription. The only real budget is quota +
  latency, which the gates already protect.
- The numbers are *ceilings*; the common case (trivial/normal non-ambiguous) adds **zero
  calls and a few-hundred tokens at most.**

### 3.2 Quota-shed policy (ordered; core answer always survives)

When the subscription quota is pressured — detected via the existing rate-limit signal the
renderer already tracks (`rateLimitedProviders`, `render.ts` `renderStream` return) and/or a
429/quota `errorCategory` on a recent turn — shed *our* features in this exact order, one step
at a time, re-evaluating each turn:

```
  1. Drop background recap refresh        (cosmetic orientation; show cached/old line)
  2. Narrow memory injection              (always-include only: identity + hard constraints;
                                           drop ranked preferences — gate §3.3 already gates
                                           preferences, this tightens it to identity-only)
  3. Skip the intent pass                 (fall back to rulesIntentFrame — no call, no latency;
                                           same path as the timeout fallback, §2.3)
  4. ── CORE ANSWER ── always runs. Never shed. The user never hits a wall from our overhead.
```

Rationale for the order: shed **least-valuable-and-most-expensive first.** Recap is pure
orientation and runs an extra call → first. Memory *preferences* are nice-to-have and cost
injected tokens → narrow next, but **identity + hard constraints are never shed** (a user who
said "always use TypeScript" must keep that even under pressure — APE/memory treat constraints
as decay-exempt, memory RC-5). The intent pass is a sharpening that costs a whole call → shed
before the answer. The answer itself is sacrosanct.

This is the subscription promise made literal: **our features get out of the way before the
user's quota does.** A degraded turn is a plain, correct answer — exactly what a per-token
tool would give, minus our extras — never an error.

### 3.3 Where it hooks

- A pure `decideShed(pressure: QuotaPressure, turnClass): SheddingPlan` in
  `src/core/capability-budget.ts` (alongside the budget table, §0.3). Inputs: a `pressure`
  level derived from recent `rateLimitedProviders`/`errorCategory` (no new probe — reuses
  signals the renderer already surfaces); turn class from the router classification.
- `buildDeps` (`menu.ts:2581`, the deps-assembly seam every feature already uses) reads the
  plan and assembles the turn's deps accordingly: recap-refresh enabled/not, memory budget
  width, intent enabled/not. This is the same additive `OrchestrateDeps` optional-fields
  pattern the feature docs already adopt (`types.ts:272` next to `routeClassifier?`).

### 3.4 Tests (pure seams)

- `capability-budget.test.ts`: `decideShed` returns the documented order — pressure level 1
  drops recap, level 2 also narrows memory, level 3 also skips intent, and **at every level
  the core-answer flag stays true**; identity/constraints are never narrowed out.
- A table test asserting the budget constants match the §3.1 ceilings (so a future feature
  that quietly adds a second blocking call fails this test — the budget is enforced, not just
  documented).
- An integration-style test: inject a `rateLimitedProviders` signal and assert `buildDeps`
  assembles deps with recap-refresh off and intent off, while still producing a final answer.

---

## 4. The Two-Chat-Surfaces Decision

**Decision (explicit, justified): menu chat is the full experience; `repl.ts` is the lean,
scriptable subset — and that asymmetry is intentional, named, and bounded by a shared core
plus a documented capability matrix.** The gate's §6.4 calls out that `repl.ts` is a real
second surface (pause/resume, AbortController, **no ESC/no queue**, `repl.ts:50-101`) and that
a 10 *names* the asymmetry instead of silently omitting it. This section names it.

### 4.1 Why the asymmetry is correct, not a gap

`repl.ts` exists for a different job: a **simple, scriptable, line-at-a-time** prompt
(`myshell-tools> `, `repl.ts:44`) that pauses readline around each `runTask` (`repl.ts:88-96`)
and never tries to be a rich TUI. Queue/ESC/memory-approval/intent-reflection are
**interactive TUI affordances** that assume a human watching a live terminal; they are
actively wrong for a piped/scripted REPL (a memory Save/Skip selector blocking a non-TTY pipe
would hang it; an ESC listener on a non-TTY stdin is meaningless, as chat-ux §13 already
notes the REPL "has no ESC listener and no queue" *by construction* via `rl.pause()`).

So the decision is: **do not retrofit the REPL into a second full TUI.** That would double the
maintenance surface and the divergence risk for no user benefit (interactive users already
have the menu chat). Instead:

### 4.2 What the REPL DOES get in v1 (read-only, non-interactive subset)

| Capability | Menu chat | REPL v1 | Why |
|---|---|---|---|
| Core answer + routing/panel/hedge | ✅ | ✅ | shared core (`runTask`→`orchestrate`) — identical |
| Memory **injection** (read) | ✅ | ✅ **read-only** | injection is a *deps* concern threaded through `assembleContextBlocks` (gate §7 Phase 2 seam) — the REPL builds the same `OrchestrateDeps`, so it gets the *same memory-aware answers* for free, with **no approval UI** |
| Memory **capture/approval** (write) | ✅ | ❌ | requires an interactive Save/Skip selector; meaningless/blocking in a pipe. `remember_user` proposals are simply **not surfaced** in the REPL (dropped, not queued) |
| Intent **frame** (internal sharpening) | ✅ | ✅ | it is a deps/prompt concern, not UI — the REPL benefits from sharper prompts with no visible reflection line |
| Intent **reflection line** (visible) | ✅ | ❌ | a TUI affordance; the REPL stays terse |
| Recap on resume / `/recap` | ✅ | ❌ | the REPL has no resume/session-list model; it is stateless-per-line |
| `※` glyph, `●` marker, "Waiting on N" | ✅ | ➖ degrades | these route through `out.color`/`out.isTty`; off-TTY they plain-degrade exactly as designed (presentation §3) — the REPL is usually non-TTY, so they self-suppress |
| ESC interrupt / typed-ahead queue | ✅ | ❌ | by construction (`rl.pause()`, chat-ux §13) — Ctrl+C aborts the in-flight `AbortController` (`repl.ts:52`) which is the correct REPL idiom |
| `/style`, `/mode`, `/memory`, `/goal` | ✅ | ➖ | REPL keeps its minimal `/help /exit /quit` set (`repl.ts:22`); see §4.4 |

The load-bearing win: **memory injection and the intent frame are "deps/prompt" concerns, not
UI**, so the *shared core* delivers them to both surfaces automatically. The REPL gets sharper,
memory-aware answers *for free* — only the *interactive write/visible* affordances are absent.

### 4.3 How to keep them from silently diverging — the shared core

1. **One core path.** Both surfaces already funnel through `runTask`→`orchestrate`. All
   feature context (memory, intent, partnerStyle) flows through `OrchestrateDeps` +
   `assembleContextBlocks` (gate §7 Phase 2 — the linchpin seam). Because both build deps the
   same way, any feature wired at the deps level reaches both surfaces *without per-surface
   code*. This is the anti-divergence mechanism: **wire at the core, not the surface.**
2. **The capability matrix above is the contract.** Phase 9 commits it to this doc; a feature
   that wants to appear in the REPL must add a row, forcing an explicit decision rather than a
   silent omission.
3. **The REPL `/help` honesty line (§1.3)** tells the user the asymmetry exists and where the
   full experience lives — no silent gap from the user's side either.

### 4.4 Tests (pure seams)

- `repl.test.ts` (extend): a memory `remember_user` proposal flowing into the REPL is **dropped,
  not surfaced** (no selector, no hang); the turn still completes.
- A shared-deps test: assert that the deps the REPL assembles include the same `memoryContext`
  field the menu assembles (read-injection parity), and do **not** include an approval callback.
- `help.test.ts`: REPL `/help` contains the asymmetry pointer line (§1.3); menu `/help` is the
  superset.
- A divergence guard (lightweight): a test enumerating the capability matrix as data and
  asserting the REPL's wired capabilities are a documented subset of the menu's — so adding a
  menu-only feature without deciding its REPL status fails the test.

---

## 5. Combined Migration / Versioning (3.12.x → 5.5)

**Decision: each artifact already forward-migrates individually; Phase 9 adds the *combined*
first-run-after-upgrade walkthrough and ONE migration test that drives a real old state dir
through a new build with zero data loss and zero scary prompts.** The gate's §6.5 notes each
piece migrates (the `normaliseMeta` pattern is verified at `conversations.ts:64-75`) but no
doc walks the *combined* upgrade.

### 5.1 The three artifacts and how each already migrates

| Artifact | New in 5.5 | Forward-migration mechanism (already designed) | Old state on read |
|---|---|---|---|
| **Conversation index** `index.json` — new `ConversationMeta` recap fields (`recap`, `recapAt`, `recapMessageCount`, recap §241-243) | recap fields | `normaliseMeta` (`conversations.ts:64-75`) defaults missing fields. Phase 9 *requires* recap doc Phase 1 to extend `normaliseMeta` so old entries get `recap:null, recapAt:null, recapMessageCount:0` — never `undefined` blowing a staleness check (`isRecapStale`, recap §287) | recap absent → treated as stale-but-empty → regenerated lazily in background; **never shown as a broken line** |
| **Memory store** `memory/index.json` + `facts/*.json` (entirely new, memory §184) | whole subsystem | absent dir → memory is simply empty; `loadConfig` defaults `memory:true` so it's *on* but with nothing stored. First-run creates the dir lazily on first write (mirrors `ensureDir`, `conversations.ts:55-57`). Corrupt index → rebuild from facts (memory §238) | absent → empty memory, no error; the §1.1 onboarding line is the *only* thing the user sees about it |
| **Config** `config.json` — new keys (`memory*` from memory §9; `seen` from §0.1; nothing else durable) | additive keys | `loadConfig` merges DEFAULTS then on-disk (`config.ts:147-149`), so **all new keys are present with safe defaults and all unknown keys are preserved** — a true forward+backward-compatible merge | missing keys → defaults; a 5.5 config opened by a 3.12.x build keeps its unknown 5.5 keys intact on save (verified merge behavior) |

The crucial property, true of all three: **the absence of new state is a valid, silent
default — never an error and never a prompt.** This is what makes the combined upgrade
"no scary prompts."

### 5.2 The combined first-run-after-upgrade walkthrough

A user upgrades from 3.12.x with existing conversations + config, launches 5.5, opens a prior
conversation:

1. **Startup.** `loadConfig` returns the old config merged over 5.5 defaults: `memory:true`
   (default-on), all `memory*` defaults present, `seen` absent. `onboarded:true` already (they
   onboarded in 3.12.x) → **`runWelcome` does NOT re-run**, so the §1.1 setup memory line does
   *not* fire for upgraders. (Correct: we don't replay onboarding on upgrade.)
2. **The "memory is on" moment for upgraders.** Because they skip `runWelcome`, the memory
   default-on disclosure instead reaches them via the **first-touch line at their first memory
   approval** (§1.2) — which is exactly when it's relevant. No upgrade-time modal, no nag.
3. **Open a prior conversation.** `normaliseMeta` fills the missing recap fields → the resume
   path sees `recap:null` → it does **not** print a stale/broken ※ line; it shows the old
   tail-echo (`menu.ts:2347`) for this first resume and generates a real recap in the
   background for next time (recap §289-291). The user sees their familiar resume line, then a
   recap appears on subsequent resumes — a strict upgrade, never a regression.
4. **First substantial turn.** Memory store dir doesn't exist yet → retrieval injects nothing
   (empty), capture creates the dir lazily on the first approved save. Intent/APE run normally.
   Nothing about the upgrade is surfaced.

Net user experience: **the tool just keeps working, then quietly gets better** — exactly the
"no data loss, no scary prompts" bar.

### 5.3 The ONE combined migration test (the gate's explicit ask)

A single integration test that exercises an **old state dir → new build**:

```
test/integration/upgrade-3.12-to-5.5.test.ts  (new)
  Fixture: a realistic 3.12.x state home:
    .myshell-tools/config.json            (onboarded:true, mode:'balanced', NO memory*/seen keys)
    .myshell-tools/conversations/index.json   (2 entries, NO recap* fields)
    .myshell-tools/conversations/<id>.jsonl    (real messages)
    (NO memory/ dir at all)
  Assert, after loading through the 5.5 code paths:
    1. loadConfig → memory:true, memory* defaults present, seen absent, mode:'balanced'
       preserved, no key lost.
    2. readIndex/normaliseMeta → both conversation entries load; recap fields default to
       null/0; title/messageCount/pinned/category all intact (no data loss).
    3. Resuming an entry produces the tail-echo (not a broken ※ line); isRecapStale treats
       null recap as "regenerate", not as a crash.
    4. A first approved memory save lazily creates memory/ and writes a fact; re-loading
       finds it.
    5. Saving config back to disk PRESERVES the original onboarded/mode AND writes the new
       defaults — and a hypothetical unknown future key in the fixture survives the round-trip.
    6. No prompt, no throw, no stderr noise on the whole path (assert the output sink received
       no warn/error teach lines from migration).
```

This is mostly a **pure-seam** test (loadConfig/normaliseMeta/isRecapStale are pure or
file-only) plus one lazy-create assertion — no TTY, no real provider, no network.

---

## 6. Where this slots into the master phase plan

This is **Phase 9 — Whole-tool finish**, the final phase in the gate's unified plan
(`final-gate-5.5.md` §7). It **depends on every prior phase landing** because it documents,
budgets, and onboards *their* surfaces:

- §1 onboarding needs the memory approval (Phase 5), intent reflection (Phase 6), recap
  (Phase 7), and panel "Waiting on N" (Phase 8) to exist before it can first-touch-explain them.
- §2 error UX needs each feature's failure path present to wrap in `teach()`.
- §3 budget needs intent (Phase 6) + recap (Phase 7) + memory injection (Phase 4) to sum them.
- §4 REPL matrix needs the deps seam (Phase 2) so injection reaches both surfaces.
- §5 migration needs the recap fields (Phase 7), memory store (Phase 3), and config keys
  (Phases 3–6) to migrate them together.

The only artifacts Phase 9 *adds* are small and cross-cutting: `src/core/first-touch.ts`,
`src/core/teach.ts`, `src/core/capability-budget.ts` (all pure), the `AppConfig.seen` key, the
two `/help` rewrites, and the one combined upgrade test — plus best-effort wiring of the
first-touch lines and shed plan into the existing `buildDeps`/`renderStream`/resume seams.
Nothing here touches the orchestration core; it is all product-edge polish over a finished
spine. **Phase 9 is non-blocking for shipping the features** (the gate lists §6 items as "not
gating starting") but **is required to stamp the whole tool a 10.**

---

## 7. Risks + Open Questions for the User

### Risks (with the chosen mitigation)

1. **First-touch lines feel like nagging if mistimed.** Mitigation: once-each-ever via `seen`,
   dim, no interaction, and *only* on the surface's genuine first occurrence. Risk residual:
   if a user's `config.json` is wiped, they re-see all five. Acceptable (rare; the lines are
   short and benign).
2. **Shed policy mis-fires and degrades a turn the user didn't need degraded.** The pressure
   signal is heuristic (recent rate-limit/429). Mitigation: shed is *gradual* (one step per
   turn, re-evaluated) and the core answer always survives, so a false-positive shed costs at
   most a missing recap or narrower memory for one turn — never a wrong or failed answer.
3. **"Silent on failure" hides a real, persistent problem from the user.** E.g. memory lock
   contention every turn because of a stuck `.lock` file → memory silently never works.
   Mitigation: terminal/repeated failures *do* surface (the index-rebuild path); but a *stuck
   lock* is a gap — see Open Question 2.
4. **REPL injection parity could leak preferences into a scripted/CI context** where the user
   didn't expect their personal memory in the prompt. Mitigation: memory is project-scoped by
   default (memory §9 `memoryDefaultScope:'project'`); a CI run in a different repo gets a
   different project key. Residual: a scripted run in the *same* repo would see project memory.
   See Open Question 3.
5. **The combined migration test is the only thing standing between an upgrade and data loss** —
   if it's under-fixtured (e.g. doesn't include a pinned/categorized conversation) a real loss
   could slip. Mitigation: the fixture in §5.3 is deliberately realistic; expand it as the
   conversation schema grows.

### Open questions for the user

1. **Onboarding for upgraders (§5.2).** Upgraders skip `runWelcome`, so they never see the
   §1.1 "memory is on" setup line — they meet it at their first memory approval instead. Is
   that enough, or do you want a **one-time, dismissible upgrade notice** on the first 5.5
   launch for existing users ("What's new in 5.5: memory, recap, sharper intent — /help")?
   (I lean *no* — it risks being a nag — but it's a product call.)

2. **Stuck-lock detection (Risk 3).** Should a memory lock that fails **N turns in a row**
   escalate from silent to a one-time `teach` warn ("Memory seems stuck — run /memory to
   reset")? It adds a tiny bit of state (a consecutive-fail counter) but closes the
   "silently never works" hole. Worth it, or keep it strictly silent for v1?

3. **REPL memory injection default (§4.2, Risk 4).** Should the REPL inject memory **by
   default** (sharper answers, but personal context in scripted runs), or be **opt-in** via a
   flag/env (`MYSHELL_REPL_MEMORY=1`) so scripted/CI usage is clean by default? I lean
   *default-on but project-scoped* (the project key already isolates most cases), but if you
   use the REPL in automation you may prefer opt-in.

4. **Shed-policy trigger source (§3.2).** I derive quota pressure from the existing
   `rateLimitedProviders`/429 signal — we have **no token-budget readout** on subscription
   CLIs (presentation §4 / Q5 deliberately drops Codex's context-remaining for this reason).
   Is reactive-after-first-429 acceptable, or do you want a more conservative *proactive* shed
   (e.g. start shedding recap once *any* provider has rate-limited *this session*)?

5. **`teach()` voice (§0.2).** I've kept failures plain and first-person ("I answered without
   your saved preferences"). Confirm that first-person "I" matches the partner persona the APE
   doc establishes — if the tool's voice elsewhere is impersonal, I'll switch these to match.

---

## Summary — the five designs + top open questions

1. **Onboarding / first-run.** Progressive & just-in-time, *not* a bigger wizard: one
   "memory is on / `/memory` to manage" line added to `runWelcome`; four dim, once-each
   first-touch lines (memory Save, intent reflection, "Waiting on N", ※ recap, APE engage)
   gated by a new `AppConfig.seen` map; a unified menu `/help` that introduces all five plus
   an honest REPL `/help` pointer.
2. **Unified error / teach-on-failure.** One pure `teach({what,did,you?,severity})` formatter;
   transient → retry/skip mostly *silent*, terminal → recover-once + one *warn* line; explicit
   per-feature matrix; surfaced only when durable user-approved state or a new persistent truth
   is at stake; never red, never throws to the turn.
3. **Cumulative budget + quota-shed.** One summed budget (trivial 0 calls / normal 0–1 /
   substantial **1** blocking call max, $0 dollars, ceilings enforced by a test) and one ordered
   shed policy: **recap refresh → narrow memory to identity/constraints → skip intent → core
   answer always survives.** The user never hits a wall from our overhead.
4. **Two chat surfaces.** Named, justified asymmetry: menu chat = full; `repl.ts` = lean
   subset that still gets *memory injection + intent frame for free* (they're deps/prompt, not
   UI) but no write-approval, recap, or queue/ESC. Kept from diverging by wiring at the shared
   core + a documented capability matrix + a divergence-guard test.
5. **Combined migration.** Each artifact (recap meta fields, new memory store, config keys)
   already forward-migrates; Phase 9 adds the combined upgrade walkthrough (upgraders skip
   re-onboarding; absence of new state is a silent valid default) and **one** integration test
   driving a real 3.12.x state dir → 5.5 with zero data loss and zero scary prompts.

**Top open questions:** (1) do upgraders need a one-time "what's new" notice or is
first-touch-at-first-use enough? (2) should a stuck memory lock escalate from silent to a
one-time warn after N consecutive fails? (3) REPL memory injection default-on (project-scoped)
or opt-in for clean scripted runs? (4) is reactive-after-429 quota-shed acceptable vs a
proactive session-wide trigger, given there's no token-budget readout on subscription CLIs?
