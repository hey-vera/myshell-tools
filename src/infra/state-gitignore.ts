/**
 * src/infra/state-gitignore.ts — fail-soft .gitignore guard for secrets
 *
 * When the myshell-tools state directory lives inside a git worktree
 * (cloud-workspace or repo-root state), ensures the worktree's .gitignore
 * contains the myshell state directory so secrets are never accidentally
 * committed. Always fail-soft: never throws, never blocks startup.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { posix } from 'node:path';

import type { AppStateLayout, StateContext } from './state-layout.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GitignoreResult {
  ok: boolean;
  reason?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const GITIGNORE_LINE = '.myshell-tools/';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Walk up from `cwd` looking for a `.git` file or directory.
 * Returns the git worktree root (the directory containing `.git`) or null.
 */
async function findGitRoot(cwd: string): Promise<string | null> {
  let current = cwd;
  while (true) {
    const gitPath = join(current, '.git');
    try {
      const s = await stat(gitPath);
      if (s.isDirectory() || s.isFile()) return current;
    } catch {
      // .git not found at this level — walk up
    }
    const parent = dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }
  return null;
}

/**
 * True when `path` is inside or equal to `root` on the filesystem.
 * Uses posix-normalised comparison.
 */
function isInside(path: string, root: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const np = norm(path);
  const nr = norm(root);
  if (np === nr) return true;
  return np.startsWith(nr + '/');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure the git worktree containing `ctx.cwd` has a `.gitignore` line that
 * ignores the myshell state directory (`.myshell-tools/`).
 *
 * Only acts when the resolved stateRoot is inside a detected git worktree.
 * For normal POSIX ~ / Windows AppData state this is always a no-op.
 *
 * Appends the ignore line idempotently. Never throws — always returns a result.
 */
export async function ensureStateGitignored(
  layout: AppStateLayout,
  ctx: StateContext,
): Promise<GitignoreResult> {
  try {
    // 1. Detect git worktree root from cwd
    const gitRoot = await findGitRoot(ctx.cwd);
    if (gitRoot === null) {
      // Not inside a git worktree — nothing to protect
      return { ok: true };
    }

    // 2. Check if stateRoot lives inside the git worktree
    if (!isInside(layout.stateRoot, gitRoot)) {
      // State is outside the repo (e.g. AppData, XDG) — nothing to protect
      return { ok: true };
    }

    // 3. Read or create .gitignore at the git root
    const gitignorePath = join(gitRoot, '.gitignore');
    let existing = '';
    try {
      existing = await readFile(gitignorePath, 'utf8');
    } catch {
      // File doesn't exist — start fresh
    }

    // 4. Idempotent check: already ignored?
    const lines = existing.split(/\r?\n/);
    if (lines.some((l) => l.trim() === GITIGNORE_LINE)) {
      return { ok: true };
    }

    // 5. Append the ignore line
    const newContent =
      (existing.length > 0 && !existing.endsWith('\n') ? existing + '\n' : existing) +
      GITIGNORE_LINE +
      '\n';

    await writeFile(gitignorePath, newContent, 'utf8');
    return { ok: true };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
