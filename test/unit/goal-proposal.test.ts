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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatGoalProposal,
  formatDependencyPhrase,
  formatHeadsUp,
  formatAutoStageNote,
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
