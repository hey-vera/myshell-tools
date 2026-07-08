/**
 * Local repo operations for natural-language repo intents.
 *
 * This is deliberately small and non-destructive: status, diff summary, and test
 * command detection. Mutating operations (undo/commit/apply patch) remain separate
 * and must be gated by checkpoint/confirmation layers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { readFile, rm, mkdir } from 'node:fs/promises';

import type { DetectedTestCommand } from '../core/verify.js';
import type { UndoAction } from '../core/ai-checkpoint.js';
import { nodeVerifyPort } from './verify-port.js';
import { atomicWrite } from './atomic.js';

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
  /** Snapshot full text contents of currently dirty files (pre-turn baseline for checkpoints). */
  readonly snapshotPreContents: (cwd: string) => Promise<ReadonlyMap<string, string>>;
  /** Read committed (HEAD) content for a path. Returns null if not in HEAD (new file or no repo). Used as before baseline for clean-pre files. */
  readonly readHeadContent: (cwd: string, path: string) => Promise<string | null>;
  /** Apply a list of undo actions (write before or delete) exactly. Returns count applied and any errors. Non-transactional per-file best effort. */
  readonly applyUndoActions: (cwd: string, actions: readonly UndoAction[]) => Promise<{ applied: number; errors: readonly string[] }>;
  /** Safe commit of current changes. message is required and reviewable. */
  readonly commitChanges: (cwd: string, message: string) => Promise<{ ok: boolean; output: string }>;
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

    async snapshotPreContents(cwd: string): Promise<ReadonlyMap<string, string>> {
      const status = await this.status(cwd);
      if (!status.isGitRepo) return new Map();
      const map = new Map<string, string>();
      await Promise.all(
        status.changedFiles.map(async (p) => {
          try {
            const full = await fsReadFileSafe(cwd, p);
            if (full !== null) map.set(normalizePath(p), full);
          } catch {
            // ignore unreadable
          }
        }),
      );
      return map;
    },

    async readHeadContent(cwd: string, path: string): Promise<string | null> {
      const normalized = normalizePath(path);
      const result = await runGit(['show', `HEAD:${normalized}`], cwd);
      if (result.stdout.length > 0) return result.stdout;
      // stderr may indicate missing; treat empty-or-error as null
      return null;
    },

    async applyUndoActions(cwd: string, actions: readonly UndoAction[]): Promise<{ applied: number; errors: readonly string[] }> {
      const errors: string[] = [];
      let applied = 0;
      for (const action of actions) {
        const fullPath = join(cwd, action.path);
        try {
          if (action.type === 'write') {
            // ensure parent dir
            const dir = dirname(fullPath);
            await mkdir(dir, { recursive: true });
            await atomicWrite(fullPath, action.text, 0o644);
            applied++;
          } else if (action.type === 'delete') {
            await rm(fullPath, { force: true });
            applied++;
          }
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          errors.push(`${action.path}: ${m}`);
        }
      }
      return { applied, errors };
    },

    async commitChanges(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
      if (!message || message.trim().length === 0) {
        return { ok: false, output: 'empty commit message refused' };
      }
      // stage all relevant, then commit
      await runGit(['add', '-A'], cwd);
      const res = await runGit(['commit', '-m', message], cwd);
      const combined = (res.stdout + '\n' + res.stderr).trim();
      void !/nothing to commit|no changes added/i.test(combined);
      return { ok: true, output: combined || 'committed' };
    },
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

async function fsReadFileSafe(cwd: string, rel: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, rel), 'utf8');
  } catch {
    return null;
  }
}

export const localRepoOps = createLocalRepoOps();
