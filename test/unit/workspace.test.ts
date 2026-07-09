/**
 * Unit tests for src/interface/workspace.ts (Slice 7 - workspace resolver +
 * candidate model). Uses an injected fake RepoScanPort so git-root behavior
 * is deterministic and independent of real global git state.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  normalizeWorkspacePath,
  resolveWorkspaceRoot,
  workspaceLabel,
  parentWorkspaceDirs,
  rankWorkspaceCandidates,
  filterWorkspaceCandidates,
  type WorkspaceCandidate,
  type PriorWorkspaceEntry,
} from '../../src/interface/workspace.ts';
import type { RepoScanPort } from '../../src/core/repo-map.ts';

function fakePort(toplevel: string | null): Pick<RepoScanPort, 'gitToplevel'> {
  return {
    gitToplevel: async () => toplevel,
  };
}

function throwingPort(): Pick<RepoScanPort, 'gitToplevel'> {
  return {
    gitToplevel: async () => {
      throw new Error('git missing');
    },
  };
}

describe('resolveWorkspaceRoot', () => {
  it('returns the git toplevel when cwd is inside a repo', async () => {
    const root = await resolveWorkspaceRoot('C:/Users/dev/repo/src', fakePort('C:/Users/dev/repo'));
    assert.equal(root, 'C:/Users/dev/repo');
  });

  it('falls back to normalized cwd when gitToplevel returns null', async () => {
    const root = await resolveWorkspaceRoot('C:/Users/dev/scratch', fakePort(null));
    assert.equal(root, 'C:/Users/dev/scratch');
  });

  it('falls back to normalized cwd when gitToplevel returns empty string', async () => {
    const root = await resolveWorkspaceRoot('C:/Users/dev/scratch', fakePort(''));
    assert.equal(root, 'C:/Users/dev/scratch');
  });

  it('falls back to normalized cwd when gitToplevel throws (best-effort, never throws)', async () => {
    const root = await resolveWorkspaceRoot('C:/Users/dev/scratch', throwingPort());
    assert.equal(root, 'C:/Users/dev/scratch');
  });

  it('normalizes a git toplevel with backslashes and trailing slash', async () => {
    const root = await resolveWorkspaceRoot('C:\\Users\\dev\\repo\\src', fakePort('C:\\Users\\dev\\repo\\'));
    assert.equal(root, 'C:/Users/dev/repo');
  });
});

describe('normalizeWorkspacePath', () => {
  it('converts backslashes to forward slashes', () => {
    assert.equal(normalizeWorkspacePath('C:\\Users\\dev\\repo'), 'C:/Users/dev/repo');
  });

  it('strips a trailing slash', () => {
    assert.equal(normalizeWorkspacePath('C:/Users/dev/repo/'), 'C:/Users/dev/repo');
  });

  it('resolves a relative path against the provided cwd', () => {
    assert.equal(normalizeWorkspacePath('sub', 'C:/Users/dev/repo'), 'C:/Users/dev/repo/sub');
  });
});

describe('workspaceLabel', () => {
  it('returns the last path segment', () => {
    assert.equal(workspaceLabel('C:/Users/dev/myshell-tools'), 'myshell-tools');
  });

  it('handles a trailing slash / backslash form', () => {
    assert.equal(workspaceLabel('C:\\Users\\dev\\myshell-tools\\'), 'myshell-tools');
  });
});

describe('parentWorkspaceDirs', () => {
  it('walks up ancestor directories nearest-first, excluding root itself', () => {
    const dirs = parentWorkspaceDirs('C:/Users/dev/repo/src', 3);
    assert.deepEqual(dirs, ['C:/Users/dev/repo', 'C:/Users/dev', 'C:/Users']);
  });

  it('stops at the filesystem root without looping', () => {
    const dirs = parentWorkspaceDirs('C:/repo', 10);
    assert.ok(dirs.length < 10);
    assert.ok(dirs.every((d) => typeof d === 'string' && d.length > 0));
  });
});

describe('rankWorkspaceCandidates', () => {
  it('orders current root, then prior workspaces by latest update, then parents', () => {
    const prior: PriorWorkspaceEntry[] = [
      { workspaceRoot: 'C:/Users/dev/other-a', updatedAt: '2026-01-01T00:00:00.000Z' },
      { workspaceRoot: 'C:/Users/dev/other-b', updatedAt: '2026-03-01T00:00:00.000Z' },
    ];
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo/src', prior, { maxParentDepth: 2 });
    const roots = candidates.map((c) => c.root);
    assert.deepEqual(roots, [
      'C:/Users/dev/repo/src',
      'C:/Users/dev/other-b',
      'C:/Users/dev/other-a',
      'C:/Users/dev/repo',
      'C:/Users/dev',
    ]);
  });

  it('dedupes a prior workspace that matches the current root', () => {
    const prior: PriorWorkspaceEntry[] = [
      { workspaceRoot: 'C:/Users/dev/repo', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', prior, { maxParentDepth: 1 });
    const roots = candidates.map((c) => c.root);
    assert.equal(roots.filter((r) => r === 'C:/Users/dev/repo').length, 1);
  });

  it('dedupes case-insensitively on win32', () => {
    const prior: PriorWorkspaceEntry[] = [
      { workspaceRoot: 'C:/USERS/DEV/REPO', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', prior, {
      maxParentDepth: 0,
      platform: 'win32',
    });
    assert.equal(candidates.length, 1);
  });

  it('ignores prior entries with null/undefined/empty workspaceRoot', () => {
    const prior: PriorWorkspaceEntry[] = [
      { workspaceRoot: null, updatedAt: '2026-01-01T00:00:00.000Z' },
      { updatedAt: '2026-01-02T00:00:00.000Z' },
      { workspaceRoot: '', updatedAt: '2026-01-03T00:00:00.000Z' },
    ];
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', prior, { maxParentDepth: 0 });
    assert.deepEqual(candidates.map((c) => c.root), ['C:/Users/dev/repo']);
  });

  it('is deterministic - same input always yields the same order', () => {
    const prior: PriorWorkspaceEntry[] = [
      { workspaceRoot: 'C:/Users/dev/other-a', updatedAt: '2026-01-01T00:00:00.000Z' },
      { workspaceRoot: 'C:/Users/dev/other-b', updatedAt: '2026-03-01T00:00:00.000Z' },
    ];
    const a = rankWorkspaceCandidates('C:/Users/dev/repo', prior, { maxParentDepth: 1 });
    const b = rankWorkspaceCandidates('C:/Users/dev/repo', prior, { maxParentDepth: 1 });
    assert.deepEqual(a, b);
  });
});

describe('filterWorkspaceCandidates', () => {
  const candidates: WorkspaceCandidate[] = [
    { root: 'C:/Users/dev/myshell-tools', label: 'myshell-tools' },
    { root: 'C:/Users/dev/other-project', label: 'other-project' },
    { root: 'C:/work/myshell-tools-fork', label: 'myshell-tools-fork' },
  ];

  it('returns all candidates unchanged for an empty query', () => {
    assert.deepEqual(filterWorkspaceCandidates('', candidates), candidates);
  });

  it('ranks prefix matches on the root path first', () => {
    const out = filterWorkspaceCandidates('c:/users/dev/myshell', candidates);
    assert.equal(out[0]?.root, 'C:/Users/dev/myshell-tools');
  });

  it('is deterministic for a given query', () => {
    const a = filterWorkspaceCandidates('myshell', candidates);
    const b = filterWorkspaceCandidates('myshell', candidates);
    assert.deepEqual(a, b);
  });

  it('excludes candidates with no match at all', () => {
    const out = filterWorkspaceCandidates('zzz-no-match', candidates);
    assert.deepEqual(out, []);
  });
});
