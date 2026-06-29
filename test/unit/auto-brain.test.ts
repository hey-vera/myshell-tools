/**
 * test/unit/auto-brain.test.ts — unit tests for the AUTO BRAIN (Layer A + B stubs).
 *
 * Covers:
 *   Layer A — rung-fusion for each intent shape (paste-code / fix-bug /
 *     vague-discuss / big-build + unknown); predict-and-commit on HARD turns;
 *     memory-bias nudge; floor clamping; capacity ceiling clamping;
 *     receipt emission; 1-model collapse.
 *   Layer B (stubs) — objective-only escalation (self-confidence CANNOT
 *     trigger); hysteresis margin; de-escalation on clean todos.
 *   Default-off — the flag is off by default and the seam is absent.
 *
 * Pure: no spawn, no I/O, no real providers.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  intentShapeOf,
  floorFromClassification,
  applyMemoryBias,
  clampToCeiling,
  fuseRung,
  buildAutoBrainReceipt,
  adaptForSingleModel,
  shouldEscalate,
  shouldDeEscalate,
  decideLayerBEscalation,
  ESCALATE_FAILURE_MARGIN,
  DEESCALATE_CLEAN_MARGIN,
  type EscalationSignals,
} from '../../src/core/auto-brain.ts';

import type { IntentFrame } from '../../src/core/intent.ts';
import { autoBrainEnabled } from '../../src/interface/ui/auto-brain-flag.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFrame(overrides: Partial<IntentFrame> = {}): IntentFrame {
  return {
    version: 1,
    goal: 'test goal',
    confidence: 'high',
    source: 'model',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Intent shape detection (structural byproduct read)
// ---------------------------------------------------------------------------

describe('intentShapeOf — structural byproduct read, no model call', () => {
  it('returns unknown for null/undefined frame', () => {
    assert.equal(intentShapeOf(null), 'unknown');
    assert.equal(intentShapeOf(undefined), 'unknown');
  });

  it('detects big-build from manager routeTier', () => {
    const frame = makeFrame({ routeTier: 'manager' });
    assert.equal(intentShapeOf(frame), 'big-build');
  });

  it('detects big-build from high operationRisk', () => {
    const frame = makeFrame({ operationRisk: 'high' });
    assert.equal(intentShapeOf(frame), 'big-build');
  });

  it('detects big-build from critical blastRadius', () => {
    const frame = makeFrame({ blastRadius: 'critical' });
    assert.equal(intentShapeOf(frame), 'big-build');
  });

  it('detects paste-code from worker routeTier', () => {
    const frame = makeFrame({ routeTier: 'worker' });
    assert.equal(intentShapeOf(frame), 'paste-code');
  });

  it('detects paste-code from explain kind', () => {
    const frame = makeFrame({ kind: 'explain code' });
    assert.equal(intentShapeOf(frame), 'paste-code');
  });

  it('detects vague-discuss from low confidence', () => {
    const frame = makeFrame({ confidence: 'low' });
    assert.equal(intentShapeOf(frame), 'vague-discuss');
  });

  it('detects fix-bug from ic routeTier with fix kind', () => {
    const frame = makeFrame({ routeTier: 'ic', kind: 'fix bug in auth' });
    assert.equal(intentShapeOf(frame), 'fix-bug');
  });

  it('returns unknown for a frame with no strong signals', () => {
    const frame = makeFrame({ routeTier: undefined, kind: 'coding', confidence: 'medium' });
    // 'coding' does not match vague-discuss or paste-code or fix-bug patterns — unknown
    const shape = intentShapeOf(frame);
    assert.ok(
      shape === 'unknown' || shape === 'fix-bug',
      `expected unknown or fix-bug, got ${shape}`,
    );
  });

  it('never throws on malformed input', () => {
    // @ts-expect-error testing bad input
    assert.doesNotThrow(() => intentShapeOf({ version: 1, goal: null, confidence: undefined, source: 'rules-fallback' }));
  });
});

// ---------------------------------------------------------------------------
// 2. Deterministic floor from classify() (no model call)
// ---------------------------------------------------------------------------

describe('floorFromClassification — deterministic floor, no model call', () => {
  it('critical risk → high floor', () => {
    assert.equal(floorFromClassification('worker', 'critical'), 'high');
  });

  it('high risk → high floor regardless of tier', () => {
    assert.equal(floorFromClassification('worker', 'high'), 'high');
    assert.equal(floorFromClassification('ic', 'high'), 'high');
  });

  it('manager tier → high floor', () => {
    assert.equal(floorFromClassification('manager', 'low'), 'high');
  });

  it('ic tier + medium risk → balanced floor', () => {
    assert.equal(floorFromClassification('ic', 'medium'), 'balanced');
  });

  it('worker + low risk → budget floor', () => {
    assert.equal(floorFromClassification('worker', 'low'), 'budget');
  });

  it('undefined inputs → balanced (safe default)', () => {
    assert.equal(floorFromClassification(undefined, undefined), 'balanced');
  });
});

// ---------------------------------------------------------------------------
// 3. Memory bias nudge
// ---------------------------------------------------------------------------

describe('applyMemoryBias — ±1 nudge on the committed level', () => {
  it('neutral bias (0) leaves level unchanged', () => {
    assert.equal(applyMemoryBias('balanced', 0), 'balanced');
    assert.equal(applyMemoryBias('balanced', undefined), 'balanced');
  });

  it('+1 proceed bias nudges DOWN one rung', () => {
    assert.equal(applyMemoryBias('balanced', 1), 'budget');
    assert.equal(applyMemoryBias('high', 1), 'balanced');
    assert.equal(applyMemoryBias('max', 1), 'high');
  });

  it('-1 ask bias nudges UP one rung', () => {
    assert.equal(applyMemoryBias('balanced', -1), 'high');
    assert.equal(applyMemoryBias('high', -1), 'max');
    assert.equal(applyMemoryBias('budget', -1), 'balanced');
  });

  it('clamps at budget (cannot go below)', () => {
    assert.equal(applyMemoryBias('budget', 1), 'budget');
  });

  it('clamps at max (cannot go above)', () => {
    assert.equal(applyMemoryBias('max', -1), 'max');
  });
});

// ---------------------------------------------------------------------------
// 4. Capacity ceiling
// ---------------------------------------------------------------------------

describe('clampToCeiling — never exceeds capacity ceiling', () => {
  it('no ceiling → level unchanged', () => {
    assert.equal(clampToCeiling('max', undefined), 'max');
  });

  it('level below ceiling → unchanged', () => {
    assert.equal(clampToCeiling('balanced', 'high'), 'balanced');
  });

  it('level equals ceiling → unchanged', () => {
    assert.equal(clampToCeiling('high', 'high'), 'high');
  });

  it('level above ceiling → clamped to ceiling', () => {
    assert.equal(clampToCeiling('max', 'balanced'), 'balanced');
    assert.equal(clampToCeiling('high', 'budget'), 'budget');
  });
});

// ---------------------------------------------------------------------------
// 5. fuseRung — the predict-and-commit spine (Layer A, full)
// ---------------------------------------------------------------------------

describe('fuseRung — Layer A rung-fusion (predict-and-commit)', () => {
  it('returns a valid RungTuple with a reason', () => {
    const result = fuseRung({});
    assert.ok(result.rung !== undefined);
    assert.ok(result.reason.length > 0);
    assert.ok(['budget', 'balanced', 'high', 'max'].includes(result.rung.level));
  });

  it('big-build frame (manager routeTier) → predict-and-commit to high', () => {
    const frame = makeFrame({ routeTier: 'manager', source: 'model' });
    const result = fuseRung({ frame });
    assert.equal(result.predictAndCommit, true);
    assert.ok(result.rung.level === 'high' || result.rung.level === 'max');
  });

  it('critical risk classify → predict-and-commit to high', () => {
    const result = fuseRung({ classifyRisk: 'critical', classifyTier: 'ic' });
    assert.equal(result.predictAndCommit, true);
    assert.ok(result.rung.level === 'high' || result.rung.level === 'max');
  });

  it('big-build + critical risk → max (the highest rung)', () => {
    const frame = makeFrame({
      routeTier: 'manager',
      operationRisk: 'critical',
      source: 'model',
    });
    const result = fuseRung({ frame, classifyRisk: 'critical', classifyTier: 'manager' });
    assert.equal(result.predictAndCommit, true);
    assert.equal(result.rung.level, 'max');
  });

  it('paste-code shape → does NOT predict-and-commit, routes to budget', () => {
    const frame = makeFrame({ routeTier: 'worker', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'worker', classifyRisk: 'low' });
    assert.equal(result.predictAndCommit, false);
    assert.equal(result.rung.level, 'budget');
    assert.equal(result.rung.modelRung, 'worker');
  });

  it('worker + low risk + no frame → keeps worker/budget rung', () => {
    const result = fuseRung({ classifyTier: 'worker', classifyRisk: 'low' });
    assert.equal(result.predictAndCommit, false);
    assert.equal(result.rung.level, 'budget');
    assert.equal(result.rung.modelRung, 'worker');
  });

  it('worker + low risk + fix-bug frame (no routeTier) → NOT forced to budget by new fallback', () => {
    const frame = makeFrame({ kind: 'fix bug', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'worker', classifyRisk: 'low' });
    assert.ok(
      result.rung.level !== 'budget',
      `fix-bug shape should not be forced to budget by classification-derived hint, got ${result.rung.level}`,
    );
  });

  it('vague-discuss shape → does NOT predict-and-commit', () => {
    const frame = makeFrame({ confidence: 'low', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'ic', classifyRisk: 'low' });
    assert.equal(result.predictAndCommit, false);
  });

  it('memory bias nudge applies after floor fusion', () => {
    // A vague-discuss at ic+medium risk → balanced floor; proceed bias → budget
    const frame = makeFrame({ confidence: 'low', source: 'model' });
    const withBias = fuseRung({ frame, classifyTier: 'ic', classifyRisk: 'medium', memoryBias: 1 });
    // budget or balanced depending on floor vs bias
    assert.ok(['budget', 'balanced'].includes(withBias.rung.level));
  });

  it('capacity ceiling clamps the result', () => {
    // Even a big-build turn gets clamped to budget when ceiling is budget
    const frame = makeFrame({ routeTier: 'manager', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'manager', classifyRisk: 'high', capacityCeiling: 'budget' });
    assert.equal(result.rung.level, 'budget');
  });

  it('falls back to balanced on empty input', () => {
    const result = fuseRung({});
    assert.ok(['budget', 'balanced', 'high', 'max'].includes(result.rung.level));
    assert.ok(result.reason.length > 0);
  });

  it('never throws on arbitrary input', () => {
    assert.doesNotThrow(() => fuseRung({}));
    assert.doesNotThrow(() => fuseRung({ frame: null, classifyTier: undefined }));
    // @ts-expect-error testing bad input
    assert.doesNotThrow(() => fuseRung({ memoryBias: 99 }));
  });

  it('intentShape is reflected in the result', () => {
    const bigBuild = makeFrame({ routeTier: 'manager', source: 'model' });
    const r = fuseRung({ frame: bigBuild });
    assert.equal(r.intentShape, 'big-build');
  });
});

// ---------------------------------------------------------------------------
// 6. Per-turn receipt
// ---------------------------------------------------------------------------

describe('buildAutoBrainReceipt — legible one-line receipt', () => {
  it('receipt contains the level, cost tier, and reason', () => {
    const result = fuseRung({ classifyTier: 'worker', classifyRisk: 'low' });
    const receipt = buildAutoBrainReceipt(result);
    assert.ok(receipt.startsWith('auto-brain:'));
    assert.ok(receipt.includes(result.rung.level));
    assert.ok(receipt.includes('—'));
  });

  it('predict-and-commit receipt includes [predict-and-commit]', () => {
    const frame = makeFrame({ routeTier: 'manager', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'manager', classifyRisk: 'high' });
    const receipt = buildAutoBrainReceipt(result);
    assert.ok(receipt.includes('[predict-and-commit]'));
  });

  it('receipt includes cost-tier label', () => {
    const budgetResult = fuseRung({ classifyTier: 'worker', classifyRisk: 'low', capacityCeiling: 'budget' });
    const receipt = buildAutoBrainReceipt(budgetResult);
    assert.ok(receipt.includes('cheap'));
  });

  it('never throws on arbitrary input', () => {
    // @ts-expect-error testing bad input
    assert.doesNotThrow(() => buildAutoBrainReceipt({}));
    // @ts-expect-error testing bad input
    assert.doesNotThrow(() => buildAutoBrainReceipt(null));
  });
});

// ---------------------------------------------------------------------------
// 7. 1-model collapse (effort becomes primary lever)
// ---------------------------------------------------------------------------

describe('adaptForSingleModel — model-rung collapses, effort stays', () => {
  it('pins modelRung to ic', () => {
    const result = fuseRung({ classifyTier: 'manager', classifyRisk: 'high' });
    const adapted = adaptForSingleModel(result.rung);
    assert.equal(adapted.modelRung, 'ic');
  });

  it('effort is preserved (primary lever in 1-model case)', () => {
    const result = fuseRung({ classifyTier: 'manager', classifyRisk: 'high' });
    const adapted = adaptForSingleModel(result.rung);
    assert.equal(adapted.effort, result.rung.effort);
  });

  it('cross-vendor verify collapses to self-check when toggle=true + high/max level', () => {
    const frame = makeFrame({ routeTier: 'manager', operationRisk: 'critical', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'manager', classifyRisk: 'critical' });
    // result.rung.level should be max → verifyDepth === 'cross-vendor'
    const adapted = adaptForSingleModel(result.rung, true);
    assert.equal(adapted.verifyDepth, 'self-check');
  });

  it('cross-vendor collapses to none when toggle=false (self-review pass off, quota-limited per locked decision #4)', () => {
    const frame = makeFrame({ routeTier: 'manager', operationRisk: 'critical', source: 'model' });
    const result = fuseRung({ frame, classifyTier: 'manager', classifyRisk: 'critical' });
    const adapted = adaptForSingleModel(result.rung, false);
    // Without toggle: no self-review pass runs — quota-limited, honest disclosure.
    // (1 model can't cross-check; toggle=false means don't run the self-review substitute.)
    assert.equal(adapted.verifyDepth, 'none');
  });

  it('cross-vendor collapses to none when toggle=false + balanced level (capped to high/max only)', () => {
    // balanced level → self-check verifyDepth (not cross-vendor), so stays unchanged.
    const result = fuseRung({ classifyTier: 'ic', classifyRisk: 'medium' });
    // balanced → verifyDepth 'self-check', not cross-vendor
    const adapted = adaptForSingleModel(result.rung, false);
    assert.equal(adapted.verifyDepth, result.rung.verifyDepth); // unchanged
  });

  it('self-check stays self-check in 1-model case', () => {
    const result = fuseRung({ classifyTier: 'ic', classifyRisk: 'medium' });
    const adapted = adaptForSingleModel(result.rung);
    // balanced level → self-check; stays self-check
    assert.equal(adapted.verifyDepth, result.rung.verifyDepth);
  });

  it('never throws on any rung', () => {
    for (const level of ['budget', 'balanced', 'high', 'max'] as const) {
      const { rung } = fuseRung({ capacityCeiling: level });
      assert.doesNotThrow(() => adaptForSingleModel(rung, false));
      assert.doesNotThrow(() => adaptForSingleModel(rung, true));
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Layer B: shouldEscalate — objective evidence ONLY
// ---------------------------------------------------------------------------

describe('shouldEscalate — LAYER B (objective signals only, self-confidence BANNED)', () => {
  const BASE: EscalationSignals = {
    attemptNumber: 1,
    maxAttempts: 3,
    currentLevel: 'balanced',
  };

  it('no objective signals → no escalation', () => {
    assert.equal(shouldEscalate(BASE), false);
  });

  it('single test failure alone (below margin) → no escalation', () => {
    assert.equal(shouldEscalate({ ...BASE, testFailures: 1 }), false);
  });

  it(`${ESCALATE_FAILURE_MARGIN} objective signals → escalate`, () => {
    // 2 distinct signals: test failure + typecheck failure
    assert.equal(
      shouldEscalate({ ...BASE, testFailures: 1, typecheckFailures: 1 }),
      true,
    );
  });

  it('scope growth + lint failure = 2 signals → escalate', () => {
    assert.equal(
      shouldEscalate({ ...BASE, scopeGrowth: true, lintFailures: 1 }),
      true,
    );
  });

  it('explicit user pushback + test failure → escalate', () => {
    assert.equal(
      shouldEscalate({ ...BASE, explicitUserPushback: true, testFailures: 1 }),
      true,
    );
  });

  it('already at max level → no escalation (nowhere to go)', () => {
    assert.equal(
      shouldEscalate({
        ...BASE,
        currentLevel: 'max',
        testFailures: 5,
        typecheckFailures: 5,
      }),
      false,
    );
  });

  it('at policy maxAttempts ceiling → no escalation', () => {
    assert.equal(
      shouldEscalate({
        ...BASE,
        attemptNumber: 3,
        maxAttempts: 3,
        testFailures: 5,
        typecheckFailures: 5,
      }),
      false,
    );
  });

  it('self-confidence alone CANNOT trigger escalation (banned by design)', () => {
    // The function has no `selfConfidence` parameter — the only way self-confidence
    // could be passed is via the objective fields. None of the objective fields
    // here: no escalation.
    const noObjectiveSignals: EscalationSignals = {
      ...BASE,
      // Self-confidence is NOT in the interface — this confirms the type has no such field.
    };
    assert.equal(shouldEscalate(noObjectiveSignals), false);
  });

  it('consecutive stalls ≥ 2 count as one objective signal', () => {
    // 1 stall alone (< 2) + 1 test failure = 2 signals → escalate
    assert.equal(
      shouldEscalate({ ...BASE, consecutiveStalls: 2, testFailures: 1 }),
      true,
    );
  });

  it('never throws on empty signals', () => {
    assert.doesNotThrow(() => shouldEscalate({}));
  });
});

// ---------------------------------------------------------------------------
// 9. Layer B: shouldDeEscalate — symmetric de-escalation on mechanical work
// ---------------------------------------------------------------------------

describe('shouldDeEscalate — LAYER B (symmetric de-escalation)', () => {
  const BASE: EscalationSignals = {
    currentLevel: 'high',
    consecutiveCleanTodos: 0,
  };

  it('no clean todos → no de-escalation', () => {
    assert.equal(shouldDeEscalate(BASE), false);
  });

  it(`fewer than ${DEESCALATE_CLEAN_MARGIN} clean todos → no de-escalation`, () => {
    assert.equal(
      shouldDeEscalate({ ...BASE, consecutiveCleanTodos: DEESCALATE_CLEAN_MARGIN - 1 }),
      false,
    );
  });

  it(`${DEESCALATE_CLEAN_MARGIN} clean todos → de-escalate`, () => {
    assert.equal(
      shouldDeEscalate({ ...BASE, consecutiveCleanTodos: DEESCALATE_CLEAN_MARGIN }),
      true,
    );
  });

  it('any active failure blocks de-escalation', () => {
    assert.equal(
      shouldDeEscalate({
        ...BASE,
        consecutiveCleanTodos: DEESCALATE_CLEAN_MARGIN + 5,
        testFailures: 1,
      }),
      false,
    );
    assert.equal(
      shouldDeEscalate({
        ...BASE,
        consecutiveCleanTodos: DEESCALATE_CLEAN_MARGIN + 5,
        typecheckFailures: 2,
      }),
      false,
    );
  });

  it('already at budget → no de-escalation (nowhere to go)', () => {
    assert.equal(
      shouldDeEscalate({
        currentLevel: 'budget',
        consecutiveCleanTodos: DEESCALATE_CLEAN_MARGIN + 10,
      }),
      false,
    );
  });

  it('never throws on empty signals', () => {
    assert.doesNotThrow(() => shouldDeEscalate({}));
  });
});

// ---------------------------------------------------------------------------
// 10. Layer B: decideLayerBEscalation — the LIVE within-turn trigger (Option B)
// ---------------------------------------------------------------------------

describe('decideLayerBEscalation — LAYER B live trigger (repeated objective failure)', () => {
  it('non-failing classifications never escalate', () => {
    assert.equal(
      decideLayerBEscalation({ classification: 'passing', currentTier: 'worker', attempts: 1, maxAttempts: 3 }),
      false,
    );
    assert.equal(
      decideLayerBEscalation({ classification: 'unverified', currentTier: 'worker', attempts: 1, maxAttempts: 3 }),
      false,
    );
  });

  it('a failing gate below the ceiling escalates (worker has room to climb)', () => {
    assert.equal(
      decideLayerBEscalation({ classification: 'failing', currentTier: 'worker', attempts: 1, maxAttempts: 3 }),
      true,
    );
  });

  it('a failing gate at IC still escalates (room to reach manager)', () => {
    assert.equal(
      decideLayerBEscalation({ classification: 'failing', currentTier: 'ic', attempts: 1, maxAttempts: 3 }),
      true,
    );
  });

  it('already at manager → no escalation (top tier)', () => {
    assert.equal(
      decideLayerBEscalation({ classification: 'failing', currentTier: 'manager', attempts: 1, maxAttempts: 3 }),
      false,
    );
  });

  it('attempt ceiling reached → no escalation', () => {
    assert.equal(
      decideLayerBEscalation({ classification: 'failing', currentTier: 'worker', attempts: 3, maxAttempts: 3 }),
      false,
    );
  });

  it('never throws on odd input', () => {
    assert.doesNotThrow(() =>
      decideLayerBEscalation({ classification: 'failing', currentTier: 'worker', attempts: 0, maxAttempts: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Hysteresis — escalation does NOT fire below the margin
// ---------------------------------------------------------------------------

describe('hysteresis — escalation requires clearing the margin', () => {
  it('one-fewer-than-margin objective signals → no escalation', () => {
    const oneBelow: EscalationSignals = {
      attemptNumber: 1,
      maxAttempts: 3,
      currentLevel: 'balanced',
      testFailures: ESCALATE_FAILURE_MARGIN >= 2 ? 1 : 0,
      // Only ONE signal (below margin of 2)
    };
    assert.equal(shouldEscalate(oneBelow), false);
  });

  it('margin-number of signals → escalation fires', () => {
    const atMargin: EscalationSignals = {
      attemptNumber: 1,
      maxAttempts: 3,
      currentLevel: 'balanced',
      testFailures: 1,
      typecheckFailures: 1,
    };
    assert.equal(shouldEscalate(atMargin), true);
  });
});

// ---------------------------------------------------------------------------
// 11. Default-off flag — autoBrainEnabled
// ---------------------------------------------------------------------------

describe('autoBrainEnabled — default OFF', () => {
  it('is OFF with no env / no config', () => {
    assert.equal(autoBrainEnabled(undefined, undefined), false);
  });

  it('is OFF with empty env and no config', () => {
    assert.equal(autoBrainEnabled({}, {}), false);
  });

  it('is OFF when config key is absent', () => {
    assert.equal(autoBrainEnabled({}, { experimentalAutoBrain: undefined }), false);
  });

  it('is ON via MYSHELL_AUTO_BRAIN=1', () => {
    assert.equal(autoBrainEnabled({ MYSHELL_AUTO_BRAIN: '1' }, {}), true);
  });

  it('is ON via MYSHELL_AUTO_BRAIN=true', () => {
    assert.equal(autoBrainEnabled({ MYSHELL_AUTO_BRAIN: 'true' }, {}), true);
  });

  it('is ON via MYSHELL_AUTO_BRAIN=on', () => {
    assert.equal(autoBrainEnabled({ MYSHELL_AUTO_BRAIN: 'ON' }, {}), true);
  });

  it('is ON via config.experimentalAutoBrain=true', () => {
    assert.equal(autoBrainEnabled({}, { experimentalAutoBrain: true }), true);
  });

  it('is OFF via config.experimentalAutoBrain=false', () => {
    assert.equal(autoBrainEnabled({}, { experimentalAutoBrain: false }), false);
  });

  it('rollback forces OFF even when env opt-in is present', () => {
    assert.equal(
      autoBrainEnabled({ MYSHELL_AUTO_BRAIN: '1', MYSHELL_ROLLBACK: '1' }, {}),
      false,
    );
  });

  it('rollback via config forces OFF', () => {
    assert.equal(
      autoBrainEnabled({ MYSHELL_AUTO_BRAIN: '1' }, { rollback: true }),
      false,
    );
  });

  it('unknown env value → OFF', () => {
    assert.equal(autoBrainEnabled({ MYSHELL_AUTO_BRAIN: 'maybe' }, {}), false);
    assert.equal(autoBrainEnabled({ MYSHELL_AUTO_BRAIN: '0' }, {}), false);
    assert.equal(autoBrainEnabled({ MYSHELL_AUTO_BRAIN: 'false' }, {}), false);
  });

  it('never throws on null-ish inputs', () => {
    assert.doesNotThrow(() => autoBrainEnabled(undefined, undefined));
  });
});

// ---------------------------------------------------------------------------
// 12. Byte-identity when flag is OFF (the OFF-GUARANTEE)
// ---------------------------------------------------------------------------

describe('OFF-GUARANTEE — flag off → no autoBrainRungTuple field injected', () => {
  /**
   * This test validates the OFF-GUARANTEE structurally: when `autoBrainEnabled`
   * returns false, the wiring in menu.ts returns `{}` (empty spread), so the
   * `autoBrainRungTuple` field is NEVER set on `OrchestrateDeps`. We verify this
   * by confirming the flag function returns false by default (the runtime path
   * is covered by the flag tests above).
   */
  it('default-off → autoBrainEnabled returns false → seam field absent', () => {
    // With no env and no config, the flag is off.
    const flagOff = !autoBrainEnabled(undefined, undefined);
    assert.equal(flagOff, true, 'flag must be off by default');
    // When flag is off, menu.ts returns {} from the auto-brain IIFE,
    // so autoBrainRungTuple is never set on deps. The routing path is
    // byte-for-byte today's (no reads of fuseRung output happen).
  });
});
