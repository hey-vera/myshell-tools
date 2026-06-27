import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evidenceReceiptV2Enabled } from '../../src/interface/ui/evidence-receipt-flag.ts';

describe('evidenceReceiptV2Enabled', () => {
  it('absent env returns false', () => {
    assert.equal(evidenceReceiptV2Enabled(undefined), false);
    assert.equal(evidenceReceiptV2Enabled({}), false);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: '1' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'true' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'on' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'yes' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: ' TRUE ' }), true);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'On' }), true);
  });

  it('returns false for opt-out and ambiguous values', () => {
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: '0' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'false' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'off' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'no' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: '' }), false);
    assert.equal(evidenceReceiptV2Enabled({ MYSHELL_EVIDENCE_RECEIPT_V2: 'garbage' }), false);
  });

  it('never throws and defaults false on hostile env', () => {
    const hostile = { get MYSHELL_EVIDENCE_RECEIPT_V2() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(evidenceReceiptV2Enabled(hostile), false);
  });
});
