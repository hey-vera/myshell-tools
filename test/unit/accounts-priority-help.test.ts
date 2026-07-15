/**
 * test/unit/accounts-priority-help.test.ts — lock honest priority-weight copy.
 *
 * UX must stay clear that weights balance seats within one provider and do
 * not choose Claude vs Codex vs Grok (provider order is separate).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  formatAccountListStatus,
  PRIORITY_WEIGHT_DETAIL_NOTE,
  PRIORITY_WEIGHT_EDIT_HELP,
  PRIORITY_WEIGHT_LIST_HINT,
} from '../../src/interface/accounts-priority-help.ts';

describe('accounts priority-weight honesty copy', () => {
  it('list hint names within-provider balance and not cross-provider choice', () => {
    assert.match(PRIORITY_WEIGHT_LIST_HINT, /this provider only/i);
    assert.match(PRIORITY_WEIGHT_LIST_HINT, /tokens/i);
    assert.match(PRIORITY_WEIGHT_LIST_HINT, /Claude vs Codex vs Grok/i);
  });

  it('edit help explains load = tokens ÷ weight and non-provider-order scope', () => {
    assert.match(PRIORITY_WEIGHT_EDIT_HELP, /session tokens/i);
    assert.match(PRIORITY_WEIGHT_EDIT_HELP, /weight/i);
    assert.match(PRIORITY_WEIGHT_EDIT_HELP, /Does not choose provider order/i);
  });

  it('detail note states within-provider only, not Auto provider order', () => {
    assert.match(PRIORITY_WEIGHT_DETAIL_NOTE, /within-provider/i);
    assert.match(PRIORITY_WEIGHT_DETAIL_NOTE, /not Auto provider order/i);
  });
});

describe('formatAccountListStatus — list row honesty (U7)', () => {
  it('maps real enabled + status fields; never invents active for missing/failed', () => {
    assert.equal(formatAccountListStatus({ enabled: true, status: 'active' }), 'active');
    assert.equal(formatAccountListStatus({ enabled: true, status: 'auth-failed' }), 'auth-failed');
    assert.equal(formatAccountListStatus({ enabled: true, status: 'expired' }), 'expired');
    assert.equal(formatAccountListStatus({ enabled: true, status: 'unknown' }), 'unknown');
    assert.equal(formatAccountListStatus({ enabled: true }), 'unknown');
    assert.equal(formatAccountListStatus({ enabled: false, status: 'active' }), 'disabled');
    assert.equal(formatAccountListStatus({ enabled: false }), 'disabled');
    assert.equal(formatAccountListStatus({ enabled: true, status: 'disabled' }), 'disabled');
  });

  it('does not treat enabled alone as active (opencode-style hardcode regression)', () => {
    // Pre-fix OpenCode row used `acc.enabled ? 'active' : 'disabled'`.
    assert.notEqual(
      formatAccountListStatus({ enabled: true, status: 'auth-failed' }),
      'active',
    );
    assert.notEqual(formatAccountListStatus({ enabled: true }), 'active');
  });
});
