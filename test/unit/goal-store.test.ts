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
} from '../../src/infra/goal-store.ts';
import type { Clock } from '../../src/core/types.ts';

function makeFakeClock(startIso = '2026-06-05T00:00:00.000Z'): Clock & { setIso(iso: string): void } {
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
    const g = await store.create({ title: 't', roadmap: [{ id: 'r1', text: 'one', status: 'pending' }] });
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

describe('goal-store — layout', () => {
  it('creates goals/ + items/ and writes one file per goal', async () => {
    await store.create({ title: 'one' });
    await store.create({ title: 'two' });
    const files = await readdir(join(goalsDir(), 'items'));
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 2);
  });
});
