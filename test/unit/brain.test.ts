/**
 * test/unit/brain.test.ts — the Adaptive Confidence Brain pure core
 * (src/core/brain.ts). PURE, table-testable: no I/O, no model call.
 *
 * Covers the confidence model (assessConfidence + the genuine-ambiguity
 * discriminator) and the per-iteration policy (decideNextMove): the fast-path
 * guard, the investigate decision, the reflect_confirm/ask decisions, and the
 * MAX_ROUNDS / opt-out bounds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessConfidence,
  decideNextMove,
  confidenceTooLowToAct,
  genuinelyAmbiguous,
  buildReflectConfirm,
  confidenceLine,
  understandingImproved,
  maxRoundsFor,
  CODEBASE_NARRATION,
  MAX_ROUNDS_DEFAULT,
  MAX_ROUNDS_COLLABORATIVE,
  type BrainLoopState,
  type Confidence,
} from '../../src/core/brain.ts';
import { planEngagement } from '../../src/core/engagement.ts';
import type { EngagementSignals } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Classification, QuestionSet } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Builders
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
  return {
    rounds: 0,
    groundedness: 'unread',
    optedOutOfDeepDive: false,
    maxRounds: MAX_ROUNDS_DEFAULT,
    ...over,
  };
}

const noAsk = (): QuestionSet | null => null;

// ---------------------------------------------------------------------------
// assessConfidence — the 3-tuple
// ---------------------------------------------------------------------------

describe('brain.assessConfidence', () => {
  it('reads stakes=high from high/critical risk', () => {
    const c = assessConfidence(frame(), signals({ classification: classification({ risk: 'high' }) }));
    assert.equal(c.stakes, 'high');
  });

  it('reads stakes=high from an irreversible task', () => {
    const c = assessConfidence(
      frame(),
      signals({ task: 'deploy the new build to production', classification: classification({ risk: 'low' }) }),
    );
    assert.equal(c.stakes, 'high');
  });

  it('reads stakes=low for an ordinary low-risk reversible turn', () => {
    const c = assessConfidence(
      frame({ confidence: 'high' }),
      signals({ task: 'rename a variable', classification: classification({ risk: 'low', tier: 'worker' }) }),
    );
    assert.equal(c.stakes, 'low');
  });

  it('passes through a measured low confidence as understanding=low', () => {
    const c = assessConfidence(frame({ confidence: 'low', source: 'model' }), signals());
    assert.equal(c.understanding, 'low');
  });

  it('HONESTY: an unmeasured (skipped) high prior on a NON-trivial turn is capped to medium', () => {
    // A skipped/rules-fallback frame's confidence is a tier PRIOR, not a measurement.
    const c = assessConfidence(
      frame({ confidence: 'high', source: 'skipped' }),
      signals({ task: 'redesign the auth and billing subsystems end to end' }),
    );
    assert.equal(c.understanding, 'medium', 'unmeasured high prior must not read as high');
  });

  it('threads the caller-supplied groundedness', () => {
    assert.equal(assessConfidence(frame(), signals(), 'grounded').groundedness, 'grounded');
    assert.equal(assessConfidence(frame(), signals()).groundedness, 'unread');
  });
});

// ---------------------------------------------------------------------------
// genuinelyAmbiguous — the parity-preserving discriminator
// ---------------------------------------------------------------------------

describe('brain.genuinelyAmbiguous', () => {
  it('true when the frame has a real fork', () => {
    const f = frame({
      confidence: 'high',
      forks: [{ id: 'F1', question: 'which datastore?', options: ['pg', 'dynamo'] }],
    });
    assert.equal(genuinelyAmbiguous(f, signals({ frame: f })), true);
  });

  it('true when the model MEASURED a non-high confidence', () => {
    const f = frame({ confidence: 'low', source: 'model' });
    assert.equal(genuinelyAmbiguous(f, signals({ frame: f })), true);
  });

  it('FALSE for a bare tier prior (skipped frame, no fork) — the parity guard', () => {
    const f = frame({ confidence: 'low', source: 'skipped' });
    assert.equal(
      genuinelyAmbiguous(f, signals({ frame: f })),
      false,
      'an unmeasured prior is not genuine ambiguity — the turn must proceed as today',
    );
  });

  it('FALSE for a confident measured frame with no fork', () => {
    const f = frame({ confidence: 'high', source: 'model' });
    assert.equal(genuinelyAmbiguous(f, signals({ frame: f })), false);
  });
});

describe('brain.confidenceTooLowToAct', () => {
  it('true on genuine LOW ambiguity, false on a bare prior', () => {
    const measured = frame({ confidence: 'low', source: 'model' });
    const prior = frame({ confidence: 'low', source: 'skipped' });
    assert.equal(
      confidenceTooLowToAct(assessConfidence(measured, signals({ frame: measured })), measured, signals({ frame: measured })),
      true,
    );
    assert.equal(
      confidenceTooLowToAct(assessConfidence(prior, signals({ frame: prior })), prior, signals({ frame: prior })),
      false,
    );
  });

  it('FALSE on a model-measured MEDIUM (the fast-path calibration — medium is NOT too low)', () => {
    // CALIBRATION #1: a medium-confidence build turn must NOT be "too low to act" —
    // it proceeds exactly as today, no scrape round.
    const medium = frame({ confidence: 'medium', source: 'model' });
    const s = signals({ frame: medium });
    assert.equal(confidenceTooLowToAct(assessConfidence(medium, s), medium, s), false);
  });
});

// ---------------------------------------------------------------------------
// decideNextMove — the per-iteration policy
// ---------------------------------------------------------------------------

describe('brain.decideNextMove — fast path', () => {
  it('a trivial turn returns answer with ZERO investigation (the hard fast-path guard)', () => {
    const s = signals({
      task: 'hi',
      classification: classification({ tier: 'worker', risk: 'low' }),
    });
    const f = frame({ confidence: 'low', source: 'skipped', goal: 'hi' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer');
  });

  it('a confident measured turn returns answer (no round)', () => {
    const f = frame({ confidence: 'high', source: 'model' });
    const s = signals({ frame: f });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer');
  });

  it('a bare-prior (skipped) substantial turn returns answer — runs with assumptions, as today', () => {
    const f = frame({ confidence: 'low', source: 'skipped' });
    const s = signals({ frame: f, task: 'redesign the auth and billing subsystems end to end' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer');
  });
});

describe('brain.decideNextMove — investigate', () => {
  it('a low-confidence INVESTIGABLE measured turn → investigate(codebase) with honest narration', () => {
    const f = frame({ confidence: 'low', source: 'model', kind: 'coding' });
    const s = signals({ frame: f, task: 'make the activity feed load real data' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'unread');
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'investigate');
    if (move.kind === 'investigate') {
      assert.equal(move.tool, 'codebase');
      assert.equal(move.narration, CODEBASE_NARRATION);
    }
  });

  it('does NOT investigate once grounded — re-assess routes onward (no spinning)', () => {
    const f = frame({ confidence: 'low', source: 'model', kind: 'coding' });
    const s = signals({ frame: f });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'grounded');
    const move = decideNextMove(conf, f, s, plan, state({ groundedness: 'grounded', rounds: 1 }), noAsk);
    assert.notEqual(move.kind, 'investigate');
  });

  it('does NOT investigate when MAX_ROUNDS reached (the bound)', () => {
    const f = frame({ confidence: 'low', source: 'model', kind: 'coding' });
    const s = signals({ frame: f });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'unread');
    const move = decideNextMove(
      conf,
      f,
      s,
      plan,
      state({ rounds: MAX_ROUNDS_DEFAULT }),
      noAsk,
    );
    assert.notEqual(move.kind, 'investigate');
  });

  it('does NOT investigate when the deep dive is opted out (direct posture)', () => {
    const f = frame({ confidence: 'low', source: 'model', kind: 'coding' });
    const s = signals({ frame: f });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'unread');
    const move = decideNextMove(conf, f, s, plan, state({ optedOutOfDeepDive: true }), noAsk);
    assert.notEqual(move.kind, 'investigate');
  });

  it('does NOT investigate a NON-investigable low-confidence turn', () => {
    const f = frame({ confidence: 'low', source: 'model', kind: 'planning', goal: 'plan the offsite' });
    const s = signals({ frame: f, task: 'plan a brand new product strategy from scratch' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'unread');
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.notEqual(move.kind, 'investigate');
  });
});

describe('brain.decideNextMove — ask / reflect_confirm', () => {
  it('a genuine non-investigable fork with a budgeted ask → ask(QuestionSet)', () => {
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
    const qs: QuestionSet = { questions: [{ id: 'F1', prompt: 'which?', options: [{ label: 'Postgres' }, { label: 'Dynamo' }], multiSelect: false, allowFreeText: true }] };
    const move = decideNextMove(conf, f, s, plan, state(), () => qs);
    assert.equal(move.kind, 'ask');
  });

  it('grounded + still genuinely-LOW (judgment call) → reflect_confirm', () => {
    const f = frame({
      confidence: 'low',
      source: 'model',
      kind: 'coding',
      goal: 'clean up the auth stuff',
      forks: [{ id: 'F1', question: 'which scope?', options: ['a', 'b'] }],
    });
    const s = signals({ frame: f, task: 'clean up the auth stuff' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'grounded');
    const move = decideNextMove(conf, f, s, plan, state({ groundedness: 'grounded', rounds: 1 }), noAsk);
    assert.equal(move.kind, 'reflect_confirm');
  });

  it('CALIBRATION #2: a SMALL clearly-understood IRREVERSIBLE task gets NO reflect_confirm — just answer', () => {
    // "delete the unused import" — high stakes (irreversible lexicon), but clearly
    // understood (measured high, no fork) and NOT substantial scope → just do it.
    const f = frame({ confidence: 'high', source: 'model', kind: 'coding', goal: 'delete the unused import' });
    const s = signals({
      frame: f,
      task: 'delete the unused import',
      classification: classification({ tier: 'worker', risk: 'low' }),
    });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s);
    assert.equal(conf.stakes, 'high', 'delete IS irreversible/high-stakes');
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer', 'high-stakes alone must NOT gate a clearly-understood small task');
  });

  it('CALIBRATION #2: a clearly-understood "delete the dead /legacy route" gets NO reflect_confirm', () => {
    const f = frame({ confidence: 'high', source: 'model', kind: 'coding', goal: 'delete the dead /legacy route' });
    const s = signals({
      frame: f,
      task: 'delete the dead /legacy route',
      classification: classification({ tier: 'worker', risk: 'low' }),
    });
    const plan = planEngagement(s);
    const move = decideNextMove(assessConfidence(f, s), f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer');
  });

  it('CALIBRATION #2: a SUBSTANTIAL big-scope build DOES get a reflect_confirm plan proposal', () => {
    // route.plan + manager tier + multi-clause → scopeScore clears PLAN_T → substantial.
    const f = frame({
      confidence: 'high',
      source: 'model',
      kind: 'coding',
      goal: 'rebuild the billing subsystem',
    });
    const s = signals({
      frame: f,
      task: 'rebuild the billing subsystem end to end, migrate the data, and cut over the API',
      classification: classification({ tier: 'manager', risk: 'medium' }),
      routePlan: true,
    });
    const plan = planEngagement(s);
    assert.equal(plan.planFirst, true, 'a big-scope build is planFirst (the substantial signal)');
    const move = decideNextMove(assessConfidence(f, s), f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'reflect_confirm', 'a substantial build earns a plan proposal');
  });
});

describe('brain.decideNextMove — medium-confidence fast path (CALIBRATION #1)', () => {
  it('a model-measured MEDIUM investigable build turn does NOT investigate — it answers', () => {
    // The key fast-path proof at the pure layer: medium ≠ too-low, so step 2
    // (investigate) does not fire and the ordinary build turn flows to answer.
    const f = frame({ confidence: 'medium', source: 'model', kind: 'coding', goal: 'build X' });
    const s = signals({ frame: f, task: 'make the activity feed load real data from the api' });
    const plan = planEngagement(s);
    const conf = assessConfidence(f, s, 'unread');
    assert.equal(conf.understanding, 'medium');
    const move = decideNextMove(conf, f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer', 'a medium-confidence build turn proceeds, no scrape');
  });
});

// ---------------------------------------------------------------------------
// FAST-PATH PRESERVATION (the 3.30.0 calibration) — the Phase 1/2/4 upgrades
// enrich the CONTENT at the EXISTING decision points; they add NO new trigger
// and must NOT make an ordinary turn loop or confirm. These assert the move on
// the FIRST assessment is `answer` (zero extra rounds, zero confirm) for both a
// trivial turn and a model-measured-MEDIUM build turn.
// ---------------------------------------------------------------------------
describe('brain — fast-path preservation after the depth upgrades', () => {
  it('a TRIVIAL turn answers immediately — zero rounds, zero confirm', () => {
    const f = frame({ confidence: 'low', source: 'skipped', goal: 'hi' });
    const s = signals({ task: 'hi', classification: classification({ tier: 'worker', risk: 'low' }) });
    const plan = planEngagement(s);
    const move = decideNextMove(assessConfidence(f, s), f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer');
  });

  it('a model-measured MEDIUM build turn answers immediately — no investigate, no reflect_confirm', () => {
    const f = frame({ confidence: 'medium', source: 'model', kind: 'coding', goal: 'add a filter to the list view' });
    const s = signals({ frame: f, task: 'add a filter to the list view', classification: classification({ tier: 'ic', risk: 'low' }) });
    const plan = planEngagement(s);
    const move = decideNextMove(assessConfidence(f, s, 'unread'), f, s, plan, state(), noAsk);
    assert.equal(move.kind, 'answer', 'medium build: no extra round, no confirm gate');
  });
});

// ---------------------------------------------------------------------------
// reflect_confirm proposal + bounds helpers
// ---------------------------------------------------------------------------

describe('brain.buildReflectConfirm', () => {
  it('reflects the real goal + doneWhen, with [Go]/[Edit]/[No] options', () => {
    const qs = buildReflectConfirm(frame({ goal: 'wire the feed to fetchFeed()', doneWhen: 'loading + empty states render' }));
    assert.ok(qs !== null);
    const q = qs!.questions[0]!;
    assert.ok(q.prompt.includes('wire the feed to fetchFeed()'), 'reflects the real goal');
    assert.ok(q.prompt.includes('loading + empty states render'), 'reflects the real doneWhen');
    assert.deepEqual(q.options.map((o) => o.label), ['Go', 'Edit', 'No']);
    assert.equal(q.allowFreeText, true);
  });

  it('returns null with no usable goal (never fabricates)', () => {
    assert.equal(buildReflectConfirm(undefined), null);
    assert.equal(buildReflectConfirm(frame({ goal: '   ' })), null);
  });

  it('PHASE 2: emits a PROACTIVE grounded multi-step plan from real forks/constraints/doneWhen', () => {
    const f = frame({
      goal: 'make the feed load real data',
      confidence: 'low',
      source: 'model',
      forks: [
        {
          id: 'F1',
          question: 'How should the feed load data?',
          options: [
            'Server-Component streaming in src/feed/page.tsx',
            'Client SWR via a new /api/feed route',
          ],
          assumeIfUnasked: 'Server-Component streaming in src/feed/page.tsx',
        },
      ],
      constraints: ['Node 22'],
      doneWhen: 'loading + empty states render',
    });
    const qs = buildReflectConfirm(f, { grounded: true });
    assert.ok(qs !== null);
    const p = qs!.questions[0]!.prompt;
    assert.ok(/I'm aligned/i.test(p), 'reads as a proactive proposal, not a hesitant echo');
    // grounded per-area plan steps: the chosen default + the constraint + done-when.
    assert.ok(p.includes('Server-Component streaming in src/feed/page.tsx'), 'states the chosen default (grounded file)');
    assert.ok(/say so if you'd rather Client SWR/i.test(p), 'invites a correction to the alternative');
    assert.ok(p.includes('Node 22'), 'honors the real constraint as a step');
    assert.ok(p.includes('loading + empty states render'), 'closes on the real done-when');
    assert.ok(/\b1\)/.test(p) && /\b2\)/.test(p), 'numbered multi-step plan');
    assert.ok(/Go\?/.test(p), 'ends with the go gate');
    // never fabricates: the plan only contains frame-sourced substance.
    assert.deepEqual(qs!.questions[0]!.options.map((o) => o.label), ['Go', 'Edit', 'No']);
  });

  it('PHASE 2: falls back to the honest simple proposal when the frame has no plannable substance', () => {
    // No forks, no constraints, no doneWhen → no plan steps → honest goal-echo.
    const qs = buildReflectConfirm(frame({ goal: 'tidy the imports', confidence: 'low', source: 'model' }));
    assert.ok(qs !== null);
    const p = qs!.questions[0]!.prompt;
    assert.ok(p.includes("Here's what I understand you want: tidy the imports"), 'honest simple proposal');
    assert.ok(!/Here's my plan/i.test(p), 'no fabricated plan when there is no substance');
  });

  it('PHASE 4: surfaces the honest confidence line when a tuple is supplied', () => {
    const f = frame({ goal: 'rebuild billing', confidence: 'medium', source: 'model' });
    const conf: Confidence = { understanding: 'medium', groundedness: 'grounded', stakes: 'low' };
    const qs = buildReflectConfirm(f, { conf, grounded: true });
    const p = qs!.questions[0]!.prompt;
    assert.ok(/Confident I understand this after checking the project layout/i.test(p));
    assert.ok(!/\d+%/.test(p), 'HONESTY: no fabricated percentage');
  });
});

describe('brain.confidenceLine — PHASE 4 (honest, no numbers)', () => {
  const mk = (over: Partial<Confidence>): Confidence => ({
    understanding: 'medium',
    groundedness: 'unread',
    stakes: 'low',
    ...over,
  });

  it('low understanding → still-forming phrasing', () => {
    assert.ok(/still forming a view/i.test(confidenceLine(mk({ understanding: 'low' }))));
  });

  it('medium + ungrounded → fairly confident', () => {
    assert.equal(confidenceLine(mk({ understanding: 'medium', groundedness: 'unread' })), 'Fairly confident I understand this');
  });

  it('medium + grounded → confident after checking the layout (rose after the round)', () => {
    assert.ok(/after checking the project layout/i.test(confidenceLine(mk({ understanding: 'medium', groundedness: 'grounded' }))));
  });

  it('high understanding → confident', () => {
    assert.ok(/Confident I understand what you want/i.test(confidenceLine(mk({ understanding: 'high' }))));
  });

  it('high stakes appends an honest caution', () => {
    assert.ok(/high-stakes/i.test(confidenceLine(mk({ understanding: 'high', stakes: 'high' }))));
  });

  it('maps the EXACT tuple decideNextMove computes — never a fabricated number', () => {
    for (const u of ['low', 'medium', 'high'] as const) {
      for (const g of ['unread', 'grounded'] as const) {
        for (const s of ['low', 'high'] as const) {
          const line = confidenceLine({ understanding: u, groundedness: g, stakes: s });
          assert.ok(line.length > 0);
          assert.ok(!/\d/.test(line), 'no digits/percentages in the honest line');
        }
      }
    }
  });

  it('returns "" for an absent tuple', () => {
    assert.equal(confidenceLine(undefined), '');
  });
});

describe('brain.bounds helpers', () => {
  it('maxRoundsFor: collaborative=3, others=2', () => {
    assert.equal(maxRoundsFor('collaborative'), MAX_ROUNDS_COLLABORATIVE);
    assert.equal(maxRoundsFor('balanced'), MAX_ROUNDS_DEFAULT);
    assert.equal(maxRoundsFor('direct'), MAX_ROUNDS_DEFAULT);
    assert.equal(maxRoundsFor(undefined), MAX_ROUNDS_DEFAULT);
  });

  it('understandingImproved: only a strict rank increase counts', () => {
    assert.equal(understandingImproved('low', 'medium'), true);
    assert.equal(understandingImproved('medium', 'high'), true);
    assert.equal(understandingImproved('low', 'low'), false);
    assert.equal(understandingImproved('high', 'low'), false);
  });
});
