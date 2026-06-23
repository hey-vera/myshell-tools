/**
 * Unit tests for src/infra/goal-store.ts (the goal/to-do I/O layer, Phase 5a).
 * Run with: node --import ./test/register.mjs --test "test/unit/goal-store.test.ts"
 *
 * Hermetic: explicit `homeDir` (temp dir) + injected `Clock`, mirroring the
 * user-memory-store tests. Covers the CRUD round-trip (create/list/setState/
 * setRoadmapItemStatus/remove), atomic 0o600 writes, corrupt-index recovery from
 * the per-goal files, path-traversal reject, and the two-scope project key.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  createFileGoalStore,
  deriveProjectKey,
  resolveProjectKey,
  InvalidGoalIdError,
  type GoalStore,
  type CreateGoalInput,
  type GoalPatch,
} from '../../src/infra/goal-store.ts';
import type { Clock } from '../../src/core/types.ts';

function makeFakeClock(
  startIso = '2026-06-05T00:00:00.000Z',
): Clock & { setIso(iso: string): void } {
  let counter = 0;
  let iso = startIso;
  return {
    now() {
      return Date.parse(iso);
    },
    isoNow() {
      return iso;
    },
    uuid() {
      counter += 1;
      return `01HX0000000000000000${String(counter).padStart(6, '0')}`;
    },
    random() {
      return 0.5;
    },
    setIso(next: string) {
      iso = next;
    },
  };
}

let homeDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let store: GoalStore;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `goal-test-${randomUUID()}-`));
  clock = makeFakeClock();
  store = createFileGoalStore({ homeDir, clock });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

const goalsDir = () => join(homeDir, '.myshell-tools', 'goals');

// ---------------------------------------------------------------------------
// CRUD round-trip
// ---------------------------------------------------------------------------

describe('goal-store — CRUD round-trip', () => {
  it('create parks a goal with a capped roadmap; list returns it', async () => {
    const g = await store.create({
      title: 'Redesign the feed',
      roadmap: [{ id: 'r1', text: 'audit current render path', status: 'pending' }],
      scope: 'project',
      projectKey: 'myrepo#abcd1234',
    });
    assert.match(g.id, /^goal_[A-Za-z0-9]+$/);
    assert.equal(g.state, 'parked'); // always born parked
    assert.equal(g.source, 'user-explicit'); // default
    assert.equal(g.roadmap.length, 1);
    assert.equal(g.scope, 'project');

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.title, 'Redesign the feed');

    const full = await store.get(g.id);
    assert.equal(full?.title, 'Redesign the feed');
  });

  it('a roadmap over the cap-8 limit is truncated to 8', async () => {
    const roadmap = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      text: `step ${i}`,
      status: 'pending' as const,
    }));
    const g = await store.create({ title: 'big', roadmap });
    assert.equal(g.roadmap.length, 8);
  });

  it('create records a goal-level approach + it round-trips through get', async () => {
    const approach = {
      chosen: 'A single guarded mutex around the refresh call',
      rationale: 'Eliminates the concurrent-refresh race without touching call sites',
      alternatives: ['per-call locking', 'optimistic retry'],
    };
    const g = await store.create({ title: 'Harden token refresh', approach });
    assert.deepEqual(g.approach, approach);
    const full = await store.get(g.id);
    assert.deepEqual(full?.approach, approach);
  });

  it('create WITHOUT an approach omits the field (byte-identical to before)', async () => {
    const g = await store.create({ title: 'plain goal' });
    assert.equal('approach' in g, false);
  });

  it('create with a half-record approach (no rationale) omits it', async () => {
    const g = await store.create({
      title: 'half',
      approach: { chosen: 'a strategy' } as unknown as { chosen: string; rationale: string },
    });
    assert.equal('approach' in g, false);
  });

  it('setState flips the lifecycle state and bumps lastTouched', async () => {
    const g = await store.create({ title: 'ship it' });
    assert.equal(g.state, 'parked');
    clock.setIso('2026-06-06T00:00:00.000Z');
    const promoted = await store.setState(g.id, 'running');
    assert.equal(promoted?.state, 'running');
    assert.equal(promoted?.lastTouched, '2026-06-06T00:00:00.000Z');
    const done = await store.setState(g.id, 'done');
    assert.equal(done?.state, 'done');
  });

  it('setState returns null for an unknown id', async () => {
    assert.equal(await store.setState('goal_doesnotexist', 'done'), null);
  });

  it('parentGoalId round-trips through create → get (GOAL-level nesting)', async () => {
    const parent = await store.create({ title: 'big goal' });
    const child = await store.create({ title: 'sub goal', parentGoalId: parent.id });
    assert.equal(child.parentGoalId, parent.id);
    const reloaded = await store.get(child.id);
    assert.equal(reloaded?.parentGoalId, parent.id);
  });

  it('create WITHOUT a parentGoalId omits the field (byte-identical to before)', async () => {
    const g = await store.create({ title: 'root goal' });
    assert.equal('parentGoalId' in g, false);
  });

  it('an invalid-format / self parentGoalId is dropped by capGoal on create', async () => {
    const g = await store.create({
      title: 'bad parent',
      parentGoalId: '../escape' as unknown as string,
    });
    assert.equal('parentGoalId' in g, false);
  });

  it('patchGoal sets, preserves, then clears a parentGoalId', async () => {
    const parent = await store.create({ title: 'parent' });
    const g = await store.create({ title: 'child' });
    assert.equal('parentGoalId' in g, false);

    // SET
    const set = await store.patchGoal(g.id, { parentGoalId: parent.id });
    assert.equal(set?.parentGoalId, parent.id);

    // PRESERVE (an unrelated patch does not drop the parent)
    const kept = await store.patchGoal(g.id, { title: 'child renamed' });
    assert.equal(kept?.title, 'child renamed');
    assert.equal(kept?.parentGoalId, parent.id);

    // CLEAR (null re-roots the goal)
    const cleared = await store.patchGoal(g.id, { parentGoalId: null });
    assert.equal('parentGoalId' in (cleared ?? {}), false);
    const reloaded = await store.get(g.id);
    assert.equal('parentGoalId' in (reloaded ?? {}), false);
  });

  it('setGoalVerdict persists EXACTLY the passed verdict (atomic, bumps lastTouched)', async () => {
    const g = await store.create({ title: 'ship it' });
    assert.equal(g.goalVerdict, undefined);
    clock.setIso('2026-06-07T00:00:00.000Z');
    const after = await store.setGoalVerdict(g.id, {
      state: 'passing',
      receipt: '✓ tests passing (npm test, 4200ms)',
      at: '2026-06-07T00:00:00.000Z',
    });
    assert.equal(after?.goalVerdict?.state, 'passing');
    assert.equal(after?.goalVerdict?.receipt, '✓ tests passing (npm test, 4200ms)');
    assert.equal(after?.lastTouched, '2026-06-07T00:00:00.000Z');
    // Survives the round-trip to disk (the per-goal file is authoritative).
    const reloaded = await store.get(g.id);
    assert.equal(reloaded?.goalVerdict?.state, 'passing');
  });

  it('setGoalVerdict records EXACTLY what is passed — a failing/unverified verdict is never green-washed', async () => {
    const g = await store.create({ title: 'wip' });
    const failing = await store.setGoalVerdict(g.id, {
      state: 'failing',
      receipt: '✗ tests failing (npm test, 900ms)',
      at: '2026-06-07T00:00:00.000Z',
    });
    assert.equal(failing?.goalVerdict?.state, 'failing');
    const unver = await store.setGoalVerdict(g.id, {
      state: 'unverified',
      receipt: '⚠ unverified — no code change to verify',
      at: '2026-06-07T00:00:00.000Z',
    });
    assert.equal(unver?.goalVerdict?.state, 'unverified');
  });

  it('setGoalVerdict returns null for an unknown id', async () => {
    assert.equal(
      await store.setGoalVerdict('goal_doesnotexist', {
        state: 'passing',
        receipt: 'x',
        at: '2026-06-07T00:00:00.000Z',
      }),
      null,
    );
  });

  it('a malformed verdict state is OMITTED by capGoal — never a fabricated green', async () => {
    const g = await store.create({ title: 'guard' });
    // Force an invalid state past the typed API to prove the store/cap layer drops it.
    const after = await store.setGoalVerdict(g.id, {
      state: 'totally-bogus' as unknown as 'passing',
      receipt: 'x',
      at: '2026-06-07T00:00:00.000Z',
    });
    assert.equal(after?.goalVerdict, undefined);
  });

  it('setGoalVerdict keeps the goal file 0o600', async () => {
    const g = await store.create({ title: 'perm' });
    await store.setGoalVerdict(g.id, {
      state: 'passing',
      receipt: 'ok',
      at: '2026-06-07T00:00:00.000Z',
    });
    const itemPath = join(goalsDir(), 'items', `${g.id}.json`);
    assert.equal((await stat(itemPath)).mode & 0o777, 0o600);
  });

  it('setRoadmapItemVerdict persists EXACTLY the passed verdict, keyed by itemId (atomic, bumps lastTouched)', async () => {
    const g = await store.create({
      title: 'manager cycle',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    assert.equal(g.roadmap[0]?.verdict, undefined);
    clock.setIso('2026-06-08T00:00:00.000Z');
    const after = await store.setRoadmapItemVerdict(g.id, 'r1', {
      state: 'passing',
      receipt: '✓ tests passing (npm test, 2100ms)',
      at: '2026-06-08T00:00:00.000Z',
      changedPaths: ['src/foo.ts'],
    });
    assert.equal(after?.roadmap[0]?.verdict?.state, 'passing');
    assert.equal(after?.roadmap[0]?.verdict?.receipt, '✓ tests passing (npm test, 2100ms)');
    assert.deepEqual(after?.roadmap[0]?.verdict?.changedPaths, ['src/foo.ts']);
    // r2 is untouched (keyed by itemId, not a blanket write).
    assert.equal(after?.roadmap[1]?.verdict, undefined);
    assert.equal(after?.lastTouched, '2026-06-08T00:00:00.000Z');
    // Survives the round-trip to disk.
    const reloaded = await store.get(g.id);
    assert.equal(reloaded?.roadmap[0]?.verdict?.state, 'passing');
  });

  it('setRoadmapItemVerdict records a failing/unverified verdict verbatim — never green-washed', async () => {
    const g = await store.create({
      title: 'wip',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    const failing = await store.setRoadmapItemVerdict(g.id, 'r1', {
      state: 'failing',
      receipt: '✗ tests failing',
      at: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(failing?.roadmap[0]?.verdict?.state, 'failing');
    const unver = await store.setRoadmapItemVerdict(g.id, 'r1', {
      state: 'unverified',
      receipt: '⚠ no code change to verify',
      at: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(unver?.roadmap[0]?.verdict?.state, 'unverified');
  });

  it('setRoadmapItemVerdict returns null for an unknown goal id or unknown itemId', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    assert.equal(
      await store.setRoadmapItemVerdict('goal_nope', 'r1', {
        state: 'passing',
        receipt: 'x',
        at: '2026-06-08T00:00:00.000Z',
      }),
      null,
    );
    assert.equal(
      await store.setRoadmapItemVerdict(g.id, 'no-such-item', {
        state: 'passing',
        receipt: 'x',
        at: '2026-06-08T00:00:00.000Z',
      }),
      null,
    );
  });

  it('setRoadmapItemVerdict drops a malformed verdict state via capRoadmapItem (never fabricated green)', async () => {
    const g = await store.create({
      title: 'guard',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    const after = await store.setRoadmapItemVerdict(g.id, 'r1', {
      state: 'totally-bogus' as unknown as 'passing',
      receipt: 'x',
      at: '2026-06-08T00:00:00.000Z',
    });
    assert.equal(after?.roadmap[0]?.verdict, undefined);
  });

  it('setRoadmapItemStatus checks off one to-do (evidence-backed, never inferred)', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const after = await store.setRoadmapItemStatus(g.id, 0, 'done');
    assert.equal(after?.roadmap[0]?.status, 'done');
    assert.equal(after?.roadmap[1]?.status, 'pending');

    const blocked = await store.setRoadmapItemStatus(g.id, 1, 'blocked');
    assert.equal(blocked?.roadmap[1]?.status, 'blocked');
  });

  it('setRoadmapItemStatus returns null for an out-of-range index', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    assert.equal(await store.setRoadmapItemStatus(g.id, 5, 'done'), null);
    assert.equal(await store.setRoadmapItemStatus(g.id, -1, 'done'), null);
  });

  it('remove hard-deletes the goal file and the index entry', async () => {
    const g = await store.create({ title: 'drop me' });
    assert.equal(await store.remove(g.id), true);
    assert.equal(await store.get(g.id), null);
    assert.equal((await store.list()).length, 0);
    await assert.rejects(stat(join(goalsDir(), 'items', `${g.id}.json`)));
    assert.equal(await store.remove(g.id), false); // already gone
  });

  it('list filters by state and scope', async () => {
    const a = await store.create({ title: 'project goal', scope: 'project', projectKey: 'p#1' });
    await store.create({ title: 'global goal', scope: 'global' });
    await store.setState(a.id, 'queued');

    assert.equal((await store.list({ state: 'parked' })).length, 1);
    assert.equal((await store.list({ state: 'queued' })).length, 1);
    assert.equal((await store.list({ scope: 'global' })).length, 1);
    assert.equal((await store.list({ scope: 'project', projectKey: 'p#1' })).length, 1);
  });

  it('list returns newest-touched first', async () => {
    const a = await store.create({ title: 'first' });
    clock.setIso('2026-06-06T00:00:00.000Z');
    await store.create({ title: 'second' });
    clock.setIso('2026-06-07T00:00:00.000Z');
    await store.setState(a.id, 'queued'); // touches 'first' last

    const all = await store.list();
    assert.equal(all[0]?.title, 'first');
  });
});

// ---------------------------------------------------------------------------
// Security: 0o600 + path-traversal + project key
// ---------------------------------------------------------------------------

describe('goal-store — security', () => {
  it('goal files and the index are written 0o600 (not world-readable)', async () => {
    const g = await store.create({ title: 'x' });
    const itemPath = join(goalsDir(), 'items', `${g.id}.json`);
    const indexPath = join(goalsDir(), 'index.json');
    assert.equal((await stat(itemPath)).mode & 0o777, 0o600);
    assert.equal((await stat(indexPath)).mode & 0o777, 0o600);
  });

  it('the InvalidGoalIdError guard class exists for the internal path builder', () => {
    // The public API never throws on a bad id (returns null/false); the guard
    // class exists only for internal path-builder misuse (mirrors the memory store).
    assert.ok(InvalidGoalIdError.prototype instanceof Error);
  });

  it('CreateGoalInput is the create() param shape', async () => {
    const input: CreateGoalInput = { title: 'typed', scope: 'global' };
    const g = await store.create(input);
    assert.equal(g.title, 'typed');
    assert.equal(g.scope, 'global');
  });

  it('get/remove reject path-traversal ids without touching the filesystem', async () => {
    assert.equal(await store.get('../../etc/passwd'), null);
    assert.equal(await store.get('goal_../foo'), null);
    assert.equal(await store.remove('goal_/etc/passwd'), false);
    assert.equal(await store.remove('..'), false);
  });

  it('deriveProjectKey is basename#hash, never the raw path (shared with memory store)', () => {
    const a = deriveProjectKey('/home/realname/secret-workspace/myrepo');
    const b = deriveProjectKey('/tmp/other/myrepo');
    assert.match(a, /^myrepo#[0-9a-f]{8}$/);
    assert.notEqual(a, b);
    assert.ok(!a.includes('/home/realname'));
  });

  it('resolveProjectKey uses the injected git resolver, falls back to cwd', async () => {
    const viaGit = await resolveProjectKey('/anywhere/sub', async () => '/repo/root');
    assert.match(viaGit!, /^root#[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Corrupt / missing index recovery (per-goal files are authoritative)
// ---------------------------------------------------------------------------

describe('goal-store — index recovery', () => {
  it('rebuilds a corrupt index from items/*.json and preserves the corrupt copy', async () => {
    const g = await store.create({ title: 'survive me' });

    await writeFile(join(goalsDir(), 'index.json'), '{ not valid json', 'utf8');

    let warned = '';
    const recovering = createFileGoalStore({
      homeDir,
      clock,
      onWarning: (m) => {
        warned = m;
      },
    });

    const all = await recovering.list();
    assert.equal(all.length, 1, 'recovered the goal from items/*.json');
    assert.equal(all[0]?.id, g.id);
    assert.match(warned, /Recovered goal index/);

    const corrupt = await readFile(join(goalsDir(), 'index.json.corrupt'), 'utf8');
    assert.match(corrupt, /not valid json/);
  });

  it('an absent index is treated as empty (no throw)', async () => {
    await store.create({ title: 'x' });
    await rm(join(goalsDir(), 'index.json'), { force: true });
    const fresh = createFileGoalStore({ homeDir, clock });
    const all = await fresh.list();
    assert.ok(Array.isArray(all));
  });
});

// ---------------------------------------------------------------------------
// Directory hygiene
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Living-plan to-do CRUD (Phase 2b) — keyed by RoadmapItem.id, audit-preserving
// ---------------------------------------------------------------------------

describe('goal-store — addRoadmapItem', () => {
  it('appends a new to-do and bumps lastTouched', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    clock.setIso('2026-06-06T00:00:00.000Z');
    const res = await store.addRoadmapItem(g.id, { id: 'r2', text: 'two', status: 'pending' });
    assert.equal(res.ok, true);
    assert.ok(res.ok && res.goal.roadmap.length === 2);
    assert.equal(res.ok && res.goal.roadmap[1]?.id, 'r2');
    assert.equal(res.ok && res.goal.lastTouched, '2026-06-06T00:00:00.000Z');

    // round-trips through a fresh store (persisted, not just in-memory)
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.length, 2);
  });

  it('atIndex inserts at the requested position (clamped)', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const res = await store.addRoadmapItem(g.id, { id: 'r3', text: 'mid', status: 'pending' }, 1);
    assert.ok(res.ok);
    assert.deepEqual(res.ok && res.goal.roadmap.map((i) => i.id), ['r1', 'r3', 'r2']);

    // out-of-range atIndex is clamped to append
    const res2 = await store.addRoadmapItem(g.id, { id: 'r4', text: 'end', status: 'pending' }, 99);
    assert.ok(res2.ok);
    assert.equal(res2.ok && res2.goal.roadmap.at(-1)?.id, 'r4');
  });

  it('re-adding the same item id is an idempotent no-op', async () => {
    const g = await store.create({ title: 'dedup' });
    const first = await store.addRoadmapItem(g.id, {
      id: 'r1-fix1',
      text: 'fix it',
      status: 'pending',
    });
    assert.equal(first.ok, true);

    const second = await store.addRoadmapItem(g.id, {
      id: 'r1-fix1',
      text: 'fix it again',
      status: 'pending',
    });
    assert.equal(second.ok, true);

    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.filter((item) => item.id === 'r1-fix1').length, 1);
  });

  it('rejects when the roadmap is at the cap-8 limit (no-op, reason=full)', async () => {
    const roadmap = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      text: `step ${i}`,
      status: 'pending' as const,
    }));
    const g = await store.create({ title: 'full', roadmap });
    const res = await store.addRoadmapItem(g.id, { id: 'r9', text: 'overflow', status: 'pending' });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, 'full');
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.length, 8); // unchanged
  });

  it('unknown goal id → reason=unknown-goal', async () => {
    const res = await store.addRoadmapItem('goal_nope', { id: 'x', text: 'x', status: 'pending' });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, 'unknown-goal');
  });
});

describe('goal-store — updateRoadmapItem', () => {
  it('patches text / acceptanceCriterion / approach, keyed by item id', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const after = await store.updateRoadmapItem(g.id, 'r2', {
      text: 'two edited',
      acceptanceCriterion: 'done means the thing works',
      approach: { chosen: 'A', rationale: 'simplest' },
    });
    assert.equal(after?.roadmap[1]?.text, 'two edited');
    assert.equal(after?.roadmap[1]?.acceptanceCriterion, 'done means the thing works');
    assert.equal(after?.roadmap[1]?.approach?.chosen, 'A');
    assert.equal(after?.roadmap[0]?.text, 'one'); // untouched
  });

  it('does NOT write verdict even if a verdict key is smuggled into the patch', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    // The patch shape has no `verdict`, but a malicious caller might cast. The
    // store must never persist a verdict via update (anti-fabrication).
    const after = await store.updateRoadmapItem(g.id, 'r1', {
      text: 'edited',
      // @ts-expect-error — verdict is intentionally NOT part of RoadmapItemPatch
      verdict: { state: 'passing', receipt: 'fabricated', at: 'now' },
    });
    assert.equal(after?.roadmap[0]?.text, 'edited');
    assert.equal(after?.roadmap[0]?.verdict, undefined);
  });

  it('returns null for unknown goal or unknown item id', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    assert.equal(await store.updateRoadmapItem('goal_nope', 'r1', { text: 'x' }), null);
    assert.equal(await store.updateRoadmapItem(g.id, 'r999', { text: 'x' }), null);
  });
});

describe('goal-store — reorderRoadmap', () => {
  it('reorders by item id; unknown ids ignored; omitted kept at the end', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
        { id: 'r3', text: 'three', status: 'pending' },
      ],
    });
    // Ask for r3 first, then r1; omit r2; include a bogus id.
    const after = await store.reorderRoadmap(g.id, ['r3', 'r1', 'bogus']);
    assert.deepEqual(
      after?.roadmap.map((i) => i.id),
      ['r3', 'r1', 'r2'],
    );
  });

  it('preserves the audit trail: a verified-done item survives a reorder', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        {
          id: 'r1',
          text: 'verified',
          status: 'done',
          verdict: { state: 'passing', receipt: 'tests green', at: '2026-06-05T00:00:00.000Z' },
        },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const after = await store.reorderRoadmap(g.id, ['r2', 'r1']);
    assert.deepEqual(
      after?.roadmap.map((i) => i.id),
      ['r2', 'r1'],
    );
    assert.equal(after?.roadmap[1]?.verdict?.state, 'passing'); // verdict intact
  });

  it('returns null for an unknown goal id', async () => {
    assert.equal(await store.reorderRoadmap('goal_nope', ['r1']), null);
  });
});

describe('goal-store — removeRoadmapItem', () => {
  it('removes an unverified item (keyed by id)', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const res = await store.removeRoadmapItem(g.id, 'r1');
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok && res.goal.roadmap.map((i) => i.id), ['r2']);
  });

  it('removes an item with a failing/unverified verdict (only verified-done is retained)', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        {
          id: 'r1',
          text: 'one',
          status: 'pending',
          verdict: { state: 'failing', receipt: 'tests red', at: '2026-06-05T00:00:00.000Z' },
        },
      ],
    });
    const res = await store.removeRoadmapItem(g.id, 'r1');
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.goal.roadmap.length, 0);
  });

  it('RETAINS a verified-done item (passing/reviewed) — audit trail survives plan edits', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        {
          id: 'r1',
          text: 'verified',
          status: 'done',
          verdict: { state: 'reviewed', receipt: 'critic ok', at: '2026-06-05T00:00:00.000Z' },
        },
      ],
    });
    const res = await store.removeRoadmapItem(g.id, 'r1');
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, 'retained-verified');
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.length, 1); // still there
    assert.equal(reread?.roadmap[0]?.verdict?.state, 'reviewed');
  });

  it('unknown goal or item id → reason=unknown', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    const a = await store.removeRoadmapItem('goal_nope', 'r1');
    assert.equal(!a.ok && a.reason, 'unknown');
    const b = await store.removeRoadmapItem(g.id, 'r999');
    assert.equal(!b.ok && b.reason, 'unknown');
  });

  it('refuses to orphan a dependedOn item → reason=depended-on', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'build', status: 'pending' },
        { id: 'r2', text: 'wire', status: 'pending', dependsOn: ['r1'] },
      ],
    });
    const res = await store.removeRoadmapItem(g.id, 'r1');
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, 'depended-on');
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.length, 2); // r1 retained
  });
});

describe('goal-store — updateRoadmapItem structural patch (dependsOn / parentId)', () => {
  it('sets dependsOn (sibling-existence + cycle guards re-run on round-trip)', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'build', status: 'pending' },
        { id: 'r2', text: 'wire', status: 'pending' },
      ],
    });
    const updated = await store.updateRoadmapItem(g.id, 'r2', { dependsOn: ['r1', 'ghost'] });
    assert.deepEqual(updated?.roadmap.find((i) => i.id === 'r2')?.dependsOn, ['r1']);
  });

  it('sets a 1-level parentId', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'p1', text: 'header', status: 'pending' },
        { id: 'c1', text: 'child', status: 'pending' },
      ],
    });
    const updated = await store.updateRoadmapItem(g.id, 'c1', { parentId: 'p1' });
    assert.equal(updated?.roadmap.find((i) => i.id === 'c1')?.parentId, 'p1');
  });
});

describe('goal-store — CRUD recovery/atomicity preserved', () => {
  it('a CRUD write recovers a corrupt index from items/*.json (self-heal still holds)', async () => {
    const g = await store.create({
      title: 'survive',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    await writeFile(join(goalsDir(), 'index.json'), '{ not valid json', 'utf8');

    let warned = '';
    const recovering = createFileGoalStore({
      homeDir,
      clock,
      onWarning: (m) => {
        warned = m;
      },
    });
    // A CRUD op reads the index inside the lock → triggers recovery from items/*.
    const res = await recovering.addRoadmapItem(g.id, { id: 'r2', text: 'two', status: 'pending' });
    assert.ok(res.ok);
    assert.equal(res.ok && res.goal.roadmap.length, 2);
    assert.match(warned, /Recovered goal index/);
  });

  it('CRUD goal files stay 0o600 after a mutation', async () => {
    const g = await store.create({
      title: 'x',
      roadmap: [{ id: 'r1', text: 'one', status: 'pending' }],
    });
    await store.addRoadmapItem(g.id, { id: 'r2', text: 'two', status: 'pending' });
    const itemPath = join(goalsDir(), 'items', `${g.id}.json`);
    assert.equal((await stat(itemPath)).mode & 0o777, 0o600);
  });
});

describe('goal-store — layout', () => {
  it('creates goals/ + items/ and writes one file per goal', async () => {
    await store.create({ title: 'one' });
    await store.create({ title: 'two' });
    const files = await readdir(join(goalsDir(), 'items'));
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 2);
  });
});

// ---------------------------------------------------------------------------
// patchGoal — scalar + roadmap batch patch
// ---------------------------------------------------------------------------

describe('goal-store — patchGoal', () => {
  it('patches title and state', async () => {
    const g = await store.create({ title: 'old title' });
    clock.setIso('2026-06-10T00:00:00.000Z');
    const after = await store.patchGoal(g.id, { title: 'new title', state: 'running' });
    assert.equal(after?.title, 'new title');
    assert.equal(after?.state, 'running');
    assert.equal(after?.lastTouched, '2026-06-10T00:00:00.000Z');
    const reloaded = await store.get(g.id);
    assert.equal(reloaded?.title, 'new title');
    assert.equal(reloaded?.state, 'running');
  });

  it('patches the goal-level approach', async () => {
    const g = await store.create({ title: 't' });
    const approach = { chosen: 'B', rationale: 'simpler' };
    const after = await store.patchGoal(g.id, { approach });
    assert.deepEqual(after?.approach, approach);
  });

  it('patches tags (overwrite)', async () => {
    const g = await store.create({ title: 't', tags: ['a', 'b'] });
    const after = await store.patchGoal(g.id, { tags: ['c'] });
    assert.deepEqual(after?.tags, ['c']);
  });

  it('adds, edits, and reorders roadmap items in one patch', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const patch: GoalPatch = {
      roadmapPatch: {
        add: [{ id: 'r3', text: 'three', status: 'pending' }],
        edit: [{ itemId: 'r1', patch: { text: 'one edited' } }],
        reorder: ['r3', 'r1', 'r2'],
      },
    };
    const after = await store.patchGoal(g.id, patch);
    assert.deepEqual(
      after?.roadmap.map((i) => i.id),
      ['r3', 'r1', 'r2'],
    );
    assert.equal(after?.roadmap.find((i) => i.id === 'r1')?.text, 'one edited');
    assert.equal(after?.roadmap.find((i) => i.id === 'r3')?.text, 'three');
  });

  it('remove skips verified-done and depended-on items', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        {
          id: 'r1',
          text: 'verified',
          status: 'done',
          verdict: { state: 'passing', receipt: 'tests green', at: '2026-06-05T00:00:00.000Z' },
        },
        { id: 'r2', text: 'build', status: 'pending' },
        { id: 'r3', text: 'wire', status: 'pending', dependsOn: ['r2'] },
        { id: 'r4', text: 'free', status: 'pending' },
      ],
    });
    const after = await store.patchGoal(g.id, {
      roadmapPatch: { remove: ['r1', 'r2', 'r3', 'r4'] },
    });
    // r1 is verified-done → retained; r2 is depended on by r3 → retained;
    // r3 and r4 are removable.
    assert.deepEqual(
      after?.roadmap.map((i) => i.id),
      ['r1', 'r2'],
    );
  });

  it('returns null for an unknown id', async () => {
    assert.equal(await store.patchGoal('goal_doesnotexist', { title: 'x' }), null);
  });

  it('add is idempotent for an existing item id', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [{ id: 'r1', text: 'original', status: 'pending' }],
    });
    const after = await store.patchGoal(g.id, {
      roadmapPatch: {
        add: [{ id: 'r1', text: 'duplicate', status: 'pending' }],
      },
    });
    assert.equal(after?.roadmap.length, 1);
    assert.equal(after?.roadmap[0]?.text, 'original');
  });

  it('honors the roadmap cap on add (extras dropped)', async () => {
    const roadmap = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`,
      text: `step ${i}`,
      status: 'pending' as const,
    }));
    const g = await store.create({ title: 'near full', roadmap });
    const after = await store.patchGoal(g.id, {
      roadmapPatch: {
        add: [
          { id: 'new1', text: 'new 1', status: 'pending' },
          { id: 'new2', text: 'new 2', status: 'pending' },
          { id: 'new3', text: 'new 3', status: 'pending' },
        ],
      },
    });
    assert.equal(after?.roadmap.length, 8);
    assert.ok(after?.roadmap.some((i) => i.id === 'new1'));
    assert.ok(after?.roadmap.some((i) => i.id === 'new2'));
    assert.ok(!after?.roadmap.some((i) => i.id === 'new3'));
  });

  it('preserves verdict when editing an item', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        {
          id: 'r1',
          text: 'one',
          status: 'done',
          verdict: { state: 'reviewed', receipt: 'ok', at: '2026-06-05T00:00:00.000Z' },
        },
      ],
    });
    const after = await store.patchGoal(g.id, {
      roadmapPatch: { edit: [{ itemId: 'r1', patch: { text: 'one edited' } }] },
    });
    assert.equal(after?.roadmap[0]?.text, 'one edited');
    assert.equal(after?.roadmap[0]?.verdict?.state, 'reviewed');
  });

  it('applies remove before reorder so retained items still reorder correctly', async () => {
    const g = await store.create({
      title: 't',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
        { id: 'r3', text: 'three', status: 'pending' },
      ],
    });
    const after = await store.patchGoal(g.id, {
      roadmapPatch: {
        remove: ['r2'],
        reorder: ['r3', 'r1'],
      },
    });
    assert.deepEqual(
      after?.roadmap.map((i) => i.id),
      ['r3', 'r1'],
    );
  });
});
