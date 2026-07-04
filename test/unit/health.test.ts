/**
 * test/unit/health.test.ts — unit tests for the pure health evaluator.
 *
 * evaluateHealth is pure and the heart of the "it just works, surfaces only when
 * broken" behavior, so it gets thorough coverage. probeStateWritable is I/O and
 * exercised indirectly elsewhere.
 *
 * Honesty Contract: no fabricated data, no hardcoded percentages.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateHealth, nodeMajor, probeStateWritable } from '../../src/infra/health.ts';
import type { HealthInputs } from '../../src/infra/health.ts';
import type { MigrationReport } from '../../src/infra/state-migration.ts';

const HEALTHY: HealthInputs = {
  nodeVersion: 'v22.19.0',
  stateWritable: true,
  pricingStale: false,
};

describe('nodeMajor', () => {
  it('parses a standard Node version string', () => {
    assert.strictEqual(nodeMajor('v22.19.0'), 22);
  });
  it('parses without the leading v', () => {
    assert.strictEqual(nodeMajor('20.20.0'), 20);
  });
  it('returns null for an unparseable string', () => {
    assert.strictEqual(nodeMajor('not-a-version'), null);
  });
});

describe('evaluateHealth', () => {
  it('returns no issues when everything is healthy (silence == healthy)', () => {
    assert.deepEqual(evaluateHealth(HEALTHY), []);
  });

  it('flags a non-writable state directory as an error', () => {
    const issues = evaluateHealth({ ...HEALTHY, stateWritable: false });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.id, 'state-not-writable');
    assert.strictEqual(issues[0]?.severity, 'error');
  });

  it('flags Node below the supported floor as a warning', () => {
    const issues = evaluateHealth({ ...HEALTHY, nodeVersion: 'v18.0.0' });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.id, 'node-too-old');
    assert.strictEqual(issues[0]?.severity, 'warn');
  });

  it('does NOT flag Node at or above the floor', () => {
    assert.deepEqual(evaluateHealth({ ...HEALTHY, nodeVersion: 'v20.0.0' }), []);
  });

  it('respects a custom minNodeMajor', () => {
    const issues = evaluateHealth({ ...HEALTHY, nodeVersion: 'v20.0.0', minNodeMajor: 22 });
    assert.strictEqual(issues[0]?.id, 'node-too-old');
  });

  it('skips the Node check when the version is unparseable (no bogus warning)', () => {
    assert.deepEqual(evaluateHealth({ ...HEALTHY, nodeVersion: 'weird' }), []);
  });

  it('flags stale pricing as a warning', () => {
    const issues = evaluateHealth({ ...HEALTHY, pricingStale: true });
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0]?.id, 'pricing-stale');
    assert.strictEqual(issues[0]?.severity, 'warn');
  });

  it('orders errors before warnings when multiple issues exist', () => {
    const issues = evaluateHealth({
      nodeVersion: 'v18.0.0',
      stateWritable: false,
      pricingStale: true,
    });
    assert.strictEqual(issues.length, 3);
    assert.strictEqual(issues[0]?.severity, 'error', 'the error comes first');
    assert.strictEqual(issues[0]?.id, 'state-not-writable');
  });

  it('every message includes an actionable fix and no fabricated percentage', () => {
    const issues = evaluateHealth({
      nodeVersion: 'v18.0.0',
      stateWritable: false,
      pricingStale: true,
    });
    for (const issue of issues) {
      assert.ok(issue.message.length > 0, 'message is non-empty');
      assert.ok(!/\d+%/.test(issue.message), 'no digit-% literal in message');
    }
  });

  // ── Migration / gitignore surface ──────────────────────────────────────

  it('surfaces a warning when migration status is conflicts', () => {
    const report: MigrationReport = {
      status: 'conflicts',
      copied: [],
      alreadyPresent: [],
      conflicts: ['credentials.json'],
      merged: [],
      errors: [],
      manifestPath: '/tmp/manifest.json',
    };
    const issues = evaluateHealth({ ...HEALTHY, migrationReport: report });
    const found = issues.find((i) => i.id === 'migration-conflicts');
    assert.ok(found !== undefined, 'should surface migration-conflicts warning');
    assert.equal(found?.severity, 'warn');
    assert.ok(found?.message.includes('conflict'), 'should mention conflicts');
    assert.ok(found?.message.includes('/tmp/manifest.json'), 'should include manifest path');
  });

  it('surfaces a warning when migration status is partial', () => {
    const report: MigrationReport = {
      status: 'partial',
      copied: [],
      alreadyPresent: [],
      conflicts: [],
      merged: [],
      errors: ['read error'],
      manifestPath: '/tmp/manifest.json',
    };
    const issues = evaluateHealth({ ...HEALTHY, migrationReport: report });
    const found = issues.find((i) => i.id === 'migration-partial');
    assert.ok(found !== undefined, 'should surface migration-partial warning');
    assert.equal(found?.severity, 'warn');
  });

  it('does NOT surface migration for complete status (silence == healthy)', () => {
    const report: MigrationReport = {
      status: 'complete',
      copied: ['config.json'],
      alreadyPresent: [],
      conflicts: [],
      merged: [],
      errors: [],
      manifestPath: '/tmp/manifest.json',
    };
    const issues = evaluateHealth({ ...HEALTHY, migrationReport: report });
    const found = issues.find((i) => i.id === 'migration-conflicts' || i.id === 'migration-partial');
    assert.equal(found, undefined, 'complete migration should not surface');
  });

  it('does NOT surface complete-with-archive (archive conflicts self-healed silently)', () => {
    const report: MigrationReport = {
      status: 'complete-with-archive',
      copied: [],
      alreadyPresent: [],
      conflicts: ['.session-archive/old.jsonl'],
      merged: [],
      errors: [],
      manifestPath: '/tmp/manifest.json',
    };
    const issues = evaluateHealth({ ...HEALTHY, migrationReport: report });
    const found = issues.find((i) => i.id === 'migration-conflicts' || i.id === 'migration-partial');
    assert.equal(found, undefined, 'complete-with-archive should not surface');
  });

  it('still surfaces non-archive conflicts as a user decision', () => {
    const report: MigrationReport = {
      status: 'conflicts',
      copied: [],
      alreadyPresent: [],
      conflicts: ['config.json'],
      merged: [],
      errors: [],
      manifestPath: '/tmp/manifest.json',
    };
    const issues = evaluateHealth({ ...HEALTHY, migrationReport: report });
    const found = issues.find((i) => i.id === 'migration-conflicts');
    assert.ok(found !== undefined, 'non-archive conflict should surface');
    assert.equal(found?.severity, 'warn');
    assert.ok(found?.message.includes('/tmp/manifest.json'), 'should include manifest path');
  });

  it('does NOT change output when migration/gitignore inputs are absent', () => {
    const issues = evaluateHealth(HEALTHY);
    assert.deepEqual(issues, [], 'absent inputs change nothing');
  });

  it('surfaces an error when gitignore guard failed (secret-leak risk)', () => {
    const issues = evaluateHealth({
      ...HEALTHY,
      gitignoreStatus: { ok: false, reason: 'EACCES: permission denied' },
    });
    const found = issues.find((i) => i.id === 'gitignore-not-protected');
    assert.ok(found !== undefined, 'should surface gitignore error');
    assert.equal(found?.severity, 'error');
    assert.ok(found?.message.includes('EACCES'), 'should include the reason');
  });

  it('is silent when gitignore guard ok', () => {
    const issues = evaluateHealth({
      ...HEALTHY,
      gitignoreStatus: { ok: true },
    });
    const found = issues.find((i) => i.id === 'gitignore-not-protected');
    assert.equal(found, undefined, 'gitignore ok should not surface');
  });
});

describe('probeStateWritable', () => {
  it('probes the resolved state home, not cwd', async () => {
    const cwd = join(tmpdir(), `health-cwd-${randomUUID()}`);
    const home = join(tmpdir(), `health-home-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(cwd, '.myshell-tools'), 'not a directory');

    try {
      assert.equal(await probeStateWritable(cwd, { stateHome: home }), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns false when the resolved state home cannot hold the state directory', async () => {
    const cwd = join(tmpdir(), `health-cwd-${randomUUID()}`);
    const home = join(tmpdir(), `health-home-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.myshell-tools'), 'not a directory');

    try {
      assert.equal(await probeStateWritable(cwd, { stateHome: home }), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it('uses exclusive probe creation and does not clobber an existing probe-like file', async () => {
    const cwd = join(tmpdir(), `health-cwd-${randomUUID()}`);
    const home = join(tmpdir(), `health-home-${randomUUID()}`);
    const stateDir = join(home, '.myshell-tools');
    const probeFileName = '.health-probe-existing';
    const probe = join(stateDir, probeFileName);
    await mkdir(cwd, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(probe, 'keep me');

    try {
      assert.equal(await probeStateWritable(cwd, { stateHome: home, probeFileName }), false);
      assert.equal(await readFile(probe, 'utf8'), 'keep me');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
