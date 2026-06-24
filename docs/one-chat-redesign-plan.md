# myshell-tools — "One Chat to Rule Them All" Redesign Plan

> Single source of truth for the redesign. Delegated agents read THIS file first so they
> don't re-derive context. Keep it updated as phases land.

## North Star

One chat. One voice. The user vibes; magic happens. Intelligence comes from whatever
model the user has (any provider, even a 1-provider/1-model setup). Quota is protected
**not by thinking dumber, but by thinking once, reusing context, gating spend, and
decomposing work.** Supports the full spectrum: pure vibe coder → hands-on senior dev.

## Load-bearing design principles (do not violate)

1. **Byproduct intelligence.** Intent classification, message routing, and draft plans are
   emitted as *structured side-output of the turn the user is already having with their
   chosen (strong) model* — never a separate cheap "router" call. One call, full intelligence,
   cache-hit input. No draft tokens emitted when intent ≠ build.
2. **Cheap models only for throwaway, self-correcting work** (ghost text). Errors there are
   free because the user accepts/rejects. Never for planning/understanding.
3. **Quota lever = frequency, context reuse, gating — not model intelligence per call.**
4. **Manager = curated state, NOT a live model and NOT a raw transcript.** Each goal carries
   a compact skeleton + rolling decision summary + evidence pointers (files/commits/verdicts).
   This is how we "never get context bloated."
5. **Lean orchestrator = deterministic plumbing.** It holds only pointers + 1-line status per
   goal and routes turns to the right lane. All intelligence is rented from the user's model
   via byproduct. This is *why* it's provider-agnostic.
6. **Always confirm before execution spend.** Remember per-user preference (manual /
   semi-auto / auto), changeable just by telling it in chat.
7. **Progressive (just-in-time) decomposition.** High-level shape now; detailed to-dos only as
   work reaches each sub-goal. Higher quality (reality-informed) AND cheaper (no throwaway detail).
8. **Provider-agnostic, gracefully degrading.** Roles (chat / ghost / execution) are logical and
   collapse onto whatever exists. 1-provider/1-model must work with high success — compensate
   quota via frequency/local-first, never via model downgrade (there's nothing to downgrade to).
9. **Timeouts are a symptom of bad decomposition.** Fix structurally (small units) + heartbeat/
   recovery + honest "here's exactly what happened" on unrecoverable failure.

## Engineering discipline (match existing repo conventions)

- New behavior behind **feature flags**, default-safe, promoted to stable once proven (mirrors
  the v9 phase/stable-flag/rollback pattern already in the repo).
- Every phase ships **green** (CI, typecheck, knip dead-code gate) and is independently valuable.
- **Provider test matrix:** every phase validated on (a) single-provider/single-model and
  (b) multi-provider. No phase is "done" until both pass.
- Auto-merge PRs when confident (per user). One PR per phase (or per sub-slice).

## Delegation model

The orchestrator (lead) holds the design in this doc. Each phase is delegated to an agent that
reads this file + does focused work + returns a summary. Lead reviews/integrates. We do NOT
delegate the design/coherence — only investigation and implementation of specced slices.

---

## Phase 0 — Provider substrate: capability + effort/mode normalization

**Why first:** every later phase rides on (a) the model reliably emitting parseable structured
byproduct on *any* provider, and (b) the firepower dial actually changing models/effort. The Phase 0
investigation (below) established that **most of this substrate already exists** — providers, tier-based
model selection, a real mode dial, a normalized reasoning-effort scale, a ledger, and a flag/rollback
convention. Phase 0 is therefore mostly *re-expressing and extending* what's there (the logical role
layer, the 5-level dial over the existing modes, the parse-fallback) rather than building from scratch.
De-risks everything; prevents rework.

- **Capability normalization layer:** emit structured byproduct (intent + routing + draft) with a
  robust **parse-from-text fallback** for providers with weak/odd structured-output support.
  Single biggest "works on any provider" risk — handle it here.
- **Role abstraction:** chat / ghost / execution roles that resolve against the user's available
  models, collapsing gracefully to 1-provider and 1-model.
- **5-level firepower dial → normalized effort + model rung** (**Budget / Balanced / High / Max /
  Auto**, Auto the default), *provider-relative*: each level maps to per-role model rung + reasoning
  effort (OpenAI/Grok `reasoning_effort`, Anthropic adaptive-thinking/budget) + verification depth +
  panel/hedge engagement + context budget. The levels layer OVER the existing 3-stop `Mode` /
  `POLICY_PRESETS` machinery (Budget≈cost-saver, Balanced≈balanced, High = a new mid-high rung,
  Max≈quality-first + full panel, Auto = per-turn). Intensity (1–5) folds UNDER the level as an
  optional override. See "Phase 0 — Implementation Spec (slice 2)".
- **Ledger groundwork** so later phases can surface spend.

**Done when:** mode dial demonstrably changes models + effort across providers; byproduct parsing
works on single- and multi-provider setups incl. a structured-output-weak provider; existing
behavior preserved behind flags.

## Phase 1 — The spine: byproduct intent → draft-then-activate goals (JIT decomposition)

**Why:** this is the heart — "talk and a plan you approve appears." Also structurally kills timeouts.

- Strong model emits per-reply byproduct: **intent** (asking/discussing vs build), **routing target**,
  and (on build-intent only) a **draft goal skeleton**.
- Draft goals created **inactive ("digesting")**, shown on board, **never executed without confirmation.**
- **Confirmation gate** before execution spend; **remember preference** (manual/semi-auto/auto),
  changeable via chat ("just start when you're confident").
- **Hierarchy:** goal → sub-goal → to-do. **Progressive decomposition:** skeleton now, per-sub-goal
  to-dos materialized just-in-time as work approaches.
- Small execution units ⇒ no monster single calls ⇒ structural timeout prevention.

**Done when:** "make an app with 20 pages" drafts a hierarchical inactive plan, user approves, it
executes in small units; preference is remembered; no over-triggering on pure discussion.

## Phase 2 — Manager-as-curated-state + lean orchestrator (the "never bloated" payoff)

**Why:** delivers the multi-goal context architecture without bloat.

- Each goal gets a persistent **curated state lane**: skeleton + rolling decision summary +
  **evidence pointers** (files/commits/verdicts). Never raw transcript.
- **Lean orchestrator:** pointers + 1-line status per goal; routes each turn to the right lane using
  Phase 1's byproduct routing. New goal / existing goal / global chat / cross-goal ops (merge, drop).
- Resume loads **only** the relevant lane → context stays bounded regardless of session length.

**Done when:** a session with several concurrent goals keeps per-turn context lean; switching goals
loads only that lane; cross-goal operations work; one invisible voice to the user.

## Phase 3 — Goal lifecycle, self-management & recovery (the "stuck"/timeout finish)

**Why:** completes "elite self-management" + "recover, and if you can't, say what happened."

- **Reconcile state:** a goal never silently hangs in `running`; detect completion (all to-dos
  verified) and stalls; status always reflects reality.
- **Recovery:** heartbeat on long runs; auto-recover stalled runs; on unrecoverable failure, state
  exactly what happened and where.
- **Autonomy** honors remembered preference: manual (confirm each) / semi-auto / full-auto advance.

**Done when:** goals never get stuck; long runs are resilient and visible; failures are honest and
specific; advancement respects the user's chosen autonomy level.

## Phase 4 — Surfaces: goal board rehaul + menu goal-section collapse

**Why:** the visible 10/10 polish (problems #1 and #5).

- **Menu:** collapse the awkward parked-goals section into a single neat summary line
  (e.g. counts + "press g"), no chunky block.
- **Board rehaul:** hierarchical (goal → sub-goal → to-do), live status, verdicts, running agents,
  scope. Simple/clean for vibe coders; expandable depth for pros. The board is the heartbeat the
  user watches while chatting.

**Done when:** menu is neat and un-redundant; board is clean, hierarchical, and reads at a glance
while still expandable for technical users.

## Phase 5 — Ghost text: goal-aware predictive autocomplete (we build it)

**Why:** problem #3 — "very good" tab-complete. Confirmed: no built-in Claude autocomplete exists;
everyone builds it on the Messages API. Quality is in our hands; cost controlled by frequency.

- **Layered, local-first:** history + slash-command trie + path matching + in-memory cache resolve
  most cases with **zero model calls**; fast model is the fallback only.
- **Debounced, canceled-on-keystroke, fail-soft** (disable silently if backend slow). NOT per-keystroke.
- **Zero-input prediction = next *action*** given board state (approve / start / next-todo / skip /
  ship), generated as **byproduct of turn-end** (piggyback on a paid turn), cached. **While-typing**
  completion reuses the same machinery.
- Uses the **ghost role** model (a *good* fast model — cheap via low volume, not via low quality).
- Provider-agnostic: ghost role resolves to the fastest model the user has; on 1-model setups, lean
  harder on local layers.
- **Extreme-budget toggle:** ghost text can be **disabled entirely** in settings (both the settings
  menu and per-conversation settings). When off, the **local-only** layers (history / slash trie /
  paths / cache) still work with **zero model calls** — so budget-zero users keep useful completion.
- **Use provider-native completion where it exists.** No universal API gives ghost text — Anthropic
  has none (open feature request); the tab-complete in the Claude Code shell is an *app/harness*
  feature, NOT a model capability myshell can inherit by calling the API. But some providers expose
  fast **FIM / predicted-output** endpoints; the ghost role should opportunistically use the best
  native mechanism per provider and fall back to the messages API otherwise.

**Done when:** Tab on empty prompt offers a genuinely useful goal-aware next action; while-typing
ghost text completes toward real intents; volume stays tiny; works on single- and multi-provider.

## Phase 6 — Cost visibility & quota guardrails (trust layer)

**Why:** the obsession is quota — the user must *see* it isn't burning.

- Per-turn / per-goal **cost meter** from the ledger.
- Mode dial wired to visible spend; optional budget ceilings / warnings.

**Done when:** spend is visible and attributable per goal/turn; user can trust the system honors
"never wasteful."

---

## Sequencing rationale

0 substrate → 1 spine (depends on byproduct+roles) → 2 context architecture (depends on routing) →
3 lifecycle/recovery (depends on goals existing) → 4 surfaces (depends on the goal model being real)
→ 5 ghost text (best when goal/board state exists for goal-aware predictions) → 6 trust layer.

Each phase is shippable and valuable alone; the spine and substrate come first because everything
hangs off them; timeouts are fixed structurally in Phase 1 and hardened in Phase 3.

---

## Phase 0 — Current-State Findings (investigation)

> Read-only map of what exists today (v3.154.0), with exact `file:line` references. This is the
> ground truth Phase 0 builds on. Key takeaway: **most of the substrate the plan assumes is
> "probably missing" already exists in a tier-shaped form** — providers, model selection, a real
> mode dial, a normalized reasoning-effort scale, a ledger, and a battle-tested flag/rollback
> convention. What is genuinely absent is the *logical role* layer (chat/ghost/execution) and the
> capability-normalization parse-fallback. The mapping work is mostly *re-expressing* existing
> tier/effort machinery through a role lens, not inventing it.

### 1. Provider/model selection

- **Provider IDs** are a closed union `'claude' | 'codex' | 'opencode' | 'grok'`
  (`src/providers/port.ts:26`). The `Provider` port (`src/providers/port.ts:124-130`) exposes
  `detect()` + `run(req, signal)`; `ProviderRequest.model` is **always a concrete model id, never a
  tier/alias** (`src/providers/port.ts:35`, contract at `:13-14`).
- **Detection** (`src/providers/detect.ts:471` `detectProvider`, `:1042` `detectEnvironment`) probes
  install + real auth per provider and returns `availableModels` per provider:
  Claude `['opus','sonnet','haiku']` (`detect.ts:592`), Codex `['gpt-5.5','gpt-5.4','gpt-5.4-mini']`
  (`detect.ts:671`), OpenCode + Grok parse their real model lists from CLI output
  (`parseOpencodeModels` `detect.ts:818`, `parseGrokModels` `detect.ts:948`).
- **Registry** builds the live provider map gated on `installed` (`buildProviders`
  `src/providers/registry.ts:31`) and the orchestration set gated on `authenticated`
  (`buildAuthenticatedProviders` `registry.ts:66`).
- **Model resolution is TIER-based, not role-based.** `route(tier, available, policy, …)`
  (`src/core/route.ts:157`) clamps the requested `Tier` (`worker|ic|manager`,
  `src/core/types.ts:21`) to `policy.maxTier`, picks a provider by `policy.providerOrderByTier`, then
  resolves the cheapest concrete model for that provider+tier (`decisionFor` `route.ts:187`,
  `candidateModelsFor` `route.ts:231`), with an opt-in capability-fit re-rank within the bounded
  candidate set (`applyCapabilityFit` `route.ts:253`). **There is no `chat`/`ghost`/`execution`
  concept anywhere** — `grep` for "ghost"/"role" in `src/` returns no routing hits.
- **Tier hints** per model live in the capability registry (`tierHint` on `ModelCapability`,
  `src/core/model-capabilities.ts:81`; declarative defaults at `:185-288`).

### 2. The mode dial (budget / balanced / high / max)

- **The internal dial is `Mode = 'cost-saver' | 'balanced' | 'quality-first'`**
  (`src/core/policy.ts:100`), user-labelled **Efficient / Balanced / Max** (`MODE_LABEL`
  `policy.ts:107`). **RESOLVED (Q1, see slice 2):** the user-facing dial is the **5-level**
  Budget / Balanced / High / Max / Auto, layered OVER these 3 internal modes — Budget≈cost-saver,
  Balanced≈balanced, **High = a new mid-high rung** (quality-first envelope, narrower panel),
  Max≈quality-first + full panel, Auto = per-turn. `Mode` stays the internal substrate; the levels
  are the surface. Persisted old `config.mode` values migrate (`migrateMode`).
- **Stored** as `config.mode?` (`src/infra/config.ts:42-43`); **absent = Auto**, which derives the
  mode from the detected subscription plan(s) (`autoModeForPlans`/`autoModeForPlanInfos`
  `policy.ts:249-267`, `defaultModeForPlan` `policy.ts:163`). Persisted via `saveConfig` with the
  no-lossy-merge contract (`config.ts:543`, doc at `:527-542`).
- **What it changes today:** the mode selects a whole `Policy` preset (`POLICY_PRESETS`
  `policy.ts:376-436`): `flagshipAdmission` (whether the manager/flagship tier can open),
  `escalateBelowConfidence` thresholds, `reviewPolicy`, and the auto-engaged
  `hedgePolicy`/`panelPolicy`/`maxPanelProviders`. **It does NOT directly pick a model** — it shifts
  *which tier is reachable* and *how readily the turn escalates*, and (indirectly, via
  `modeFromPolicy`) feeds the reasoning-effort selector (see §3). So "does the mode change models?"
  → **yes, indirectly** (by gating manager-tier admission and escalation), and **it changes effort
  directly** through `baseDesiredEffort(mode, …)`.
- **Read at:** `modeFromPolicy(deps.policy)` in `orchestrate` (`src/core/orchestrate.ts:1528`,
  `:1138`, `:1279`); the menu mode selector `runModeSelect` (`src/interface/menu-settings.ts:67`);
  auto-mode resolution (`src/interface/menu-auto-mode.ts`, `src/interface/menu.ts`); the tool-state
  self-awareness block (`src/core/tool-state.ts`).
- **Per-conversation settings menu:** the Settings screen (`src/interface/menu-settings.ts`) owns the
  mode/verbosity/partner-style/oversight selectors; `runModeSelect` (`:67`) writes `config.mode`
  (clearing it for Auto at `:109`). There is **one** settings surface (global config); there is no
  separate per-conversation mode override beyond env vars — the same `config.mode` is read each turn.
- **A SECOND user dial exists:** `Intensity = 'auto' | 1..5` (`config.intensity?`
  `config.ts:46-47`; `src/core/capacity-allocator.ts:123`) governs **concurrency regime** (focused →
  fleet-panel, `regimeForIntensity` `capacity-allocator.ts:127`), distinct from `Mode`.
  `legacyModeToIntensity` (`capacity-allocator.ts:195`) bridges them. Roles must not collide with
  either dial — see open question Q2.

### 3. Reasoning / effort handling — **already normalized internally**

- There **is** a single internal effort scale today:
  `ReasoningEffort = 'none'|'low'|'medium'|'high'|'xhigh'|'max'`, ordered cheapest→deepest
  (`src/core/model-capabilities.ts:37`, `KNOWN_REASONING_EFFORTS` `:49`, `isReasoningEffort` `:59`).
- **Selection is pure + tested:** `selectReasoningEffort({model, mode, tier, risk, taskKind, …})`
  (`src/core/route.ts:795`) → `baseDesiredEffort(mode, tier, risk, taskKind)` (`route.ts:677`)
  gives the mode×tier ladder, a bounded ±1 `difficultyStep` (`route.ts:738`), then
  `resolveSupported` steps **down** to the nearest effort the model declares. Tests:
  `test/unit/select-reasoning-effort.test.ts`.
- **Per-provider plumbing is partial and honest about it:** `ProviderRequest.reasoningEffort?`
  (`src/providers/port.ts:63`) is threaded **only when the chosen model's capability declares it
  supports an effort**. Today **only the Codex adapter** maps it to a CLI flag
  (`-c model_reasoning_effort=…`); **Claude/OpenCode/Grok ignore it** at the adapter level
  (`port.ts:56-63`) — though Claude's CLI *does* expose `--effort low|medium|high|xhigh|max` per the
  declarative registry (`model-capabilities.ts:192-194`) and Grok declares the same ladder
  (`:264-286`). So the *internal* scale → provider mapping is the gap, not the scale itself.
- **Provider-relative reality:** OpenAI/Codex + Grok use a low/med/high(/xhigh/max) effort knob;
  Anthropic's CLI exposes `--effort` levels (declared) but the messages-level lever is
  adaptive-thinking/budget. The internal `ReasoningEffort` enum is already the normalization target
  the plan asks for.

### 4. Ledger / cost tracking — **exists**

- `LedgerEntry` (`src/core/types.ts:167-202`) records per-run `provider, model, tier, inputTokens,
  outputTokens, cachedInputTokens, usd, durationMs, success`, plus optional `reasoningEffort` and
  `taskKind`. `LedgerWriter.record` (`types.ts:204`).
- Impl: `createLedger` appends JSONL to `.myshell-tools/ledger.jsonl`; `readLedger` +
  `summarizeLedger` (pure reduction) power `myshell-tools cost` (`src/infra/ledger.ts:20-103`,
  command at `src/commands/cost.ts`). Outcome learning reads it (`src/core/routing-memory.ts`,
  `learnRouting` flag). So "ledger groundwork" is **largely present**; Phase-0's ledger slice is
  about *role/effort attribution surfacing*, not building storage from scratch — see Spec.

### 5. Feature-flag + rollback convention — **the exact pattern to copy**

The repo uses a very consistent flag shape; new flags MUST match it:

- **One pure predicate file per flag** under `src/interface/ui/<x>-flag.ts` (or `src/core/<x>-flag.ts`
  for core-consumed ones). Pure, no I/O/JSX, so the regular `npm test` exercises it. Examples:
  `verify-flag.ts` (`verifyEnabled` `:48`), `board-flag.ts` (`boardEnabled` `:34`), `governor-flag.ts`,
  `tribunal-flag.ts`, `rollback-flag.ts` (`rollbackEngaged` `src/core/rollback-flag.ts:25`).
- **Opt-in truth table:** an `ON = new Set(['1','true','on','yes'])` env check on a `MYSHELL_<FEATURE>`
  var (trimmed, case-insensitive) **OR** `config.experimental<Feature> === true`. Default-OFF flags
  return false otherwise (`verify-flag.ts:34-57`). Default-ON flags additionally honor an
  `OFF = new Set(['0','false','off','no'])` opt-out (`board-flag.ts:22-50`).
- **Config key:** a documented `experimental<Feature>?: boolean` on `AppConfig`
  (`src/infra/config.ts`, e.g. `experimentalGovernor?` `:256`, `experimentalBoard?` `:397`), default
  absent. Each carries a long doc comment ending in the off-guarantee.
- **Rollback** is a unified kill-switch: `MYSHELL_ROLLBACK` / `config.rollback`
  (`rollback-flag.ts:25`); the narrow rollback scope is verify/judgment/trust only
  (`experimental-default.ts:41`).
- **Composition root:** default-ON flags are composed at the wiring site via
  `experimentalEnabledByDefault(env, config, envKey, configValue, optInHelper)`
  (`src/interface/ui/experimental-default.ts:95`). Default-OFF flags are consulted directly.
- **THE OFF-GUARANTEE (load-bearing):** when off, the feature injects **nothing** onto
  `OrchestrateDeps` (`...(enabled ? {field} : {})` spread, e.g. `menu.ts:2427-2449`,
  `:2510-2521`), so `orchestrate` short-circuits and the path is **byte-for-byte** today's. The
  characterization + oracle suites prove neutrality.
- **Arch guards** (`test/arch/guards.test.ts`): core purity (no I/O/Date/Math in `src/core/`),
  single `process.exit` in `cli.ts`, and a **no-orphan guard** (`:239-289`) — every `src/*.ts` file's
  basename must appear in some `from '…'` import across `src/` (a test import does **not** satisfy
  it). New src modules must be wired into the src import graph, not only referenced by tests.
- **knip** dead-code gate (`knip.json`): flags unused exports; `ignoreExportsUsedInFile: true`. Every
  new exported symbol must be imported by an entry (test) or another src file.

---

## Phase 0 — Implementation Spec

### (a) The chat / ghost / execution ROLE abstraction

**Concept.** A `Role` is a *logical* lane — `'chat' | 'ghost' | 'execution'` — independent of
provider. It answers "which of the models the user actually has should serve this lane, and at what
reasoning depth?" It is a thin layer **over** the existing tier machinery, not a replacement:

- `chat` → the strong conversational/understanding model (maps to a strong tier rung).
- `ghost` → the fast throwaway model for self-correcting ghost text (cheapest fast rung).
- `execution` → the model that does build/edit work (mid/strong rung depending on mode).

**Resolution + graceful collapse (principle #8).** Given the user's *available* (provider →
concrete models) map plus tier hints from the capability registry, a role resolves to a
`(provider, model)`:

1. Build, per provider, the rung ladder from `availableModels` ordered by `tierHint`
   (manager>ic>worker), reusing the registry facts that already exist.
2. Map each role to a *desired rung* (mode-relative, see (b)).
3. Pick the best `(provider, model)` for that rung from what exists.
4. **Collapse rule:** if a provider exposes only ONE model, every role resolves to that one model.
   If the user has only ONE provider, all roles stay on that provider. If a desired rung has no
   model, step **down** to the nearest available rung (never invent a model, never error). A
   1-provider/1-model setup therefore yields chat = ghost = execution = the single model — proven by
   a dedicated degradation unit test. Quota on such setups is protected by frequency/local-first
   (per the plan), never by a (non-existent) downgrade.

**Purity.** All of the above is a pure function over plain data (`{provider, models[]}` + registry
tier hints + mode), no I/O, living in `src/core/roles.ts`, unit-tested. It deliberately **reuses**
`Tier`, `ReasoningEffort`, `Mode`, and `ModelCapability` rather than introducing parallel types.

### (b) Mode dial → (model rung per role + normalized reasoning effort)

A pure mapping `roleProfileForMode(mode, role) → { rung: Tier; effort: ReasoningEffort }` that is
**provider-relative at the edge but normalized in the middle**:

- The internal `ReasoningEffort` scale (`'none'|'low'|'medium'|'high'|'xhigh'|'max'`) is the single
  normalization target — already defined. OpenAI/Grok `reasoning_effort` (low/med/high…) and
  Anthropic adaptive-thinking/budget both project onto it at the **adapter** layer (existing
  `ProviderRequest.reasoningEffort` seam, `resolveSupported` step-down). The role layer emits the
  normalized effort; the adapter owns the provider-relative dialect (already true for Codex;
  Claude/Grok wiring is a later slice, not this one).
- Rung-per-role by mode (initial table, mirrors `baseDesiredEffort`'s envelope so the two never
  disagree): chat ≈ strong rung (ic→manager as mode rises); execution ≈ ic (manager under Max);
  ghost ≈ worker always. Effort-per-role by mode reuses the SAME ladder shape as
  `baseDesiredEffort` so a future unification is mechanical.

This slice ships the mapping + resolution **pure functions and their tests only**. It is wired behind
a default-OFF flag and is **not consumed by `orchestrate`** yet (see "Built in this slice").

### Built in this slice (PR: provider-substrate role abstraction)

- `src/core/roles.ts` — pure: `Role` type, `roleProfileForMode`, `rolesForMode`, `resolveRole`,
  `resolveAllRoles`, plus the `RoleResolution` / `ProviderModels` data shapes. No I/O.
- `src/interface/ui/role-flag.ts` — pure default-OFF predicate `roleMappingEnabled(env, config)`
  matching the verify/board flag shape (`MYSHELL_ROLES` ∈ {1,true,on,yes} OR
  `config.experimentalRoles === true`).
- `config.experimentalRoles?: boolean` on `AppConfig` (default absent → OFF).
- `OrchestrateDeps.roleMapping?` — a purely-additive, **never-read** optional seam (like the existing
  `goalId` multi-goal seams). Off → field absent → byte-identical. `orchestrate` does not consume it
  in this slice; the field exists so the flag wires through the src import graph (no-orphan) and so the
  next slice has a landing pad.
- Tests: `test/unit/roles.test.ts` (mapping table, multi-provider resolution, **single-provider /
  single-model degradation**) and `test/unit/role-flag.test.ts` (opt-in truth table + OFF default).

### Phase 0 — Implementation Spec (slice 2): the 5-level firepower dial

**The locked model (final).** Five user-facing levels — **Budget / Balanced / High / Max / Auto**,
with **Auto the DEFAULT** — layered OVER the existing `Mode` / `POLICY_PRESETS` machinery rather than a
parallel system:

- **Budget** — cheapest models, low/no reasoning effort, local-first, **NO agent recursion**.
  `≈ cost-saver` policy (no panel/hedge); default Intensity 1; base effort `low`.
- **Balanced** — mid models, medium effort, standard verification. `≈ balanced` (DEFAULT_POLICY);
  Intensity 3; effort `medium`.
- **High** — strong models, high effort, thorough review. A **NEW mid-high rung**: the quality-first
  escalation/review envelope but with a **narrowed 2-provider panel** (vs Max's 3); Intensity 4;
  effort `high`.
- **Max** — strongest models, **cross-provider deliberation** (the existing panel + hedge + review
  machinery fully on, ≤3 providers), deepest effort. `≈ quality-first`; Intensity 5; effort `max`.
- **Auto (smart)** — per-task: no fixed mode/policy of its own. The difficulty that drives Auto is a
  **byproduct of the turn the user is already having** (principle #1 — no separate classification
  call). `resolveLevel` is the clean seam for that byproduct (`AutoDifficulty` →
  `levelFromAutoDifficulty`); until the byproduct emission lands (a later phase), Auto falls back to
  the existing heuristics — the persisted legacy `config.mode` (migrated) then the plan-derived auto
  mode, mirroring today's `config.mode ?? resolveAutoMode` precedence, with a `balanced` safety net.

**Mapping onto the existing machinery (no parallel system).** All of the above is a set of PURE total
functions in `src/core/mode-levels.ts` that REUSE `Mode`, `Policy` (built FROM `POLICY_PRESETS`),
`Intensity`, and `ReasoningEffort` — `levelToMode`, `policyForLevel`, `defaultIntensityForLevel`,
`baseEffortForLevel`, `allowsAgentRecursion`, `profileForLevel`, plus the Auto seam (`resolveLevel`,
`levelFromAutoDifficulty`) and the backward-compat `migrateMode`.

**Intensity folds UNDER the level.** Each level sets a sensible default Intensity (1/3/4/5; Auto →
`'auto'`). Intensity remains only as an optional power-user override, not a primary dial.

**Roles stay internal/auto-derived** (slice 1) — not user-facing.

**Backward compat.** Persisted `config.mode` values migrate: `cost-saver→budget`,
`balanced→balanced`, `quality-first→max` (the strongest old stop; High is genuinely new), absent →
`auto`.

#### Built in this slice (PR: 5-level dial over existing policy)

- `src/core/mode-levels.ts` — pure: `Level` type, `ALL_LEVELS`, `isLevel`, `LEVEL_DESC`/`levelLabel`,
  `levelToMode`, `policyForLevel`, `defaultIntensityForLevel`, `baseEffortForLevel`,
  `allowsAgentRecursion`, `LevelProfile` + `profileForLevel`, `migrateMode`, the `AutoDifficulty`
  seam + `levelFromAutoDifficulty`, and `resolveLevel`. No I/O.
- `src/interface/ui/level-flag.ts` — pure default-OFF predicate `levelDialEnabled(env, config)`
  matching the role/verify flag shape (`MYSHELL_LEVEL_DIAL` ∈ {1,true,on,yes} OR
  `config.experimentalLevelDial === true`; rollback forces off).
- `config.experimentalLevelDial?: boolean` on `AppConfig` (default absent → OFF).
- `OrchestrateDeps.levelProfile?` — a purely-additive, **never-read** optional seam (mirrors
  `roleMapping`). Off → field absent → byte-identical. `orchestrate` does not consume it; the live
  route still reads `config.mode`/`effectiveMode` exactly as today. The field exists so the level
  substrate wires through the src import graph (no-orphan) and so the next slice has a landing pad.
- Tests: `test/unit/mode-levels.test.ts` (mapping table per level, Intensity-under-level, migration,
  Auto byproduct seam + heuristic fallback, single-provider/single-model still resolves a level) and
  `test/unit/level-flag.test.ts` (opt-in truth table + OFF default).

**NOT in this slice (deferred):** the level selector UI, live consumption in `orchestrate`/`route`
(so the level *demonstrably* picks models/effort), and the Auto byproduct emission itself. This slice
lands the pure substrate behind the default-OFF flag only.

### Remaining Phase 0 slices — NOT yet built (specced, deferred)

1. **Capability normalization + structured-output parse fallback.** The single biggest "works on any
   provider" risk (plan Phase 0). Emit structured byproduct (intent + routing + draft) with a robust
   parse-from-text fallback for providers with weak/odd structured-output support. *Not started.* The
   capability *fact* layer exists (`model-capabilities.ts`, Layer 1/2); the *parse-fallback* does not.
2. **Ledger groundwork for role/effort attribution.** Storage + `reasoningEffort`/`taskKind` columns
   already exist (`types.ts:188-201`, `infra/ledger.ts`). The deferred work is attributing spend
   **per role** and surfacing it (feeds Phase 6). *Not started.*
3. **Live wiring of roles into `orchestrate`/`route`.** Making the dial *demonstrably* pick
   role-resolved models + effort across providers (the Phase-0 "Done when"). The pure substrate is
   landed behind a flag; consuming it in the live path is a later slice.
4. **Live wiring of the 5-level dial + the level selector UI.** Consuming `levelProfile` in the live
   path (so the chosen level actually sets the policy/effort/intensity per turn), the Settings/menu
   selector that writes the level, and the Auto byproduct emission that feeds `resolveLevel`. The pure
   mapping + flag are landed (slice 2); live consumption + UI are the next slice.

### Open design questions (need the lead's decision — left unresolved on purpose)

- **Q1 — Dial arity. RESOLVED (slice 2).** The user-facing dial is the **5-level** Budget / Balanced
  / High / Max / Auto, with Auto the default — layered OVER the existing 3 modes (Budget≈cost-saver,
  Balanced≈balanced, **High = a new mid-high rung**, Max≈quality-first + full panel, Auto = per-turn).
  We did NOT invent a parallel policy system: `policyForLevel` builds every level's policy FROM
  `POLICY_PRESETS`. Intensity folds UNDER the level (a per-level default + optional override).
  Persisted `config.mode` migrates via `migrateMode`.
- **Q2 — Role vs the dials. RESOLVED (slice 2).** Roles stay internal/auto-derived; they are NOT a
  user-facing axis. The user tunes the single 5-level dial; roles resolve from the effective level's
  mode under the hood (slice 1 substrate). No user-facing role setting was added.
- **Q3 — Ghost provider preference.** "ghost = fastest model the user has" needs a *speed* signal.
  `costSpeedTier` exists on `ModelCapability` but is `unknown` for almost everything (the
  unknown-is-absent invariant). Until a real speed signal lands, ghost falls back to the
  worker-tier rung (cheapest), which is a reasonable proxy but not literally "fastest". Confirm that
  proxy is acceptable, or specify the speed source.
- **Q4 — Claude/Grok effort wiring.** Both declare an `--effort` ladder, but only Codex's adapter
  currently maps `reasoningEffort` to a flag. Promoting Claude/Grok to honor it is a behavior change
  to live runs and is deliberately OUT of this scaffolding slice. Confirm before wiring.
