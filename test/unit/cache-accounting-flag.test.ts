import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cacheAccountingV2Enabled } from '../../src/interface/ui/cache-accounting-flag.js';

describe('cacheAccountingV2Enabled', () => {
  it('absent env returns true (default on)', () => {
    assert.strictEqual(cacheAccountingV2Enabled(undefined), true);
    assert.strictEqual(cacheAccountingV2Enabled({}), true);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    for (const val of ['1', 'true', 'on', 'yes']) {
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val }), true);
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val.toUpperCase() }), true);
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: ` ${val} ` }), true);
    }
  });

  it('returns false only for explicit opt-out values', () => {
    for (const val of ['0', 'false', 'off', 'no']) {
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val }), false);
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: val.toUpperCase() }), false);
      assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: ` ${val} ` }), false);
    }
  });

  it('returns true for empty, ambiguous, and hostile values', () => {
    assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: '' }), true);
    assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: 'maybe' }), true);
    assert.strictEqual(cacheAccountingV2Enabled({ MYSHELL_CACHE_ACCOUNTING_V2: '2' }), true);
  });

  it('never throws and defaults true on hostile env', () => {
    assert.strictEqual(cacheAccountingV2Enabled(null as unknown as NodeJS.ProcessEnv), true);
    assert.strictEqual(
      cacheAccountingV2Enabled({
        get MYSHELL_CACHE_ACCOUNTING_V2() { throw new Error('boom'); }
      } as unknown as NodeJS.ProcessEnv),
      true,
    );
  });
});
