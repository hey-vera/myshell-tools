/**
 * test/unit/ghost-text.test.ts — pure local-first ghost engine (P0.17–P0.18).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  applyGhost,
  GHOST_DEBOUNCE_MS,
  MODEL_GHOST_MAX_SUFFIX,
  MODEL_GHOST_MIN_PREFIX,
  parseModelGhostCompletion,
  proposeGhost,
  resolveGhostPrecedence,
  shouldOfferModelGhost,
} from '../../src/interface/ghost-text.ts';
import { goalHintsFromBoard } from '../../src/interface/ui/layout.ts';
import type { GoalBoardRow } from '../../src/interface/ui/state.ts';

function boardRow(over: Partial<GoalBoardRow> = {}): GoalBoardRow {
  return {
    id: over.id ?? 'goal_a',
    title: over.title ?? 'Redesign feed',
    state: over.state ?? 'parked',
    done: over.done ?? 0,
    total: over.total ?? 3,
    glyph: over.glyph ?? '◷',
    scope: over.scope ?? 'project',
    agents: over.agents ?? 0,
    ...(over.todos !== undefined ? { todos: over.todos } : {}),
  };
}

test('GHOST_DEBOUNCE_MS is 300', () => {
  assert.equal(GHOST_DEBOUNCE_MS, 300);
});

test('empty line with no goalHints → null', () => {
  assert.equal(proposeGhost({ line: '' }), null);
  assert.equal(proposeGhost({ line: '', goalHints: [] }), null);
  assert.equal(proposeGhost({ line: '', goalHints: ['  ', ''] }), null);
});

test('empty line prefers first non-empty goal hint', () => {
  const g = proposeGhost({
    line: '',
    goalHints: ['  ', 'continue active goal', 'start next todo'],
  });
  assert.ok(g);
  assert.equal(g.source, 'goal-hint');
  assert.equal(g.full, 'continue active goal');
  assert.equal(g.suffix, 'continue active goal');
});

// ---------------------------------------------------------------------------
// goalHintsFromBoard — live board → empty-prompt ghost inject (P0.17 wire)
// ---------------------------------------------------------------------------

test('goalHintsFromBoard: empty/null board → []', () => {
  assert.deepEqual(goalHintsFromBoard([]), []);
  assert.deepEqual(goalHintsFromBoard(undefined), []);
  assert.deepEqual(goalHintsFromBoard(null), []);
});

test('goalHintsFromBoard: prefers next-step todos; ordered running → queued → parked', () => {
  const hints = goalHintsFromBoard([
    boardRow({
      id: 'p',
      title: 'Parked goal',
      state: 'parked',
      todos: [{ id: 't1', text: 'parked next step', status: 'pending' }],
    }),
    boardRow({
      id: 'r',
      title: 'Running goal',
      state: 'running',
      todos: [
        { id: 't0', text: 'done item', status: 'done' },
        { id: 't1', text: 'active next step', status: 'active' },
      ],
    }),
    boardRow({
      id: 'q',
      title: 'Queued goal',
      state: 'queued',
      todos: [{ id: 't1', text: 'queued next step', status: 'pending' }],
    }),
  ]);
  assert.deepEqual(hints, ['active next step', 'queued next step', 'parked next step']);
});

test('goalHintsFromBoard: falls back to title when no todos; skips terminal states', () => {
  const hints = goalHintsFromBoard([
    boardRow({ id: 'd', title: 'Done goal', state: 'done' }),
    boardRow({ id: 'f', title: 'Failed goal', state: 'failed' }),
    boardRow({ id: 'p', title: 'Ship the ghost PR', state: 'parked' }),
    boardRow({
      id: 'b',
      title: 'Blocked',
      state: 'blocked',
      todos: [{ id: 't1', text: 'should not appear', status: 'active' }],
    }),
  ]);
  assert.deepEqual(hints, ['Ship the ghost PR']);
});

test('goalHintsFromBoard → proposeGhost empty-prompt end-to-end', () => {
  const hints = goalHintsFromBoard([
    boardRow({
      id: 'r',
      title: 'Wire goalHints',
      state: 'running',
      todos: [{ id: 't1', text: 'pass goalHints into InputBox', status: 'active' }],
    }),
  ]);
  const g = proposeGhost({ line: '', goalHints: hints });
  assert.ok(g);
  assert.equal(g.source, 'goal-hint');
  assert.equal(g.full, 'pass goalHints into InputBox');
});

test('history prefix match is most-recent-first', () => {
  const g = proposeGhost({
    line: 'fix the',
    history: ['fix the login flow', 'fix the chat composer', 'unrelated'],
  });
  assert.ok(g);
  assert.equal(g.source, 'history');
  assert.equal(g.full, 'fix the chat composer');
  assert.equal(g.suffix, ' chat composer');
});

test('history exact match (no extension) → null; longer recent wins', () => {
  assert.equal(proposeGhost({ line: 'hello', history: ['hello'] }), null);
  const g = proposeGhost({ line: 'hello', history: ['hello', 'hello world'] });
  assert.ok(g);
  assert.equal(g.full, 'hello world');
});

test('slash-name ghost extends typed prefix', () => {
  const g = proposeGhost({ line: '/hel' });
  assert.ok(g);
  assert.equal(g.source, 'slash');
  assert.equal(g.full, '/help');
  assert.equal(g.suffix, 'p');
});

test('slash-arg ghost extends mode tiers', () => {
  const g = proposeGhost({ line: '/mode Ba' });
  assert.ok(g);
  assert.equal(g.source, 'slash-arg');
  assert.equal(g.full, '/mode Balanced');
  assert.equal(g.suffix, 'lanced');
});

test('plain prose without history → null (no corruption)', () => {
  assert.equal(proposeGhost({ line: 'hello there' }), null);
});

test('recentCompletions cache used when history misses', () => {
  const g = proposeGhost({
    line: 'ship the',
    history: [],
    recentCompletions: ['ship the PR', 'other'],
  });
  assert.ok(g);
  assert.equal(g.source, 'cache');
  assert.equal(g.full, 'ship the PR');
});

test('completionHits path token extends line', () => {
  const g = proposeGhost({
    line: 'see src/int',
    completionHits: ['src/interface/', 'src/infra/'],
  });
  // Without path classification, completionHits are only consulted for non-none kinds.
  // 'see src/int' classifies as path (embedded slash).
  assert.ok(g);
  assert.equal(g.full, 'see src/interface/');
  assert.equal(g.suffix, 'erface/');
  assert.equal(g.source, 'path');
});

test('applyGhost replaces up-to-cursor and keeps tail', () => {
  const ghost = { full: 'hello world', suffix: ' world', source: 'history' as const };
  const r = applyGhost('helloXX', 5, ghost);
  assert.equal(r.value, 'hello worldXX');
  assert.equal(r.cursor, 'hello world'.length);
});

test('proposeGhost never throws on bad input', () => {
  assert.equal(proposeGhost({ line: null as unknown as string }), null);
  assert.equal(
    proposeGhost({
      line: 'x',
      history: [null as unknown as string, 1 as unknown as string, 'xy'],
    })?.full,
    'xy',
  );
});

test('free-text /goal arg is not slash-mangled; history can still complete', () => {
  assert.equal(proposeGhost({ line: '/goal fix' }), null);
  const g = proposeGhost({
    line: '/goal fix',
    history: ['/goal fix the flaky test'],
  });
  assert.ok(g);
  assert.equal(g.full, '/goal fix the flaky test');
});

// ---------------------------------------------------------------------------
// Optional model ghost (P1.5) — pure gate / parse / precedence
// ---------------------------------------------------------------------------

test('resolveGhostPrecedence: local always wins over model', () => {
  const local = { full: 'hello world', suffix: ' world', source: 'history' as const };
  const model = { full: 'hello there', suffix: ' there', source: 'model' as const };
  assert.equal(
    resolveGhostPrecedence({ local, model, modelEnabled: true })?.full,
    'hello world',
  );
  assert.equal(
    resolveGhostPrecedence({ local: null, model, modelEnabled: true })?.source,
    'model',
  );
  assert.equal(
    resolveGhostPrecedence({ local: null, model, modelEnabled: false }),
    null,
  );
  assert.equal(
    resolveGhostPrecedence({ local: null, model: null, modelEnabled: true }),
    null,
  );
});

test('shouldOfferModelGhost: default off; local miss + prose only', () => {
  assert.equal(
    shouldOfferModelGhost({ enabled: false, local: null, line: 'fix the' }),
    false,
  );
  assert.equal(
    shouldOfferModelGhost({
      enabled: true,
      local: { full: 'fix the migration', suffix: ' migration', source: 'history' },
      line: 'fix the',
    }),
    false,
  );
  assert.equal(
    shouldOfferModelGhost({ enabled: true, local: null, line: 'fix the', kind: 'none' }),
    true,
  );
  assert.equal(
    shouldOfferModelGhost({ enabled: true, local: null, line: '/he', kind: 'slash-name' }),
    false,
  );
  assert.equal(
    shouldOfferModelGhost({ enabled: true, local: null, line: 'a', kind: 'none' }),
    false,
    'below MODEL_GHOST_MIN_PREFIX',
  );
  assert.equal(MODEL_GHOST_MIN_PREFIX, 2);
  assert.equal(
    shouldOfferModelGhost({ enabled: true, local: null, line: '', kind: 'none' }),
    true,
    'empty buffer may ask model when goalHints also miss',
  );
});

test('parseModelGhostCompletion: suffix and full-line; fail-soft garbage', () => {
  const suffix = parseModelGhostCompletion('fix the', ' migration path');
  assert.ok(suffix);
  assert.equal(suffix.source, 'model');
  assert.equal(suffix.full, 'fix the migration path');
  assert.equal(suffix.suffix, ' migration path');

  const full = parseModelGhostCompletion('fix the', 'fix the release notes');
  assert.ok(full);
  assert.equal(full.full, 'fix the release notes');

  assert.equal(parseModelGhostCompletion('hello', undefined), null);
  assert.equal(parseModelGhostCompletion('hello', ''), null);
  // Bare word without leading space is still accepted as a pure suffix (model
  // sometimes omits the join space — Tab accept is user-gated).
  const glued = parseModelGhostCompletion('hello', 'goodbye');
  assert.ok(glued);
  assert.equal(glued.full, 'hellogoodbye');

  // Cap suffix length
  const long = 'x'.repeat(MODEL_GHOST_MAX_SUFFIX + 40);
  const capped = parseModelGhostCompletion('hi', long);
  assert.ok(capped);
  assert.equal(capped.suffix.length, MODEL_GHOST_MAX_SUFFIX);
});
