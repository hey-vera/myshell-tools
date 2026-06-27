/**
 * test/unit/work-call-blocked-state.test.ts — blocked-state terminal tests
 * for blocked record construction and validation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildBlockedRecord, isBlockedRecord, type BlockedRecord } from '../../src/core/blocked.ts';

describe('buildBlockedRecord', () => {
  it('builds a valid blocked record with code', () => {
    const r = buildBlockedRecord({
      reason: 'Auth failed',
      nextAction: 'Login and retry',
      preservedWork: 'Partial output saved',
      code: 'missing_authority',
    });
    assert.notEqual(r, null);
    assert.equal(r!.reason, 'Auth failed');
    assert.equal(r!.nextAction, 'Login and retry');
    assert.equal(r!.preservedWork, 'Partial output saved');
    assert.equal(r!.code, 'missing_authority');
  });

  it('omits invalid code', () => {
    const r = buildBlockedRecord({
      reason: 'Auth failed',
      nextAction: 'Login and retry',
      preservedWork: 'Partial output saved',
      code: 'garbage_code',
    });
    assert.notEqual(r, null);
    assert.equal(r!.code, undefined);
  });

  it('returns null when reason is empty', () => {
    assert.equal(buildBlockedRecord({ reason: '', nextAction: 'x', preservedWork: 'y' }), null);
    assert.equal(buildBlockedRecord({ reason: '  ', nextAction: 'x', preservedWork: 'y' }), null);
  });

  it('returns null when nextAction is empty', () => {
    assert.equal(buildBlockedRecord({ reason: 'x', nextAction: '', preservedWork: 'y' }), null);
  });

  it('returns null when preservedWork is empty', () => {
    assert.equal(buildBlockedRecord({ reason: 'x', nextAction: 'y', preservedWork: '' }), null);
  });

  it('isBlockedRecord validates correctly', () => {
    const valid: BlockedRecord = { reason: 'a', nextAction: 'b', preservedWork: 'c' };
    assert.equal(isBlockedRecord(valid), true);
    assert.equal(isBlockedRecord(null), false);
    assert.equal(isBlockedRecord({}), false);
    assert.equal(isBlockedRecord({ reason: '', nextAction: 'x', preservedWork: 'y' }), false);
  });

  it('accepts absent code', () => {
    const r = buildBlockedRecord({
      reason: 'Time ran out',
      nextAction: 'Retry with more time',
      preservedWork: 'Partial draft saved',
    });
    assert.notEqual(r, null);
    assert.equal(r!.code, undefined);
  });
});
