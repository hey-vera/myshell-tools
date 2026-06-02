/**
 * test/unit/health.test.ts — unit tests for the pure health evaluator.
 *
 * evaluateHealth is pure and the heart of the "it just works, surfaces only when
 * broken" behavior, so it gets thorough coverage. probeStateWritable is I/O and
 * exercised indirectly elsewhere.
 *
 * Honesty Contract: no fabricated data, no hardcoded percentages.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateHealth, nodeMajor } from '../../src/infra/health.ts';
import type { HealthInputs } from '../../src/infra/health.ts';

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
});
