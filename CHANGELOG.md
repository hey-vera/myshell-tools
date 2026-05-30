# Changelog

All notable changes to **myshell-tools** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- Live cross-vendor review demonstration (requires an authenticated Codex CLI).
- Cross-OS CI execution (requires a public remote).
- First npm publish.

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
