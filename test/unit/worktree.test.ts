/**
 * test/unit/worktree.test.ts — the ONLY real-git test for the Rival Tribunal's
 * production {@link WorktreePort} (src/infra/worktree.ts). Runs entirely inside a
 * throwaway tmp repo: git init → one commit → create a worktree → exec a command in
 * it → remove it. Skips cleanly if `git` is absent (mirrors the verify-port gating).
 *
 * NEVER runs `npm install` (the firewall gotcha) — instead it asserts the node_modules
 * SYMLINK path is created when a source node_modules exists. Everything is torn down in
 * afterAll().
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeWorktreePort } from '../../src/infra/worktree.ts';
import type { Worktree } from '../../src/core/tribunal.ts';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_GIT = gitAvailable();

describe('nodeWorktreePort — real git, throwaway tmp repo', { skip: !HAVE_GIT }, () => {
  let repoCwd: string;
  const created: Worktree[] = [];

  beforeAll(() => {
    repoCwd = mkdtempSync(join(tmpdir(), 'myshell-wt-repo-'));
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoCwd, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    // A real node_modules so the symlink assertion is meaningful.
    mkdirSync(join(repoCwd, 'node_modules'));
    writeFileSync(join(repoCwd, 'README.md'), '# tmp repo\n');
    run(['add', '.']);
    run(['commit', '-m', 'init']);
  });

  afterAll(() => {
    // Best-effort teardown of any worktree + the repo itself.
    for (const wt of created) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', wt.cwd], { cwd: repoCwd, stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
    try {
      rmSync(repoCwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('createWorktree makes an isolated worktree dir off HEAD', async () => {
    const wt = await nodeWorktreePort.createWorktree(repoCwd, 'tribunal-claude');
    assert.ok(wt !== null, 'a worktree should be created in a real git repo');
    created.push(wt);
    assert.ok(existsSync(wt.cwd), 'the worktree dir exists');
    // The committed file is present in the worktree (checked out off HEAD).
    assert.ok(existsSync(join(wt.cwd, 'README.md')));
    // node_modules is a SYMLINK from the main tree — NEVER an npm install.
    // Creating that symlink needs privileges Windows dev shells lack, so the
    // symlink-specific assertions are POSIX-only (the rest still runs on Windows).
    if (process.platform !== 'win32') {
      assert.ok(existsSync(join(wt.cwd, 'node_modules')));
      assert.ok(lstatSync(join(wt.cwd, 'node_modules')).isSymbolicLink(), 'node_modules is symlinked, never installed');
    }
  });

  it('execInWorktree runs a bounded command inside the worktree', async () => {
    const wt = created[0];
    assert.ok(wt !== undefined);
    const res = await nodeWorktreePort.execInWorktree(wt, 'git', ['status', '--porcelain'], 10_000);
    assert.equal(res.exitCode, 0);
    assert.equal(typeof res.output, 'string');
  });

  it('removeWorktree tears the worktree down (best-effort, no throw)', async () => {
    const wt = created[0];
    assert.ok(wt !== undefined);
    await nodeWorktreePort.removeWorktree(repoCwd, wt);
    assert.ok(!existsSync(wt.cwd), 'the worktree dir is removed');
    // Drop it from the teardown sink (already removed).
    created.length = 0;
  });

  it('createWorktree returns null in a non-git dir (degrades, never throws)', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'myshell-not-repo-'));
    try {
      const wt = await nodeWorktreePort.createWorktree(notRepo, 'tribunal-x');
      assert.equal(wt, null);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
