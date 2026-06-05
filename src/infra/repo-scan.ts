/**
 * src/infra/repo-scan.ts — the IMPURE fs/git reader behind the repo-map's
 * `RepoScanPort` (docs/codebase-awareness-5.6.md, Phase E1).
 *
 * Mirrors the user-memory-store's `defaultGitToplevel`: every git/fs operation is
 * wrapped so a missing `git`, a non-repo dir, or an unreadable file degrades to a
 * null/empty/no-throw result rather than failing the turn. The pure ranking +
 * rendering lives in core/repo-map.ts; this is only the raw-facts reader.
 *
 * NO model call, NO network, NO new dep — just `git` (best-effort) + node:fs.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RepoScanPort } from '../core/repo-map.js';

const execFileAsync = promisify(execFile);

/** Cap so a pathological `git log` can never hang the orientation gather. */
const GIT_TIMEOUT_MS = 4000;
/** Bound the tracked-file listing on huge monorepos. */
const MAX_TRACKED = 4000;

/**
 * The production `RepoScanPort`: git toplevel/branch/dirty + tracked-file recency
 * ordering via `git log`, with a plain fs fallback. Each method swallows its own
 * failure so the pure composer's per-call `safe()` wrapper has belt-and-suspenders.
 */
export const nodeRepoScanPort: RepoScanPort = {
  async gitToplevel(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      const top = stdout.trim();
      return top.length > 0 ? top : null;
    } catch {
      return null;
    }
  },

  async gitBranch(root: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      });
      const b = stdout.trim();
      return b === 'HEAD' ? '' : b; // detached → unknown
    } catch {
      return '';
    }
  },

  async gitDirtyCount(root: string): Promise<number | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      });
      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      return lines.length;
    } catch {
      return undefined;
    }
  },

  async listTrackedFiles(root: string): Promise<readonly string[]> {
    // Prefer git-log order (most-recently-committed first) so the recency signal
    // is faithful; fall back to ls-files; fall back to nothing.
    const recent = await trackedByRecency(root);
    if (recent.length > 0) return recent.slice(0, MAX_TRACKED);
    const all = await lsFiles(root);
    return all.slice(0, MAX_TRACKED);
  },

  async dirtyFiles(root: string): Promise<ReadonlySet<string>> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      });
      const set = new Set<string>();
      for (const line of stdout.split('\n')) {
        const rel = line.slice(3).trim();
        if (rel.length > 0) set.add(rel.replace(/\\/g, '/'));
      }
      return set;
    } catch {
      return new Set<string>();
    }
  },

  async readFile(root: string, rel: string): Promise<string | null> {
    try {
      return await fsReadFile(join(root, rel), 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * Tracked files ordered most-recently-committed-first via a single `git log`
 * over name-only diffs. De-duped, preserving first (most recent) occurrence.
 */
async function trackedByRecency(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--name-only', '--pretty=format:', '-n', '400'],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const line of stdout.split('\n')) {
      const rel = line.trim();
      if (rel.length === 0 || seen.has(rel)) continue;
      seen.add(rel);
      ordered.push(rel.replace(/\\/g, '/'));
    }
    // Append any tracked files not yet seen (older / never-changed) after the
    // recent set so they can still appear in the map, just ranked lower.
    const all = await lsFiles(root);
    for (const f of all) {
      if (!seen.has(f)) {
        seen.add(f);
        ordered.push(f);
      }
    }
    return ordered;
  } catch {
    return [];
  }
}

/** `git ls-files` (tracked-only) → repo-relative POSIX paths. */
async function lsFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .map((l) => l.trim().replace(/\\/g, '/'))
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
