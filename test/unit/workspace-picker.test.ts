/**
 * Unit tests for the workspace picker's candidate + filter pipeline (Slice 7),
 * combining rankWorkspaceCandidates + filterWorkspaceCandidates from
 * src/interface/workspace.ts the way a picker UI would: rank once per turn, then
 * re-filter on every keystroke of the query.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  rankWorkspaceCandidates,
  filterWorkspaceCandidates,
  type PriorWorkspaceEntry,
} from '../../src/interface/workspace.ts';

function samplePriorWorkspaces(): PriorWorkspaceEntry[] {
  return [
    { workspaceRoot: 'C:/Users/dev/alpha-project', updatedAt: '2026-02-10T00:00:00.000Z' },
    { workspaceRoot: 'C:/Users/dev/beta-project', updatedAt: '2026-05-20T00:00:00.000Z' },
    { workspaceRoot: 'C:/Users/dev/repo', updatedAt: '2026-06-01T00:00:00.000Z' },
    { workspaceRoot: null, updatedAt: '2026-06-05T00:00:00.000Z' },
  ];
}

describe('workspace picker - rank then filter pipeline', () => {
  it('with an empty query, shows the ranked list unchanged (current root first)', () => {
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', samplePriorWorkspaces(), {
      maxParentDepth: 1,
    });
    const shown = filterWorkspaceCandidates('', candidates);
    assert.equal(shown[0]?.root, 'C:/Users/dev/repo');
    assert.deepEqual(shown, candidates);
  });

  it('narrows to matching candidates as the query grows, staying deterministic', () => {
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', samplePriorWorkspaces(), {
      maxParentDepth: 1,
    });
    const afterB = filterWorkspaceCandidates('beta', candidates);
    assert.equal(afterB.length, 1);
    assert.equal(afterB[0]?.root, 'C:/Users/dev/beta-project');

    const afterB2 = filterWorkspaceCandidates('beta', candidates);
    assert.deepEqual(afterB, afterB2);
  });

  it('a query matching multiple candidates preserves rank order among matches', () => {
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', samplePriorWorkspaces(), {
      maxParentDepth: 1,
    });
    // 'project' matches alpha-project and beta-project; beta ranks higher
    // (more recently updated), so it should stay first after filtering too.
    const shown = filterWorkspaceCandidates('project', candidates);
    const roots = shown.map((c) => c.root);
    assert.deepEqual(roots, ['C:/Users/dev/beta-project', 'C:/Users/dev/alpha-project']);
  });

  it('a query matching nothing yields an empty picker list, not a throw', () => {
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', samplePriorWorkspaces(), {
      maxParentDepth: 1,
    });
    const shown = filterWorkspaceCandidates('no-such-workspace-xyz', candidates);
    assert.deepEqual(shown, []);
  });

  it('the current root always appears exactly once even if also a prior workspace', () => {
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', samplePriorWorkspaces(), {
      maxParentDepth: 0,
    });
    const repoHits = candidates.filter((c) => c.root === 'C:/Users/dev/repo');
    assert.equal(repoHits.length, 1);
  });

  it('null workspaceRoot entries never surface as candidates', () => {
    const candidates = rankWorkspaceCandidates('C:/Users/dev/repo', samplePriorWorkspaces(), {
      maxParentDepth: 0,
    });
    assert.ok(candidates.every((c) => typeof c.root === 'string' && c.root.length > 0));
    assert.equal(candidates.length, 3); // repo (current+dedup), alpha, beta
  });
});
