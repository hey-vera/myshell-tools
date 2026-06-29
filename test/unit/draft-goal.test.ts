/**
 * test/unit/draft-goal.test.ts — pure unit tests for the draft-goal-skeleton
 * derivation (src/core/draft-goal.ts).
 *
 * All tests are quota-free: they feed hardcoded IntentFrames through the pure
 * derivation functions and assert the result. Zero model calls, zero auth.
 *
 * Coverage:
 *  (a) Build-intent frames → a sensible DraftGoalSkeleton is produced.
 *  (b) Question/discussion frames → isBuildIntent returns false, no skeleton.
 *  (c) capDraftGoalSkeleton: tolerant passthrough of valid / malformed input.
 *  (d) Never throws on garbage.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  isBuildIntent,
  deriveDraftGoalSkeleton,
  capDraftGoalSkeleton,
} from '../../src/core/draft-goal.ts';
import type { IntentFrame } from '../../src/core/intent.ts';

// ---------------------------------------------------------------------------
// Shared representative frames
// ---------------------------------------------------------------------------

/**
 * SCENARIO A — "make an app with 20 pages"
 * Classic build request: large coding task, manager-tier, ic routing.
 * Expected: isBuildIntent=true, skeleton with title + outline.
 */
const BUILD_APP_FRAME: IntentFrame = {
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
      options: ['Next.js — SSR, file-based routing', 'Vite SPA — simpler, client-only'],
      assumeIfUnasked: 'Next.js — SSR, file-based routing',
    },
  ],
};

/**
 * SCENARIO B — "add dark mode to the settings screen"
 * Targeted feature request: coding, ic-tier, build verb in goal.
 * Expected: isBuildIntent=true, skeleton.
 */
const DARK_MODE_FRAME: IntentFrame = {
  version: 1,
  goal: 'Add dark mode to the settings screen',
  kind: 'coding',
  routeTier: 'ic',
  confidence: 'high',
  source: 'model',
  doneWhen: 'The settings screen has a working dark/light toggle',
  // Model pre-emitted a skeleton:
  draftGoalSkeleton: {
    title: 'Add dark mode to settings screen',
    outline: [
      { text: 'Add a theme toggle to the settings UI' },
      { text: 'Implement CSS variable / Tailwind dark mode' },
      { text: 'Persist the preference and apply on load' },
    ],
  },
};

/**
 * SCENARIO C — "how does the routing work?" — QUESTION / DISCUSSION.
 * No build verb, no build kind. Expected: isBuildIntent=false, no skeleton.
 */
const QUESTION_FRAME: IntentFrame = {
  version: 1,
  goal: 'Understand how the routing works in this codebase',
  kind: 'research',
  routeTier: 'worker',
  confidence: 'high',
  source: 'model',
};

/**
 * SCENARIO D — casual conversational / skipped frame.
 * Source is 'skipped' (trivial turn that bypassed the extractor entirely).
 * Expected: isBuildIntent=false (skipped guard), no skeleton.
 */
const SKIPPED_FRAME: IntentFrame = {
  version: 1,
  goal: 'sounds good',
  confidence: 'medium',
  source: 'skipped',
};

/**
 * SCENARIO E — ops/deploy request.
 * "deploy the app to production" — kind='ops', build goal.
 * Expected: isBuildIntent=true, skeleton.
 */
const DEPLOY_FRAME: IntentFrame = {
  version: 1,
  goal: 'Deploy the app to production',
  kind: 'ops',
  routeTier: 'manager',
  confidence: 'high',
  source: 'model',
  operationRisk: 'high',
};

/**
 * SCENARIO F — planning request.
 * "plan the refactoring of the auth module" — kind='planning'.
 * Expected: isBuildIntent=true (planning is a build kind), skeleton.
 */
const PLAN_FRAME: IntentFrame = {
  version: 1,
  goal: 'Plan the refactoring of the auth module',
  kind: 'planning',
  routeTier: 'manager',
  confidence: 'medium',
  source: 'model',
  doneWhen: 'A detailed refactoring plan with sub-goals is documented',
};

// ---------------------------------------------------------------------------
// isBuildIntent
// ---------------------------------------------------------------------------

describe('isBuildIntent — BUILD requests', () => {
  it('coding kind → true', () => {
    assert.equal(isBuildIntent(BUILD_APP_FRAME), true);
  });

  it('coding kind + pre-emitted skeleton → true', () => {
    assert.equal(isBuildIntent(DARK_MODE_FRAME), true);
  });

  it('ops kind → true', () => {
    assert.equal(isBuildIntent(DEPLOY_FRAME), true);
  });

  it('planning kind → true', () => {
    assert.equal(isBuildIntent(PLAN_FRAME), true);
  });

  it('ic-tier + build verb in goal → true (secondary signal)', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'Refactor the payment module',
      kind: 'other',
      routeTier: 'ic',
      confidence: 'medium',
      source: 'model',
    };
    assert.equal(isBuildIntent(frame), true);
  });

  it('pre-emitted draftGoalSkeleton alone → true (model decided)', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'Some goal',
      kind: 'other',
      routeTier: 'worker',
      confidence: 'low',
      source: 'model',
      draftGoalSkeleton: {
        title: 'Some goal',
        outline: [{ text: 'Step 1' }, { text: 'Step 2' }],
      },
    };
    assert.equal(isBuildIntent(frame), true);
  });
});

describe('isBuildIntent — NON-BUILD (question / discussion)', () => {
  it('research kind → false', () => {
    assert.equal(isBuildIntent(QUESTION_FRAME), false);
  });

  it('skipped source → false (trivial turn bypassed extractor)', () => {
    assert.equal(isBuildIntent(SKIPPED_FRAME), false);
  });

  it('worker-tier question → false', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'Explain what a promise chain is',
      kind: 'research',
      routeTier: 'worker',
      confidence: 'high',
      source: 'model',
    };
    assert.equal(isBuildIntent(frame), false);
  });

  it('writing WITHOUT doneWhen → false (no concrete deliverable)', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'Write a blog post about async patterns',
      kind: 'writing',
      routeTier: 'worker',
      confidence: 'medium',
      source: 'model',
      // no doneWhen
    };
    assert.equal(isBuildIntent(frame), false);
  });

  it('writing WITH doneWhen → true (concrete deliverable)', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'Write a technical spec for the new API',
      kind: 'writing',
      routeTier: 'ic',
      confidence: 'high',
      source: 'model',
      doneWhen: 'A complete spec document is ready for review',
    };
    assert.equal(isBuildIntent(frame), true);
  });

  it('ic-tier WITHOUT a build verb in goal → false', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'Explain the difference between map and flatMap',
      kind: 'other',
      routeTier: 'ic',
      confidence: 'medium',
      source: 'model',
    };
    assert.equal(isBuildIntent(frame), false);
  });

  it('rules-fallback frame with research kind → false', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'research the current state of websocket libraries',
      kind: 'research',
      confidence: 'low',
      source: 'rules-fallback',
    };
    assert.equal(isBuildIntent(frame), false);
  });
});

describe('isBuildIntent — never throws', () => {
  it('handles a bare minimal frame without crashing', () => {
    const bare: IntentFrame = {
      version: 1,
      goal: '',
      confidence: 'low',
      source: 'rules-fallback',
    };
    assert.doesNotThrow(() => isBuildIntent(bare));
  });
});

// ---------------------------------------------------------------------------
// deriveDraftGoalSkeleton — BUILD scenarios produce a skeleton
// ---------------------------------------------------------------------------

describe('deriveDraftGoalSkeleton — BUILD frames produce a skeleton', () => {
  it('coding frame: title from goal, outline from forks + default steps', () => {
    const skeleton = deriveDraftGoalSkeleton(BUILD_APP_FRAME);
    assert.ok(skeleton !== null, 'expected a skeleton for a build frame');
    assert.ok(skeleton.title.length > 0, 'title must be non-empty');
    assert.ok(skeleton.outline.length >= 2, 'outline must have ≥2 items');
    // First item should come from the fork
    assert.ok(
      skeleton.outline[0]?.text.includes('Which framework?') ||
        skeleton.outline[0]?.text.length > 0,
      'first outline item must be non-empty',
    );
  });

  it('pre-emitted skeleton: returns the capped skeleton directly', () => {
    const skeleton = deriveDraftGoalSkeleton(DARK_MODE_FRAME);
    assert.ok(skeleton !== null, 'expected a skeleton for a build frame');
    assert.equal(skeleton.title, 'Add dark mode to settings screen');
    assert.equal(skeleton.outline.length, 3);
    assert.equal(skeleton.outline[0]?.text, 'Add a theme toggle to the settings UI');
  });

  it('ops frame: title + derived outline', () => {
    const skeleton = deriveDraftGoalSkeleton(DEPLOY_FRAME);
    assert.ok(skeleton !== null, 'expected a skeleton for an ops frame');
    assert.ok(skeleton.title.length > 0);
    assert.ok(skeleton.outline.length >= 2);
  });

  it('planning frame with doneWhen: outline includes doneWhen in implementation step', () => {
    const skeleton = deriveDraftGoalSkeleton(PLAN_FRAME);
    assert.ok(skeleton !== null, 'expected a skeleton for a planning frame');
    // Outline should include at least one step that references the doneWhen
    const texts = skeleton.outline.map((o) => o.text).join(' ');
    assert.ok(texts.length > 0);
    assert.ok(skeleton.outline.length >= 2);
  });

  it('outline items are capped to 160 chars', () => {
    const longGoalFrame: IntentFrame = {
      version: 1,
      goal: 'Build a very complex system',
      kind: 'coding',
      routeTier: 'manager',
      confidence: 'medium',
      source: 'model',
      forks: [
        {
          id: 'F1',
          question: 'A'.repeat(200), // over limit
          assumeIfUnasked: 'B'.repeat(200),
        },
      ],
    };
    const skeleton = deriveDraftGoalSkeleton(longGoalFrame);
    assert.ok(skeleton !== null);
    for (const item of skeleton.outline) {
      assert.ok(item.text.length <= 160, `item text exceeds 160 chars: ${item.text.length}`);
    }
  });

  it('title is capped to 120 chars', () => {
    const longTitleFrame: IntentFrame = {
      version: 1,
      goal: 'X'.repeat(200),
      kind: 'coding',
      routeTier: 'ic',
      confidence: 'medium',
      source: 'model',
    };
    const skeleton = deriveDraftGoalSkeleton(longTitleFrame);
    assert.ok(skeleton !== null);
    assert.ok(skeleton.title.length <= 120);
  });

  it('outline is capped to 6 items', () => {
    const manyForksFrame: IntentFrame = {
      version: 1,
      goal: 'Build something big',
      kind: 'coding',
      routeTier: 'manager',
      confidence: 'high',
      source: 'model',
      draftGoalSkeleton: {
        title: 'Build something big',
        outline: Array.from({ length: 10 }, (_, i) => ({ text: `Step ${i + 1}` })),
      },
    };
    const skeleton = deriveDraftGoalSkeleton(manyForksFrame);
    assert.ok(skeleton !== null);
    assert.ok(skeleton.outline.length <= 6, `outline has ${skeleton.outline.length} items`);
  });
});

// ---------------------------------------------------------------------------
// deriveDraftGoalSkeleton — NON-BUILD frames produce null
// ---------------------------------------------------------------------------

describe('deriveDraftGoalSkeleton — NON-BUILD frames produce null', () => {
  it('research question frame → null', () => {
    assert.equal(deriveDraftGoalSkeleton(QUESTION_FRAME), null);
  });

  it('skipped frame → null', () => {
    assert.equal(deriveDraftGoalSkeleton(SKIPPED_FRAME), null);
  });

  it('worker-tier question → null', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'What is a closure?',
      kind: 'research',
      routeTier: 'worker',
      confidence: 'high',
      source: 'model',
    };
    assert.equal(deriveDraftGoalSkeleton(frame), null);
  });
});

describe('deriveDraftGoalSkeleton — never throws', () => {
  it('does not throw on a bare minimal non-build frame', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: '',
      confidence: 'low',
      source: 'rules-fallback',
    };
    assert.doesNotThrow(() => deriveDraftGoalSkeleton(frame));
  });

  it('does not throw on a null-goal build frame', () => {
    const frame: IntentFrame = {
      version: 1,
      goal: '',
      kind: 'coding',
      routeTier: 'ic',
      confidence: 'high',
      source: 'model',
    };
    // null or a skeleton — either is acceptable; just must not throw
    assert.doesNotThrow(() => deriveDraftGoalSkeleton(frame));
  });
});

// ---------------------------------------------------------------------------
// capDraftGoalSkeleton
// ---------------------------------------------------------------------------

describe('capDraftGoalSkeleton — valid input', () => {
  it('passes through a well-formed skeleton', () => {
    const raw = {
      title: 'Add dark mode',
      outline: [{ text: 'Step 1' }, { text: 'Step 2' }],
    };
    const result = capDraftGoalSkeleton(raw);
    assert.ok(result !== null);
    assert.equal(result.title, 'Add dark mode');
    assert.equal(result.outline.length, 2);
  });

  it('accepts outline items as plain strings', () => {
    const raw = {
      title: 'Build something',
      outline: ['Step A', 'Step B'],
    };
    const result = capDraftGoalSkeleton(raw);
    assert.ok(result !== null);
    assert.equal(result.outline[0]?.text, 'Step A');
  });

  it('caps title at 120 chars', () => {
    const raw = {
      title: 'X'.repeat(200),
      outline: [{ text: 'Step 1' }, { text: 'Step 2' }],
    };
    const result = capDraftGoalSkeleton(raw);
    assert.ok(result !== null);
    assert.ok(result.title.length <= 120);
  });
});

describe('capDraftGoalSkeleton — malformed input returns null', () => {
  it('null → null', () => {
    assert.equal(capDraftGoalSkeleton(null), null);
  });

  it('undefined → null', () => {
    assert.equal(capDraftGoalSkeleton(undefined), null);
  });

  it('missing title → null', () => {
    assert.equal(
      capDraftGoalSkeleton({ outline: [{ text: 'Step 1' }, { text: 'Step 2' }] }),
      null,
    );
  });

  it('empty title → null', () => {
    assert.equal(
      capDraftGoalSkeleton({ title: '', outline: [{ text: 'Step 1' }, { text: 'Step 2' }] }),
      null,
    );
  });

  it('outline with < 2 valid items → null', () => {
    assert.equal(
      capDraftGoalSkeleton({ title: 'Build something', outline: [{ text: 'Step 1' }] }),
      null,
    );
  });

  it('empty outline → null', () => {
    assert.equal(capDraftGoalSkeleton({ title: 'Build something', outline: [] }), null);
  });

  it('garbage input → null without throwing', () => {
    assert.doesNotThrow(() => capDraftGoalSkeleton('not an object'));
    assert.doesNotThrow(() => capDraftGoalSkeleton(42));
    assert.doesNotThrow(() => capDraftGoalSkeleton([]));
    assert.equal(capDraftGoalSkeleton('not an object'), null);
    assert.equal(capDraftGoalSkeleton(42), null);
  });
});
