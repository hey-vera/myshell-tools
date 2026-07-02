# ROADMAP-STATUS

Compact state record for session handoff (per docs/operating-protocol-10of10.md).
Not a narrative — update the tables, keep it terse.

_Last updated: 2026-07-02, main @ #39._

## Operating model
gpt-5.5 (codex) = only planner/thinker + judges. opencode-go = workers only.
Claude = launcher + merge GATE + human-decision surfacer (never edits src/·test/;
PreToolUse hook enforces). Dev = receipt-backed state machine. See
docs/operating-protocol-10of10.md and memory `operating-protocol`.

## Phase status
| Item | What | State |
|------|------|-------|
| 9  | call-budget ledger | SHIPPED, observe-only |
| 8  | semantic preflight + evidence | 10/11 SHIPPED dark, default-off flag `MYSHELL_SEMANTIC_PREFLIGHT_V1` (PRs #28–#37) |
| 8k | flip semantic preflight DEFAULT-ON + retire legacy | TODO — eval runs on opencode/codex SUBSCRIPTIONS (~$0, not billed); user wants default-on; default-off was only dark scaffold |
| 5  | authoritative TurnPlan | CONTRACT authored `docs/r7-item5-turnplan-contract.md` (P1-05a..j); no code |
| 17 | verification→completion (folds in **20 delivery-quality gate**) | NO contract yet |
| 11 | durable provider-neutral context | NO contract yet |
| 12 | async startup + provider registry (folds in **21 latency/feel budget**) | NO contract yet |
| 10 | exactly-once execution/resume | NO contract yet |
| 13 | goal stewardship / multi-goal DAG | NO contract yet |
| 18 | intent continuity / correction DAG (NEW, standalone) | NO contract yet |
| 19 | ask-vs-act judgment policy (NEW, standalone) | NO contract yet |

## Vision-alignment verdict (docs/vision-alignment-5.6.md, #alignment-5.6)
6-item spine = right CONTROL SPINE, insufficient for "elite pro." Added behavior items.
USER DECISION 2026-07-02: 18 & 19 standalone; 20 folds→17; 21 folds→12.

## Immediate queue (corrected order per alignment audit)
1. codex authors delegation-ready contracts (r7-item8 rigor, dark/reversible, adversarially self-challenged, north-star drift check), one dispatch each, commit each doc to main, IN BUILD ORDER: **17 (w/ 20) → 11 → 12 (w/ 21) → 10 → 13 → 18 → 19**.
   Key dep edges: 17→10 (resume needs completion truth), 11→10 (exactly-once state lives in canonical substrate), 12→10 (provider generation stable before safe retry), 17/11→13.
2. After contracts merged: user picks implementation start. Then opencode-go executes, Claude gates merges.
3. Item 8k default-on = GATED promotion only (eval green + rollback + receipt naming what it does NOT prove); not an architecture slice, not the vision leap.

## Human-decision gates (never do unattended)
- User-facing default flips (8k), any paid run, force-push, deleting others' branches.
- Activate the enforcement hook: user must open `/hooks` once (or restart) — settings.json wasn't present at this session's start.
- `/goal` is mis-scoped to whole-product 10/10 (unsatisfiable → bloats every session). Re-scope to a milestone with north-star checks.

## Contracts / key docs
- docs/master-plan.md (spine) · docs/r7-item8-semantic-preflight-contract.md · docs/r7-item5-turnplan-contract.md · docs/operating-protocol-10of10.md
