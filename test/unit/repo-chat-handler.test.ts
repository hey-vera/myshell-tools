import { describe, expect, it } from 'vitest';

import { buildAiCheckpoint, hashText, type AiChangeCheckpoint } from '../../src/core/ai-checkpoint.js';
import { handleRepoChatIntent, type RepoChatHandlerDeps } from '../../src/interface/repo-chat-handler.js';

function deps(overrides: Partial<RepoChatHandlerDeps> = {}): RepoChatHandlerDeps {
  return {
    cwd: '/repo',
    repoOps: {
      async status() {
        return { isGitRepo: true, clean: true, changedFiles: [], raw: '' };
      },
      async diff() {
        return { isGitRepo: true, empty: true, stat: '', patchPreview: '' };
      },
      async detectTestCommand() {
        return null;
      },
    },
    checkpointStore: {
      async latest() {
        return null;
      },
    },
    ...overrides,
  };
}

function checkpoint(): AiChangeCheckpoint {
  return buildAiCheckpoint({
    id: 'cp-1',
    createdAt: '2026-07-07T00:00:00.000Z',
    repoRoot: '/repo',
    intent: 'test checkpoint',
    files: [
      { path: 'src/a.ts', beforeText: 'before', afterText: 'after' },
      { path: 'src/new.ts', beforeText: null, afterText: 'new file' },
    ],
  });
}

describe('handleRepoChatIntent', () => {
  it('does not intercept normal edit requests', async () => {
    const result = await handleRepoChatIntent('fix the failing parser test', deps());
    expect(result).toBeNull();
  });

  it('reports a clean git status', async () => {
    const result = await handleRepoChatIntent('status please', deps());
    expect(result).toMatchObject({ operation: 'status', mutatesWorkspace: false });
    expect(result?.message).toBe('Repo status: clean.');
  });

  it('reports changed files for dirty status', async () => {
    const result = await handleRepoChatIntent('where are we?', deps({
      repoOps: {
        async status() {
          return { isGitRepo: true, clean: false, changedFiles: ['src/a.ts', 'test/a.test.ts'], raw: ' M src/a.ts' };
        },
        async diff() {
          return { isGitRepo: true, empty: true, stat: '', patchPreview: '' };
        },
        async detectTestCommand() {
          return null;
        },
      },
    }));

    expect(result?.message).toContain('2 changed file(s)');
    expect(result?.message).toContain('src/a.ts');
  });

  it('reports non-git status safely', async () => {
    const result = await handleRepoChatIntent('repo status', deps({
      repoOps: {
        async status() {
          return { isGitRepo: false, clean: true, changedFiles: [], raw: '' };
        },
        async diff() {
          return { isGitRepo: false, empty: true, stat: '', patchPreview: '' };
        },
        async detectTestCommand() {
          return null;
        },
      },
    }));

    expect(result?.message).toBe('This folder is not a git repo.');
  });

  it('summarizes an empty diff', async () => {
    const result = await handleRepoChatIntent('what changed?', deps());
    expect(result?.operation).toBe('summarize_diff');
    expect(result?.message).toBe('No git diff detected.');
  });

  it('summarizes a non-empty diff with stat and preview', async () => {
    const result = await handleRepoChatIntent('show diff', deps({
      repoOps: {
        async status() {
          return { isGitRepo: true, clean: true, changedFiles: [], raw: '' };
        },
        async diff() {
          return {
            isGitRepo: true,
            empty: false,
            stat: ' src/a.ts | 2 ++',
            patchPreview: 'diff --git a/src/a.ts b/src/a.ts',
          };
        },
        async detectTestCommand() {
          return null;
        },
      },
    }));

    expect(result?.message).toContain('Git diff detected.');
    expect(result?.message).toContain('src/a.ts | 2 ++');
    expect(result?.message).toContain('diff --git');
  });

  it('detects but does not run a test command', async () => {
    const result = await handleRepoChatIntent('run the tests', deps({
      repoOps: {
        async status() {
          return { isGitRepo: true, clean: true, changedFiles: [], raw: '' };
        },
        async diff() {
          return { isGitRepo: true, empty: true, stat: '', patchPreview: '' };
        },
        async detectTestCommand() {
          return { label: 'unit', command: 'npm', args: ['test'] };
        },
      },
    }));

    expect(result?.operation).toBe('verify_only');
    expect(result?.message).toBe('Detected test command: unit (npm test). I have not run it yet.');
  });

  it('reports when no test command is detected', async () => {
    const result = await handleRepoChatIntent('verify this', deps());
    expect(result?.message).toContain('No test command was detected');
  });

  it('refuses undo when no checkpoint exists', async () => {
    const result = await handleRepoChatIntent('undo that', deps());
    expect(result?.operation).toBe('undo_last_ai_change');
    expect(result?.message).toContain('no AI checkpoint exists');
  });

  it('previews a safe checkpoint undo without applying it', async () => {
    const cp = checkpoint();
    const result = await handleRepoChatIntent('undo the last change', deps({
      checkpointStore: {
        async latest() {
          return cp;
        },
      },
      async readFileText(path) {
        if (path === 'src/a.ts') return 'after';
        if (path === 'src/new.ts') return 'new file';
        return null;
      },
    }));

    expect(result?.message).toBe('Undo is available for checkpoint cp-1: would write 1 file(s) and delete 1 file(s). I have not applied it yet.');
  });

  it('refuses checkpoint undo when current files diverged', async () => {
    const cp = checkpoint();
    const result = await handleRepoChatIntent('please revert that', deps({
      checkpointStore: {
        async latest() {
          return cp;
        },
      },
      async readFileText(path) {
        if (path === 'src/a.ts') return 'user changed it';
        if (path === 'src/new.ts') return 'new file';
        return null;
      },
    }));

    expect(result?.message).toContain("can't safely undo checkpoint cp-1");
    expect(result?.message).toContain('src/a.ts');
    expect(hashText('user changed it')).not.toBe(cp.files[0]?.afterHash);
  });

  it('handles commit intent without mutating the repo (safe handler stays non-mutating; execution is in caller)', async () => {
    const result = await handleRepoChatIntent('commit this change', deps());
    expect(result).toMatchObject({ operation: 'commit_current_ai_change', mutatesWorkspace: false });
    expect(result?.message).toContain('summarize changes and commit');
  });
});
