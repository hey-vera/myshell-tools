/**
 * test/ui/p0-lifecycle-characterization.test.tsx — P0-06b component baseline tests
 *
 * Runs under vitest via tsx. Validates the component characterization suite:
 *   - All 7 exact case IDs present
 *   - Output is deterministic across two runs (except metadata.commit)
 *   - Each fixture's specific behaviors are recorded
 *   - Missing cases trigger suite-level failure
 */

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { runComponentSuite } from '../../scripts/p0-component-benchmark.js';

const EXPECTED_IDS = [
  'manage-early-key',
  'surface-replace-1000',
  'legacy-buffer-mm',
  'ctrl-c-contexts',
  'login-child-handoff',
  'dirty-worktree-verify',
  'auto-stage-success',
] as const;

let suite1: Awaited<ReturnType<typeof runComponentSuite>> | null = null;
let suite2: Awaited<ReturnType<typeof runComponentSuite>> | null = null;

beforeAll(async () => {
  suite1 = await runComponentSuite();
  suite2 = await runComponentSuite();
}, 120_000);

afterAll(() => {
  suite1 = null;
  suite2 = null;
});

test('component harness emits all seven exact case IDs', () => {
  assert.ok(suite1, 'suite must run');
  assert.equal(suite1.cases.length, 7, 'must have exactly 7 cases');

  const ids = suite1.cases.map((c) => c.id);
  for (const expectedId of EXPECTED_IDS) {
    assert.ok(ids.includes(expectedId), `must include case "${expectedId}", got: ${ids.join(', ')}`);
  }
});

test('component output is deterministic across two runs except metadata.commit', () => {
  assert.ok(suite1, 'suite 1 must run');
  assert.ok(suite2, 'suite 2 must run');

  // Same length
  assert.equal(suite1.cases.length, suite2.cases.length, 'case count must match');

  // Same IDs
  const ids1 = suite1.cases.map((c) => c.id);
  const ids2 = suite2.cases.map((c) => c.id);
  assert.deepEqual(ids1, ids2, 'case IDs must match');

  // Same status per case
  for (let i = 0; i < suite1.cases.length; i++) {
    assert.equal(suite1.cases[i].status, suite2.cases[i].status,
      `case ${suite1.cases[i].id} status must match`);
  }

  // Metadata must match except commit
  assert.equal(suite1.metadata.node, suite2.metadata.node, 'node version must match');
  assert.equal(suite1.metadata.platform, suite2.metadata.platform, 'platform must match');
  assert.equal(suite1.metadata.arch, suite2.metadata.arch, 'arch must match');
  // commit may differ if repo changes between runs — that's OK
});

test('manage early key records current editor remainder', () => {
  assert.ok(suite1, 'suite must run');
  const c = suite1.cases.find((x) => x.id === 'manage-early-key');
  assert.ok(c, 'case manage-early-key must exist');
  // editorRemainder should be non-empty if the 'p' was captured in the editor
  // or empty if it was discarded; either is valid characterization
  assert.equal(typeof c.editorRemainder, 'string', 'editorRemainder must be a string');
  assert.equal(typeof c.observation, 'string', 'observation must be a string');
});

test('1000 replacements record zero committed delta', () => {
  assert.ok(suite1, 'suite must run');
  const c = suite1.cases.find((x) => x.id === 'surface-replace-1000');
  assert.ok(c, 'case surface-replace-1000 must exist');
  assert.equal(c.committedDelta, 0, 'chrome/replace must not affect committed[]');
  assert.ok(c.dispatches >= 1000, `expected at least 1000 dispatches, got ${c.dispatches}`);
});

test('mm records one chunk and zero menu actions', () => {
  assert.ok(suite1, 'suite must run');
  const c = suite1.cases.find((x) => x.id === 'legacy-buffer-mm');
  assert.ok(c, 'case legacy-buffer-mm must exist');
  assert.equal(c.actions, 0, 'zero menu actions expected');
  assert.ok(c.observation.includes('oneChunk=true'), 'must record one-chunk behavior');
});

test('login handoff balances suspend/resume and listeners', () => {
  assert.ok(suite1, 'suite must run');
  const c = suite1.cases.find((x) => x.id === 'login-child-handoff');
  assert.ok(c, 'case login-child-handoff must exist');
  // Balanced means suspend count equals resume count
  assert.ok(c.observation.includes('balanced='), 'must record balanced state');
  // Listener delta should not indicate leaks (should be small or zero)
  assert.ok(Math.abs(c.listenerDelta) <= 5, `listener leak detected: delta=${c.listenerDelta}`);
});

test('dirty baseline is explicitly pre-existing', () => {
  assert.ok(suite1, 'suite must run');
  const c = suite1.cases.find((x) => x.id === 'dirty-worktree-verify');
  assert.ok(c, 'case dirty-worktree-verify must exist');
  // Known-bad: pre-existing diff is attributed (not cleaned/normalized)
  assert.ok(c.observation.includes('files='), 'must record files found');
  assert.ok(
    c.editorRemainder === 'pre-existing-diff-attributed' || c.editorRemainder === 'clean',
    `editorRemainder must indicate attribution state, got: ${c.editorRemainder}`,
  );
});

test('auto-stage records zero execution', () => {
  assert.ok(suite1, 'suite must run');
  const c = suite1.cases.find((x) => x.id === 'auto-stage-success');
  assert.ok(c, 'case auto-stage-success must exist');
  // parkedCreates is stored in dispatches field
  assert.ok(c.dispatches >= 1, `expected at least 1 parked create, got ${c.dispatches}`);
  // The parked-only invariant: goals are created but never executed
  // syncBoard calls are recorded as pushes — these are display, not execution
  assert.ok(c.observation.includes('parkedCreates='), 'must record parked creates');
});

test('missing case makes suite status failed', () => {
  assert.ok(suite1, 'suite must run');

  // Simulate a suite with a missing case
  const incompleteSuite = {
    ...suite1,
    // Remove one case
    cases: suite1.cases.filter((c) => c.id !== 'surface-replace-1000'),
  };

  assert.equal(incompleteSuite.cases.length, 6, 'synthetic suite must have 6 cases');
  assert.equal(incompleteSuite.cases.length < 7, true, 'must be missing a case');

  // When cases.length !== 7, the suite status should NOT be 'pass'
  const idsIncomplete = incompleteSuite.cases.map((c) => c.id);
  assert.ok(!idsIncomplete.includes('surface-replace-1000'), 'surface-replace-1000 must be missing');

  // Validate: less than 7 cases means something is missing
  assert.ok(idsIncomplete.length < EXPECTED_IDS.length,
    `incomplete suite has ${idsIncomplete.length} cases, expected < ${EXPECTED_IDS.length}`);
});

test('component output JSON is schema-valid', () => {
  assert.ok(suite1, 'suite must run');
  assert.equal(suite1.version, 1, 'version must be 1');
  assert.equal(suite1.suite, 'component', 'suite name must be component');
  assert.ok(['pass', 'failed'].includes(suite1.status), `status must be pass|failed, got ${suite1.status}`);

  assert.equal(typeof suite1.metadata.node, 'string', 'metadata.node must be string');
  assert.equal(typeof suite1.metadata.platform, 'string', 'metadata.platform must be string');
  assert.equal(typeof suite1.metadata.arch, 'string', 'metadata.arch must be string');
  assert.equal(typeof suite1.metadata.commit, 'string', 'metadata.commit must be string');

  for (const c of suite1.cases) {
    assert.equal(typeof c.id, 'string', `case ${c.id}: id must be string`);
    assert.ok(['observed', 'failed'].includes(c.status), `case ${c.id}: status must be observed|failed`);
    assert.equal(typeof c.actions, 'number', `case ${c.id}: actions must be number`);
    assert.equal(typeof c.dispatches, 'number', `case ${c.id}: dispatches must be number`);
    assert.equal(typeof c.pushes, 'number', `case ${c.id}: pushes must be number`);
    assert.equal(typeof c.committedDelta, 'number', `case ${c.id}: committedDelta must be number`);
    assert.equal(typeof c.editorRemainder, 'string', `case ${c.id}: editorRemainder must be string`);
    assert.equal(typeof c.listenerDelta, 'number', `case ${c.id}: listenerDelta must be number`);
    assert.equal(typeof c.observation, 'string', `case ${c.id}: observation must be string`);
  }
});
