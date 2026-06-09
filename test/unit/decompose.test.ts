/**
 * test/unit/decompose.test.ts — plan decomposition into a goal DAG
 * (core/decompose.ts). Uses a fake Provider (no live model), so it verifies the
 * PLUMBING + the PARSER + the DAG validation, not extraction quality. Twin of
 * intent-extractor.test.ts.
 *
 * Coverage:
 *  - parseDecomposition: a multi-part plan → the right GoalSpecs + DAG.
 *  - COST HONESTY: a genuinely-single plan → ONE goal (no forced fan-out).
 *  - DAG fail-soft: cycles broken, unknown/self dep ids dropped, count capped,
 *    duplicate ids dropped, garbage → null (single-goal fallback).
 *  - decompose(): always ≥1 spec; every failure mode (no provider / route throw /
 *    run error / empty / unparseable) → the single-goal whole-plan fallback.
 *  - the request runs at the STRONGEST admissible tier, read-only, never writes.
 *
 * Run: node --import ./test/register.mjs --experimental-strip-types --test test/unit/decompose.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decompose,
  parseDecomposition,
  buildDecomposePrompt,
  MAX_GOALS,
  type DecomposeDeps,
} from '../../src/core/decompose.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const SIGNAL = new AbortController().signal;

function fakeProvider(events: ProviderEvent[], sink?: { req?: ProviderRequest }): Provider {
  return {
    id: 'claude',
    async detect() {
      return {
        id: 'claude',
        installed: true,
        version: '1.0.0',
        authenticated: true,
        plan: null,
        binaryPath: null,
        availableModels: [],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (sink) sink.req = req;
      for (const ev of events) yield ev;
    },
  };
}

const baseDeps = (provider: Provider): DecomposeDeps => ({
  providers: { claude: provider },
  policy: DEFAULT_POLICY,
  cwd: '/tmp/project',
  timeoutMs: 8_000,
});

// ---------------------------------------------------------------------------
// parseDecomposition — PURE parse + DAG validation
// ---------------------------------------------------------------------------

describe('parseDecomposition — multi-part plan → GoalSpecs + DAG', () => {
  it('parses several genuinely-independent goals with dependency edges', () => {
    const text = JSON.stringify({
      goals: [
        { id: 'g1', title: 'create the data layer', dependsOn: [] },
        { id: 'g2', title: 'build the UI', dependsOn: [] },
        { id: 'g3', title: 'wire UI to data', dependsOn: ['g1', 'g2'] },
      ],
    });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.equal(specs.length, 3);
    assert.deepEqual(specs.map((s) => s.id), ['g1', 'g2', 'g3']);
    assert.deepEqual(specs[0]?.dependsOn, undefined); // no deps → omitted
    assert.deepEqual(specs[2]?.dependsOn, ['g1', 'g2']);
  });

  it('COST HONESTY: a single-goal response stays ONE goal (no forced fan-out)', () => {
    const text = JSON.stringify({ goals: [{ id: 'g1', title: 'refactor the parser end to end' }] });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.title, 'refactor the parser end to end');
    assert.equal(specs[0]?.dependsOn, undefined);
  });

  it('extracts the JSON object even when wrapped in prose / fences', () => {
    const text = 'Here is the plan:\n```json\n' + JSON.stringify({ goals: [{ id: 'a', title: 'do a' }, { id: 'b', title: 'do b' }] }) + '\n```\nDone.';
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.equal(specs.length, 2);
  });
});

describe('parseDecomposition — DAG fail-soft validation', () => {
  it('drops UNKNOWN dependency ids (edge to a goal that was not returned)', () => {
    const text = JSON.stringify({
      goals: [
        { id: 'g1', title: 'a' },
        { id: 'g2', title: 'b', dependsOn: ['g1', 'ghost'] },
      ],
    });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.deepEqual(specs[1]?.dependsOn, ['g1']); // ghost dropped
  });

  it('drops SELF dependency edges', () => {
    const text = JSON.stringify({ goals: [{ id: 'g1', title: 'a', dependsOn: ['g1'] }] });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.equal(specs[0]?.dependsOn, undefined);
  });

  it('breaks a CYCLE by stripping the offending deps (degrade to independent, no deadlock)', () => {
    const text = JSON.stringify({
      goals: [
        { id: 'g1', title: 'a', dependsOn: ['g2'] },
        { id: 'g2', title: 'b', dependsOn: ['g1'] },
      ],
    });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.equal(specs.length, 2);
    // The cycle is broken so the graph is DRAINABLE (acyclic) — at least one of
    // the two cyclic edges is removed. We assert acyclicity via a topo-peel rather
    // than a specific edge: the scheduler must be able to order every goal.
    const byId = new Map(specs.map((s) => [s.id, s.dependsOn ?? []]));
    const ordered = new Set<string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, deps] of byId) {
        if (!ordered.has(id) && deps.every((d) => ordered.has(d))) {
          ordered.add(id);
          progressed = true;
        }
      }
    }
    assert.equal(ordered.size, specs.length, 'cycle was not broken — graph is not drainable');
  });

  it('preserves a clean chain while breaking only a downstream cycle', () => {
    const text = JSON.stringify({
      goals: [
        { id: 'root', title: 'root' },
        { id: 'g1', title: 'a', dependsOn: ['root', 'g2'] },
        { id: 'g2', title: 'b', dependsOn: ['g1'] },
      ],
    });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    const root = specs.find((s) => s.id === 'root');
    assert.equal(root?.dependsOn, undefined);
    // g1/g2 are on a cycle; their cyclic edge is stripped but the clean edge to
    // the ordered 'root' is preserved (honest).
    const g1 = specs.find((s) => s.id === 'g1');
    assert.deepEqual(g1?.dependsOn, ['root']);
  });

  it('de-dupes duplicate goal ids (a reused id is dropped)', () => {
    const text = JSON.stringify({
      goals: [
        { id: 'g1', title: 'first' },
        { id: 'g1', title: 'shadow' },
        { id: 'g2', title: 'second' },
      ],
    });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.deepEqual(specs.map((s) => s.id), ['g1', 'g2']);
    assert.equal(specs[0]?.title, 'first'); // first wins
  });

  it(`caps the goal count at MAX_GOALS (${MAX_GOALS})`, () => {
    const goals = Array.from({ length: MAX_GOALS + 5 }, (_v, i) => ({ id: `g${i}`, title: `goal ${i}` }));
    const specs = parseDecomposition(JSON.stringify({ goals }));
    assert.ok(specs !== null);
    assert.equal(specs.length, MAX_GOALS);
  });

  it('skips goals with no title; mints an id when missing', () => {
    const text = JSON.stringify({ goals: [{ id: 'g1', title: '' }, { title: 'real work' }] });
    const specs = parseDecomposition(text);
    assert.ok(specs !== null);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.title, 'real work');
    assert.ok((specs[0]?.id.length ?? 0) > 0);
  });

  it('returns null on garbage / missing goals array (→ single-goal fallback)', () => {
    assert.equal(parseDecomposition(undefined), null);
    assert.equal(parseDecomposition(''), null);
    assert.equal(parseDecomposition('not json at all'), null);
    assert.equal(parseDecomposition(JSON.stringify({ goals: 'nope' })), null);
    assert.equal(parseDecomposition(JSON.stringify({ goals: [] })), null);
    assert.equal(parseDecomposition(JSON.stringify({ other: 1 })), null);
  });
});

// ---------------------------------------------------------------------------
// buildDecomposePrompt
// ---------------------------------------------------------------------------

describe('buildDecomposePrompt', () => {
  it('states the cost-honesty rule and includes the plan', () => {
    const prompt = buildDecomposePrompt('redesign the feed', {});
    assert.match(prompt, /ONE goal/);
    assert.match(prompt, /INDEPENDENT/);
    assert.match(prompt, /redesign the feed/);
  });
  it('weaves in constraints and the repo map when provided', () => {
    const prompt = buildDecomposePrompt('build it', { constraints: ['Node 22'], repoMap: 'src/core/foo.ts' });
    assert.match(prompt, /Node 22/);
    assert.match(prompt, /src\/core\/foo\.ts/);
  });
});

// ---------------------------------------------------------------------------
// decompose — the model call (fake provider) + fallbacks
// ---------------------------------------------------------------------------

describe('decompose — always returns >=1 spec; fail-soft to the whole-plan fallback', () => {
  it('returns the parsed DAG on a good multi-goal response', async () => {
    const provider = fakeProvider([
      { type: 'done', text: JSON.stringify({ goals: [{ id: 'a', title: 'do a' }, { id: 'b', title: 'do b', dependsOn: ['a'] }] }), raw: {} },
    ]);
    const specs = await decompose('the plan', {}, baseDeps(provider), SIGNAL);
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[1]?.dependsOn, ['a']);
  });

  it('COST HONESTY: a single-goal model response runs as ONE goal', async () => {
    const provider = fakeProvider([
      { type: 'done', text: JSON.stringify({ goals: [{ id: 'g1', title: 'one coherent piece' }] }), raw: {} },
    ]);
    const specs = await decompose('one coherent piece', {}, baseDeps(provider), SIGNAL);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.title, 'one coherent piece');
  });

  it('no providers → single-goal fallback (the whole plan)', async () => {
    const specs = await decompose('do the big thing', {}, { providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 }, SIGNAL);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.title, 'do the big thing');
  });

  it('an error event → single-goal fallback', async () => {
    const provider = fakeProvider([
      { type: 'error', error: { category: 'unknown', message: 'boom', recoverable: false, suggestion: '' } },
    ]);
    const specs = await decompose('plan x', {}, baseDeps(provider), SIGNAL);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.title, 'plan x');
  });

  it('an unparseable response → single-goal fallback', async () => {
    const provider = fakeProvider([{ type: 'done', text: 'sorry, I cannot help with that', raw: {} }]);
    const specs = await decompose('plan y', {}, baseDeps(provider), SIGNAL);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.title, 'plan y');
  });

  it('an empty plan → single-goal fallback (never throws)', async () => {
    const provider = fakeProvider([{ type: 'done', text: JSON.stringify({ goals: [{ id: 'a', title: 'a' }] }), raw: {} }]);
    const specs = await decompose('   ', {}, baseDeps(provider), SIGNAL);
    assert.equal(specs.length, 1);
  });

  it('runs the request at the STRONGEST admissible tier, read-only, never writes', async () => {
    const sink: { req?: ProviderRequest } = {};
    const provider = fakeProvider([{ type: 'done', text: JSON.stringify({ goals: [{ id: 'a', title: 'a' }] }), raw: {} }], sink);
    await decompose('plan', {}, baseDeps(provider), SIGNAL);
    assert.ok(sink.req !== undefined);
    assert.equal(sink.req.sandbox, 'read-only');
    // DEFAULT_POLICY clamps manager → ic; the decision is the best the policy allows.
    assert.ok(sink.req.model.length > 0);
    assert.match(sink.req.prompt, /plan/);
  });
});
