/**
 * test/unit/goal-objective.test.ts — the PURE goal-objective core
 * (core/goal-objective.ts): the prompt builder and the parser. No live model —
 * these are deterministic seams, exactly like recap.test.ts drives recap.ts.
 *
 * This is the 4th-report fix's regression guard: the user kept SEEING their own
 * raw phrasing as the goal. These tests lock in that the manager-tier formation
 * (a) is given the product-vision persona + the no-echo rules, and (b) parses a
 * model reply into a crisp objective, NOT the raw text, with the preamble stripped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoalObjectivePrompt,
  parseGoalObjective,
  GOAL_OBJECTIVE_MAX_CHARS,
} from '../../src/core/goal-objective.ts';
import { ELITE_VOICE_PREAMBLE } from '../../src/core/prompt.ts';

const RAMBLY =
  'so yea i think the frontend is a decent skeleton to build into, like 2010 youtube but better in rust for millions of users';

describe('buildGoalObjectivePrompt', () => {
  it('embeds the raw request, the ELITE_VOICE persona, and the no-echo rules', () => {
    const p = buildGoalObjectivePrompt(RAMBLY);
    // (a) the product-vision / quality-bar persona leads the prompt.
    assert.ok(p.startsWith(ELITE_VOICE_PREAMBLE), 'leads with the reused ELITE_VOICE_PREAMBLE persona');
    // (b) the user's raw request is included for the model to distil.
    assert.ok(p.includes(RAMBLY), 'includes the raw request to distil');
    // (c) the OBJECTIVE contract + the no-echo / no-preamble rules are present.
    assert.ok(/OBJECTIVE:/.test(p), 'asks for a tagged OBJECTIVE line');
    assert.ok(/NEVER echo/i.test(p), 'forbids echoing the user phrasing');
    assert.ok(/preamble/i.test(p), 'forbids a we/this/the-user preamble');
    assert.ok(p.includes(String(GOAL_OBJECTIVE_MAX_CHARS)), 'states the length bound');
  });

  it('returns empty string for empty/whitespace input (caller skips the model touch)', () => {
    assert.equal(buildGoalObjectivePrompt(''), '');
    assert.equal(buildGoalObjectivePrompt('   \n  '), '');
  });
});

describe('parseGoalObjective', () => {
  it('extracts a crisp objective from a tagged reply (NOT the raw text)', () => {
    const out = parseGoalObjective('OBJECTIVE: heyvera — YouTube-scale video platform in Rust');
    assert.equal(out, 'Heyvera — YouTube-scale video platform in Rust');
    assert.notEqual(out, RAMBLY);
  });

  it('strips a we/this/the-user/let\'s/"the goal is" preamble so it reads as an objective', () => {
    assert.equal(
      parseGoalObjective('We are going to build a Rust video platform'),
      'Going to build a Rust video platform',
    );
    assert.equal(
      parseGoalObjective('The goal is: ship the auth system'),
      'Ship the auth system',
    );
    assert.equal(parseGoalObjective("Let's wire the login flow"), 'Wire the login flow');
  });

  it('strips marker glyphs, wrapping quotes, and trailing sentence punctuation', () => {
    assert.equal(parseGoalObjective('⏺ "Ship the payments API."'), 'Ship the payments API');
    assert.equal(parseGoalObjective('OBJECTIVE: “Migrate auth to JWT”;'), 'Migrate auth to JWT');
  });

  it('bounds to GOAL_OBJECTIVE_MAX_CHARS on a word boundary', () => {
    const long = 'OBJECTIVE: ' + 'build the entire distributed video transcoding and delivery pipeline end to end now';
    const out = parseGoalObjective(long);
    assert.ok(out !== null);
    assert.ok((out as string).length <= GOAL_OBJECTIVE_MAX_CHARS, 'within the bound');
    assert.ok(!/\s$/.test(out as string), 'no trailing whitespace from the word-boundary cut');
  });

  it('returns null for unusable input so the caller falls back to the deterministic shaper', () => {
    assert.equal(parseGoalObjective(null), null);
    assert.equal(parseGoalObjective(undefined), null);
    assert.equal(parseGoalObjective('   '), null);
    assert.equal(parseGoalObjective('OBJECTIVE:'), null);
    assert.equal(parseGoalObjective('ab'), null);
  });

  it('never throws on adversarial input', () => {
    assert.doesNotThrow(() => parseGoalObjective(RAMBLY));
    assert.doesNotThrow(() => parseGoalObjective('\n\n※\n\n'));
  });
});
