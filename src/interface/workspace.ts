/**
 * src/interface/workspace.ts — Workspace root resolution + candidate ranking
 * (Slice 7, docs/menu-build-spec-final.md).
 *
 * Lives in `interface/`, not `infra/`, because it composes `fuzzyRank`
 * (`menu-completion.ts`, also `interface/`) — the architecture guard
 * (`test/arch/guards.test.ts`, "core and infra never import interface")
 * forbids `core`/`infra` from importing `interface`. `resolveWorkspaceRoot`
 * itself is infra-flavored (fs/git via an injected port) but the module as a
 * whole exists to feed the workspace PICKER, so `interface/` is the correct
 * home.
 *
 * `resolveWorkspaceRoot` answers "what project is the user in": the git
 * toplevel when `cwd` is inside a repo, else the normalized `cwd` itself —
 * mirroring the `nodeRepoScanPort` convention in `repo-scan.ts` (best-effort,
 * never throws). `rankWorkspaceCandidates` builds the picker's candidate list
 * (current root, then prior conversation roots by recency, then ancestor
 * directories), deduped by normalized path. `filterWorkspaceCandidates` layers
 * the existing `fuzzyRank` (menu-completion.ts) on top for the picker's
 * type-to-filter UX, so ranking logic lives in exactly one place.
 *
 * Deliberately decoupled from `ConversationStore`/`ConversationMeta` (owned by
 * Slice 6, a parallel branch): prior workspaces are passed in as the minimal
 * `PriorWorkspaceEntry` shape rather than imported, so the two slices merge
 * without touching each other's files.
 */

import { posix as posixPath, win32 as win32Path } from 'node:path';
import type { RepoScanPort } from '../core/repo-map.js';
import { fuzzyRank } from './menu-completion.js';

/** True on filesystems where path comparison should be case-insensitive. */
function isCaseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * True if any of `inputs` look like a Windows-style path (a drive letter
 * like 'C:' or a backslash separator). Workspace roots are persisted
 * strings (in conversation history / saved state) that may have been
 * produced on a different host OS than the one running right now -- e.g. a
 * `workspaceRoot` saved on a Windows machine, read back on a POSIX CI
 * runner or a POSIX dev box. Using the HOST's native `path` module (which
 * is `path.posix` on POSIX, `path.win32` on Windows) to parse such a
 * string is wrong: a Windows-style absolute path like `'C:/Users/dev/repo'`
 * does not start with `/`, so POSIX `path.resolve` treats it as RELATIVE
 * and prefixes it with the runner's actual cwd. Selecting the path module
 * by the INPUT'S shape rather than the host platform makes path handling
 * for a given string identical on every OS: `path.posix`/`path.win32` are
 * pure, host-independent implementations (unlike bare `node:path`, which is
 * whichever of the two matches `process.platform`).
 */
function looksLikeWindowsPath(...inputs: readonly string[]): boolean {
  return inputs.some((s) => /^[A-Za-z]:/.test(s) || s.includes('\\'));
}

/** Pick `path.win32` or `path.posix` based on the shape of `inputs`, not the host OS. */
function pathModuleFor(...inputs: readonly string[]): typeof posixPath {
  return looksLikeWindowsPath(...inputs) ? win32Path : posixPath;
}

/**
 * Normalize a path for cross-platform comparison/display: resolved to an
 * absolute path, forward-slash separators, no trailing slash (except a bare
 * root like `/` or `C:/`). PURE given `cwd`.
 */
export function normalizeWorkspacePath(p: string, cwd: string = process.cwd()): string {
  const pm = pathModuleFor(p, cwd);
  const abs = pm.resolve(cwd, p);
  let norm = abs.split('\\').join('/');
  // Strip a trailing slash EXCEPT on a bare root: POSIX '/' (length 1, already
  // excluded below) or a Windows drive root like 'C:/'. Stripping the latter
  // would produce the drive-relative form 'C:' -- which `path.resolve` treats
  // as relative to the CURRENT directory on that drive, not the drive root --
  // so a caller walking up parents via dirname() would bounce back into cwd
  // instead of terminating at the drive root.
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(norm);
  if (norm.length > 1 && norm.endsWith('/') && !isWindowsDriveRoot) norm = norm.slice(0, -1);
  return norm;
}

/**
 * Resolve the workspace root for `cwd`: the git toplevel if `cwd` is inside a
 * repo, else the normalized `cwd`. Never throws — a failing/missing
 * `gitToplevel` degrades to the cwd fallback, matching `nodeRepoScanPort`'s
 * fail-soft contract.
 */
export async function resolveWorkspaceRoot(
  cwd: string,
  repoScanPort: Pick<RepoScanPort, 'gitToplevel'>,
): Promise<string> {
  let top: string | null = null;
  try {
    top = await repoScanPort.gitToplevel(cwd);
  } catch {
    top = null;
  }
  if (typeof top === 'string' && top.length > 0) return normalizeWorkspacePath(top);
  return normalizeWorkspacePath(cwd);
}

/** Short display label for a workspace root: its last path segment. PURE. */
export function workspaceLabel(root: string): string {
  const norm = normalizeWorkspacePath(root);
  const base = pathModuleFor(norm).basename(norm);
  return base.length > 0 ? base : norm;
}

/**
 * Ancestor directories of `root`, nearest first, excluding `root` itself,
 * stopping at the filesystem root (or after `maxDepth` steps). PURE.
 */
export function parentWorkspaceDirs(root: string, maxDepth = 5): string[] {
  const norm = normalizeWorkspacePath(root);
  const out: string[] = [];
  let current = norm;
  for (let i = 0; i < maxDepth; i++) {
    const parent = normalizeWorkspacePath(pathModuleFor(current).dirname(current));
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/** A ranked, deduped workspace the picker can offer. */
export interface WorkspaceCandidate {
  readonly root: string;
  readonly label: string;
}

/**
 * Minimal prior-conversation shape needed for ranking. Intentionally NOT
 * `ConversationMeta` — this stays decoupled from the conversation store so
 * Slice 6 (which owns `ConversationMeta.workspaceRoot`) and Slice 7 don't
 * collide on the same files. The public field name/type
 * (`workspaceRoot?: string | null`) matches that contract exactly.
 */
export interface PriorWorkspaceEntry {
  readonly workspaceRoot?: string | null;
  readonly updatedAt: string;
}

/**
 * Rank workspace candidates for the picker:
 *   1. the current root
 *   2. prior conversation workspaceRoots, most-recently-updated first
 *   3. ancestor directories of the current root, nearest first
 *
 * Deduped by normalized path (case-insensitive on win32/darwin), keeping the
 * first — i.e. highest-priority — occurrence. PURE.
 */
export function rankWorkspaceCandidates(
  currentRoot: string,
  priorWorkspaces: readonly PriorWorkspaceEntry[] = [],
  options: { maxParentDepth?: number; platform?: NodeJS.Platform } = {},
): WorkspaceCandidate[] {
  const caseInsensitive = isCaseInsensitiveFs(options.platform);
  const seen = new Set<string>();
  const out: WorkspaceCandidate[] = [];
  const push = (root: string): void => {
    const norm = normalizeWorkspacePath(root);
    const key = caseInsensitive ? norm.toLowerCase() : norm;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ root: norm, label: workspaceLabel(norm) });
  };

  push(currentRoot);

  const priorRoots = priorWorkspaces
    .filter(
      (p): p is PriorWorkspaceEntry & { workspaceRoot: string } =>
        typeof p.workspaceRoot === 'string' && p.workspaceRoot.length > 0,
    )
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  for (const p of priorRoots) push(p.workspaceRoot);

  for (const dir of parentWorkspaceDirs(currentRoot, options.maxParentDepth ?? 5)) push(dir);

  return out;
}

/**
 * Filter+rank `candidates` against a fuzzy `query` (picker type-to-filter),
 * reusing `fuzzyRank` (menu-completion.ts) rather than re-implementing
 * matching. Ranks by full normalized root path (not the display label) so
 * candidates that share a label — e.g. two checkouts both named
 * `myshell-tools` — stay distinct. Empty query returns `candidates` unchanged
 * (already ranked by {@link rankWorkspaceCandidates}). PURE; deterministic.
 */
export function filterWorkspaceCandidates(
  query: string,
  candidates: readonly WorkspaceCandidate[],
): WorkspaceCandidate[] {
  if (!query) return [...candidates];
  const roots = candidates.map((c) => c.root);
  const ranked = fuzzyRank(query, roots);
  const byRoot = new Map(candidates.map((c) => [c.root, c] as const));
  const out: WorkspaceCandidate[] = [];
  for (const r of ranked) {
    const c = byRoot.get(r);
    if (c !== undefined) out.push(c);
  }
  return out;
}
