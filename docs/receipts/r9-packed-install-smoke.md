# R9.1 — Real packed-artifact install smoke

**Date:** 2026-07-14  
**Branch:** `actualize/r9-packed-install-smoke`  
**Plan gap:** CLAUDEPLAN.md R9 — matrix + packed-artifact proof (first slice: real tarball install, not dry-run only)

## Behavior

A new (or CI) runner can prove the **published-shaped** artifact works:

1. `npm pack` produces a real `.tgz` from the built package (not `--dry-run` alone).
2. That tarball installs into an **empty** temp consumer project.
3. Both bin names — `myshell-tools` and `myshell` — answer `--help` and `--version`.
4. With no visible provider CLIs / empty credential homes, `myshell-tools run …` exits non-zero with **actionable** login/provider guidance (no crash, no hang).
5. The consumer project is not corrupted (integrity marker intact; only expected `node_modules` / lockfile appear; no myshell state dir written into the project cwd).

## Change set

| Path | Role |
|------|------|
| `scripts/packed-install-smoke.mjs` | Shared smoke implementation (CI package-check + local) |
| `package.json` | `smoke:packed` script |
| `test/integration/packed-install-smoke.test.ts` | Vitest wrapper; **opt-in only** via `MYSHELL_PACKED_SMOKE=1` (skipped in default `test:integration` / multi-OS matrix) |
| `test/fixtures/support-matrix.json` | Minimal machine-readable OS/node/provider matrix |
| `test/unit/support-matrix-fixture.test.ts` | Loads + validates matrix; aligns engines/bins with package.json (stays in cheap unit suite) |
| `.github/workflows/ci.yml` | `package-check` gains expandable matrix + real pack smoke step (`MYSHELL_PACKED_SMOKE=1`) |
| `README.md` | One-line link to the support-matrix fixture |

No product `src/` behavior change in this slice.

## CI placement (important)

- **Default multi-OS×Node `test` job** runs `npm run test:integration` — packed smoke is **skipped** unless `MYSHELL_PACKED_SMOKE=1` (avoids Windows Node 20 vitest worker OOM/exit after ~55s pack+install).
- **`package-check` job** (ubuntu-latest / node 22 first; matrix keys ready to expand) is the **only** CI lane that runs the real smoke by default: dry-run forbidden-path check **plus** `npm run smoke:packed` with `MYSHELL_PACKED_SMOKE=1`.
- Support matrix documents the smoke path under `packed_artifact`.

## Intentional non-claims (later R9)

- Full golden journey (auth handoff, interactive chat, resume, cancel, multi-OS pack matrix).
- Generated matrix from live CLI version probes.
- Every provider combination / cooling / mid-chat inventory churn.

This slice establishes the **install substrate** and a checked-in expandable matrix fixture.

## Verification commands

From repo root:

```bash
npm run build
npm run smoke:packed
npx vitest run test/unit/support-matrix-fixture.test.ts
# opt-in vitest wrapper (same script as smoke:packed):
MYSHELL_PACKED_SMOKE=1 npx vitest run test/integration/packed-install-smoke.test.ts
# default integration suite must skip packed smoke:
npm run test:integration
npm run typecheck
npm run knip
```

## Rollback

Revert this branch/PR. No data migration; no version bump required for the slice itself.
