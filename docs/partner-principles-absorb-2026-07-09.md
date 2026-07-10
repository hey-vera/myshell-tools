# Partner principles absorb (2026-07-09)

**Status:** CODE COMPLETE on main (2026-07-10) — #142–#147; human smoke still open  
**North star:** one chat to rule them all (multi-goal, subscription-native).  
**Not:** loop.sh clone, Claude Projects admin, cron constitution product, API-key theater.

| Slice | PR | Landed |
|-------|-----|--------|
| Spec + board | #142 | yes |
| Partner laws | #143 | yes |
| Account weight UX | #144 | yes |
| Routing receipts | #145 | yes |
| Goal rewatch+ | #146 | yes |
| Done=check binding | #147 | yes |

## What we steal (Fable / elite-partner principles) — improved

| Principle | Product meaning here | Not this |
|-----------|----------------------|----------|
| **Visible dispatch** | After a turn (or on demand), user can see *who ran it* and *why* (provider · model · effort · account · short reason). | Dumping full RouteTrace every turn; fake $ costs. |
| **Done = check** | Terminal “done” / goal settle only with verify/receipt truth. Model confidence never promotes done. | Maker self-grades; “looks good” green. |
| **Don’t always burn strongest** | Auto/brain already tiers; surface the reason so heaviness feels intentional. | Hidden routing that always picks Opus-class. |
| **Standing goals rewatch** | On resume/open, partner re-orients parked/blocked goals and can act — not a silent museum. | One-shot dim line then forget. |
| **Maker ≠ checker** | Verify/repair path independent of the writer’s prose. | Second model always (costly); role theater without verify. |
| **Pressure honesty** | Accounts priority/weight + capacity/cooldown are real and discoverable; unknown stays unknown. | Fake quota %; ambient “Pro detected.” |
| **Anti-goldplate / anti-overplan** | Short always-on laws: ship the minimal correct change; don’t invent plans for trivial turns. | Wall-of-text constitution / CLAUDE.md product surface. |

## Improve, don’t clone

1. **Multi-concern first** — parallel goals are a superpower; isolation is internal (DAG/board/routing), not “one project per topic.”
2. **Built through conversation** — preferences/taste/memory absorb work; user does not pre-load brand kits.
3. **Subscription seats are inventory** — `priorityWeight` balances *within* a provider’s accounts today; product copy must say that honestly. Provider order remains plan/capacity/auth driven unless we later wire aggregate seat weight (separate, explicit PR).
4. **Laws as behavior + tiny prompt** — verify pipeline + 4–6 lines in system prompt; not a user-managed constitution file.

## Seam audit (code, main @ 3.166.0)

See live code; summary:

| Feature | Maturity | Primary seams | Honest gap |
|---------|----------|---------------|------------|
| Routing receipts | Partial | `auto-brain` notice, evidence tokens, verbose tier, `RouteDecision`/`RouteTrace` | No unified end-of-turn provider/model/effort/account/**why** line |
| Done = check | Strong for code | `verify`, quality gate, goal verified-done | Named law missing; `doneCondition` often null; non-code claims weak |
| Goal rewatch | P0 shipped | `resume-goal-orientation`, board, recap | One-shot print; weak mid-session / first-turn context inject |
| Account weight | Seat routing live | `priorityWeight` + `selectSubscriptionAccount` | UI/copy may imply provider-level heaviness; weights don’t pick providers |
| Partner laws | Persona + honesty | `prompt.ts`, verify honesty | No compact anti-goldplate / done=check law block |

## Implementation DAG (thin green PRs)

Independent roots launch in parallel (separate worktrees). Serialize only on shared hot files.

```
[PR-A partner laws] ──────────┐
[PR-B routing receipts] ──────┼──► green CI → merge → main
[PR-C account weight UX] ─────┘
         │
         ▼ (after A/B land or non-conflicting files)
[PR-D done=check binding]  (accept-stage + goal settle; bind doneCondition)
[PR-E goal rewatch+]       (mid-session / first-turn context inject)
```

### PR-A — Built-in partner laws (prompt)
- **Objective:** Append a short always-on `PARTNER_LAWS` block (≤8 lines) to elite system prompts: done only with check; no gold-plate; no overplan trivial turns; grounded claims or label Unverified; don’t burn max effort without reason; multi-goal awareness.
- **Allowed:** `src/core/prompt.ts`, `src/core/tool-state.ts` (if natural), unit tests under `test/unit/*prompt*`
- **Non-objectives:** New user-facing constitution UI; loop.sh scheduling; long persona walls.
- **Verify:** `npm run typecheck`; `npm test -- --test-name-pattern prompt` (or full suite if cheap); existing golden prompts if any updated.

### PR-B — Turn routing receipts
- **Objective:** One post-turn (or end-of-work) chrome line: `provider · model · effort · account? · why` from *actual* run fields. Prefer extending existing final/receipt path; reuse auto-brain reason + capabilityReasons when present.
- **Allowed:** `src/core/types.ts` (minimal field), `src/core/orchestrate.ts` / accept path that owns final, `src/interface/render.ts`, `src/interface/ui/reduce.ts` (+ tests). Avoid rewriting the router.
- **Non-objectives:** Second router; fake costs; dumping full RouteTrace by default.
- **Verify:** unit tests for format helper; typecheck; full test if touching orchestrate.

### PR-C — Account heaviness UX honesty
- **Objective:** Accounts UI copy + optional help line: priority/weight balances **within-provider seats** under normalized load; sticky high-weight; does not alone pick Claude vs Codex. Prove routing still uses weights (`selectSubscriptionAccount` tests if missing).
- **Allowed:** `src/interface/menu-*-accounts.ts`, short docs in PROJECT-BOARD/checklist, tests for routing if gap.
- **Non-objectives:** Redesigning Auto to weight *providers* by account priority (that’s a later explicit product decision).

### PR-D — Done = check binding
- **Objective:** Fill `doneCondition` from semantic preflight when present; ensure goal settlement / terminal done cannot skip verify when work claimed completion. Align copy with partner laws.
- **Allowed:** `src/core/accept-stage.ts`, preflight binding, focused tests; touch `menu.ts` only if goal gate gap is real and minimal.
- **Non-objectives:** Full r7 CompletionResultV1 completion theater.

### PR-E — Goal rewatch+
- **Objective:** Lightweight standing rewatch: on resume *and* when re-entering chat after idle (or first model turn of session), inject orientation summary into partner context so the model can act; keep board/recap truthful.
- **Allowed:** `src/core/resume-goal-orientation.ts`, menu/App wiring, tests.
- **Non-objectives:** Full goal-steward re-audit every open (too heavy).

## Definition of Done (wave)
- Green CI on each PR; squash merge only when green + vision-aligned.
- Independent gate: typecheck + lint + knip + full test + build on the worktree before merge trust.
- Checklist + PROJECT-BOARD updated; no overclaim of human Replit smoke.
- Version bump only when user wants a release cut (not mid-wave).

## Out of scope this wave
- npm publish (user)
- P1.5 model ghost, deep forge create/review, P2.4 shared deps builder
- loop.sh cron product, Claude Projects upload UX
