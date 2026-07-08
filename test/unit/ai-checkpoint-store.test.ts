import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildAiCheckpoint } from '../../src/core/ai-checkpoint.ts';
import { createAiCheckpointStore, parseAiCheckpoint } from '../../src/infra/ai-checkpoint-store.ts';
import { resolveStateLayout } from '../../src/infra/state-layout.ts';

function testLayout(homeDir: string, cwd: string) {
  return resolveStateLayout({ env: {}, platform: process.platform, cwd, homeDir });
}

describe('ai checkpoint store', () => {
  it('saves, loads, lists, and returns the latest project-scoped checkpoint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-checkpoints-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'myshell-checkpoints-repo-'));
    try {
      const store = createAiCheckpointStore({ cwd, layout: testLayout(home, cwd) });
      const older = buildAiCheckpoint({
        id: 'older',
        createdAt: '2026-07-07T00:00:00.000Z',
        repoRoot: cwd,
        intent: 'first',
        files: [{ path: 'a.ts', beforeText: 'a', afterText: 'b' }],
      });
      const newer = buildAiCheckpoint({
        id: 'newer',
        createdAt: '2026-07-07T00:01:00.000Z',
        repoRoot: cwd,
        intent: 'second',
        files: [{ path: 'b.ts', beforeText: null, afterText: 'created' }],
      });

      await store.save(newer);
      await store.save(older);

      assert.deepEqual(await store.get('older'), older);
      assert.deepEqual((await store.list()).map((c) => c.id), ['older', 'newer']);
      assert.equal((await store.latest())?.id, 'newer');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sanitizes ids for path storage while preserving checkpoint id in content', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-checkpoints-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'myshell-checkpoints-repo-'));
    try {
      const store = createAiCheckpointStore({ cwd, layout: testLayout(home, cwd) });
      const checkpoint = buildAiCheckpoint({
        id: '../odd:id',
        createdAt: '2026-07-07T00:00:00.000Z',
        repoRoot: cwd,
        intent: 'safe id',
        files: [{ path: 'a.ts', beforeText: 'a', afterText: 'b' }],
      });
      await store.save(checkpoint);
      assert.equal((await store.latest())?.id, '../odd:id');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores malformed checkpoint files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-checkpoints-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'myshell-checkpoints-repo-'));
    try {
      const layout = testLayout(home, cwd);
      const store = createAiCheckpointStore({ cwd, layout });
      const good = buildAiCheckpoint({
        id: 'good',
        createdAt: '2026-07-07T00:00:00.000Z',
        repoRoot: cwd,
        intent: 'good',
        files: [{ path: 'a.ts', beforeText: 'a', afterText: 'b' }],
      });
      await store.save(good);
      const latest = await store.latest();
      assert.ok(latest !== null);
      const raw = await readFile(join(layout.stateRoot, 'projects'), 'utf8').catch(() => null);
      assert.equal(raw, null);
      const dir = join(layout.stateRoot, 'projects');
      // Place a malformed sibling through the public store path shape by using a bad id file in the same dir.
      const checkpointDir = join(dir, cwd.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '--').replace(/^--+|--+$/g, ''), 'ai-checkpoints');
      await writeFile(join(checkpointDir, 'bad.json'), '{ nope', 'utf8');
      assert.deepEqual((await store.list()).map((c) => c.id), ['good']);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('parseAiCheckpoint rejects invalid shapes', () => {
    assert.equal(parseAiCheckpoint(null), null);
    assert.equal(parseAiCheckpoint({ version: 2 }), null);
    assert.equal(parseAiCheckpoint({ version: 1, id: 'x', createdAt: 't', repoRoot: 'r', intent: '', files: [{ path: 'a' }] }), null);
  });
});
