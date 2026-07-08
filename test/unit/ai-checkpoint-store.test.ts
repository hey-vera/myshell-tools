import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildAiCheckpoint } from '../../src/core/ai-checkpoint.ts';
import { createAiCheckpointStore, parseAiCheckpoint, capturePreEditSnapshot, createAiCheckpointCreator } from '../../src/infra/ai-checkpoint-store.ts';
import { resolveStateLayout } from '../../src/infra/state-layout.ts';

const execFileAsync = promisify(execFile);

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

  it('capturePreEditSnapshot returns contents of dirty files in a git repo', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-cp-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'myshell-cp-repo-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd });
      await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd });
      const f = join(cwd, 'dirty.txt');
      await writeFile(f, 'before-the-ai');
      await execFileAsync('git', ['add', 'dirty.txt'], { cwd });
      await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd });
      // make dirty then capture the pre-AI content
      await writeFile(f, 'pre-ai-dirty-content');
      const pre = await capturePreEditSnapshot(cwd);
      // now simulate AI edit
      await writeFile(f, 'after-the-ai-edit');
      assert.equal(pre.get('dirty.txt'), 'pre-ai-dirty-content');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('createAiCheckpointCreator builds+ saves checkpoint using pre snap + post reads + git fallback (smoke that creates one)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-cp-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'myshell-cp-repo-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd });
      await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd });
      await mkdir(join(cwd, 'src'), { recursive: true });
      const tracked = join(cwd, 'src', 'edit.ts');
      await writeFile(tracked, 'OLD\n');
      await execFileAsync('git', ['add', 'src/edit.ts'], { cwd });
      await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd });
      const pre = await capturePreEditSnapshot(cwd);
      const untrackedNew = join(cwd, 'created.txt');
      // simulate AI edit on tracked + create new (file did not exist pre)
      await writeFile(tracked, 'NEW\nedited by ai\n');
      await writeFile(untrackedNew, 'CREATED by ai');
      const layout = testLayout(home, cwd);
      const creator = createAiCheckpointCreator({ cwd, layout });
      const ts = '2026-07-07T12:00:00.000Z';
      await creator({ intent: 'smoke create checkpoint on edit', changedPaths: ['src/edit.ts', 'created.txt'], preSnapshot: pre, createdAt: ts });
      const store = createAiCheckpointStore({ cwd, layout });
      const saved = await store.latest();
      assert.ok(saved, 'checkpoint must have been saved');
      assert.equal(saved.intent, 'smoke create checkpoint on edit');
      const mod = saved.files.find((f: any) => f.path.endsWith('edit.ts')); // eslint-disable-line @typescript-eslint/no-explicit-any
      assert.ok(mod);
      assert.equal(mod.beforeText, 'OLD\n');
      assert.equal(mod.afterText, 'NEW\nedited by ai\n');
      const cre = saved.files.find((f: any) => f.path.endsWith('created.txt')); // eslint-disable-line @typescript-eslint/no-explicit-any
      assert.ok(cre);
      assert.ok(cre.beforeText == null, 'created file before must be absent/null');
      assert.equal(cre.afterText, 'CREATED by ai');
      // on-disk proof
      const onDiskLayout = testLayout(home, cwd);
      const projKey = cwd.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '--').replace(/^--+|--+$/g, '');
      const chkDir = join(onDiskLayout.stateRoot, 'projects', projKey, 'ai-checkpoints');
      const names = await readdir(chkDir).catch(() => [] as string[]);
      assert.ok(names.some((n) => n.endsWith('.json')), 'checkpoint json must exist on disk');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
