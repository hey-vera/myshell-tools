import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cacheAccountingV2Enabled } from '../../src/interface/ui/cache-accounting-flag.js';

describe('cacheAccountingV2Enabled', () => {
  it('absent env returns false', () => {
    assert.strictEqual(cacheAccountingV2Enabled(undefined), false);
    assert.strictEqual(cacheAccountingV2Enabled({}), false);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    for (const val of ['1', 'true', 'on', 'yes']) {
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val }), true);
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val.toUpperCase() }), true);
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: ` ${val} ` }), true);
    }
  });

  it('returns false for opt-out and ambiguous values', () => {
    for (const val of ['0', 'false', 'off', 'no']) {
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val }), false);
    }
    assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: '' }), false);
    assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: 'maybe' }), false);
    assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: '2' }), false);
  });

  it('never throws and defaults false on hostile env', () => {
    assert.strictEqual(cacheAccountingV2Enabled(null as unknown as NodeJS.ProcessEnv), false);
    assert.strictEqual(
      cacheAccountingV2Enabled({
        get MYSHELL_CACHE_ACCOUNTING_V2() { throw new Error('boom'); }
      } as unknown as NodeJS.ProcessEnv),
      false,
    );
  });
});
