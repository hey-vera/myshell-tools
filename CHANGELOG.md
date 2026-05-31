# Changelog

All notable changes to **myshell-tools** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- Live cross-vendor review demonstration (requires an authenticated Codex CLI).
- Cross-OS CI execution (requires a public remote).
- First npm publish.

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
