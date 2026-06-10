/**
 * test/unit/rules-store.test.ts — the STANDING-RULES I/O layer (Phase 4).
 * Run with: node --import ./test/register.mjs --test "test/unit/rules-store.test.ts"
 *
 * Hermetic: explicit `homeDir` (temp dir) + injected `Clock`, mirroring the
 * goal-store tests. Covers the CRUD round-trip (create/list/get/remove), atomic
 * 0o600 writes, corrupt-index recovery from the per-rule files, path-traversal
 * reject, the two-scope project key, and the newest-first ordering.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createFileRulesStore,
  deriveProjectKey,
  InvalidRuleIdError,
  type RulesStore,
} from '../../src/infra/rules-store.ts';
import type { Clock } from '../../src/core/types.ts';

function makeFakeClock(startIso = '2026-06-10T00:00:00.000Z'): Clock & { setIso(iso: string): void } {
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
let store: RulesStore;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'rules-store-'));
  clock = makeFakeClock();
  store = createFileRulesStore({ homeDir, clock });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('rules-store CRUD + persistence', () => {
  it('creates and lists a rule (round-trip)', async () => {
    const created = await store.create({
      kind: 'pause',
      trigger: { category: 'security' },
      text: 'pause before any security goal',
      scope: 'global',
    });
    assert.match(created.id, /^rule_[A-Za-z0-9]+$/);
    assert.equal(created.kind, 'pause');
    assert.equal(created.createdAt, '2026-06-10T00:00:00.000Z');

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.text, 'pause before any security goal');

    const got = await store.get(created.id);
    assert.deepEqual(got, created);
  });

  it('persists the full rule file at 0o600 and an index', async () => {
    const created = await store.create({
      kind: 'block',
      trigger: { pathGlob: 'package-lock.json' },
      text: 'never touch package-lock.json',
      scope: 'global',
    });
    const itemPath = join(homeDir, '.myshell-tools', 'rules', 'items', `${created.id}.json`);
    const st = await stat(itemPath);
    assert.equal(st.mode & 0o777, 0o600);
    const onDisk = JSON.parse(await readFile(itemPath, 'utf8'));
    assert.equal(onDisk.kind, 'block');
    assert.equal(onDisk.trigger.pathGlob, 'package-lock.json');
  });

  it('lists newest-first and filters by scope/projectKey', async () => {
    clock.setIso('2026-06-10T00:00:01.000Z');
    await store.create({ kind: 'prefer', trigger: { keyword: 'a' }, text: 'first', scope: 'global' });
    clock.setIso('2026-06-10T00:00:02.000Z');
    const projectKey = deriveProjectKey('/tmp/app');
    await store.create({ kind: 'prefer', trigger: { keyword: 'b' }, text: 'second', scope: 'project', projectKey });

    const all = await store.list();
    assert.equal(all[0]?.text, 'second'); // newest first

    const onlyProject = await store.list({ scope: 'project' });
    assert.equal(onlyProject.length, 1);
    assert.equal(onlyProject[0]?.projectKey, projectKey);

    const onlyGlobal = await store.list({ scope: 'global' });
    assert.equal(onlyGlobal.length, 1);
    assert.equal(onlyGlobal[0]?.text, 'first');
  });

  it('removes a rule (returns false on an unknown id)', async () => {
    const created = await store.create({ kind: 'pause', trigger: { keyword: 'x' }, text: 'x', scope: 'global' });
    assert.equal(await store.remove(created.id), true);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.remove(created.id), false);
  });

  it('rejects a path-traversal id (get/remove return null/false, never touch fs)', async () => {
    assert.equal(await store.get('../etc/passwd'), null);
    assert.equal(await store.remove('../../x'), false);
    assert.equal(await store.get('rule_ok_but_missing'), null);
  });

  it('the InvalidRuleIdError guard class exists for the internal path builder', () => {
    const err = new InvalidRuleIdError('../bad');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'InvalidRuleIdError');
    assert.ok(InvalidRuleIdError.prototype instanceof Error);
  });

  it('recovers a corrupt index from the per-rule files', async () => {
    const a = await store.create({ kind: 'pause', trigger: { keyword: 'a' }, text: 'alpha', scope: 'global' });
    const b = await store.create({ kind: 'block', trigger: { keyword: 'b' }, text: 'beta', scope: 'global' });
    // Corrupt the index cache; the per-rule files stay authoritative.
    const indexPath = join(homeDir, '.myshell-tools', 'rules', 'index.json');
    await writeFile(indexPath, '{ not valid json', 'utf8');

    const warnings: string[] = [];
    const recovering = createFileRulesStore({ homeDir, clock, onWarning: (m) => warnings.push(m) });
    const all = await recovering.list();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.text).sort(), ['alpha', 'beta']);
    assert.ok(warnings.some((w) => /Recovered rules index/.test(w)));
    // The corrupt index was preserved.
    const corruptPath = join(homeDir, '.myshell-tools', 'rules', 'index.json.corrupt');
    await stat(corruptPath); // throws if absent
    // ids survived the round-trip.
    assert.notEqual(await recovering.get(a.id), null);
    assert.notEqual(await recovering.get(b.id), null);
  });
});
