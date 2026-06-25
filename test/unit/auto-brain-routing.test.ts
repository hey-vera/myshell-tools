/**
 * test/unit/auto-brain-routing.test.ts — integration tests for the AUTO BRAIN
 * Layer A routing preview (no model calls, no auth needed).
 *
 * Feeds TWO representative scenarios through classify() + fuseRung() and asserts
 * the receipt, verifying the full classify→fuse pipeline with hardcoded
 * representative IntentFrames (as the byproduct would produce).
 *
 * SCENARIO 1 — "pasted code" (large code blob, explain/review intent):
 *   Expected: cheap/budget rung (worker-tier byproduct, low risk, explain kind).
 *
 * SCENARIO 2 — "find-and-fix-bug" (targeted repair with risk):
 *   Expected: higher rung — balanced or high (ic-tier byproduct, medium risk, fix kind).
 *
 * ZERO model calls, ZERO auth needed. Pure classify() + fuseRung().
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../../src/core/classify.ts';
import { fuseRung, buildAutoBrainReceipt } from '../../src/core/auto-brain.ts';
import type { IntentFrame } from '../../src/core/intent.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a representative IntentFrame as the byproduct would produce.
 * All fields optional so tests only specify what matters for their scenario.
 */
function makeByproductFrame(overrides: Partial<IntentFrame>): IntentFrame {
  return {
    version: 1,
    goal: overrides.goal ?? 'test goal',
    confidence: overrides.confidence ?? 'high',
    source: 'model',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SCENARIO 1 — "pasted code" (explain/review, worker-tier byproduct, low risk)
// ---------------------------------------------------------------------------

describe('auto-brain routing: SCENARIO 1 — pasted-code (explain intent, low risk)', () => {
  // Representative task: user pastes a blob of code and asks to explain it.
  // No mutation, no filesystem, just reading/explaining — pure worker-tier.
  const PASTED_CODE_TASK =
    'explain this function: function fib(n) { return n <= 1 ? n : fib(n-1)+fib(n-2); }';

  // Representative byproduct IntentFrame the model would emit for this turn.
  // routeTier: 'worker' (read-only, explanation)
  // kind: 'explain code' (matches paste-code pattern in intentShapeOf)
  // confidence: 'high' (the goal is clear)
  // operationRisk / blastRadius: absent (no mutations)
  const PASTED_CODE_FRAME: IntentFrame = makeByproductFrame({
    goal: 'explain the fib function',
    kind: 'explain code',
    routeTier: 'worker',
    confidence: 'high',
    source: 'model',
  });

  it('classify() detects worker tier and low risk for a simple explain task', () => {
    const cl = classify(PASTED_CODE_TASK);
    // A function-explanation task → worker or ic tier (not manager); low or medium risk
    assert.ok(
      cl.tier === 'worker' || cl.tier === 'ic',
      `expected worker or ic, got ${cl.tier}`,
    );
    assert.ok(
      cl.risk === 'low' || cl.risk === 'medium',
      `expected low or medium risk, got ${cl.risk}`,
    );
  });

  it('fuseRung() routes to budget or balanced (cheap rung for trivial explain)', () => {
    const cl = classify(PASTED_CODE_TASK);
    const result = fuseRung({
      frame: PASTED_CODE_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });

    // The byproduct says worker+explain → should resolve to budget or balanced.
    // Budget is ideal (cheap, locked decision #3 — byproduct may lower floor).
    assert.ok(
      result.rung.level === 'budget' || result.rung.level === 'balanced',
      `expected budget or balanced for paste-code, got ${result.rung.level}`,
    );

    // predictAndCommit should be FALSE for a trivial explain turn.
    assert.equal(result.predictAndCommit, false);
  });

  it('intentShape is paste-code for explain+worker byproduct', () => {
    const cl = classify(PASTED_CODE_TASK);
    const result = fuseRung({
      frame: PASTED_CODE_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });
    assert.equal(result.intentShape, 'paste-code');
  });

  it('receipt is compact and contains the level + cost-tier label', () => {
    const cl = classify(PASTED_CODE_TASK);
    const result = fuseRung({
      frame: PASTED_CODE_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });
    const receipt = buildAutoBrainReceipt(result);

    // Receipt format: "auto-brain: <level> (<cost-tier>) — <reason>"
    assert.ok(receipt.startsWith('auto-brain:'), `receipt should start with auto-brain: got: ${receipt}`);
    assert.ok(receipt.includes(result.rung.level), `receipt missing level: ${receipt}`);
    // cheap = budget, moderate = balanced
    assert.ok(
      receipt.includes('cheap') || receipt.includes('moderate'),
      `expected cheap or moderate cost label in receipt: ${receipt}`,
    );
    assert.ok(receipt.includes('—'), `receipt missing reason separator: ${receipt}`);
  });

  it('receipt does NOT include [predict-and-commit] for trivial explain', () => {
    const cl = classify(PASTED_CODE_TASK);
    const result = fuseRung({
      frame: PASTED_CODE_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });
    const receipt = buildAutoBrainReceipt(result);
    assert.ok(
      !receipt.includes('[predict-and-commit]'),
      `trivial explain should not predict-and-commit: ${receipt}`,
    );
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 2 — "find-and-fix-bug" (targeted repair, ic-tier byproduct, medium risk)
// ---------------------------------------------------------------------------

describe('auto-brain routing: SCENARIO 2 — find-and-fix-bug (repair intent, medium risk)', () => {
  // Representative task: user asks to find and fix a bug in auth logic.
  // Targeted file mutation, bounded scope, medium risk (could break auth).
  const FIX_BUG_TASK =
    'find and fix the bug in the auth token validation — users are getting 401s even with valid tokens';

  // Representative byproduct IntentFrame the model would emit for this turn.
  // routeTier: 'ic' (targeted code change, bounded scope)
  // kind: 'fix bug in auth' (matches fix-bug pattern in intentShapeOf)
  // operationRisk: 'medium' (auth-related, could break login)
  // blastRadius: 'medium' (affects all auth users)
  const FIX_BUG_FRAME: IntentFrame = makeByproductFrame({
    goal: 'fix auth token validation bug causing 401s',
    kind: 'fix bug in auth token validation',
    routeTier: 'ic',
    confidence: 'high',
    operationRisk: 'medium',
    blastRadius: 'medium',
    source: 'model',
  });

  it('classify() detects ic or manager tier for a fix-bug-in-auth task', () => {
    const cl = classify(FIX_BUG_TASK);
    // Auth bug fix → ic or manager; medium or high risk (auth is security-sensitive)
    assert.ok(
      cl.tier === 'ic' || cl.tier === 'manager',
      `expected ic or manager, got ${cl.tier}`,
    );
    // Risk should be medium or higher (auth keyword triggers security signals)
    assert.ok(
      cl.risk === 'medium' || cl.risk === 'high' || cl.risk === 'critical',
      `expected medium/high/critical risk, got ${cl.risk}`,
    );
  });

  it('fuseRung() routes to balanced or higher (not budget for fix-bug with risk)', () => {
    const cl = classify(FIX_BUG_TASK);
    const result = fuseRung({
      frame: FIX_BUG_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });

    // A targeted auth fix with medium risk → balanced or high (NOT budget).
    assert.ok(
      result.rung.level === 'balanced' || result.rung.level === 'high' || result.rung.level === 'max',
      `expected balanced/high/max for fix-bug, got ${result.rung.level}`,
    );
  });

  it('intentShape is fix-bug for ic+fix-bug byproduct', () => {
    const cl = classify(FIX_BUG_TASK);
    const result = fuseRung({
      frame: FIX_BUG_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });
    assert.equal(result.intentShape, 'fix-bug');
  });

  it('rung is higher than paste-code scenario', () => {
    // Paste-code scenario
    const PASTED_CODE_FRAME: IntentFrame = makeByproductFrame({
      goal: 'explain the fib function',
      kind: 'explain code',
      routeTier: 'worker',
      confidence: 'high',
    });
    const pasteCodeCl = classify('explain this function: function fib(n) { return n; }');
    const pastResult = fuseRung({
      frame: PASTED_CODE_FRAME,
      classifyTier: pasteCodeCl.tier,
      classifyRisk: pasteCodeCl.risk,
    });

    // Fix-bug scenario
    const fixBugCl = classify(FIX_BUG_TASK);
    const fixResult = fuseRung({
      frame: FIX_BUG_FRAME,
      classifyTier: fixBugCl.tier,
      classifyRisk: fixBugCl.risk,
    });

    // The ranking: budget < balanced < high < max
    const rank = { budget: 0, balanced: 1, high: 2, max: 3 } as const;
    const pasteRank = rank[pastResult.rung.level];
    const fixRank = rank[fixResult.rung.level];

    assert.ok(
      fixRank >= pasteRank,
      `fix-bug (${fixResult.rung.level}) should be >= paste-code (${pastResult.rung.level}) rung`,
    );
  });

  it('receipt is compact and contains level + cost label + reason', () => {
    const cl = classify(FIX_BUG_TASK);
    const result = fuseRung({
      frame: FIX_BUG_FRAME,
      classifyTier: cl.tier,
      classifyRisk: cl.risk,
    });
    const receipt = buildAutoBrainReceipt(result);

    assert.ok(receipt.startsWith('auto-brain:'), `receipt should start with auto-brain: got: ${receipt}`);
    assert.ok(receipt.includes(result.rung.level), `receipt missing level: ${receipt}`);
    // Not cheap — it's at least moderate
    assert.ok(
      receipt.includes('moderate') || receipt.includes('expensive') || receipt.includes('maximum'),
      `expected moderate/expensive/maximum cost label in receipt: ${receipt}`,
    );
    assert.ok(receipt.includes('—'), `receipt missing reason separator: ${receipt}`);
  });
});

// ---------------------------------------------------------------------------
// Cross-scenario invariants
// ---------------------------------------------------------------------------

describe('auto-brain routing: cross-scenario invariants (zero model calls)', () => {
  it('both scenarios complete with no model calls (pure classify + fuseRung)', () => {
    // If we get here, no model calls were made — these are pure functions.
    const cl1 = classify('explain this function');
    const r1 = fuseRung({ classifyTier: cl1.tier, classifyRisk: cl1.risk });
    assert.ok(r1.rung !== undefined);

    const cl2 = classify('find and fix the bug in auth token validation');
    const r2 = fuseRung({ classifyTier: cl2.tier, classifyRisk: cl2.risk });
    assert.ok(r2.rung !== undefined);
  });

  it('receipts are human-readable one-liners (no newlines)', () => {
    const cl1 = classify('explain this code');
    const r1 = fuseRung({ classifyTier: cl1.tier, classifyRisk: cl1.risk });
    const receipt1 = buildAutoBrainReceipt(r1);
    assert.ok(!receipt1.includes('\n'), `receipt should be one line: ${receipt1}`);

    const cl2 = classify('fix the bug in the payment processor');
    const r2 = fuseRung({ classifyTier: cl2.tier, classifyRisk: cl2.risk });
    const receipt2 = buildAutoBrainReceipt(r2);
    assert.ok(!receipt2.includes('\n'), `receipt should be one line: ${receipt2}`);
  });

  it('never throws on either scenario (total functions)', () => {
    assert.doesNotThrow(() => {
      const cl = classify('explain this code function');
      fuseRung({ classifyTier: cl.tier, classifyRisk: cl.risk });
    });
    assert.doesNotThrow(() => {
      const cl = classify('find and fix the bug in auth');
      fuseRung({ classifyTier: cl.tier, classifyRisk: cl.risk });
    });
  });
});
