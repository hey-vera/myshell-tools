# OS1 — Multi-OS packed install smoke in CI

**Date:** 2026-07-15  
**Branch:** `product/os1-multi-os-pack-smoke`  
**Plan gap:** Real users need multi-OS proof; R9.1 package-check was Ubuntu-only

## Behavior

CI proves the published-shaped artifact installs and bins work on:

| OS | Job name (status-check context) | Branch protection | Contents dry-run |
|----|----------------------------------|-------------------|------------------|
| Ubuntu | `Package check (ubuntu-latest / node 22)` | **Required** (unchanged exact name) | Yes + `smoke:packed` |
| Windows | `Package smoke (windows-latest / node 22)` | **Not required** (optional until protection update) | Smoke only |
| macOS | `Package smoke (macos-latest / node 22)` | **Not required** (optional until protection update) | Smoke only |

All three use Node **22**, `needs: test`, then `npm ci` → `npm run build` → `npm run smoke:packed` with `MYSHELL_PACKED_SMOKE=1`.

## Why not `strategy.matrix` on the required job

GitHub Actions appends matrix keys to job `name` (e.g. `Package check (…)` becomes something like `Package check (…) (ubuntu-latest, 22)`). That would **break** the required main-branch status check named exactly:

`Package check (ubuntu-latest / node 22)`

So:

- Keep **`package-check`** as a dedicated non-matrix job with that exact `name:`.
- Add **`package-smoke-windows`** and **`package-smoke-macos`** as separate non-matrix jobs with distinct names.

**Do not** add win/mac names to branch protection without an explicit, documented protection change.

## Change set

| Path | Role |
|------|------|
| `.github/workflows/ci.yml` | Keep ubuntu `package-check`; add win/mac `package-smoke-*` jobs |
| `test/fixtures/support-matrix.json` | Document multi-OS packed smoke jobs + required vs optional |
| `docs/receipts/os1-multi-os-pack-smoke.md` | This receipt |

No product `src/` behavior change.

## Intentional non-claims

- Full golden journey (auth handoff, interactive chat, resume, cancel) on every OS.
- Making win/mac package smoke **required** status checks (branch protection left alone).
- Expanding pack dry-run contents verification to Windows/macOS (bash-oriented step stays on ubuntu).

## Verification

```bash
# Local (any OS with Node 22):
npm run build
npm run smoke:packed
npx vitest run test/unit/support-matrix-fixture.test.ts

# CI: after push, confirm three job names appear and ubuntu required check still matches protection.
```

## Rollback

Revert this branch/PR. No data migration; no version bump required for the slice itself.
