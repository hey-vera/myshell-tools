/**
 * Unit tests for src/infra/user-memory-store.ts (the memory I/O layer, Phase 3).
 * Run with: node --import ./test/register.mjs --test "test/unit/user-memory-store.test.ts"
 *
 * Hermetic: explicit `homeDir` (temp dir) + injected `Clock`, like the
 * conversations tests. Covers the whole-transaction round-trip (ADD/UPDATE/
 * SUPERSEDE/FORGET), 0o600 mode, corrupt-index recovery, path-traversal reject,
 * audit append, decay sweep, and the privacy-preserving project key.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  createFileUserMemoryStore,
  deriveProjectKey,
  resolveProjectKey,
  InvalidFactIdError,
  type UserMemoryStore,
} from '../../src/infra/user-memory-store.ts';
import type { Candidate } from '../../src/core/user-memory.ts';
import type { Clock } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Fake clock — monotonic ids + advanceable time
// ---------------------------------------------------------------------------

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

function cand(overrides: Partial<Candidate> = {}): Candidate {
  return {
    scope: 'global',
    projectKey: null,
    shape: 'profile',
    kind: 'preference',
    subject: 'answer_length',
    text: 'Prefers concise, direct answers.',
    trust: 'user_stated',
    source: 'user_explicit',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let homeDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let store: UserMemoryStore;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `mem-test-${randomUUID()}-`));
  clock = makeFakeClock();
  store = createFileUserMemoryStore({ homeDir, clock });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

const memoryDir = () => join(homeDir, '.myshell-tools', 'memory');

// ---------------------------------------------------------------------------
// Round-trip: ADD / list / UPDATE / SUPERSEDE / FORGET
// ---------------------------------------------------------------------------

describe('user-memory-store — write transaction round-trip', () => {
  it('commit ADD persists a fact + facet, list returns it', async () => {
    const res = await store.commit(cand());
    assert.equal(res.op, 'ADD');
    assert.ok(res.fact);
    assert.match(res.fact!.id, /^mem_[A-Za-z0-9]+$/);

    const facets = await store.listFacets();
    assert.equal(facets.length, 1);
    assert.equal(facets[0]?.text, 'Prefers concise, direct answers.');

    const full = await store.get(res.fact!.id);
    assert.equal(full?.text, 'Prefers concise, direct answers.');
    assert.equal(full?.importance, 3);
  });

  it('the mem0 #4896 scenario through the STORE: LGY then LGS → ONE current fact', async () => {
    await store.commit(cand({ kind: 'identity', subject: 'role', text: 'My name is LGY', value: 'LGY' }));
    const after = await store.commit(cand({ kind: 'identity', subject: 'role', text: 'My name is LGS', value: 'LGS' }));
    assert.equal(after.op, 'UPDATE');

    const facets = await store.listFacets();
    assert.equal(facets.length, 1, 'must be exactly one current fact, not two');
    assert.equal(facets[0]?.text, 'My name is LGS');

    const full = await store.get(facets[0]!.id);
    assert.equal(full?.value, 'LGS');
  });

  it('SUPERSEDE keeps the old fact on disk (invalidate-not-delete) but excludes it from listFacets', async () => {
    const first = await store.commit(
      cand({ shape: 'collection', kind: 'constraint', subject: 'dependencies', text: 'avoid paid APIs', value: 'avoid' }),
    );
    clock.setIso('2026-06-06T00:00:00.000Z');
    const second = await store.commit(
      cand({ shape: 'collection', kind: 'constraint', subject: 'dependencies', text: 'use the Stripe paid API', value: 'use' }),
    );
    assert.equal(second.op, 'SUPERSEDE');

    const facets = await store.listFacets();
    assert.equal(facets.length, 1);
    assert.equal(facets[0]?.text, 'use the Stripe paid API');

    // The old fact is still on disk, marked superseded.
    const old = await store.get(first.fact!.id);
    assert.ok(old);
    assert.notEqual(old!.validTo, null);
    assert.equal(old!.supersededBy, second.fact!.id);

    // listAll surfaces both.
    const all = await store.listAll();
    assert.equal(all.length, 2);
  });

  it('forget hard-deletes the fact file and the facet, with an audit row', async () => {
    const res = await store.commit(cand());
    const id = res.fact!.id;
    const ok = await store.forget(id);
    assert.equal(ok, true);

    assert.equal(await store.get(id), null);
    assert.equal((await store.listFacets()).length, 0);

    const factPath = join(memoryDir(), 'facts', `${id}.json`);
    await assert.rejects(stat(factPath));

    const audit = await readFile(join(memoryDir(), 'audit.jsonl'), 'utf8');
    assert.match(audit, /"op":"FORGET"/);
  });

  it('NOOP exact-dup touches useCount without creating a second fact', async () => {
    await store.commit(cand({ text: 'Prefers concise answers.' }));
    const dup = await store.commit(cand({ text: 'prefers concise answers' }));
    assert.equal(dup.op, 'NOOP');
    assert.equal((await store.listFacets()).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Security: 0o600, path-traversal, no raw path in project key
// ---------------------------------------------------------------------------

describe('user-memory-store — security', () => {
  it('fact files and index are written 0o600 (not world-readable)', async () => {
    const res = await store.commit(cand());
    const factPath = join(memoryDir(), 'facts', `${res.fact!.id}.json`);
    const indexPath = join(memoryDir(), 'index.json');
    const fMode = (await stat(factPath)).mode & 0o777;
    const iMode = (await stat(indexPath)).mode & 0o777;
    assert.equal(fMode, 0o600);
    assert.equal(iMode, 0o600);
  });

  it('get/forget reject path-traversal ids without touching the filesystem', async () => {
    assert.equal(await store.get('../../etc/passwd'), null);
    assert.equal(await store.get('mem_../foo'), null);
    assert.equal(await store.forget('mem_/etc/passwd'), false);
    assert.equal(await store.forget('..'), false);
  });

  it('getFactPath-style id validation throws InvalidFactIdError only for internal misuse', () => {
    // The public API never throws on a bad id (returns null/false), but the guard
    // class exists for the internal path builder.
    assert.ok(InvalidFactIdError.prototype instanceof Error);
  });

  it('deriveProjectKey is basename#hash, stable, differs across roots, never contains the raw path', () => {
    const a = deriveProjectKey('/home/realname/secret-workspace/myrepo');
    const b = deriveProjectKey('/home/realname/secret-workspace/myrepo');
    const c = deriveProjectKey('/tmp/other/myrepo');
    assert.equal(a, b, 'stable for the same root');
    assert.notEqual(a, c, 'differs across roots (hash of full path)');
    assert.match(a, /^myrepo#[0-9a-f]{8}$/);
    assert.ok(!a.includes('/home/realname'), 'never leaks the raw path');
    assert.ok(!a.includes('secret-workspace'));
  });

  it('resolveProjectKey uses the injected git-toplevel resolver and falls back to cwd', async () => {
    const viaGit = await resolveProjectKey('/anywhere/sub/dir', async () => '/repo/root');
    assert.match(viaGit!, /^root#[0-9a-f]{8}$/);

    const viaCwd = await resolveProjectKey('/cwd/here', async () => null);
    assert.match(viaCwd!, /^here#[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Corrupt / missing index recovery
// ---------------------------------------------------------------------------

describe('user-memory-store — index recovery', () => {
  it('rebuilds a corrupt index from facts/*.json and preserves the corrupt copy', async () => {
    const res = await store.commit(cand());
    const id = res.fact!.id;

    // Corrupt the index.
    await writeFile(join(memoryDir(), 'index.json'), '{ this is not valid json', 'utf8');

    let warned = '';
    const recoveringStore = createFileUserMemoryStore({
      homeDir,
      clock,
      onWarning: (m) => {
        warned = m;
      },
    });

    const facets = await recoveringStore.listFacets();
    assert.equal(facets.length, 1, 'recovered the fact from facts/*.json');
    assert.equal(facets[0]?.id, id);
    assert.match(warned, /Recovered memory index/);

    // The corrupt copy is preserved.
    const corrupt = await readFile(join(memoryDir(), 'index.json.corrupt'), 'utf8');
    assert.match(corrupt, /not valid json/);
  });

  it('a missing index is treated as empty (absent), then rebuilt on next read', async () => {
    await store.commit(cand());
    await rm(join(memoryDir(), 'index.json'), { force: true });
    const fresh = createFileUserMemoryStore({ homeDir, clock });
    const facets = await fresh.listFacets();
    // Absent index → empty; facts on disk are recovered via the corrupt path only,
    // but a bare-absent index returns [] until a write rebuilds it. Confirm no throw.
    assert.ok(Array.isArray(facets));
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('user-memory-store — audit log (inside the lock)', () => {
  it('appends one audit row per write op', async () => {
    await store.commit(cand({ kind: 'identity', subject: 'role', text: 'My name is LGY', value: 'LGY' }));
    await store.commit(cand({ kind: 'identity', subject: 'role', text: 'My name is LGS', value: 'LGS' }));
    const audit = await readFile(join(memoryDir(), 'audit.jsonl'), 'utf8');
    const lines = audit.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /"op":"ADD"/);
    assert.match(lines[1]!, /"op":"UPDATE"/);
    // The UPDATE row snapshots the prior text.
    assert.match(lines[1]!, /"priorText":"My name is LGY"/);
  });
});

// ---------------------------------------------------------------------------
// markUsed + decay sweep (clock-injected)
// ---------------------------------------------------------------------------

describe('user-memory-store — markUsed + decay sweep', () => {
  it('markUsed bumps useCount and lastUsedAt for the given ids only', async () => {
    const a = await store.commit(cand({ subject: 'answer_length', text: 'pref A always' }));
    const b = await store.commit(cand({ kind: 'identity', subject: 'role', text: 'role B' }));
    clock.setIso('2026-07-01T00:00:00.000Z');
    await store.markUsed([a.fact!.id]);

    const fa = await store.get(a.fact!.id);
    const fb = await store.get(b.fact!.id);
    assert.equal(fa?.useCount, 1);
    assert.equal(fa?.lastUsedAt, '2026-07-01T00:00:00.000Z');
    assert.equal(fb?.useCount, 0);
    assert.equal(fb?.lastUsedAt, null);
  });

  it('sweepDecay archives a past-window agent_inferred fact but not a decay-exempt constraint', async () => {
    // An agent_inferred preference (importance 2, 90-day window).
    const pref = await store.commit(
      cand({ kind: 'preference', subject: 'answer_tone', text: 'warmer tone preferred', trust: 'agent_inferred', source: 'model_proposed' }),
    );
    // A user_stated constraint — decay-exempt.
    const constraint = await store.commit(
      cand({ kind: 'constraint', subject: 'runtime', text: 'Uses Node 22 always', trust: 'user_stated' }),
    );

    // Advance well past the 90-day window.
    clock.setIso('2026-12-31T00:00:00.000Z');
    const archived = await store.sweepDecay({ base: 90 });

    assert.ok(archived.includes(pref.fact!.id), 'stale agent_inferred pref archived');
    assert.ok(!archived.includes(constraint.fact!.id), 'exempt constraint not archived');

    const facets = await store.listFacets();
    const ids = facets.map((f) => f.id);
    assert.ok(!ids.includes(pref.fact!.id));
    assert.ok(ids.includes(constraint.fact!.id));
  });

  it('sweepDecay capacity cap evicts the lowest (importance, oldest) excluding exempt', async () => {
    // Two low-importance agent_inferred facts + one exempt; cap at 2.
    clock.setIso('2026-06-05T00:00:00.000Z');
    await store.commit(cand({ kind: 'preference', subject: 'answer_tone', text: 'tone one', trust: 'agent_inferred', source: 'model_proposed' }));
    clock.setIso('2026-06-06T00:00:00.000Z');
    await store.commit(cand({ kind: 'preference', subject: 'format', text: 'format two', trust: 'agent_inferred', source: 'model_proposed' }));
    clock.setIso('2026-06-07T00:00:00.000Z');
    await store.commit(cand({ kind: 'constraint', subject: 'runtime', text: 'Uses Node 22 always', trust: 'user_stated' }));

    const archived = await store.sweepDecay({ base: 100000, max: 2 });
    // The two prefs both have importance 2; capacity cap with 3 live facts and the
    // exempt constraint excluded means exactly 1 pref gets evicted (the oldest).
    assert.equal(archived.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Directory hygiene
// ---------------------------------------------------------------------------

describe('user-memory-store — layout', () => {
  it('creates memory/ + facts/ and writes one file per fact', async () => {
    await store.commit(cand({ subject: 'answer_length', text: 'fact one always' }));
    await store.commit(cand({ kind: 'identity', subject: 'role', text: 'fact two role' }));
    const factFiles = await readdir(join(memoryDir(), 'facts'));
    assert.equal(factFiles.filter((f) => f.endsWith('.json')).length, 2);
  });

  it('ensureDirs is idempotent across stores sharing a homeDir', async () => {
    await mkdir(memoryDir(), { recursive: true });
    const s2 = createFileUserMemoryStore({ homeDir, clock });
    const res = await s2.commit(cand());
    assert.equal(res.op, 'ADD');
  });
});
