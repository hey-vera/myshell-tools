# The Golden Plan — Rebuilding `myshell-tools` to A++

> A from-scratch engineering plan to turn a tool that *simulates* AI orchestration
> into one that *genuinely performs* it — at a level you would defend in front of a
> staff-engineering review board.
>
> **Status:** authoritative build spec. Everything here is the contract.
> **Audience:** the engineers (human + AI) who will build v2.
> **Date authored:** 2026-05-29.
> **Predecessor:** `myshell-tools` v1.1.0 (graded **D−** overall — see `docs/POSTMORTEM.md` summary in §1).

---

## Amendments (decided during the build — these override the original text below)

*Recorded 2026-05-30, after Phase 1 shipped. The plan is the contract; when reality taught us
better, we amend the contract rather than let it drift.*

- **A1 — `execa` is an accepted runtime dependency (amends §10 "zero runtime deps").** The spawn
  layer is exactly where v1 died on Windows (CVE‑2024‑27980, orphaned process trees). Hand‑rolling it
  trades robustness for ideology. We adopt `execa` for process execution, isolated behind the
  `Provider` port (one file). The principle becomes **"zero runtime deps except `execa`,"** with the
  Claude Agent SDK still a possible second, port‑gated exception pending subscription‑auth
  verification. Validated: execa correctly drives a Windows `.ps1`/`.cmd` shim.

- **A2 — Discovery over declaration (amends §8 / Appendix A pricing).** Routing uses **stable model
  aliases** (`haiku`/`sonnet`/`opus`, Codex tiers), so a vendor's newer model is picked up
  automatically with no code change. Cost prefers the **provider CLI's own reported figure** (Claude
  reports `total_cost_usd`). The hardcoded price table is demoted to a **dated cold‑start *seed***,
  used only for estimates/counterfactuals where a CLI doesn't self‑report, and it carries a staleness
  warning. Honest limit: no CLI/API exposes list prices, so that one seed needs occasional manual
  refresh — everything else self‑updates.

- **A3 — Live self‑measurement replaces the static benchmark as the headline proof (amends §4.5 /
  §8).** A fixed seed benchmark goes stale and invites cherry‑picking. The real, never‑stale proof is
  **continuous measurement from the cost ledger of actual usage** (`myshell-tools cost`: routed vs
  always‑flagship, review catch‑rate, escalation rate). The static benchmark is demoted to a small CI
  **regression guard** (does routing still pick sane tiers? does review still catch a couple seeded
  defects?), not the headline.

- **A4 — Preference-aware (not quota-aware).** Subscription quotas are unreliable (CLIs expose only
  historical stats or interactive /usage; no real-time remaining for planning). The system is
  preference-aware: learned taste (observed edits/accepts/forks via free ledger) + routing memory
  bias + real plan-tier capacity. /plan is first-class pure-planning (judgeGoal parity, proposal +
  PLAN.md + park) for "one chat to rule them all". No fabricated numbers.

---

## 0. Why this document exists

The v1 codebase failed the only test that matters: **when a user runs it, it does not call any AI.**
The shipped entry point (`cli.mjs` → `startEnhancedREPL`) routes every prompt to a `Math.random()`
state machine that prints hardcoded strings and a constant "87% confidence." The real engine
(`chef.mjs`) is imported and never invoked. On top of that: zero tests, a load balancer disabled by a
typo (`providerfrom` vs `providerFrom`), a cost-saving "Worker" tier that is never reachable,
112 lines of dead pricing config and 6 dead prompt templates shipped in the package, three conflicting
product names, fabricated install instructions, `danger-full-access` handed to an LLM on every task,
and a Windows "fix" that fixed detection but not execution.

There were exactly two things worth keeping: the subprocess error-handling taxonomy
(`providers/errors.mjs`) and the atomic file primitives (`state/atomic.mjs`).

This plan does not patch v1. **We rebuild.** The bar is A++ in all six review dimensions, and the
definition of A++ is concrete and testable in §12.

---

## 1. First principles — the non-negotiable contract

These are ranked. When two principles conflict, the lower number wins.

1. **The Honesty Contract (cardinal rule).** The tool never displays fabricated, mocked, randomized,
   or placeholder data as if it were real. No `Math.random()` deciding UX. No hardcoded "87%". No
   `// TODO: replace with real data` reaching `main`. Every number on screen traces to a real
   measurement or is explicitly labeled an estimate. **This is enforced by a lint rule and a test
   (§5.6), not by good intentions.** Violating this is a release blocker, full stop.

2. **Every feature traces to measurable value.** If we cannot write a test or a metric that proves a
   feature helped (cheaper, more correct, faster, or caught a real defect), it does not ship. This is
   how we kill theater — "confidence scoring" by keyword matching dies here unless it earns its place.

3. **Test-first, always.** No module is "done" without tests written against its public contract.
   Orchestration logic — the entire value of this product — is deterministic and unit-testable when
   the provider layer is mocked. There is no excuse for zero tests. Target ≥ 85% line coverage on
   `core/`, 100% on routing decision functions.

4. **Cross-platform is a P0 requirement, not a patch.** Windows, macOS, and Linux are first-class.
   CI runs the full suite on all three from commit #1.

5. **Least privilege by default.** The tool is an agent runner with filesystem and network access.
   It defaults to the most restrictive sandbox that still works, and escalates privilege only with
   explicit, per-session, logged user consent. `danger-full-access` is never the default and never
   silent.

6. **One identity.** One product name, one package name, one repo URL, one version source of truth.
   Verified available on npm before launch.

7. **Zero *runtime* dependencies remains the goal**, because the product's pitch is "thin orchestrator
   over CLIs you already have." Dev/build/test dependencies are fine. A runtime dependency is allowed
   only if it buys correctness we cannot reasonably achieve ourselves (and each is justified in §10).

---

## 2. What we are actually building (re-founding the value proposition)

v1's pitch — "a Manager AI reviews an IC AI to produce better code" — is mostly theater for a single
coding task, and v1 didn't even do it. Before writing a line, we decide *what honest value this tool
delivers that running one CLI directly does not.* There are exactly four defensible value props, and
we build for these and nothing else:

| # | Value prop | Why it's real | How we prove it |
|---|-----------|---------------|-----------------|
| **V1** | **Cost-aware routing** | Sending "rename this variable" to Opus/GPT‑5.5 is wasteful; Haiku/Nano does it for ~5% of the cost. | Per-task cost ledger (real token counts × real prices) and an A/B mode that shows $ spent vs. $ if-always-flagship. |
| **V2** | **Cross-provider adversarial review** | Different model families have different blind spots. Codex reviewing Claude's diff (and vice-versa) catches real defects a single model misses. | Reviewer must produce *specific, file-anchored* findings; we log catch-rate on a seeded bug corpus. |
| **V3** | **Subscription arbitrage + no API metering** | Uses the Claude Code and Codex CLIs you already pay for via subscription; no per-token API bill. | The execution layer drives the CLIs (subscription auth), never raw metered API keys, unless the user opts in. |
| **V4** | **Transparent, auditable orchestration** | A complete, replayable log of who decided what, with which model, at what cost, and why. | `.myshell-tools/handoffs.jsonl` is a first-class, schema-validated artifact with a `myshell-tools replay` command. |

Everything that does not serve V1–V4 is cut. Specifically **killed**: random "simulate AI work,"
keyword-sentiment "confidence," the never-used Worker-tier dead path, the parallel duplicate load
balancers, the unread JSON config, the unread templates, and the fake `/balance`, `/status`,
`displaySessionResume` data.

**The honest mental model** we present to users: *"You describe a task. myshell-tools picks the
cheapest model likely to succeed, runs it on your real codebase, optionally has a second model from a
different vendor review the result, and shows you exactly what it did and what it cost."*

### 2.1 Naming & identity (resolve before commit #1)
- Pick ONE name. Candidates: `myshell-tools`, `myshell-tools-cli`, `myshell`. Verify npm availability
  (`npm view <name>`), GitHub org, and that the binary name doesn't collide on `$PATH`
  (`myshell-tools` is taken by some tools — check). The working name in this doc is **`myshell-tools`**; the
  build's first task (T0) is to lock the final name and propagate it everywhere via a single constant.
- One `package.json` `name`, `bin`, `repository.url`, `homepage`, `bugs.url` — all consistent.
- Version lives in exactly one place (`package.json`) and is read at runtime via
  `createRequire(import.meta.url)('../package.json').version`. No hand-typed `VERSION` constant.

---

## 3. Target architecture

### 3.1 Design tenets
- **Hexagonal / ports-and-adapters.** The orchestration core knows nothing about Claude, Codex, child
  processes, or terminals. It talks to a `Provider` port and a `Clock`/`Logger`/`Telemetry` port.
  Adapters implement those. This is what makes the core 100% unit-testable and is the single biggest
  architectural fix vs. v1, where `chef.mjs` reached directly into `spawnSync` wrappers, the filesystem,
  and `console.log`.
- **Pure decision functions.** Routing, escalation, and review-trigger logic are pure functions:
  `(state, signals) → decision`. No I/O, no time, no randomness inside them. Time and randomness are
  injected. This makes every routing rule a one-line table-driven test.
- **One entry path.** There is exactly one REPL and one non-interactive runner, both of which call the
  *same* `orchestrate()` function. There is no "enhanced" vs "real" fork. The mock-vs-real split that
  sank v1 is structurally impossible because there is only one path.

### 3.2 End-to-end execution flow (the real one)

```
                 ┌─────────────────────────────────────────────────────────┐
  user prompt ──▶│  Interface layer  (REPL  |  `myshell-tools run "<task>"`  | pipe)│
                 └───────────────────────────┬─────────────────────────────┘
                                             │ TaskRequest
                                ┌────────────▼────────────┐
                                │   Orchestrator core      │   PURE + injected ports
                                │  ┌────────────────────┐  │
                                │  │ classify()         │  │  signals → plan
                                │  │ route()            │  │  cost-aware tier/model pick
                                │  │ runTier()          │──┼──┐
                                │  │ assessResult()     │  │  │ calls Provider port
                                │  │ maybeReview()      │  │  │
                                │  │ decideNext()       │  │  │
                                │  └────────────────────┘  │  │
                                └───────────┬──────────────┘  │
                                            │ Decision/Result  │
        ┌───────────────────────────────────┼──────────────────┘
        │ Ports (interfaces)                 │
        ▼                  ▼                 ▼                 ▼
 ┌────────────┐   ┌────────────────┐  ┌────────────┐   ┌──────────────┐
 │ Provider   │   │ Telemetry/Cost │  │ SessionLog │   │ Renderer     │
 │  adapters  │   │  ledger        │  │ (atomic)   │   │ (UI/streams) │
 └─────┬──────┘   └────────────────┘  └────────────┘   └──────────────┘
       │
  ┌────┴───────────────────────────┐
  ▼                                ▼
 ClaudeAdapter                  CodexAdapter
 (Agent SDK or `claude -p`)     (`codex exec --json`)
       │                                │
   real model call               real model call
   (subscription auth)           (subscription auth)
```

The **critical invariant**: the Interface layer can *only* reach a model by going through
`orchestrate()` → Provider port → adapter → real CLI. There is no code path from the REPL to a string
literal that looks like a model response. (Enforced by an architecture test, §5.6.)

### 3.3 The Provider port (the most important interface)

```ts
// One contract; both vendors implement it. Streaming, cancelable, fully typed.
export interface Provider {
  readonly id: 'claude' | 'codex';
  detect(): Promise<ProviderStatus>;            // installed? authed? version? models?
  run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface ProviderRequest {
  model: string;                 // resolved concrete model id, never an alias at this layer
  prompt: string;                // passed via STDIN, never as a shell arg (see §7)
  cwd: string;
  sandbox: SandboxLevel;         // 'read-only' | 'workspace-write' | 'full-access'
  timeoutMs: number;
}

// Discriminated union — UI streams these; core consumes the terminal ones.
export type ProviderEvent =
  | { type: 'text';      delta: string }
  | { type: 'tool';      name: string; phase: 'start' | 'end'; detail?: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage';     inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: 'done';      text: string; usage?: Usage; raw: unknown }
  | { type: 'error';     error: CliError };
```

This is what lets the core stream real output to the UI *and* compute real cost, while remaining
testable with an in-memory fake provider that yields scripted events.

### 3.4 Module map (file tree of the new repo)

```
myshell-tools/
├─ package.json                 # single source of name + version; bin → dist/cli.js
├─ tsconfig.json                # strict: true, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├─ src/
│  ├─ cli.ts                    # arg parsing (one place), dispatch; the ONLY process entry
│  ├─ interface/
│  │  ├─ repl.ts                # the one and only REPL → orchestrate()
│  │  ├─ run.ts                 # `myshell-tools run` non-interactive → orchestrate()
│  │  └─ render.ts              # consumes ProviderEvent/CoreEvent streams → terminal
│  ├─ core/                     # PURE. no fs, no child_process, no console, no Date.now/Math.random
│  │  ├─ orchestrate.ts         # the single orchestration entry; async generator of CoreEvent
│  │  ├─ classify.ts            # signals → {tier, risk, rationale}
│  │  ├─ route.ts               # cost-aware model selection (pure)
│  │  ├─ assess.ts              # result → confidence/should-escalate (real signals only)
│  │  ├─ review.ts              # cross-provider review trigger + verdict parsing
│  │  └─ policy.ts              # all thresholds/tables in ONE typed config object
│  ├─ providers/
│  │  ├─ port.ts                # the Provider interface above
│  │  ├─ claude.ts              # adapter (Agent SDK primary, `claude -p` fallback)
│  │  ├─ codex.ts               # adapter (`codex exec --json`)
│  │  ├─ detect.ts              # capability detection (real probes, cached)
│  │  ├─ spawn.ts               # the ONE correct cross-platform spawn (stdin prompt)
│  │  └─ errors.ts              # SALVAGED + hardened from v1 errors.mjs
│  ├─ infra/
│  │  ├─ atomic.ts              # SALVAGED + fixed from v1 atomic.mjs (O(1) append, real locking)
│  │  ├─ session.ts             # append-only session log via atomic
│  │  ├─ handoffs.ts            # schema-validated audit trail
│  │  ├─ ledger.ts             # cost/telemetry: real tokens × real prices
│  │  ├─ pricing.ts             # the corrected price table (Appendix A), with provenance + asOf date
│  │  └─ clock.ts               # injectable time/uuid/random (so core stays pure)
│  ├─ ui/                       # presentation only; given real data by callers
│  │  ├─ theme.ts  spinner.ts  format.ts  banner.ts
│  └─ commands/                 # doctor, status, replay, reset, cost
├─ test/
│  ├─ unit/                     # core/* table-driven tests, fakes only
│  ├─ contract/                 # provider adapters vs recorded real CLI fixtures
│  ├─ integration/              # real CLI, gated behind CORTEX_E2E=1
│  ├─ arch/                     # architecture invariants (§5.6)
│  └─ fixtures/                 # recorded JSONL transcripts from real claude/codex runs
├─ .github/workflows/ci.yml     # lint+typecheck+test on win/mac/linux matrix
└─ docs/ (this plan, ADRs, README)
```

---

## 4. Area-by-area plan to A++

Each subsection: **v1 grade → what A++ means here → the work → exit criteria.** The exit criteria are
the things that must be objectively true; they roll up into the §12 scorecard.

### 4.1 BATTER — core substance  (v1: D− → target: A++)

**A++ means:** the orchestration genuinely runs real models, the routing measurably saves money on a
benchmark, escalation/review fires on real signals, and every decision is a tested pure function.

Work:
- **Single real path.** Delete the concept of a mock REPL. `orchestrate()` is the only way to reach a
  model. (§3.2 invariant + arch test.)
- **Make the tier system real and complete.** Worker/IC/Manager all reachable; `route()` actually
  selects Worker for trivially-classified tasks and we measure that it does. Tiers map to concrete
  models via `policy.ts`, resolved to full model IDs at the adapter boundary.
- **Honest confidence.** Two real signals only: (a) the model's *self-reported* structured confidence
  when it emits the agreed JSON envelope, and (b) *outcome* signals we can verify (exit code, tests
  passed/failed if the task ran tests, reviewer verdict). Keyword-sentiment scoring is deleted. If no
  real signal exists, confidence is `null` and the UI shows "unrated," never a fabricated number.
- **Escalation & review on real signals.** Escalate on: model-requested escalation, verified failure,
  self-reported confidence below a risk-indexed threshold, or reviewer "bounce." Cross-provider review
  (V2) triggers on risk class + opt-in, and the reviewer is *the other vendor* by default.
- **State machine, explicit and bounded.** `decideNext()` is a pure transition function over an
  explicit `OrchestrationState` enum with a hard attempt budget and loop detection driven by the audit
  log (correctly keyed — fix the v1 `provider_from` null bug with a typed log writer that makes the bug
  unrepresentable).

Exit criteria:
- [ ] On the seeded benchmark (§8), routed mode spends **< 60%** of always-flagship cost at **≥ 95%**
  of always-flagship task success.
- [ ] 100% branch coverage on `classify/route/assess/review/decideNext`.
- [ ] An arch test proves no `core/` file imports `child_process`, `fs`, or `console`.
- [ ] Worker tier is exercised by at least one real benchmark task and the ledger shows it ran.

### 4.2 ICING — polish/UX  (v1: C+ but deceptive → target: A++)

**A++ means:** the polish is beautiful *and* every pixel is true. Streaming real tokens, real costs,
real provider state, graceful everything.

Work:
- **Stream, don't fake.** The UI renders `ProviderEvent`s as they arrive — real text deltas, real tool
  calls ("Codex is editing `auth.ts`…"), real reasoning shimmer. No `setTimeout` theater. Because the
  provider layer is genuinely async-streaming (Agent SDK / JSONL), the spinner reflects actual work,
  fixing v1's bug where `spawnSync` blocked the spinner's own timer.
- **Truthful status surfaces.** `/status`, `/cost`, `/models`, banner — all read live state. If there's
  no session yet, it says so. The provider-balance bar shows real call counts from the ledger or is
  hidden. Delete every hardcoded "12 exchanges / 8m 23s / sess-abc123."
- **Signal handling done right.** Ctrl‑C cancels the in-flight model run via `AbortSignal` (kills the
  child process), flushes the session/ledger atomically, and exits — no 500 ms cosmetic `setTimeout`
  pretending to "save." Double Ctrl‑C force-quits. SIGTERM handled. Resize handled. Paste of multi-line
  input handled.
- **Accessibility & environments.** Respect `NO_COLOR`, `FORCE_COLOR`, non-TTY (CI) → plain
  line-oriented output, `TERM=dumb`. Width-aware layout. Emoji-degradation for terminals without it.
- **Error messages that teach.** Keep v1's good error taxonomy; make every message state *what
  happened, why, and the exact next command to run* — and verify those commands are real (Appendix A).

Exit criteria:
- [ ] Snapshot tests of rendered output for: success, escalation, review-bounce, provider-down,
  not-authed, Ctrl‑C mid-run, non-TTY mode.
- [ ] Honesty-lint passes: zero hardcoded metrics in `ui/` or `interface/`.
- [ ] Manual a11y checklist (NO_COLOR / non-TTY / narrow width / no-emoji) all pass on 3 OSes.

### 4.3 CODE QUALITY  (v1: D → target: A++)

**A++ means:** TypeScript strict, zero dead code, zero duplication, names that state intent, one way to
do each thing, enforced by tooling in CI.

Work:
- **TypeScript, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.** The typo class
  of bug (`providerfrom`) becomes a compile error because log entries are constructed via a typed
  builder, not bag-of-keys object literals.
- **Dead-code elimination is mechanical, not manual.** `knip` (dead exports/files/deps) + ESLint
  `no-unused-vars` + `ts-prune` run in CI and **fail the build** on any unused export, file, or dep.
  This makes v1's "112-line unread config + 6 dead templates + dead duplicate balancer" literally
  unmergeable.
- **One source of truth per concept.** One load-balancing implementation, one prompt source (and if we
  externalize prompts to `templates/`, there is a loader and a test that every template is referenced;
  otherwise prompts live in typed constants — no orphan files).
- **Naming review as a gate.** PR checklist item: do the names state intent? `chef` → `orchestrate`.
  `runTier` stays but is pure. No `data/orchestrator.json` ghost.
- **Prettier + ESLint (typescript-eslint strict) + import-order**, all enforced.

Exit criteria:
- [ ] `knip`, `ts-prune`, `eslint`, `tsc --noEmit` all green in CI with zero suppressions outside a
  reviewed allowlist.
- [ ] No file in `dist` that no entry path reaches (verified by `knip` + bundle graph).
- [ ] Duplication scan (`jscpd`) < 1% on `src/`.

### 4.4 PERFORMANCE & EFFICIENCY  (v1: C → target: A++)

**A++ means:** fast cold start, truly async/streaming provider calls, parallel where it helps, bounded
memory, justified deps.

Work:
- **Kill `spawnSync` in the hot path.** Use async `spawn` with streamed stdout parsing (or the Agent
  SDK's async generator). This unblocks the event loop, makes the spinner real, and enables
  cancellation and parallel cross-provider review.
- **Parallelism where it's a win.** When two providers are available and the plan calls for a second
  opinion, run primary and reviewer-prep concurrently; when classification is provider-agnostic,
  pre-warm detection. Never serialize what can be concurrent.
- **O(1) appends.** Fix v1's O(n²): `session.ts`/`handoffs.ts` use real append (`appendFile` / a kept-
  open append stream) guarded by the atomic lock, not read-whole-file-then-rewrite. Rotate logs at a
  size threshold.
- **Cold start budget.** `myshell-tools --version` and `--help` must not import the provider/SDK graph. Lazy-
  import heavy modules behind the subcommands that need them. Target: `--help` < 150 ms,
  interactive banner < 400 ms on a warm disk (measured in CI with a perf smoke test).
- **No busy-wait.** Replace v1's CPU-spinning lock loop with `await setTimeout`-based backoff.

Exit criteria:
- [ ] Perf test: `--help` and `--version` cold-start under budget on all 3 OSes.
- [ ] Memory test: 10k-message session append stays O(1) per write (timed) and flat heap.
- [ ] Cancellation test: Ctrl‑C during a run terminates the child within 250 ms (no orphan processes).

### 4.5 INTELLIGENCE & ORCHESTRATION  (v1: F → target: A++)

**A++ means:** the multi-model system is *demonstrably* better or cheaper than single-model on a
benchmark, prompts are real and version-controlled and tested, and "confidence" is grounded.

Work:
- **Adopt the strongest honest pattern (V2): cross-vendor adversarial review.** Default reviewer is the
  *other* vendor. The reviewer prompt demands file-anchored, line-referenced, actionable findings with
  a structured verdict; vague "looks good" is rejected and re-prompted once.
- **Prompts are engineered artifacts, not afterthoughts.** Each tier/role prompt: explicit role, the
  task, the working contract (edit files directly, run tests, report what changed), a strict output
  envelope, and few-shot exemplars for the confidence/verdict JSON so parsing is reliable. Prompts are
  versioned, snapshot-tested, and changes require a benchmark re-run.
- **Structured output envelope, robustly parsed.** Define a single JSON envelope schema
  (`{confidence, escalate, reason, needs_review, verdict?, findings?}`), validate it, and have a
  deterministic fallback that marks confidence `null` (not a guessed number) when the model didn't
  comply. Prefer the providers' native structured/JSON modes over regex-scraping free text.
- **Cost-aware routing with a real model table.** `route()` consults `pricing.ts` + task class to pick
  the cheapest model whose expected success clears the bar. The expectation table starts as documented
  priors and is **updated from the ledger's observed success/cost** over time (and that learning is
  itself tested with fixtures).
- **Loop & failure detection that actually reads correct data** (typed audit log; the v1 op-name
  mismatch and null-provider bugs are unrepresentable).

Exit criteria:
- [ ] **Benchmark proof (the headline):** on a seeded suite of ~30 tasks spanning trivial→complex, the
  orchestrated system beats best single-model on a blended `cost × correctness` score, and we publish
  the numbers in the README (real, reproducible via `myshell-tools bench`).
- [ ] Cross-provider review catches ≥ X seeded defects that single-model misses (X set after baseline).
- [ ] Envelope parser has fuzz tests over malformed/partial model output; never throws, never invents a
  number.

### 4.6 PRODUCTION READINESS  (v1: F → target: A++)

**A++ means:** real tests, real cross-platform support, least-privilege security, clean packaging,
versioned releases, and observability.

Work (expanded in §5–§9):
- Full test pyramid (§5), security model (§6), Windows correctness (§7), telemetry (§8),
  packaging/release/CI (§9).
- **Doctor that doesn't lie.** `myshell-tools doctor` runs real probes (CLI present? authed? can we execute a
  1-token no-op? write to `.myshell-tools`?) and reports actual versions/models. The v1 doctor README example
  with invented model IDs is gone; doctor prints what it truly found.
- **Supply chain & provenance.** npm publish with provenance, `--ignore-scripts` safe install,
  lockfile committed, `npm pack` content reviewed in CI (no dead `data/`/`templates/` shipped, no
  secrets, no `.myshell-tools/`).

Exit criteria: see §12 scorecard (this section is the union of §5–§9 gates).

---

## 5. Testing strategy — the missing pillar

v1 had **zero** tests; that single fact explains nearly every defect. Testing is not a phase, it's the
substrate. The pyramid:

### 5.1 Unit tests (the bulk) — `test/unit/`
Pure `core/` functions, table-driven. Because routing/escalation/review are pure
`(state, signals) → decision`, each rule is a row:
```
classify("rename foo to bar")                    → tier=worker, risk=low
classify("rotate the prod signing key in .env")  → tier=manager, risk=critical
route(worker, {claude,codex}, budget)             → cheapest worker model
assess({selfConfidence:null, exitCode:1})         → escalate=true (verified failure)
decideNext(state=IC_DONE, verdict=bounce, n=1)    → state=IC_RETRY
```
Provider port is a **fake** that yields scripted `ProviderEvent[]`. No network, no subprocess, fast.

### 5.2 Contract tests — `test/contract/`
Each adapter is tested against **recorded real transcripts** (JSONL captured once from actual
`claude -p --output-format stream-json` and `codex exec --json` runs, stored in `test/fixtures/`). This
pins our parsing to the providers' real wire formats and catches breakage when a CLI changes its output.
Refresh fixtures on a schedule; a failing contract test = "the CLI changed, update the adapter."

### 5.3 Integration / E2E — `test/integration/` (gated `CORTEX_E2E=1`)
Real CLIs, real (cheap) models, on a scratch repo. Runs in CI nightly with secrets, not on every PR
(to stay fast and not burn quota). Validates the whole path including spawn, sandbox, cancellation,
and session/ledger writes.

### 5.4 Snapshot tests for UI — `test/unit/` (render)
Render functions are pure (data → string). Snapshot the terminal output for every important state,
including `NO_COLOR` and non-TTY variants.

### 5.5 Property/fuzz tests
The structured-output envelope parser is fuzzed with malformed/truncated/duplicated JSON to guarantee:
never throws, never fabricates a confidence number, always degrades to `null`.

### 5.6 Architecture & honesty tests (the v1-killers) — `test/arch/`
Automated guards that make v1's failure modes *impossible to merge*:
- **No-mock guard:** static scan fails if `interface/` or `ui/` contains literals matching a
  response/metric shape, or imports anything that returns canned strings; the only response source
  allowed in those layers is the `orchestrate()`/provider stream.
- **Purity guard:** `core/` must not import `child_process`, `fs`, `console`, `Date`, `Math.random`
  (time/uuid/random come from the injected `clock`).
- **Single-entry guard:** exactly one call site each for the REPL and runner, both into `orchestrate()`.
- **No-orphan guard:** `knip` + `ts-prune` — zero dead files/exports (kills dead config/templates).
- **Honesty-lint:** custom ESLint rule banning hardcoded percentages/durations/IDs in user-facing
  strings unless tagged with a `/* @real(source) */` annotation that references a live value.

### 5.7 Coverage gates (CI-enforced)
- `core/` ≥ 90% lines, **100% on decision functions**.
- Overall ≥ 85%. PRs that drop coverage fail.

---

## 6. Security model

The tool runs LLM-generated actions against the user's machine. v1 handed Codex
`-s danger-full-access` on every task — unacceptable. The new model:

1. **Sandbox ladder, default-safe.** Map our `SandboxLevel` to each CLI:
   - `read-only` → Claude: no edit/bash tools; Codex: `--sandbox read-only`.
   - `workspace-write` (**default**) → edits confined to cwd; Codex: `--sandbox workspace-write`.
   - `full-access` → Codex `--sandbox danger-full-access` / Claude bypass perms — **only** after an
     explicit interactive consent gate, scoped to the session, recorded in the audit log with a reason.
2. **Risk-gated escalation.** The classifier's `critical`/`high` risk classes (auth, secrets, `.env`,
   billing, deploy) *raise* the required consent, never lower the sandbox silently. A task touching
   `.env` cannot run at `full-access` without an explicit, separate confirmation.
3. **No prompt-as-shell-arg.** Prompts go to the child via **stdin**, never the command line. This
   eliminates shell-injection (esp. on Windows where `shell:true` is needed for `.cmd`), avoids
   `ARG_MAX` limits, and handles arbitrary content safely. (§7.)
4. **Credentials.** We never read, store, or transmit provider credentials ourselves; auth lives in the
   CLIs. Detection checks *existence/validity signals only*, never copies token contents. No secret is
   ever written to the session log or telemetry (a redaction pass + a test asserting no token-shaped
   strings in artifacts).
5. **Telemetry is local-only by default.** The ledger/handoff logs stay on disk. Any future remote
   reporting is opt-in, documented, and off by default (the Honesty/least-surprise contract).
6. **`security-review` in CI** on every PR (the repo's own security-review skill / `npm audit` /
   `codeql`), plus dependency review for the (ideally zero) runtime deps.

---

## 7. Cross-platform correctness (Windows is not an afterthought)

The single most important code-level fact, grounded in CVE‑2024‑27980: **Node ≥ 18.20.2/20.12.2 throws
`EINVAL` if you `spawn` a `.cmd`/`.bat` (which is what `claude`/`codex` are on Windows) without
`shell:true`.** v1's `executeWithRecovery` spawned with no shell → broken on Windows; it only "worked"
because the shipped REPL never executed anything.

The one correct spawn (`providers/spawn.ts`), used everywhere:
- Detect platform. On `win32`, the launcher resolves the real executable (prefer the `.cmd`/`.ps1`
  shim's target, or use `shell:true` with **fully-quoted** args). Because we pass the **prompt via
  stdin**, the only command-line args are fixed, trusted flags — so `shell:true` carries no injection
  risk from user input.
- Never pass untrusted content as an arg on any platform (defense in depth).
- Set `windowsHide:true`, propagate `AbortSignal`, enforce timeout, capture stdout/stderr as streams.
- A contract test runs the spawn path on the Windows CI runner against a tiny fake "cli" `.cmd` to prove
  it launches, receives stdin, streams stdout, and cancels — *without* relying on real Claude/Codex.

CI matrix: `{windows-latest, macos-latest, ubuntu-latest} × {Node 20 LTS, Node 22 LTS}` for the full
unit/contract/arch suite on every PR.

---

## 8. Observability & cost telemetry (this is how V1/V2/V4 become *provable*)

Theater dies when value is measured. Build the measurement in from the start.

- **Cost ledger (`infra/ledger.ts`).** Every model call records `{provider, model, inputTokens,
  outputTokens, cachedInputTokens, usd, tier, taskId, durationMs, success}`. `usd` = real token counts
  (from the provider's `usage` event) × the price table in `pricing.ts`. Stored append-only in
  `.myshell-tools/ledger.jsonl`.
- **`myshell-tools cost`** shows real spend for the session/day/project and the **counterfactual**: "you spent
  $0.12; always-Opus would have been $0.41 (3.4× more)." This is V1 made visible and honest.
- **`myshell-tools bench`** runs the seeded benchmark suite (§4.5) and reports blended cost×correctness for:
  orchestrated, always-flagship, always-cheap, single-Claude, single-Codex. These numbers go in the
  README and are reproducible by anyone. **No claimed benefit ships unmeasured.**
- **`myshell-tools replay <session>`** reconstructs the orchestration timeline from the audit log (V4).
- **Pricing provenance.** `pricing.ts` carries an `asOf` date and source URLs (Appendix A). A test
  warns when prices are > N months stale, prompting a refresh — we will not let the price table rot
  into fiction like v1's unread config.

---

## 9. Packaging, release, and CI

- **Build:** TypeScript → `dist/` (ESM, Node ≥ 20). `bin` points to `dist/cli.js` with a correct
  shebang; `prepublishOnly` builds and runs the full suite.
- **`files` allowlist** ships only `dist/`, `README`, `LICENSE`, `CHANGELOG`. No `src/`, no tests, no
  `.myshell-tools/`, no dead `data/`/`templates/`. `npm pack --dry-run` is asserted in CI against an expected
  manifest.
- **One version source** (`package.json`), surfaced via `createRequire`. CHANGELOG kept (Keep a
  Changelog), real dates, SemVer.
- **CI (`ci.yml`)** on every PR: install (`--ignore-scripts`), typecheck, lint, knip/ts-prune,
  honesty+arch tests, unit+contract tests, coverage gate, perf smoke, `npm pack` manifest check,
  security-review, OS matrix. Nightly: E2E with real CLIs + fixture-refresh job.
- **Publish** with `--provenance`, signed tags, automated via release workflow on tag.
- **Docs that match reality.** README install/usage commands are taken verbatim from Appendix A and
  asserted by a doc-test that extracts fenced commands and checks them for the known-correct strings.

---

## 10. Tech-stack decisions (with rationale = ADRs)

Each becomes an ADR in `docs/adr/`:

| Decision | Choice | Rationale |
|---|---|---|
| Language | **TypeScript, strict** | Makes the v1 typo-class of bug a compile error; types are the cheapest tests. Compiles to zero-runtime-dep JS. |
| Test runner | **`node:test` + `c8`** (built-in first) | Keeps dev-deps minimal; no framework lock-in. `vitest` allowed if snapshot ergonomics demand it (ADR). |
| Claude adapter | **`@anthropic-ai/claude-agent-sdk` primary, `claude -p` fallback** | SDK gives a real streaming async generator, permission modes, and structured events — far more robust than scraping stdout. Fallback preserves the pure-CLI/zero-extra-dep path. This is the *one* runtime dep we may accept; gated behind an adapter so the CLI path keeps zero-dep purists whole. |
| Codex adapter | **`codex exec --json` + `--output-last-message`** | Native JSONL event stream (`item.completed`/`agent_message`/`turn.completed` usage) — parse the documented schema, no scraping. |
| Prompt-to-child | **stdin, not argv** | Security + Windows quoting + ARG_MAX. |
| Spawn | **async `spawn`, custom thin wrapper** | Non-blocking, cancelable, correct on Windows; not worth a dep. |
| Lint/format | **typescript-eslint (strict) + Prettier + knip + ts-prune + jscpd** | Mechanically enforces the code-quality bar. |
| Zero runtime deps | **goal, with the Agent-SDK exception isolated behind an adapter** | Preserves the product's "thin layer" identity; any dep is justified in an ADR. |

> **Open architecture question (decide in T0 via ADR):** does the Claude **Agent SDK** authenticate via
> the user's **Claude Code subscription** (preserving V3, no API metering) or require an API key? If it
> requires a key, the **CLI shell-out (`claude -p`) becomes the default adapter** to protect the
> subscription-arbitrage value prop, and the SDK is an opt-in "I have an API key" mode. This must be
> verified empirically before committing the dependency.

---

## 11. Phased roadmap (with exit gates — no phase starts until the prior gate is green)

**Phase 0 — Foundation & truth-in-advertising (T0).**
Lock the name (npm-verified). Scaffold TS strict + CI matrix + lint/knip + the **arch/honesty tests
first** (so they guard from commit #1). Salvage & port `errors` and `atomic` (with the O(1) + lock
fixes) *with tests*. Write Appendix A facts into `pricing.ts`/`detect.ts`. Resolve the Agent-SDK auth
ADR.
*Gate:* CI green on 3 OSes; arch/honesty/purity tests pass on an empty skeleton; `--help`/`--version`
work and are under the cold-start budget.

**Phase 1 — Real single-provider vertical slice.**
`Provider` port + **one** adapter (whichever auths via subscription most cleanly) + `spawn` (stdin,
cross-platform, cancelable) + `orchestrate()` doing the simplest real thing: classify → run IC → stream
real output → write session + ledger. The REPL and `myshell-tools run` both call it.
*Gate:* contract tests vs recorded fixtures pass; a real task end-to-end produces real output and a real
cost ledger entry on all 3 OSes; cancellation kills the child < 250 ms; **zero hardcoded UX data**
(honesty-lint green).

**Phase 2 — Cost-aware routing + Worker/Manager tiers (V1).**
`route()` + `policy.ts` + Worker/IC/Manager fully wired with real model selection; `myshell-tools cost` with
counterfactual; `myshell-tools bench` harness + seeded suite.
*Gate:* benchmark shows routed mode < 60% always-flagship cost at ≥ 95% success; 100% decision-function
coverage.

**Phase 3 — Second provider + cross-vendor adversarial review (V2 + V3).**
Second adapter; `review.ts` with file-anchored findings; default reviewer = other vendor; escalation &
loop detection on the typed audit log.
*Gate:* review catches the seeded defects single-model misses; subscription-auth path confirmed for both
providers (V3); replay command works (V4).

**Phase 4 — Polish, perf, and production hardening.**
Full UI states + a11y/non-TTY + snapshot tests; perf/memory/cancellation tests; security model
(sandbox ladder + consent gate + redaction); doctor with real probes; docs doc-tested; packaging
manifest asserted; provenance publish.
*Gate:* the entire §12 scorecard is green.

**Phase 5 — Launch.**
README with *real* benchmark numbers, real install commands, one identity. Publish.

---

## 12. Definition of Done — the A++ scorecard

Ship only when **every** box is checked and reproducible in CI.

**Batter (A++)**
- [ ] Single real orchestration path; mock path structurally impossible (arch test).
- [ ] All three tiers reachable and exercised by real benchmark tasks.
- [ ] Routed cost < 60% of always-flagship at ≥ 95% success on the seeded suite.
- [ ] 100% branch coverage on classify/route/assess/review/decideNext.

**Icing (A++)**
- [ ] Real streaming UI; zero fabricated metrics (honesty-lint green).
- [ ] Snapshot tests for all UX states incl. NO_COLOR/non-TTY/Ctrl‑C.
- [ ] a11y checklist passes on 3 OSes.

**Code quality (A++)**
- [ ] TS strict; knip/ts-prune/eslint/jscpd green, zero unreviewed suppressions.
- [ ] One identity everywhere; version from one source.

**Performance (A++)**
- [ ] No `spawnSync` in hot path; provider calls async-stream.
- [ ] `--help`/`--version` under cold-start budget; O(1) appends; Ctrl‑C kills child < 250 ms.

**Intelligence (A++)**
- [ ] Published, reproducible benchmark proving multi-model beats best single-model on cost×correctness.
- [ ] Cross-vendor review catches seeded defects single-model misses.
- [ ] Envelope parser fuzz-tested: never throws, never fabricates a number.

**Production readiness (A++)**
- [ ] Test pyramid in place; coverage gates enforced; OS matrix CI.
- [ ] Windows spawn correct (CVE‑2024‑27980‑safe) + proven by contract test on Windows runner.
- [ ] Sandbox least-privilege default + consent gate for full-access; secret-redaction test.
- [ ] `files` allowlist asserted; publish with provenance; docs doc-tested against Appendix A.

**Single biggest thing we must not regress:** *the tool must call a real model the first time anyone
runs it, and show them only true information about what happened.* Everything else is in service of
that.

---

## 13. Risks, assumptions, and open questions

- **CLI output formats drift.** Mitigation: contract tests on recorded fixtures + a nightly
  fixture-refresh job that surfaces breakage as a failing test, not a silent prod bug.
- **Subscription auth via SDK uncertain.** Resolve in T0 ADR (see §10). If SDK needs an API key, CLI
  shell-out stays default to protect V3.
- **Benchmark design bias.** The seeded suite must be public, diverse, and not cherry-picked; include
  tasks where orchestration *loses* and report them honestly (that's the Honesty Contract applied to
  ourselves).
- **Pricing/model churn.** `pricing.ts` carries `asOf` + staleness test; models are resolved through a
  table, never hardcoded at call sites.
- **Quota/cost in E2E CI.** Gate E2E to nightly with cheap models and a spend cap.
- **Name availability.** T0 blocker; do not build under a name we can't publish.

---

## Appendix A — Corrected facts (verified 2026-05; the v1 docs got these wrong)

> These supersede every install/model/flag string in the v1 README, CLI, and config. They live in code
> (`pricing.ts`, `detect.ts`, error messages) with these source URLs as provenance.

**Claude Code CLI**
- Install: `npm install -g @anthropic-ai/claude-code` (v1's `pip install anthropic-cli` /
  `claude-ai-cli` were both wrong).
- Headless: `claude -p "<task>" --output-format json` (one JSON) or `--output-format stream-json
  --verbose` (JSONL). Prompt can be supplied via stdin.
- Programmatic: `@anthropic-ai/claude-agent-sdk` → `query()` async generator (streams typed messages).
- Models (2026): **Opus 4.7** ($5/$25 per M tok), **Sonnet 4.6** ($3/$15), **Haiku 4.5** ($1/$5);
  1M-token context on Opus/Sonnet. `--model opus|sonnet|haiku` aliases resolve to current gen; pin full
  IDs for reproducibility.

**Codex CLI (OpenAI)**
- Install: `npm install -g @openai/codex` (then `codex login`). *(Verify exact package/install at T0.)*
- Non-interactive: `codex exec --json -m <model> --sandbox <read-only|workspace-write|danger-full-access>
  [--output-last-message <file>] -` (prompt via stdin).
- Event schema (`--json` JSONL): `thread.started → turn.started → item.completed(item.type=agent_message
  | reasoning | command_execution | file_change | …) → turn.completed(usage)`; `turn.failed` / `error`
  on failure. v1's parsing of `item.completed/agent_message` + `turn.completed.usage` was actually
  correct — keep it, harden it.
- Sandbox default is **read-only**; we default to **workspace-write**; **danger-full-access only behind
  consent.**
- Models (2026): **GPT‑5.5** ($5/$30), GPT‑5.5 Pro ($30/$180), **GPT‑5.4** ($2.50/$15), GPT‑5.4 Mini
  ($0.75/$4.50), GPT‑5.4 Nano ($0.20/$1.25), **GPT‑5.2‑Codex** ($1.75/$14). (v1's `gpt-5.5`/`gpt-5.4`
  names were *real*, but the prices lived in an unread config — here they're in `pricing.ts` and
  actually drive routing.)

**Node / Windows**
- CVE‑2024‑27980: `spawn`/`spawnSync` on a `.cmd`/`.bat` without `shell:true` throws `EINVAL`
  (Node ≥ 18.20.2/20.12.2). Use `shell:true` **with trusted, fixed args only** (prompt via stdin), or
  resolve the real target. Never revert the CVE patch.

**Sources**
- Claude Code install / headless / Agent SDK:
  https://www.npmjs.com/package/@anthropic-ai/claude-code ·
  https://code.claude.com/docs/en/setup ·
  https://platform.claude.com/docs/en/agent-sdk/typescript
- Claude pricing: https://platform.claude.com/docs/en/about-claude/pricing ·
  https://www.cloudzero.com/blog/claude-api-pricing/
- Codex CLI reference / non-interactive / sandbox:
  https://developers.openai.com/codex/cli/reference ·
  https://developers.openai.com/codex/noninteractive ·
  https://developers.openai.com/codex/concepts/sandboxing ·
  https://github.com/openai/codex/blob/main/docs/exec.md
- OpenAI pricing: https://developers.openai.com/api/docs/pricing ·
  https://www.cloudzero.com/blog/openai-pricing/
- CVE‑2024‑27980: https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 ·
  https://www.herodevs.com/vulnerability-directory/cve-2024-27980

---

## Appendix B — Salvage & kill lists (from v1)

**Salvage (port to TS + tests):**
- `providers/errors.mjs` → `providers/errors.ts` — recoverability classification, backoff+jitter,
  friendly messages. Keep the taxonomy; wire to the typed event model.
- `state/atomic.mjs` → `infra/atomic.ts` — O_EXCL locking + tmp+rename. **Fix:** O(1) append (drop
  read-whole-file-rewrite), replace busy-wait with async backoff, and make `session`/`handoffs`
  actually use the lock.

**Kill (do not port):**
- `repl-enhanced.mjs` (the mock), `generateMockResponse`, `simulateAIWork`, `getProviderBalance` (fake),
  the `Math.random` session/balance fakes.
- `providers/balance.mjs` (duplicate of `select.mjs`); collapse to one `route.ts`.
- `data/orchestrator.json` (unread) and `templates/prompts/*` (unread) — replace with typed `policy.ts`
  + tested prompt constants/loader.
- `classifyPathRisk` (dead dup of `classifyFileRisk`), `delegateToWorker` (dead), the truthiness-guarded
  static imports, and `classify.mjs`'s `typeof selectProvider` dead branch.
- Every fabricated install string and the `VERSION` constant.

---

*End of plan. This document is the contract; PRs are reviewed against §12. If a change can't point to a
principle in §1 or a value prop in §2, it doesn't merge.*
