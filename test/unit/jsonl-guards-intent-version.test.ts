/**
 * test/unit/jsonl-guards-intent-version.test.ts — unit tests for isIntentVersion
 * in src/infra/jsonl-guards.ts.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { isIntentVersion } from '../../src/infra/jsonl-guards.ts';

function validBase() {
  return {
    version: 1,
    id: 'v1',
    sessionId: 'sess-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    rawUserTurnText: 'hello',
    intent: {
      objective: 'do the thing',
    },
  };
}

describe('isIntentVersion', () => {
  it('valid intent version passes', () => {
    assert.equal(isIntentVersion(validBase()), true);
  });

  it('minimal old intent version row passes', () => {
    assert.equal(
      isIntentVersion({
        version: 1,
        id: 'v1',
        sessionId: 'sess-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        rawUserTurnText: 'hello',
        intent: {
          objective: 'do the thing',
        },
      }),
      true,
    );
  });

  it('intent version with blank id fails', () => {
    assert.equal(isIntentVersion({ ...validBase(), id: '' }), false);
    assert.equal(isIntentVersion({ ...validBase(), id: '  ' }), false);
  });

  it('intent version with malformed parentId fails', () => {
    assert.equal(isIntentVersion({ ...validBase(), parentId: '' }), false);
    assert.equal(isIntentVersion({ ...validBase(), parentId: '  ' }), false);
    // null is fine
    assert.equal(isIntentVersion({ ...validBase(), parentId: null }), true);
    // string is fine
    assert.equal(isIntentVersion({ ...validBase(), parentId: 'parent-1' }), true);
  });

  it('intent version with malformed intent payload fails', () => {
    assert.equal(isIntentVersion({ ...validBase(), intent: {} }), false);
    assert.equal(isIntentVersion({ ...validBase(), intent: { objective: '' } }), false);
    assert.equal(isIntentVersion({ ...validBase(), intent: { objective: 'x', assumptions: 42 } }), false);
    assert.equal(isIntentVersion({ ...validBase(), intent: { objective: 'x', risk: 'unknown' } }), false);
    assert.equal(isIntentVersion({ ...validBase(), intent: { objective: 'x', confidence: 'unknown' } }), false);
  });
});
