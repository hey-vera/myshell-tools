import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { createLocalRepoOps, type GitRunner } from '../../src/infra/repo-ops.ts';

function fakeGit(responses: Record<string, string>): GitRunner {
  return async (args) => {
    const key = args.join(' ');
    return { stdout: responses[key] ?? '', stderr: '' };
  };
}

describe('local repo ops', () => {
  it('reports non-git repos as clean/no diff without throwing', async () => {
    const ops = createLocalRepoOps({ git: fakeGit({ 'rev-parse --is-inside-work-tree': 'false\n' }) });
    assert.deepEqual(await ops.status('/repo'), { isGitRepo: false, clean: true, changedFiles: [], raw: '' });
    assert.deepEqual(await ops.diff('/repo'), { isGitRepo: false, empty: true, stat: '', patchPreview: '' });
  });

  it('parses porcelain status changed files', async () => {
    const ops = createLocalRepoOps({ git: fakeGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'status --porcelain=v1': ' M src/a.ts\n?? test/b.ts\n',
    }) });

    const status = await ops.status('/repo');
    assert.equal(status.isGitRepo, true);
    assert.equal(status.clean, false);
    assert.deepEqual(status.changedFiles, ['src/a.ts', 'test/b.ts']);
  });

  it('summarizes diff and truncates patch preview', async () => {
    const ops = createLocalRepoOps({ git: fakeGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'diff --stat': ' src/a.ts | 2 ++\n',
      'diff --no-ext-diff': 'abcdef',
    }) });

    const diff = await ops.diff('/repo', 3);
    assert.equal(diff.isGitRepo, true);
    assert.equal(diff.empty, false);
    assert.equal(diff.stat, ' src/a.ts | 2 ++\n');
    assert.equal(diff.patchPreview, 'abc\n...[diff truncated]');
  });

  it('delegates test command detection to verify port', async () => {
    const ops = createLocalRepoOps({
      git: fakeGit({}),
      verifyPort: { async detectTestCommand() { return { label: 'npm test', command: 'npm', args: ['test'] }; } },
    });
    assert.deepEqual(await ops.detectTestCommand('/repo'), { label: 'npm test', command: 'npm', args: ['test'] });
  });
});
