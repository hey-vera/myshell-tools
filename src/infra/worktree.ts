/**
 * src/infra/worktree.ts — the IMPURE git-worktree exec behind the Rival Tribunal's
 * {@link WorktreePort} (master-plan PHASE 9; the pure half is core/tribunal.ts).
 *
 * Mirrors verify-port.ts EXACTLY: every git/fs/exec operation is wrapped so a missing
 * `git`, a non-repo dir, or a failed `git worktree add` degrades to a null/empty
 * result rather than throwing — the pure caller (runTribunal) then tears down and
 * degrades to the normal work-call. No model call, no embeddings, no metered service.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * CRITICAL FIREWALL GOTCHA — NEVER run `npm install` in a worktree. Doing so bakes
 * `package-firewall.replit.local` URLs into package-lock.json and breaks the owner's
 * publish. A fresh worktree has NO node_modules; instead we SYMLINK node_modules from
 * the main tree (best-effort). If the symlink fails, that's fine — the rival's tests
 * then error → the build is honestly reported `unverified`, never a fabricated pass.
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * NON-DESTRUCTIVE + BOUNDED: every exec runs with a TIMEOUT, reject:false (a non-zero
 * exit is read, not thrown), cwd scoped to the worktree, no stdin. Teardown is
 * `git worktree remove --force` + `git worktree prune`, best-effort, never throws.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import type { WorktreePort, Worktree } from '../core/tribunal.js';

const execFileAsync = promisify(execFile);

/** Cap so a pathological `git worktree` op can never hang the tribunal. */
const GIT_TIMEOUT_MS = 15_000;
/** Bound captured exec output. */
const MAX_EXEC_OUTPUT_CHARS = 64 * 1024;

/**
 * The production {@link WorktreePort}. Each method swallows its own failure so the
 * pure caller's degradation path (tear down + fall through to the normal work-call)
 * is never reached by a thrown error.
 */
export const nodeWorktreePort: WorktreePort = {
  async createWorktree(repoCwd: string, label: string): Promise<Worktree | null> {
    try {
      // A throwaway temp dir OUTSIDE the repo so the worktree is fully isolated.
      const base = await mkdtemp(join(tmpdir(), `myshell-${sanitize(label)}-`));
      const wtDir = join(base, 'wt');

      // Detached worktree off the current HEAD — no branch churn in the main repo.
      const added = await runGit(repoCwd, ['worktree', 'add', '--detach', wtDir, 'HEAD']);
      if (!added) return null;

      // Resolve the checked-out ref for the receipt/teardown (best-effort).
      const branch = (await gitOut(wtDir, ['rev-parse', '--short', 'HEAD'])) ?? 'HEAD';

      // SYMLINK node_modules from the main tree — NEVER `npm install` (firewall
      // gotcha). Best-effort: an EEXIST or any failure is fine (tests then error →
      // the build is honestly `unverified`, never a fabricated pass).
      try {
        await symlink(join(repoCwd, 'node_modules'), join(wtDir, 'node_modules'), 'dir');
      } catch {
        // ignore — including EEXIST and a missing source node_modules.
      }

      return { cwd: wtDir, branch };
    } catch {
      return null;
    }
  },

  async execInWorktree(
    wt: Worktree,
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; output: string }> {
    try {
      const result = await execa(command, [...args], {
        cwd: wt.cwd,
        timeout: Math.max(1000, timeoutMs),
        reject: false,
        all: true,
        stripFinalNewline: false,
        stdin: 'ignore',
        env: { CI: 'true', NO_COLOR: '1' },
      });
      const output = clip(typeof result.all === 'string' ? result.all : '', MAX_EXEC_OUTPUT_CHARS);
      return { exitCode: result.exitCode ?? null, output };
    } catch {
      return { exitCode: null, output: '' };
    }
  },

  async removeWorktree(repoCwd: string, wt: Worktree): Promise<void> {
    // Best-effort, never throws: force-remove the worktree dir, then prune the
    // bookkeeping so a half-removed entry can't accumulate.
    await runGit(repoCwd, ['worktree', 'remove', '--force', wt.cwd]);
    await runGit(repoCwd, ['worktree', 'prune']);
  },
};

// ---------------------------------------------------------------------------
// Helpers (best-effort, no-throw — the verify-port discipline)
// ---------------------------------------------------------------------------

/** Run a git subcommand; return true on exit 0, false on any failure. No-throw. */
async function runGit(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Run a git subcommand and return trimmed stdout, or null on any failure. */
async function gitOut(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Make a label safe as a tmp-dir name component. */
function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'rival';
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
