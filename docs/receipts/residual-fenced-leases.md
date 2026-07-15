# Receipt — Residual: fenced goal-job leases

**Date:** 2026-07-15  
**Branch:** `product/residual-fenced-leases`  
**Baseline:** `origin/main`  
**Scope:** Renewable fenced leases on durable goal jobs so reclaim does not trust PID alone. **No version bump.**

## Defaults (shipped)

| Knob | Value |
| --- | --- |
| Lease TTL | `DEFAULT_GOAL_JOB_LEASE_TTL_MS` = 3 minutes |
| Worker renew interval | `DEFAULT_GOAL_JOB_LEASE_RENEW_MS` = 45s (30–60s band) |
| Reclaim when | lease **expired** **or** owner PID **dead** |
| Schema | job v1 **additive** optional: `leaseId`, `leaseGeneration`, `leaseExpiresAt` |
| Stolen mid-run | worker aborts attempt, **does not** mark terminal — job stays claimable |

## Behavior

1. **`applyClaim`** mints `leaseId`, bumps `leaseGeneration` (0 → 1 on first claim), sets `leaseExpiresAt = now + TTL`.
2. **`canClaimGoalJob`** — pending always; claimed/running reclaimable if owner dead **or** lease expired (legacy jobs without `leaseExpiresAt` keep PID-only hold).
3. **`renewLease` / `applyRenewLease`** — fence match required; wrong generation / id / expired → null.
4. **`isLeaseHeld`** — matching fence + not expired + claimed/running.
5. **`applyReleaseForHandoff`** — already rebuilt without claim fields; now also clears lease fence (omitted on write).
6. **Worker loop** — renews lease while executor runs; renew failure aborts; post-run fence check skips `markTerminal` if lease lost.

## Files

| Path | Role |
| --- | --- |
| `src/infra/goal-job.ts` | lease fields, TTL/renew constants, `isLeaseExpired`, `isLeaseHeld`, `applyClaim` lease mint, `applyRenewLease`, `canClaim` expiry |
| `src/infra/goal-job-store.ts` | claim writes lease (`randomUUID`); `renewLease` |
| `src/commands/worker.ts` | background renew; stolen-lease abort without terminal |
| `test/unit/goal-job.test.ts` | pure lease + expiry reclaim + wrong-gen renew |
| `test/unit/goal-job-store.test.ts` | store expiry reclaim + renewFence; handoff clears lease |

## Non-goals

- Version bump / CHANGELOG release line (residual only).
- Distributed consensus beyond single-host file + lock.
- Changing job `version` field (stays `1`; fields optional).

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (3 pre-existing `no-console` warnings in `p0-pty-benchmark.test.ts` only) |
| `npm run knip` | exit 0 |
| focused | `test/unit/goal-job.test.ts` (28) + `test/unit/goal-job-store.test.ts` (17) green |
| `npm test` (`test/unit` + `test/arch`) | **9333 passed**, 15 skipped, 0 failed |
