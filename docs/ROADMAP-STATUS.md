# ROADMAP-STATUS

Compact state record for session handoff (per docs/operating-protocol-10of10.md).
Not a narrative — update the tables, keep it terse.

_Last updated: 2026-07-02, main @ #50. All 7 contracts landed._

## Operating model
gpt-5.5 (codex) = only planner/thinker + judges. opencode-go = workers only.
Claude = launcher + merge GATE + human-decision surfacer (never edits src/·test/;
PreToolUse hook enforces). Dev = receipt-backed state machine. See
docs/operating-protocol-10of10.md and memory `operating-protocol`.
Merges land via GitHub native auto-merge (`gh pr merge <n> --auto --squash`); repo
has allow_auto_merge + delete_branch_on_merge enabled. Self-direct-merge is blocked
by the auto-mode classifier — always use `--auto` (GitHub performs the merge).

## Contract status — ALL AUTHORED + MERGED
| Item | What | Contract |
|------|------|----------|
| 5  | authoritative TurnPlan | `docs/r7-item5-turnplan-contract.md` (P1-05a..j) |
| 17 | verification→completion (+folded 20 delivery-quality) | `docs/r7-item17-completion-contract.md` (#42) |
| 11 | durable provider-neutral context | `docs/r7-item11-durable-context-contract.md` (#44) |
| 12 | async startup + provider registry (+folded 21 latency/feel) | `docs/r7-item12-provider-registry-contract.md` (#45) |
| 10 | exactly-once execution/resume | `docs/r7-item10-exactly-once-contract.md` (#46) |
| 18 | intent continuity / correction DAG (NEW) | `docs/r7-item18-intent-continuity-contract.md` (#47) |
| 19 | ask-vs-act judgment policy (NEW) | `docs/r7-item19-ask-vs-act-contract.md` (#48) |
| 13 | goal stewardship / multi-goal DAG (capstone) | `docs/r7-item13-goal-stewardship-contract.md` (#50) |

All contracts are DARK/default-off, adversarially self-challenged, with eval gate +
rollback + sliced work items (P1-*a..z) + verification receipts. NO implementation code yet.

## Vision-alignment verdict (docs/vision-alignment-5.6.md, #41)
6-item spine = right CONTROL SPINE, insufficient for "elite pro." Added behavior items.
USER DECISION 2026-07-02: 18 & 19 standalone; 20 folds→17; 21 folds→12.
Build order (dependency-driven): 17 → 11 → 12 → 10 → 13, then 8k gated, then 18/19.

## CI HEALTH — main was red at 3 masked layers (fail-fast step ordering hid them)
Discovered this session: the "10/11 SHIPPED" state had CI red at multiple layers.
CI Test job steps: typecheck → lint → knip → unit → contract → build → integration.
| Layer | Root cause | State |
|-------|-----------|-------|
| knip dead-code | 2 unused evidence exports | FIXED #43 |
| 7 unit tests | **real source regression**: dark evidence-enforcement (56cb9b7) hard-blocked `cannot-ground`, killing normal turns; + 2 fragile `/fake/cwd` tests | FIXED #43 (frontier-adjudicated `docs/adjudication-cannot-ground.md`: proceed-but-Unverified) |
| 2 Windows-unit | evidence-sink hashAfter undefined; menu-accounts ENOENT (Windows-only) | IN PROGRESS (worker) |
| 5 Linux PTY integration | benchmark readiness too weak (`scripts/pty-p0-benchmark.mjs`) — pre-existing, confirmed on origin/main | TRACKED DEBT: diagnosis `docs/pty-integration-diagnosis-5.6.md`; blind fix #49 (WIP, NOT merged) did not green Linux; needs informed re-diagnosis using captured screen-tail |

## Immediate queue
1. Finish CI green: 2 Windows-unit failures (worker, locally verifiable on Windows), then the PTY integration layer (#49 WIP — needs Linux-informed fix; treat as tracked debt if it keeps resisting).
2. Item 8k default-on flip — NOW UNBLOCKED (the cannot-ground fix was its prerequisite: evidence enforcement would have silently broken normal turns if flipped on). GATED user decision: eval green + rollback + receipt naming what it does NOT prove.
3. Implementation phase: user picks which contract to build first; opencode-go executes slices, Claude gates merges.

## Human-decision gates (never do unattended)
- User-facing default flips (8k), any paid run, force-push, deleting others' branches.
- Enforcement hook: user opens `/hooks` once (or restart) to activate.
- `/goal` re-scoped 2026-07-02 to a milestone (drive contracts + CI green + real test), no longer whole-product.

## Contracts / key docs
- docs/master-plan.md (spine) · docs/vision-alignment-5.6.md · docs/operating-protocol-10of10.md
- All 8 item contracts above · docs/adjudication-cannot-ground.md · docs/pty-integration-diagnosis-5.6.md
