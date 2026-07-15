# U5 — Hermetic multi-chat handoff smoke

**Date:** 2026-07-15  
**Branch:** `agent/u5-multichat-smoke`  
**Plan:** `docs/EXTERNAL-READINESS-PLAN.md` Phase 3 U5

## Behavior

Adds a **quota-free** smoke that imports real package modules (via `tsx` on source, same pattern as `auto-brain:preview`) and proves multi-chat handoff **invariants** without live providers:

| # | Invariant | Mechanism |
|---|-----------|-----------|
| 1 | Leave-chat / per-conversation abort does not kill other chats’ workers | `goal-worker-registry`: `registerGoalWorker`, `abortConversationGoalWorkers`, counts |
| 2 | Fenced lease reclaim without trusting PID alone | `goal-job-store` temp root + injectable `isOwnerAlive`; claim → expire TTL → reclaim with live PID |
| 3 | Home work-status chips pure format | `formatConversationWorkStatus` known shapes |
| 4 | Release TUI ownership → claimable | `releaseTuiOwnership` then worker `claim` |

Command: `npm run smoke:multichat` → `node --import tsx/esm scripts/multichat-handoff-smoke.mjs`  
Exit **0** only if all checks pass.

## Change set

| Path | Role |
|------|------|
| `scripts/multichat-handoff-smoke.mjs` | Hermetic smoke (18 checks) |
| `package.json` | `"smoke:multichat"` script only |
| `docs/receipts/u5-multichat-handoff-smoke.md` | This receipt |
| `docs/EXTERNAL-READINESS-PLAN.md` | U5 checkbox |
| `docs/SUPPORT-MATRIX.md` | One-line hermetic smoke note |

No `src/` product change. No version bump. No publish.

## Intentional non-claims (does **not** prove)

- Live provider auth, chat, streaming, or paid quota
- Full interactive PTY menu (`/back`, Esc) or real `ensureWorkerProcess` spawn
- Cross-process worker reclaim under real OS contention
- Detached free-loop multi-turn end-to-end

Those remain **owner human smoke** (U12 H4/H5) and unit/integration coverage elsewhere.

## Verification (command evidence)

```text
> npm run smoke:multichat

=== multichat handoff smoke (U5, hermetic) ===

1) leave-chat isolation (goal-worker-registry)
  [PASS] registry-setup — counts A=2 B=1 total=3
  [PASS] abort-conv-A-scoped — aborted=2 A1.aborted=true A2.aborted=true
  [PASS] conv-B-still-live — B.aborted=false B.count=1
  [PASS] leave-chat-no-abort — leave live; other live (no abort on leave path)

2) fenced lease reclaim (goal-job-store temp dir)
  [PASS] claim-mints-fence — leaseId=… gen=1 exp=…
  [PASS] claim-denied-while-lease-live — second claim=null
  [PASS] reclaim-on-expired-lease-not-pid — owner=worker pid=99 gen=2 newFence=true

4) releaseTuiOwnership handoff (goal-job-store)
  [PASS] worker-blocked-while-tui-holds — claim while TUI holds=null
  [PASS] release-tui-clears-claim — n=1 status=pending owner=undefined
  [PASS] worker-claims-after-release — owner=worker pid=200

3) work-status chips (menu-render pure)
  [PASS] chip:2 working …
  [PASS] chips-all — 7/7 shapes match

---
multichat handoff smoke: PASS (18 checks)
Note: does not prove live auth/chat, PTY menu, or real detached worker spawn.
```

**Exit code:** 0

## Rollback

Remove `scripts/multichat-handoff-smoke.mjs`, drop `smoke:multichat` from `package.json`, revert plan/matrix/receipt. No data migration.
