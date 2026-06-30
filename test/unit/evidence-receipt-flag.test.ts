import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { evidenceReceiptV2Enabled } from '../../src/interface/ui/evidence-receipt-flag.ts';

describe('evidenceReceiptV2Enabled', () => {
  it('absent env returns true (default on)', () => {
    assert.equal(evidenceReceiptV2Enabled(undefined), true);
    assert.equal(evidenceReceiptV2Enabled({}), true);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: '1' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'true' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'on' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'yes' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: ' TRUE ' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'On' }), true);
  });

  it('returns false only for explicit opt-out values', () => {
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: '0' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'false' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'off' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'no' }), false);
  });

  it('returns true for empty and ambiguous values', () => {
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: '' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'garbage' }), true);
  });

  it('never throws and defaults true on hostile env', () => {
    const hostile = { get MYSHELL_EVIDENCE_RECEIPT_V2() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(evidenceReceiptV2Enabled(hostile), true);
  });
});
