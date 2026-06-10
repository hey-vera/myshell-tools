/**
 * test/unit/oversight.test.ts — the OVERSIGHT SPECTRUM (Phase 2b) pure seams:
 * resolveOversight (default + each level + env override) and the reusable
 * shouldPauseBeforeLaunch launch-checkpoint hook (the Phase-4 extension point).
 *
 * Honesty Contract: no Math.random, no fabricated AI output, no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOversight,
  shouldPauseBeforeLaunch,
  type Oversight,
  type LaunchCheckpointReason,
} from '../../src/interface/ui/oversight.ts';

describe('resolveOversight — the execution-autonomy level', () => {
  it('defaults to checkpoint when nothing is set', () => {
    assert.equal(resolveOversight(undefined, {}), 'checkpoint');
    assert.equal(resolveOversight({}, {}), 'checkpoint');
    assert.equal(resolveOversight({ oversight: undefined }, {}), 'checkpoint');
  });

  it('honours an explicit config level', () => {
    assert.equal(resolveOversight({ oversight: 'review-all' }, {}), 'review-all');
    assert.equal(resolveOversight({ oversight: 'checkpoint' }, {}), 'checkpoint');
    assert.equal(resolveOversight({ oversight: 'autonomous' }, {}), 'autonomous');
  });

  it('lets MYSHELL_OVERSIGHT override the config (incl. friendly aliases)', () => {
    assert.equal(
      resolveOversight({ oversight: 'checkpoint' }, { MYSHELL_OVERSIGHT: 'autonomous' }),
      'autonomous',
    );
    assert.equal(
      resolveOversight({ oversight: 'autonomous' }, { MYSHELL_OVERSIGHT: 'review-all' }),
      'review-all',
    );
    // Aliases + case/whitespace tolerance.
    assert.equal(resolveOversight({}, { MYSHELL_OVERSIGHT: ' Auto ' }), 'autonomous');
    assert.equal(resolveOversight({}, { MYSHELL_OVERSIGHT: 'review' }), 'review-all');
    assert.equal(resolveOversight({}, { MYSHELL_OVERSIGHT: 'PROPOSE' }), 'checkpoint');
  });

  it('ignores an unknown env value and falls back to config/default', () => {
    assert.equal(resolveOversight({ oversight: 'review-all' }, { MYSHELL_OVERSIGHT: 'bogus' }), 'review-all');
    assert.equal(resolveOversight({}, { MYSHELL_OVERSIGHT: 'bogus' }), 'checkpoint');
  });
});

describe('shouldPauseBeforeLaunch — the reusable launch-checkpoint seam', () => {
  it('pauses ONLY for review-all, only at the per-todo-diff site, only with a real diff', () => {
    const pause = shouldPauseBeforeLaunch({
      oversight: 'review-all',
      phase: 'per-todo-diff',
      hasDiff: true,
    });
    assert.notEqual(pause, null);
    // The reason is the typed extension point Phase 4 will widen.
    const reason: LaunchCheckpointReason | undefined = pause?.reason;
    assert.equal(reason, 'review-all-diff');
  });

  it('does NOT pause review-all when there is no diff to review', () => {
    assert.equal(
      shouldPauseBeforeLaunch({ oversight: 'review-all', phase: 'per-todo-diff', hasDiff: false }),
      null,
    );
  });

  it('never pauses for checkpoint or autonomous (their launch behaviour is at the proposal site)', () => {
    for (const oversight of ['checkpoint', 'autonomous'] as Oversight[]) {
      assert.equal(
        shouldPauseBeforeLaunch({ oversight, phase: 'per-todo-diff', hasDiff: true }),
        null,
        `${oversight} must not pause at the per-diff hook`,
      );
    }
  });
});
