/**
 * test/unit/goal-proposal.test.ts — the PURE proposal renderer (core/goal-proposal.ts).
 *
 * Locks in the Phase-2 headline: a staged plan renders a CONFIDENT proposal (vision
 * line · goal titles · to-dos · the dependency cause→effect phrase · the chosen
 * approach over alternatives), the dependency phrasing is plain-English, the
 * auto-stage note names what landed + asks the go-ahead, the heads-up surfaces 1–2
 * real findings (never fabricated), and EVERY empty/none/clarify input degrades to
 * '' / [] (the fail-soft additive contract). No I/O, no clock — table-tested.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  formatGoalProposal,
  formatDependencyPhrase,
  formatHeadsUp,
  formatAutoStageNote,
  type ProposalDroppedCounts,
} from '../../src/core/goal-proposal.ts';
import type { GoalPlan } from '../../src/core/goal-plan.ts';
import type { SystemModel } from '../../src/core/understanding.ts';

const STAGED_PLAN: GoalPlan = {
  judgment: 'stage',
  vision: 'ship the auth system',
  goals: [
    {
      title: 'Harden the token-refresh path',
      approach: {
        chosen: 'rotate refresh tokens server-side',
        rationale: 'it closes the replay window the client-only flow leaves open',
        alternatives: ['client-only refresh', 'no rotation'],
      },
      todos: [
        { text: 'wire the refresh endpoint' },
        { text: 'add rotation on use', dependsOn: [1] },
        { text: 'cover it with tests', dependsOn: [1, 2] },
      ],
    },
    {
      title: 'Add password reset',
      todos: [{ text: 'build the reset email flow' }],
    },
  ],
};

describe('formatGoalProposal', () => {
  it('renders the confident vision header with goal + to-do counts', () => {
    const out = formatGoalProposal(STAGED_PLAN);
    assert.ok(
      out.startsWith("Here's how I'd tackle ship the auth system: 2 goals, 4 to-dos."),
      'leads with the vision + counts',
    );
  });

  it('renders each goal title, its approach over the alternatives + rationale, and the to-dos', () => {
    const out = formatGoalProposal(STAGED_PLAN);
    assert.ok(out.includes('1. Harden the token-refresh path'), 'goal 1 title');
    assert.ok(out.includes('2. Add password reset'), 'goal 2 title');
    assert.ok(
      out.includes(
        'Approach: rotate refresh tokens server-side over client-only refresh, no rotation — because it closes the replay window the client-only flow leaves open',
      ),
      'the chosen approach, the alternatives it beats, and the rationale',
    );
    assert.ok(out.includes('1. [ ] wire the refresh endpoint'), 'a to-do checklist item');
    assert.ok(out.includes('3. [ ] cover it with tests'), 'the last to-do');
    assert.ok(out.includes('1. [ ] build the reset email flow'), 'goal 2 to-do');
  });

  it('renders the dependency structure as a plain cause→effect phrase', () => {
    const out = formatGoalProposal(STAGED_PLAN);
    // todos 2 + 3 depend on 1 (+ 2) → "Steps 2-3 build on 1-2."
    assert.ok(out.includes('Steps 2-3 build on 1-2.'), 'plain dependency phrasing');
  });

  it('omits the approach line for a goal with no approach', () => {
    const out = formatGoalProposal(STAGED_PLAN);
    const goal2 = out.slice(out.indexOf('2. Add password reset'));
    assert.ok(!goal2.includes('Approach:'), 'goal 2 has no approach line');
  });

  it('uses a generic header when no vision was stated', () => {
    const out = formatGoalProposal({
      judgment: 'stage',
      goals: [{ title: 'Do the thing', todos: [{ text: 'step one' }] }],
    });
    assert.ok(out.startsWith("Here's the plan: 1 goal, 1 to-do."), 'singular nouns + generic header');
  });

  it('returns "" for none / clarify / empty plans (fail-soft additive contract)', () => {
    assert.equal(formatGoalProposal({ judgment: 'none', goals: [] }), '');
    assert.equal(
      formatGoalProposal({ judgment: 'clarify', goals: [], clarifyingQuestion: 'which db?' }),
      '',
    );
    assert.equal(formatGoalProposal({ judgment: 'stage', goals: [] }), '');
  });
});

describe('formatDependencyPhrase', () => {
  it('returns "" for a flat goal with no edges', () => {
    assert.equal(formatDependencyPhrase([{ text: 'a' }, { text: 'b' }]), '');
  });

  it('phrases a single dependent step with singular "Step"', () => {
    const phrase = formatDependencyPhrase([{ text: 'a' }, { text: 'b', dependsOn: [1] }]);
    assert.equal(phrase, 'Step 2 build on 1.');
  });

  it('collapses contiguous step ranges', () => {
    const phrase = formatDependencyPhrase([
      { text: 'a' },
      { text: 'b' },
      { text: 'c', dependsOn: [1, 2] },
      { text: 'd', dependsOn: [1, 2] },
    ]);
    assert.equal(phrase, 'Steps 3-4 build on 1-2.');
  });

  it('ignores forward / self refs (defensive)', () => {
    // dependsOn includes a forward (3) + self (2) which are not < position → dropped.
    const phrase = formatDependencyPhrase([{ text: 'a' }, { text: 'b', dependsOn: [3, 2, 1] }]);
    assert.equal(phrase, 'Step 2 build on 1.');
  });
});

describe('formatAutoStageNote', () => {
  it('names the goal(s), the to-do count, and asks the go-ahead', () => {
    const note = formatAutoStageNote(['Harden auth', 'Add reset'], 4);
    assert.equal(note, 'Staged 2 goals on the board: Harden auth; Add reset · 4 to-dos · shall I start?');
  });

  it('uses singular nouns for one goal / one to-do', () => {
    assert.equal(
      formatAutoStageNote(['Do the thing'], 1),
      'Staged 1 goal on the board: Do the thing · 1 to-do · shall I start?',
    );
  });

  it('caps the named titles and rolls the rest into "+N more"', () => {
    const note = formatAutoStageNote(['One', 'Two', 'Three', 'Four'], 0);
    assert.ok(note.includes('One; Two (+2 more)'), 'names two, rolls the rest');
    assert.ok(!note.includes('· 0 to-dos'), 'omits a zero to-do count');
  });

  it('returns "" when nothing was staged', () => {
    assert.equal(formatAutoStageNote([], 0), '');
    assert.equal(formatAutoStageNote(['   '], 0), '');
  });
});

describe('formatGoalProposal — cap-transparency (dropped hints)', () => {
  it('appends the honest "kept N steps; M more not shown" line when todos were dropped', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [{ title: 'Harden auth', todos: [{ text: 'wire endpoint' }, { text: 'add tests' }] }],
    };
    // Goal 0 had 5 more todos that were capped
    const dropped: ProposalDroppedCounts = { perGoalTodos: new Map([[0, 5]]) };
    const out = formatGoalProposal(plan, dropped);
    assert.ok(out.includes('(kept the 2 highest-leverage steps; 5 more not shown)'), 'shows the honest cap note');
  });

  it('omits the cap note entirely when nothing was dropped (byte-identical to no-hint call)', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [{ title: 'Harden auth', todos: [{ text: 'wire endpoint' }] }],
    };
    const withNoDropped = formatGoalProposal(plan);
    const withZeroDropped: ProposalDroppedCounts = { perGoalTodos: new Map([[0, 0]]) };
    const withExplicitZero = formatGoalProposal(plan, withZeroDropped);
    assert.ok(!withNoDropped.includes('not shown'), 'no cap note when no hint given');
    assert.ok(!withExplicitZero.includes('not shown'), 'no cap note when dropped=0');
    assert.equal(withNoDropped, withExplicitZero, 'byte-identical when dropped=0');
  });

  it('uses singular "step" when only 1 todo is kept', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [{ title: 'G', todos: [{ text: 'only step' }] }],
    };
    const dropped: ProposalDroppedCounts = { perGoalTodos: new Map([[0, 3]]) };
    const out = formatGoalProposal(plan, dropped);
    assert.ok(out.includes('(kept the 1 highest-leverage step; 3 more not shown)'), 'singular "step"');
  });

  it('appends the dropped-goal note when goal cap was hit', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [
        { title: 'Goal A', todos: [{ text: 'step 1' }] },
        { title: 'Goal B', todos: [{ text: 'step 2' }] },
      ],
    };
    const dropped: ProposalDroppedCounts = { goals: 3 };
    const out = formatGoalProposal(plan, dropped);
    assert.ok(out.includes('3 additional goals not shown'), 'shows goal-cap note');
    assert.ok(out.includes('5-goal cap'), 'explains the total cap count');
  });

  it('uses singular "goal" for exactly 1 dropped goal', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [{ title: 'Goal A', todos: [{ text: 'step 1' }] }],
    };
    const dropped: ProposalDroppedCounts = { goals: 1 };
    const out = formatGoalProposal(plan, dropped);
    assert.ok(out.includes('1 additional goal not shown'), 'singular "goal"');
  });

  it('omits the goal-cap note entirely when goals=0 (additive — byte-identical)', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [{ title: 'G', todos: [{ text: 's' }] }],
    };
    const withNoDropped = formatGoalProposal(plan);
    const withZero = formatGoalProposal(plan, { goals: 0 });
    assert.ok(!withNoDropped.includes('additional goal'), 'no goal-cap note by default');
    assert.equal(withNoDropped, withZero, 'byte-identical when goals dropped=0');
  });

  it('handles both todo and goal drops simultaneously', () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      goals: [
        { title: 'Goal A', todos: [{ text: 'a' }, { text: 'b' }] },
        { title: 'Goal B', todos: [{ text: 'c' }] },
      ],
    };
    const dropped: ProposalDroppedCounts = {
      perGoalTodos: new Map([[0, 6], [1, 2]]),
      goals: 1,
    };
    const out = formatGoalProposal(plan, dropped);
    assert.ok(out.includes('(kept the 2 highest-leverage steps; 6 more not shown)'), 'goal A todo-cap note');
    assert.ok(out.includes('(kept the 1 highest-leverage step; 2 more not shown)'), 'goal B todo-cap note');
    assert.ok(out.includes('1 additional goal not shown'), 'goal-cap note');
  });
});

describe('formatAutoStageNote — dropped-goals cap disclosure', () => {
  it('appends the dropped-goals note when droppedGoals > 0', () => {
    const note = formatAutoStageNote(['Harden auth', 'Add reset'], 4, 2);
    assert.ok(
      note.includes('2 more goals not staged (plan exceeded cap)'),
      'shows the dropped-goals note',
    );
    assert.ok(note.startsWith('Staged 2 goals on the board:'), 'prefix is unchanged');
    assert.ok(note.endsWith('· shall I start?'), 'suffix is unchanged');
  });

  it('omits the dropped note when droppedGoals=0 (byte-identical to two-arg call)', () => {
    const withoutArg = formatAutoStageNote(['Harden auth'], 3);
    const withZero = formatAutoStageNote(['Harden auth'], 3, 0);
    assert.ok(!withoutArg.includes('not staged'), 'no note without arg');
    assert.equal(withoutArg, withZero, 'byte-identical when droppedGoals=0');
  });

  it('uses singular "goal" for exactly 1 dropped goal', () => {
    const note = formatAutoStageNote(['Goal A'], 2, 1);
    assert.ok(note.includes('1 more goal not staged (plan exceeded cap)'), 'singular "goal"');
  });
});

describe('formatHeadsUp', () => {
  const model: SystemModel = {
    summary: 'the system',
    modules: [],
    conventions: [],
    constraints: ['subscription-OAuth only, no API keys'],
    openQuestions: ['is the refresh path rate-limited?', 'does logout revoke tokens?'],
    researchCitations: [],
  };

  it('surfaces open questions first, then constraints, capped at two', () => {
    const out = formatHeadsUp(model);
    assert.deepEqual(out, [
      'is the refresh path rate-limited?',
      'does logout revoke tokens?',
    ]);
  });

  it('fills the budget with constraints when there is room', () => {
    const out = formatHeadsUp({
      ...model,
      openQuestions: ['only one question'],
    });
    assert.deepEqual(out, ['only one question', 'subscription-OAuth only, no API keys']);
  });

  it('returns [] when there is no warm model (never fabricates)', () => {
    assert.deepEqual(formatHeadsUp(undefined), []);
  });

  it('returns [] when the model has no findings', () => {
    assert.deepEqual(
      formatHeadsUp({ ...model, openQuestions: [], constraints: [] }),
      [],
    );
  });
});
