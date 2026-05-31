# Changelog

All notable changes to **myshell-tools** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- Live cross-vendor review demonstration (requires an authenticated Codex CLI).
- Cross-OS CI execution (requires a public remote).

## [3.2.0]

### Fixed (first-run friction)
- **Pasting the Claude token now works on the first try.** A long `sk-ant-oat…` token could arrive mangled — a stray space, surrounding quotes, terminal bracketed-paste escape markers, or a soft-wrap newline that split the value across what the terminal reports as several lines — and the capture would reject or truncate it. The paste is now aggressively normalised (`sanitizePastedToken`: strips ANSI/bracketed-paste escapes and quotes, then removes all internal whitespace — a real token contains none), and fragments that arrived split across lines are reassembled before extraction. Pure + unit-tested.
- **Demystified the "valid for ~1 year / save it securely" message.** That wording comes from Claude's own `claude setup-token` screen, not us, and read as sketchy. The sign-in guidance now sets expectations up front: it's a normal long-lived sign-in for the claude CLI (not an API key, not a password), stored on *this machine only* in `~/.myshell-tools/credentials.json` (owner-read-only), used solely to run claude, and never uploaded.

### Changed (first-run UX)
- **Single-keypress yes/no in the setup wizard.** On an interactive terminal you no longer type `y`/`n` then Enter: **Enter** accepts the `[Capitalized]` default, **y**/**n** decide instantly, any other key is ignored, and Ctrl-C still exits. Piped/non-TTY input (and the test suite) keep the exact line-based `(Y/n)` behaviour as a built-in fallback, so nothing scripted changes. Pure decision core `interpretYesNoKey` is unit-tested; the raw-mode reader restores the terminal and falls back to a line read on any hiccup so onboarding can never be left in a broken state.

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
