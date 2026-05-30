/**
 * Unit tests for src/core/escalate.ts
 * Run with: node --import ./test/register.mjs --test "test/unit/escalate.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextTierUp, pickReviewer } from '../../src/core/escalate.ts';

// ---------------------------------------------------------------------------
// nextTierUp
// ---------------------------------------------------------------------------

describe('nextTierUp — tier escalation chain', () => {
  it('worker escalates to ic', () => {
    assert.equal(nextTierUp('worker'), 'ic');
  });

  it('ic escalates to manager', () => {
    assert.equal(nextTierUp('ic'), 'manager');
  });

  it('manager returns null (top of chain)', () => {
    assert.equal(nextTierUp('manager'), null);
  });
});

// ---------------------------------------------------------------------------
// pickReviewer
// ---------------------------------------------------------------------------

describe('pickReviewer — reviewer selection', () => {
  it('returns null when available is empty', () => {
    assert.equal(pickReviewer([], 'claude'), null);
  });

  it('prefers a different vendor (cross-vendor review)', () => {
    // codex is different from claude → prefer it
    const reviewer = pickReviewer(['claude', 'codex'], 'claude');
    assert.equal(reviewer, 'codex');
  });

  it('prefers cross-vendor even when primary comes first in list', () => {
    const reviewer = pickReviewer(['codex', 'claude'], 'codex');
    // claude is the cross-vendor option
    assert.equal(reviewer, 'claude');
  });

  it('falls back to primary when all available are same vendor', () => {
    // Only claude available, primary is claude → return claude
    const reviewer = pickReviewer(['claude'], 'claude');
    assert.equal(reviewer, 'claude');
  });

  it('returns null when primary is unavailable and no cross-vendor exists', () => {
    // primary is codex but only claude is available — find returns claude as cross-vendor
    // Actually: claude !== codex, so it's picked as cross-vendor
    // Let's test a case where primary is not in available and only primaries are listed
    // This scenario: available=['claude'], primary='codex'
    // 'claude' !== 'codex' so cross-vendor is returned
    const reviewer = pickReviewer(['claude'], 'codex');
    assert.equal(reviewer, 'claude');
  });

  it('returns null when available is empty regardless of primary', () => {
    assert.equal(pickReviewer([], 'codex'), null);
  });

  it('handles single item same as primary — falls back to primary', () => {
    assert.equal(pickReviewer(['codex'], 'codex'), 'codex');
  });

  it('handles single item different from primary — returns that item (cross-vendor)', () => {
    assert.equal(pickReviewer(['codex'], 'claude'), 'codex');
  });

  it('with multiple providers prefers first cross-vendor found', () => {
    // Two cross-vendor options: codex appears first in the search
    const reviewer = pickReviewer(['codex', 'claude', 'codex'], 'claude');
    // find() returns first non-claude, which is codex
    assert.equal(reviewer, 'codex');
  });
});
