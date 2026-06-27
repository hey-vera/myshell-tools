/**
 * Unit tests for src/infra/ledger.ts
 * Run with: node --experimental-strip-types --test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createLedger, readLedger, summarizeLedger } from '../../src/infra/ledger.ts';
import { summarizeSpend } from '../../src/infra/insights.ts';
import { getLedgerFile } from '../../src/infra/paths.ts';
import type { LedgerEntry } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: randomUUID(),
    taskId: randomUUID(),
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    tier: 'ic',
    inputTokens: 1000,
    outputTokens: 200,
    cachedInputTokens: 0,
    usd: 0.006,
    durationMs: 1500,
    success: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createLedger — record() and readLedger()
// ---------------------------------------------------------------------------

describe('createLedger — record and readLedger', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `ledger-test-${randomUUID()}-`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records two entries and readLedger returns them both', async () => {
    const cwd = join(dir, 'two-entries');
    const ledger = createLedger({ cwd });

    const entry1 = makeEntry({ model: 'claude-haiku-4-5', usd: 0.001 });
    const entry2 = makeEntry({ model: 'claude-sonnet-4-6', usd: 0.005 });

    await ledger.record(entry1);
    await ledger.record(entry2);

    const entries = await readLedger(cwd);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.model, 'claude-haiku-4-5');
    assert.equal(entries[0]?.usd, 0.001);
    assert.equal(entries[1]?.model, 'claude-sonnet-4-6');
    assert.equal(entries[1]?.usd, 0.005);
  });

  it('record creates .myshell-tools/ directory when it does not exist', async () => {
    const cwd = join(dir, 'dir-creation');
    const ledger = createLedger({ cwd });

    await ledger.record(makeEntry());

    const { stat } = await import('node:fs/promises');
    const stateDir = join(cwd, '.myshell-tools');
    const st = await stat(stateDir);
    assert.ok(st.isDirectory(), '.myshell-tools dir should be a directory');
  });

  it('readLedger returns empty array when file does not exist', async () => {
    const cwd = join(dir, 'nonexistent-ledger');
    const entries = await readLedger(cwd);
    assert.deepEqual(entries, []);
  });

  it('readLedger skips malformed lines', async () => {
    const cwd = join(dir, 'malformed');
    const ledger = createLedger({ cwd });

    const valid1 = makeEntry({ model: 'model-a', usd: 0.01 });
    await ledger.record(valid1);

    // Inject a malformed line
    await appendFile(getLedgerFile(cwd), 'NOT VALID JSON\n', 'utf8');

    const valid2 = makeEntry({ model: 'model-b', usd: 0.02 });
    await ledger.record(valid2);

    const entries = await readLedger(cwd);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.model, 'model-a');
    assert.equal(entries[1]?.model, 'model-b');
  });

  it('readLedger skips valid JSON records with the wrong shape', async () => {
    const cwd = join(dir, 'wrong-shape');
    const ledger = createLedger({ cwd });

    const valid = makeEntry({ model: 'model-valid', usd: 0.03 });
    await ledger.record(valid);

    await appendFile(
      getLedgerFile(cwd),
      [
        'null',
        '{}',
        '{"usd":"x"}',
        '{"timestamp":123,"provider":"claude","model":"bad","tier":"ic","inputTokens":1,"outputTokens":1,"cachedInputTokens":0,"usd":1,"durationMs":1,"success":true}',
        '123',
        '',
      ].join('\n'),
      'utf8',
    );

    const entries = await readLedger(cwd);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.model, 'model-valid');
    assert.doesNotThrow(() => summarizeSpend(entries, new Date().toISOString()));
    assert.equal(summarizeSpend(entries, new Date().toISOString()).calls, 1);
  });

  it('preserves all LedgerEntry fields round-trip', async () => {
    const cwd = join(dir, 'round-trip');
    const ledger = createLedger({ cwd });

    const entry = makeEntry({
      provider: 'codex',
      model: 'gpt-5.4',
      tier: 'manager',
      inputTokens: 5000,
      outputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 2201,
      usd: 0.037,
      durationMs: 3200,
      success: false,
      stage: 'intent',
      intentVersionId: 'ver-round-trip-1',
    });

    await ledger.record(entry);
    const entries = await readLedger(cwd);

    assert.equal(entries.length, 1);
    const got = entries[0];
    assert.equal(got?.provider, 'codex');
    assert.equal(got?.model, 'gpt-5.4');
    assert.equal(got?.tier, 'manager');
    assert.equal(got?.inputTokens, 5000);
    assert.equal(got?.outputTokens, 800);
    assert.equal(got?.cachedInputTokens, 200);
    assert.equal(got?.cacheWriteInputTokens, 2201);
    assert.equal(got?.usd, 0.037);
    assert.equal(got?.durationMs, 3200);
    assert.equal(got?.success, false);
    assert.equal(got?.stage, 'intent');
    assert.equal(got?.intentVersionId, 'ver-round-trip-1');
  });
});

// ---------------------------------------------------------------------------
// summarizeLedger — pure function tests
// ---------------------------------------------------------------------------

describe('summarizeLedger — pure reduction', () => {
  it('returns zeros for an empty array', () => {
    const summary = summarizeLedger([]);
    assert.equal(summary.totalUsd, 0);
    assert.equal(summary.calls, 0);
    assert.deepEqual(summary.byModel, {});
  });

  it('sums a single entry correctly', () => {
    const entry = makeEntry({ model: 'claude-haiku-4-5', usd: 0.003 });
    const summary = summarizeLedger([entry]);

    assert.equal(summary.totalUsd, 0.003);
    assert.equal(summary.calls, 1);
    assert.equal(summary.byModel['claude-haiku-4-5']?.calls, 1);
    assert.equal(summary.byModel['claude-haiku-4-5']?.usd, 0.003);
  });

  it('sums multiple entries with the same model', () => {
    const entries = [
      makeEntry({ model: 'claude-sonnet-4-6', usd: 0.005 }),
      makeEntry({ model: 'claude-sonnet-4-6', usd: 0.010 }),
      makeEntry({ model: 'claude-sonnet-4-6', usd: 0.015 }),
    ];
    const summary = summarizeLedger(entries);

    assert.equal(summary.calls, 3);
    assert.ok(
      Math.abs(summary.totalUsd - 0.03) < 1e-9,
      `expected totalUsd 0.03, got ${summary.totalUsd}`,
    );
    assert.equal(summary.byModel['claude-sonnet-4-6']?.calls, 3);
    assert.ok(
      Math.abs((summary.byModel['claude-sonnet-4-6']?.usd ?? 0) - 0.03) < 1e-9,
      `expected model usd 0.03`,
    );
  });

  it('computes correct per-model breakdown with multiple models', () => {
    const entries = [
      makeEntry({ model: 'claude-haiku-4-5', usd: 0.001 }),
      makeEntry({ model: 'claude-sonnet-4-6', usd: 0.005 }),
      makeEntry({ model: 'claude-haiku-4-5', usd: 0.002 }),
      makeEntry({ model: 'gpt-5.4-mini', usd: 0.003 }),
      makeEntry({ model: 'claude-sonnet-4-6', usd: 0.007 }),
    ];

    const summary = summarizeLedger(entries);

    assert.equal(summary.calls, 5);
    assert.ok(
      Math.abs(summary.totalUsd - 0.018) < 1e-9,
      `expected totalUsd 0.018, got ${summary.totalUsd}`,
    );

    // claude-haiku-4-5: 2 calls, $0.003
    assert.equal(summary.byModel['claude-haiku-4-5']?.calls, 2);
    assert.ok(
      Math.abs((summary.byModel['claude-haiku-4-5']?.usd ?? 0) - 0.003) < 1e-9,
    );

    // claude-sonnet-4-6: 2 calls, $0.012
    assert.equal(summary.byModel['claude-sonnet-4-6']?.calls, 2);
    assert.ok(
      Math.abs((summary.byModel['claude-sonnet-4-6']?.usd ?? 0) - 0.012) < 1e-9,
    );

    // gpt-5.4-mini: 1 call, $0.003
    assert.equal(summary.byModel['gpt-5.4-mini']?.calls, 1);
    assert.ok(
      Math.abs((summary.byModel['gpt-5.4-mini']?.usd ?? 0) - 0.003) < 1e-9,
    );
  });

  it('counts failed calls as well as successful ones', () => {
    const entries = [
      makeEntry({ usd: 0.004, success: true }),
      makeEntry({ usd: 0.002, success: false }),
    ];
    const summary = summarizeLedger(entries);
    assert.equal(summary.calls, 2);
    assert.ok(Math.abs(summary.totalUsd - 0.006) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Integration: record then summarize
// ---------------------------------------------------------------------------

describe('createLedger + summarizeLedger integration', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `ledger-summary-${randomUUID()}-`));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records entries then summarizes with correct totals', async () => {
    const cwd = join(dir, 'summary-integration');
    const ledger = createLedger({ cwd });

    await ledger.record(makeEntry({ model: 'claude-haiku-4-5', usd: 0.001, tier: 'worker' }));
    await ledger.record(makeEntry({ model: 'claude-sonnet-4-6', usd: 0.005, tier: 'ic' }));
    await ledger.record(makeEntry({ model: 'claude-haiku-4-5', usd: 0.002, tier: 'worker' }));

    const entries = await readLedger(cwd);
    const summary = summarizeLedger(entries);

    assert.equal(summary.calls, 3);
    assert.ok(Math.abs(summary.totalUsd - 0.008) < 1e-9);
    assert.equal(summary.byModel['claude-haiku-4-5']?.calls, 2);
    assert.equal(summary.byModel['claude-sonnet-4-6']?.calls, 1);
  });
});
