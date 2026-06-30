import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { readRepoFingerprint, nodeRepoScanPort } from '../../src/infra/repo-scan.ts';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `repo-scan-test-${randomUUID()}-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' });
}

describe('readRepoFingerprint', () => {
  it('returns a non-empty HEAD sha and status tree hash for a git repo', async () => {
    await withTempDir(async (dir) => {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      await writeFile(join(dir, 'README.md'), '# repo\n', 'utf8');
      git(dir, ['add', 'README.md']);
      git(dir, ['commit', '-m', 'initial']);

      const fp = await readRepoFingerprint(dir);

      assert.match(fp.headSha, /^[0-9a-f]{40}$/);
      assert.match(fp.treeHash, /^[0-9a-f]{64}$/);
    });
  });

  it('fails soft to an empty fingerprint outside a git repo', async () => {
    await withTempDir(async (dir) => {
      assert.deepEqual(await readRepoFingerprint(dir), { headSha: '', treeHash: '' });
    });
  });

  it('is surfaced on nodeRepoScanPort (DI seam) and changes when the tree changes', async () => {
    await withTempDir(async (dir) => {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'test@example.com']);
      git(dir, ['config', 'user.name', 'Test User']);
      await writeFile(join(dir, 'README.md'), '# repo\n', 'utf8');
      git(dir, ['add', 'README.md']);
      git(dir, ['commit', '-m', 'initial']);

      const clean = await nodeRepoScanPort.readRepoFingerprint(dir);
      assert.match(clean.headSha, /^[0-9a-f]{40}$/);

      // A working-tree change must alter the fingerprint (drives re-grounding).
      await writeFile(join(dir, 'README.md'), '# repo\nmore\n', 'utf8');
      const dirty = await nodeRepoScanPort.readRepoFingerprint(dir);
      assert.equal(dirty.headSha, clean.headSha); // HEAD unchanged
      assert.notEqual(dirty.treeHash, clean.treeHash); // tree changed
    });
  });
});
