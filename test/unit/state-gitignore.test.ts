/**
 * test/unit/state-gitignore.test.ts — hermetic tests for ensureStateGitignored
 *
 * Uses throwaway tmp repos created with `git init`. Skips cleanly when `git` is
 * absent (mirrors worktree.test.ts gating).
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureStateGitignored } from '../../src/infra/state-gitignore.js';
import type { AppStateLayout, StateContext } from '../../src/infra/state-layout.js';

// ── helpers ────────────────────────────────────────────────────────────────

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAVE_GIT = gitAvailable();

/** Create a minimal AppStateLayout rooted inside `cwd`. */
function repoLayout(cwd: string): AppStateLayout {
  const root = join(cwd, '.myshell-tools');
  return {
    kind: 'cloud-workspace',
    appName: 'myshell-tools',
    configRoot: root,
    stateRoot: root,
    cacheRoot: root,
    legacyRoot: root,
    cloud: { provider: 'generic', workspaceRoot: cwd },
    paths: {
      configFile: join(root, 'config.json'),
      credentialsFile: join(root, 'credentials.json'),
      conversationsDir: join(root, 'conversations'),
      conversationArchiveDir: join(root, '.session-archive'),
      goalsDir: join(root, 'goals'),
      memoryDir: join(root, 'memory'),
      rulesDir: join(root, 'rules'),
      subscriptionsFile: join(root, 'subscriptions.json'),
      providerHomesDir: join(root, 'provider-homes'),
      updateCacheFile: join(root, 'update-check.json'),
      migrationDir: join(root, 'migration'),
    },
  };
}

function testCtx(cwd: string): StateContext {
  return {
    env: {},
    platform: process.platform,
    cwd,
    homeDir: '',
  };
}

// ── inside-git-worktree suite ──────────────────────────────────────────────

describe('ensureStateGitignored — inside git worktree', { skip: !HAVE_GIT }, () => {
  let repoCwd: string;

  beforeAll(() => {
    repoCwd = mkdtempSync(join(tmpdir(), 'myshell-gitignore-repo-'));
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoCwd, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(repoCwd, 'README.md'), '# tmp\n');
    run(['add', '.']);
    run(['commit', '-m', 'init']);
  });

  afterAll(() => {
    rmSync(repoCwd, { recursive: true, force: true });
  });

  it('appends the ignore line when .gitignore does not exist', async () => {
    // Fresh state: no .gitignore yet
    const gitignorePath = join(repoCwd, '.gitignore');
    try { rmSync(gitignorePath, { force: true }); } catch { /* ok */ }

    const result = await ensureStateGitignored(repoLayout(repoCwd), testCtx(repoCwd));
    assert.equal(result.ok, true);

    const content = readFileSync(gitignorePath, 'utf8');
    assert.ok(content.includes('.myshell-tools/'), 'should contain the ignore line');
  });

  it('is idempotent when .myshell-tools/ is already ignored', async () => {
    // Run twice — the second time should be a no-op and not duplicate the line
    const result1 = await ensureStateGitignored(repoLayout(repoCwd), testCtx(repoCwd));
    assert.equal(result1.ok, true);

    const gitignorePath = join(repoCwd, '.gitignore');
    const content1 = readFileSync(gitignorePath, 'utf8');

    const result2 = await ensureStateGitignored(repoLayout(repoCwd), testCtx(repoCwd));
    assert.equal(result2.ok, true);

    const content2 = readFileSync(gitignorePath, 'utf8');
    assert.equal(content2, content1, 'idempotent — no duplicate lines');
  });

  it('returns { ok:false } when .gitignore is unwritable (no throw)', async () => {
    // Create a new temp repo so we can break .gitignore independently
    const tmpRepo = mkdtempSync(join(tmpdir(), 'myshell-gi-ro-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpRepo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo, stdio: 'ignore' });
      writeFileSync(join(tmpRepo, 'README.md'), '# tmp\n');
      execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, stdio: 'ignore' });

      // Make .gitignore a directory so writeFile fails with EISDIR
      mkdirSync(join(tmpRepo, '.gitignore'));

      const result = await ensureStateGitignored(repoLayout(tmpRepo), testCtx(tmpRepo));
      assert.equal(result.ok, false);
      assert.ok(result.reason !== undefined, 'should include a reason');
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

// ── not-in-git suite ───────────────────────────────────────────────────────

describe('ensureStateGitignored — not inside git worktree', () => {
  it('returns { ok:true } no-op when cwd has no .git ancestor', async () => {
    const noGitDir = mkdtempSync(join(tmpdir(), 'myshell-gi-nogit-'));
    try {
      const result = await ensureStateGitignored(repoLayout(noGitDir), testCtx(noGitDir));
      assert.equal(result.ok, true);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });
});
