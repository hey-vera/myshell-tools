# Changelog

All notable changes to **myshell-tools** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.65.0] - 2026-06-10

### Added (elite planning-partner build — verified-done, the anti-fabrication backbone)
- **A goal can no longer be "done" just because the model said so** (behind
  `MYSHELL_TRULY_COMPLETE`, default off). When a goal loop signals completion, the
  partner now runs a real verification first (the existing test/build engine's honest
  4-state) over the goal's actual changes and marks it **done only when the evidence
  says passing/reviewed**. Failing, unverified, or an empty diff (nothing to verify) →
  **not done** — the goal stays open with an honest receipt ("tests failing" / "no code
  change to verify"). The verdict can only be built from a real verification outcome,
  never from the model's claim; an evidence-only store write path persists it; the board
  shows the honest verdict (✓verified / ~reviewed / ✗failing / ⚠unverified). Fail-soft
  (a verify error → unverified → not-done, never a fake pass) and byte-identical when off.



### Added (elite planning-partner build — whole-picture understanding pass)
- **Before staging goals, the partner now builds a real understanding of the situation**
  (behind `MYSHELL_UNDERSTANDING`, default off): a manager-tier, read-only pass that
  investigates the actual codebase (modules, conventions, real constraints, open
  questions) and — for high-stakes work (auth/payments/deploy/production, via the
  existing risk classifier) — researches current best practice via the provider's native
  web search. The resulting system model grounds the planner so staged goals reflect
  expert, whole-picture depth instead of a surface parts-list. Honest (never fabricates
  modules or citations — omits what it can't determine; open questions can drive the
  clarify path), fail-soft and non-blocking, and byte-identical when off.



### Added (elite planning-partner build — the planning brain, auto-stage)
- **The partner now judges your conversation and auto-stages real goals** (behind
  `MYSHELL_AUTO_GOAL`, default off). When you describe substantial work, a manager-tier
  pass — led by the product-vision/quality-bar persona — decomposes it into one or more
  professional goals, each with a to-do list, and **stages them as parked goals on the
  board** (non-destructive; nothing auto-runs). When it's ambiguous/high-stakes it asks a
  sharp clarifying question instead; a trivial message ("sounds good?") stages nothing and
  never even pays for a model call. Runs post-reply, non-blocking, fail-soft — the chat is
  never delayed; honest (never fabricates a goal from a non-substantial turn; staged goals
  show truthful 0/N to-dos). Flag-off is byte-identical (orchestrate untouched).



### Added (elite planning-partner build, Phase 2b — living-plan to-do CRUD)
- **You can now manage a goal's to-do list directly**: `/todo add <g> <text>`,
  `/todo edit <g> <n> <text>`, `/todo move <g> <n> <to>`, `/todo rm <g> <n>`. All local
  (no model call), atomic + locked like the rest of the goal store.
- **The to-do list is now editable infrastructure** (the foundation the upcoming
  auto-planning + manager phases build on): the store gained add/update/reorder/remove,
  all keyed by stable to-do id (never array position) so edits never orphan a to-do's
  identity. Honest audit trail: a **verified-done** to-do is retained on remove rather
  than silently deleted, and `update` cannot write a verdict (verdicts are evidence-only,
  written by the verification phase — never hand-set).



### Added (foundation — the elite planning-partner build, Phase 1+2)
- **A real, persistent goal board** (behind `MYSHELL_BOARD`, default off): replaces the
  per-turn "GOALS ▸ <your message>" card that flashed and vanished every turn. The board
  is sourced from the actual goal store, shows each goal with its to-do progress · state ·
  scope · live agent count, and **persists across turns** instead of being a throwaway
  label on the current turn. With the flag on, the live turn region shows honest "WORKING"
  status (tier/agents), never your raw message dressed up as a goal. Default-off path is
  byte-identical to today.
- **"Truly complete" data model**: each to-do can now carry an explicit
  `acceptanceCriterion` (definition of done), an evidence-backed `verdict`
  (unverified/reviewed/passing/failing — never hand-set by a model), and a best-approach
  record; goals carry a goal-level acceptance check. Additive and defensively capped — no
  behavior change yet; later phases wire verification to enforce that "done" means
  *verified* done, not claimed.



### Fixed
- **Goals are now written by a smart model, like a senior engineer would** — the real
  fix for "it made the goal whatever I typed." 3.52.0 made the conversation *recap*
  smart but left the GOAL OBJECTIVE on the old path: explicit `/goal <text>` used your
  raw text verbatim as the goal/title/contract-objective, and auto-engage formed the
  label with the cheapest (worker-tier) model. Now every goal-label path — `/goal`,
  auto-engage, timeout-chunk, keep-going, and promote — forms the objective with a
  **manager-tier model led by the product-vision/quality-bar persona** (`ELITE_VOICE`),
  producing a crisp professional objective and never an echo (e.g. a rambly "2010
  youtube but better in rust for millions" becomes "Rust video platform — 2010-YouTube
  reimagined for millions"). The full text still drives the work; only the
  objective/title is the smart concise form. Fail-soft with a tight 6s timeout so it
  never blocks goal start; reuses the subscription provider machinery (no API keys).
  Validated live against the real model.

## [3.59.0] - 2026-06-09

### Fixed
- **No OAuth refresh storm on a malformed token response** — a 200 with no/zero
  `expires_in` used to write an instantly-expired token and clear the cooldown, so
  every launch re-refreshed. It's now treated as a failed refresh (cooldown applies).
- **Resume tells you when older turns fall out of the model's context** — long threads
  silently fed the model only a recent window while showing the full scrollback. Resume
  now prints a one-time dim note when older turns are outside the model's window, so you
  know it isn't seeing everything above.
- **"Today: N provider calls"** — the menu count includes internal sub-calls (reviewers,
  diff critics, poll candidates), so it's relabeled from "calls" to "provider calls" to
  be honest about what it counts (it was never your turn count).
- Pruned the unbounded interrupt-timestamp array (memory hygiene on long sessions).

## [3.58.0] - 2026-06-09

### Fixed
- **Local commands work before you sign in** — `/memory`, `/forget`, `/goals`, `/todo`,
  `/remember` run entirely locally, but the no-provider gate sat in front of them, so
  they printed "No signed-in provider yet" and did nothing. The gate now sits just
  before the model path, so local commands work unauthenticated while anything needing
  a model still gates.
- **Expired Claude session tells you what to do** — when the OAuth refresh token is gone
  (a true re-login is required), startup now prints an actionable one-liner naming the
  login command instead of silently proceeding to a later "not signed in".
- **`/todo` and `/goals` now tab-complete** — both were dispatchable and in `/help` but
  missing from completion.
- **The Usage screen (`[$]`) can't crash the menu** — a non-ENOENT ledger read error
  (e.g. a permission/IO issue) now fails soft with a note instead of escaping and
  taking down the menu.
- **`[m] Change mode` is now listed in the menu** — the handler existed but wasn't
  shown, so it was only reachable via Settings or `/mode`.
- **Honest total cost across cross-vendor turns** — `final.totalCostUsd` excluded the
  spend of a judgment poll or rival tribunal (it could even report 0 after real calls).
  It now sums prior cross-vendor cost (additive/optional — no behavior change when no
  poll/tribunal ran). Latent today (the token display reads the ledger, which was
  already correct), fixed for any future consumer of the field.

## [3.57.0] - 2026-06-09

### Fixed
- **No more duplicated/garbled blocks when the input box grows** — the word-wrap added
  in 3.53.0 let the composer wrap to more physical rows than the layout planner had
  reserved, which could push the live region past the viewport and re-trigger the
  scrollback-duplication glitch the planner exists to prevent. The planner now measures
  the composer's TRUE wrapped height and shrinks the stream/status region to fit, so the
  dynamic region never overflows; an extreme paste scrolls the composer to keep the
  caret visible. (Residual edge: a single unbroken line longer than the whole viewport
  can still spill a couple rows — caret stays visible by design.)
- **Long single turns stay snappy** — the live prose buffer grew without bound within a
  turn and was re-wrapped in full on every ~40ms flush. It's now capped to the visible
  tail (the complete prose is still committed to the transcript intact), removing the
  latency/memory creep on very long replies.
- **Menu chrome can't overflow into an active turn** — the menu's live frame is now
  subtracted from the layout budget so it can never coexist with a painting turn and
  blow the viewport.

## [3.56.0] - 2026-06-09

### Fixed
- **Clarifying questions are now saved to the conversation** — when the assistant
  asked you a question, the turn was stored with an EMPTY body, so on resume you saw
  your reply but not what was asked, and on the next turn the model had no record of
  its own question (it answered your reply blind). The question + options are now
  persisted as clean plain text, so resume shows it and the model remembers what it
  asked. (This is the adaptive partner's core "ask a sharp question" path.)
- **Canceling a turn mid-stream no longer leaves a phantom half-answer** — on ESC the
  partial reply was shown but never saved, so the on-screen transcript silently
  diverged from the stored conversation (and a truncated, abandoned answer could
  pollute the next turn's context). Now a canceled turn drops the uncommitted partial
  cleanly — screen, store, and resume all agree — matching the brain-loop cancel path.
  Applied consistently across the Ink and legacy renderers.

## [3.55.0] - 2026-06-09

### Fixed
- **Settings no longer silently erase other config keys** (data-loss bug). Each
  Settings toggle rebuilt the config from a hand-listed allow-list and the file was
  blind-overwritten, so any key not in that list was permanently dropped on the next
  toggle — including `codebaseAwareness` (the privacy kill-switch, which would
  silently flip back ON), dismissed first-touch hints (`seen`), and every config-set
  `experimental*` flag. Every setter now spreads the full prior config and changes
  only its one field; clears omit the key cleanly (no `undefined`). Found via a
  multi-agent audit.

## [3.54.0] - 2026-06-09

### Fixed
- **Clarifying-question pickers and `/edit` prompts are now visible** — on the Ink
  TUI the action cue ("Pick one, or Enter to skip:", "Type your answer:", "Pick a
  number…", "New message…") was written without a trailing newline, so it sat unseen
  until you submitted — you were parked at a blank composer not knowing a picker was
  waiting. The Ink `readLine` now flushes pending output before reading (the same
  pattern key-confirm already used), so the cue shows while you decide.
- **Resume is instant again** — "Continue / Resume" awaited the recap model call
  before enabling input, so it could stall up to 8s before you could type (the 3.52.0
  manager-tier recap made this heavier). The composer now goes live immediately and
  the recap resolves concurrently, printing the `※ recap` line when ready; a guard
  suppresses a late recap write if you've already left the conversation (its side
  effects — stored recap + smart title — still complete).
- **Turn-end line no longer claims "· 0 tokens"** — when a turn reports no usage, the
  completion line now reads `✓ done` / `✓ done · 3s` instead of `✓ done · 0 tokens`,
  matching the honesty already enforced on the live status surfaces (mirrored across
  the Ink and legacy renderers to preserve run-stream parity).

## [3.53.0] - 2026-06-09

### Fixed
- **The chat input box now word-wraps** — long messages were hard-truncated with an
  ellipsis at the box width, so you couldn't see what you were typing. Now a long
  line soft-wraps within the box and the bordered composer grows vertically; the
  `❯` caret stays on the first row and wrapped continuation lines indent under the
  gutter (no repeated caret). (Up/Down still step `\n`-delimited logical rows, not
  visual wrapped rows — no cursor-glyph change.)

## [3.52.0] - 2026-06-09

### Fixed
- **Conversation titles & recaps are now written by a smart model, like a senior
  engineer would** — the third pass at "it made a goal of what I typed." The two
  prior fixes patched the autonomous `/goal` path, but a normal chat never touches
  it: the Recent-card title was a raw `.slice(0,80)` of your first message (later a
  regex clause-slice of a recap), and the dim state line was a **worker-tier** (cheapest
  model) recap that routinely parroted the assistant's last reply. Now ONE
  manager-tier pass, led by the product-vision/quality-bar persona (`ELITE_VOICE`),
  writes BOTH a professional **title** (a crisp objective that names the actual
  project — never an echo, no "we/this conversation" preamble) and an honest **state**
  line (what's done + the next step — never a parrot of the last message).
  - Reuses the existing provider/route machinery at the manager tier (subscription
    OAuth — no API keys, no metered calls). Fail-soft: an unparseable reply falls back
    to prior behavior, never crashes. Cost stays bounded — the existing staleness
    (every ≥3 turns) and quota-shed gates are preserved, so the manager call is
    infrequent, and one call produces both title and recap.

## [3.51.0] - 2026-06-09

### Fixed
- **Claude replies now stream live, word-by-word** — the biggest "I can't see it
  happening" gap. The Claude provider was spawned without `--include-partial-messages`
  and the parser only handled complete `assistant` messages, so a whole reply landed
  as one block at the end (after a silent "Thinking…"). Now the CLI streams raw API
  token deltas (`stream_event`/`content_block_delta`/`text_delta`) and the parser
  emits one `text` event per delta — prose paints as the model writes it.
  - De-doubled cleanly: visible prose is built entirely from `text` deltas, so the
    redundant per-block `assistant` text event is no longer emitted (the `assistant`
    event still owns `tool_use` → tool events). Thinking/signature deltas are not
    surfaced as prose. Stateless, fixture-verified (`claude-parse` contract suite).
- **Claude tool actions now show a target** — a `tool_use` block's `input` yields a
  live-action `detail` (`file_path`/`path`/`command`/`pattern`), so the status line
  reads "editing src/auth/mw.ts" / "running …" instead of a bare verb. Claude now
  matches codex/opencode, which already supplied a target. Fail-soft: omitted when no
  recognizable field is present.

### Pending
- Cross-OS CI execution (requires a public remote).
- Installer: PowerShell-Core profile support + PowerShell interactive guard; don't
  overwrite an existing `cm`/`mst` alias — deferred (niche / minor).
- update-check: use semver precedence for prerelease→stable (no prereleases shipped today).
- Work Contract: cross-turn / cross-session contract seeding (Stage 5) — re-seed a
  resumed goal's contract from the persisted `workTrace` (niche: the in-run contract
  is already kept in memory; only cross-session resume benefits). Optional.

## [3.50.0]

### Fixed — the menu paints instantly: first-paint no longer blocks on disk

- **Launch is now instant.** `startMenu` previously awaited reading the unbounded spend
  ledger (+ token-capture date + conversation/goal lists) BEFORE drawing the first frame,
  so the menu felt slow to appear and worse as the ledger grew. Now the full menu skeleton
  — header, banners, the action menu, the prompt — paints synchronously with `Loading
  usage…` / `loading…` placeholders, and the spend sum, token date, and lists fill
  asynchronously (in parallel), repainting in place via the existing single-dispatch frame
  path. The unbounded ledger is never on the first-paint path again.
- **Accuracy preserved**: `summarizeSpend` still reads the full ledger (no truncation) —
  just off the first-paint path. Fills are fail-soft (errors degrade to "—", never crash).
- **Safely gated**: the paint-first behavior applies only on the Ink live-region sink; the
  legacy/stdout path keeps its exact prior byte output, and a guard prevents a late fill
  from repainting over an active sub-flow. (Completes the deferred follow-up from 3.48.0.)

## [3.49.0]

### Changed — see everything happening: live-action status, honest tokens, no clutter

- **Lead with the live action.** The status line and the running agent row now show what's
  actually happening right now — "editing src/auth/mw.ts", "running tests", "searching" —
  by capturing the active tool's name (and target, when the provider supplies one) that was
  previously thrown away. Falls back to the real "Thinking" when no tool is active. A
  friendly verb map (Edit/Write→editing, Read→reading, Bash→running, Grep/Glob→searching)
  keeps it scannable; unmapped tools show their raw name — never invented.
- **No more fabricated token number.** The live "↓ ~N tokens" was a character-count proxy
  (`streamedChars ÷ 4`), not real usage — and for the Claude subscription there is NO
  mid-stream token data at all. Removed it. Real tokens now appear ONLY where genuinely
  known: the agent/goal rows after their tier completes, the turn summary once > 0, and the
  final "✓ done · N tokens". Mid-run shows the work, not a fake count.
- **Less clutter.** The redundant turn-summary line ("▸ 1 goal · 1 agent · …") no longer
  renders for a single goal — it only appears when there are multiple goals to aggregate.
- `currentTool` is live-status state only (never enters the committed transcript), so the
  run-stream parity contract holds.

## [3.48.0]

### Fixed — the TUI feels instant: render-performance pass (no visible change)

- **The live UI no longer gets laggier the longer a turn runs.** Root cause: the layout
  planner ran twice per render, and an 80ms spinner/elapsed interval re-rendered the
  entire Ink tree (recomputing layout over a growing buffer each tick).
- **Single memoized layout pass** — `AppBody` computes the layout once in a `useMemo`
  keyed on real content inputs and threads it to `StatusBlock` as a prop (the duplicate
  second pass is gone). The 80ms braille spinner moved to its own leaf component, so a
  frame tick repaints one line instead of the whole tree; elapsed seconds recompute at
  1Hz. `Panels` is now memoized.
- **Tool-event coalescing** — bursts of tool-call step-count bumps flush through the same
  scheduler seam as prose, batching into one re-render instead of one per tool call.
- **No per-keystroke disk reads** — the menu loop's conversation + parked-goal lists are
  now cached behind a dirty flag (mirroring the spend cache), so a plain keypress reuses
  them instead of hitting disk twice.
- Rendered output is byte-identical at any frame (pure structural change); ui-layout +
  run-stream parity + smokes all green. (Deferred follow-up: paint a menu skeleton before
  the spend/ledger reads so first-paint is instant too.)

## [3.47.0]

### Fixed — smart goal titles: a concise objective, not your raw chat text

- When chat auto-engages a goal, the goal title/objective is now a **concise,
  professionally-formed goal** (e.g. "Build out the frontend skeleton") instead of the
  user's raw verbatim message ("so yea i think the frontend is a decent skeleton to build
  into, so yea…"). It reuses the existing cheap worker-tier intent extractor to form the
  label, falling back deterministically (`deriveGoal` → raw text) and never blocking —
  the extractor is skipped entirely when the intent engine is off or under quota pressure.
- The concise label drives only the displayed title + the work-contract objective; the
  **full raw message still drives the actual work** every turn (intent is never lost).
- `src/core/goal.ts` gains the pure, tested `formConciseGoalLabel(frameGoal, rawText)`;
  `runGoalLoop` now threads a separate `goalLabel` from the work task.

## [3.46.0]

### Changed — the intelligence is ON by default: automatic, frictionless

- **The full intelligence now ships ON by default** — no env vars, no flag-flipping. The
  Governor, the verification ladder, learned taste, the plural judgment poll, the trust
  surface, and the Rival Tribunal all engage automatically. The Governor is the
  always-on spine that keeps this safe: it caps per-turn spend, auto-adapts the budget to
  your subscription tier, and admits the expensive cross-vendor levers only when they're
  warranted — so default-on is disciplined, not reckless. Cross-vendor features (poll,
  tribunal) need ≥2 vendors connected and otherwise degrade honestly to single-vendor.
- **`src/interface/ui/experimental-default.ts`** — the composition-root resolver
  (`experimentalEnabledByDefault`). Priority: explicit per-feature opt-IN
  (`MYSHELL_X` ∈ {1,true,on,yes} / `config.experimentalX === true`) wins — ON even in
  basic mode; then global basic mode → OFF; then explicit opt-OUT (`MYSHELL_X` ∈
  {0,false,off,no} / `config.experimentalX === false`) → OFF; absent → ON. It composes
  the existing pure opt-in helpers, so they stay production-used (no orphan, no weakened
  guard).
- **Escape hatches**: disable any single subsystem with `MYSHELL_<NAME>=0` (or
  `config.experimentalX: false`); disable them all at once with `MYSHELL_BASIC=1` (or
  `config.experimentalBasic: true`) for a plain run.
- The concurrent multi-goal scheduler (`MYSHELL_SCHEDULER`) remains OPT-IN — it is a
  quota multiplier, not a single-turn intelligence lever.
- Flag-OFF neutrality intact: the opt-out path is byte-for-byte today's behavior
  (characterization + oracle suites unchanged), so basic mode is a clean escape hatch.

## [3.45.1]

### Changed — all-flags-ON composition audit: honesty fix + regression guard

- **Auditable-reasons honesty**: on a budget-starved risky/repo turn the Governor could
  record that "the critic took this turn's cross-vendor unit" in a refusal reason even
  when the critic did not ultimately fire (the oracle had taken the last unit). Reworded
  the two affected reasons to state the critic's *domain/priority* ("this diff turn
  belongs to the diff-scoped critic; verification has priority") — true regardless of
  final budget. Behavior unchanged; only the audit-trail string is now accurate.
- **`test/unit/governor-composition.test.ts`**: a new exhaustive sweep (every shape ×
  mode × vendor-count × pressure) pinning the all-flags-ON invariants — the
  `levers.length <= turnCallBudget` hard cap, {critic, poll, tribunal} mutual exclusion,
  no cross-vendor lever below two vendors, and cost-saver opening no paid lever. Locks
  down the composition an integration audit verified safe.

## [3.45.0]

### Added — the Rival Tribunal: cross-vendor build-off, flag-off

- **The Rival Tribunal** (`src/core/tribunal.ts` + `src/infra/worktree.ts`): on a
  genuine load-bearing implementation fork, two rival vendors each build a REAL diff in
  their own isolated git worktree; the tests-first ladder culls a failing build, each
  rival's diff is cross-red-teamed by the OTHER vendor (reusing the diff-scoped critic),
  and the brain adjudicates an honest winner — or `chosen=null` when there is no clear
  one. Never fabricates a second rival, never claims a winner without real test verdicts.
- **Honest single-vendor degradation**: with fewer than two authed vendors (or a dirty /
  non-git tree) there is no rival — the turn falls through to the normal single build +
  verification ladder and says so. The tribunal lever sits in the Governor's `locked`
  set, never granted.
- **Governor-gated as the most expensive lever**: `tribunalAllowed` is granted only on a
  substantial repo-oriented decide fork, with ≥2 vendors, off cost-saver, and enough
  budget (the Max-tier allowance) — mutually exclusive with the judgment poll and the
  critic over the one cross-vendor unit. The two cross-vendor decision levers are now
  disjoint by domain (poll weighs pure decisions; the tribunal builds implementation
  forks), so enabling the Governor no longer preempts the tribunal.
- **Worktree safety**: a fresh worktree symlinks `node_modules` from the main tree and
  NEVER runs `npm install` (the package-firewall lockfile gotcha); both worktrees are
  torn down in a `finally`, including on abort.
- **Flag** `MYSHELL_TRIBUNAL` / `config.experimentalTribunal` (default OFF). Tests use
  fake vendor builds + fake worktree/verify ports — zero live model calls; the one
  real-git test runs in a throwaway tmp repo.
- Flag-off neutrality preserved: characterization + oracle suites byte-identical.

## [3.44.0]

### Added — the trust surface: auditable, honest "what just happened", flag-off

- **Trust receipt** (`src/core/trust-receipt.ts`): a pure composer that turns a
  finished turn into an auditable "what just happened" line. Confidence is grounded
  in a fixed, honest order — files actually changed, then the real test verdict, then
  the real cross-vendor agreement — never asserted from vibes. A self-audit names the
  gaps (what was not verified) but only fires when anchored to a real turn (at least
  one positive signal present), so an empty turn produces an empty receipt rather than
  a bare "didn't verify" line.
- **Flag** `MYSHELL_TRUST` / `config.experimentalTrust` (default OFF), mirroring the
  other experimental subsystems.
- 31 new tests pin the no-fabrication properties.
- Flag-off neutrality preserved: characterization + oracle suites byte-identical.

## [3.43.0]

### Added — plural judgment: the cross-vendor judgment superpower, flag-off
- On a genuine decision-fork (>=2 named options, non-trivial, a real fork), myshell can poll its independent vendor minds ONE SHOT, no cross-talk, and tally their structured choices deterministically into CONSENSUS / LEAN / SPLIT. This is NOT a debate/council (iterated argument flips correct answers) — it is bounded plural judgment: agreement = earned multi-perspective confidence, disagreement = a genuine fork surfaced to you.
- THE honesty inversion: there is NO synthesizer model run — the tally is pure, so the synthesizer is STRUCTURALLY incapable of resolving a real SPLIT (a split returns chosen:null and is surfaced with both sides reasoning). One lone mind is never consensus; a lean that agrees with you never manufactures a challenge; a verdict whose choice isnt a real option id is dropped (no hallucinated choices).
- Feeds an optional agreement dimension into the brain confidence tuple (consensus raises understanding with a real receipt — "the other models I checked independently agree"; split caps at medium and forces a surface; absent when no poll ran, never fabricated). Activates push_back poll_split: a SPLIT or a LEAN-against-your-approach becomes a grounded challenge.
- Reuses the panel internals verbatim (runCandidate/mergeCandidates/cost+ledger accounting parameterized, not duplicated). Governor-gated: granted only on decide/risky forks with >=2 vendors + budget room; poll and critic never both fire (plural judgment beats one strong author on a decision turn). Single-vendor: no poll — degrades honestly to the partner own judgment (push_back); the poll is surfaced as locked, never faked with one vendor.
- Flag-gated MYSHELL_JUDGMENT (the gated half of the judgment system push_back began), DEFAULT OFF = byte-for-byte today behavior (characterization + oracle byte-identical). Subscription-clean (reuses existing routing, no API keys), fail-soft (a poll error => no-poll + the existing flow).

## [3.42.0]

### Added — subscription-adaptive AUTO budget + real pressure threading (enriches the Governor, flag-off)
- The AUTO mode now sizes the Governor per-turn budget to the DETECTED subscription tier: Max plan -> full (budget 3, paid levers eligible), Pro -> balanced (2), Free -> conservative (1, Oracle vetoed). An unknown/undetected plan resolves to balanced (2) and is NEVER assumed Max. Single-vendor adapts to that one vendor plan; cross-vendor levers stay locked until 2 vendors. Reuses the existing detect.ts/policy.ts plan signals — no new probe, no new model call.
- Honest posture label (always-on display, pure projection of the same Mode the budget derives from, so it can never overstate): e.g. Mode: Max (auto - 1 Max 20x -> full), Mode: Efficient (auto - 1 Free -> conservative), (auto -> balanced) when undetected.
- Real pressure threading: the Governor budget now shrinks under genuine pressure (effectiveBudget = max(1, base - pressure)). REAL signal wired = rate-limit cooldown count (providers currently in 429 cooldown this session — the same signal shedding already consumes). Honestly still 0: token/quota headroom (subscription CLIs expose no quota readout — documented, never fabricated).
- All of this rides the existing MYSHELL_GOVERNOR / config.experimentalGovernor flag (no new flag). Governor OFF = byte-for-byte unchanged (governorPressure set only when ON; the characterization + oracle suites are byte-identical and pass). The honest mode label is pure display, independent of the flag.

## [3.41.0]

### Added — the free judgment layer: a partner with its own honest judgment, flag-off
- A new push_back brain move (sibling of reflect_confirm): the partner proactively CHALLENGES a planned move, but ONLY with a grounded, nameable cause — never generic hedging. Sources: (a) a correctness/irreversibility RED FLAG (the existing isIrreversible signal coincident with non-high understanding — about to do the hard-to-undo thing while still uncertain of the goal), and (b) a LEARNED-TASTE VIOLATION (the planned default contradicts the recorded taste playbook, naming both halves: you have preferred X here, this would do Y). The poll-split source is a later gated phase (extension point left). When no source grounds out, push_back STAYS SILENT — silence is the default.
- Activates the pushback_accept / pushback_reject taste signals that shipped inert in 3.39.0: when you accept or reject a push-back, that outcome is recorded, so the partner learns whether its judgment is trusted.
- Ask-calibration: the existing genuine-fork ask spine (hasGenuineFork/forkBudget/ASK_CAP) is reused verbatim — push_back is purely additive and never converts a proceed into an ask. The 3.30.0 calibration (trivial/medium fast-path, no nag) is preserved exactly.
- Flag-gated MYSHELL_JUDGMENT / config.experimentalJudgment, DEFAULT OFF = byte-for-byte today behavior (flag-on-with-no-reason deep-equals flag-off; the Phase-1 characterization + oracle suites are byte-identical and pass). No new model calls, subscription-clean.
- Honesty held: never manufactures a disagreement; push_back requires a real nameable reason or stays silent; never fabricates a taste violation (returns null unless it can point at the specific recorded call).

## [3.40.0]

### Added — the verification centerpiece: trustworthy "done", flag-off
- After a turn produces a code change, a graduated, honest verification runs in the work-call verifyStage and surfaces an honest four-state receipt: passing (real tests executed green) / failing / reviewed (a critic looked, no tests — weak signal) / unverified (nothing ran). It NEVER claims passing without tests that actually ran green; reviewed never reads as passing.
- Tests-first (FREE local exec, the strongest+cheapest signal, always before any model call): conservative test-command detection (package.json test script, or pytest/cargo/go when their manifest exists; nothing clear => honest unverified, never a fabricated pass), run via execa with a hard timeout, output captured, non-destructive, fail-soft (a crash => unverified, never a faked pass).
- Diff-scoped cross-vendor critic (the ONE paid lever, Governor-gated): buildDiffReviewPrompt reviews the actual DIFF + test output, not prose; routed to a DIFFERENT vendor via the existing pickReviewer; one critic max/turn; tests own pass/fail (critic annotates). Single-vendor: tests-first reaches real passing/failing with one vendor; the critic falls back to the same vendor LABELLED self-check (weak signal), never sold as cross-vendor.
- Activates the Governor verify lever (non-diff=>none, diff=>tests, high-stakes/risky diff + 2 vendors + budget=>tests+critic). Governor-off default policy (verify-policy.ts): tests-first floor, critic only on a large diff (>=5 files) with 2 vendors, never trivial.
- Flag-gated MYSHELL_VERIFY / config.experimentalVerify, DEFAULT OFF => verifyStage is the byte-for-byte no-op it was (the Phase-1 characterization + oracle suites are byte-identical and pass). Subscription-clean (critic uses existing routing, no API keys, no new deps).
- Honest gap: change-capture falls back to git diff HEAD (acceptEdits already wrote the files; the turn-scoped edited-files signal isnt tracked yet), so on a dirty tree the diff may be broader than this-turn-only; the port accepts an editedFiles arg for when that signal lands.

## [3.39.0]

### Added — learned-taste ledger (free judgment layer), flag-off
- The compounding moat: myshell now learns your taste from OBSERVED signals only (never inferred opinions). New src/core/taste.ts (pure: TasteEvent schema where source is structurally pinned to observed, distill -> {memoryBias, playbook}), src/infra/taste-ledger.ts (append-only JSONL via the same atomic primitive the cost ledger uses, 0o600, project-scoped via deriveProjectKey, fail-soft). Records fork choices + immediate rephrases today; the schema also covers push-back + accept-unchanged signals that activate when those (later) seams land.
- Feeds the real, previously-unfed EngagementSignals.memoryBias seam (a bounded +/-1 calibration, never a takeover) and injects a distilled LEARNED-TASTE block at prompt assembly (order: ENVIRONMENT -> TOOL-STATE -> MEMORY -> LEARNED TASTE -> WORK STATE -> INTENT -> ENGAGEMENT; explicit always beats learned).
- Flag-gated MYSHELL_TASTE / config.experimentalTaste, DEFAULT OFF = byte-for-byte today behavior (proven: the Phase-1 characterization + oracle suites are unchanged and pass). Subscription-clean (local JSONL, no deps, no embeddings, no metered calls). Honesty held: observed-only (the write boundary drops anything unvalidatable), project-scoped (a project fact never leaks to another repo), fail-soft (a corrupt ledger degrades to no-bias, never throws into a turn).

## [3.38.0]

### Added — the Performance Governor (the spine), flag-off
- A new pure src/core/governor.ts consulted once per turn at the admission seam, returning a typed AllocationPlan: the task SHAPE (quick/explain/build/investigate/decide/risky, from existing predicates), a hard tier-adaptive per-turn call budget (Free 1 / Pro 2 / Max 3, shrunk honestly by live pressure), and which levers to spend within it — chosen by expected quality-per-token, with an auditable reasons[] refusal/grant trail. Its anti-drift act is REFUSING wasteful levers against the objective.
- It COORDINATES the existing gates, never bypasses them: it can only make the tier request equally or more conservative; authorizeTier/admitManager still decide. Cross-vendor levers are marked locked and auto-unlock at 2 connected vendors (fully 10/10 single-vendor). Phase-2 active levers: model tier, depth, verbosity; verification/poll/tribunal/concurrency are reserved cells that later phases light up.
- Flag-gated MYSHELL_GOVERNOR (or config.experimentalGovernor), default OFF = byte-for-byte today behavior (orchestrate short-circuits before consulting it; proven by the unchanged Phase-1 characterization suite). Deterministic invariant tests pin: trivial=>budget 1/no escalation, levers<=budget, locked-never-chosen<2-vendors, pressure shrinks honestly.

## [3.37.1]

### Changed — internal: extract the work-call seam (behavior-preserving)
- Refactored orchestrate() so the per-attempt work-execution loop (route -> stream -> collect -> accept -> retry/failover) is now a cohesive, named runWorkCall stage in src/core/work-call.ts, with an explicit empty verifyStage slot reserved where Phase 3 verification will plug in. orchestrate.ts shrank 2249->979 lines. Admission gates (authorizeTier/admitManager/Oracle) keep their authority and run before the stage. Zero observable behavior change — pinned by 10 new characterization tests that pass identically before and after extraction. This is the seam the Governor + verification + judgment subsystems plug into.

## [3.37.0]

### Added — `myshell eval`: measure the partner's answer quality (the ruler)
- A frozen 20-prompt eval suite + a cross-vendor judge that scores the partner's real answers on 7 dimensions (understanding, judgment, clarity, proactivity, correctness, honesty, conciseness) — so quality is a tracked NUMBER, not a vibe. The judge runs on a DIFFERENT vendor than the one that answered (honestly falls back to same-vendor, labeled, when only one is connected); an unjudged prompt is recorded as such, never a fabricated score.
- Opt-in + cost-stated: `myshell eval` prints the cost (~40 model calls) and exits without spending; `myshell eval --yes` runs + stores a timestamped result; `myshell eval --compare` diffs the last two runs. Never auto-runs. Subscription-clean (your own provider seats, no API key, no metered eval service).
- This is the foundation the quality work is measured against, going forward.

## [3.36.0]

### Internal — plan decomposition + dependency-aware scheduling (default-off flag)
- The engine that turns a confirmed plan into several goals running concurrently: decomposes only when parts are genuinely independent (a single/sequential plan stays ONE goal, so concurrency never wastes quota), runs independent goals in parallel while dependents queue, blocks dependents of a failed prerequisite, and re-validates each goal through the brain. Behind the default-off experimental flag — no behavior change until you turn it on. Groundwork for the visible multi-goal experience.

## [3.35.0]

### Changed — big-picture moments now use your strongest model (the "Oracle")
- When a turn is genuinely substantial — a plan, an architecture call, a real explanation — its reasoning is now routed to the STRONGEST model you have admissible (e.g. Claude Opus), so the partner's most important thinking runs on the best brain you already pay for. You can see it in the live tier/agent display.
- Cost-disciplined: it only escalates on substantial turns (trivial/quick/everyday turns are byte-for-byte unchanged on the normal tier — zero extra cost), and it respects your Mode — Max escalates freely, Balanced only when the call is also high-stakes/uncertain, Efficient never. Degrades to the normal tier under rate-limit pressure or when the strong model is unavailable. No new model calls, subscription-clean.

### Fixed — friendly plan label in the banner
- The codex plan now shows a clean name (e.g. "codex: ready (Pro)") instead of the raw token slug ("prolite"). Known plans get a friendly label; unknown ones are title-cased. Read from local creds only, never fabricated.

## [3.34.0]

### Changed — the partner explains like an elite engineer, not a manual
- It now leads with the INTUITIVE point (what this means + why it matters, in plain language a non-expert gets) and then LAYERS the technical detail a dev needs — so backend wiring, dependencies, and long-term consequences actually LAND for anyone, while staying precise for experts. No more jargon lists.
- More PROACTIVE: it orients instead of just answering — connects the task to your larger goal, flags what you are about to get wrong before you hit it, and surfaces the non-obvious win you did not think to ask for, with a real point of view (not just a recommendation).
- An elite VOICE: "make a non-expert feel smart and an expert feel met" — warm because it is clear and candid, never because it flatters (brutal honesty preserved).
- The depth only kicks in when a turn genuinely warrants it; quick questions stay crisp and instant. All prompt-level — no new model calls, subscription-clean, and it never fabricates a file/fact/number to make an explanation tidier.

## [3.33.0]

### Changed — the partner asks + proposes like a senior engineer
- When it needs a decision, it now reasons in SOLUTION space first — it offers the 2–4 genuinely different WAYS to build the thing, each naming real files/areas with a one-line tradeoff and a recommended default (not a generic "build / debug / review" menu). Grounded in the actual repo; it never invents a filename it has not seen.
- When it proposes, it aligns proactively with a real plan: "I understand and I am aligned — here is my plan: 1) … 2) … 3) …. Go?" (still Go / Edit / No), instead of just echoing the goal.
- It surfaces its confidence in plain words ("fairly confident I understand this" / "still forming a view — let me look first") — never a fabricated number. Everyday and clearly-understood turns are unchanged and just as fast; this only enriches the moments it already asks or proposes (no new model calls — it reuses the same gated step, subscription-clean).

### Added — codex / opencode plan shown in the banner (when truthfully known)
- The banner now shows codex's ChatGPT plan when it is present in the local auth token (e.g. "codex: ready (pro)"), alongside claude's tier. Read from local credentials only — no API call, never fabricated; if a provider's plan is not in its local creds (e.g. opencode's key-based auth), it honestly stays "ready".

## [3.32.0]

### Added — parked goals & to-do lists
- Capture work you are NOT doing right now as a PARKED goal with its own to-do list. `/todo <text>` parks a goal; the menu shows a **Parked** section with each goal's to-do count (e.g. "Redesign feed · 3/8 to-dos"); `/goals` lists Active/Queued/Parked; `/goals show|go|drop` and `[g] Manage goals` let you view/check off/promote/remove. A to-do is always a step of a goal — nothing floats.
- **Promoting a parked goal re-validates it.** "Go" hands the goal to the adaptive brain (not the stored list), so a stale/changed to-do list is re-checked against current reality before anything runs — never executed blindly. To-dos are marked done only on real evidence, never inferred.
- Persists across sessions (per-project and global scopes), reusing the same hardened atomic/corrupt-recovery storage as memory.

## [3.31.0]

### Internal — bounded concurrent multi-goal scheduler (default-off flag)
- Landed the engine that will run several goals at once within your subscription's real ceiling (2–4 active, the rest queued), behind a default-off experimental flag — no live behavior change yet. It fans out ESC cancellation to all active goals, isolates a failing goal from its siblings, recovers concurrency after rate-limit cooldowns, and reports honest per-goal progress. Adversarially reviewed (caught + fixed a hang-on-ESC and a sibling-leak-on-throw) and proven not to hang or leak. The visible multi-goal experience (plan decomposition + confirm panel) builds on this next.

## [3.30.1]

### Internal — multi-goal display foundation (no user-visible change yet)
- Added the additive `goalId` event seam + state/render support for showing MULTIPLE concurrent goals (each with phase X/Y, agents, queued/running/done) and graceful collapse on small terminals — all proven byte-identical to today while there is still one goal per turn. Groundwork for the upcoming concurrent multi-goal scheduler.

## [3.30.0]

### Added — the partner thinks before it acts (adaptive confidence, Phase 1)
- myshell no longer turns every message straight into a goal and barrels into
  execution. It now assesses its **confidence** in understanding your request and
  adapts:
  - **Genuinely unsure + answerable from the code?** It investigates first —
    factoring in the project layout — then re-assesses, narrating honestly what
    it's doing (it does not claim to read files it didn't).
  - **A big / ambiguous build?** It reflects back the plan and asks "sound good?"
    *before* spending a turn executing.
  - **Everyday, clearly-understood requests (and quick questions)?** They flow
    straight through, exactly as fast as before — no extra step, no extra cost.
- It's adaptive, not a rigid gate: it only pauses or digs in when that genuinely
  helps; small clear tasks (even irreversible ones) just get done. Bounded
  (at most one investigation round in this phase), ESC-cancelable, and costs are
  reported truthfully.
- Foundation for what's next: deeper code reads, web research (Codex), and
  concurrent multi-goal orchestration build on this loop.

## [3.29.7]

### Fixed — snappy menu (no more creeping lag)
- The interactive menu redrew its full ~30-line screen into the **append-only**
  transcript on every keypress, so the rendered list grew unbounded and the menu
  got progressively laggier the longer you used it. The menu (and other transient
  chrome) now repaints in a bounded ephemeral region that's replaced in place, so
  navigation stays fast no matter how long the session runs. (The committed
  transcript and scrollback are unchanged; menus still linger above sub-flows.)

## [3.29.6]

### Changed — the live orchestration view is now legible (agents, not jargon)
- **Goals show what they're actually doing.** The cryptic `◐ ic` (an internal
  routing-tier id) is replaced by a real one-line goal title derived from your
  request (work-contract objective → intent → your message), with the tier + risk
  demoted to a dim `ic · medium` badge.
- **Agent-centric counters.** The status line now leads with how many agents are
  working (`1 agent` / `3 agents`, or "Waiting on N models" in panel mode) instead
  of the low-signal `29 steps` (kept as a dim "N tool calls" detail). Each agent row
  shows what it's doing (its live work label), tokens, and elapsed time.
- **A bottom summary line:** `▸ 1 goal · 4 agents · 9.4k tok · 22s`. When a request
  escalates through tiers it honestly reads "2 phases" (not inflated to "2 goals").
- **Graceful collapse** on short terminals (summarized to one agent-led line, or
  hidden with the count still on the status line) — never overflows the viewport.
- Counts are never fabricated: the agent number equals the real models in flight.
  (Today that's 1 sequentially, up to ~4 in panel mode — a true many-agent/parallel
  fan-out engine is a separate, future feature, not faked here.)

## [3.29.5]

### Fixed — new-user readiness sweep (first-run + in-chat)
- **First-run setup questions are now visible.** The Ink output only rendered text
  once a newline arrived, so the welcome prompts ("Install …? / Sign in? / pick a
  Mode / set default shell? / check for updates?") — written without a trailing
  newline — never showed, leaving a brand-new user pressing keys on invisible
  questions. The output now flushes any pending prompt before waiting for input.
- **No more garbled duplicate input box during a chat.** The chat loop was writing
  the *legacy* boxed prompt (raw cursor escapes) into the Ink screen every turn,
  stacking a broken box above the real composer. That write is now skipped on the
  Ink path (the real composer already renders the prompt).
- **"Sign in first" call-to-action.** When no provider is signed in, the menu now
  shows `⚠ Not signed in yet — press [j] Claude · [k] Codex · [o] opencode to get
  started`, and the empty-state line says "Sign in to begin" instead of inviting a
  chat that would just bounce to auth.
- **Immediate feedback when a turn starts.** The `⠋ Thinking…` status line now
  appears the instant you submit, instead of a multi-second frozen-looking gap
  before the first model event.
- **Report views don't vanish.** `[d] Diagnose` and `[$] Usage` now wait for a
  keypress before redrawing the menu, so the output is readable.
- **Raw provider session** ([r]) now says "Cancelled." (and shows `[Enter] cancel`)
  instead of silently returning on Enter.

## [3.29.4]

### Fixed — the menu now shows it's waiting for input
- Removing the composer from the menu in 3.29.3 left no input affordance — the menu
  ended with no prompt, so it read like finished output rather than something
  waiting for a keypress. The menu (and the auth/settings sub-flows) now show a
  minimal dim **`❯ press a key`** prompt. The full chat composer still appears only
  inside a conversation; on the menu you get just the single-key prompt. (The
  composer that briefly appeared at startup in 3.29.3 was the *previous* version
  rendering before the auto-update relaunched — it does not happen once you're on
  3.29.3+.)

## [3.29.3]

### Fixed — from live use in the data-tools shell
- **The chat composer no longer shows in the menu.** The full-width composer is now
  rendered ONLY inside an active conversation — at the main menu, sign-in flows,
  settings, and raw-session passthrough it's hidden (those use single-key input, not
  the line composer). Entering a chat shows it; returning to the menu hides it again.
- **opencode is recognized when signed in with a key, not just OAuth.** myshell
  delegates opencode sign-in to opencode's own secure store and **never sees the
  credential** — so it now counts opencode as authenticated whenever opencode holds
  *any* credential (an "OpenCode Zen" / provider key as well as OAuth). This unblocks
  using opencode as a broker for the many models it fronts (e.g. Kimi via
  `opencode-go`). The sign-in guidance now points at OpenCode Zen instead of
  discouraging it. (myshell still never stores or handles a raw key itself.)

### Also included — reliability polish
- A keystroke typed right after Ctrl+C-returns-to-menu is no longer swallowed
  (orphaned input waiters are now cancelled).
- The Ink layout budget reserves the composer's real (multi-line) height, and the
  token meter clamps malformed usage numbers — both further close the
  scrollback-overflow / NaN edge cases.
- The Ink turn-completion line shows elapsed time (`· Ns`), matching the legacy path.
- The Claude OAuth-refresh backup file is mode-pinned to `0600` and stale scratch
  files are cleaned up before each refresh.

## [3.29.2]

### Fixed — reliability hardening from a full end-to-end audit
- **The chat could "get stuck" with a spinning cursor and lost output.** If the
  model event stream threw mid-turn (an internal invariant, a store/ledger
  rejection), the renderer skipped its cleanup — the spinner's timer leaked and
  repainted forever and held-back prose was lost. Spinner-stop + final flush are
  now in a `finally`, guaranteed on both normal completion and a thrown stream
  (the error still propagates so the turn reports `[error]`). Applies to both the
  Ink and legacy render paths.
- **Long streaming answers could re-introduce the scrollback "double-box" glitch.**
  The live answer region was rendered without the height cap the layout planner
  computes, so an answer taller than the viewport overflowed and Ink re-emitted it
  into scrollback. The live region is now truncated to its height budget (newest
  lines kept, like a terminal scrolling up).
- **The UI now tracks terminal resizes.** Dimensions were sampled once at mount;
  after a resize the layout cap and composer width went stale. A SIGWINCH listener
  now re-measures (and recovers a 0/1-column PTY).
- **A render error no longer wedges the terminal.** A new error boundary catches a
  render/reducer throw, restores cooked mode, resolves any pending key read, closes
  the reader, and shows a concise `[error] interface crashed: …` line — instead of
  leaving stdin stuck in raw mode.
- **A corrupt conversation store no longer crashes the menu mid-chat.** Every
  per-turn history load (normal turn, question answer, goal loop, post-login retry)
  now degrades fail-soft to an empty thread with a one-line notice.
- **No file-descriptor leak on a failed interactive spawn.** If spawning the vendor
  child throws synchronously, the `/dev/tty` fd opened for it is now always closed.

## [3.29.1]

### Fixed — interactive sign-in / passthrough now reaches the terminal in pipe-stdin shells
- **Follow-up to the 3.29.0 activation fix (caught in adversarial review before it
  shipped live).** Once the Ink UI mounts in a wrapper shell where `process.stdin`
  is a pipe (it reads `/dev/tty` instead), spawning an interactive child with
  `stdio:'inherit'` handed the child the *pipe* as its input — so `claude /login`'s
  "paste code here" prompt and the raw `claude`/`codex` passthrough session would
  receive **no keystrokes** and hang. Interactive children now read from `/dev/tty`
  (the real controlling terminal) when `process.stdin` isn't a TTY, via a new
  `runInteractiveChild()` helper used by both the login flow and the raw-session
  passthrough. On a normal terminal (`process.stdin` is a TTY), Windows, or a true
  non-interactive/CI run, behaviour is unchanged (`inherit`) — including vendor
  binary resolution (PATH / Windows `.cmd`), which still goes through execa.

## [3.29.0]

### Fixed — the Ink UI now actually activates in Replit/data-tools shells
- **Root cause of "the new UI never showed up":** the mount gate required BOTH
  stdout *and* `process.stdin` to be TTYs. In wrapper shells (e.g. Steve Moraco's
  `data-tools`/`replit-tools`) `process.stdin` is not a raw TTY even though the
  terminal is fully interactive — so Ink never mounted and you saw the legacy
  renderer. The gate now mirrors the legacy raw-key path exactly: a new
  `resolveRawKeyInput()` returns `process.stdin` when it's raw-capable, else the
  cached `/dev/tty` `ReadStream`, else `null`. Ink mounts when stdout is a TTY and
  that stream exists, and is fed to Ink as its `stdin`. Pipes/CI (stdout not a TTY)
  still fall through to the legacy/cooked path, so nothing about non-interactive
  use changes.

### Changed — redesigned, full-width orchestration composer
- The chat input is no longer a narrow rounded box. It is now a **full-width
  composer**: a dim `─ chat ───…` rule across the terminal with a **right-pinned
  blue info chip** showing the current mode and command hints
  (`┌ Mode Balanced · /goal · /help · /back ┐`), the `❯` caret line, and a closing
  full-width rule. The mode/hints line that used to scroll away in the transcript
  is now pinned to the composer and updates live. An empty composer shows a dim
  `Type a message...` placeholder.
- The composer recomputes its width on terminal resize, and degrades cleanly to a
  plain `❯ value` surface under `NO_COLOR`, a non-TTY, or a narrow (<32 col)
  terminal.

### Internal
- New `blue` theme primitive (ANSI 34) alongside the existing colour helpers.
- `smoke:pty:ink` composer assertion updated to the new full-width shape, and
  `smoke:pty:handoff` made wedge-aware: the documented PTY job-control race (an
  inherited-stdio child briefly owning the foreground process group) is retried,
  while any attempt that resumes is still asserted hard so a genuine regression
  fails.

## [3.28.0]

### Changed — the orchestration-terminal Ink UI is now the default
- The new Ink-rendered interface is mounted by default on an interactive terminal.
  It is a mission-control surface, not just a prettier prompt:
  - **Live panels** for the current goal, the agents/models in flight, and a
    running token tally — so a long, multi-model turn is legible while it runs.
  - **Streaming that doesn't corrupt your input:** model output renders in its own
    live region instead of fighting the prompt line, so a paste or typed-ahead
    line is never garbled mid-stream.
  - **Single-key navigation** in the menu and the in-chat `/mode` / `/style`
    pickers (one keypress, no Enter), and **ESC interrupts the in-flight turn**
    and leaves you at the prompt (distinct from Ctrl+C → menu → exit).
- **Legacy renderer retained as the opt-out for this release.** Set
  `MYSHELL_INK=0` (also `false`/`off`/`no`, case-insensitive) — or
  `experimentalInk: false` in config — to run the previous raw-mode renderer
  byte-for-byte. Kept as the safety fallback for one release; not yet removed.
- **Non-TTY stays on legacy, always.** Ink mounts ONLY when both stdout and stdin
  are a real interactive TTY. Piped input, CI, and dumb terminals fall through to
  the legacy path unchanged, so scripts and pipelines are unaffected.
- Built incrementally behind the `MYSHELL_INK` flag before being promoted to the
  default: parity-proven against the legacy renderer, adversarially reviewed
  (6 bugs found and fixed), covered by the main + UI test suites, and verified
  end-to-end under a real pseudo-terminal (`smoke:pty:ink`). The legacy
  fallback's raw-mode behaviors (single-keypress nav, the doubled-paste fix)
  remain covered by `smoke:pty`, now pinned to `MYSHELL_INK=0`.

## [3.27.2]

### Fixed — self-update lands on the copy that's actually running
- The auto-updater ran `npm install -g myshell-tools@latest`, which installs into
  npm's *global* prefix — but the `myshell-tools` on the user's PATH can live under
  a *different* prefix (a version-manager shim dir, an earlier global install, etc.).
  When that happened the update landed somewhere the user never executes and the
  running copy stayed stale, so the tool honestly reported "Updated to X, but the
  active `myshell-tools` on your PATH is still Y" and stayed put — every launch.
  - **Targets the running install:** the updater now derives the npm prefix that
    owns the *currently-running* binary (from the realpath of the running entry)
    and passes `npm install -g --prefix <that>`, so the update lands on the copy
    that's executing. Conservative + fail-soft: anything that doesn't match a
    global-install shape (local dev checkout, npx cache) falls back to plain `-g`,
    so it's never worse than before. (`src/infra/update-prefix.ts`, unit-tested.)
  - **Self-diagnosing mismatch:** if a mismatch still occurs, the message now names
    the *actual path* of the stale binary (`which`/`where myshell-tools`) so you can
    remove it or fix PATH order without guessing.

## [3.27.1]

### Fixed — runtime Node floor (don't warn/block Node 20 users)
- `engines.node` was `>=22.0.0`, which made every end user on Node 20 hit an
  `EBADENGINE` warning on install (and would hard-fail installs under
  `engine-strict`). The Node 22 requirement was only ever needed for the **dev
  test runner** (`--experimental-strip-types`), never the shipped runtime.
  Lowered to **`>=20.0.0`** — the real, proven floor: the compiled `dist/` targets
  ES2022 and uses only stable `node:` builtins (JSON is loaded via `createRequire`,
  not import-attributes), so it runs cleanly on Node 20. Dev/test still uses Node 22
  via `.nvmrc`; nothing about the gate changed.

## [3.27.0]

### Added — Claude Max 5x vs 20x awareness (quota-aware auto behavior)
- The system now distinguishes **Claude Max 5x** ($100) from **Max 20x** ($200).
  Previously any "max" plan was treated identically and got the most aggressive
  auto-behavior (3-way panels on hard turns). The sub-tier lives in the
  credentials' `rateLimitTier` (e.g. `default_claude_max_5x`) — read fail-soft and
  matched on the `5x`/`20x` substring (no brittle exact-string hardcoding).
  - **Honest display:** the plan shows as "Max 5x" / "Max 20x" (plain "Max" when
    the sub-tier is unknown).
  - **Quota-aware tuning:** on the AUTO mode path, a detected Max **5x** narrows the
    panel to `maxPanelProviders: 2` (gentler on its smaller quota); **20x**, generic
    Max, and any explicitly-chosen `/mode Max` keep the full 3. A mix of tiers stays
    at 3 (conservative). `classifyPlan` still classifies both as tier `'max'`, so
    quality-first auto-selection is unchanged — only panel width and the label differ.

## [3.26.0]

### Fixed — honesty & graceful failure (ready-for-real-usage pass)
- **Empty model output is now an honest failure, not a fake success.** An errorless
  run whose final text was empty/whitespace used to render as `✓ done · 0 tokens`
  with no answer — a failure shown as success. It now becomes a `model`-category
  error and routes through the normal failover → escalate → honest-fail path.
- **Escalation is visible in normal mode.** When a turn escalates (first model
  low-confidence → a stronger model runs), normal mode previously streamed BOTH
  full answers with no explanation. It now shows a concise `↑ low confidence —
  refining with a stronger model…` so the second answer reads as a refinement.
- A failure-path audit verified the other modes degrade gracefully: no-auth
  (actionable sign-in prompt), rate-limit/429 (failover + cooldown), crash/timeout
  (honest "big task" framing + unknown-spend warning, never false success), and
  network/missing-binary (clean one-liners, no stack traces).

### Changed — panel latency feel
- **Panel candidates now stream live progress** instead of a silent `Promise.all`.
  A Max-mode multi-provider panel used to show a silent "Waiting on N models"
  spinner for the whole (multi-minute) candidate phase; each candidate's progress
  and completion now surface as it happens. (Synthesis remains a final adjudication
  pass — Max trades speed for quality, and discloses its quota cost up front.)

### Changed — internal architecture (behavior-preserving)
- **Decomposed the two largest files** with zero behavior change, every step gated +
  PTY-smoked: `menu.ts` 5,686 → ~2,575 lines (14 focused `menu-*` modules), and
  `orchestrate.ts` 2,106 → ~1,910 (`orchestrate-signals` + `orchestrate-memory`).
  An independent senior review confirmed the codebase is advanced (strictest TS
  flags, statically-enforced core purity, zero real `any`/`@ts-ignore`/TODO) — a
  ground-up rewrite was assessed and explicitly rejected as a second-system trap.
- **Removed all knip-flagged dead exports** (26 → 0) and aligned `@types/node` /
  `engines` to Node 22 (matches `.nvmrc` and the test runner).

## [3.25.0]

### Changed — concurrency is now automatic (the `/mode` knob owns it)
- **Panel and hedge auto-engage from the mode preset.** They used to be hidden,
  default-off opt-in switches (`config.panel` / `config.hedge`); now the `/mode`
  knob drives them so the default experience is "auto and frictionless":
  - **Efficient** — panel off, hedge off (quota-frugal; sequential path only).
  - **Balanced** (the default) — hedge on, panel on hard turns, up to 2 providers.
  - **Max** — hedge on, panel on hard turns, up to 3 providers.
  - **Scope/Reality:** the pre-existing safety gates still bound everything — a
    panel needs ≥2 signed-in providers **and** a high/critical-risk turn; a hedge
    needs high/critical risk + an admittable flagship + the sleep port. So
    trivial/low/medium turns stay on the single sequential path; only the rare hard
    turn auto-engages. A single sign-in never forms a panel (it may hedge).
  - `config.panel` / `config.hedge` remain as explicit **force-on** overrides;
    there is no force-OFF override (a user who wants neither picks Efficient).
- **Honest quota disclosure when it fires.** Because a user who flipped no switch
  can now trigger extra runs, the surface discloses the cost: the panel header reads
  `Panel (hard turn): … · N quota-consuming runs, may take longer`; the hedge emits
  `primary slow — starting flagship in parallel (now 2 quota-consuming runs)` only
  when the second run is genuinely incurred. Never billed as "free" (the budget is
  quota + latency on a flat-rate subscription, not dollars). A guardrail test locks
  the disclosure.
- **Design cross-checked with GPT-5.5 (codex)** against the real code: reuse the
  existing `/mode` knob rather than add a parallel "strategy" knob, and avoid panel
  `'always'` (it bypasses the risk gate). The two paths are kept, not collapsed —
  panel buys cross-vendor correctness, hedge buys latency hiding; they are distinct.

### Removed
- **Dead exports flagged by knip (26 → 0)** — dropped redundant `export` on
  internally-used symbols and one dead `RecapGenerator` re-export chain. No runtime
  behaviour change.

## [3.24.0]

### Added/Fixed — polished chat surface (queueing that feels real, input box, live goal visibility)
- **Clean mid-turn input + visible queue (fixes "can't queue messages"):** the queue
  worked mechanically, but mid-turn keystrokes echoed RAW onto the spinner line
  (PTY-confirmed: `Thinking… 0 steps · 2sQUEUEDLINE`), so it looked broken. A muting
  `ReadlineOutputProxy` suppresses readline's echo during a turn; typed-ahead text no
  longer smears, and a clean `⏎ queued (N); <preview>` indicator shows what's queued.
- **Bordered input box:** `╭──── ✦╮ / │ ❯ … │ / ╰────╯` with a corner glyph (the modern
  shell-chat "type box"); degrades to the plain `❯ ` caret off-TTY / NO_COLOR / narrow.
- **Graceful big-work framing:** a turn that times out now reads as a big-task signal
  ("that ran past the single-turn time limit — it's a big one") leading into keep-going,
  instead of an alarming "Failed — 0 tokens" crash line.
- **Live goal visibility:** `/goal` shows an honest live status each iteration —
  objective, current step, steps done/total (from the real roadmap), and cumulative
  tokens spent (from the ledger). No fabricated agent count (the goal loop runs
  sequential turns; only a real parallel-panel turn surfaces "N models in parallel").

PTY-VERIFIED (`npm run smoke:pty` PASS): paste commits once, single-keypress intact,
mid-turn smear gone, queued indicator visible, no crash on typing. Box render visually
confirmed + unit-tested. +7 tests (3457 → 3464), gate green.

## [3.23.0]

### Added — provider capability utilization (audit-driven: use the full capacity of each provider, smartly + combined)
Acting on `docs/provider-capability-utilization-audit-5.6.md` (which rated utilization
Claude 45% / Codex 62% / OpenCode 28% / combined 52%), each lever verified live:
- **Claude `--effort`** (audit #1): the CLI exposes low/medium/high/xhigh/**max**; only
  Codex consumed the effort seam before. Now Claude does too (`max` is the deepest level;
  Max-mode admitted-manager hardest turns reach it, bounded by authorizeTier).
- **OpenCode capabilities** (audit #2, the most under-used): a fail-soft
  `opencode models --verbose` refresh populates real per-model facts (context, vision,
  toolcall, reasoning variants) and `opencode run --variant` is wired.
- **Codex native web search** (audit #3): when Codex is ALREADY the selected provider, an
  external/current-fact turn passes the `-c tools.web_search=true` override to `codex exec`.
- **Image attachments** (audit #4): referencing a local image path attaches it (codex `-i`,
  opencode `-f`) and flags the turn `needsVision`.

Scope/Reality (corrected after audit): these levers are narrower than first stated.
- Cross-provider routing does NOT re-rank arbitrary OpenCode models: the OpenCode refresh
  populates facts and `--variant`, but `candidateModelsFor` emits placeholder OpenCode ids
  and the router never re-ranks arbitrary dynamic OpenCode ids across providers. The
  hard-requirement preference applies within the existing candidate set only.
- Web search is NOT a cross-provider routing trigger. It is a Codex adapter flag that only
  fires when Codex is already selected; search is not detected from task signals, and the
  Claude/OpenCode adapters ignore `webSearch`.
- Image vision is honored on the SEQUENTIAL chat/run path only. The image/`needsVision`
  flag is dropped in the REPL, hedge, panel and review paths.

Self-awareness now presents the full per-provider capability matrix (models, efforts,
search, vision). Subscription-cost clean throughout (OAuth-CLI flags only; no api-key/
embeddings/metered/Vertex). Deliberate, rationale-backed deferrals (not gaps): structured-
output for internal envelopes (audit #5 — marginal over the existing fail-soft parsing),
OpenCode native sessions (#8), routing unknown dynamic models (#9 — would require guessing
tiers), MCP/provider-native skills/subagents (keep explicit, not auto), and Gemini (design
provider-agnostic for a clean later drop-in). 3431 → 3457 tests, 0 fail.

## [3.22.0]

### Added — adaptive partner v2 roadmap complete (work-state, vision triage, discovery escalation, grounded opinion, history hardening)
Builds out the adaptive-partner-v2 design (`docs/adaptive-partner-v2-5.6.md`) on top of
the TurnDirective (3.19.0):
- **Live work-state (AP2-B)** — `deriveWorkStateFromHistory` reconstructs objective /
  done / next / blocked from persisted `workTrace` (done requires evidence; never
  inferred from silence) and renders a truthful WORK STATE block. Resume + "continue"
  now names what's truly done and starts the next step instead of re-asking.
- **Vision triage (AP2-C)** — decomposes a multi-part vision into SOLID / DISCUSS /
  MIGRATE_REARCHITECT / INVESTIGATE_THEN_PROPOSE, recommends a sequence (not a menu),
  and gives an opinion on migrations. MIGRATE tier bounded by `authorizeTier`.
- **Discovery-driven escalation (AP2-D)** — extracts discovery signals (larger bug,
  cross-cutting, wrong-repo, high-stakes, low-confidence) from a turn's output and
  escalates/reviews through the existing gates (bounded by authorizeTier/panelPolicy/
  maxAttempts); local reversible fixes are just done; no spurious escalation on clean
  turns.
- **Grounded-recommendation validator (AP2-E)** — substantial decision turns must carry
  a recommendation grounded in real evidence (files, repo facts, assumptions, sources,
  or an honest "I can't see that repo"), else one shared-budget repair + truthful
  fallback; tiny factual turns exempt.
- **Native-session + stale-history hardening (AP2-F)** — quarantine now blocks resuming
  a poisoned provider-side session, compaction preserves user asks + trusted workTrace,
  and an `ENGINE_BEHAVIOR_VERSION` marker identifies pre-fix transcript periods.

Subscription-cost clean throughout (pure decisions, no embeddings/metered/extra always-on
model calls). 3356 → 3380 tests (whole roadmap 3119 → 3380), 0 fail.

Scope/Reality (corrected after audit): "each stage real-run-verified" overstated it — most
of v2 is prompt-shaping and pure decisions, not an enforced runtime layer:
- Vision triage is deterministic lexicon/regex logic rendered as prompt INSTRUCTIONS to the
  model, not an independent classifier pass.
- Discovery-driven escalation reads regex signals out of the MODEL'S OWN output — it is not
  an independent discovery pass.
- The grounded-recommendation validator checks the final TEXT for evidence shape; it does
  not independently verify the claims.
- Work-state is reconstructed for PROMPT CONTEXT (a rendered block), not a runtime state
  machine that gates execution.
The checked-in tests for these are unit/fake/gated, not reproducible real-provider runs in
CI (see 3.21 Scope/Reality).

## [3.21.0]

### Added — model/provider capability registry (Stages 1–5, capability-aware routing)
myshell-tools now knows what each model can actually do, and routes/explains
accordingly — designed as 3 layers (objective declarative facts + dynamic refresh +
a thin learned tie-break), per `docs/model-capability-registry-5.6.md`:
- **Registry + dynamic refresh** (`model-capabilities.ts`, `model-capability-refresh.ts`,
  `infra/model-capability-port.ts`): objective per-model facts (context window,
  reasoning efforts, vision, tools, native session, cost tier), merged fail-soft from
  declarative defaults ← detection `availableModels` ← `$CODEX_HOME/models_cache.json`.
  Unknown = absent, never fabricated; missing cache degrades gracefully.
- **Self-awareness** now states real capabilities ("Codex GPT-5.5 — low/medium/high/
  xhigh, 272k context, vision") and degrades honestly to "unknown" when the source is
  gone.
- **Capability-fit routing** (`route()`): bounded re-ranking of *which model of the
  already-chosen provider* runs (large context, vision, native session) — can never
  bypass auth/cooldown/tier admission; byte-for-byte unchanged with no registry.
- **Reasoning-effort selection** (`selectReasoningEffort`): mode×tier×risk×task ladder
  → Codex `-c model_reasoning_effort=<effort>` (xhigh only when manager admitted);
  recorded in the ledger. Claude/OpenCode unchanged.
- **Learned outcomes** (`routing-memory.ts`): a conservative, per-user, ledger-derived
  tie-break that *extends* `learnProviderOrder` (min 5 runs, neutral prior, ≤0.5
  influence) — applied only after hard capability fit, never overriding it.
  Scope/Reality: OFF BY DEFAULT (`learnRouting=false`) and cold-started — it needs history
  across 2+ providers and 5+ runs per model before it contributes, and even when enabled it
  is only a small bounded tie-break. For a default install it effectively does not
  participate in routing.
- **Provider-native feature inventory** (facts only): records that Claude Code supports
  Skills/sub-agents but states plainly that myshell-tools does NOT invoke them —
  routing uses our own orchestrator. Non-routable; never executed.

Subscription-cost clean (no embeddings/metered/extra model calls). Gemini deliberately
deferred (provider-agnostic shapes leave a clean drop-in). 3119 → 3251 tests, 0 fail.

Scope/Reality: the checked-in test base is unit/fake/gated — it is not reproducible
real-provider evidence in CI. The native-session E2E is skipped unless
`MYSHELL_NATIVE_SESSION_E2E=1`, and the menu-cli integration tests make no real provider
calls. Treat "verified" here as "covered by deterministic tests", not "reproduced live
from repo CI".

## [3.20.0]

### Added — tool self-awareness ("ABOUT THIS TOOL" context block)
The chat partner now knows myshell-tools' own live state instead of guessing it.
Before, asking "how many subscriptions am I authed and what mode am I in?" made the
model read the wrong files and HALLUCINATE ("0 subscriptions, balanced mode") when
the user actually had Claude Max + Codex authed in Max mode. Fixed with a
deterministic, accurate context block (`src/core/tool-state.ts` →
`buildToolStateContext`) assembled from the live `EnvironmentStatus` + `Config` and
injected via `assembleContextBlocks` adjacent to the ENVIRONMENT block:
- Connected subscriptions + plans + count (authed only; installed-but-unauthed noted;
  null plan → "authed (plan unknown)", never a guess).
- Current mode (auto vs explicit) + canonical meanings of Efficient/Balanced/Max +
  smart-routing state.
- What the tool/partner can do (the canonical /help command set).

Pure assembly — no model call, no API key, no metered service. Wired into the chat
path, the one-shot `run` path, and the legacy `repl`. Verified by a REAL run: the
model now reports the exact detected state ("2 authed — Claude Max, Codex plan
unknown; OpenCode installed, not signed in; mode Max, auto"), no hallucination.
+34 tests (3119 → 3153), 0 fail.

## [3.19.0]

### Added — adaptive partner: advisory → partially enforced (TurnDirective, Stage 1)
The engagement plan was *advisory* — rendered as prompt text the model could (and
did) ignore, which is why a gate-green posture change left live behavior unmoved.
Stage 1 of the v2 design (`docs/adaptive-partner-v2-5.6.md`) moves SOME of it from
advisory toward enforced via an orchestrator-owned `TurnDirective`
(`src/core/turn-directive.ts`, consumed in `orchestrate`):
- **Pre-provider structured ask.** When the plan selects a genuine, non-investigable
  fork with a real question set, the orchestrator emits the `ask_user` question
  *before* the model runs — zero provider tokens, and the model can't bypass it with
  prose.
- **Generic-menu validator + one repair retry.** A pure `validateTurnOutput` detects
  the generic "fixing / adding / polishing / integrating?" menu in final prose (only
  when a repo is present / investigation was planned, so normal option-listing isn't
  blocked) and retries once at the same tier with corrective feedback. One call only
  on the actual failure — no new always-on model call. A still-failing repair keeps
  the better answer (never discarded as Failed).
- **History quarantine.** Prior assistant turns that are themselves generic menus are
  filtered from the replayed history so a resumed conversation written by older builds
  stops few-shot-poisoning new turns.

Subscription-cost clean (no embeddings, no metered services). +28 tests
(3108 → 3136), 0 fail.

Scope/Reality (corrected after audit): "enforced" applies to the parts that run in the
orchestrator — the pre-provider `ask_user`, the pure `validateTurnOutput` menu check + one
repair retry, and history quarantine. The broader `requiredBeforeAnswer` directive is only
partially enforced: only `vision_triage` has a live impl, while `orient_repo`,
`investigate_context`, `web_research` and `plan_first` are RESERVED (not built). The
"real provider runs" claim is not reproducible from repo CI — the checked-in tests for this
are unit/fake (see 3.21 Scope/Reality).

## [3.18.1]

### Fixed
- **Doubled input line (correct root cause).** 3.18.0 attacked the wrong layer. The
  real cause: the chat readline interface used Node's DEFAULT prompt `'> '`, and a
  paste (any line refresh) makes readline repaint `'> ' + buffer` at column 0 —
  competing with the manually-written `❯ ` caret and showing the pasted text on a
  second line. Fixed by setting readline's prompt to empty (`prompt: ''`) so a
  refresh repaints just the buffer; reverted the 3.18.0 cursor-math echo hack.

## [3.18.0]

### Fixed (live-found — chat feel)
- **Doubled input echo.** A pasted/typed chat line could appear twice (readline's
  live preview row left on screen beneath the committed text). The loop now clears
  that preview row and renders exactly one canonical `> <line>` echo on a TTY.
  Rendering-only — no new stdin consumer, no raw-mode / suspend-resume change.
- **Working indicator now appears instantly.** The "Thinking…" spinner started only
  at `tier-start`, so it looked like it appeared only once a model/agent spawned. It
  now starts the moment `renderStream` owns the turn (on a TTY), staying alive through
  setup, tool, and reasoning activity. Verbose telemetry, the parallel-models panel
  line, the elapsed counter, and the interrupt hint are unchanged.
- **One indicator, not two.** The live working line no longer prepends the semantic
  `●` glyph on top of the braille loading frame — just the loading frame + label. The
  `●` remains where it's meaningful: heading the assistant's answer and on the
  completion line.

### Changed (partner posture)
- **Investigate, then recommend — don't interrogate.** After orienting, the partner now
  states what it found and recommends the concrete next step instead of offering a
  generic "fixing / adding / polishing / integrating?" menu. The engagement engine no
  longer treats such a generic task-category menu as a genuine fork on an investigable
  request, and `ask_user` options must be concrete and grounded in findings. Applied
  across all three personas.

## [3.17.0]

### Added
- **Smart Tab completion.** Press Tab to complete: command arguments (`/mode `→
  tiers, `/style `→ direct/balanced/collaborative, `/memory `→ subcommands),
  file **paths** (`./ ../ ~/`), and `@`-file **mentions** — with fuzzy matching
  (prefix → substring → subsequence). It stays strictly out of the way on plain
  prose (a mid-sentence `@email` or free-text never gets mangled), runs locally
  with no model call, and is fail-soft. Shared by both the menu chat and the REPL.

## [3.16.0]

**It's a real chat now.** A ranked roadmap (`docs/real-chat-gap-analysis.md`) of
the gaps between myshell's chat and a polished chat app, all built — driven by
live testing. Subscription-auth throughout (no metered services).

### Added
- **Transcript on resume.** Reopening a conversation now *shows* it — a bounded,
  glyph-styled transcript of the recent messages (● assistant / › user, dim
  timestamps) above the recap, so you see where you left off instead of a blank
  prompt. (The model already received the history; this was the missing display.)
- **`/retry` and `/edit`** — message-level redo. `/retry` regenerates the last
  answer; `/edit` lets you pick a prior message, edit it, and re-run from there.
  Backed by a new controlled, atomic, fail-soft `truncateAfter` store op.
- **`/copy` and `/export`** — `/copy` puts the last answer on your clipboard
  (fail-soft, with a headless text fallback); `/export` writes the conversation
  as a Markdown transcript. Your work is never trapped in scrollback.
- **Richer conversation list** — each row shows a `· N msgs` count.
- **Semantic conversation titles** — titles are distilled from the conversation's
  recap (reusing it; no extra model call) instead of raw first-words, and never
  clobber a name you set.

## [3.15.0]

Post-3.14.0 hardening + codebase awareness — several driven by live testing on a
real repo (the kind of bug unit tests miss).

### Fixed
- **Memory never silently loses a fact.** Distinct facts that both fell into the
  `'other'` catch-all subject (the closed vocab can't name everything) were
  collapsed by consolidation — e.g. saving "My name is Jordan" clobbered a saved
  "I prefer British English spelling". `'other'` is no longer treated as a unique
  key; distinct facts coexist (they merge only on real lexical similarity).
- **Never report a good answer as "Failed".** The cross-vendor review `revise`
  loop re-ran the whole task at the same tier with no cap; a good-but-low-
  confidence answer could loop to `maxAttempts` and then be discarded as a red
  "Failed" (after burning tokens re-running it). The loop now returns the
  best-effort answer (flagged, not discarded), caps revise re-runs at 1 then
  escalates, and reserves "Failed" for genuine no-output failures.

### Added
- **Investigate before interrogate (partner posture).** The vision-first partner
  now reads the codebase to answer its own questions and asks the user only about
  genuine forks it can't resolve by looking; if you reference a project/area that
  isn't in the current working directory, it says so and asks where the code is
  instead of asking abstract questions.
- **Codebase awareness (E1).** The chat opens already knowing its repo: a cheap,
  deterministic ENVIRONMENT / repo-map block (repo name/branch/dirty, project
  type, key docs + entry points, a ranked file map) is injected first into every
  prompt — Cursor-grade orientation with **no embeddings, no vector DB, no metered
  service, no model call**, composed with the wrapped model's own agentic search.
  `codebaseAwareness` config kill-switch.

Test suite 2926 → 2985 (0 failing).

## [3.14.0]

### Added
**Vision-first adaptive partner — chat overhaul.** A 10-phase build (designed and
adversarially self-reviewed, then implemented and re-reviewed on the running tool;
the X/10 figures were our own internal design-review scores, not an external
benchmark), all behind the existing subscription-auth model (no API keys,
embeddings, or metered services; the only new model touches are gated cheap
worker-tier passes via the existing injected provider port). Full design corpus in
`docs/*-5.5.md`, build sequenced by `docs/MASTER-PLAN-5.5.md`. Highlights:

- **Chat mechanics** — press **ESC to interrupt** the current turn (stay at the
  prompt; distinct from double-Ctrl+C → menu), **type-ahead queueing** (lines typed
  while it works are queued and drained FIFO, never auto-answering an unseen
  selector), and a single canonical post-turn order (`decidePostTurn`).
- **Adaptive partner** — an intent engine builds a per-turn `IntentFrame` (one
  gated cheap call, skipped on trivial turns) and an Adaptive Partner Engine decides
  *what to do, when, and in what order* (execute / reflect / ask / plan-first /
  investigate / research / discuss) with a hard safety floor (irreversible+ambiguous
  always confirms) and efficiency guardrails (no over-ask/over-research). `partnerStyle`
  (`/style` direct·balanced·collaborative) is a soft bias, not a hard mode.
- **Memory** — durable, *smart* memory: a write-gate (rejects secrets, transient,
  instruction-shaped, re-derivable), write-as-consolidation (ADD/UPDATE/SUPERSEDE/
  NOOP — no duplicate-fact drift), trust tiers, bi-temporal invalidate-not-delete,
  use-it-or-lose-it decay, deterministic capped retrieval, and per-turn injection
  gated so trivial turns stay clean. No silent saves: `/remember`, `/forget`,
  `/memory [all·loaded·export]`, CLI `memory …`, and approved `remember_user`
  proposals. On by default, project-scoped; kill-switch in Settings.
- **Feel** — a semantic `●` turn marker (cyan→green/red), a real **"Waiting on N
  models"** panel status sourced from live ensemble events, `※` recap on resume,
  and light inline markdown — all degrading cleanly under NO_COLOR / non-TTY /
  MYSHELL_PLAIN.
- **Whole-tool** — progressive first-run hints, a unified teach-on-failure error
  format, an ADVISORY overhead budget (a documented intent of ≤1 added blocking call
  per turn from this layer — not a runtime governor; other pre-answer calls on the
  chat path are not counted or capped by it) with a quota-shed ladder where the core
  answer always survives, and a 3.12.x→3.14.0 upgrade path (no data loss, no scary
  prompts).

Test suite grew 2461 → 2926 (0 failing).

## [3.13.0]

### Changed
**opencode sign-in is now one frictionless step — no giant provider picker.**
Previously "Add/sign in to opencode" ran bare `opencode auth login`, which dumped
opencode's full multi-provider list (anthropic, openai, google, dozens of
models.dev providers) before you ever reached the OpenCode account. Both the
browser and code/headless login paths now run `opencode auth login -p opencode`,
which goes straight to connecting your **OpenCode account** (create/paste one API
key from `https://opencode.ai/auth`). OpenCode Go subscriptions and OpenCode Zen
credits are tiers of that same account — once connected, myshell just uses whatever
models the account unlocks, exactly like a Claude/ChatGPT subscription. myshell
never sees the key; opencode stores it. Onboarding and login guidance reworded to
match. Empirically verified against opencode 1.15.12 (`-p opencode` lands directly
on the credential screen; no `-m` method label needed). Full write-up in
`docs/opencode-auth-audit-5.5.md`.

## [3.12.3]

### Fixed
Auth flow could loop back into sign-in after a **successful** login, and a vendor
prompt's text could stay invisible until a second Enter (reported live on Replit).
Full diagnosis in `docs/auth-flow-audit-5.5.md`; root cause was two bugs lining up:
- **Post-login re-auth loop.** First-run onboarding (`runWelcome`) decided each
  provider's sign-in prompt from a **stale** environment snapshot taken before login,
  so a completed Claude sign-in could be followed by another (stale) auth prompt —
  and a leftover Enter could default-accept it. Onboarding now **re-detects the
  environment immediately after each accepted login**, so a finished sign-in is never
  offered again.
- **Invisible prompt / double-Enter race.** After an inherited-stdio vendor child
  exited, a trailing Enter could arrive just *after* `createLineReader.resume()` had
  cleared its buffer and then auto-answer (or flash) the next prompt. `resume()` now
  suppresses one immediate blank line during the short TTY handoff window (guarded;
  no effect on piped/test input).
- **Browser-mode login trusted exit code 0.** It now uses the same real credential
  probe as code-mode login (shared `verifyPostLogin`) — a vendor exiting 0 after a
  cancelled/failed paste or first-run trust dialog is correctly reported as not signed in.
- **`doctor --fix` double stdin-handoff.** `doctor` suspended stdin *and* `runLogin`
  suspended internally — a nested suspend/resume around one login (same race class).
  `doctor` now threads its `readLine`/`confirm`/`suspendStdin` seams into `runLogin`
  so there is a single handoff owner, matching the menu path.

### Tests
- No-re-auth-loop regressions (explicit `[j]` login and onboarding login both re-detect
  and return home without re-prompting), a `createLineReader.resume()` blank-line-drain
  test, and a `doctor` test proving stdin is suspended once (by login only). Full suite:
  2458 pass / 0 fail.

## [3.12.2]

### Fixed
Interactive menu was broken and Enter-bound on Replit / web shells after a launch
auto-update self-relaunch (reported live on v3.12.1). Two compounding faults, both fixed:
- **Keys didn't dispatch.** When raw single-key mode was unavailable, `readMenuKey`
  fell back to a line read and returned it **un-normalized**, so a line like `j`, `J`,
  `j ` or `j\r` never matched the exact `key === 'j'` dispatch — the menu silently
  re-rendered and you could not even sign in. The line fallback now runs through a
  shared `normalizeMenuKey` (trim + lowercase; multi-char tokens like settings keys
  preserved), so every menu/confirm key dispatches in line mode too.
- **Single-keypress was lost after self-relaunch.** The auto-update relaunch left the
  child process with a stdin that wasn't raw-capable, forcing line mode (press key
  **then Enter**). `readMenuKey` and the yes/no confirm now fall back to the
  controlling terminal (`/dev/tty`, lazily opened + cached, guarded, non-Windows) for
  true single-keypress input, and the parent no longer re-primes `fd0` after a
  successful relaunch handoff (it would steal keys / degrade the child's TTY).

### Changed (friction)
- Pressing **[n]/[c]** with exactly one installed-but-unauthenticated provider now
  signs in to it **directly** instead of asking a second "Sign in now? [j/k/o]" question.
- Settings **Auto-goal** moved from `[10]` to **`[a]`** — a two-char item was
  unreachable under raw single-key input (pressing `1` fired option 1 immediately).
- Empty **Manage** screen returns immediately instead of a dead-end "press Enter to go back".

### Tests
- `normalizeMenuKey` + line-fallback coverage (`j\r`→`j`, ` J `→`j`, `n\t`→`n`,
  blank→`''`, `null`→`null`, `10`→`10`) and an end-to-end regression proving a
  line-mode `j\r` dispatches Claude login. Full suite green: 2454 pass / 0 fail.

## [3.12.1]

### Fixed
Cross-stage hardening of the Work Contract feature (from a full integration review):
- **`/goal` loop could stall after one turn.** A goal turn also received the normal
  trailing confidence-envelope instruction; a model emitting that JSON *after* the
  `GOAL_CONTINUE`/`GOAL_COMPLETE` marker made the last line JSON, so the loop read
  "no signal" and stopped. Goal turns now suppress the confidence envelope (via a
  `goalTurn` prompt mode — non-goal turns are unaffected), and the loop also strips a
  stray trailing confidence envelope before reading the marker. This most affected the
  new auto-engaged goals.
- **Auto-goal no longer double-routes.** The opt-in pre-dispatch check used the model
  router and then `runTask` routed again — an extra model-classifier run on ambiguous
  turns. The preflight now uses only deterministic keyword classification (no model
  call); auto-engage requires manager tier + ≥2 classifier signals.
- **Hedged goal turns now persist their `workTrace`** (previously dropped on the hedge
  accept path; now mirrors the sequential and panel paths).
- **Honest progress labeling.** The running trace built from each turn's
  `GOAL_CONTINUE` next-step is now rendered as "RECENT STEPS (each turn's stated next
  action)" instead of "CHECKPOINTS SO FAR" — stated intentions, not verified
  completions.
- Trimmed unused branches from `decideAutonomyOffer`; de-duplicated
  `isCleanObjectiveTask` into `work-contract.ts`; documented `SessionEntry.workTrace`
  as an append-only audit trail.

## [3.12.0]

### Added
Smart-auto autonomy (Stage 4) — opt-in, **default-off**. When enabled, `quality-first`
mode can automatically enter the existing `/goal` loop for conservatively detected
multi-step work, instead of requiring you to type `/goal`:
- New `autoGoal` config flag (default off) + a Settings toggle **[10] Auto-goal
  (quality-first)**. With the flag off, behavior is **identical** to before — no
  preflight routing, no auto-engage (pinned by a parity test).
- New pure `decideAutonomyOffer` centralizes the autonomy decision. Existing timeout
  and `keep_going` offers are preserved in all modes (still ask first). Auto-engage is
  strict: only `quality-first` + opt-in + corroborated multi-step work (manager tier
  **and** route `plan` or ≥2 classifier signals) starts `/goal` without a prompt.
- Auto-engaged runs show a visible banner — `Working autonomously until it's done
  (up to 8 turns). Ctrl+C to stop.` — and bail instantly on Ctrl+C via the existing
  AbortController. It reuses `runGoalLoop` as-is (no second autonomous executor).

This completes the user-facing half of the Work Contract feature: a structured
objective now anchors long autonomous runs (3.11.1), the reviewer verifies against it
(3.11.0), it persists as an audit trail (3.11.2), and qualifying work can now engage
autonomously on its own (3.12.0).

## [3.11.2]

### Added
Work Contract — Stage 3: a capped audit trail persisted on accepted turns. Genuinely
multi-step work now records one compact `workTrace` (objective + checkpoint trace)
on the accepted assistant entry, in the existing conversation JSONL — no new files:
- `SessionEntry` gained an optional `workTrace?: WorkContract`; an autonomous `/goal`
  turn persists its live contract (clean objective + `GOAL_CONTINUE`-derived
  checkpoints), threaded from the goal loop through a new optional
  `OrchestrateDeps.workContract`. All four sequential accept sites and the panel
  accept site persist it uniformly via the shared accepted-run object.
- Ordinary single-shot turns persist **no** `workTrace` key at all (verified by
  `Object.hasOwn` test) — zero bytes, zero behavior change.
- New `isWorkTrace` guard in `jsonl-guards.ts` validates a present trace (version,
  objective, roadmap/checkpoint/verification shapes) and is wired into
  `isSessionEntry`, so a corrupt trace is skipped rather than trusted — while an
  absent one is always fine.
- A non-`/goal` trace is only generated for multi-step (manager-tier / plan) turns
  whose task is a clean objective line, never a rendered contract prompt. Traces are
  `capContract`-capped before write. `workTrace` is a structured field, never rendered
  into prose, so history replay is unaffected.

## [3.11.1]

### Added
Work Contract — Stage 2: anti-drift north star in the autonomous `/goal` loop. Each
goal turn now re-states the objective as a hard constraint and carries a compact
running checkpoint trace built from the worker's *own* `GOAL_CONTINUE` text — so long
autonomous runs stay pointed at the original ask instead of drifting:
- `buildGoalTask` gained an optional `contract?`; when present it prepends the
  objective + "confirm this turn still serves the OBJECTIVE" and a capped checkpoint
  trace. When absent it is **byte-identical** to before (existing goal tests unchanged).
- New pure `appendCheckpointFromContinue` folds each turn's `GOAL_CONTINUE: <next step>`
  into the contract (keeps the most recent 6, drops oldest), and new additive
  `parseGoalContinueText` extracts that text — `parseGoalSignal`/`parseTrailingGoalMarker`
  semantics are untouched, no new control key.
- The contract lives only in the live prompt: `runGoalLoop` persists the **clean**
  goal task to session history (a thin session-writer wrapper), so the internal
  objective/checkpoint block never bloats history or leaks into replayed conversation.
- Still prompt-only: no persistence, no extra model call, no `SessionEntry` change.

## [3.11.0]

### Added
Work Contract — Stage 1: structured verifier criteria. A compact, ephemeral
`WorkContract` (objective + optional vision) is now handed to the cross-vendor
reviewer and the panel synthesizer as explicit adjudication criteria, replacing the
prior unstructured "does this look good?" review:
- New pure `src/core/work-contract.ts`: the `WorkContract` type model, a deterministic
  `capContract` (caps every field; never throws), `renderContractForPrompt` (degrades
  cleanly to objective-only), and the `shouldMaterializeContract` proportionality
  predicate (criteria only when a reviewer/synthesizer already runs; roadmap reserved
  for multi-step contexts in later stages).
- `buildReviewPrompt` / `buildPanelSynthesisPrompt` gained an optional `contract?`
  argument; when absent the prompts are **byte-for-byte identical** to before (pinned
  by snapshot tests), so trivial turns pay zero tax and no new control-envelope key is
  introduced (the 3.10.10 leak contract is untouched).
- The contract lives only in the prompt we send — never in model output we parse,
  never in assistant prose — so nothing new can leak and history replay is unaffected.
- No persistence, no extra model call, no worker-output change in this stage.

## [3.10.20]

### Fixed
Shell-rc install/uninstall hook safety (`myshell-tools install`/`uninstall` edits your
shell startup file):
- **Symlinked rc files and file permissions are respected.** Writing the hook used a
  temp+rename that replaced a symlinked `~/.bashrc`/`~/.zshrc` with a regular file
  (breaking dotfiles-repo setups) and could loosen a `0600` rc to `0644`. It now resolves
  a symlink and writes the real target (keeping the link), preserves the existing file
  mode, creates a new rc as `0600` (rc files can hold secrets), and refuses (with the
  manual snippet) rather than clobber an unresolvable symlink.
- **Uninstall can't delete unrelated lines.** A regex removed everything between the first
  begin marker and the next end marker, so an orphan/malformed marker from a prior edit
  could take your own rc lines with it. It now parses line-by-line and removes only a
  complete, exactly-matching managed block; on malformed/orphan/nested/duplicate markers
  it aborts without writing and tells you to remove the block manually.
- **fish users aren't given a broken bash hook.** A `fish` `$SHELL` fell through and wrote
  `~/.bashrc`; it now refuses and prints fish-correct manual guidance instead.

## [3.10.19]

### Fixed
- **Auto-update can't relaunch the old binary (or loop).** It treated `npm install -g` exit
  0 as success and relaunched `myshell-tools` from PATH without checking the active binary
  was actually the new version — so a shadowed/wrong-prefix global install could relaunch
  the old version (and, with auto-update on, loop). It now verifies the active
  `myshell-tools --version` matches the target before relaunching; on a mismatch it prints
  an actionable PATH message and stays on the current process instead of looping.
- **Health checks the real state directory.** `probeStateWritable` probed `cwd/.myshell-tools`,
  but config/conversations/credentials live under the resolved state home (your home dir off
  Replit) — so health could say "writable" while the actual state dir failed. It now probes
  the resolved state home and the (cwd-based) ledger dir separately, labeling each path.
- **The health probe can't clobber a file.** It wrote a fixed `.health-probe` (truncating any
  existing same-named file); it now uses a unique name with exclusive create and removes only
  the file it made.

## [3.10.18]

### Fixed
`/goal` autonomous-loop control-marker fixes (the iteration ceiling was already correct):
- **A goal no longer stops early because prose *mentions* the completion marker.** The
  parser matched `GOAL_COMPLETE`/`GOAL_CONTINUE` anywhere in the output (and "last
  wins"); it now reads only the trailing marker line (shared with the renderer's stripping
  via one `goal.ts` utility), so a turn discussing the markers can't end the run.
- **A turn with no marker stops honestly instead of burning turns.** A missing/garbled
  signal previously defaulted to "continue", spending the remaining autonomous turns
  repeating work; it now stops with "no goal signal — re-run /goal to continue".
- **Goal markers no longer leak into replayed history.** They were stripped from the
  display but not from the compacted history, so later turns saw a prior turn's
  `GOAL_CONTINUE: <next step>` as context; history compaction now strips them too.
- **A question during a `/goal` run pauses for you.** If a goal turn emits an `ask_user`
  block, the loop now surfaces the question selector instead of treating it as a
  markerless success and continuing to guess autonomously.
- opencode native-session continuity (`run --session`) — feature add, needs live opencode verification.
- Reconcile Codex advertised models (detect.ts) with the pricing table and current vendor
  model IDs — deferred: needs live verification of what the `codex` CLI actually exposes.

## [3.10.17]

### Fixed
- **Plural risk words now trigger review/escalation.** The risk classifier's signals were
  mostly singular, so "rotate API keys and credentials", "fix payments permissions", "run
  the db migrations", "schema changes", etc. could classify as low risk — skipping the
  high/critical cross-vendor review and using looser acceptance thresholds. The
  critical/high signal patterns are now plural-safe (`credentials?`, `api[-\s]?keys?`,
  `payments?`, `permissions?`, `migrations?`, `schemas?`, …).
- **Ambiguous "design/plan"-style tasks reach the smart router.** A lone soft manager
  keyword falsely counted as routing evidence, so the model-brained tier classifier was
  skipped and the task defaulted to IC. `hasTierEvidence` now uses the same
  "manager qualifies" rule as the classifier (strong signal or ≥2 soft), so a genuinely
  ambiguous task (e.g. "design a multi-tenant billing system") now consults the smart
  router instead of silently routing IC.
- **Routing fallback honors advertised models.** The rare "no preferred provider
  available" fallback bypassed the `availableModels` filter and could return an
  unadvertised model; it now goes through the normal provider model-selection path.
- Per-conversation append/remove lock (a delete racing an append from two concurrent
  processes on the same conversation) — low single-user likelihood; deferred as a
  larger, deadlock-sensitive change.
- fsync durability on writes — deferred: the atomic temp+rename already gives readers a
  consistent file, and the workspace FS is durable; fsync's only benefit is surviving an
  abrupt kernel/power crash mid-write, at a per-write latency cost.

## [3.10.16]

### Fixed
- **The append-only conversation mirror can no longer clobber a good archive.** It
  `copyFile`d the live log over the archive whenever the live file was larger — so a
  corrupted/replaced live file could overwrite the known-good backup. It now verifies the
  archive is a byte-prefix of the live file and appends only the new suffix; if the live
  file has diverged, it keeps the archive and saves the divergent bytes as a `.conflict-`
  copy. Initial archives are written atomically (temp + rename).
- **Locks are owner-safe.** A lock stolen as "stale" (e.g. a process merely paused past
  the threshold) could be cross-deleted by another process's release, reintroducing an
  index read-modify-write clobber. Each acquisition now writes a unique token and
  `releaseLock` only unlinks when the on-disk token still matches — a lock that was
  stolen/re-acquired is never deleted by the wrong owner.

## [3.10.15]

### Fixed
- **Honest usage counts.** The home screen's "Today:" line showed the *all-time* call
  count (while its tokens were today-scoped) and labeled provider calls as "tasks". It
  now shows today's calls (new `todayCalls`) and says "calls". The `cost` command's
  "Tasks run" is relabeled "Model calls" (and per-model "N tasks" → "N calls"), since the
  ledger records provider calls/attempts/reviews, not user tasks.

## [3.10.14]

### Fixed
- **A corrupt conversations index no longer wipes your conversations.** Previously a
  torn/partial `index.json` was treated like an empty store, so the next `create()`
  overwrote it with just the new conversation — orphaning every prior one. Now a corrupt
  index is detected (vs a genuinely-absent one), preserved as `index.json.corrupt`, and
  **rebuilt from the on-disk message logs** (titles/timestamps recovered), with a one-line
  `[warn]`. Every mutating op recovers first, so it can never clobber prior conversations.
- **Malformed records can't poison summaries or resume.** The JSONL readers (ledger,
  session, conversation messages) skipped invalid *JSON* but accepted syntactically-valid
  wrong-shape records (`null`, `{}`, `{"usd":"x"}`), which could crash spend summaries
  (`timestamp.slice`) or resume (`content.slice`). They now validate each record's shape
  with runtime type guards and skip bad ones.

## [3.10.13]

### Fixed
- **Accurate token accounting for multi-step opencode runs.** opencode emits per-step
  `usage` events plus a terminal `done` whose usage is the accumulated total, but the
  stream consumers used "first usage wins" — so the ledger recorded only the first
  step's tokens. `done.usage` is now authoritative (overrides earlier per-step usage)
  across all five consumers (orchestrate, panel, hedge). No-op for Claude/Codex (their
  `done.usage` matches the usage emitted alongside it).

## [3.10.12]

### Fixed
Provider adapter/parser robustness (from an adapter-layer review):
- **Claude/Codex always emit a terminal event.** If the CLI exited 0 with no parseable
  terminal line (schema change, all-noise stdout, truncated output), `run()` could finish
  silently — now it emits an honest `unknown` error ("… produced no parseable output").
- **Adapters stop after the first terminal event.** All three adapters now break stdout
  parsing once a `done`/`error` is emitted, so a stray extra result/error line can't
  produce a second terminal (or post-terminal) event.
- **The Claude parser never throws on an unexpected shape.** It validated nothing before
  iterating `message.content`; a schema change/truncated object could throw out of the
  stream. It now checks the `message`/`content`/block shapes and skips malformed blocks.
- **More auth errors are recognized.** "not logged in", "not authenticated", "please log
  in", and "api key missing/required/invalid" now classify as `auth` (so the inline
  re-login offer fires) instead of falling to `unknown` — matched precisely to avoid
  over-classifying unrelated errors.

## [3.10.11]

### Fixed
- **Multi-turn history keeps only the accepted answer.** The sequential orchestrator
  appended an assistant entry after *every* provider attempt — before it knew whether
  that attempt would fail over, escalate, time out, or be rejected by review — so failed
  attempts' error messages and superseded lower-tier drafts were replayed as context on
  later turns (and in `/goal`). It now persists exactly one assistant entry per
  successful turn: the accepted answer (with its tier/provider/model/confidence and
  native session id for resume), at the four acceptance points. Failed/inconclusive/
  cancelled turns persist no assistant entry. The ledger still records every attempt
  (cost/usage unchanged) — this only cleans the conversation history. Brings the
  sequential engine in line with the Panel/Hedge executors, which already did this.

## [3.10.10]

### Fixed
- **No internal/reviewer output or raw control-JSON ever leaks into the transcript.** Two
  fixes: (1) the cross-vendor reviewer run is now consumed internally
  (`collectProviderRun`) instead of streamed, so the reviewer's critique and its raw
  `{"verdict":…}` JSON never reach the user (its tier telemetry, ledger entry, verdict
  parsing, and "Review by/verdict" notices are unchanged); (2) the renderer now finalizes
  each attempt's prose at the tier boundary — stripping a completed attempt's trailing
  control envelope (`confidence`/`ask_user`/`verdict`) instead of raw-dumping it when the
  next attempt streams, and inserting a break so escalated attempts don't glue together.
  The common single-attempt answer still streams live and envelope-clean.

## [3.10.9]

### Fixed
- **Ctrl-C reads as a clean "Cancelled", not an error.** A user-initiated cancel emitted
  a generic `final(success:false)` and rendered the red "Failed — …" summary; cancellation
  finals now carry a `canceled` flag and render a calm "■ Cancelled" with no failure
  telemetry. In the plain REPL, Ctrl-C no longer re-prompts before the run settles (late
  output could appear after a fresh prompt).
- **`/goal` "stop" hint matches reality.** It said "Esc to stop", but only Ctrl-C is wired
  (Escape did nothing); the copy now says "Ctrl+C to stop".

## [3.10.8]

### Fixed
- **Codex/opencode timeouts are now classified as timeouts.** Only the Claude adapter
  checked `timedOut`; a timed-out Codex/opencode run was reported as an unexplained
  error, and the menu's "ran past the time limit — keep working autonomously?" offer
  (which keys off the `timeout` category) never fired. Both adapters now emit a real
  `timeout` error first, so a big task offers autonomous chunking instead of dying.
- **opencode no longer reports an empty answer as success.** A run that produced no
  text, tokens, or cost emitted a blank `done` (→ "✓ done (0 tokens)"); it now emits an
  honest error ("opencode produced no output").
- **`assess()` only reads a *trailing* confidence envelope.** It scanned for the last
  `confidence` JSON anywhere in the output, so an answer containing an *example* JSON
  with a `confidence` field could wrongly drive escalation/review. It now uses the same
  trailing-envelope contract as the renderer and question parser (no real trailing
  envelope → confidence null, never fabricated).

## [3.10.7]

### Fixed
- **Help and the no-providers error now mention opencode.** The `login` help line and
  the "no providers available" error said "claude or codex", omitting the fully-supported
  opencode. Both now say "claude, codex, or opencode". (Native-session resume copy stays
  claude/codex-only — that feature genuinely is.)

## [3.10.6]

### Fixed
- **No more dead-end when nothing is signed in.** Opening a chat (`[n]`/`[c]`/numbered)
  with no authenticated provider now shows an inline sign-in picker first — `[j] Claude
  [k] Codex [o] opencode [Enter] back` (installed providers only) — runs login, re-detects,
  and enters the chat only if you're now signed in. The old gate copy ("press Ctrl+C to
  go back", which actually needs two presses) is corrected to "type /back or press Ctrl+C
  twice".
- **`doctor` is honest about readiness.** It reported "Ready" when a provider was merely
  *installed*; now "Ready" (and the exit code) require at least one *authenticated*
  provider. Installed-but-signed-out shows "Not ready — providers are installed but none
  are signed in. Run: myshell-tools login", and `doctor --fix` re-evaluates after its
  sign-in actions.
- **Raw provider session lists only installed CLIs.** It used to always list Claude/Codex
  and could spawn a missing binary (throwing out of the menu); it now lists installed
  providers only (using their detected path) and prints an actionable message if none are
  installed.
- **Onboarding offers opencode sign-in.** The first-run sign-in step only iterated
  Claude/Codex; a user who added opencode landed on the menu still signed out. It now
  offers opencode sign-in after install too.

## [3.10.5]

### Fixed
- **First-time login now persists on Replit (you stay signed in across restarts).** On
  Replit the container home is ephemeral, and the login flow spawned the vendor CLI with
  no env override — so first-time `claude /login` / `codex login` / `opencode auth`
  wrote credentials to the default home (`~/.claude`, …) which Replit wipes on restart,
  leaving you "not signed in" again. (The existing persistent-dir resolver only kicked
  in once credentials already existed — a chicken-and-egg that never helped the *first*
  login.) New `loginPersistentEnv` creates the workspace-persistent credential dirs and
  points the vendor CLI at them *before* login — but ONLY on Replit (`isReplit`), never
  overriding an already-set `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/XDG var, and using the exact
  paths detection reads. On a normal machine it's a no-op (vendor CLIs keep their default
  homes). It only directs *where* the CLI writes its own credentials — it never reads,
  copies, or logs credential contents (the post-login verification runs the CLI's own
  status check against the scoped home with credential-file reads disabled).

## [3.10.4]

### Fixed
A self-directed audit of the menu's input/terminal handling closed the remaining issues
of the single-keypress / inherited-stdio class:
- **`readSingleKey` could hang** if stdin closed/ended mid-read (raw mode + listeners left
  attached). It now handles `end`/`close`/`error` (idempotent restore) and rejects so the
  caller falls back to line mode.
- **More inherited-stdio spawns now suspend the parent reader**: onboarding provider
  installs, the `[o]` opencode install+login, the `[u]` manual update, and every
  `doctor --fix` install/login/refresh action — so the child owns the terminal and the
  menu's single-key input is intact on return.
- **`doctor --fix`** switched its leak-prone per-prompt readline to the shared reader
  lifecycle (no stale `close` listeners).

### Changed
- **More single-keypress, fewer Enters**: the `[e] Manage` action picker and the raw-session
  provider picker now act on one keypress; the chat-loop yes/no prompts (auth-retry,
  big-task→autonomous, keep-going) and the delete confirm and the login "retry with code?"
  prompt now use the shared single-key confirm. Text entry (chat, tags, rename, numbered
  picks, token paste) stays line-based.

## [3.10.3]

### Fixed
- **Two more inherited-stdio stdin races fixed (same class as 3.10.1).** When the menu
  hands the terminal to a native CLI via inherited stdio, the parent's line reader must
  be suspended or it races the child for keystrokes. Two spots missed it: the **raw
  provider session** (`[r]`) and **Codex login** (`[k]`) — Claude login already
  suspended correctly. Both now suspend the parent's stdin for the duration and resume
  after the child (and the raw session's SIGINT handler) is fully torn down, so the
  native session owns the terminal cleanly and the menu's single-key input is intact on
  return.

## [3.10.2]

### Changed
- **Single-keypress everywhere in the menu.** The Settings screen, the mode picker,
  the onboarding mode prompt, and the verbosity picker were still line-buffered (you
  had to press a digit *then Enter*). They now use the same single-key reader as the
  home menu, so one keypress acts immediately (Enter still = keep/back, and the
  line-mode fallback for pipes/non-TTY is unchanged).

## [3.10.1]

### Fixed
- **Single-keypress menu works after an auto-update relaunch.** When the tool
  auto-updated on launch and re-launched itself, the home menu fell back to
  line-mode (you had to press a key *then Enter*) instead of acting on one
  keypress. Cause: the update/relaunch step spawned the new process with inherited
  stdio but never suspended the parent's readline, so the parent raced the
  relaunched process for stdin and its single-key reader lost. The update +
  relaunch now suspend the parent's stdin first (the same pattern the login flow
  already uses before handing the terminal to an inherited-stdio child), so the
  relaunched menu owns the TTY and one keypress acts immediately.

## [3.10.0]

### Added
- **Latency-Hedged Escalation (EXPERIMENTAL, opt-in, default OFF).** The sequential
  engine waits for a cheap-tier attempt to finish and be judged low-confidence before
  it starts a stronger escalation — so a slow weak attempt serially delays the strong
  one. Hedging hides that latency: on a high/critical-risk turn, if the primary attempt
  is still running after a short delay, it speculatively starts a flagship attempt in
  parallel and takes whichever finishes first with adequate confidence, cancelling the
  slower branch. This is uniquely a subscription-first trade: the cancelled branch costs
  **$0 in dollars** (the budget is quota + the cancelled run), so it deliberately spends
  quota to buy wall-clock — something a per-token-billed tool would never do.
  - New pure `core/hedge.ts`: `planHedge` (gates on hedge-on + injected delay port +
    high/critical risk + flagship admittable + not-already-manager) and the `runHedged`
    executor (isolated, like the Panel; exactly one final per path; aborts the loser;
    ledgers every run with real measured usage; honest notices — never claims
    cancellation "saved quota" unless the speculative truly never started).
  - Deterministic by construction: the delay is an **injected** `OrchestrateDeps.sleep`
    port, so the hedge's timing is fully testable (16 unit tests cover primary-fast,
    primary-slow-speculative-wins, primary-slow-primary-wins, and abort).
  - `Policy` gains `hedgePolicy` (`off`|`on`) + `hedgeDelayMs` (default 4000). Enable via
    Settings → `[9] Hedged escalation (experimental)`. Default off → `planHedge` returns
    null on every turn → **zero behaviour change**.

## [3.9.2]

### Changed
- **The Panel synthesizer now earns the flagship tier on hard turns.** The synthesizer
  is the final decision-maker over the candidates' answers, so on a high/critical-risk
  panel it's now admitted to the strongest model (via the same adaptive `authorizeTier`
  gate the cross-vendor reviewer uses) instead of adjudicating at the candidates' tier.
  A low-risk `always`-panel synthesizer stays at the classification tier — it never
  opens the flagship off a soft classification. (Surfaced by the live verification run,
  where a critical-risk panel synthesized at the IC tier.)

## [3.9.1]

### Added
- **The Panel and Learned Routing are now first-class Settings toggles** ([7] Panel,
  [8] Learned routing), so the two experimental engine upgrades are visible and
  reversible from the UI instead of hand-edited JSON — matching the "visible, not
  buried in config" philosophy used for Mode and Native sessions.

### Fixed
- **Settings toggles no longer drop your experimental flags.** Each toggle rebuilds the
  config object field-by-field, and the new `panel` / `learnRouting` flags weren't
  carried — so changing any setting silently reset them. Every Settings rebuild site now
  preserves both (and a regression test asserts toggling one setting keeps the others).

## [3.9.0]

### Added
- **Local Outcome Learner — learned routing from your own ledger (EXPERIMENTAL, opt-in,
  default OFF).** When several providers are signed in, the honest question on a flat-rate
  plan isn't "which is cheapest per token" (there's no per-token bill) but "which one
  actually finishes my work, fastest" — and the only ground truth is your own recorded
  outcomes. New pure `core/routing-memory.ts` (`learnProviderOrder` / `computeTierStats`)
  ranks providers per tier by observed **success rate** (tie-break: lower **latency**, then
  id), using ONLY the `success` flag and `durationMs` — never usd/tokens, never inferred
  plan/quota. It requires real signal (≥3 runs/provider and ≥2 qualifying providers) before
  it reorders anything; otherwise it returns null and routing is unchanged.
  - `route()` gained an optional learned `preferredOrder` consulted *before* the static
    order (auth-aware, and it can only reorder *reachable* providers — never strand or
    expand the candidate set). `OrchestrateDeps.learnedProviderOrder` carries the per-tier
    snapshot; orchestrate + the panel thread it into every `route()` call.
  - Opt in with `learnRouting: true` in config. The conversation layer reads the ledger
    once per session (last 500 entries) and learns each tier. With the flag off (default),
    nothing is read and routing is byte-for-byte unchanged.

## [3.8.0]

### Added
- **Parallel Subscription Panel (EXPERIMENTAL, opt-in, default OFF).** A categorically
  different engine for hard turns: instead of one model then maybe another, it runs a
  turn as a *concurrent panel* of your signed-in providers — each answers
  independently — then a cross-vendor synthesizer reconciles their answers into one.
  This is uniquely a subscription-first move: on a flat-rate plan extra model runs cost
  $0 in dollars (the budget is quota + latency), so spending several concurrent runs on
  a hard turn buys genuinely independent cross-vendor judgment a per-token-billed tool
  would never afford — and it catches single-model confident-but-wrong answers.
  - New pure `core/ensemble.ts`: `planPanel` (when/who; needs ≥2 authenticated
    providers), `buildPanelCandidatePrompt` / `buildPanelSynthesisPrompt`, and the
    `runPanel` executor (candidates run via `Promise.all`; the synthesizer streams live;
    candidate prose isn't streamed, to protect attention).
  - Opt in with `panel: true` in config → maps to `panelPolicy: 'hard-turns'` (panel on
    high/critical-risk turns). `Policy` gains `panelPolicy` (`off`|`hard-turns`|`always`)
    and `maxPanelProviders` (default 2). With `panelPolicy` absent (the default for every
    preset), `planPanel` returns null on every turn → **zero behaviour change**.
  - Honest by construction: real per-run ledger entries and measured metrics, no
    fabricated confidence/usage, no dollar-budget framing.

## [3.7.2]

### Fixed
Hardening from a comprehensive GPT-5.5 audit of the adaptive-admission system:
- **Critical — cross-vendor review no longer bypasses flagship admission or mislabels
  the tier.** The reviewer was routed with the static policy, so under Balanced/Efficient
  it ran an IC model while every event/ledger entry claimed `'manager'`. The review now
  goes through the same `authorizeTier` gate and uses the *resolved* tier everywhere —
  a high-risk review is honestly admitted to (and labelled) the flagship; a denied one
  runs and is labelled `'ic'`. It does not consume the per-turn escalation budget.
- **Cooldown now survives a rescued failover.** A provider that hit a 429 and was then
  rescued by failover into a success is still cooled down next turn (collected from the
  event stream, not just the final's error category).
- **Reviewer is chosen only from authenticated (and cooldown-filtered) providers** — no
  more routing a review to a signed-out or throttled vendor; review is skipped honestly
  when no eligible cross-vendor reviewer exists.
- **Free-plan veto is scoped to eligible candidate providers**, so a cooled-down or
  signed-out `free` provider can't veto a flagship route that would actually go to a
  different (non-free / unknown-plan) provider.
- **Honest notice when a warranted escalation is denied** (Efficient, free-plan veto, or
  spent flagship budget) instead of silently accepting a low-confidence result.
- Failover preview uses the same effective policy as the real route (correct target
  name); corrected stale `maxTier` comment.

## [3.7.1]

### Removed
- **Retired the `maxCostUsd` dollar budget guard.** On a flat-rate subscription a USD
  cap is fiction (the GPT-5.5 design review flagged it), and `maxAttempts` already
  bounds the loop against runaway. Removed the four budget gates from `orchestrate.ts`,
  deleted `src/core/budget.ts`, and dropped the `Policy.maxCostUsd` field and its preset
  values. The real scarce resource (rate-limit headroom) is handled by the per-session
  cooldown and the adaptive free-plan veto, not a dollar number.

### Fixed
- Corrected the stale `detect.ts` doc comments that claimed opencode is "authenticated
  when installed because free models need no credentials" — the implementation requires
  at least one configured credential (`opencode auth list`), which the comments now match.

## [3.7.0]

### Added
- **Adaptive flagship admission — Balanced now reaches the strongest model when a turn
  earns it.** Designed in an adversarial review by GPT-5.5 (Codex CLI) against the real
  codebase. The static `maxTier` ceiling encoded API-billing logic ("manager is
  expensive") that doesn't apply to a flat-rate subscription — the real scarce resource
  is quota/rate-limit headroom. Manager access is now an adaptive per-turn decision
  (`src/core/flagship.ts::authorizeTier`, pure):
  - **Efficient** (`never-auto`) — never auto-opens the flagship.
  - **Balanced** (`adaptive`) — earns ONE flagship pass per turn when the turn proves it
    needs one (high/critical risk, low confidence, a reviewer escalation, or an
    execution failure), **vetoed on an observed `free` plan** to preserve tight quota.
    Previously Balanced was hard-capped at the mid tier and could never reach the
    flagship — the mode most users land on now delivers "the right model for the task".
  - **Max** (`always-eligible`) — opens the flagship whenever a turn asks.
- Observed plan classification (`classifyPlan`) is now passed into orchestration
  (`OrchestrateDeps.planInfos`) so the free-plan veto uses real signal — never fabricated
  (providers whose CLI reports no plan classify to `confidence: 'none'` and don't veto).

### Changed
- `Policy` gains `flagshipAdmission` and `maxFlagshipAttemptsPerTurn`; `maxTier` is now a
  deprecated route() safety net (admission derives from it when `flagshipAdmission` is
  absent, so older configs behave unchanged). Mode descriptions / README / mode-screen
  copy updated again to state the adaptive behaviour honestly.

## [3.6.11]

### Fixed
- **Honest mode descriptions (Honesty Contract).** The mode copy claimed quality is
  "never capped — routing always escalates to the strongest model when a turn needs
  it." That was false for `Efficient` and `Balanced`, which hard-cap at the IC tier
  (`maxTier: 'ic'`) and therefore can *never* reach the manager-tier (Opus / GPT-5.5)
  model — only `Max` can. Reworded the descriptions, the mode-screen header, and the
  README so each mode honestly states its ceiling: Efficient/Balanced top out below
  the strongest model, only Max opens it. No behaviour change — the deliberate tier
  clamp is unchanged; the copy now matches the code.

## [3.6.10]

### Changed
- **Cleaner auto status line.** The always-visible mode line now summarises only the
  plans actually reported (`Mode: Max (auto · 2 Max, 1 Pro)`) and stays clean
  (`Mode: Balanced (auto)`) when no provider reports a plan — instead of nagging
  "no plan reported" on every screen. The full per-provider story (including who
  reported nothing) still lives on the mode screen's "Auto detected" breakdown.

### Fixed
- The rate-limit cooldown notice no longer repeats when an already-cooling provider
  hits another 429 (e.g. across iterations of an autonomous goal loop) — it announces
  only on first entry into cooldown.

## [3.6.9]

### Added
- **Multi-plan capacity: route around a rate-limited provider.** When a turn fails
  with a rate-limit (HTTP 429 / "quota exceeded") on a provider, that provider is put
  in a short per-conversation cooldown (5 min) so the NEXT turn prefers an un-throttled
  signed-in provider. This is where having a second subscription actually pays off —
  the load shifts instead of stalling. Orchestration already failed over *within* a
  task; this carries that memory *across* turns. It only de-prioritises and never
  strands you: if every signed-in provider is cooling down, the full set is used. When
  another provider is available you get a one-line note explaining the switch.

## [3.6.8]

### Added
- **Auto now classifies every plan and shows you the full breakdown.** A new honest
  plan taxonomy (`classifyPlan` → `{ tier, confidence }`) replaces the old loose
  substring matching: each authenticated provider's plan is classified as Max / Pro /
  Free / Unknown, and either `observed` (the CLI actually reported it) or `none` (no
  plan reported — never a guess). The mode screen now prints an **"Auto detected"**
  breakdown: one line per signed-in provider with its detected plan (or an explicit
  "no plan reported"), then the deciding rule, e.g. `→ 2 Max, 1 Pro ⇒ Max`.
- **Auto accounts for the full set of plans, including duplicates.** Multiple Max or
  Pro plans are all counted and summarised (`2 Max, 1 Pro`) rather than short-circuiting
  on the first match. The main-screen mode line now carries this reason too
  (`Mode: Max (auto · 2 Max, 1 Pro)`).

### Changed
- Auto's mode decision is now driven by the classified plan KIND (`autoModeForPlanInfos`):
  any Max → Max; else any Pro → Balanced; only Free → Efficient; no signal → Balanced.
  Behaviour is unchanged for existing single-plan users; the honesty boundary is intact
  — Codex and opencode still report no plan, so they show "no plan reported" rather than
  a fabricated tier.

## [3.6.7]

### Added
- **Auto is now a real, first-class quality mode — and the default.** Auto detection
  from your subscription already existed but was invisible and one-way (an unset
  config you could only escape by hand-editing JSON). Now it's a selectable `[4] Auto`
  in the mode screen you can always snap back to, it's marked `‹active›` when on, and
  it shows what it resolved to (e.g. `Mode: Max (auto · Claude max)`).

### Changed
- **Auto considers ALL authenticated providers, not just Claude.** Auto now gathers
  the plan from every signed-in provider and takes the strongest signal (any `max`
  plan → Max mode; only `free` plans → Efficient; otherwise Balanced). Today only the
  Claude CLI reports a `subscriptionType`; Codex and opencode expose no plan, so they
  contribute nothing until their CLIs do — auto reads whatever each CLI actually
  reports and never invents a plan.

## [3.6.6]

### Changed
- **Onboarding never forces myshell as your default shell.** The "Set myshell-tools
  as your default shell tool?" step is now opt-IN (default No): it edits your shell
  startup and can collide with another launcher you already use, so we won't do it on
  a reflexive Enter — you choose it explicitly (`y`).
- **Onboarding detects when it's already your default and skips the question.** A
  quick "Checking your shell setup…" spinner, then a `✓ Already set as your default
  shell tool.` checkmark instead of re-asking — and it won't re-run the installer.

## [3.6.5]

### Fixed
- **Pasting the sign-in code now lands in the right place.** When handing the
  terminal to an interactive child (claude's `/login` TUI, `codex login`), myshell
  used to "drain" stdin by calling `read()` in a loop first. On a TTY that left a
  pending read on fd0 that competed with the child, siphoning off the first chunk
  of a paste — so the code reached claude split/truncated, showing as "Invalid
  code" (old subcommand) or the paste landing in the wrong spot inside the `/login`
  TUI. The drain is removed; myshell now just pauses and lets the child own the
  terminal, so a pasted code arrives whole.

## [3.6.4]

### Changed
- **Claude sign-in now uses `claude /login` (the interactive TUI) instead of the
  bare `claude auth login` subcommand.** The subcommand skipped Claude's
  login-method selector (subscription / Console / 3rd-party) and used a fragile
  "Paste code here >" prompt that kept rejecting a correctly-copied code ("Invalid
  code. Please make sure the full code was copied."). `claude /login` shows the
  selector and handles the paste in Claude's own input box — the flow that actually
  works in remote/Replit shells. After signing in you exit claude (`/exit` or
  Ctrl+C) and myshell continues; success is confirmed by a real credential probe.

## [3.6.3]

### Fixed
- **myshell now recognizes an existing Claude sign-in it previously missed.** Auth
  detection relied solely on spawning `claude auth status` (10s timeout). During the
  launch-time churn (myshell's own npm self-update plus background `claude install` /
  `codex update`) that spawn can transiently fail, so myshell wrongly showed "claude:
  not signed in" — and pushed you into a sign-in you didn't need — even though you
  were signed in. Detection now falls back to the on-disk credential: if the spawn
  doesn't confirm auth but a valid (non-expired) token or API key is present in
  `.credentials.json`, you're correctly shown as signed in.
- **Emoji-free, perfectly-aligned status boxes.** Emoji (⚠️ especially) render at
  terminal-dependent widths no calculation can predict, so the right border drifted
  in some terminals. All emoji were removed from inside bordered boxes (the title and
  the per-provider status markers); the status text carries the meaning and the
  borders now align everywhere.

## [3.6.2]

### Fixed
- **Failover no longer wastes an attempt on a signed-out provider.** When several
  providers are installed but only one is signed in, a failed turn could "fail over"
  to an installed-but-signed-out provider — a doomed attempt that just reports "not
  signed in". Failover is now restricted to authenticated providers (when auth is
  known), so it escalates within the signed-in provider instead. Verified end-to-end:
  a single connected provider routes every tier correctly, and failure escalates
  in-place to a clean `final` rather than attempting an unusable vendor.
- **Clean, aligned status boxes.** Lines longer than the box width (the provider
  status lines, install commands, token-expiry notice) overflowed and broke the
  right border. `box()` is now adaptive — it grows to fit the longest line (min 56,
  cap 70 columns) so the border always aligns, and truncates anything past the cap
  with an ellipsis so no content can push past it. Emoji/wide characters are counted
  at their true display width. `panel()` got the same fix.

### Changed
- **Less redundant wording across the UI.** The menu had two adjacent "Conversations"
  headers and repeated the noun in every item under it → now a "Recent" list plus
  terse actions (Continue last / New / Resume numbered / Manage / Raw provider
  session). Dropped the redundant "— press [o] to add your provider" from the
  opencode status line (the menu already shows `[o]`), the "press n to start one"
  hint, filler like "you can run it yourself" and "now", and a stale help example
  referencing the dead `sk-ant-oat…` token.
- **Menu label "Doctor" → "Diagnose".** Says what it does instead of borrowed jargon
  (the CLI command names `doctor` / `status` / `check` are unchanged).

## [3.6.1]

### Fixed
- **claude sign-in: drain stdin before handing off, and honest guidance.** A stray
  keystroke left in the buffer before the handoff (e.g. an Enter pressed out of
  habit right after the single-key `y` confirm) was read by `claude auth login` as
  a premature empty submit — surfacing as "Invalid code. Please make sure the full
  code was copied." even when the pasted code was correct. myshell now drains any
  buffered stdin before giving the terminal to claude. The guidance was also
  rewritten to match reality: it no longer blames a "partial copy" (the claude page
  has a one-click Copy button) and no longer over-quotes a prompt; it explains the
  real failure mode (the code is single-use and short-lived) and notes you can run
  `claude /login` directly — myshell now picks up that sign-in automatically.
- **Sign-in now verifies real auth instead of trusting the exit code.** `claude auth
  login` can exit 0 even when the pasted code was rejected, so myshell would wrongly
  report success. It now re-probes credentials after the attempt and, when you're
  still not signed in, says so plainly and points to the fix (re-authorize promptly,
  or `claude /login` directly). Self-correcting rather than silently "complete".

## [3.6.0]

### Fixed
- **Autonomous-run control markers no longer leak into the chat.** During a `/goal`
  run the model emits a `GOAL_COMPLETE` / `GOAL_CONTINUE: …` status line that myshell
  parses internally — but it was showing up verbatim in the transcript. The streaming
  renderer now strips a trailing goal marker the same way it already strips the
  confidence envelope (only the trailing line; an ordinary sentence that merely starts
  with `GOAL_` is left alone). Removes a class of leaked-control-token noise.
- **myshell's own state now persists on Replit (onboarding, conversations, config,
  update cache).** myshell kept its state under `~/.myshell-tools/`, but on Replit
  the home dir is wiped on every container restart (only the workspace survives) —
  so onboarding never stuck and chat history vanished. State is now anchored to the
  persistent workspace on Replit (co-located with the cost ledger, which already
  lived there), and left under `~` everywhere else. Sign in / set up once and it
  sticks.

### Added
- **Conversations are backed up to an append-only archive.** A grow-only mirror
  under `.session-archive/` keeps every conversation log; a file is copied only
  when the live one is larger and the archive is never trimmed. So a deleted
  conversation (archived just before the delete) or a truncated/corrupted log is
  still recoverable. Best-effort and silent — synced at launch and right before any
  delete.
- **Claude stays signed in across restarts (OAuth auto-refresh).** At launch,
  myshell now refreshes Claude's OAuth token *in place* if it's expired or within
  2h of it — exchanging the stored refresh token for a fresh one at Anthropic's own
  endpoint and writing it back to Claude's `.credentials.json`. So a container
  that's been idle past the token's lifetime comes back already signed in instead
  of forcing a re-login. It's best-effort and safe: a no-op when the token is still
  valid, ≤5s and only when actually near expiry, backs up the credentials file
  before writing (restores on any failure), and backs off for 1h after a failed
  attempt so it never hammers the endpoint or wedges startup. The token is only
  ever sent to Anthropic and never copied into myshell's own store.

### Added
- **Live progress panel for autonomous (`/goal`) runs.** Each turn now shows a
  real, measured progress line — `▸ turn 3/8 · 6m 12s · 42.1k tokens this goal` —
  so you can watch overall progress move across a long autonomous run, not just
  the current turn. Every figure is measured (turn index, wall-clock elapsed, and
  tokens recorded in the ledger for this run) — no estimates, nothing fabricated.
  (myshell works sequentially toward a goal, so this is the honest equivalent of a
  "tasks in progress" view — it never claims a step is done that isn't.)
- **Live "still working" readout with a token counter.** The working indicator now
  shows a streamed-token estimate alongside the step count and elapsed time
  (`Thinking… 3 steps · ↓ ~1.2k tokens · 14s`), Claude-Code-style, so a long turn
  visibly *moves* instead of looking frozen. The `~` marks it as a live estimate
  (≈4 chars/token); the end-of-turn summary still reports the real measured tokens.
  It also revives after an answer when a tool/reasoning phase runs next, so a
  post-answer step no longer leaves a dead, frozen-looking line.

### Changed
- **Resume a Claude or Codex session from one numbered list.** The old `[i]` import
  made you pick a provider first, then a session. Now `[i]` shows a single merged
  list of your recent Claude *and* Codex sessions (newest first, each tagged), and
  a number resumes it straight into a myshell conversation — so your existing CLI
  history is one keypress away (mirrors DATA Tools' cross-tool resume). It now also
  finds sessions in the persistent `CLAUDE_CONFIG_DIR` / `CODEX_HOME` dirs, not just
  `~/.claude` / `~/.codex`.
- **Single-key main menu — no Enter.** On a real terminal the main menu now acts
  the instant you press a key (`c`, `n`, `j`, a digit, …) instead of making you
  type the letter and then press Enter. Case-insensitive, your shortcuts are
  unchanged, Ctrl-C exits, and it transparently falls back to line input when
  stdin is piped (scripts/tests behave exactly as before).
- **Clearer, consistent yes/no prompts.** The clunky `(y(enter) / n)` / `(y/N)`
  wording is replaced everywhere with `yes (enter) / no`, where the dimmed
  `(enter)` always marks the default. One rule across the whole app: **Enter (or
  `y`) means yes** — no more flipping between default-yes and default-no prompts to
  second-guess. The previously default-NO prompts ("Add opencode?", "Set as default
  shell tool?") now default to yes like the rest of setup.
- **Sensitive actions use a strict confirm.** Deleting a conversation now shows
  `yes (y) / no (n)` and has **no Enter default** — you must consciously press `y`
  or `n`, so a reflexive Enter can never delete. (Ctrl-C still aborts; an explicit
  `n`, Enter, or anything else cancels.)

### Fixed
- **A freshly published version is now seen on the very next launch.** The launch
  update-check trusts a "you're on the latest" verdict before re-asking npm; that
  window was 20 minutes, so right after `npm publish` the CLI could keep insisting
  you were current. Tightened to 30s — long enough to dedupe a rapid double-launch
  (and avoid an update→relaunch re-check loop), short enough that a new release is
  offered on the next run. A known *pending* update is still trusted for the full
  TTL (re-asking npm when we already know an update exists changes nothing).

## [3.5.4]

### Fixed
- **claude sign-in guidance now names the exact thing to look for.** After you
  authorize at claude.com, the page shows a box labelled **"Authentication code"**
  / **"Paste this into Claude Code:"** — the old guidance just said "a short code",
  so users weren't sure what to copy. The guidance now names that label and stresses
  copying the **whole** value end to end: a partial copy is the usual cause of
  claude's own `Invalid code. Please make sure the full code was copied.` error.
  No behaviour change — claude still runs its own OOB code flow and persists the
  credential itself; this is purely clearer instructions.

## [3.5.3]

### Added
- **opencode now uses the BEST model per tier from what you actually have.**
  Previously myshell ran `opencode run` with no `-m`, so even with an OpenCode Go
  subscription (Kimi/GLM/DeepSeek/…) or Zen credits, opencode fell through to a
  weak free model unless you'd configured a default yourself. Now detection reads
  your **real** model list (`opencode models`) and the router maps worker/ic/
  manager → the strongest model you have access to, passing `-m provider/model`.
  Model ids are never hardcoded (your set depends on what you've connected), and
  it's fail-safe: if no usable model is resolved it omits `-m` and lets opencode
  use its own default. (OpenCode Go models are `opencode-go/*`; Zen are
  `opencode/*` — both are detected automatically.)

### Fixed
- **No more "dead pause" between sign-ins in the setup wizard.** After signing
  into claude, the next provider's prompt (codex) appeared to hang — nothing
  happened until you pressed Enter to nudge it. Root cause: once `claude auth
  login` (inherited stdio) handed the terminal back, a bare `resume()` left the
  TTY read handle dormant, so the next keypress didn't register until Enter woke
  the stream. `resume()` now re-primes the TTY (cycles raw mode off→on) and drops
  any leftover line the child buffered, so the wizard flows straight to the next
  step.
- **claude sign-in guidance now matches reality — no more phantom localhost error.**
  The old guidance told you to expect a localhost "can't be reached" error and to
  paste the full address-bar *URL* back. Verified against claude 2.1.158, that's
  simply not what happens: `claude auth login` uses an out-of-band **code** flow
  (`redirect_uri=https://platform.claude.com/oauth/code/callback`, not localhost).
  It prints a sign-in link, you authorize, the page shows a short **code**, and you
  paste that code at claude's "Paste code here" prompt — no localhost, no error
  page. Guidance rewritten to describe exactly that. (We still use `claude auth
  login`, not `setup-token`: per the docs setup-token only prints a 1-year token
  you must export yourself and does not persist — it would leave claude unsigned-in
  or force us to store a token.)

### Changed
- **Default-yes prompts show that Enter = yes.** Yes-default confirms now read
  `(y(enter) / n)` so it's obvious pressing Enter is the same as `y`. Default-no
  prompts stay `(y/N)` (the capital marks the default) — no `enter` hint there.

## [3.5.2]

### Fixed
- **Recognises the one-time sign-in that survives container restarts (Replit).**
  Replit (and replit-tools) keep the `claude`/`codex` login in persistent workspace
  dirs and point the CLIs at them via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Those vars
  are set inside agent sessions but not always in a plain shell — so a plainly-
  launched `myshell-tools` spawned the CLIs against the *ephemeral* `~/.claude` /
  `~/.codex` and reported *"not signed in"* despite a valid sign-in. myshell now
  detects `.replit-tools/.claude-persistent` / `.codex-persistent` and points the
  spawned CLIs there (detection *and* execution) — one sign-in, remembered. Only
  redirects when the persistent dir actually holds creds, so it never breaks a
  working ephemeral login; harmless off Replit (the dirs won't exist).
- **opencode auth is now a REAL credential probe — bring your own subscription.**
  Previously opencode was reported "ready" the moment the binary was installed, on
  the assumption its free models were enough. They aren't for real work. Detection
  now runs `opencode auth list` and reports `authenticated` only when you've logged
  a real provider/subscription in (`opencode auth login` → credentials in
  `auth.json`). An unconfigured opencode shows *"not signed in — press [o] to add
  your provider"*, is offered sign-in in onboarding/doctor, and no longer counts
  toward the "any usable provider?" gate. Net: log your $10 opencode + $20 claude +
  $20 codex subscriptions into the container once, and each is used only when it's
  actually signed in.
- **opencode remembers your own provider across restarts too.** Your configured
  provider lives in XDG dirs; the same persistent-dir fix points opencode at the
  workspace XDG dirs (`XDG_CONFIG_HOME` / `XDG_DATA_HOME`) when present, gated on an
  actual `.config/opencode`, so one sign-in survives restarts.

### Changed
- **Update check runs FIRST — before the first-run welcome.** On launch the version
  check now happens ahead of onboarding, so a fresh install offers the latest
  version before walking you through setup.

## [3.5.1]

### Changed
- **Update on launch now ASKS first — and shows the version.** The first thing on
  startup is an update check; if one's available it prints `current → latest` and
  asks *"Install it now? (Y/n)"* before installing — never a silent swap. Yes →
  installs + relaunches; no → drops to the menu (press `u` anytime). Non-
  interactive sessions never auto-install (no EOF-default). Power users who want
  the old hands-off behaviour can set `autoUpdate: true` to install silently.
  Settings label is now **"Update on launch"**.

## [3.5.0]

A "one chat — automatic, honest, partner-grade" reshape. The chat tunes itself to
your subscription, talks like a real advisor, and can keep working on its own
until a job is done — without commands to learn. All changes below are unit-/
dist-verified, and the major flows were verified against live models.

### Added
- **Sustained autonomy without a command.** When a big task exceeds the per-turn
  time limit, the chat offers *"keep working on it autonomously, step by step,
  until it's done? (Y/n)"*; accept and it runs an autonomous loop on your original
  task — one concrete step per turn — surviving per-turn timeouts and writing real
  progress to disk. The model can also offer this naturally for big jobs (an
  `ask_user` block with id `keep_going`). `/goal <text>` remains the explicit
  trigger. Verified live (a multi-file auth system built across autonomous turns).
- **Subscription-aware auto mode.** Routing mode now auto-detects from your
  detected plan — Max → highest quality (opens the Opus/manager tier), else
  Balanced — so you get the right firepower with zero configuration and no
  "what subscriptions do you have?" interrogation. Verified live.
- **Mode, surfaced and one-keystroke.** The active mode shows on the home screen
  (`press m to change`), in the chat entry line, and via `/mode` in-chat — never a
  settings dive. One global knob, changeable anywhere (drift-free).
- **Advisor persona.** For a decision (tool/language/design) the chat forms an
  opinion and recommends a clear winner, surfaces a strong option you may not have
  considered, and asks only the one or two questions that change the answer —
  never the easy/obvious default, never redundant questions.

### Changed
- **Tokens, not dollars.** myshell-tools drives subscription CLIs (flat fee, no
  per-token bill), so the `$` cost estimate was fiction. The usage view is now
  tokens + a billing-agnostic efficiency *ratio*; `/goal` is bounded by turns, not
  a dollar cap; the home menu option is "Usage (tokens)".
- **Modes reframed cost → quality.** `Efficient · Balanced · Max` (internal keys
  unchanged). Quality is never capped by the knob — routing always escalates to
  the strongest model when a turn needs it; the mode only tunes how eagerly it
  reaches for the slower/stronger model.
- **Smart routing on by default.** Ambiguous, keyword-less turns are routed by a
  cheap model instead of defaulting to the IC tier (fixes under-routing of
  complex-but-unkeyworded requests). ~5–10s on those turns only; clear turns stay
  instant. Calibrated live so it doesn't over-escalate trivial chat.
- **opencode uses your own configured model.** As a subscription/free provider,
  opencode now runs whatever model you've set up (a free opencode-zen model, or a
  premium one you've added — e.g. Kimi K2); the adapter omits `-m` and the three
  guessed model ids collapse to one honest `opencode` provider-default. "Just use
  whatever opencode has" — no invented tier/price.

### Fixed (found via live audit)
- **Autonomous file work was deadlocked.** `workspace-write` passed no permission
  flag, so headless `claude -p` prompted before every write with no one to approve
  — file-mutating tasks spun and wrote nothing. Now maps to `--permission-mode
  acceptEdits`.
- **Codex couldn't run outside a git repo** — adapter now passes
  `--skip-git-repo-check`. Cross-vendor review (Claude IC ↔ Codex review) verified
  live; the prior "codex bwrap fails here" note was stale.
- **`ask_user` leaked raw JSON** when the model fenced it or sent >4 options — the
  parser/stripper now tolerate trailing code fences and clamp option lists; the
  selector renders cleanly.
- **Claude OAuth guidance** rewritten to match the real `claude auth login` flow
  (paste the address-bar URL on a localhost-callback error) — the old
  `setup-token` paste instructions were deprecated/misleading.
- Backspace in cooked-mode after a child CLI; prose glued after a tool call;
  multi-line / scaffold-polluted conversation titles; the "thinking" indicator.

## [3.4.0]

### Added
- **Tab-autocomplete for slash-commands.** At the chat prompt (and the REPL) pressing Tab completes `/help`, `/back`, `/exit` (chat) or `/help`, `/exit`, `/quit` (repl). Fires only on `/`-prefixed input so free-form prose is never mangled, and is inert on piped/non-TTY input.
- **In-chat multiple-choice questions.** The assistant can now ask you a structured question mid-conversation — choose a numbered option, multi-select, or type your own — instead of guessing when it's genuinely blocked. Modeled on Claude Code's AskUserQuestion / MCP elicitation, transported in text (the model emits an `ask_user` block; the TUI renders a selector; your answer becomes the next turn). The raw block never leaks into the transcript, and consecutive auto-asked turns are capped at 3 so it can't loop. Also: the tier prompts now research proactively when facts are uncertain or time-sensitive — you never have to tell it to look something up.

### Changed (the chat now behaves like a professional partner, not a router)
This release is a response to a live-use audit that rated the experience "pretty poor." Four root causes, all fixed:

- **Output hygiene — the chat no longer leaks its own control plane.** Every model response was told to append a `{"confidence":…,"escalate":…}` envelope and the renderer printed it *verbatim*, so users saw raw JSON after every answer — plus an unconditional `[tool] … start` wall and per-turn telemetry. The renderer now buffers the prose tail and strips the trailing envelope (reusing the brace-aware scanner) so it never reaches the user, and a new **verbosity setting** (`quiet`/`normal`/`verbose`, default `normal`, in Settings) gates tool/telemetry chrome. Failed runs now show the actionable error *suggestion* (`formatErrorMessage`, previously dead code) instead of a bare two-word message.
- **Routing/cost guardrail — "balanced" can no longer burn opus on a chat message.** A single soft keyword like "plan" forced the `manager` tier → `claude-opus-4-7`, even in balanced mode. Classification now requires a strong structural signal **or** ≥2 distinct soft signals before choosing manager (a lone soft word → `ic`). `Policy.maxTier` is enforced as a clamp in `route()`: **cost-saver and balanced cap at `ic`** (never auto-run opus), **quality-first** allows manager. The dead `maxCostUsd` budget guard now has real per-preset values ($0.50 / $2.00 / uncapped).
- **Partner persona + proactive research.** The tier prompts were pure ticket-closers ("do not pad responses"). All three now carry a senior-engineering-partner voice — warm, explains tradeoffs, asks when genuinely ambiguous — with an explicit "warmth is not length" guard so concise stays the default. They also research with judgment: proactively grounding uncertain/time-sensitive facts via web tools and skipping the obvious, so **you never have to tell it to look something up**.
- **Timeouts are no longer treated as crashes.** A manager run that blew the flat 120s limit was SIGKILL'd, recorded as **0 tokens / $0** (despite burning real subscription quota), then blindly cross-vendor re-run on the other provider. Now: a timeout is classified as `timeout` (not "unexpected error"); orchestrate **stops with actionable guidance instead of failing over**; a killed run with no usage emits an explicit *"spend unknown"* notice rather than implying it was free; every `claude -p` run carries `--max-budget-usd 25` as a runaway rail (the CLI has no `--max-turns`); and the per-run timeout is configurable via `config.timeoutMs`.

## [3.3.0]

### Changed (the update path is no longer "silently stale")
- **Fresh releases now reach users in minutes, not up to a day.** The update check cached the npm "latest" version for a flat 24h, so right after a publish — including the publishing dev's own machine — myshell kept insisting you were current for up to 24 hours. Worse, an auto-updater exists, which gave false confidence that staying current was handled. Two-part fix in `update-check.ts`: the default re-check window drops to **3h**, and — the key change — a cache that says *"you're already on the latest"* (exactly the state a new publish invalidates) is re-verified on a **20-minute** clock instead of the full TTL. A cache that already knows about a pending update is still trusted for the full window (re-asking npm teaches it nothing). This is the actual reason a freshly-published fix appeared not to ship.
- **`myshell run "…"` now surfaces updates too.** Previously only the interactive menu checked for updates; the scriptable one-shot path never did, so anyone aliasing or scripting `run` would never learn an update existed. It now prints a one-line nudge — **notify-only, on stderr, and only on a TTY** — so it can't corrupt piped stdout, spam CI logs, or (the un-polished move) swap the binary out from under a running task.
- **Auto-update failures are loud and actionable.** A failed `npm install -g` (overwhelmingly a global-dir `EACCES` permission issue) used to print one vague line and silently continue on the stale version. It now explains the likely cause and gives the exact copy-paste fixes (plain and `sudo`), and the update banner stays up — so you are never left silently behind.

## [3.2.3]

### Changed (Claude sign-in is now automatic — no token paste, no "1 year" message)
- **Claude sign-in uses `claude auth login` instead of `claude setup-token`.** This is the fix for the whole cluster of first-run complaints: the awkward "now paste the token back here" step, the "your token is valid for ~1 year, store it securely" message that read as sketchy, and tokens that "didn't save". Root cause: `setup-token` is a **CI-only** command — it prints a one-year OAuth token to stdout and *deliberately saves nothing*, expecting you to copy it into a `CLAUDE_CODE_OAUTH_TOKEN` env var. We were (mis)using it for interactive sign-in, which forced us to capture the printed token by asking you to paste it back. `claude auth login` is the real sign-in: it opens a browser, or in a container/SSH/WSL2 shows a URL and a "paste code here" prompt, and **persists the credential itself** (macOS Keychain, or `~/.claude/.credentials.json` / `%USERPROFILE%\.claude\.credentials.json`). So now you just: open the link, sign in (paste the code straight into claude if asked), done — myshell-tools captures nothing, stores no token, and shows no scary message. When you later run a task, plain `claude` uses its own stored credential (auth precedence). Verified against the actual installed `claude` CLI (`auth login`, `auth status --json`) and the official auth docs, not assumptions.
- **Auth detection unchanged and already correct** — it reads `claude auth status --json` (`loggedIn`), so a successful `auth login` immediately shows claude as "ready" with no token bookkeeping on our side.
- **Migration for older installs:** after a successful claude sign-in we now **clear** any `sk-ant-oat…` token a previous `setup-token` flow left in `~/.myshell-tools/credentials.json`. A stale long-lived token takes precedence over your fresh subscription login and would silently shadow it once it expired (a known Claude Code footgun). `doctor`/`status` still offers to refresh a legacy token that's expiring, which now migrates you onto `auth login`.

### Removed
- The token paste-capture flow (`captureClaudeTokenWithPaste`) and its now-unused stdin-reassembly plumbing (`drainExtraLines`/`drainBufferedNow`). Nothing pastes a Claude token into myshell-tools anymore.

## [3.2.2]

### Fixed (the real cause of the first-paste failure)
- **The Claude token paste now reaches `claude setup-token`'s prompt intact on the first try — for the right reason this time.** 3.2.1 hardened how a *captured* token string is cleaned up (trim, de-quote, rejoin soft-wraps), but the bytes were being lost *before* that code ever ran: the menu opens a `readline` over `process.stdin` (raw/flowing mode) for its entire lifetime, and when `claude setup-token` is spawned with inherited stdio, our readline and the child were **both draining the same TTY**. The user's first paste got split between the two consumers, so claude's code prompt saw garbage → error → the retry happened to land clean. That byte-race also explains tokens that "didn't save" (our own capture got a mangled value, so extraction found nothing to persist). Fix: the readline now **releases stdin** (`rl.pause()` + drop raw mode + pause the stream) for the entire duration of any inherited-stdio child — `claude setup-token`, the browser flow, the `--device-auth` flow — and takes it back afterward, so the child is the sole reader of the terminal. Wired through every login entry point (onboarding wizard, `[j]` Login Claude, and the in-chat auth-failure retry). The sanitizing from 3.2.1 stays as a second line of defence.
  - **Verification:** the release/reacquire logic (`LineReader.suspend`/`resume`) is unit-tested over an injected fake readline + stdin — it pauses readline, drops raw mode only on a TTY, pauses then resumes the stream in the correct order, and never throws. The one thing only a live terminal can exercise — the OS actually delivering the pasted bytes to claude's prompt instead of ours — is environment-specific and can't run in the build sandbox; verify with a real `claude setup-token` paste and report back.

## [3.2.1]

### Fixed (first-run friction)
- **Pasting the Claude token now works on the first try.** A long `sk-ant-oat…` token could arrive mangled — a stray space, surrounding quotes, terminal bracketed-paste escape markers, or a soft-wrap newline that split the value across what the terminal reports as several lines — and the capture would reject or truncate it. The paste is now aggressively normalised (`sanitizePastedToken`: strips ANSI/bracketed-paste escapes and quotes, then removes all internal whitespace — a real token contains none), and fragments that arrived split across lines are reassembled before extraction. Pure + unit-tested.
- **Demystified the "valid for ~1 year / save it securely" message.** That wording comes from Claude's own `claude setup-token` screen, not us, and read as sketchy. The sign-in guidance now sets expectations up front: it's a normal long-lived sign-in for the claude CLI (not an API key, not a password), stored on *this machine only* in `~/.myshell-tools/credentials.json` (owner-read-only), used solely to run claude, and never uploaded.

### Changed (first-run UX)
- **Single-keypress yes/no in the setup wizard.** On an interactive terminal you no longer type `y`/`n` then Enter: **Enter** accepts the `[Capitalized]` default, **y**/**n** decide instantly, any other key is ignored, and Ctrl-C still exits. Piped/non-TTY input (and the test suite) keep the exact line-based `(Y/n)` behaviour as a built-in fallback, so nothing scripted changes. Pure decision core `interpretYesNoKey` is unit-tested; the raw-mode reader (`readSingleKey`/`confirmViaKey`) is verified through an injected fake stream — listener detach/restore, raw-mode toggle, single-key resolution, the ignore loop, and echo — and falls back to a line read on any hiccup so onboarding can never be left in a broken state.

## [3.2.0]

### Changed
- **Tokens, not dollars, on the everyday UI.** myshell-tools drives your *subscription* CLIs (flat fee), so per-task dollar figures were misleading — they don't map to subscription billing and read as bloat. The control-panel status line and the live per-task output now show **real, measured token counts**; the always-on money meter ("Today: $… · session so far: $…") is gone. The `tier-done` and final-summary lines show tokens; the control-panel line shows tasks + tokens.
- **`cost` reframed as "usage & efficiency".** It now leads with real tokens (overall + per model) and a **billing-agnostic routing-efficiency ratio** ("routing picked cheaper-tier models — ~N× less than always-flagship"), which is honest under a subscription. The dollar estimate is demoted to a clearly-captioned section: **"Estimated cost — API-equivalent (list price), not your subscription bill"** — and both the routed and always-flagship figures use the **same basis** (list price × tokens), so they're apples-to-apples and internally consistent (routed never exceeds flagship). The previous mix of a provider-reported total against a list-price counterfactual could read as a contradiction; that's resolved. New pure `formatTokens` helper; `SpendSummary` gained `todayTokens`/`totalTokens`; the `tier-done` event carries real `inputTokens`/`outputTokens`.

### Added
- **Version status in the header** — the control-panel title now always tells you where you stand: `myshell-tools v3.2.0 (latest)` when current, or `myshell-tools v3.2.0 → 3.3.0 available` when a newer release exists. No more guessing whether you're up to date. (`versionStatusLabel`, pure + tested.)
- **npx-awareness** — when run via `npx myshell-tools`, the tool now detects it (`isRunningUnderNpx`) and is honest about updates: instead of silently running a global install that the next `npx` invocation would ignore (npx re-serves its own cache), it shows `Install globally to stay current: npm install -g myshell-tools@latest`. Silent auto-update and the `[u]` key are suppressed under npx because they cannot persist there.

### Changed
- The update banner and `[u]` Update-now action appear **only when a newer version is genuinely available** (unchanged), and are now also gated on the update being able to persist (not under npx).

### Performance
- **Control-panel menu no longer re-parses the ledger on every keystroke.** The spend summary is computed once and cached, and only refreshed after a task actually runs (the only time the ledger changes). Previously each keypress re-read and re-parsed the unbounded `ledger.jsonl`; on an active ledger that was tens-to-hundreds of ms of avoidable latency per keystroke. The menu hot path is now O(1) in ledger size.

### Added (experimental, opt-in)
- **Native session continuity for Claude and Codex (`nativeSessions`, default OFF).** The default path replays a compacted history block into every turn's prompt so stateless `-p`/`exec` calls have context — correct and provider-portable, but it re-sends prior context each turn. When enabled, a conversation that stays on one provider reuses that provider's *native* session and the replayed history is skipped — better context fidelity and less re-sent context (matters most for subscription rate-limit headroom; it isn't a dollar saving on a flat plan). Two id models, handled transparently:
  - **Claude** — we choose the id (the conversation id): `--session-id` to establish, `--resume` to continue.
  - **Codex** — Codex generates its own thread id; myshell-tools captures it from the `thread.started` event, persists it on the turn in the conversation log, and resumes via `codex exec resume <thread-id>` on the next Codex turn.

  If a turn routes to a provider with no active native session, it transparently falls back to history replay — so switching providers never loses context. Enable via Settings → `[4] Native sessions` or `"nativeSessions": true`.
  - **Verification:** the planning logic, the Claude/Codex CLI-arg construction, the Codex thread-id capture (contract test against the recorded transcript), and the persist-on-the-turn behavior are all unit/contract-tested. The one thing only a live CLI can prove — that resuming actually carries context — is a **gated integration test** you run with your own authenticated CLIs: `MYSHELL_NATIVE_SESSION_E2E=1 npm run test:integration` (covers both Claude and Codex). Off until you opt in; the feature defaults off until you've confirmed it on your setup. opencode has no documented resume flag yet, so it stays on history replay.
- **Per-command help.** `myshell-tools <command> --help` now shows focused, command-specific help (e.g. `login --help` explains `--code`/`--browser` and the container flow; `cost --help` is honest about subscription-vs-API billing) instead of the generic command list. Bare `--help` still shows the global list. Pure `commandHelpText`, unit-tested.
- **Self-health, surfaced automatically — no command to run.** The control panel now evaluates its own environment at startup (Node version, state-directory writability, pricing-table staleness) and shows a short, actionable warning **only when something is actually wrong**. No problems → nothing shown. Pure `evaluateHealth` (fully unit-tested) + a one-shot `probeStateWritable`. The diagnostics that were already visible in the header (provider install/auth, Claude-token expiry) are not duplicated.
- **`doctor --fix` offers to refresh an expiring Claude token.** When Claude is signed in and the stored `sk-ant-oat…` token is expired or inside the 14-day warning window, the fix pass offers a one-keypress re-login — closing the gap where the expiry was *reported* but never *actionable*.

### Changed
- **Retired the `doctor` name from the user-facing surface.** "Doctor" was borrowed jargon, and *requiring* a diagnostic command is itself friction — health now surfaces on its own (see above). The command still exists as a hidden, scriptable health check for support/CI, reachable as `status`, `check`, or `doctor` (the old name still works for muscle-memory and existing scripts); it's just no longer advertised in `--help`. Its report header now reads "environment health" rather than "doctor".

### Why
- Users running the convenience `npx` path were landing on a stale cached version (e.g. 2.8.0) and could not understand why "auto-update" never advanced them — npx ignores the global install our updater performs. The tool now names that situation and points to the durable fix instead of failing silently.

## [3.1.0]

### Added
- **Claude token lifetime awareness** — `claude setup-token` mints an `sk-ant-oat…` token valid ~1 year; the tool now records when it was captured and surfaces the remaining lifetime. `doctor` shows `token: expires ~YYYY-MM-DD (NNN days left)`, and the control-panel header shows a concise warning only when the token is near expiry or already expired (`claudeTokenStatus`, pure + tested). No nagging when the token is healthy.

## [3.0.0]

### Added
- **opencode contract test** — parser pinned to a recorded real `opencode run --format json` transcript.

### Changed
- **Wizard polish** — first-run prompts are simple `(y/n)` / `(Y/n)` instead of requiring the user to type `yes`.
- **Chat feels like a chat** — the conversation prompt is a bare `> ` (not `myshell-tools>`).
- **Claude token env-scoping** — the stored OAuth token is injected only into the provider child process env (and only when not already present), never globally exported.

### Fixed
- **Browser→code login retry** — when the browser/localhost OAuth flow can't work (containers/SSH), the login offers an interactive `--code` retry.
- **Auth-aware routing** — `route()` prefers authenticated + available providers; auth errors short-circuit (no wasted failover/escalation).

## [2.17.0]

### Security
- Credentials file (~/.myshell-tools/credentials.json) is now created with mode 0600 and its directory 0700 from the first write (atomicWrite gained an optional mode), closing a brief world-readable window on shared systems.

### Fixed
- opencode now advertises a model per tier so routing never picks a model it does not have.
- run (one-shot) now respects your Settings mode (cost-saver/balanced/quality-first) instead of always using the default policy.
- Environment detection runs once per launch (was duplicated: 6 provider --version spawns, now 3).

### Changed
- Honest labels: opencode shows ready (free models) (not signed in); doctor shows free models (no sign-in needed); the cost total is labeled provider-reported where available, otherwise estimated from list prices (Codex costs are estimates).
- README de-staled (auto-update default-on + (Y/n) + MYSHELL_NO_UPDATE documented; alpha roadmap table removed; brittle test-count claims replaced).
- Architecture guards strengthened (no-orphan logic; core purity now also forbids new Date(/node:os/node:crypto) and two weak tests made assertive.

## [2.16.0]

### Fixed
- **Login no longer garbles the screen**: the Claude code-method sign-in now runs claude setup-token with inherited stdio (clean native animation) and uses the robust paste prompt, instead of piping/echoing the output (which turned the spinner into a scroll of repeated banners). Honest error on non-zero exit.
- **Auth errors short-circuit**: a not-signed-in provider no longer burns failover + tier escalation (3 failed attempts) before surfacing — it stops after one attempt and the conversation offers inline re-login immediately.
- **Orchestrator edge cases**: reviewer escalate at the top tier no longer loops silently; a failover event is never shown when no attempt remains to honor it; reviewer revise notes are now applied on retries at any tier; the JSON-envelope scanner is string-aware (braces inside string values no longer break confidence/verdict parsing).
- **Ctrl+C x2 returns to menu even mid-task** (was dropped while a task was running).
- **No dead-end runs**: starting a task with no signed-in provider now prompts you to sign in instead of failing through the tiers.
- **Inline re-login retries with refreshed auth** (was reusing stale provider state).

### Changed
- **Conversation feels like a chat**: the per-message prompt is now a plain > (not myshell-tools>), and the verbose Classified: routing line is hidden unless MYSHELL_DEBUG is set — the model's reply is the focus.

### Security
- Credentials file is created with 0600 and its dir 0700 from the start (no world-readable race) — see 2.16.x.

## [2.15.0]

### Changed
- **Auto-update is now ON by default** (was opt-in/notify-only). New + existing clients keep themselves up to date: at launch, when a newer version is published, myshell-tools installs it and relaunches — no action needed. Disable any time via Settings -> Auto-update, by setting the env var MYSHELL_NO_UPDATE=1, or by answering n to the first-run prompt (now (Y/n), default yes). A new pure helper autoUpdateEnabled(config, env) gates this. Clients on a version BELOW 2.9.0 have no updater and must be updated once manually (npm i -g myshell-tools@latest).

## [2.14.0]

### Fixed
- **Auth-aware routing**: the orchestrator now prefers providers that are actually **signed in**. Previously it routed by a fixed preference order regardless of auth, so an installed-but-signed-out provider (e.g. claude) would be tried first, fail with `Not logged in`, and escalate — even when other providers were ready. Now `route()` picks the first authenticated+available provider for the tier (falling back to a signed-out one only if none are authenticated, where failover + inline re-login take over). `authenticatedProviders` is threaded from detection through `OrchestrateDeps`.
- **Honest login message**: the claude code-method no longer prints `✓ claude sign-in complete` when the token was not actually captured; the paste prompt reports the real outcome.

## [2.13.0]

### Added
- **Cross-vendor failover**: when a provider errors mid-task, the orchestrator now retries the same tier on another available vendor (emitting a `failover` event) before escalating — so a transient outage on one vendor doesn't sink the task. Single-provider behavior is unchanged.
- **Inline re-login on auth failure**: if a task fails because a provider isn't signed in, the conversation offers `Sign in to <provider> now and retry? (Y/n)` and, on yes, signs in and re-runs the task once. The failing provider + error category are now carried on the final event.
- **Live cost meter**: each tier-done line now shows a running `session so far: $X` total as a task progresses, not just the final total.
- **`doctor --fix`**: `myshell-tools doctor --fix` interactively offers to install missing providers and sign in to unauthenticated ones, then re-checks — instead of only reporting.
- **Raw-session escape (Unix)**: inside a raw `[r]` native session, pressing Ctrl+C twice quickly returns you to the myshell menu (best-effort, Unix-only; single Ctrl+C still reaches the native CLI). No-op on Windows.

## [2.12.0]

### Added
- **Shell quick-keys**: when you enable "set as default shell", the guarded startup hook now also defines `cm` and `mst` aliases (both open the control panel) so the menu is one keystroke from any shell prompt after you exit it. Fully reversible via `myshell-tools uninstall` (the whole block is stripped).

## [2.11.0]

### Added
- **Ctrl+C escape model in conversations** (DATA-Tools-style): while in a conversation, `Ctrl+C` once cancels the running task (or hints when idle), **twice** returns to the control-panel menu, and **three times** exits to the shell — all within a ~1.5s window. Implemented with pure, tested helpers (`countRecentInterrupts`, `interpretInterrupt`); the menu is now always one gesture away. (Escaping from *inside* a raw native `claude`/`codex` passthrough session is a separate, Unix-specific follow-up.)

## [2.10.0]

### Added
- **Claude token auto-capture (no paste step)**: `login claude --code` now tees the `claude setup-token` output and automatically extracts the `sk-ant-oat…` token — you no longer have to copy/paste it. A robust paste fallback remains for when auto-capture can't read it: it retries (up to 3×), strips surrounding quotes/whitespace, and gives a specific warning if you paste an Anthropic **API key** (`sk-ant-api…`) instead of the **OAuth token** (`sk-ant-oat…`). New pure helpers `classifyPastedSecret` / `stripPastedSecretWrapper` in `src/infra/credentials.ts`.

### Changed
- **Smarter task classifier**: tier selection is now multi-signal scored — read/lookup phrasing → worker, edit/implement verbs → ic, design/review/security/audit/architecture → manager (deterministic tie-break manager > ic > worker, default ic). Risk signals were tightened with word boundaries (no more false hits like "keyboard") and expanded (oauth, api key, private key, jwt, session → critical; production, release, rollback, terraform, kubernetes, docker, db migration → high; lint, ci, build, dependencies → medium). Still pure/deterministic; the `rationale` names every matched signal so routing stays auditable.
- **Internal**: the duplicated provider-streaming loop in the orchestrator (IC run vs cross-vendor review run) is now a single shared `streamProvider` generator — behavior-identical (no test changes), just less duplication in the most critical code path.

## [2.9.0]

### Added
- **Update notifier**: myshell-tools now checks the npm registry (once per 24h, cached) for a newer version and shows a banner `▲ Update available: <current> → <latest>  (press u)` in the control-panel header when one is found. The check is injected via a seam in tests so no real npm requests are made during the test suite.
- **`[u] Update now`**: a new Options menu entry appears only when an update is available. Pressing `u` runs `npm install -g myshell-tools@latest` (stdio inherit) and prints `✓ Updated to <latest> — restart myshell-tools to use it.` on success. The manual `[u]` path does not auto-relaunch — restart is explicit and safe.
- **Opt-in auto-update**: when `autoUpdate: true` is set in config, myshell-tools updates itself at launch (before entering the main loop) and relaunches the freshly-installed binary. On failure it prints a note and continues to the menu normally.
- **`autoUpdate` config flag** (`src/infra/config.ts`): new optional boolean field in `AppConfig`. Absent/false = notify-only banner. True = auto-update at launch. Merged over defaults so old config files are unaffected.
- **Wizard auto-update prompt**: the first-run welcome wizard now asks `Keep myshell-tools up to date automatically? (y/N)` after set-as-default, using the standard `(y/N)` convention (Enter → no).
- **Settings `[3] Auto-update` toggle**: the Settings screen (`[s]`) now lists `[3] Auto-update: on/off`; selecting it flips the flag and persists the updated config.

## [2.8.0]

### Added
- **opencode offered in first-run setup**: the welcome wizard now prompts `Add opencode? (optional — free models + more providers) (y/N)` after the claude/codex install offers, defaulting to NO. Answering `y` installs `opencode-ai` and re-detects the environment (via the injected seam, so tests stay hermetic). No opencode sign-in prompt is shown — opencode is authenticated-when-installed.

### Changed
- **Wizard uses consistent (y/n) prompts**: all yes/no prompts in `runWelcome` now follow a single convention — `(Y/n)` when Enter means yes (install offers, sign-in offers) and `(y/N)` when Enter means no (set-as-default). A new exported pure helper `parseYesNo(input, defaultYes)` handles the parsing; it never throws and is fully unit-tested.

## [2.7.1]

### Fixed
- **opencode is now connectable directly from the control panel** — the Auth section always offers `[o] Login opencode` (alongside `[j] Login Claude` and `[k] Login Codex`); when opencode isn't installed yet the entry reads `[o] Login opencode (installs it first)` and the handler installs `opencode-ai` (with consent) before running `opencode auth login`. Previously the entry only appeared after opencode was already installed, leaving no in-app path to add it.

## [2.7.0]

### Added
- **opencode sign-in / subscription UX**: the Auth section of the control panel now shows `[o] Login / add subscription (opencode)` when the opencode CLI is installed. Selecting it launches `opencode auth login` so the user can pick a provider and authentication method (Anthropic, OpenAI, opencode-zen, etc.). Free opencode models still require no login at all; myshell-tools never handles the underlying credentials.

### Fixed
- **Claude headless sign-in now actually works** (`login claude --code`, auto-selected in containers/SSH): `claude setup-token` only prints a long-lived OAuth token (`sk-ant-oat…`) — it does not apply it. myshell-tools now prompts the user to paste that token, stores it in `~/.myshell-tools/credentials.json` (mode 0600), and injects `CLAUDE_CODE_OAUTH_TOKEN` into the process environment at startup so `claude auth status` reports signed-in and `claude -p` works. Users no longer need to set environment variables manually. Note: this token must be stored as `CLAUDE_CODE_OAUTH_TOKEN`, **not** as `ANTHROPIC_API_KEY` (which causes an "invalid api key" error). Implemented in `src/infra/credentials.ts`, `src/commands/login.ts`, and startup injection in `src/cli.ts`.
- **Stale provider status after first-run onboarding**: the control panel now re-detects provider auth state after the onboarding sign-in step completes, so a provider you just authenticated (e.g. Codex via device code) immediately shows "ready" in the header instead of the stale "not signed in" state from before login.

## [2.6.0]

### Added
- **opencode provider (experimental, auto-detected)**: third provider alongside claude/codex. Auto-detected when the `opencode` CLI is installed; works immediately via opencode's free hosted models (no keys required), with premium providers (Gemini/Claude/GPT/local/etc.) available through opencode's own `auth login` — myshell-tools never handles the keys. Streams via `opencode run --format json`, reports real per-step token usage AND cost to the ledger via step_finish events (no pricing-table dependency for billing), and appears in the control-panel header + raw-session picker only when installed (no nag otherwise). Cross-vendor review stays honest by comparing the effective vendor from the `provider/model` id.
- **Routing robustness**: `route()` now prefers a model the provider CLI actually advertises (from detection) and never selects a model the CLI lacks; falls back gracefully when the advertised set matches no pricing entry, never throws. Closes a latent crash where an opencode-only setup (or any escalation that reached manager tier with opencode as the sole available provider) would throw `No models available for tier "…" with providers [opencode]` because the pricing table only had an entry for the `ic` tier. All three tiers (worker/ic/manager) now have opencode pricing entries.

## [2.5.0]

### Added
- **Conversation context continuity**: multi-turn conversations now replay a bounded, compacted slice of prior history to the model on each turn — previously every turn was sent cold/stateless, so follow-up questions had no context. The history is token-bounded (most recent 12 turns, ~6 k chars) and assistant confidence-envelopes are stripped before replay to save tokens. Implemented via `src/core/history.ts` (`compactHistory`).
- **Efficiency engine**: cost-aware cross-vendor review gating via `reviewPolicy: auto | critical-only | off` — cost-saver mode now only runs the double-spend review pass on critical-risk tasks, not every IC invocation. An optional per-task cost budget cap (`Policy.maxCostUsd`) stops escalating/reviewing once spend reaches the cap and accepts the best result so far. Implemented via `src/core/budget.ts` (`budgetExceeded`, `remainingBudget`) and the `reviewPolicy` field in `src/core/policy.ts`.
- **Container / SSH-friendly sign-in ("code method")**: when the browser/localhost OAuth callback can't be reached (Replit, Codespaces, Gitpod, SSH, or a headless Linux box), `login` now uses a no-localhost flow automatically — `codex login --device-auth` (authorize with a one-time device code) for Codex, and `claude setup-token` (paste an authorization code from claude.ai) for Claude. The environment is auto-detected; force either flow with `myshell-tools login <provider> --code` / `--browser`. A failed browser sign-in now also points at the `--code` fallback.
- **Settings → "Set as default shell" toggle**: the control-panel Settings screen (`[s]`) now exposes `[2] Set as default shell` alongside the mode picker; toggling it installs/uninstalls the real shell startup hook (same mechanism as `myshell-tools install`/`uninstall`) and only flips the stored flag when the hook write succeeds.
- **JSON-envelope deduplication**: the brace-depth `{...}` scanner used to extract model confidence/verdict envelopes was duplicated across `assess.ts`, `review.ts`, and `history.ts`. Extracted into a shared pure module `src/core/json-envelope.ts` (`lastJsonObjectWithKey`, `lastJsonObjectBoundsWithKey`); all three consumers now delegate to it. Behaviour is identical; the shared module carries its own thorough test suite.

## [2.4.0]

### Added
- **Real `install` / "set as default"**: `myshell-tools install` writes a guarded, reversible hook to your shell rc (`~/.bashrc`/`~/.zshrc` or the PowerShell profile) so new interactive shells launch myshell-tools. The control panel's "set as default? Y" now actually does this (it was a no-op hint before). `myshell-tools uninstall` removes it; opt out per-shell with `MYSHELL_SKIP=1`.

## [2.3.0]

### Added
- **Import native conversations**: `[i] Import` reads a Claude or Codex transcript (read-only) and seeds a NEW persistent myshell-tools conversation with its history — resume/continue it under orchestration. Native conversations stay native; titles use the first real prompt (system wrappers skipped).
- **Raw provider passthrough**: `[r]` opens the native `claude`/`codex` CLI directly (a native-owned session, not orchestrated).

## [2.2.0]

### Added
- **Frictionless `npx myshell-tools` first-run setup**: detects missing provider CLIs and offers to install them (Claude Code / Codex) with one keypress (never silent), then offers sign-in **only for providers not already authenticated** (no double login). One command from nothing to ready.
- README is now npx-first.

## [2.1.0]

### Added
- **Sessions-first interactive control panel** (default when you run `myshell-tools`):
  a boxed provider-status header, a recent-conversations list, and a sectioned menu
  (continue / new / resume / manage conversations, login, settings, doctor, cost).
- **Persistent conversations**: create, resume, rename, delete; auto-titled from the
  first message; stored under `~/.myshell-tools/conversations/`.
- **First-run setup** and **`login`** that delegates to each provider's own OAuth.
- **Modes**: cost-saver / balanced / quality-first policy presets, switchable in Settings.
- **TUI kit** (box / menu / bar / badge / separator / panel) — one honest visual language.

## [2.0.0]

A ground-up rebuild. The architecture is hexagonal (a pure, injected orchestration
core behind a `Provider` port), and the first principle is the **Honesty Contract**:
the tool never presents fabricated, mocked, or randomized data as if it were real —
enforced by architecture tests, not by convention.

### Added
- **Orchestration core (pure, fully unit-tested):** task classification, cost-aware
  tier routing (worker / ic / manager), output assessment, a bounded
  escalation + **cross-vendor review** loop, and a typed policy of thresholds.
- **Provider port + adapters:** Claude (`claude -p --output-format stream-json`) and
  Codex (`codex exec --json`), both via `execa` with the prompt delivered over
  **stdin**, streaming events, `AbortSignal` cancellation (child terminated < 250 ms),
  and Windows-safe process handling. Providers are **auto-detected** and routing uses
  stable model aliases so newer models are picked up without code changes.
- **Honest cost:** prefers the provider CLI's own reported cost; an append-only cost
  **ledger** and session log under `.myshell-tools/`; `myshell-tools cost` shows real spend plus an
  apples-to-apples "always-flagship" counterfactual.
- **Commands & UX:** `run`, `repl`, `doctor`, `cost`; streaming renderer with an
  honest working-indicator, theme, and banner. `NO_COLOR` / non-TTY aware.
- **Tooling:** TypeScript strict, ESLint, `node:test`, contract tests pinned to
  recorded real transcripts, and **architecture/honesty guard tests** (no-mock,
  core purity, single process-exit entry point, no fabricated metrics). CI matrix
  across Windows / macOS / Linux on Node 22 & 24.

### Notes
- Zero runtime dependencies other than `execa` (correct cross-platform process
  execution), isolated behind the `Provider` port.
- Pricing is a small, dated seed used only for estimates/counterfactuals and carries
  a staleness warning; real per-run cost comes from the provider CLIs.
