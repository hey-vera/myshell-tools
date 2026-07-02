/**
 * test/unit/jsonl-guards-intent-version.test.ts — unit tests for isIntentVersion
 * in src/infra/jsonl-guards.ts.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { isIntentVersion } from '../../src/infra/jsonl-guards.ts';
import type { SemanticPreflightV1 } from '../../src/core/semantic-preflight.ts';

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

function validSemantic(): SemanticPreflightV1 {
  return {
    version: 1,
    objective: 'inspect login test',
    taskShape: { kind: 'change', scope: 'single-step', mutatesWorkspace: true },
    route: { tier: 'ic', plan: false, rationale: 'small code change' },
    risk: { level: 'medium', reasons: ['touches tests'] },
    uncertainty: { level: 'low', reasons: [], forks: [] },
    evidenceNeeded: [
      {
        id: 'E1',
        kind: 'local-code',
        phase: 'before-execution',
        query: 'read login test',
        required: true,
      },
    ],
    doneCondition: { status: 'specified', text: 'test passes' },
    planSteps: [{ text: 'Inspect test' }],
    proposedExecution: { provider: 'auto', effort: 'none', rationale: 'defer routing' },
    source: 'model',
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

  it('legacy row without semantic field still passes guard and reads unchanged', () => {
    const row = validBase();

    assert.equal(isIntentVersion(row), true);
    assert.deepEqual(row.intent, { objective: 'do the thing' });
    assert.equal('semanticPreflight' in row, false);
  });

  it('old-reader projection ignores additive semantic field', () => {
    const row = {
      ...validBase(),
      semanticPreflight: validSemantic(),
    };

    assert.equal(isIntentVersion(row), true);
    assert.deepEqual(row.intent, validBase().intent);
  });

  it('malformed optional semantic payload fails new guard', () => {
    assert.equal(
      isIntentVersion({
        ...validBase(),
        semanticPreflight: { ...validSemantic(), doneCondition: { status: 'specified', text: '' } },
      }),
      false,
    );
    assert.equal(
      isIntentVersion({
        ...validBase(),
        semanticPreflight: { ...validSemantic(), evidenceNeeded: [{ id: 'bad id' }] },
      }),
      false,
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
