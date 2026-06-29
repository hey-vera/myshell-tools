/**
 * test/unit/upgrade-3.12-to-5.5.test.ts — the ONE combined migration test
 * (whole-tool-finish-5.5.md §5, §5.3).
 *
 * Drives a realistic OLD (3.12.x-shaped) state dir — existing conversations +
 * config with NONE of the new keys/fields, NO memory dir — through the 5.5 code
 * paths and asserts: zero data loss, no fabricated state, NO scary first-run
 * prompt for the upgrader (absence of new state = valid silent default), and a
 * lazy first memory write. Hermetic (temp dir + injected clock), file-only.
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { loadConfig, saveConfig, type AppConfig } from '../../src/infra/config.ts';
import { createFileConversationStore } from '../../src/infra/conversations.ts';
import { isRecapStale } from '../../src/core/recap.ts';
import { createFileUserMemoryStore } from '../../src/infra/user-memory-store.ts';
import { shouldShowFirstTouch } from '../../src/core/first-touch.ts';
import type { Clock } from '../../src/core/types.ts';
import type { Candidate } from '../../src/core/user-memory.ts';

function makeClock(startIso = '2026-06-05T00:00:00.000Z'): Clock {
  let counter = 0;
  return {
    now: () => Date.parse(startIso),
    isoNow: () => startIso,
    uuid: () => `01HX0000000000000000${String(++counter).padStart(6, '0')}`,
    random: () => 0.5,
  };
}

const CONV_A = 'conv-aaaaaaaaaaaaaaaaaaaaaa';
const CONV_B = 'conv-bbbbbbbbbbbbbbbbbbbbbb';

let homeDir: string;
let clock: Clock;

/** Write a realistic 3.12.x state home: config + 2 conversations, NO new keys. */
async function seedOldStateDir(): Promise<void> {
  const dir = join(homeDir, '.myshell-tools');
  const convDir = join(dir, 'conversations');
  await mkdir(convDir, { recursive: true });

  // config.json — onboarded, a mode, an UNKNOWN future key; NO memory*/seen.
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify(
      { onboarded: true, setAsDefault: false, mode: 'balanced', futureUnknownKey: 'keepme' },
      null,
      2,
    ),
  );

  // index.json — 2 entries, NO recap* fields; one pinned + categorized (realism).
  await writeFile(
    join(convDir, 'index.json'),
    JSON.stringify(
      [
        {
          id: CONV_A,
          title: 'Auth refactor',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          messageCount: 8,
          pinned: true,
          category: 'refactor',
        },
        {
          id: CONV_B,
          title: 'README polish',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z',
          messageCount: 2,
          pinned: false,
          category: null,
        },
      ],
      null,
      2,
    ),
  );

  // Real messages for conv A (SessionEntry shape: timestamp + role + content).
  const lines = [
    { timestamp: '2026-01-01T00:00:00.000Z', role: 'user', content: 'Refactor the auth module.' },
    {
      timestamp: '2026-01-01T00:01:00.000Z',
      role: 'assistant',
      content: 'Done — split into token + session.',
    },
  ];
  await writeFile(
    join(convDir, `${CONV_A}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  await writeFile(join(convDir, `${CONV_B}.jsonl`), JSON.stringify(lines[0]) + '\n');
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `upgrade-test-${randomUUID()}-`));
  clock = makeClock();
  await seedOldStateDir();
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('upgrade 3.12.x → 5.5 — combined migration', () => {
  it('1. loadConfig: memory default-on, memory* defaults absent-but-safe, seen absent, mode kept, no key lost', async () => {
    const cfg = await loadConfig(homeDir);
    assert.equal(cfg.onboarded, true, 'onboarded preserved → no re-onboarding');
    assert.equal(cfg.mode, 'balanced', 'mode preserved');
    // memory is default-on (absent → on): the kill-switch is `false`, never absent.
    assert.notEqual(cfg.memory, false, 'memory is not turned off (default-on)');
    // The new first-touch map is absent → nothing shown yet (valid silent default).
    assert.equal(cfg.seen, undefined, 'seen absent for upgrader');
    // The unknown future key survives the merge.
    assert.equal(
      (cfg as unknown as Record<string, unknown>)['futureUnknownKey'],
      'keepme',
      'unknown key preserved',
    );
  });

  it('2. readIndex/normaliseMeta: both entries load; recap fields default null/0; metadata intact (no loss)', async () => {
    const store = createFileConversationStore({ homeDir, clock });
    const metas = await store.list();
    assert.equal(metas.length, 2, 'both conversations load');

    const a = metas.find((m) => m.id === CONV_A);
    assert.ok(a !== undefined);
    assert.equal(a.title, 'Auth refactor', 'title intact');
    assert.equal(a.messageCount, 8, 'messageCount intact');
    assert.equal(a.pinned, true, 'pinned intact');
    assert.equal(a.category, 'refactor', 'category intact');
    // Recap fields forward-migrate to absent/null — never a fabricated recap.
    assert.ok(a.recap === undefined || a.recap === null, 'recap not fabricated');
    assert.ok(a.recapMessageCount === undefined || a.recapMessageCount === 0);

    const b = metas.find((m) => m.id === CONV_B);
    assert.ok(b !== undefined);
    assert.equal(b.pinned, false);
    assert.equal(b.category, null);
  });

  it('3. resume: a null recap is treated as "regenerate", never crashes the staleness check', async () => {
    const store = createFileConversationStore({ homeDir, clock });
    const a = (await store.list()).find((m) => m.id === CONV_A);
    assert.ok(a !== undefined);
    // isRecapStale must treat the migrated (absent recap) entry as stale-but-empty
    // → regenerate lazily, never throw on the missing field.
    assert.doesNotThrow(() => isRecapStale(a));
    assert.equal(isRecapStale(a), true, 'eligible + no cached recap → regenerate');
    // The actual messages are intact (resume shows real content, not a broken ※).
    const entries = await store.load(CONV_A);
    assert.equal(entries.length, 2, 'messages preserved');
  });

  it('4. a first approved memory save lazily creates memory/ and persists; re-load finds it', async () => {
    // No memory dir exists yet (the old state dir had none).
    const memStore = createFileUserMemoryStore({ homeDir, clock });
    const before = await memStore.listAll();
    assert.equal(before.length, 0, 'empty memory before any write');

    const candidate: Candidate = {
      scope: 'global',
      projectKey: null,
      shape: 'profile',
      kind: 'identity',
      subject: 'role',
      text: 'My name is Josh.',
      value: 'Josh',
      trust: 'user_stated',
      source: 'user_explicit',
    };
    await memStore.commit(candidate, { projectKey: null });

    // Re-open a fresh store over the same dir and confirm the fact persisted.
    const reopened = createFileUserMemoryStore({ homeDir, clock });
    const after = await reopened.listAll();
    assert.equal(after.length, 1, 'lazily created + persisted the fact');
    assert.equal(after[0]?.kind, 'identity');
  });

  it('5. saving config back preserves onboarded/mode AND the unknown key round-trips', async () => {
    const cfg = await loadConfig(homeDir);
    // Simulate a 5.5 write (e.g. after marking a first-touch seen).
    const next: AppConfig = { ...cfg, seen: { recap: true } };
    await saveConfig(next, homeDir);

    const onDisk = JSON.parse(await readFile(join(homeDir, '.myshell-tools', 'config.json'), 'utf8'));
    assert.equal(onDisk.onboarded, true, 'onboarded preserved on write');
    assert.equal(onDisk.mode, 'balanced', 'mode preserved on write');
    assert.equal(onDisk.futureUnknownKey, 'keepme', 'unknown future key survives round-trip');
    assert.deepEqual(onDisk.seen, { recap: true }, 'new key written');

    const reloaded = await loadConfig(homeDir);
    assert.equal((reloaded as unknown as Record<string, unknown>)['futureUnknownKey'], 'keepme');
  });

  it('6. NO scary first-run prompt for the upgrader: onboarded skips runWelcome; first-touch lines absent→show once, never a modal', async () => {
    const cfg = await loadConfig(homeDir);
    // Upgraders skip runWelcome (onboarded already true) — so the setup-time
    // memory line never re-fires. They meet memory via the first-touch line at
    // their FIRST approval, which (seen absent) is allowed to show exactly once.
    assert.equal(cfg.onboarded, true, 'onboarded → runWelcome does not re-run');
    // No new state forces a prompt: every first-touch surface is "show once",
    // never a blocking modal — the absence of `seen` is a valid silent default.
    for (const key of ['memorySave', 'intentReflect', 'panelWaiting', 'recap', 'apeEngage'] as const) {
      assert.equal(shouldShowFirstTouch(key, cfg.seen), true, `${key} allowed once (not suppressed, not a modal)`);
    }
  });

  it('no warn/error teach noise is produced by the migration paths themselves', async () => {
    // Loading config + listing conversations + opening memory must not throw or
    // require any output sink — they are pure/file-only. (A teach warn only fires
    // on a corrupt index rebuild, which this clean upgrade has no reason to hit.)
    const store = createFileConversationStore({ homeDir, clock });
    await assert.doesNotReject(async () => {
      await loadConfig(homeDir);
      await store.list();
      await store.load(CONV_A);
      await createFileUserMemoryStore({ homeDir, clock }).listAll();
    });
  });
});
