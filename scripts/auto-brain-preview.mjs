#!/usr/bin/env node
/**
 * scripts/auto-brain-preview.mjs — QUOTA-FREE routing preview for the Auto Brain.
 *
 * Shows the fused rung + receipt for representative IntentFrames WITHOUT
 * executing any turn, WITHOUT making any model calls, and WITHOUT needing
 * live provider auth.
 *
 * Usage:
 *   node --import tsx/esm scripts/auto-brain-preview.mjs
 *   node --import tsx/esm scripts/auto-brain-preview.mjs pasted-code
 *   node --import tsx/esm scripts/auto-brain-preview.mjs find-and-fix-bug
 *   node --import tsx/esm scripts/auto-brain-preview.mjs all
 *
 * The two built-in scenarios match the integration tests in
 * test/unit/auto-brain-routing.test.ts. No npm run needed — just node.
 *
 * Adding a scenario: push a new entry into `SCENARIOS` below.
 */

// @ts-check
import { classify } from '../src/core/classify.ts';
import { fuseRung, buildAutoBrainReceipt } from '../src/core/auto-brain.ts';

// ---------------------------------------------------------------------------
// Representative IntentFrames (as the byproduct model would emit)
// ---------------------------------------------------------------------------

/**
 * SCENARIO 1 — "pasted-code"
 * User pasted a code blob and asked to explain/review it.
 * Expected: cheap/budget rung (worker-tier, low risk, no mutations).
 *
 * @type {import('../src/core/intent.ts').IntentFrame}
 */
const PASTED_CODE_FRAME = {
  version: 1,
  goal: 'explain the fibonacci function',
  kind: 'explain code',
  routeTier: 'worker',
  confidence: 'high',
  source: 'model',
};

/**
 * SCENARIO 2 — "find-and-fix-bug"
 * User wants to find and fix a bug in auth token validation.
 * Expected: balanced or higher rung (ic-tier, medium risk, targeted repair).
 *
 * @type {import('../src/core/intent.ts').IntentFrame}
 */
const FIX_BUG_FRAME = {
  version: 1,
  goal: 'fix auth token validation bug causing 401s',
  kind: 'fix bug in auth token validation',
  routeTier: 'ic',
  confidence: 'high',
  operationRisk: 'medium',
  blastRadius: 'medium',
  source: 'model',
};

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: 'pasted-code',
    label: 'Pasted code (explain/review intent)',
    task: 'explain this function: function fib(n) { return n <= 1 ? n : fib(n-1)+fib(n-2); }',
    frame: PASTED_CODE_FRAME,
    expectedNote: 'Expected: budget or balanced (cheap — worker-tier explain)',
  },
  {
    id: 'find-and-fix-bug',
    label: 'Find-and-fix-bug (targeted repair, medium risk)',
    task: 'find and fix the bug in the auth token validation — users are getting 401s even with valid tokens',
    frame: FIX_BUG_FRAME,
    expectedNote: 'Expected: balanced or higher (moderate+ — ic-tier repair with auth risk)',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single scenario: classify the task, fuse the rung, print the receipt.
 * @param {{ id: string; label: string; task: string; frame: object; expectedNote: string }} scenario
 */
function runScenario(scenario) {
  const cl = classify(scenario.task);
  const result = fuseRung({
    frame: scenario.frame,
    classifyTier: cl.tier,
    classifyRisk: cl.risk,
  });
  const receipt = buildAutoBrainReceipt(result);

  console.log('');
  console.log(`┌── Scenario: ${scenario.label} ──`);
  console.log(`│  Task:            ${scenario.task.slice(0, 72)}${scenario.task.length > 72 ? '…' : ''}`);
  console.log(`│  Byproduct frame: routeTier=${scenario.frame.routeTier ?? 'none'} kind="${scenario.frame.kind ?? ''}" opRisk=${scenario.frame.operationRisk ?? 'none'}`);
  console.log(`│  classify():      tier=${cl.tier} risk=${cl.risk}`);
  console.log(`│  ► ${receipt}`);
  console.log(`│  Rung details:    modelRung=${result.rung.modelRung} effort=${result.rung.effort} verifyDepth=${result.rung.verifyDepth}`);
  console.log(`│  predictAndCommit=${result.predictAndCommit}  intentShape=${result.intentShape}`);
  console.log(`│  ${scenario.expectedNote}`);
  console.log(`└──`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const arg = process.argv[2] ?? 'all';

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('  AUTO BRAIN — Layer A Routing Preview (quota-free, no auth)');
console.log('  Pure classify() + fuseRung() — ZERO model calls');
console.log('═══════════════════════════════════════════════════════════════════');

const scenariosToRun =
  arg === 'all'
    ? SCENARIOS
    : SCENARIOS.filter((s) => s.id === arg);

if (scenariosToRun.length === 0) {
  console.error(`\nUnknown scenario "${arg}". Available: all, ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

for (const scenario of scenariosToRun) {
  runScenario(scenario);
}

console.log('');
console.log('Done. No model calls made. No auth needed.');
console.log('');
