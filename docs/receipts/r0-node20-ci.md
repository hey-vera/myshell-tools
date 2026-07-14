# R0 — Node 20 CI matrix alignment

**Date:** 2026-07-14
**Branch:** `actualize/r0-node20-ci`
**Plan gap:** CLAUDEPLAN.md R0 — declared `engines.node` vs CI coverage

## Decision

Keep `package.json` `engines.node` at `>=20.0.0` and **add Node 20** to the CI test matrix so declared support is exercised. Do not raise the engine floor.

## Change

- `.github/workflows/ci.yml` test job matrix: `node: [22, 24]` → `node: [20, 22, 24]`
- OS matrix unchanged: windows / macos / ubuntu

## Intentional non-changes

- **Coverage** and **package-check** (and any other single-version jobs) remain on **Node 22** — no need to multiply those lanes for engine alignment; the multi-OS/multi-node **test** matrix is the support proof.
- `package.json` engines, `src/`, and `test/` untouched.

## Verification

- Matrix YAML reads `node: [20, 22, 24]`
- `git diff --check` clean
