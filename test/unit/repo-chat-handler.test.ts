import { describe, expect, it } from 'vitest';

import { buildAiCheckpoint, hashText, type AiChangeCheckpoint } from '../../src/core/ai-checkpoint.js';
import type { CommandGateDecision, CommandGatePort } from '../../src/core/command-gate.js';
import {
  githubPrChecksUnavailableMessage,
  githubPrCreateUnavailableMessage,
  githubPrStatusUnavailableMessage,
  gitlabCiStatusUnavailableMessage,
  gitlabMrCreateUnavailableMessage,
  handleRepoChatIntent,
  type RepoChatHandlerDeps,
} from '../../src/interface/repo-chat-handler.js';

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
      async commitChanges() {
        return { ok: true, output: 'committed (test mock)' };
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
        async commitChanges() {
          return { ok: true, output: 'committed (test mock)' };
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
        async commitChanges() {
          return { ok: true, output: 'committed (test mock)' };
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
        async commitChanges() {
          return { ok: true, output: 'committed (test mock)' };
        },
      },
    }));

    expect(result?.message).toContain('Git diff detected.');
    expect(result?.message).toContain('src/a.ts | 2 ++');
    expect(result?.message).toContain('diff --git');
  });

  it('executes gated verify_only via verifyPort.runTests and returns real outcome/receipt', async () => {
    const runSpy: Array<{ command: string; hadGate: boolean }> = [];
    const result = await handleRepoChatIntent('run the tests', deps({
      verifyPort: {
        async detectTestCommand() {
          return { label: 'unit', command: 'npm', args: ['test'] };
        },
        async runTests(cwd, command, timeoutMs, commandGate) {
          runSpy.push({ command: command.label, hadGate: !!commandGate });
          return { outcome: 'green', output: 'ok\n1 passed', durationMs: 42 } as const;
        },
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'test-build',
          forbidBackground: false,
          mustRecord: false,
          rationale: '',
        }),
        confirm: async () => true,
        record: () => {},
      } as CommandGatePort,
      oversight: 'autonomous',
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
        async commitChanges() {
          return { ok: true, output: 'committed (test mock)' };
        },
      },
    }));

    expect(result?.operation).toBe('verify_only');
    expect(result?.message).toContain('GREEN');
    expect(result?.message).toContain('42ms');
    expect(runSpy).toEqual([{ command: 'unit', hadGate: true }]);
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

  it('previews a safe checkpoint undo without applying it when no apply seam / confirm', async () => {
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
      // no applyUndoActions + non-autonomous → preview only
    }));

    expect(result?.message).toBe('Undo is available for checkpoint cp-1: would write 1 file(s) and delete 1 file(s). I have not applied it yet.');
    expect(result?.mutatesWorkspace).toBe(false);
  });

  it('applies a safe checkpoint undo under autonomous oversight', async () => {
    const cp = checkpoint();
    const applied: Array<{ path: string; type: string }> = [];
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
      oversight: 'autonomous',
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
        async commitChanges() {
          return { ok: true, output: 'ok' };
        },
        async applyUndoActions(_cwd, actions) {
          for (const a of actions) applied.push({ path: a.path, type: a.type });
          return { applied: actions.length, errors: [] };
        },
      },
    }));

    expect(result?.message).toContain('Applied undo for checkpoint cp-1');
    expect(result?.message).toContain('2 action(s)');
    expect(result?.mutatesWorkspace).toBe(true);
    expect(applied).toEqual([
      { path: 'src/a.ts', type: 'write' },
      { path: 'src/new.ts', type: 'delete' },
    ]);
  });

  it('applies undo after confirm under checkpoint oversight', async () => {
    const cp = checkpoint();
    let confirmed = false;
    const result = await handleRepoChatIntent('undo that', deps({
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
      oversight: 'checkpoint',
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: 'test',
        }),
        confirm: async () => {
          confirmed = true;
          return true;
        },
        record: () => {},
      } as CommandGatePort,
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
        async commitChanges() {
          return { ok: true, output: 'ok' };
        },
        async applyUndoActions(_cwd, actions) {
          return { applied: actions.length, errors: [] };
        },
      },
    }));

    expect(confirmed).toBe(true);
    expect(result?.message).toContain('Applied undo');
    expect(result?.mutatesWorkspace).toBe(true);
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

  it('handles commit: summarizes, gates (autonomous skips confirm), calls commitChanges, returns receipt', async () => {
    const commitCalls: Array<{ cwd: string; msg: string }> = [];
    const result = await handleRepoChatIntent('commit this change', deps({
      repoOps: {
        async status() {
          return { isGitRepo: true, clean: false, changedFiles: ['src/foo.ts'], raw: 'M src/foo.ts' };
        },
        async diff() {
          return { isGitRepo: true, empty: false, stat: ' src/foo.ts | 1 +', patchPreview: 'diff...' };
        },
        async detectTestCommand() {
          return null;
        },
        async commitChanges(cwd: string, message: string) {
          commitCalls.push({ cwd, msg: message });
          return { ok: true, output: '[main abc123] chat: commit 1 file(s) via natural language [src/foo.ts]' };
        },
      },
      // autonomous: no confirm required (test confirm would otherwise be called)
      oversight: 'autonomous',
    }));
    expect(result?.operation).toBe('commit_current_ai_change');
    expect(result?.mutatesWorkspace).toBe(true);
    expect(result?.message).toContain('Commit intent:');
    expect(result?.message).toContain('src/foo.ts');
    expect(result?.message).toContain('Commit succeeded');
    expect(commitCalls).toEqual([{ cwd: '/repo', msg: 'chat: commit 1 file(s) via natural language [src/foo.ts]' }]);
  });

  // -------------------------------------------------------------------------
  // P1.6 thin — GitHub PR status via NL ("pr status" / "github status")
  // -------------------------------------------------------------------------

  const githubForge = {
    cwd: '/repo',
    gitRoot: '/repo',
    remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git', purpose: 'fetch' as const }],
    hostClass: 'github' as const,
    primaryRemoteUrl: 'git@github.com:acme/app.git',
    tools: { gh: true, glab: false },
  };

  it('github_pr_status: runs gh pr status when host is GitHub and gh is available', async () => {
    const ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('pr status', deps({
      forgeContext: githubForge,
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'Current branch\n  #12  open  feat: foo  [main]',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'read-only',
          forbidBackground: false,
          mustRecord: false,
          rationale: '',
        }),
      } as CommandGatePort,
    }));

    expect(result?.operation).toBe('github_pr_status');
    expect(result?.mutatesWorkspace).toBe(false);
    expect(result?.message).toContain('GitHub PR status');
    expect(result?.message).toContain('#12');
    expect(ghCalls).toEqual([{ args: ['pr', 'status'], cwd: '/repo' }]);
  });

  it('github_pr_status: honest message when gh is missing on GitHub host (no theater)', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent("what's the PR status", deps({
      forgeContext: {
        ...githubForge,
        tools: { gh: false, glab: false },
      },
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('github_pr_status');
    expect(result?.message).toMatch(/gh.*not on PATH/i);
    expect(ghCalls).toEqual([]);
  });

  it('github_pr_status on GitLab+glab: runs glab mr list (no false gh)', async () => {
    const ghCalls: unknown[] = [];
    const glabCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('github status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: true, glab: true },
      },
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: '!42  open  feat: bar',
          stderr: '',
          exitCode: 0,
        };
      },
    }));

    expect(result?.message).toMatch(/GitLab MR list \(via glab\)/);
    expect(result?.message).toContain('!42');
    expect(result?.message).not.toMatch(/GitHub PR status \(via gh\)/);
    expect(ghCalls).toEqual([]);
    expect(glabCalls).toEqual([{ args: ['mr', 'list'], cwd: '/repo' }]);
  });

  it('gitlab_mr_status: runs glab mr list when host is GitLab and glab is available', async () => {
    const glabCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('mr status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return { ok: true, stdout: '!7 open fix: tests', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('gitlab_mr_status');
    expect(result?.mutatesWorkspace).toBe(false);
    expect(result?.message).toContain('GitLab MR list');
    expect(result?.message).toContain('!7');
    expect(glabCalls).toEqual([{ args: ['mr', 'list'], cwd: '/repo' }]);
  });

  it('gitlab_mr_status: honest message when glab missing on GitLab host', async () => {
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('mr status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: false },
      },
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.message).toMatch(/glab.*not on PATH/i);
    expect(glabCalls).toEqual([]);
  });

  it('github_pr_status: honest message for local-only / no remote', async () => {
    const result = await handleRepoChatIntent('pr status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [],
        hostClass: 'none',
        primaryRemoteUrl: null,
        tools: { gh: false, glab: false },
      },
    }));

    expect(result?.message).toMatch(/Local-only|no remote/i);
  });

  it('github_pr_status: surfaces gh failure honestly', async () => {
    const result = await handleRepoChatIntent('pr status', deps({
      forgeContext: githubForge,
      async runGh() {
        return {
          ok: false,
          stdout: '',
          stderr: 'HTTP 401: Bad credentials',
          exitCode: 1,
        };
      },
    }));

    expect(result?.message).toContain('gh pr status failed');
    expect(result?.message).toContain('401');
  });

  it('github_pr_status: gate deny does not run gh', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent('pr status', deps({
      forgeContext: githubForge,
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: 'ok', stderr: '', exitCode: 0 };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: false,
          requireConfirmation: false,
          commandTier: 'read-only',
          forbidBackground: false,
          mustRecord: false,
          rationale: 'denied in test',
        }),
      } as CommandGatePort,
    }));

    expect(result?.message).toMatch(/denied/i);
    expect(ghCalls).toEqual([]);
  });

  it('githubPrStatusUnavailableMessage: null only when GitHub + gh', () => {
    expect(githubPrStatusUnavailableMessage(githubForge)).toBeNull();
    expect(
      githubPrStatusUnavailableMessage({
        ...githubForge,
        tools: { gh: false, glab: false },
      }),
    ).toMatch(/not on PATH/i);
  });

  // -------------------------------------------------------------------------
  // P1.6 thin extension — GitHub PR checks via NL ("pr checks" / "ci status")
  // -------------------------------------------------------------------------

  it('github_pr_checks: runs gh pr checks when host is GitHub and gh is available', async () => {
    const ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('pr checks', deps({
      forgeContext: githubForge,
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'lint\tpass\t10s\thttps://ci.example/1\ntypecheck\tpass\t20s\thttps://ci.example/2',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'read-only',
          forbidBackground: false,
          mustRecord: false,
          rationale: '',
        }),
      } as CommandGatePort,
    }));

    expect(result?.operation).toBe('github_pr_checks');
    expect(result?.mutatesWorkspace).toBe(false);
    expect(result?.message).toContain('GitHub PR checks');
    expect(result?.message).toContain('typecheck');
    expect(ghCalls).toEqual([{ args: ['pr', 'checks'], cwd: '/repo' }]);
  });

  it('github_pr_checks: surfaces failed checks table when gh exits non-zero with stdout', async () => {
    const result = await handleRepoChatIntent('ci status', deps({
      forgeContext: githubForge,
      async runGh() {
        return {
          ok: false,
          stdout: 'lint\tfail\t10s\thttps://ci.example/1\nunit\tpass\t30s\thttps://ci.example/2',
          stderr: '',
          exitCode: 1,
        };
      },
    }));

    expect(result?.operation).toBe('github_pr_checks');
    expect(result?.message).toMatch(/not all green/i);
    expect(result?.message).toContain('lint');
    expect(result?.message).toContain('fail');
  });

  it('github_pr_checks: honest message when gh is missing on GitHub host (no theater)', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent('are checks green', deps({
      forgeContext: {
        ...githubForge,
        tools: { gh: false, glab: false },
      },
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('github_pr_checks');
    expect(result?.message).toMatch(/gh.*not on PATH/i);
    expect(ghCalls).toEqual([]);
  });

  it('github_pr_checks on GitLab+glab: runs glab ci status (no fake gh)', async () => {
    const ghCalls: unknown[] = [];
    const glabCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('github checks', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: true, glab: true },
      },
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: '(running) · https://gitlab.com/acme/app/-/pipelines/99',
          stderr: '',
          exitCode: 0,
        };
      },
    }));

    expect(result?.operation).toBe('github_pr_checks');
    expect(result?.message).toMatch(/GitLab CI status \(via glab\)/i);
    expect(result?.message).toContain('pipelines/99');
    expect(result?.message).not.toMatch(/GitHub PR checks \(via gh\)/);
    expect(ghCalls).toEqual([]);
    expect(glabCalls).toEqual([{ args: ['ci', 'status'], cwd: '/repo' }]);
  });

  it('github_pr_checks on GitLab without glab: honest message (no fake gh)', async () => {
    const ghCalls: unknown[] = [];
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('ci status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: false },
      },
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('github_pr_checks');
    expect(result?.message).toMatch(/GitLab/i);
    expect(result?.message).toMatch(/glab.*not on PATH/i);
    expect(ghCalls).toEqual([]);
    expect(glabCalls).toEqual([]);
  });

  it('github_pr_checks: honest message for local-only / no remote', async () => {
    const result = await handleRepoChatIntent('check status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [],
        hostClass: 'none',
        primaryRemoteUrl: null,
        tools: { gh: false, glab: false },
      },
    }));

    expect(result?.message).toMatch(/Local-only|no remote/i);
  });

  it('github_pr_checks: surfaces gh failure honestly when no useful stdout', async () => {
    const result = await handleRepoChatIntent('gh pr checks', deps({
      forgeContext: githubForge,
      async runGh() {
        return {
          ok: false,
          stdout: '',
          stderr: 'no pull requests found for branch "main"',
          exitCode: 1,
        };
      },
    }));

    expect(result?.message).toContain('gh pr checks failed');
    expect(result?.message).toMatch(/no pull requests/i);
  });

  it('github_pr_checks: gate deny does not run gh', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent('pr checks', deps({
      forgeContext: githubForge,
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: 'ok', stderr: '', exitCode: 0 };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: false,
          requireConfirmation: false,
          commandTier: 'read-only',
          forbidBackground: false,
          mustRecord: false,
          rationale: 'denied in test',
        }),
      } as CommandGatePort,
    }));

    expect(result?.message).toMatch(/denied/i);
    expect(ghCalls).toEqual([]);
  });

  it('githubPrChecksUnavailableMessage: null when GitHub+gh or GitLab+glab', () => {
    expect(githubPrChecksUnavailableMessage(githubForge)).toBeNull();
    expect(
      githubPrChecksUnavailableMessage({
        ...githubForge,
        tools: { gh: false, glab: false },
      }),
    ).toMatch(/not on PATH/i);
    expect(
      githubPrChecksUnavailableMessage({
        ...githubForge,
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        tools: { gh: false, glab: true },
      }),
    ).toBeNull();
    expect(
      githubPrChecksUnavailableMessage({
        ...githubForge,
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        tools: { gh: false, glab: false },
      }),
    ).toMatch(/glab.*not on PATH/i);
  });

  // -------------------------------------------------------------------------
  // P1.7 thin extension — GitLab CI/pipeline status via NL ("pipeline status")
  // -------------------------------------------------------------------------

  it('gitlab_ci_status: runs glab ci status when host is GitLab and glab is available', async () => {
    const glabCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('pipeline status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: '(success) · https://gitlab.com/acme/app/-/pipelines/42',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'read-only',
          forbidBackground: false,
          mustRecord: false,
          rationale: '',
        }),
      } as CommandGatePort,
    }));

    expect(result?.operation).toBe('gitlab_ci_status');
    expect(result?.mutatesWorkspace).toBe(false);
    expect(result?.message).toContain('GitLab CI status');
    expect(result?.message).toContain('pipelines/42');
    expect(glabCalls).toEqual([{ args: ['ci', 'status'], cwd: '/repo' }]);
  });

  it('gitlab_ci_status: surfaces non-green stdout when glab exits non-zero', async () => {
    const result = await handleRepoChatIntent('are pipelines green', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGlab() {
        return {
          ok: false,
          stdout: '(failed) · https://gitlab.com/acme/app/-/pipelines/7',
          stderr: '',
          exitCode: 1,
        };
      },
    }));

    expect(result?.operation).toBe('gitlab_ci_status');
    expect(result?.message).toMatch(/not all green/i);
    expect(result?.message).toContain('failed');
  });

  it('gitlab_ci_status: honest message when glab missing on GitLab host', async () => {
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('glab ci status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: false },
      },
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('gitlab_ci_status');
    expect(result?.message).toMatch(/glab.*not on PATH/i);
    expect(glabCalls).toEqual([]);
  });

  it('gitlab_ci_status on GitHub+gh: cross-routes to gh pr checks', async () => {
    const ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('pipeline status', deps({
      forgeContext: githubForge,
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'lint\tpass\t5s\thttps://ci.example/1',
          stderr: '',
          exitCode: 0,
        };
      },
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('github_pr_checks');
    expect(result?.message).toContain('GitHub PR checks');
    expect(result?.message).toContain('lint');
    expect(ghCalls).toEqual([{ args: ['pr', 'checks'], cwd: '/repo' }]);
    expect(glabCalls).toEqual([]);
  });

  it('gitlab_ci_status: honest message for local-only / no remote', async () => {
    const result = await handleRepoChatIntent('mr pipeline', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [],
        hostClass: 'none',
        primaryRemoteUrl: null,
        tools: { gh: false, glab: false },
      },
    }));

    expect(result?.message).toMatch(/Local-only|no remote/i);
  });

  it('gitlab_ci_status: surfaces glab failure honestly when no useful stdout', async () => {
    const result = await handleRepoChatIntent('glab ci status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGlab() {
        return {
          ok: false,
          stdout: '',
          stderr: 'none of the git remotes configured map to a valid project command',
          exitCode: 1,
        };
      },
    }));

    expect(result?.message).toContain('glab ci status failed');
    expect(result?.message).toMatch(/remotes configured/i);
  });

  it('gitlab_ci_status: gate deny does not run glab', async () => {
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('pipeline status', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: 'ok', stderr: '', exitCode: 0 };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: false,
          requireConfirmation: false,
          commandTier: 'read-only',
          forbidBackground: false,
          mustRecord: false,
          rationale: 'denied in test',
        }),
      } as CommandGatePort,
    }));

    expect(result?.message).toMatch(/denied/i);
    expect(glabCalls).toEqual([]);
  });

  it('gitlab_ci_status: caps long glab output', async () => {
    const long = 'pipeline-line\n'.repeat(500);
    const result = await handleRepoChatIntent('pipeline list', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGlab() {
        return { ok: true, stdout: long, stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.message).toMatch(/truncated/i);
    expect(result?.message.length).toBeLessThan(long.length);
  });

  it('gitlabCiStatusUnavailableMessage: null when GitLab+glab or GitHub+gh', () => {
    expect(
      gitlabCiStatusUnavailableMessage({
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      }),
    ).toBeNull();
    expect(gitlabCiStatusUnavailableMessage(githubForge)).toBeNull();
    expect(
      gitlabCiStatusUnavailableMessage({
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: false },
      }),
    ).toMatch(/not on PATH/i);
  });

  // -------------------------------------------------------------------------
  // P1.6 thin extension — GitHub PR create via NL ("create a pr" / "gh pr create")
  // -------------------------------------------------------------------------

  it('github_pr_create: runs gh pr create --fill when host is GitHub and gh is available', async () => {
    const ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('create a pr', deps({
      forgeContext: githubForge,
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'https://github.com/acme/app/pull/42',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: '',
        }),
        async confirm() {
          return true;
        },
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.operation).toBe('github_pr_create');
    expect(result?.mutatesWorkspace).toBe(true);
    expect(result?.message).toContain('GitHub PR created');
    expect(result?.message).toContain('pull/42');
    expect(ghCalls).toEqual([{ args: ['pr', 'create', '--fill'], cwd: '/repo' }]);
  });

  it('github_pr_create: honest message when gh is missing on GitHub host (no theater)', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent('open a pull request', deps({
      forgeContext: {
        ...githubForge,
        tools: { gh: false, glab: false },
      },
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('github_pr_create');
    expect(result?.message).toMatch(/gh.*not on PATH/i);
    expect(result?.mutatesWorkspace).toBe(false);
    expect(ghCalls).toEqual([]);
  });

  it('github_pr_create on GitLab+glab: cross-routes to glab mr create --fill --yes', async () => {
    const ghCalls: unknown[] = [];
    const glabCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('create a pr', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'https://gitlab.com/acme/app/-/merge_requests/7',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: '',
        }),
        async confirm() {
          return true;
        },
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.operation).toBe('github_pr_create');
    expect(result?.message).toMatch(/GitLab MR created/i);
    expect(result?.message).toContain('merge_requests/7');
    expect(ghCalls).toEqual([]);
    expect(glabCalls).toEqual([{ args: ['mr', 'create', '--fill', '--yes'], cwd: '/repo' }]);
  });

  it('github_pr_create: honest message for wrong/non-GitHub host', async () => {
    const result = await handleRepoChatIntent('gh pr create', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@example.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'other',
        primaryRemoteUrl: 'git@example.com:acme/app.git',
        tools: { gh: true, glab: false },
      },
    }));

    expect(result?.message).toMatch(/not GitHub/i);
  });

  it('github_pr_create: surfaces gh failure honestly with shell guidance', async () => {
    const result = await handleRepoChatIntent('create a pr', deps({
      forgeContext: githubForge,
      async runGh() {
        return {
          ok: false,
          stdout: '',
          stderr: 'must be on a branch with commits ahead of base',
          exitCode: 1,
        };
      },
      oversight: 'autonomous',
    }));

    expect(result?.message).toContain('gh pr create --fill failed');
    expect(result?.message).toMatch(/must be on a branch|commits ahead/i);
    expect(result?.message).toMatch(/will not hang/i);
    expect(result?.mutatesWorkspace).toBe(false);
  });

  it('github_pr_create: gate deny does not run gh', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent('create a pr', deps({
      forgeContext: githubForge,
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: 'https://example.com/pr/1', stderr: '', exitCode: 0 };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: false,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: 'denied in test',
        }),
        async confirm() {
          return true;
        },
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.message).toMatch(/denied/i);
    expect(ghCalls).toEqual([]);
  });

  it('github_pr_create: without confirm seam stays preview-only (no hang, no spawn)', async () => {
    const ghCalls: unknown[] = [];
    const result = await handleRepoChatIntent('create a pr', deps({
      forgeContext: githubForge,
      async runGh() {
        ghCalls.push(1);
        return { ok: true, stdout: 'https://example.com/pr/1', stderr: '', exitCode: 0 };
      },
      // commandGate present but no confirm — non-autonomous must not spawn
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: '',
        }),
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.message).toMatch(/have not created a PR/i);
    expect(result?.message).toMatch(/gh pr create --fill/);
    expect(ghCalls).toEqual([]);
  });

  it('githubPrCreateUnavailableMessage: null when GitHub + gh or GitLab + glab', () => {
    expect(githubPrCreateUnavailableMessage(githubForge)).toBeNull();
    expect(
      githubPrCreateUnavailableMessage({
        ...githubForge,
        tools: { gh: false, glab: false },
      }),
    ).toMatch(/not on PATH/i);
    expect(
      githubPrCreateUnavailableMessage({
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'gitlab',
        primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
        tools: { gh: false, glab: true },
      }),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // P1.7 thin extension — GitLab MR create via NL ("create a mr" / "glab mr create")
  // -------------------------------------------------------------------------

  const gitlabForge = {
    cwd: '/repo',
    gitRoot: '/repo',
    remotes: [{ name: 'origin', url: 'git@gitlab.com:acme/app.git', purpose: 'fetch' as const }],
    hostClass: 'gitlab' as const,
    primaryRemoteUrl: 'git@gitlab.com:acme/app.git',
    tools: { gh: false, glab: true },
  };

  it('gitlab_mr_create: runs glab mr create --fill --yes when host is GitLab and glab is available', async () => {
    const glabCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('create a mr', deps({
      forgeContext: gitlabForge,
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'https://gitlab.com/acme/app/-/merge_requests/12',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: '',
        }),
        async confirm() {
          return true;
        },
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.operation).toBe('gitlab_mr_create');
    expect(result?.mutatesWorkspace).toBe(true);
    expect(result?.message).toContain('GitLab MR created');
    expect(result?.message).toContain('merge_requests/12');
    expect(glabCalls).toEqual([{ args: ['mr', 'create', '--fill', '--yes'], cwd: '/repo' }]);
  });

  it('gitlab_mr_create: honest message when glab is missing on GitLab host (no theater)', async () => {
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('open a merge request', deps({
      forgeContext: {
        ...gitlabForge,
        tools: { gh: false, glab: false },
      },
      async runGlab(args, cwd) {
        glabCalls.push({ args, cwd });
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
    }));

    expect(result?.operation).toBe('gitlab_mr_create');
    expect(result?.message).toMatch(/glab.*not on PATH/i);
    expect(result?.mutatesWorkspace).toBe(false);
    expect(glabCalls).toEqual([]);
  });

  it('gitlab_mr_create on GitHub+gh: cross-routes to gh pr create --fill', async () => {
    const glabCalls: unknown[] = [];
    const ghCalls: Array<{ args: readonly string[]; cwd: string }> = [];
    const result = await handleRepoChatIntent('create a merge request', deps({
      forgeContext: githubForge,
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: '', stderr: '', exitCode: 0 };
      },
      async runGh(args, cwd) {
        ghCalls.push({ args, cwd });
        return {
          ok: true,
          stdout: 'https://github.com/acme/app/pull/99',
          stderr: '',
          exitCode: 0,
        };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: '',
        }),
        async confirm() {
          return true;
        },
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.operation).toBe('github_pr_create');
    expect(result?.message).toMatch(/GitHub PR created/i);
    expect(result?.message).toContain('pull/99');
    expect(glabCalls).toEqual([]);
    expect(ghCalls).toEqual([{ args: ['pr', 'create', '--fill'], cwd: '/repo' }]);
  });

  it('gitlab_mr_create: honest message for wrong/non-GitLab host', async () => {
    const result = await handleRepoChatIntent('glab mr create', deps({
      forgeContext: {
        cwd: '/repo',
        gitRoot: '/repo',
        remotes: [{ name: 'origin', url: 'git@example.com:acme/app.git', purpose: 'fetch' }],
        hostClass: 'other',
        primaryRemoteUrl: 'git@example.com:acme/app.git',
        tools: { gh: false, glab: true },
      },
    }));

    expect(result?.message).toMatch(/not GitLab/i);
  });

  it('gitlab_mr_create: surfaces glab failure honestly with shell guidance', async () => {
    const result = await handleRepoChatIntent('create a mr', deps({
      forgeContext: gitlabForge,
      async runGlab() {
        return {
          ok: false,
          stdout: '',
          stderr: 'must be on a branch with commits ahead of target',
          exitCode: 1,
        };
      },
      oversight: 'autonomous',
    }));

    expect(result?.message).toContain('glab mr create --fill --yes failed');
    expect(result?.message).toMatch(/must be on a branch|commits ahead/i);
    expect(result?.message).toMatch(/will not hang/i);
    expect(result?.mutatesWorkspace).toBe(false);
  });

  it('gitlab_mr_create: gate deny does not run glab', async () => {
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('create a mr', deps({
      forgeContext: gitlabForge,
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: 'https://example.com/mr/1', stderr: '', exitCode: 0 };
      },
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: false,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: 'denied in test',
        }),
        async confirm() {
          return true;
        },
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.message).toMatch(/denied/i);
    expect(glabCalls).toEqual([]);
  });

  it('gitlab_mr_create: without confirm seam stays preview-only (no hang, no spawn)', async () => {
    const glabCalls: unknown[] = [];
    const result = await handleRepoChatIntent('create a mr', deps({
      forgeContext: gitlabForge,
      async runGlab() {
        glabCalls.push(1);
        return { ok: true, stdout: 'https://example.com/mr/1', stderr: '', exitCode: 0 };
      },
      // commandGate present but no confirm — non-autonomous must not spawn
      commandGate: {
        gate: (): CommandGateDecision => ({
          allowed: true,
          requireConfirmation: false,
          commandTier: 'local-write',
          forbidBackground: false,
          mustRecord: true,
          rationale: '',
        }),
      } as CommandGatePort,
      oversight: 'checkpoint',
    }));

    expect(result?.message).toMatch(/have not created an MR/i);
    expect(result?.message).toMatch(/glab mr create --fill --yes/);
    expect(glabCalls).toEqual([]);
  });

  it('gitlabMrCreateUnavailableMessage: null when GitLab + glab or GitHub + gh', () => {
    expect(gitlabMrCreateUnavailableMessage(gitlabForge)).toBeNull();
    expect(
      gitlabMrCreateUnavailableMessage({
        ...gitlabForge,
        tools: { gh: false, glab: false },
      }),
    ).toMatch(/not on PATH/i);
    expect(gitlabMrCreateUnavailableMessage(githubForge)).toBeNull();
  });
});
