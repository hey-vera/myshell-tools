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
  autoPostureForMode,
  pollPermittedConservative,
  type TaskShape,
  type AllocateInput,
  type AllocationPlan,
  type TierRequest,
  type Verbosity,
  type Verify,
  type Lever,
} from '../../src/core/governor.ts';
import { autoModeForPlanInfos, classifyPlan } from '../../src/core/policy.ts';
import { pressureFromSignals } from '../../src/core/capability-budget.ts';
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

  it('PHASE 3: verify is tests-first on a diff shape, none on non-diff; concurrency always 1', () => {
    const modes: Mode[] = ['cost-saver', 'balanced', 'quality-first'];
    for (const mode of modes) {
      // Non-diff shape (a clearly-understood plain answer — not repo-oriented, high
      // confidence so it is NOT `investigate`) → no verification.
      const s = signals({ task: 'what is a closure in JS?' });
      const conf = assessConfidence(frame({ confidence: 'high' }), s);
      const explain = allocate(allocInput({ mode, signals: s, conf, repoOriented: false }));
      assert.strictEqual(explain.shape, 'explain', `the no-diff case is the explain shape (${mode})`);
      assert.strictEqual(explain.verify, 'none', `non-diff shape skips verify (${explain.shape}/${mode})`);
      // Diff shape (build) single-vendor low-stakes → tests-first only, no paid critic.
      const build = allocate(
        allocInput({ mode, signals: s, conf, repoOriented: true, authedProviderCount: 1 }),
      );
      assert.strictEqual(build.verify, 'tests', `build verifies tests-first (${build.shape}/${mode})`);
      assert.ok(!build.levers.includes('critic'), 'single-vendor low-stakes never opens a paid critic');
      // Concurrency stays single-goal (Phase 6 lights it up).
      assert.strictEqual(explain.concurrency, 1, `concurrency is single-goal (${explain.shape}/${mode})`);
      assert.strictEqual(build.concurrency, 1, `concurrency is single-goal (${build.shape}/${mode})`);
    }
  });

  it('PHASE 3: high-stakes diff + 2 vendors + budget → tests+critic (the one paid lever)', () => {
    const s = signals({ task: 'rewrite the auth token refresh', classification: classification({ risk: 'high' }) });
    const conf = assessConfidence(frame({ confidence: 'low' }), s);
    const plan = allocate(
      allocInput({
        signals: s,
        conf,
        repoOriented: true,
        mode: 'quality-first',
        authedProviderCount: 2,
      }),
    );
    // High stakes makes this `risky`; with 2 vendors + a Max budget the critic fires.
    assert.strictEqual(plan.verify, 'tests+critic', 'high-stakes diff earns the diff-scoped critic');
    assert.ok(plan.levers.includes('critic'), 'the critic is recorded as a spent lever');
    assert.ok(plan.levers.length <= plan.turnCallBudget, 'levers never exceed the hard budget');
  });

  it('PHASE 3: single-vendor high-stakes diff stays tests-only (no faked cross-vendor critic)', () => {
    const s = signals({ task: 'rewrite the auth token refresh', classification: classification({ risk: 'high' }) });
    const conf = assessConfidence(frame({ confidence: 'low' }), s);
    const plan = allocate(
      allocInput({
        signals: s,
        conf,
        repoOriented: true,
        mode: 'quality-first',
        authedProviderCount: 1,
      }),
    );
    assert.strictEqual(plan.verify, 'tests', 'one vendor → tests-first only, never a faked critic');
    assert.ok(!plan.levers.includes('critic'), 'no cross-vendor critic with a single vendor');
    assert.ok(plan.locked.includes('critic'), 'the locked critic cell is surfaced honestly');
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

// ===========================================================================
// C) PHASE 4 — SUBSCRIPTION-ADAPTIVE AUTO BUDGET (Part A)
//
// The user's explicit ask: "smart auto mode should auto-adapt to their
// subscription types." The budget DERIVES from the detected strongest tier:
// Free ⇒ conservative (budget 1, no paid levers), Pro ⇒ balanced (2), Max ⇒
// full (3). An UNKNOWN / undetected plan resolves to the SAFE conservative middle
// (balanced/2) — NEVER Max. These exercise the REAL detect→mode seam
// (autoModeForPlanInfos over classified PlanInfos) so the budget can never be
// detached from the detected subscription.
// ===========================================================================

describe('governor — subscription-adaptive auto budget (Phase 4 Part A)', () => {
  // A non-trivial build turn (so the budget is the tier base, not the quick=1
  // short-circuit) — the population whose budget the tier actually sets.
  function buildPlanFor(mode: AllocateInput['mode']): AllocationPlan {
    const s = signals({ task: 'add a logout button to the navbar' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    return allocate(allocInput({ signals: s, conf, repoOriented: true, mode }));
  }

  it('Max plan ⇒ full budget 3 (the detected Max tier → quality-first → 3)', () => {
    const mode = autoModeForPlanInfos([classifyPlan('claude max 20x')]);
    assert.strictEqual(mode, 'quality-first', 'precondition: a Max plan → quality-first');
    assert.strictEqual(buildPlanFor(mode).turnCallBudget, 3, 'Max ⇒ budget 3 (full)');
  });

  it('Pro plan ⇒ balanced budget 2 (the detected Pro tier → balanced → 2)', () => {
    const mode = autoModeForPlanInfos([classifyPlan('pro')]);
    assert.strictEqual(mode, 'balanced', 'precondition: a Pro plan → balanced');
    assert.strictEqual(buildPlanFor(mode).turnCallBudget, 2, 'Pro ⇒ budget 2 (balanced)');
  });

  it('Free plan ⇒ conservative budget 1 AND no paid levers (no Oracle even on decide)', () => {
    const mode = autoModeForPlanInfos([classifyPlan('free')]);
    assert.strictEqual(mode, 'cost-saver', 'precondition: a Free plan → cost-saver');
    const build = buildPlanFor(mode);
    assert.strictEqual(build.turnCallBudget, 1, 'Free ⇒ budget 1 (conservative)');
    // A Free decision turn must STILL never open the paid strong model.
    const s = signals({ task: 'should we use Redux or Context?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    const decide = allocate(allocInput({ signals: s, conf, substantial: true, mode }));
    assert.strictEqual(decide.shape, 'decide');
    assert.strictEqual(decide.tierRequest, 'ic', 'Free never requests the Oracle (no paid lever)');
    assert.ok(!decide.levers.includes('oracle'));
    assert.ok(!decide.levers.includes('critic'), 'Free opens no paid cross-vendor lever');
  });

  it('UNKNOWN / undetected plan ⇒ the SAFE conservative middle (budget 2), NEVER Max', () => {
    // CLI reported NO plan → classifyPlan → confidence 'none' → autoModeForPlanInfos
    // resolves to 'balanced' (the safe middle), NOT 'quality-first'. The budget must
    // be 2 (never the Max 3) — we never assume Max on an undetected plan.
    const mode = autoModeForPlanInfos([classifyPlan(null)]);
    assert.strictEqual(mode, 'balanced', 'precondition: no plan signal → balanced (safe middle)');
    const plan = buildPlanFor(mode);
    assert.strictEqual(plan.turnCallBudget, 2, 'unknown plan ⇒ safe middle budget 2, never Max 3');
    assert.notStrictEqual(plan.turnCallBudget, 3, 'an undetected plan never gets the Max budget');
  });

  it('single-vendor: the budget adapts to THAT one vendor’s detected plan', () => {
    // One authed vendor on a Free plan → cost-saver → frugal budget 1; the same
    // single vendor on a Max plan → quality-first → 3. The adaptation tracks the one
    // detected plan, with no cross-vendor assumption.
    const freeMode = autoModeForPlanInfos([classifyPlan('claude free')]);
    const maxMode = autoModeForPlanInfos([classifyPlan('claude max 5x')]);
    assert.strictEqual(buildPlanFor(freeMode).turnCallBudget, 1, 'single Free vendor → 1');
    assert.strictEqual(buildPlanFor(maxMode).turnCallBudget, 3, 'single Max vendor → 3');
  });

  it('the honest AUTO POSTURE label is a pure projection of the SAME mode (never overstates)', () => {
    // The label must match the budget the governor actually sets, by construction.
    assert.strictEqual(autoPostureForMode('quality-first'), 'full'); //   budget 3
    assert.strictEqual(autoPostureForMode('balanced'), 'balanced'); //    budget 2
    assert.strictEqual(autoPostureForMode('cost-saver'), 'conservative'); // budget 1
    // The crucial honesty: an unknown plan → balanced → 'balanced', never 'full'.
    assert.strictEqual(
      autoPostureForMode(autoModeForPlanInfos([classifyPlan(null)])),
      'balanced',
      'undetected plan → balanced posture, never the Max "full"',
    );
  });
});

// ===========================================================================
// D) PHASE 4 — REAL PRESSURE SHRINKS THE BUDGET, FROM THE REAL SIGNAL (Part B)
//
// Phase 2 fed the governor an honest 0 (no real signal threaded). Phase 4 threads
// the REAL pressure dimension the caller observes — the count of providers in
// rate-limit cooldown (real 429s this session), via `pressureFromSignals` — into
// the consult. These assert the budget shrinks UNDER that real pressure and that
// the pressure value is SOURCED FROM the real signal (pressureFromSignals over the
// cooled-provider count), not fabricated.
// ===========================================================================

describe('governor — real pressure shrinks the budget honestly (Phase 4 Part B)', () => {
  function maxDecide(pressure: AllocateInput['pressure']): AllocationPlan {
    const s = signals({ task: 'should we use Redux or Context?' });
    const conf = assessConfidence(frame({ confidence: 'high' }), s);
    return allocate(allocInput({ signals: s, conf, substantial: true, mode: 'quality-first', pressure }));
  }

  it('the pressure input is SOURCED from the real signal (pressureFromSignals over cooled count)', () => {
    // The exact computation the caller performs at the admission consult: the count
    // of providers in rate-limit cooldown mapped by the pure pressureFromSignals.
    // Asserting the governor consumes THIS value (not a fabricated one) is the
    // honesty contract of Part B.
    const realPressureTwoCooled = pressureFromSignals({ rateLimitedProviderCount: 2 });
    assert.strictEqual(realPressureTwoCooled, 2, 'two cooled providers → real pressure 2');
    const plan = maxDecide(realPressureTwoCooled);
    assert.strictEqual(plan.turnCallBudget, 1, 'Max 3 shrinks to 1 under real pressure 2');
    assert.ok(
      plan.reasons.some((r) => /conserving|pressure/i.test(r)),
      'the honest shrink is surfaced in reasons',
    );
  });

  it('NO real pressure (no cooled providers) ⇒ the full tier budget, byte-identical to Phase-2 zero', () => {
    const realZero = pressureFromSignals({ rateLimitedProviderCount: 0 });
    assert.strictEqual(realZero, 0, 'no cooled providers → real pressure 0');
    // The honest-zero (deps.governorPressure absent) path is pressureFromSignals({}).
    assert.strictEqual(pressureFromSignals({}), 0, 'absent signal → honest 0');
    assert.strictEqual(maxDecide(realZero).turnCallBudget, 3, 'no pressure → the full Max budget 3');
  });

  it('graduated: real pressure 1 shrinks Max 3→2; pressure 3 floors it at 1 (never 0)', () => {
    assert.strictEqual(maxDecide(pressureFromSignals({ rateLimitedProviderCount: 1 })).turnCallBudget, 2);
    assert.strictEqual(maxDecide(pressureFromSignals({ rateLimitedProviderCount: 3 })).turnCallBudget, 1);
    // The core answer is un-sheddable: the budget floors at 1, never 0.
    assert.strictEqual(maxDecide(3).turnCallBudget, 1, 'budget floors at 1 (core answer never shed)');
  });
});

// ===========================================================================
// H) THE PLURAL JUDGMENT POLL gate (master-plan PHASE 7 / judgment §5.3)
// ===========================================================================

describe('governor.allocate — the judgment poll lever', () => {
  // A genuine DECISION turn: substantial, NOT high-stakes (so shape is `decide`,
  // not `risky`), repo-oriented, with a fork.
  function decideInput(over: Partial<AllocateInput> = {}): AllocateInput {
    const f = frame({ confidence: 'medium', source: 'model' });
    const s = signals({ frame: f, task: 'should the feed stream server-side or fetch client-side?' });
    return allocInput({
      signals: s,
      frame: f,
      conf: assessConfidence(f, s),
      substantial: true,
      repoOriented: false,
      ...over,
    });
  }

  it('GRANTS the poll on a decide turn with ≥2 vendors + budget (Balanced/Max)', () => {
    const plan = allocate(decideInput({ mode: 'balanced', authedProviderCount: 2 }));
    assert.strictEqual(plan.shape, 'decide');
    assert.strictEqual(plan.pollAllowed, true);
    assert.ok(plan.levers.includes('poll'), 'the poll is a recorded spent lever');
    assert.ok(plan.levers.length <= plan.turnCallBudget, 'poll never blows the hard budget');
  });

  it('SINGLE-VENDOR → pollAllowed false (no plural poll; locked surfaced honestly)', () => {
    const plan = allocate(decideInput({ mode: 'balanced', authedProviderCount: 1 }));
    assert.strictEqual(plan.pollAllowed, false);
    assert.ok(!plan.levers.includes('poll'));
    assert.ok(plan.locked.includes('poll'), 'the locked poll cell is honest, not nagged');
  });

  it('FRUGAL (cost-saver/Free) NEVER opens the poll', () => {
    const plan = allocate(decideInput({ mode: 'cost-saver', authedProviderCount: 2 }));
    assert.strictEqual(plan.pollAllowed, false);
    assert.ok(!plan.levers.includes('poll'));
  });

  it('NO BUDGET (pressure shrinks below the poll minimum) → no poll', () => {
    // Balanced base 2, pressure 1 → budget 1 < POLL_MIN_BUDGET (2) → refused.
    const plan = allocate(decideInput({ mode: 'balanced', authedProviderCount: 2, pressure: 1 }));
    assert.strictEqual(plan.turnCallBudget, 1);
    assert.strictEqual(plan.pollAllowed, false);
    assert.ok(plan.reasons.some((r) => /poll refused/i.test(r)), 'records the refusal reason');
  });

  it('the poll and the critic NEVER both fire (a build/risky turn → critic, not poll)', () => {
    // A high-stakes diff turn classifies `risky` and earns the critic; the poll yields.
    const s = signals({ task: 'rewrite the auth token refresh', classification: classification({ risk: 'high' }) });
    const conf = assessConfidence(frame({ confidence: 'low' }), s);
    const plan = allocate(allocInput({ signals: s, conf, repoOriented: true, mode: 'quality-first', authedProviderCount: 2 }));
    assert.strictEqual(plan.verify, 'tests+critic');
    assert.ok(plan.levers.includes('critic'));
    assert.ok(!plan.levers.includes('poll'), 'poll and critic never both fire on one turn');
    assert.ok(plan.levers.length <= plan.turnCallBudget);
  });

  it('a non-decision shape (build/explain/quick) never grants the poll', () => {
    const build = allocate(allocInput({ repoOriented: true, mode: 'balanced', authedProviderCount: 2 }));
    assert.notStrictEqual(build.shape, 'decide');
    assert.strictEqual(build.pollAllowed, false);
  });
});

describe('governor.pollPermittedConservative — the Governor-OFF built-in default', () => {
  it('grants ONLY on a high-stakes fork with ≥2 vendors', () => {
    assert.strictEqual(pollPermittedConservative(true, 2), true);
  });
  it('denies on low stakes, or <2 vendors', () => {
    assert.strictEqual(pollPermittedConservative(false, 2), false);
    assert.strictEqual(pollPermittedConservative(true, 1), false);
    assert.strictEqual(pollPermittedConservative(false, 1), false);
  });
});
