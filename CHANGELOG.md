# Changelog

All notable changes to **myshell-tools** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- Live cross-vendor review demonstration (requires an authenticated Codex CLI).
- Cross-OS CI execution (requires a public remote).
- First npm publish.

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
