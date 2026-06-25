#!/usr/bin/env node
/**
 * scripts/draft-goals-preview.mjs — QUOTA-FREE draft-goal skeleton preview for
 * Phase 1 of the one-chat redesign ("chat → draft goal").
 *
 * Shows the result of feeding representative IntentFrames through the pure
 * draft-goal derivation WITHOUT executing any turn, WITHOUT making any model
 * calls, and WITHOUT needing live provider auth.
 *
 * Usage:
 *   node --import tsx/esm scripts/draft-goals-preview.mjs
 *   node --import tsx/esm scripts/draft-goals-preview.mjs build-request
 *   node --import tsx/esm scripts/draft-goals-preview.mjs dark-mode
 *   node --import tsx/esm scripts/draft-goals-preview.mjs question
 *   node --import tsx/esm scripts/draft-goals-preview.mjs all
 *
 * The scenarios directly mirror the integration tests in
 * test/unit/draft-goal.test.ts. No npm run needed — just node.
 *
 * Adding a scenario: push a new entry into SCENARIOS below.
 */

// @ts-check
import { isBuildIntent, deriveDraftGoalSkeleton } from '../src/core/draft-goal.ts';

// ---------------------------------------------------------------------------
// Representative IntentFrames (as the byproduct model would emit)
// ---------------------------------------------------------------------------

/**
 * SCENARIO 1 — "build-request"
 * "Make an app with 20 pages" — large coding task, manager-tier.
 * Expected: BUILD INTENT → draft goal skeleton produced.
 *
 * @type {import('../src/core/intent.ts').IntentFrame}
 */
const BUILD_REQUEST_FRAME = {
  version: 1,
  goal: 'Build a web app with 20 pages',
  kind: 'coding',
  routeTier: 'manager',
  confidence: 'high',
  source: 'model',
  doneWhen: 'All 20 pages are implemented and the app builds cleanly',
  forks: [
    {
      id: 'F1',
      question: 'Which framework?',
      options: [
        'Next.js — SSR, file-based routing, strong ecosystem',
        'Vite SPA — simpler, client-only, faster dev server',
      ],
      assumeIfUnasked: 'Next.js — SSR, file-based routing, strong ecosystem',
    },
  ],
};

/**
 * SCENARIO 2 — "dark-mode"
 * "Add dark mode to the settings screen" — targeted feature, ic-tier,
 * model already pre-emitted a draft skeleton in the byproduct.
 * Expected: BUILD INTENT → pre-emitted skeleton is capped and used.
 *
 * @type {import('../src/core/intent.ts').IntentFrame}
 */
const DARK_MODE_FRAME = {
  version: 1,
  goal: 'Add dark mode to the settings screen',
  kind: 'coding',
  routeTier: 'ic',
  confidence: 'high',
  source: 'model',
  doneWhen: 'The settings screen has a working dark/light toggle',
  draftGoalSkeleton: {
    title: 'Add dark mode to settings screen',
    outline: [
      { text: 'Add a theme toggle component to the settings UI' },
      { text: 'Implement CSS variable / Tailwind dark mode class switching' },
      { text: 'Persist the preference in localStorage and apply on load' },
    ],
  },
};

/**
 * SCENARIO 3 — "question"
 * "How does the routing work?" — pure question / research turn.
 * Expected: NOT a build intent → NO goal is drafted (no over-triggering).
 *
 * @type {import('../src/core/intent.ts').IntentFrame}
 */
const QUESTION_FRAME = {
  version: 1,
  goal: 'Understand how the routing works in this codebase',
  kind: 'research',
  routeTier: 'worker',
  confidence: 'high',
  source: 'model',
};

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: 'build-request',
    label: 'Build request — "Make an app with 20 pages"',
    frame: BUILD_REQUEST_FRAME,
    expectedNote: 'Expected: BUILD INTENT → draft goal skeleton produced (no model call)',
  },
  {
    id: 'dark-mode',
    label: 'Dark mode feature — model pre-emitted draftGoalSkeleton in byproduct',
    frame: DARK_MODE_FRAME,
    expectedNote: 'Expected: BUILD INTENT → pre-emitted skeleton capped + returned',
  },
  {
    id: 'question',
    label: 'Question/discussion — "How does routing work?"',
    frame: QUESTION_FRAME,
    expectedNote: 'Expected: NOT a build intent → null (NO goal drafted, zero over-triggering)',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a single scenario: check intent, derive skeleton, print result.
 * @param {{ id: string; label: string; frame: object; expectedNote: string }} scenario
 */
function runScenario(scenario) {
  const frame = /** @type {import('../src/core/intent.ts').IntentFrame} */ (scenario.frame);
  const isBuilding = isBuildIntent(frame);
  const skeleton = deriveDraftGoalSkeleton(frame);

  console.log('');
  console.log(`┌── Scenario: ${scenario.label} ──`);
  console.log(`│  Frame kind:      ${frame.kind ?? 'none'}  routeTier=${frame.routeTier ?? 'none'}  source=${frame.source}`);
  console.log(`│  Goal:            ${frame.goal}`);
  console.log(`│  isBuildIntent:   ${isBuilding}`);

  if (skeleton !== null) {
    console.log(`│  Draft skeleton:`);
    console.log(`│    title:   "${skeleton.title}"`);
    console.log(`│    outline: ${skeleton.outline.length} item(s)`);
    for (const item of skeleton.outline) {
      console.log(`│      • ${item.text}`);
    }
    console.log(`│  → Goal would be created INACTIVE (state: parked, source: byproduct-draft)`);
    console.log(`│  → NEVER queued or executed without explicit user confirmation`);
  } else {
    console.log(`│  Draft skeleton:  null — NO goal drafted`);
    if (!isBuilding) {
      console.log(`│  → Non-build turn correctly produces NO goal (zero over-triggering)`);
    }
  }

  console.log(`│  ${scenario.expectedNote}`);
  console.log(`└──`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const arg = process.argv[2] ?? 'all';

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('  DRAFT GOALS — Phase 1 Spine Preview (quota-free, no auth)');
console.log('  Pure isBuildIntent() + deriveDraftGoalSkeleton() — ZERO model calls');
console.log('  flag: MYSHELL_DRAFT_GOALS=1  (default-OFF)');
console.log('═══════════════════════════════════════════════════════════════════');

const scenariosToRun =
  arg === 'all'
    ? SCENARIOS
    : SCENARIOS.filter((s) => s.id === arg);

if (scenariosToRun.length === 0) {
  console.error(
    `\nUnknown scenario "${arg}". Available: all, ${SCENARIOS.map((s) => s.id).join(', ')}`,
  );
  process.exit(1);
}

for (const scenario of scenariosToRun) {
  runScenario(scenario);
}

console.log('');
console.log('Key: skeleton!=null → parked draft goal WOULD be created when flag is ON.');
console.log('     skeleton==null → turn is a question/discussion — NO goal drafted.');
console.log('');
console.log('Done. No model calls made. No auth needed.');
console.log('');
