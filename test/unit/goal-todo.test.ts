/**
 * test/unit/goal-todo.test.ts — the PURE shaping/formatting core (core/goal-todo.ts).
 * No I/O, no clock — `nowIso` is injected. Table-tested.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  capGoal,
  capRoadmap,
  roadmapProgress,
  formatTodoCount,
  ageInDays,
  isStale,
  goalGlyph,
  formatGoalRow,
  formatRoadmapLines,
  selectGoals,
  normalizeGoalTitle,
  isDuplicateGoalTitle,
  ROADMAP_LIMIT,
  goalVerdictFromOutcome,
  isGoalVerifiedDone,
  goalVerdictTag,
  type Goal,
  type GoalVerdict,
} from '../../src/core/goal-todo.ts';
import type { RoadmapItem, RoadmapItemVerdict, RoadmapItemApproach } from '../../src/core/work-contract.ts';
import type { VerifyOutcome } from '../../src/core/verify.ts';

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Redesign feed',
    state: 'parked',
    source: 'user-explicit',
    roadmap: [],
    scope: 'project',
    projectKey: 'repo#abcd1234',
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const ITEMS = (statuses: RoadmapItem['status'][]): RoadmapItem[] =>
  statuses.map((status, i) => ({ id: `r${i}`, text: `step ${i}`, status }));

describe('roadmapProgress + formatTodoCount', () => {
  it('counts done / total / blocked', () => {
    const p = roadmapProgress(ITEMS(['done', 'done', 'pending', 'blocked']));
    assert.deepEqual(p, { done: 2, total: 4, blocked: 1 });
  });

  it('formats "3/8 to-dos" (plural) and "1/1 to-do" (singular)', () => {
    assert.equal(formatTodoCount(ITEMS(['done', 'done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending'])), '3/8 to-dos');
    assert.equal(formatTodoCount(ITEMS(['pending'])), '0/1 to-do');
    assert.equal(formatTodoCount([]), '0/0 to-dos');
  });
});

describe('ageInDays + isStale', () => {
  it('computes whole days between two ISO times', () => {
    assert.equal(ageInDays('2026-06-01T00:00:00.000Z', '2026-06-11T00:00:00.000Z'), 10);
    assert.equal(ageInDays('2026-06-11T00:00:00.000Z', '2026-06-01T00:00:00.000Z'), 0); // now <= then
    assert.equal(ageInDays('garbage', '2026-06-11T00:00:00.000Z'), 0); // unparseable → 0
  });

  it('isStale at the 30-day window', () => {
    const fresh = makeGoal({ lastTouched: '2026-06-01T00:00:00.000Z' });
    assert.equal(isStale(fresh, '2026-06-20T00:00:00.000Z'), false);
    assert.equal(isStale(fresh, '2026-07-05T00:00:00.000Z'), true);
  });
});

describe('goalGlyph', () => {
  it('reuses the StatusBlock vocabulary by state', () => {
    assert.equal(goalGlyph(makeGoal({ state: 'done' })), '✓');
    assert.equal(goalGlyph(makeGoal({ state: 'failed' })), '✗');
    assert.equal(goalGlyph(makeGoal({ state: 'running' })), '◐');
    assert.equal(goalGlyph(makeGoal({ state: 'queued' })), '○');
    assert.equal(goalGlyph(makeGoal({ state: 'parked' })), '◷');
  });

  it('a parked goal with a blocked to-do gets the ⚠ flag', () => {
    assert.equal(goalGlyph(makeGoal({ state: 'parked', roadmap: ITEMS(['blocked']) })), '⚠');
  });
});

describe('formatGoalRow', () => {
  it('renders the concise themed row with a to-do count', () => {
    const g = makeGoal({ roadmap: ITEMS(['done', 'done', 'done', 'pending', 'pending', 'pending', 'pending', 'pending']) });
    const row = formatGoalRow(g, '2026-06-02T00:00:00.000Z');
    assert.match(row, /◷ Redesign feed · 3\/8 to-dos · parked · this repo/);
  });

  it('shows the blocker text and age when blocked + stale + global', () => {
    const g = makeGoal({
      scope: 'global',
      projectKey: null,
      roadmap: [{ id: 'r1', text: 'needs the windowing lib decision', status: 'blocked' }],
      lastTouched: '2026-06-01T00:00:00.000Z',
    });
    const row = formatGoalRow(g, '2026-07-05T00:00:00.000Z');
    assert.match(row, /⚠ Redesign feed/);
    assert.match(row, /blocked: needs the windowing lib decision/);
    assert.match(row, /parked \d+d ago/);
    assert.match(row, /global/);
  });
});

describe('formatRoadmapLines', () => {
  it('renders numbered [✓]/[ ]/[⚠] checkboxes', () => {
    const lines = formatRoadmapLines(ITEMS(['done', 'pending', 'blocked', 'active']));
    assert.match(lines[0]!, /1\. \[✓\] step 0/);
    assert.match(lines[1]!, /2\. \[ \] step 1/);
    assert.match(lines[2]!, /3\. \[⚠\] step 2/);
    assert.match(lines[3]!, /4\. \[ \] step 3/); // active renders as an open box
  });
});

describe('capGoal + capRoadmap (defensive shaping)', () => {
  it('caps roadmap to ROADMAP_LIMIT and normalises bad statuses', () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, text: `s${i}`, status: 'weird' }));
    const capped = capRoadmap(tooMany);
    assert.equal(capped.length, ROADMAP_LIMIT);
    assert.equal(capped[0]?.status, 'pending'); // bad status → pending
  });

  it('a malformed goal falls back to safe defaults rather than throwing', () => {
    const bad = capGoal({ state: 'nonsense', scope: 'nope', roadmap: 'not-an-array' } as unknown as Goal);
    assert.equal(bad.state, 'parked');
    assert.equal(bad.scope, 'project');
    assert.deepEqual(bad.roadmap, []);
    assert.equal(bad.version, 1);
  });

  it('a global goal never carries a projectKey', () => {
    const g = capGoal(makeGoal({ scope: 'global', projectKey: 'leak#1' }));
    assert.equal(g.projectKey, null);
  });
});

describe('selectGoals', () => {
  it('filters by state and scope without mutating the input', () => {
    const goals = [
      makeGoal({ id: 'goal_1', state: 'parked', scope: 'project', projectKey: 'p#1' }),
      makeGoal({ id: 'goal_2', state: 'running', scope: 'global', projectKey: null }),
    ];
    assert.equal(selectGoals(goals, { state: 'parked' }).length, 1);
    assert.equal(selectGoals(goals, { scope: 'global' }).length, 1);
    assert.equal(selectGoals(goals).length, 2);
    assert.equal(goals.length, 2); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Phase 2 data-model: capGoal + capRoadmap new fields
// ---------------------------------------------------------------------------

describe('capGoal — Phase 2 goalAcceptance + goalVerdict', () => {
  it('a goal WITHOUT the new fields round-trips byte-identically (regression guard)', () => {
    const g = makeGoal({
      roadmap: ITEMS(['pending', 'done']),
    });
    const capped = capGoal(g);
    // Ensure none of the new optional fields leak in when not present.
    assert.equal('goalAcceptance' in capped, false);
    assert.equal('goalVerdict' in capped, false);
    // All existing fields unchanged.
    assert.equal(capped.id, g.id);
    assert.equal(capped.title, g.title);
    assert.equal(capped.state, g.state);
    assert.deepEqual(capped.roadmap, g.roadmap);
  });

  it('goalAcceptance is preserved and capped to 400 chars', () => {
    const long = 'A'.repeat(500);
    const g = capGoal(makeGoal({ goalAcceptance: long } as Goal));
    assert.equal(g.goalAcceptance?.length, 400);
  });

  it('goalAcceptance is omitted when absent', () => {
    const g = capGoal(makeGoal());
    assert.equal('goalAcceptance' in g, false);
  });

  it('goalVerdict round-trips a valid verdict', () => {
    const verdict: GoalVerdict = {
      state: 'passing',
      receipt: '✓ tests passing (npm test, 1200ms)',
      at: '2026-06-10T12:00:00.000Z',
    };
    const g = capGoal(makeGoal({ goalVerdict: verdict } as Goal));
    assert.deepEqual(g.goalVerdict, verdict);
  });

  it('goalVerdict is omitted when verdict.state is invalid (anti-fabrication)', () => {
    const badVerdict = { state: 'invented', receipt: 'fake', at: '2026-06-10T12:00:00.000Z' };
    const g = capGoal(makeGoal({ goalVerdict: badVerdict } as unknown as Goal));
    assert.equal('goalVerdict' in g, false);
  });

  it('goalVerdict.receipt is capped to 400 chars', () => {
    const verdict: GoalVerdict = {
      state: 'reviewed',
      receipt: 'R'.repeat(600),
      at: '2026-06-10T12:00:00.000Z',
    };
    const g = capGoal(makeGoal({ goalVerdict: verdict } as Goal));
    assert.equal(g.goalVerdict?.receipt.length, 400);
  });

  it('goalVerdict with missing state is dropped, not thrown', () => {
    const noState = { receipt: 'some receipt', at: '2026-06-10T12:00:00.000Z' };
    assert.doesNotThrow(() => capGoal(makeGoal({ goalVerdict: noState } as unknown as Goal)));
    const g = capGoal(makeGoal({ goalVerdict: noState } as unknown as Goal));
    assert.equal('goalVerdict' in g, false);
  });

  it('all four valid verdict states are preserved', () => {
    for (const state of ['unverified', 'reviewed', 'passing', 'failing'] as const) {
      const g = capGoal(makeGoal({
        goalVerdict: { state, receipt: 'r', at: '2026-06-10T12:00:00.000Z' },
      } as Goal));
      assert.equal(g.goalVerdict?.state, state, `state '${state}' should be preserved`);
    }
  });
});

describe('capRoadmap + capGoal — Phase 2 RoadmapItem new fields', () => {
  it('a RoadmapItem WITHOUT the new fields round-trips byte-identically (regression guard)', () => {
    const item: RoadmapItem = { id: 'r1', text: 'step one', status: 'pending' };
    const [capped] = capRoadmap([item]);
    assert.deepEqual(capped, item);
    assert.equal('acceptanceCriterion' in (capped ?? {}), false);
    assert.equal('verdict' in (capped ?? {}), false);
    assert.equal('approach' in (capped ?? {}), false);
  });

  it('acceptanceCriterion is preserved and capped to 400 chars', () => {
    const item: RoadmapItem = {
      id: 'r1', text: 'fix the bug', status: 'pending',
      acceptanceCriterion: 'B'.repeat(500),
    };
    const [capped] = capRoadmap([item]);
    assert.equal(capped?.acceptanceCriterion?.length, 400);
  });

  it('acceptanceCriterion is omitted when absent', () => {
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending' }]);
    assert.equal('acceptanceCriterion' in (capped ?? {}), false);
  });

  it('verdict round-trips all four valid states', () => {
    for (const state of ['unverified', 'reviewed', 'passing', 'failing'] as const) {
      const verdict: RoadmapItemVerdict = {
        state,
        receipt: '✓ tests passing',
        at: '2026-06-10T12:00:00.000Z',
      };
      const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', verdict }]);
      assert.equal(capped?.verdict?.state, state, `state '${state}' should be preserved`);
    }
  });

  it('verdict is dropped when state is invalid (anti-fabrication)', () => {
    const item = {
      id: 'r1', text: 'x', status: 'pending',
      verdict: { state: 'made-up', receipt: 'lies', at: '2026-06-10T12:00:00.000Z' },
    };
    const [capped] = capRoadmap([item]);
    assert.equal('verdict' in (capped ?? {}), false);
  });

  it('verdict.receipt is capped to 400 chars', () => {
    const verdict: RoadmapItemVerdict = {
      state: 'failing',
      receipt: 'F'.repeat(600),
      at: '2026-06-10T12:00:00.000Z',
    };
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', verdict }]);
    assert.equal(capped?.verdict?.receipt.length, 400);
  });

  it('verdict.changedPaths is bounded to 20 items and each path capped to 200 chars', () => {
    const verdict: RoadmapItemVerdict = {
      state: 'passing',
      receipt: 'ok',
      at: '2026-06-10T12:00:00.000Z',
      changedPaths: Array.from({ length: 30 }, (_, i) => `${'p'.repeat(250)}/file${i}.ts`),
    };
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', verdict }]);
    assert.equal(capped?.verdict?.changedPaths?.length, 20);
    assert.ok((capped?.verdict?.changedPaths?.[0]?.length ?? 0) <= 200);
  });

  it('approach round-trips chosen + rationale + alternatives', () => {
    const approach: RoadmapItemApproach = {
      chosen: 'Use a hash map',
      rationale: 'O(1) lookup vs O(n) scan',
      alternatives: ['linear scan', 'sorted array'],
    };
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', approach }]);
    assert.deepEqual(capped?.approach, approach);
  });

  it('approach is omitted when chosen is empty', () => {
    const approach = { chosen: '', rationale: 'some rationale', alternatives: [] };
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', approach }]);
    assert.equal('approach' in (capped ?? {}), false);
  });

  it('approach.chosen and rationale are capped to 400 chars each', () => {
    const approach: RoadmapItemApproach = {
      chosen: 'C'.repeat(500),
      rationale: 'R'.repeat(500),
    };
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', approach }]);
    assert.equal(capped?.approach?.chosen.length, 400);
    assert.equal(capped?.approach?.rationale.length, 400);
  });

  it('approach.alternatives is bounded to 8 items and each capped to 160 chars', () => {
    const approach: RoadmapItemApproach = {
      chosen: 'best',
      rationale: 'why',
      alternatives: Array.from({ length: 12 }, (_, i) => 'A'.repeat(200) + i),
    };
    const [capped] = capRoadmap([{ id: 'r1', text: 'x', status: 'pending', approach }]);
    assert.equal(capped?.approach?.alternatives?.length, 8);
    assert.ok((capped?.approach?.alternatives?.[0]?.length ?? 0) <= 160);
  });

  it('verdict.state: all invalid values are dropped without throwing', () => {
    for (const bad of ['', 'PASSING', 'true', null, 42, {}]) {
      const item = {
        id: 'r1', text: 'x', status: 'pending',
        verdict: { state: bad, receipt: 'r', at: '2026-06-10T00:00:00.000Z' },
      };
      assert.doesNotThrow(() => capRoadmap([item]));
      const [capped] = capRoadmap([item]);
      assert.equal('verdict' in (capped ?? {}), false, `invalid state=${JSON.stringify(bad)} must be dropped`);
    }
  });

  it('a goal with new roadmap fields round-trips through capGoal unchanged', () => {
    const verdict: RoadmapItemVerdict = {
      state: 'passing',
      receipt: '✓ tests passing (npm test, 800ms)',
      at: '2026-06-10T12:00:00.000Z',
      changedPaths: ['src/core/goal-todo.ts'],
    };
    const approach: RoadmapItemApproach = {
      chosen: 'functional update',
      rationale: 'immutable, testable',
    };
    const g = makeGoal({
      goalAcceptance: 'All tests green and board shows correct verdicts',
      goalVerdict: {
        state: 'passing',
        receipt: '✓ tests passing',
        at: '2026-06-10T12:00:00.000Z',
      } as GoalVerdict,
      roadmap: [{
        id: 'r1', text: 'implement cap', status: 'done',
        acceptanceCriterion: 'capRoadmapItem handles all 4 verdict states',
        verdict,
        approach,
      }],
    } as Goal);
    const capped = capGoal(g);
    assert.equal(capped.goalAcceptance, g.goalAcceptance);
    assert.deepEqual(capped.goalVerdict, (g as Goal).goalVerdict);
    assert.deepEqual(capped.roadmap[0]?.verdict, verdict);
    assert.deepEqual(capped.roadmap[0]?.approach, approach);
  });
});

// ---------------------------------------------------------------------------
// Verified-done gate helpers (Elite-partner Part 3) — the honesty boundary
// ---------------------------------------------------------------------------

describe('goalVerdictFromOutcome — verdict state comes ONLY from a real VerifyOutcome', () => {
  const at = '2026-06-07T12:00:00.000Z';

  it('copies the four-state VERBATIM (passing) + an honest receipt', () => {
    const outcome: VerifyOutcome = {
      verified: 'passing',
      changedFiles: 3,
      changedPaths: ['a.ts', 'b.ts', 'c.ts'],
      testCommand: 'npm test',
      testRun: { outcome: 'green', output: '', durationMs: 4200 },
    };
    const v = goalVerdictFromOutcome(outcome, at);
    assert.equal(v.state, 'passing');
    assert.equal(v.at, at);
    assert.match(v.receipt, /tests passing/);
  });

  it('failing stays failing — never upgraded', () => {
    const outcome: VerifyOutcome = {
      verified: 'failing',
      changedFiles: 1,
      testCommand: 'npm test',
      testRun: { outcome: 'red', output: 'AssertionError', durationMs: 900 },
    };
    const v = goalVerdictFromOutcome(outcome, at);
    assert.equal(v.state, 'failing');
    assert.match(v.receipt, /failing/);
  });

  it('unverified (empty diff) stays unverified with its honest note', () => {
    const outcome: VerifyOutcome = { verified: 'unverified', changedFiles: 0, note: 'no code change to verify' };
    const v = goalVerdictFromOutcome(outcome, at);
    assert.equal(v.state, 'unverified');
    assert.match(v.receipt, /unverified/);
  });
});

describe('isGoalVerifiedDone — only passing/reviewed qualify', () => {
  const mk = (state: GoalVerdict['state']): GoalVerdict => ({ state, receipt: 'r', at: 'x' });
  it('passing ⇒ true, reviewed ⇒ true', () => {
    assert.equal(isGoalVerifiedDone(mk('passing')), true);
    assert.equal(isGoalVerifiedDone(mk('reviewed')), true);
  });
  it('failing ⇒ false, unverified ⇒ false (never done on a weak/absent signal)', () => {
    assert.equal(isGoalVerifiedDone(mk('failing')), false);
    assert.equal(isGoalVerifiedDone(mk('unverified')), false);
  });
});

describe('normalizeGoalTitle — fold case/punctuation/whitespace for dedup', () => {
  it('lowercases, folds punctuation to spaces, collapses whitespace', () => {
    assert.equal(normalizeGoalTitle('  Redesign the FEED!! '), 'redesign the feed');
    assert.equal(normalizeGoalTitle('Build—auth/login'), 'build auth login');
    assert.equal(normalizeGoalTitle(''), '');
  });
});

describe('isDuplicateGoalTitle — smart near-duplicate guard for auto-stage', () => {
  it('exact normalized match ⇒ duplicate', () => {
    assert.equal(isDuplicateGoalTitle('Redesign the feed!', ['redesign the feed']), true);
  });
  it('strong token overlap ⇒ duplicate (Jaccard ≥ 0.7)', () => {
    assert.equal(
      isDuplicateGoalTitle('Finish the frontend skeleton', ['finish the frontend skeleton work']),
      true,
    );
  });
  it('a genuinely different goal ⇒ not a duplicate', () => {
    assert.equal(
      isDuplicateGoalTitle('Add OAuth login', ['Redesign the video feed', 'Write the deploy script']),
      false,
    );
  });
  it('empty candidate or empty existing list ⇒ false', () => {
    assert.equal(isDuplicateGoalTitle('', ['anything']), false);
    assert.equal(isDuplicateGoalTitle('Something', []), false);
  });
});

describe('goalVerdictTag — honest board tag, only when a real verdict exists', () => {
  it('returns undefined when the goal has no verdict (never fabricated)', () => {
    assert.equal(goalVerdictTag(makeGoal()), undefined);
  });
  it('maps each four-state to its honest tag', () => {
    const tag = (state: GoalVerdict['state']) =>
      goalVerdictTag(makeGoal({ goalVerdict: { state, receipt: 'r', at: 'x' } }));
    assert.equal(tag('passing'), '✓verified');
    assert.equal(tag('reviewed'), '~reviewed');
    assert.equal(tag('failing'), '✗failing');
    assert.equal(tag('unverified'), '⚠unverified');
  });
});
