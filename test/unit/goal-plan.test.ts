/**
 * test/unit/goal-plan.test.ts — the PURE planning-brain core (core/goal-plan.ts):
 * the prompt builder and the tagged-reply parser. No live model — deterministic
 * seams, exactly like goal-objective.test.ts drives goal-objective.ts.
 *
 * Locks in the HEADLINE behaviour's judge: trivial → none, substantial → stage
 * (goals + todos parsed, counts capped), ambiguous → clarify (question parsed),
 * garbage → null, and the no-echo / persona / judge rules in the prompt.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoalPlanPrompt,
  parseGoalPlan,
  planTodosToRoadmap,
  countDroppedTodos,
  countDroppedGoals,
  GOAL_PLAN_MAX_GOALS,
  GOAL_PLAN_MAX_TODOS,
} from '../../src/core/goal-plan.ts';
import { ELITE_VOICE_PREAMBLE } from '../../src/core/prompt.ts';

const SUBSTANTIAL =
  'we need to ship the whole auth system — signup, login, password reset, token refresh';

describe('buildGoalPlanPrompt', () => {
  it('leads with the ELITE_VOICE persona, the judge rules, and the no-echo rule', () => {
    const p = buildGoalPlanPrompt(SUBSTANTIAL);
    assert.ok(p.startsWith(ELITE_VOICE_PREAMBLE), 'leads with the reused ELITE_VOICE_PREAMBLE persona');
    assert.ok(p.includes(SUBSTANTIAL), 'includes the owner turn to judge');
    // The three verdicts are spelled out.
    assert.ok(/JUDGMENT: none/.test(p), 'documents the none verdict');
    assert.ok(/JUDGMENT: stage/.test(p), 'documents the stage verdict');
    assert.ok(/JUDGMENT: clarify/.test(p), 'documents the clarify verdict');
    assert.ok(/GOAL:/.test(p) && /TODO:/.test(p), 'asks for tagged GOAL/TODO lines');
    assert.ok(/ASK:/.test(p), 'asks for a tagged ASK line on clarify');
    assert.ok(/VISION:/.test(p), 'asks for a VISION framing on stage');
    assert.ok(/NEVER echo/i.test(p), 'forbids echoing the owner phrasing');
    assert.ok(p.includes(String(GOAL_PLAN_MAX_GOALS)), 'states the goal cap');
    assert.ok(p.includes(String(GOAL_PLAN_MAX_TODOS)), 'states the todo cap');
    // The OPTIONAL dependency marker is documented in the TODO grammar.
    assert.ok(/\[after:/i.test(p), 'documents the optional [after: ...] dependency marker');
    assert.ok(/EARLIER/i.test(p), 'instructs that a todo may only reference EARLIER numbers');
    // The OPTIONAL best-approach grammar (APPROACH/WHY/ALT) is documented.
    assert.ok(/APPROACH:/.test(p), 'documents the optional APPROACH line (chosen strategy)');
    assert.ok(/WHY:/.test(p), 'documents the WHY line (why it beats the alternatives)');
    assert.ok(/ALT:/.test(p), 'documents the optional ALT line (rejected options)');
  });

  it('returns empty string for empty/whitespace input (caller skips the model touch)', () => {
    assert.equal(buildGoalPlanPrompt(''), '');
    assert.equal(buildGoalPlanPrompt('   \n  '), '');
  });

  it('threads optional assistant reply + frame goal context when provided', () => {
    const p = buildGoalPlanPrompt(SUBSTANTIAL, 'here is my reply', 'Ship the platform');
    assert.ok(p.includes('here is my reply'), 'carries the assistant reply context');
    assert.ok(p.includes('Ship the platform'), 'carries the active goal frame');
  });

  // ---- SystemModel grounding (Elite-partner Part 2) ------------------------
  it('with a SystemModel ⇒ injects the whole-picture grounding block', () => {
    const p = buildGoalPlanPrompt(SUBSTANTIAL, undefined, undefined, {
      summary: 'auth lives in core/oauth, refreshed in infra/token-store',
      modules: ['core/oauth'],
      conventions: ['pure core, impure infra'],
      constraints: ['subscription-OAuth only, no metered API'],
      openQuestions: ['eager or lazy refresh?'],
      researchCitations: [],
    });
    assert.ok(/WHOLE-PICTURE UNDERSTANDING/.test(p), 'has the grounding header');
    assert.ok(p.includes('auth lives in core/oauth'), 'carries the system summary');
    assert.ok(p.includes('subscription-OAuth only, no metered API'), 'carries the hard constraint');
    assert.ok(p.includes('eager or lazy refresh?'), 'carries the genuinely-open question for clarify');
  });

  it('WITHOUT a SystemModel ⇒ byte-for-byte identical to the pre-understanding prompt (regression guard)', () => {
    const base = buildGoalPlanPrompt(SUBSTANTIAL, 'a reply', 'A frame goal');
    const withUndefined = buildGoalPlanPrompt(SUBSTANTIAL, 'a reply', 'A frame goal', undefined);
    assert.equal(withUndefined, base, 'omitting the systemModel must not change the prompt');
    assert.ok(!/WHOLE-PICTURE UNDERSTANDING/.test(base), 'no grounding header when ungrounded');
  });

  it('an all-empty SystemModel ⇒ no grounding block (stays byte-identical to ungrounded)', () => {
    const base = buildGoalPlanPrompt(SUBSTANTIAL);
    const empty = buildGoalPlanPrompt(SUBSTANTIAL, undefined, undefined, {
      summary: '   ',
      modules: [],
      conventions: [],
      constraints: ['   '],
      openQuestions: [''],
      researchCitations: [],
    });
    assert.equal(empty, base, 'a contentless system model injects nothing');
  });
});

describe('parseGoalPlan — trivial → none', () => {
  it('parses a bare none verdict (do nothing, frictionless)', () => {
    const out = parseGoalPlan('JUDGMENT: none');
    assert.deepEqual(out, { judgment: 'none', goals: [] });
  });
});

describe('parseGoalPlan — substantial → stage', () => {
  it('parses goals + their todos under a stage verdict', () => {
    const reply = [
      'JUDGMENT: stage',
      'VISION: A production-grade authentication system',
      'GOAL: Build the signup + login flow',
      'TODO: Design the user + session schema',
      'TODO: Implement the signup endpoint',
      'GOAL: Add password reset',
      'TODO: Wire the reset-token email',
    ].join('\n');
    const out = parseGoalPlan(reply);
    assert.ok(out !== null);
    assert.equal(out?.judgment, 'stage');
    assert.equal(out?.vision, 'A production-grade authentication system');
    assert.equal(out?.goals.length, 2);
    assert.equal(out?.goals[0]?.title, 'Build the signup + login flow');
    assert.deepEqual(out?.goals[0]?.todos, [
      { text: 'Design the user + session schema' },
      { text: 'Implement the signup endpoint' },
    ]);
    assert.equal(out?.goals[1]?.title, 'Add password reset');
    assert.deepEqual(out?.goals[1]?.todos, [{ text: 'Wire the reset-token email' }]);
  });

  it('caps goals to GOAL_PLAN_MAX_GOALS and todos to GOAL_PLAN_MAX_TODOS', () => {
    const lines = ['JUDGMENT: stage'];
    for (let g = 0; g < GOAL_PLAN_MAX_GOALS + 3; g += 1) {
      lines.push(`GOAL: Goal number ${g}`);
      for (let t = 0; t < GOAL_PLAN_MAX_TODOS + 4; t += 1) lines.push(`TODO: step ${g}.${t}`);
    }
    const out = parseGoalPlan(lines.join('\n'));
    assert.ok(out !== null);
    assert.equal(out?.goals.length, GOAL_PLAN_MAX_GOALS, 'goals capped');
    for (const goal of out?.goals ?? []) {
      assert.ok(goal.todos.length <= GOAL_PLAN_MAX_TODOS, 'todos capped per goal');
    }
    // Honest cap disclosure (never hide a cap): the over-cap reply records what it dropped.
    assert.ok(out?.dropped !== undefined, 'over-cap plan reports dropped counts');
    assert.equal(out?.dropped?.goals, 3, '3 goals over GOAL_PLAN_MAX_GOALS recorded');
    assert.ok((out?.dropped?.perGoalTodos.size ?? 0) > 0, 'per-goal dropped to-dos recorded');
  });

  it('a within-cap plan reports NO dropped field (additive — byte-identical)', () => {
    const out = parseGoalPlan('JUDGMENT: stage\nGOAL: Ship it\nTODO: step one\nTODO: step two');
    assert.ok(out !== null);
    assert.equal(out?.dropped, undefined, 'nothing dropped ⇒ no dropped field');
  });

  it('does NOT echo the raw phrasing (the model writes professional titles)', () => {
    const out = parseGoalPlan('JUDGMENT: stage\nGOAL: Harden the auth token-refresh path\nTODO: Add a refresh test');
    assert.ok(out !== null);
    assert.notEqual(out?.goals[0]?.title, SUBSTANTIAL);
    assert.equal(out?.goals[0]?.title, 'Harden the auth token-refresh path');
  });

  it('a TODO before any GOAL is dropped (never orphaned)', () => {
    const out = parseGoalPlan('JUDGMENT: stage\nTODO: a stray step\nGOAL: Real goal\nTODO: real step');
    assert.ok(out !== null);
    assert.equal(out?.goals.length, 1);
    assert.deepEqual(out?.goals[0]?.todos, [{ text: 'real step' }]);
  });

  it('a stage verdict with no parseable goal degrades to null (do nothing)', () => {
    assert.equal(parseGoalPlan('JUDGMENT: stage\nVISION: nice idea'), null);
  });

  it('recovers a stage verdict from present GOAL lines when JUDGMENT tag is missing', () => {
    const out = parseGoalPlan('GOAL: Ship the API\nTODO: write the handler');
    assert.equal(out?.judgment, 'stage');
    assert.equal(out?.goals.length, 1);
  });
});

describe('parseGoalPlan — best-approach (APPROACH/WHY/ALT)', () => {
  it('extracts a goal approach from APPROACH + WHY (+ ALT) into the goal', () => {
    const reply = [
      'JUDGMENT: stage',
      'GOAL: Harden the auth token-refresh path',
      'APPROACH: A single guarded mutex around the refresh call',
      'WHY: Eliminates the concurrent-refresh race without touching call sites',
      'ALT: per-call locking, optimistic retry',
      'TODO: Add a concurrent-refresh test',
    ].join('\n');
    const out = parseGoalPlan(reply);
    assert.ok(out !== null);
    assert.deepEqual(out?.goals[0]?.approach, {
      chosen: 'A single guarded mutex around the refresh call',
      rationale: 'Eliminates the concurrent-refresh race without touching call sites',
      alternatives: ['per-call locking', 'optimistic retry'],
    });
    // The todos are unaffected by the approach lines.
    assert.deepEqual(out?.goals[0]?.todos, [{ text: 'Add a concurrent-refresh test' }]);
  });

  it('attaches the approach to the MOST-RECENT goal (per-goal, not global)', () => {
    const reply = [
      'JUDGMENT: stage',
      'GOAL: First goal',
      'TODO: step one',
      'GOAL: Second goal',
      'APPROACH: chosen for second',
      'WHY: because it fits the second goal',
      'TODO: step two',
    ].join('\n');
    const out = parseGoalPlan(reply);
    assert.equal('approach' in (out?.goals[0] ?? {}), false, 'first goal has no approach');
    assert.equal(out?.goals[1]?.approach?.chosen, 'chosen for second');
  });

  it('omits the approach when WHY is missing (never a half-record)', () => {
    const out = parseGoalPlan('JUDGMENT: stage\nGOAL: G\nAPPROACH: a strategy\nTODO: t');
    assert.ok(out !== null);
    assert.equal('approach' in (out?.goals[0] ?? {}), false);
  });

  it('omits the approach when APPROACH is missing (WHY alone is not enough)', () => {
    const out = parseGoalPlan('JUDGMENT: stage\nGOAL: G\nWHY: some reasoning\nTODO: t');
    assert.ok(out !== null);
    assert.equal('approach' in (out?.goals[0] ?? {}), false);
  });

  it('a plan with NO approach markers parses byte-identically (no approach field anywhere)', () => {
    const reply = 'JUDGMENT: stage\nGOAL: Ship the API\nTODO: write the handler';
    const out = parseGoalPlan(reply);
    assert.ok(out !== null);
    for (const g of out?.goals ?? []) {
      assert.equal('approach' in g, false);
    }
  });

  it('bounds the ALT list to 4, deduped, each capped', () => {
    const out = parseGoalPlan(
      [
        'JUDGMENT: stage',
        'GOAL: G',
        'APPROACH: x',
        'WHY: y',
        'ALT: a, a, b, c, d, e, f',
        'TODO: t',
      ].join('\n'),
    );
    const alts = out?.goals[0]?.approach?.alternatives ?? [];
    assert.ok(alts.length <= 4, 'at most 4 alternatives');
    assert.deepEqual([...new Set(alts)], alts, 'deduped');
  });
});

describe('parseGoalPlan — ambiguous → clarify', () => {
  it('parses a single sharp ASK question', () => {
    const out = parseGoalPlan('JUDGMENT: clarify\nASK: Should this scale to millions of users or a small team?');
    assert.deepEqual(out, {
      judgment: 'clarify',
      goals: [],
      clarifyingQuestion: 'Should this scale to millions of users or a small team?',
    });
  });

  it('a clarify verdict with no ASK degrades to null (do nothing)', () => {
    assert.equal(parseGoalPlan('JUDGMENT: clarify'), null);
  });

  it('recovers a clarify verdict from a present ASK when JUDGMENT tag is missing', () => {
    const out = parseGoalPlan('ASK: which database are we targeting?');
    assert.equal(out?.judgment, 'clarify');
    assert.equal(out?.clarifyingQuestion, 'which database are we targeting?');
  });
});

describe('parseGoalPlan — garbage → null + defensive', () => {
  it('returns null for unusable / verdict-less input', () => {
    assert.equal(parseGoalPlan(null), null);
    assert.equal(parseGoalPlan(undefined), null);
    assert.equal(parseGoalPlan(''), null);
    assert.equal(parseGoalPlan('   '), null);
    assert.equal(parseGoalPlan('just some prose with no tags at all'), null);
    assert.equal(parseGoalPlan(42 as unknown as string), null);
  });

  it('never throws on adversarial input', () => {
    assert.doesNotThrow(() => parseGoalPlan('JUDGMENT:\nGOAL:\nTODO:\nASK:'));
    assert.doesNotThrow(() => parseGoalPlan('\n\n※\n\n'));
    assert.doesNotThrow(() => parseGoalPlan('GOAL: '.repeat(5000)));
    assert.doesNotThrow(() => parseGoalPlan('JUDGMENT: stage\nGOAL: g\nTODO: x [after: not, a, number]'));
  });
});

describe('parseGoalPlan — optional [after:] dependency marker', () => {
  it('extracts EARLIER 1-based deps and strips the marker from the displayed text', () => {
    const reply = [
      'JUDGMENT: stage',
      'GOAL: Ship the feature',
      'TODO: Wire the API endpoint',
      'TODO: Add auth middleware',
      'TODO: Build the UI that calls the API  [after: 1, 2]',
    ].join('\n');
    const out = parseGoalPlan(reply);
    assert.ok(out !== null);
    assert.deepEqual(out?.goals[0]?.todos, [
      { text: 'Wire the API endpoint' },
      { text: 'Add auth middleware' },
      { text: 'Build the UI that calls the API', dependsOn: [1, 2] },
    ]);
  });

  it('a plan with NO marker parses exactly as before (no dependsOn field anywhere)', () => {
    const reply = 'JUDGMENT: stage\nGOAL: g\nTODO: first\nTODO: second';
    const out = parseGoalPlan(reply);
    assert.deepEqual(out?.goals[0]?.todos, [{ text: 'first' }, { text: 'second' }]);
  });

  it('drops self / forward / out-of-range refs (acyclic by construction)', () => {
    const reply = [
      'JUDGMENT: stage',
      'GOAL: g',
      'TODO: a  [after: 1]', // self → dropped (position 1)
      'TODO: b  [after: 3, 9, 0]', // forward (3), out-of-range (9, 0) → all dropped
      'TODO: c  [after: 2, 2, 1]', // dedupe + keep earlier
    ].join('\n');
    const out = parseGoalPlan(reply);
    assert.deepEqual(out?.goals[0]?.todos, [
      { text: 'a' },
      { text: 'b' },
      { text: 'c', dependsOn: [2, 1] },
    ]);
  });

  it('a marker with no usable number is stripped and yields no dependsOn', () => {
    const out = parseGoalPlan('JUDGMENT: stage\nGOAL: g\nTODO: x  [after: ]');
    assert.deepEqual(out?.goals[0]?.todos, [{ text: 'x' }]);
  });
});

describe('planTodosToRoadmap — pure index→id translation', () => {
  it('mints r1.. ids and translates dependsOn indices into sibling ids', () => {
    const roadmap = planTodosToRoadmap([
      { text: 'wire the API' },
      { text: 'build the UI', dependsOn: [1] },
      { text: 'add tests', dependsOn: [1, 2] },
    ]);
    assert.deepEqual(roadmap, [
      { id: 'r1', text: 'wire the API', status: 'pending' },
      { id: 'r2', text: 'build the UI', status: 'pending', dependsOn: ['r1'] },
      { id: 'r3', text: 'add tests', status: 'pending', dependsOn: ['r1', 'r2'] },
    ]);
  });

  it('a flat plan (no deps) is byte-identical to the {id,text,status} shape', () => {
    const roadmap = planTodosToRoadmap([{ text: 'a' }, { text: 'b' }]);
    assert.deepEqual(roadmap, [
      { id: 'r1', text: 'a', status: 'pending' },
      { id: 'r2', text: 'b', status: 'pending' },
    ]);
    assert.ok(!('dependsOn' in roadmap[0]!), 'no dependsOn field on a dep-free item');
  });

  it('defensively skips an out-of-range / forward index (no orphan id)', () => {
    const roadmap = planTodosToRoadmap([
      { text: 'a', dependsOn: [2, 5] }, // forward (2) + out-of-range (5) → dropped
      { text: 'b' },
    ]);
    assert.equal(roadmap[0]?.dependsOn, undefined, 'no edge survives → field omitted');
  });

  it('handles the empty plan', () => {
    assert.deepEqual(planTodosToRoadmap([]), []);
  });
});

describe('countDroppedTodos + countDroppedGoals — cap-transparency helpers', () => {
  it('returns 0 when the list is within the limit (nothing dropped)', () => {
    assert.equal(countDroppedTodos(['a', 'b', 'c'], 8), 0);
    assert.equal(countDroppedTodos([], 8), 0);
    assert.equal(countDroppedTodos(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 8), 0);
    assert.equal(countDroppedGoals(['g1', 'g2'], 4), 0);
  });

  it('returns the positive count of items that exceed the limit', () => {
    assert.equal(countDroppedTodos(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 8), 1);
    assert.equal(countDroppedTodos(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], 8), 4);
    assert.equal(countDroppedGoals(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'], 4), 2);
    assert.equal(countDroppedGoals(['g1', 'g2', 'g3', 'g4', 'g5'], GOAL_PLAN_MAX_GOALS), 1);
  });

  it('clamps to 0 on adversarial input (never throws, never negative)', () => {
    assert.equal(countDroppedTodos(null as unknown as [], 8), 0);
    assert.equal(countDroppedTodos(undefined as unknown as [], 8), 0);
    assert.equal(countDroppedGoals([], 0), 0);
    assert.equal(countDroppedGoals([], -5), 0); // negative limit ⇒ treats as 0
  });

  it('matches the GOAL_PLAN_MAX_TODOS cap that parseGoalPlan enforces', () => {
    // Build a raw over-limit list (12 todos) and check the helper agrees with the cap.
    const rawTodos = Array.from({ length: 12 }, (_, i) => ({ text: `step ${i}` }));
    assert.equal(countDroppedTodos(rawTodos, GOAL_PLAN_MAX_TODOS), 12 - GOAL_PLAN_MAX_TODOS);
  });
});
