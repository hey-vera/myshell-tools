# Releasing myshell-tools

This file defines the release boundary. Current implementation status and the active build order live in `CLAUDEPLAN.md` and `docs/ROADMAP-STATUS.md`.

## Current state

The package is not release-ready while CLAUDEPLAN R-1 through R9 remain incomplete. Do not bump or publish merely because a focused slice is green.

## Release gate

After every release-critical slice has merged:

1. Start from a fresh checkout of green `main` and run `npm ci`.
2. Run the deterministic quality command defined by R0: typecheck, lint, dead-code, build, unit, architecture, UI, contract, and deterministic integration tests.
3. Build a real npm tarball, install it into empty projects on every supported OS/Node lane, and complete the R9 golden journeys.
4. Review `main...release` for security, credential handling, product truth, migrations, generated files, support-matrix drift, and rollback.
5. Open a separate semver-bump PR only after the implementation is fully green.
6. Wait for bump/release CI and repeat the packed-artifact gate.
7. Merge and stop. The user publishes npm manually.
8. After publication, install from the registry into a clean real project, run the golden journey, and retain rollback/deprecation instructions.

## Prohibited unattended actions

Agents must not publish npm, rotate credentials, change provider accounts, widen support claims, bypass required CI, or silently convert subscription-backed execution to usage-billed API access.

## Live canaries

Live authenticated-provider canaries are optional evidence because they consume external quota and depend on volatile provider state. Deterministic fake-CLI contracts run on every PR. Run live canaries only with explicit authorization and record CLI versions, auth kind, account/profile, model inventory generation, and redacted results.
