/**
 * R4.3 — Grok prompt-file safety: exclusive 0o600 create, cleanup, scavenge.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writePromptFile,
  removePromptFile,
  scavengeStaleGrokPromptFiles,
  GROK_PROMPT_DIR_PREFIX,
} from '../../src/providers/grok.ts';

describe('writePromptFile / removePromptFile', () => {
  it('writes content under a grok-prompt-* temp dir', async () => {
    const path = await writePromptFile('secret prompt body');
    try {
      assert.ok(path.includes(GROK_PROMPT_DIR_PREFIX), `path should include prefix: ${path}`);
      const st = await stat(path);
      assert.ok(st.isFile());
      // Content round-trip
      const { readFile } = await import('node:fs/promises');
      assert.equal(await readFile(path, 'utf8'), 'secret prompt body');
    } finally {
      await removePromptFile(path);
    }
  });

  it.skipIf(process.platform === 'win32')('creates the file with mode 0o600', async () => {
    const path = await writePromptFile('owner-only');
    try {
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
    } finally {
      await removePromptFile(path);
    }
  });

  it('removePromptFile deletes the file and parent grok-prompt dir', async () => {
    const path = await writePromptFile('to-delete');
    const parent = join(path, '..');
    await removePromptFile(path);
    await assert.rejects(() => stat(path));
    await assert.rejects(() => stat(parent));
  });
});

describe('scavengeStaleGrokPromptFiles', () => {
  it('removes only stale grok-prompt-* dirs; leaves fresh and unrelated entries', async () => {
    const base = await mkdtemp(join(tmpdir(), 'myshell-scavenge-test-'));
    try {
      const staleDir = join(base, `${GROK_PROMPT_DIR_PREFIX}stale`);
      const freshDir = join(base, `${GROK_PROMPT_DIR_PREFIX}fresh`);
      const otherDir = join(base, 'other-temp-dir');
      await mkdir(staleDir);
      await mkdir(freshDir);
      await mkdir(otherDir);
      await writeFile(join(staleDir, 'prompt.txt'), 'old', 'utf8');
      await writeFile(join(freshDir, 'prompt.txt'), 'new', 'utf8');
      await writeFile(join(otherDir, 'x.txt'), 'keep', 'utf8');

      // Backdate stale mtime by 2 hours.
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(staleDir, twoHoursAgo, twoHoursAgo);

      const removed = await scavengeStaleGrokPromptFiles({
        baseDir: base,
        maxAgeMs: 60 * 60 * 1000,
        nowMs: Date.now(),
      });
      assert.equal(removed, 1);

      const names = await readdir(base);
      assert.ok(!names.includes(`${GROK_PROMPT_DIR_PREFIX}stale`));
      assert.ok(names.includes(`${GROK_PROMPT_DIR_PREFIX}fresh`));
      assert.ok(names.includes('other-temp-dir'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('returns 0 and does not throw when baseDir is missing', async () => {
    const removed = await scavengeStaleGrokPromptFiles({
      baseDir: join(tmpdir(), `no-such-dir-${Date.now()}`),
    });
    assert.equal(removed, 0);
  });
});
