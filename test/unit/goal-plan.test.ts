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
      'Design the user + session schema',
      'Implement the signup endpoint',
    ]);
    assert.equal(out?.goals[1]?.title, 'Add password reset');
    assert.deepEqual(out?.goals[1]?.todos, ['Wire the reset-token email']);
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
    assert.deepEqual(out?.goals[0]?.todos, ['real step']);
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
  });
});
