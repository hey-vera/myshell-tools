/**
 * test/unit/vision-triage.test.ts — Adaptive Partner Engine v2, STAGE 3.
 *
 * Pure-function coverage for vision triage (adaptive-partner-v2-5.6.md §2.4 C):
 *   - triageVision: the disposition TABLE — a SOLID implementable claim → proceed;
 *     a genuine fork → DISCUSS/ask_user (and a generic "fix/add/polish" fork is NOT
 *     a genuine fork → reclassified to investigate); a "rewrite in Rust" / "move the
 *     core" claim → MIGRATE_REARCHITECT/flag_architecture; an investigable claim →
 *     INVESTIGATE_THEN_PROPOSE/investigate.
 *   - Caps + fail-soft (empty/garbage → []).
 *   - Derived facts (hasMigrationConcern / hasInvestigateConcern / firstDiscussFork).
 *   - renderVisionTriageBlock: recommends a SEQUENCE, forbids a generic menu.
 *
 * PURE — no model, no I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  triageVision,
  hasMigrationConcern,
  hasInvestigateConcern,
  firstDiscussFork,
  renderVisionTriageBlock,
  type TriageVisionInput,
  type VisionTriageItem,
} from '../../src/core/vision-triage.ts';
import type { EngagementSignals } from '../../src/core/engagement.ts';
import type { IntentFrame, IntentFork } from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';

const IC: Classification = { tier: 'ic', risk: 'medium', rationale: 't' };

function signals(over: Partial<EngagementSignals> & { task: string }): EngagementSignals {
  return {
    classification: IC,
    routePlan: false,
    engagementBias: 1, // collaborative — raises the fork budget / fork-asking lean
    ...over,
  };
}

function frameWith(forks: readonly IntentFork[] | undefined, kind = 'product'): IntentFrame {
  return {
    version: 1,
    goal: 'g',
    kind,
    confidence: 'low',
    source: 'model',
    ...(forks !== undefined ? { forks } : {}),
  };
}

function triage(over: Partial<EngagementSignals> & { task: string }, repoPresent?: boolean): readonly VisionTriageItem[] {
  const input: TriageVisionInput = {
    signals: signals(over),
    ...(repoPresent !== undefined ? { repoPresent } : {}),
  };
  return triageVision(input);
}

function dispositions(items: readonly VisionTriageItem[]): readonly string[] {
  return items.map((i) => i.disposition);
}

// ---------------------------------------------------------------------------
// Disposition TABLE
// ---------------------------------------------------------------------------

describe('triageVision — disposition table', () => {
  it('SOLID: a clear, in-scope implementable claim → proceed', () => {
    const items = triage({ task: 'add a dark-mode toggle to the settings screen' });
    assert.ok(items.length >= 1);
    assert.ok(
      items.some((i) => i.disposition === 'SOLID' && i.defaultAction === 'proceed'),
      'a clear implementable claim is SOLID/proceed',
    );
    // No spurious migration/investigate on a plain build claim.
    assert.ok(!hasMigrationConcern(items));
  });

  it('DISCUSS: a genuine (preference/vision) fork → ask_user, carrying the fork', () => {
    const frame = frameWith([
      {
        id: 'F1',
        question: 'Which tone do you prefer for the brand voice?',
        options: ['Playful', 'Formal'],
        assumeIfUnasked: 'Playful',
      },
    ]);
    const items = triage({ frame, task: 'write the marketing landing copy' });
    const discuss = items.find((i) => i.disposition === 'DISCUSS');
    assert.ok(discuss !== undefined, 'a genuine preference fork is DISCUSS');
    assert.equal(discuss.defaultAction, 'ask_user');
    assert.ok(discuss.question !== undefined, 'DISCUSS carries the fork for the ASK machinery');
    assert.equal(discuss.question.id, 'F1');
    assert.equal(firstDiscussFork(items)?.id, 'F1');
  });

  it('a generic "fix/add/polish/integrate" fork is NOT a genuine fork → reclassified to investigate', () => {
    const frame = frameWith([
      {
        id: 'F1',
        question: 'What are you trying to do with the page?',
        options: ['fix something broken', 'add a new feature', 'polish the layout'],
      },
    ]);
    // A coding turn referencing an existing page is investigable.
    const items = triage({
      frame,
      task: 'work on the existing socials page in this repo',
    });
    // The generic menu fork must NOT be a DISCUSS/ask_user item.
    assert.ok(
      !items.some((i) => i.disposition === 'DISCUSS'),
      'a generic task-category fork is never DISCUSS/ask_user',
    );
    assert.ok(
      items.some((i) => i.disposition === 'INVESTIGATE_THEN_PROPOSE'),
      'a generic menu fork is reclassified to investigate',
    );
    assert.equal(firstDiscussFork(items), undefined);
  });

  it('MIGRATE_REARCHITECT: "rewrite in Rust" → flag_architecture', () => {
    const items = triage({ task: 'maybe rewrite the indexing core in Rust for speed' });
    const migrate = items.find((i) => i.disposition === 'MIGRATE_REARCHITECT');
    assert.ok(migrate !== undefined, '"rewrite in Rust" is a migration concern');
    assert.equal(migrate.defaultAction, 'flag_architecture');
    assert.ok(hasMigrationConcern(items));
  });

  it('MIGRATE_REARCHITECT: "move the core" → flag_architecture', () => {
    const items = triage({ task: 'we should move the core to a separate service' });
    assert.ok(
      items.some((i) => i.disposition === 'MIGRATE_REARCHITECT' && i.defaultAction === 'flag_architecture'),
      '"move the core" is a migration concern',
    );
  });

  it('INVESTIGATE_THEN_PROPOSE: an investigable claim → investigate', () => {
    const items = triage({ task: 'figure out why the checkout page is slow' });
    const inv = items.find((i) => i.disposition === 'INVESTIGATE_THEN_PROPOSE');
    assert.ok(inv !== undefined, 'a why/diagnose claim is investigable');
    assert.equal(inv.defaultAction, 'investigate');
    assert.ok(hasInvestigateConcern(items));
  });

  it('separates a BROAD multi-part vision into distinct dispositions', () => {
    // The §4 Stage-3 real-run shape: product judgment + code investigation + a Rust rewrite.
    const frame = frameWith([
      {
        id: 'F1',
        question: 'Which audience should the product judgment optimize for?',
        options: ['Power users', 'New users'],
      },
    ]);
    const items = triage({
      frame,
      task:
        'I want part product judgment on the roadmap, and figure out why the planner is flaky, ' +
        'and maybe rewrite the planner core in Rust. Make a plan.',
    });
    const ds = dispositions(items);
    assert.ok(ds.includes('DISCUSS'), 'a genuine product fork is DISCUSS');
    assert.ok(ds.includes('INVESTIGATE_THEN_PROPOSE'), 'the flaky-planner part is investigate-first');
    assert.ok(ds.includes('MIGRATE_REARCHITECT'), 'the Rust rewrite is a migration concern');
    // It must be multi-part (≥2 distinct) — the directive will carry it.
    assert.ok(new Set(ds).size >= 2, 'a broad vision separates into ≥2 dispositions');
  });
});

// ---------------------------------------------------------------------------
// Caps + fail-soft
// ---------------------------------------------------------------------------

describe('triageVision — caps + fail-soft', () => {
  it('empty task → no items (fail-soft, never throws)', () => {
    assert.deepEqual(triage({ task: '' }), []);
    assert.deepEqual(triage({ task: '   ' }), []);
  });

  it('garbage input → [] (never throws)', () => {
    // @ts-expect-error — deliberately malformed input
    assert.deepEqual(triageVision(null), []);
    // @ts-expect-error — deliberately malformed input
    assert.deepEqual(triageVision({ signals: null }), []);
  });

  it('caps the number of items', () => {
    const task = Array.from({ length: 20 }, (_, i) => `do distinct thing number ${i}`).join(' and ');
    const items = triage({ task });
    assert.ok(items.length <= 6, 'triage is capped at 6 items');
  });

  it('helpers are total over an empty list', () => {
    assert.equal(hasMigrationConcern([]), false);
    assert.equal(hasInvestigateConcern([]), false);
    assert.equal(firstDiscussFork([]), undefined);
  });
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

describe('renderVisionTriageBlock', () => {
  it('returns "" for empty/undefined', () => {
    assert.equal(renderVisionTriageBlock(undefined), '');
    assert.equal(renderVisionTriageBlock([]), '');
  });

  it('recommends a SEQUENCE and explicitly forbids a generic menu', () => {
    const items = triage({
      task: 'figure out why it is slow, and maybe rewrite the core in Rust',
    });
    const block = renderVisionTriageBlock(items);
    assert.match(block, /VISION TRIAGE/);
    assert.match(block, /SEQUENCE|ORDER/i);
    assert.match(block, /do NOT offer a generic menu|not a list of generic options/i);
    // Each item line tags its disposition.
    assert.match(block, /\[MIGRATE_REARCHITECT\]/);
    assert.match(block, /\[INVESTIGATE_THEN_PROPOSE\]/);
  });
});
