# R5.1 receipt: enforce TurnCallBudget on live chat path

## Intent

Flip the live interactive turn-call budget from observe-only ledgering to
**enforce** mode so discretionary/auxiliary provider calls cannot spend the
reserved core `work` unit (or other reserved buckets). This is the R5 acceptance
/ quota contract step that makes Item-9's unit-tested `mode:'enforce'` path
authoritative on the real chat surface.

## Behavior change

| Entry point | Before | After |
| --- | --- | --- |
| `src/interface/menu.ts` foreground turn mint | `mode: 'observe'` | `mode: 'enforce'` |
| `src/interface/repl.ts` per-line turn mint | `mode: 'observe'` | `mode: 'enforce'` |

Unchanged (still the same reservations as P1-09j-b):

- `totalUnits: 64`
- `reserved.work: 1` (always)
- menu: `failover: authedCount >= 2 ? 1 : 0`, `verification: verifyOn ? 1 : 0`
- repl: `failover: 0`, `verification: 0`

**Out of scope for this slice**

- One-shot CLI `run` / eval budgets in `src/cli.ts` remain observe (not the live chat path).
- No redesign of the context compiler, TurnPlan finalizer, or capability-budget table.
- No change to purpose/bucket catalog or budgeted-provider seam.

## Semantics

In `enforce` mode, `TurnCallBudget.begin` denies when the requested bucket has
zero remaining capacity (`insufficient-<bucket>-capacity`). Discretionary calls
draw only from the discretionary pool (`totalUnits − reserved.{work,failover,verification}`);
they cannot borrow the reserved work unit. Observe mode continues to exist for
tests and non-chat entry points and still records `call-would-deny` while admitting.

## Tests

- Extended `test/unit/turn-call-budget.test.ts`:
  - `discretionary cannot spend reserved work unit when discretionary is exhausted`
    — exhausts discretionary with work still reserved, asserts denial reason,
    then proves the work bucket still admits once.
  - Source composition guard: menu + repl mint `mode: 'enforce'` with
    `work: 1` and do not mint observe on that path.

## Command evidence

From repository root on this branch (Windows, Node via local `node_modules` after `npm ci`):

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run test/unit/turn-call-budget.test.ts` | exit 0 — 41 tests passed (1 file), ~731 ms |
| `npm run lint` | exit 0 — 0 errors; 3 pre-existing `no-console` warnings in `test/integration/p0-pty-benchmark.test.ts` only |
| `npm run knip` | exit 0 — clean |

## Branch / baseline

- Branch: `actualize/r5-enforce-turn-budget`
- Baseline: origin/main at slice start (`d3074a2` — R3.1 cooling accounts)
- Files: `src/interface/menu.ts`, `src/interface/repl.ts`,
  `test/unit/turn-call-budget.test.ts`, this receipt.
)
