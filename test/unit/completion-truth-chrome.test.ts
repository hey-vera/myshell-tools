/**
 * Unit tests for pure completion-truth chrome (P2.5 partner continuity).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { CompletionResultV1 } from '../../src/core/types.ts';
import {
  COMPLETION_TRUTH_CHROME_MAX_CHARS,
  completionTruthChromeFromFinal,
  formatCompletionTruthChrome,
  mergeCompletionTruthIntoOrientation,
} from '../../src/core/completion-truth-chrome.ts';

function makeCr(overrides: Partial<CompletionResultV1> = {}): CompletionResultV1 {
  return {
    version: 1,
    id: 'cr-1',
    turnId: 't1',
    sessionId: 's1',
    createdAt: '2026-07-10T00:00:00.000Z',
    scope: 'code-change',
    terminal: 'answered',
    objective: 'task',
    doneCondition: null,
    output: 'ok',
    success: true,
    bestEffort: true,
    verification: {
      status: 'unverified',
      testEvidence: { status: 'not-needed' },
      repair: {
        attempted: false,
        attempts: 0,
        maxAttempts: 1,
        retestedAfterLastRepair: false,
        finalAttemptChangedPaths: [],
      },
      factualClaims: [],
      obligationsSatisfied: [],
      obligationsUnmet: [],
      ruleCodes: ['not-applicable'],
    },
    deliveryQuality: {
      status: 'passed',
      checked: true,
      issues: [],
      nextActionNamed: false,
      userVisibleSummary: 'ok',
    },
    worktree: {
      baseline: 'unknown',
      baselineEntries: [],
      changedByAssistant: [],
      excludedPreExisting: [],
      concurrentUserEdits: [],
      conflictPaths: [],
    },
    goalSettlement: {
      allowed: false,
      state: 'none',
      reason: 'answered',
    },
    replayPolicy: {
      replay: 'repair-only',
      reason: 'done-requires-check',
    },
    receipt: { lines: [] },
    upstream: {},
    ...overrides,
  };
}

describe('formatCompletionTruthChrome', () => {
  it('returns undefined for absent/invalid input (no theater)', () => {
    assert.equal(formatCompletionTruthChrome(undefined), undefined);
    assert.equal(formatCompletionTruthChrome(null), undefined);
    // @ts-expect-error deliberate bad input
    assert.equal(formatCompletionTruthChrome({}), undefined);
  });

  it('formats unverified answered with not settled honesty', () => {
    const line = formatCompletionTruthChrome(makeCr());
    assert.ok(line !== undefined);
    assert.match(line!, /check: unverified/);
    assert.match(line!, /answered/);
    assert.match(line!, /not settled/);
  });

  it('formats verified done + settled without inventing fields', () => {
    const line = formatCompletionTruthChrome(
      makeCr({
        terminal: 'done',
        bestEffort: false,
        verification: {
          ...makeCr().verification,
          status: 'verified',
          ruleCodes: ['tests-passing'],
        },
        goalSettlement: { allowed: true, state: 'done', reason: 'verified' },
      }),
    );
    assert.ok(line !== undefined);
    assert.match(line!, /check: verified/);
    assert.match(line!, /done/);
    assert.match(line!, /settled/);
    assert.ok(!line!.includes('undefined'));
    assert.ok(!line!.includes('null'));
  });

  it('formats failing without claiming settled', () => {
    const line = formatCompletionTruthChrome(
      makeCr({
        terminal: 'failed',
        success: false,
        verification: {
          ...makeCr().verification,
          status: 'failing',
          ruleCodes: ['tests-failing'],
        },
        goalSettlement: { allowed: false, state: 'none', reason: 'failed' },
      }),
    );
    assert.ok(line !== undefined);
    assert.match(line!, /check: failing/);
    assert.match(line!, /failed/);
    assert.match(line!, /not settled/);
    // Must not claim positive settlement (allowed=true path).
    assert.ok(!/\bsettled \(verified\)|\bsettled \(reviewed\)| · settled$/.test(line!));
  });

  it('includes short doneCondition when real', () => {
    const line = formatCompletionTruthChrome(
      makeCr({ doneCondition: 'tests green' }),
    );
    assert.ok(line !== undefined);
    assert.match(line!, /doneWhen: tests green/);
  });

  it('omits long doneCondition to keep chrome scannable', () => {
    const line = formatCompletionTruthChrome(
      makeCr({ doneCondition: 'x'.repeat(80) }),
    );
    assert.ok(line !== undefined);
    assert.ok(!line!.includes('doneWhen:'));
  });

  it('caps to max chars', () => {
    const line = formatCompletionTruthChrome(
      makeCr({
        goalSettlement: {
          allowed: false,
          state: 'active',
          reason: 'done-requires-check-' + 'y'.repeat(200),
        },
        terminal: 'done',
      }),
    );
    assert.ok(line !== undefined);
    assert.ok(line!.length <= COMPLETION_TRUTH_CHROME_MAX_CHARS);
  });

  it('never throws on bad input', () => {
    // @ts-expect-error deliberate
    assert.doesNotThrow(() => formatCompletionTruthChrome(null));
    // @ts-expect-error deliberate
    assert.equal(formatCompletionTruthChrome({ version: 2 }), undefined);
  });
});

describe('completionTruthChromeFromFinal', () => {
  it('returns undefined when final has no completionResult', () => {
    assert.equal(completionTruthChromeFromFinal({}), undefined);
    assert.equal(completionTruthChromeFromFinal(undefined), undefined);
  });

  it('formats when completionResult is present', () => {
    const line = completionTruthChromeFromFinal({ completionResult: makeCr() });
    assert.ok(line !== undefined);
    assert.match(line!, /check: unverified/);
  });
});

describe('mergeCompletionTruthIntoOrientation', () => {
  it('returns orientation alone when chrome is clean verified settled', () => {
    const chrome = formatCompletionTruthChrome(
      makeCr({
        terminal: 'done',
        verification: { ...makeCr().verification, status: 'verified' },
        goalSettlement: { allowed: true, state: 'done', reason: 'verified' },
      }),
    );
    const merged = mergeCompletionTruthIntoOrientation('Parked: “Auth”.', chrome);
    assert.equal(merged, 'Parked: “Auth”.');
  });

  it('appends honesty when unverified', () => {
    const chrome = formatCompletionTruthChrome(makeCr());
    const merged = mergeCompletionTruthIntoOrientation(
      'Parked: “Auth”. Resume?',
      chrome,
    );
    assert.ok(merged !== null);
    assert.match(merged!, /Parked/);
    assert.match(merged!, /unverified/);
  });

  it('returns chrome alone when orientation empty and honesty needed', () => {
    const chrome = formatCompletionTruthChrome(makeCr());
    const merged = mergeCompletionTruthIntoOrientation(null, chrome);
    assert.ok(merged !== null);
    assert.match(merged!, /unverified/);
  });

  it('returns null when both empty', () => {
    assert.equal(mergeCompletionTruthIntoOrientation(null, null), null);
    assert.equal(mergeCompletionTruthIntoOrientation('  ', ''), null);
  });
});
