/**
 * test/unit/brain-judgment.test.ts — THE FREE JUDGMENT LAYER (master-plan PHASE 5;
 * .tmp-master-judgment.md Parts 2 & 3). PURE, table-testable: no I/O, no model call.
 *
 * Covers the `push_back` brain move + its narrow grounded-reason gate, the
 * ask-vs-proceed calibration neutrality, the taste-violation detector, the
 * push-back-answer classifier (the pushback_accept/reject recording round-trip),
 * the push_back QuestionSet builder, the judgment FLAG off-guarantee (flag-off ⇒
 * decideNextMove byte-for-byte unchanged), and the no-manufactured-disagreement
 * property (no grounded reason ⇒ no push_back; silence is correct).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessConfidence,
  decideNextMove,
  detectTasteViolation,
  buildPushBack,
  isPushBackQuestionSet,
  classifyPushBackAnswer,
  type JudgmentContext,
  type BrainLoopState,
} from '../../src/core/brain.ts';
import { judgmentEnabled } from '../../src/core/judgment-flag.ts';
import { planEngagement } from '../../src/core/engagement.ts';
import type { EngagementSignals } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Classification, QuestionSet } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Builders (mirror brain.test.ts conventions)
// ---------------------------------------------------------------------------

function classification(over: Partial<Classification> = {}): Classification {
  return { tier: 'ic', risk: 'medium', rationale: 'test', ...over };
}

function signals(over: Partial<EngagementSignals> = {}): EngagementSignals {
  return {
    classification: classification(),
    routePlan: false,
    engagementBias: 0,
    task: 'make the activity feed load real data',
    ...over,
  };
}

function frame(over: Partial<IntentFrame> = {}): IntentFrame {
  return {
    version: 1,
    goal: 'make the activity feed load real data',
    kind: 'coding',
    confidence: 'low',
    source: 'model',
    ...over,
  } as IntentFrame;
}

function state(over: Partial<BrainLoopState> = {}): BrainLoopState {
  return { rounds: 0, groundedness: 'unread', optedOutOfDeepDive: false, maxRounds: 2, ...over };
}

const noAsk = (): QuestionSet | null => null;
const ON: JudgmentContext = { enabled: true };

/** A SUBSTANTIAL build turn (route.plan + manager tier + multi-clause → planFirst). */
function substantialSignals(over: Partial<EngagementSignals> = {}): EngagementSignals {
  return signals({
    classification: classification({ tier: 'manager', risk: 'medium' }),
    routePlan: true,
    task: 'rebuild the billing subsystem end to end, migrate the data, and cut over the API',
    ...over,
  });
}

// ===========================================================================
// THE FLAG — off-guarantee
// ===========================================================================

describe('judgment-flag', () => {
  it('default OFF (no env, no config)', () => {
    assert.equal(judgmentEnabled({}, undefined), false);
    assert.equal(judgmentEnabled({}, {}), false);
  });
  it('ON via MYSHELL_JUDGMENT truthy (case-insensitive)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
      assert.equal(judgmentEnabled({ MYSHELL_JUDGMENT: v }, undefined), true, `value ${v}`);
    }
  });
  it('ON via config.experimentalJudgment', () => {
    assert.equal(judgmentEnabled({}, { experimentalJudgment: true }), true);
  });
  it('OFF for falsy/garbage values', () => {
    for (const v of ['0', 'false', '', 'off', 'maybe']) {
      assert.equal(judgmentEnabled({ MYSHELL_JUDGMENT: v }, undefined), false, `value ${v}`);
    }
  });
});

// ===========================================================================
// FLAG-OFF NEUTRALITY — decideNextMove byte-for-byte unchanged
// ===========================================================================

describe('push_back — flag-off neutrality (the OFF-GUARANTEE)', () => {
  it('an irreversible substantial turn returns its existing move (reflect_confirm), NOT push_back, when the flag is OFF', () => {
    const f = frame({
      confidence: 'medium',
      source: 'model',
      goal: 'drop the legacy users table and migrate',
    });
    const s = substantialSignals({
      frame: f,
      task: 'drop the legacy users table then migrate the data over',
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    // Default judgment arg (omitted) === disabled.
    const off = decideNextMove(conf, f, s, plan, state(), noAsk);
    // Explicit disabled context must be identical to the omitted-arg path.
    const offExplicit = decideNextMove(conf, f, s, plan, state(), noAsk, { enabled: false });
    assert.notEqual(off.kind, 'push_back', 'flag OFF never offers push_back');
    assert.deepEqual(off, offExplicit, 'omitted arg === explicit disabled');
  });

  it('a taste-violating substantial turn does NOT push_back when the flag is OFF (even with taste lines present)', () => {
    const f = frame({
      confidence: 'medium',
      source: 'model',
      goal: 'wire the feed data',
      forks: [
        {
          id: 'F1',
          question: 'how should the feed load data?',
          options: ['client-side fetch', 'server component'],
          assumeIfUnasked: 'client-side fetch',
        },
      ],
    });
    const s = substantialSignals({ frame: f, task: 'wire the feed data to the api' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    // tasteLines present but flag OFF → still no push_back.
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, {
      enabled: false,
      tasteLines: ['feed data: server component'],
    });
    assert.notEqual(move.kind, 'push_back');
  });
});

// ===========================================================================
// SOURCE 1 — correctness / irreversibility RED FLAG
// ===========================================================================

describe('push_back — red-flag source (irreversibility + uncertainty)', () => {
  it('FIRES on a substantial irreversible turn with non-high understanding', () => {
    const f = frame({
      confidence: 'medium', // NOT high → genuine uncertainty
      source: 'model',
      goal: 'drop the legacy users table and migrate',
    });
    const s = substantialSignals({
      frame: f,
      task: 'drop the legacy users table then migrate the data over',
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    assert.equal(conf.stakes, 'high', 'irreversible → high stakes');
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, ON);
    assert.equal(move.kind, 'push_back');
    if (move.kind === 'push_back') {
      assert.equal(move.source, 'red_flag');
      assert.ok(move.reason.length > 0, 'a NAMED reason');
      assert.ok(move.recommendation.length > 0, 'a concrete recommendation');
      assert.ok(isPushBackQuestionSet(move.questions), 'carries the push_back QuestionSet');
    }
  });

  it('STAYS SILENT on a CLEARLY-UNDERSTOOD irreversible turn (understanding high) — no nag', () => {
    // The existing calibration: a clearly-understood irreversible task flows
    // straight through. push_back must NOT regress that.
    const f = frame({
      confidence: 'high', // clearly understood
      source: 'model',
      goal: 'drop the legacy users table and migrate',
    });
    const s = substantialSignals({
      frame: f,
      task: 'drop the legacy users table then migrate the data over',
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, ON);
    assert.notEqual(move.kind, 'push_back', 'high understanding ⇒ no red-flag push_back');
  });

  it('STAYS SILENT on a SMALL irreversible turn (not substantial) — no nag', () => {
    const f = frame({ confidence: 'medium', source: 'model', goal: 'delete the unused import' });
    const s = signals({
      frame: f,
      task: 'delete the unused import',
      classification: classification({ tier: 'worker', risk: 'low' }),
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, ON);
    assert.notEqual(move.kind, 'push_back', 'small clear work ⇒ no push_back');
  });
});

// ===========================================================================
// SOURCE 2 — learned-taste VIOLATION
// ===========================================================================

describe('push_back — taste-violation source', () => {
  it('FIRES when the planned default contradicts a recorded taste line', () => {
    const f = frame({
      confidence: 'high', // understood — but it violates recorded taste
      source: 'model',
      goal: 'wire the feed data',
      forks: [
        {
          id: 'F1',
          question: 'how should the feed load data?',
          options: ['client-side fetch', 'server component'],
          assumeIfUnasked: 'client-side fetch',
        },
      ],
    });
    const s = substantialSignals({ frame: f, task: 'wire the feed data to the api' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, {
      enabled: true,
      tasteLines: ['feed loading: server component'],
    });
    assert.equal(move.kind, 'push_back');
    if (move.kind === 'push_back') {
      assert.equal(move.source, 'taste_violation');
      assert.match(move.reason, /server component/i, 'names the recorded call');
      assert.match(move.reason, /client-side fetch/i, 'names the planned departure');
    }
  });

  it('STAYS SILENT when the planned default ALREADY honours the recorded taste (no violation)', () => {
    const f = frame({
      confidence: 'high',
      source: 'model',
      goal: 'wire the feed data',
      forks: [
        {
          id: 'F1',
          question: 'how should the feed load data?',
          options: ['client-side fetch', 'server component'],
          assumeIfUnasked: 'server component', // matches the recorded taste
        },
      ],
    });
    const s = substantialSignals({ frame: f, task: 'wire the feed data to the api' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, {
      enabled: true,
      tasteLines: ['feed loading: server component'],
    });
    assert.notEqual(move.kind, 'push_back', 'no departure ⇒ no taste-violation push_back');
  });

  it('STAYS SILENT with NO taste lines (cannot fabricate a violation)', () => {
    const f = frame({
      confidence: 'high',
      source: 'model',
      goal: 'wire the feed data',
      forks: [
        {
          id: 'F1',
          question: 'how should the feed load data?',
          options: ['client-side fetch', 'server component'],
          assumeIfUnasked: 'client-side fetch',
        },
      ],
    });
    const s = substantialSignals({ frame: f, task: 'wire the feed data to the api' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, { enabled: true });
    assert.notEqual(move.kind, 'push_back', 'no playbook ⇒ no taste-violation push_back');
  });
});

// ===========================================================================
// NO-MANUFACTURED-DISAGREEMENT — silence is correct without a grounded reason
// ===========================================================================

describe('push_back — no manufactured disagreement (silence is correct)', () => {
  it('an ordinary substantial build with NO red flag and NO taste violation does NOT push_back', () => {
    // A perfectly reversible, clearly-understood substantial build with the flag ON
    // and even with taste lines that are NOT violated → no push_back. The engine
    // returns its existing move; it never invents a disagreement to look thorough.
    const f = frame({
      confidence: 'high',
      source: 'model',
      goal: 'rebuild the billing subsystem',
    });
    const s = substantialSignals({
      frame: f,
      task: 'rebuild the billing subsystem end to end and add the new pricing tiers',
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const withFlag = decideNextMove(conf, f, s, plan, state(), noAsk, {
      enabled: true,
      tasteLines: ['unrelated subject: some other call'],
    });
    const noFlag = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.notEqual(withFlag.kind, 'push_back', 'no grounded reason ⇒ no push_back');
    assert.deepEqual(withFlag, noFlag, 'flag-on with no reason === flag-off behavior');
  });

  it('a TRIVIAL turn never push_backs (the fast-path guard holds with the flag ON)', () => {
    const f = frame({ confidence: 'low', source: 'skipped', goal: 'hi' });
    const s = signals({ task: 'hi', classification: classification({ tier: 'worker', risk: 'low' }) });
    const plan = planEngagement(s);
    const move = decideNextMove(assessConfidence(f, s), f, s, plan, state(), noAsk, ON);
    assert.equal(move.kind, 'answer');
  });

  it('a MEDIUM ordinary build never push_backs (the medium fast-path holds with the flag ON)', () => {
    const f = frame({ confidence: 'medium', source: 'model', goal: 'add a filter to the list view' });
    const s = signals({
      frame: f,
      task: 'add a filter to the list view',
      classification: classification({ tier: 'ic', risk: 'low' }),
    });
    const plan = planEngagement(s);
    const move = decideNextMove(assessConfidence(f, s, 'unread'), f, s, plan, state(), noAsk, ON);
    assert.equal(move.kind, 'answer', 'medium build: no push_back, no confirm gate');
  });
});

// ===========================================================================
// ASK-CALIBRATION — a genuine fork still asks; a weak signal proceeds-and-states
// ===========================================================================

describe('ask-calibration (sharper, not new) under the judgment flag', () => {
  it('a GENUINE non-investigable fork with a budgeted ask still ASKS (flag ON, no regression)', () => {
    const f = frame({
      confidence: 'low',
      source: 'model',
      kind: 'planning',
      goal: 'pick a datastore',
      forks: [{ id: 'F1', question: 'which would you prefer?', options: ['Postgres', 'Dynamo'] }],
    });
    const s = signals({
      frame: f,
      task: 'pick a datastore for the new service',
      engagementBias: 1, // collaborative → fork budget 1
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const qs: QuestionSet = {
      questions: [
        {
          id: 'F1',
          prompt: 'which?',
          options: [{ label: 'Postgres' }, { label: 'Dynamo' }],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    };
    const move = decideNextMove(conf, f, s, plan, state(), () => qs, ON);
    assert.equal(move.kind, 'ask', 'a genuine fork still earns the sharp ask');
  });

  it('a WEAK signal (no budgeted ask) PROCEEDS-and-states — does not ask (flag ON, no new asking)', () => {
    // Default bias → forkBudget 0 → no ask even with a fork present; the engine
    // states the assumption and proceeds, exactly as today (push_back is additive,
    // it does NOT add new asking).
    const f = frame({
      confidence: 'medium',
      source: 'model',
      kind: 'coding',
      goal: 'add the export button',
      forks: [{ id: 'F1', question: 'which export format?', options: ['csv', 'json'] }],
    });
    const s = signals({
      frame: f,
      task: 'add an export button to the report view',
      engagementBias: 0, // not collaborative → 0 asks
      classification: classification({ tier: 'ic', risk: 'low' }),
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk, ON);
    assert.notEqual(move.kind, 'ask', 'weak signal ⇒ proceed-and-state, not ask');
  });
});

// ===========================================================================
// detectTasteViolation — the pure predicate
// ===========================================================================

describe('detectTasteViolation', () => {
  it('returns the {recorded, planned} pair on a real departure', () => {
    const f = frame({
      forks: [
        {
          id: 'F1',
          question: 'data loading?',
          options: ['client fetch', 'server component'],
          assumeIfUnasked: 'client fetch',
        },
      ],
    });
    const v = detectTasteViolation(f, ['loading: server component']);
    assert.notEqual(v, null);
    assert.match(v!.recorded, /server component/i);
    assert.match(v!.planned, /client fetch/i);
  });
  it('null when the default already matches the recorded call', () => {
    const f = frame({
      forks: [
        {
          id: 'F1',
          question: 'data loading?',
          options: ['client fetch', 'server component'],
          assumeIfUnasked: 'server component',
        },
      ],
    });
    assert.equal(detectTasteViolation(f, ['loading: server component']), null);
  });
  it('null with no lines, no forks, or no frame', () => {
    assert.equal(detectTasteViolation(undefined, ['x: y']), null);
    assert.equal(detectTasteViolation(frame({ forks: [] }), ['x: y']), null);
    assert.equal(
      detectTasteViolation(
        frame({ forks: [{ id: 'F1', question: 'q', options: ['a', 'b'], assumeIfUnasked: 'a' }] }),
        [],
      ),
      null,
    );
  });
  it('never throws on garbage and returns null', () => {
    assert.equal(detectTasteViolation(undefined, undefined), null);
  });
});

// ===========================================================================
// THE PUSH-BACK RESOLUTION — accept/reject classification (taste round-trip)
// ===========================================================================

describe('classifyPushBackAnswer / isPushBackQuestionSet', () => {
  it('classifies the structured answers', () => {
    assert.equal(classifyPushBackAnswer('Go with your call'), 'accept');
    assert.equal(classifyPushBackAnswer('go with your call'), 'accept');
    assert.equal(classifyPushBackAnswer('Do it my way'), 'reject');
    assert.equal(classifyPushBackAnswer('Explain'), null, 'Explain ⇒ not a taste signal');
    assert.equal(classifyPushBackAnswer('use a different approach entirely'), null, 'free text ⇒ null');
    assert.equal(classifyPushBackAnswer(''), null);
  });
  it('recognises a push_back QuestionSet by its id', () => {
    const qs = buildPushBack('the reason', 'the rec', 'the subject');
    assert.equal(isPushBackQuestionSet(qs), true);
    assert.equal(isPushBackQuestionSet({ questions: [] }), false);
    assert.equal(isPushBackQuestionSet(undefined), false);
  });
  it('the built QuestionSet carries the named reason + recommendation + override-first options', () => {
    const qs = buildPushBack('this is irreversible', 'stage it behind a dry-run', 'the migration');
    const q = qs.questions[0]!;
    assert.match(q.prompt, /irreversible/);
    assert.match(q.prompt, /dry-run/);
    assert.match(q.prompt, /the migration/);
    assert.equal(q.options[0]?.label, 'Do it my way', 'override is the easy first option');
    assert.equal(q.options[1]?.label, 'Go with your call');
    assert.equal(q.allowFreeText, true, 'free text lets the user re-ground the decision');
  });
});
