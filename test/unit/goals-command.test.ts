/**
 * test/unit/goals-command.test.ts — the goal/to-do command logic
 * (src/commands/goals.ts): pure arg parsing, the create/list/mark handlers over
 * an injected GoalStore, and the menu Parked-section render.
 *
 * Hermetic: a real file-backed GoalStore on a temp home + injected Clock (so the
 * store path is exercised end-to-end without a TTY). No model call.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  parseGoalsCommand,
  parseTodoCommand,
  renderParkedSection,
  runTodoCreate,
  runTodoAdd,
  runGoalsList,
  runGoalCancel,
  listParked,
  parkedAt,
  renderGoalExpanded,
} from '../../src/commands/goals.ts';
import { createFileGoalStore, type GoalStore } from '../../src/infra/goal-store.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { Clock } from '../../src/core/types.ts';
import type { Goal } from '../../src/core/goal-todo.ts';

function makeFakeClock(startIso = '2026-06-05T00:00:00.000Z'): Clock {
  let counter = 0;
  return {
    now: () => Date.parse(startIso),
    isoNow: () => startIso,
    uuid: () => `01HX${String(++counter).padStart(20, '0')}`,
    random: () => 0.5,
  };
}

function makeSink(): OutputSink & { buf: string } {
  let buf = '';
  return {
    get buf() {
      return buf;
    },
    write: (s: string) => {
      buf += s;
    },
    color: false,
    isTty: false,
  };
}

function makeGoalFixture(overrides: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Harden token refresh',
    state: 'parked',
    source: 'user-explicit',
    roadmap: [{ id: 'r1', text: 'add a refresh test', status: 'pending' }],
    scope: 'project',
    projectKey: 'repo#abcd1234',
    conversationId: null,
    createdAt: '2026-06-05T00:00:00.000Z',
    lastTouched: '2026-06-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderGoalExpanded — best-approach surfacing', () => {
  it('shows an "approach: <chosen>" line when the goal carries one', () => {
    const out = makeSink();
    renderGoalExpanded(
      makeGoalFixture({
        approach: { chosen: 'a single guarded mutex', rationale: 'race-free' },
      }),
      out,
    );
    assert.match(out.buf, /approach: a single guarded mutex/);
  });

  it('shows NO approach line when the goal has none', () => {
    const out = makeSink();
    renderGoalExpanded(makeGoalFixture(), out);
    assert.equal(/approach:/.test(out.buf), false);
  });
});

// ---------------------------------------------------------------------------
// Pure arg parsing
// ---------------------------------------------------------------------------

describe('parseGoalsCommand', () => {
  it('bare / "list" → list', () => {
    assert.equal(parseGoalsCommand('').kind, 'list');
    assert.equal(parseGoalsCommand('  list ').kind, 'list');
  });
  it('go/drop/cancel/park/show <n>', () => {
    assert.deepEqual(parseGoalsCommand('go 2'), { kind: 'go', n: 2 });
    assert.deepEqual(parseGoalsCommand('drop 1'), { kind: 'drop', n: 1 });
    assert.deepEqual(parseGoalsCommand('cancel 6'), { kind: 'cancel', n: 6 });
    assert.deepEqual(parseGoalsCommand('park 3'), { kind: 'park', n: 3 });
    assert.deepEqual(parseGoalsCommand('show 4'), { kind: 'show', n: 4 });
    assert.deepEqual(parseGoalsCommand('expand 5'), { kind: 'show', n: 5 });
    assert.deepEqual(parseGoalsCommand('7'), { kind: 'show', n: 7 });
  });
  it('garbage → usage', () => {
    assert.equal(parseGoalsCommand('go').kind, 'usage');
    assert.equal(parseGoalsCommand('frobnicate 2').kind, 'usage');
  });
});

describe('parseTodoCommand', () => {
  it('empty → usage', () => {
    assert.equal(parseTodoCommand('').kind, 'usage');
  });
  it('done/block <g> <n> → mark', () => {
    assert.deepEqual(parseTodoCommand('done 1 2'), { kind: 'mark', status: 'done', g: 1, n: 2 });
    assert.deepEqual(parseTodoCommand('block 2 1'), { kind: 'mark', status: 'blocked', g: 2, n: 1 });
    assert.deepEqual(parseTodoCommand('blocked 3 4'), { kind: 'mark', status: 'blocked', g: 3, n: 4 });
  });
  it('free text → create', () => {
    assert.deepEqual(parseTodoCommand('add rate limiting'), { kind: 'create', text: 'add rate limiting' });
  });
  it('add <g> <text> → add', () => {
    assert.deepEqual(parseTodoCommand('add 1 write the tests'), {
      kind: 'add',
      g: 1,
      text: 'write the tests',
    });
  });
  it('retired edit/move/rm subcommands → create (the partner maintains the plan itself)', () => {
    // The plan-restructuring commands were removed: the manager cycle's automatic
    // re-plan pass maintains the to-do list now. A leftover `edit`/`move`/`rm` line
    // is treated as free-text goal capture, never a plan edit — and never crashes.
    assert.deepEqual(parseTodoCommand('edit 1 2 new wording'), {
      kind: 'create',
      text: 'edit 1 2 new wording',
    });
    assert.deepEqual(parseTodoCommand('move 1 3 1'), { kind: 'create', text: 'move 1 3 1' });
    assert.deepEqual(parseTodoCommand('rm 2 1'), { kind: 'create', text: 'rm 2 1' });
  });
});

// ---------------------------------------------------------------------------
// renderParkedSection — only when non-empty
// ---------------------------------------------------------------------------

describe('renderParkedSection', () => {
  const goal = (overrides: Partial<Goal>): Goal => ({
    version: 1,
    id: 'goal_1',
    title: 'Redesign feed',
    state: 'parked',
    source: 'user-explicit',
    roadmap: [],
    scope: 'project',
    projectKey: 'repo#1',
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
    ...overrides,
  });

  it('returns [] when there are no parked goals (no clutter)', () => {
    assert.deepEqual(renderParkedSection([], '2026-06-05T00:00:00.000Z', false), []);
  });

  it('renders a header + one row per parked goal + the manage hint', () => {
    const lines = renderParkedSection([goal({})], '2026-06-05T00:00:00.000Z', false);
    assert.ok(lines.some((l) => /Goals · Parked \(1\)/.test(l)));
    assert.ok(lines.some((l) => /Redesign feed/.test(l)));
    assert.ok(lines.some((l) => /press g to manage goals/.test(l)));
  });
});

// ---------------------------------------------------------------------------
// Handlers over a real store
// ---------------------------------------------------------------------------

let homeDir: string;
let store: GoalStore;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `goals-cmd-${randomUUID()}-`));
  store = createFileGoalStore({ homeDir, clock: makeFakeClock() });
});
afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('runTodoCreate', () => {
  it('parks a goal whose title + first to-do come from the text (no model call)', async () => {
    const out = makeSink();
    const msg = await runTodoCreate({
      store,
      out,
      text: 'add rate limiting to the API',
      projectKey: 'repo#1',
      conversationId: 'conv-1',
    });
    assert.match(msg, /Parked goal: add rate limiting to the API \(0\/1 to-do\)/);

    const parked = await listParked(store);
    assert.equal(parked.length, 1);
    assert.equal(parked[0]?.state, 'parked');
    assert.equal(parked[0]?.roadmap.length, 1);
    assert.equal(parked[0]?.conversationId, 'conv-1');
  });

  it('empty text → usage, no goal created', async () => {
    const out = makeSink();
    const msg = await runTodoCreate({ store, out, text: '  ', projectKey: null, conversationId: null });
    assert.match(msg, /Usage/);
    assert.equal((await listParked(store)).length, 0);
  });
});

describe('runGoalsList', () => {
  it('shows an empty-state line when there are no goals', async () => {
    const out = makeSink();
    const msg = await runGoalsList({ store, out, nowIso: '2026-06-05T00:00:00.000Z', projectKey: null });
    assert.match(msg, /No goals yet/);
  });

  it('groups goals Active / Queued / Parked', async () => {
    const a = await store.create({ title: 'running one' });
    const b = await store.create({ title: 'queued one' });
    await store.create({ title: 'parked one' });
    await store.setState(a.id, 'running');
    await store.setState(b.id, 'queued');

    const out = makeSink();
    const text = await runGoalsList({ store, out, nowIso: '2026-06-05T00:00:00.000Z', projectKey: null });
    assert.match(text, /Active/);
    assert.match(text, /Queued/);
    assert.match(text, /Parked \(1\)/);
  });
});

describe('parkedAt', () => {
  it('resolves a 1-based index, null out of range', async () => {
    const g = await store.create({ title: 'x' });
    const parked = await listParked(store);
    assert.equal(parkedAt(parked, 1)?.id, g.id);
    assert.equal(parkedAt(parked, 2), null);
    assert.equal(parkedAt(parked, 0), null);
  });
});

describe('runGoalCancel', () => {
  it('reports every terminated id/title and preserves done descendants', async () => {
    const root = await store.create({ title: 'root' });
    const live = await store.create({ title: 'live child', parentGoalId: root.id });
    const done = await store.create({ title: 'done child', parentGoalId: root.id });
    await store.setState(live.id, 'running');
    await store.setState(done.id, 'done');
    const out = makeSink();

    const text = await runGoalCancel({ store, out, n: 1 });

    assert.match(text, new RegExp(`${root.id} — root`));
    assert.match(text, new RegExp(`${live.id} — live child`));
    assert.doesNotMatch(text, new RegExp(done.id));
    assert.equal((await store.get(root.id))?.state, 'failed');
    assert.equal((await store.get(live.id))?.state, 'failed');
    assert.equal((await store.get(done.id))?.state, 'done');
  });

  it('reports an unknown target without mutating goals', async () => {
    const goal = await store.create({ title: 'unchanged' });
    const before = await store.get(goal.id);
    const out = makeSink();

    const text = await runGoalCancel({ store, out, n: 9 });

    assert.match(text, /No parked goal #9/);
    assert.deepEqual(await store.get(goal.id), before);
  });
});


describe('runTodoAdd', () => {
  it('appends a new to-do to an existing parked goal', async () => {
    const g = await store.create({
      title: 'goal',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    const out = makeSink();
    const msg = await runTodoAdd({ store, out, g: 1, text: 'second thing' });
    assert.match(msg, /Added a to-do/);
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.length, 2);
    assert.equal(reread?.roadmap[1]?.text, 'second thing');
    assert.equal(reread?.roadmap[1]?.id, 'r2'); // collision-free fresh id
  });

  it('reports the cap-8 nudge when the goal is full', async () => {
    const roadmap = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      text: `s${i}`,
      status: 'pending' as const,
    }));
    await store.create({ title: 'full goal', roadmap });
    const out = makeSink();
    const msg = await runTodoAdd({ store, out, g: 1, text: 'overflow' });
    assert.match(msg, /already has 8 to-dos/);
  });

  it('bad goal index → clear error', async () => {
    const out = makeSink();
    const msg = await runTodoAdd({ store, out, g: 9, text: 'x' });
    assert.match(msg, /No parked goal #9/);
  });
});
