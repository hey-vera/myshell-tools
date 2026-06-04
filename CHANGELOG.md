# Changelog

All notable changes to **myshell-tools** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- Cross-OS CI execution (requires a public remote).
- Installer: PowerShell-Core profile support + PowerShell interactive guard; don't
  overwrite an existing `cm`/`mst` alias — deferred (niche / minor).
- update-check: use semver precedence for prerelease→stable (no prereleases shipped today).

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
