/**
 * test/unit/governor.test.ts — THE PERFORMANCE GOVERNOR pure core
 * (src/core/governor.ts). PURE, table-testable: no I/O, no model call, ZERO live
 * model calls.
 *
 * Two halves:
 *
 *   A) classifyTaskShape — the ~30-line pure projection, exercised over the REAL
 *      predicates it reuses (isTrivial / confidenceTooLowToAct / the substantial &
 *      repoOriented flags the directive computes). We assert each shape is reached
 *      by its genuine signal and that the precedence (stakes win, then decide, then
 *      investigate, then build, then the explain default) holds.
 *
 *   B) allocate — the DETERMINISTIC INVARIANT TRIPWIRES (perf doc §6.2 / build
 *      PHASE 2): trivial → budget 1 and NO escalation lever; total levers chosen ≤
 *      turnCallBudget; a locked cross-vendor lever is NEVER chosen when
 *      authedProviderCount < 2; Free never auto-opens the Oracle; the declared-but-
 *      inactive cells (verify, concurrency) hold at their Phase-2 values.
 *
 * The FLAG-OFF neutrality invariant (the governor's plan is not applied when
 * MYSHELL_GOVERNOR is off) is proven at the orchestrate seam by the unchanged
 * characterization tests (orchestrate-oracle.test.ts) — the governor module itself
 * is pure and has no flag; the flag gates the CONSULT, not the math.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyTaskShape,
  allocate,
  type TaskShape,
  type AllocateInput,
  type AllocationPlan,
  type TierRequest,
  type Verbosity,
  type Verify,
  type Lever,
} from '../../src/core/governor.ts';
import { assessConfidence, maxRoundsFor, type Confidence } from '../../src/core/brain.ts';
import type { EngagementSignals, EngagementPlan } from '../../src/core/engagement.ts';
import { planEngagement } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';
import type { Mode } from '../../src/core/policy.ts';

// ---------------------------------------------------------------------------
// Builders (mirror brain.test.ts)
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

/** Build a complete AllocateInput, deriving conf from the REAL assessConfidence. */
function allocInput(over: Partial<AllocateInput> = {}): AllocateInput {
  const s = over.signals ?? signals();
  const f = 'frame' in over ? over.frame : frame();
  const conf = over.conf ?? assessConfidence(f, s);
  const plan = over.plan ?? planEngagement(s);
  return {
    conf,
    frame: f,
    signals: s,
    plan,
    substantial: over.substantial ?? false,
    repoOriented: over.repoOriented ?? false,
    mode: over.mode ?? 'balanced',
    authedProviderCount: over.authedProviderCount ?? 1,
    pressure: over.pressure ?? 0,
    maxRounds: over.maxRounds ?? maxRoundsFor(undefined),
  };
}

function shapeOf(over: Partial<AllocateInput> = {}): TaskShape {
  const i = allocInput(over);
  return classifyTaskShape({
    conf: i.conf,
    frame: i.frame,
    signals: i.signals,
    plan: i.plan,
    substantial: i.substantial,
    repoOriented: i.repoOriented,
  });
}

// A genuinely trivial turn the engagement fast-path exempts: worker tier, low
// risk, single short clause (the exact gate isTrivial enforces).
const TRIVIAL = signals({
  task: 'hi',
  classification: classification({ tier: 'worker', risk: 'low' }),
});

// ===========================================================================
// A) classifyTaskShape — over the real predicates
// ===========================================================================

describe('governor.classifyTaskShape', () => {
  it('quick ← isTrivial (the same population the fast-path exempts)', () => {
    const s = TRIVIAL;
    const conf = assessConfidence(undefined, s);
    assert.strictEqual(shapeOf({ signals: s, frame: undefined, conf }), 'quick');
  });

  it('risky ← high stakes (risk high) dominates even a decision-shaped turn', () => {
    const s = signals({ classification: classification({ risk: 'high' }), task: 'should we deploy to prod?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    assert.strictEqual(conf.stakes, 'high', 'precondition: brain read stakes=high');
    // substantial=true (decision-shaped) but stakes WIN → risky, not decide.
    assert.strictEqual(shapeOf({ signals: s, conf, substantial: true }), 'risky');
  });

  it('risky ← irreversible task even at low risk classification', () => {
    const s = signals({ task: 'delete the production database' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    assert.strictEqual(conf.stakes, 'high', 'precondition: irreversible → stakes high');
    assert.strictEqual(shapeOf({ signals: s, conf }), 'risky');
  });

  it('decide ← substantial (decision/recommendation) when stakes are low', () => {
    const s = signals({ task: 'should we use Redux or Context for state?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    assert.strictEqual(conf.stakes, 'low', 'precondition: low stakes');
    assert.strictEqual(shapeOf({ signals: s, conf, substantial: true }), 'decide');
  });

  it('investigate ← confidenceTooLowToAct (genuinely-low + investigable)', () => {
    // A measured low-confidence frame with a real fork → genuinely ambiguous → too
    // low to act → investigate (the EXACT gate brain.ts uses for a hypothesis round).
    const f = frame({
      confidence: 'low',
      source: 'model',
      forks: [{ id: 'feed', question: 'which feed?', options: ['a', 'b'], assumeIfUnasked: 'a' }],
    } as Partial<IntentFrame>);
    const s = signals({ frame: f, task: 'why is the activity feed empty' });
    const conf = assessConfidence(f, s);
    assert.strictEqual(conf.understanding, 'low', 'precondition: understanding low');
    assert.strictEqual(shapeOf({ signals: s, frame: f, conf }), 'investigate');
  });

  it('build ← repoOriented (a code-change context) when not decide/investigate/risky', () => {
    const s = signals({ task: 'add a logout button to the navbar' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    assert.strictEqual(shapeOf({ signals: s, conf, repoOriented: true, substantial: false }), 'build');
  });

  it('explain ← the residual default (no diff, not a decision, not too-low)', () => {
    const s = signals({ task: 'how does the orchestrate loop work' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    assert.strictEqual(shapeOf({ signals: s, conf, repoOriented: false, substantial: false }), 'explain');
  });

  it('fail-soft: a malformed signals bag → explain (never throws)', () => {
    const bad = classifyTaskShape({
      conf: { understanding: 'medium', groundedness: 'unread', stakes: 'low' } as Confidence,
      frame: undefined,
      // deliberately malformed
      signals: null as unknown as EngagementSignals,
      plan: {} as EngagementPlan,
      substantial: false,
      repoOriented: false,
    });
    assert.strictEqual(bad, 'explain');
  });
});

// ===========================================================================
// B) allocate — the deterministic invariant tripwires
// ===========================================================================

describe('governor.allocate — invariant tripwires', () => {
  it('TRIVIAL → budget 1 and NO escalation lever (provably instant)', () => {
    const conf = assessConfidence(undefined, TRIVIAL);
    const plan = allocate(allocInput({ signals: TRIVIAL, frame: undefined, conf, mode: 'quality-first' }));
    assert.strictEqual(plan.shape, 'quick');
    assert.strictEqual(plan.turnCallBudget, 1, 'trivial budget is provably 1');
    assert.strictEqual(plan.tierRequest, 'ic', 'trivial never requests the Oracle');
    assert.ok(!plan.levers.includes('oracle'), 'no oracle escalation lever on a trivial turn');
    assert.strictEqual(plan.roundBudget, 0, 'no investigation rounds on a trivial turn');
    assert.strictEqual(plan.verbosity, 'terse', 'trivial is terse, never bloated');
  });

  it('INVARIANT: total levers chosen ≤ turnCallBudget, across every shape × tier', () => {
    const modes: Mode[] = ['cost-saver', 'balanced', 'quality-first'];
    const cases: Array<Partial<AllocateInput>> = [
      { signals: TRIVIAL, frame: undefined },
      { signals: signals({ task: 'add a logout button' }), repoOriented: true },
      { substantial: true, signals: signals({ task: 'redux or context?' }) },
      { signals: signals({ classification: classification({ risk: 'high' }), task: 'deploy to prod?' }) },
    ];
    for (const mode of modes) {
      for (const c of cases) {
        const plan = allocate(allocInput({ ...c, mode }));
        assert.ok(
          plan.levers.length <= plan.turnCallBudget,
          `levers (${plan.levers.length}) must be ≤ budget (${plan.turnCallBudget}) for ${plan.shape}/${mode}`,
        );
      }
    }
  });

  it('INVARIANT: a locked cross-vendor lever is NEVER chosen when authedProviderCount < 2', () => {
    // A build turn would reach for a `critic` (cross-vendor); with 1 vendor it must
    // be LOCKED, never in `levers`.
    const s = signals({ task: 'add a logout button' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const plan = allocate(
      allocInput({ signals: s, conf, repoOriented: true, authedProviderCount: 1, mode: 'quality-first' }),
    );
    assert.strictEqual(plan.shape, 'build');
    assert.ok(!plan.levers.includes('critic'), 'critic is never chosen with one vendor');
    assert.ok(plan.locked.includes('critic'), 'critic is recorded as locked (honest, not nagged)');
  });

  it('with ≥2 vendors the cross-vendor cell is no longer locked (auto-unlock)', () => {
    const s = signals({ task: 'add a logout button' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const plan = allocate(
      allocInput({ signals: s, conf, repoOriented: true, authedProviderCount: 2, mode: 'quality-first' }),
    );
    assert.strictEqual(plan.shape, 'build');
    assert.ok(!plan.locked.includes('critic'), 'critic is not locked once a 2nd vendor connects');
  });

  it('INVARIANT: Free (cost-saver) NEVER auto-opens the Oracle, even on a decide turn', () => {
    const s = signals({ task: 'should we use Redux or Context?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const plan = allocate(allocInput({ signals: s, conf, substantial: true, mode: 'cost-saver' }));
    assert.strictEqual(plan.shape, 'decide');
    assert.strictEqual(plan.turnCallBudget, 1, 'Free allowance is a frugal 1 call/turn');
    assert.strictEqual(plan.tierRequest, 'ic', 'Free never requests the Oracle');
    assert.ok(!plan.levers.includes('oracle'));
  });

  it('a Max decide turn DOES request the Oracle (the strong-model warrants it)', () => {
    const s = signals({ task: 'should we use Redux or Context?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const plan = allocate(allocInput({ signals: s, conf, substantial: true, mode: 'quality-first' }));
    assert.strictEqual(plan.shape, 'decide');
    assert.strictEqual(plan.tierRequest, 'oracle');
    assert.ok(plan.levers.includes('oracle'));
    assert.ok(plan.levers.length <= plan.turnCallBudget);
  });

  it('a routine build DEPRIORITIZES the Oracle (diff+tests buys more per token)', () => {
    const s = signals({ task: 'add a logout button' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const plan = allocate(allocInput({ signals: s, conf, repoOriented: true, mode: 'quality-first' }));
    assert.strictEqual(plan.shape, 'build');
    assert.strictEqual(plan.tierRequest, 'ic', 'a routine build does not burn the strong author');
  });

  it('INVARIANT: live pressure shrinks the allowance honestly and says so', () => {
    const s = signals({ task: 'should we use Redux or Context?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const base = allocate(allocInput({ signals: s, conf, substantial: true, mode: 'quality-first', pressure: 0 }));
    const squeezed = allocate(
      allocInput({ signals: s, conf, substantial: true, mode: 'quality-first', pressure: 2 }),
    );
    assert.strictEqual(base.turnCallBudget, 3);
    assert.strictEqual(squeezed.turnCallBudget, 1, 'pressure 2 shrinks Max 3→1');
    assert.ok(
      squeezed.reasons.some((r) => /conserving|pressure/i.test(r)),
      'the shrink is surfaced honestly in reasons',
    );
  });

  it('PHASE 2: verify is always none and concurrency always 1 (declared-but-inactive)', () => {
    const modes: Mode[] = ['cost-saver', 'balanced', 'quality-first'];
    for (const mode of modes) {
      for (const ro of [false, true]) {
        const plan = allocate(allocInput({ mode, repoOriented: ro }));
        assert.strictEqual(plan.verify, 'none', `verify is inactive in Phase 2 (${plan.shape}/${mode})`);
        assert.strictEqual(plan.concurrency, 1, `concurrency is single-goal in Phase 2 (${plan.shape}/${mode})`);
      }
    }
  });

  it('every allocation records auditable reasons (the refusal/grant trail)', () => {
    const plan = allocate(allocInput({ mode: 'quality-first', repoOriented: true }));
    assert.ok(plan.reasons.length > 0, 'reasons are always recorded for the honest receipt');
  });

  it('the AllocationPlan exposes its typed lever surface (public type contract)', () => {
    // Exercise the named field types so the public contract is anchored by a real
    // consumer (the levers light up in later phases; the types are stable now).
    const plan: AllocationPlan = allocate(allocInput({ mode: 'quality-first', repoOriented: true }));
    const tier: TierRequest = plan.tierRequest;
    const verbosity: Verbosity = plan.verbosity;
    const verify: Verify = plan.verify;
    const levers: readonly Lever[] = plan.levers;
    assert.ok(tier === 'ic' || tier === 'oracle');
    assert.ok(['terse', 'laddered', 'deep'].includes(verbosity));
    assert.ok(['none', 'tests', 'tests+critic', 'reviewed'].includes(verify));
    for (const l of levers) {
      assert.ok(['oracle', 'depth', 'critic', 'poll', 'tribunal'].includes(l));
    }
  });
});
