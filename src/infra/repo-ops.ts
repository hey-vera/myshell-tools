/**
 * Local repo operations for natural-language repo intents.
 *
 * This is deliberately small and non-destructive: status, diff summary, and test
 * command detection. Mutating operations (undo/commit/apply patch) remain separate
 * and must be gated by checkpoint/confirmation layers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { DetectedTestCommand } from '../core/verify.js';
import { nodeVerifyPort } from './verify-port.js';

const execFileAsync = promisify(execFile);

export interface GitRunnerResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunnerResult>;

export interface RepoStatusSummary {
  readonly isGitRepo: boolean;
  readonly clean: boolean;
  readonly changedFiles: readonly string[];
  readonly raw: string;
}

export interface RepoDiffSummary {
  readonly isGitRepo: boolean;
  readonly empty: boolean;
  readonly stat: string;
  readonly patchPreview: string;
}

export interface LocalRepoOps {
  readonly status: (cwd: string) => Promise<RepoStatusSummary>;
  readonly diff: (cwd: string, maxPreviewChars?: number) => Promise<RepoDiffSummary>;
  readonly detectTestCommand: (cwd: string) => Promise<DetectedTestCommand | null>;
}

const DEFAULT_DIFF_PREVIEW_CHARS = 12_000;

async function defaultGitRunner(args: readonly string[], cwd: string): Promise<GitRunnerResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const nodeErr = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      stdout: typeof nodeErr.stdout === 'string' ? nodeErr.stdout : '',
      stderr: typeof nodeErr.stderr === 'string' ? nodeErr.stderr : String(nodeErr.message ?? err),
    };
  }
}

function parsePorcelain(raw: string): readonly string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}

async function isGitRepo(cwd: string, runGit: GitRunner): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return result.stdout.trim() === 'true';
}

export function createLocalRepoOps(deps: { readonly git?: GitRunner; readonly verifyPort?: Pick<typeof nodeVerifyPort, 'detectTestCommand'> } = {}): LocalRepoOps {
  const runGit = deps.git ?? defaultGitRunner;
  const verifyPort = deps.verifyPort ?? nodeVerifyPort;

  return {
    async status(cwd: string): Promise<RepoStatusSummary> {
      if (!(await isGitRepo(cwd, runGit))) {
        return { isGitRepo: false, clean: true, changedFiles: [], raw: '' };
      }
      const result = await runGit(['status', '--porcelain=v1'], cwd);
      const changedFiles = parsePorcelain(result.stdout);
      return {
        isGitRepo: true,
        clean: changedFiles.length === 0,
        changedFiles,
        raw: result.stdout,
      };
    },

    async diff(cwd: string, maxPreviewChars = DEFAULT_DIFF_PREVIEW_CHARS): Promise<RepoDiffSummary> {
      if (!(await isGitRepo(cwd, runGit))) {
        return { isGitRepo: false, empty: true, stat: '', patchPreview: '' };
      }
      const stat = await runGit(['diff', '--stat'], cwd);
      const patch = await runGit(['diff', '--no-ext-diff'], cwd);
      const patchPreview = patch.stdout.length > maxPreviewChars
        ? `${patch.stdout.slice(0, maxPreviewChars)}\n...[diff truncated]`
        : patch.stdout;
      return {
        isGitRepo: true,
        empty: stat.stdout.trim().length === 0 && patch.stdout.trim().length === 0,
        stat: stat.stdout,
        patchPreview,
      };
    },

    async detectTestCommand(cwd: string): Promise<DetectedTestCommand | null> {
      return verifyPort.detectTestCommand(cwd);
    },
  };
}

export const localRepoOps = createLocalRepoOps();
