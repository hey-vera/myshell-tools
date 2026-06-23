import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { repoCacheKey, repoStateChanged, type RepoFingerprint } from '../../src/core/repo-identity.ts';

describe('repoCacheKey', () => {
  it('is deterministic for the same project key and fingerprint', () => {
    const fp: RepoFingerprint = { headSha: 'abc123', treeHash: 'def456' };

    assert.equal(repoCacheKey('project#1', fp), repoCacheKey('project#1', fp));
  });

  it('changes when the project key changes', () => {
    const fp: RepoFingerprint = { headSha: 'abc123', treeHash: 'def456' };

    assert.notEqual(repoCacheKey('project#1', fp), repoCacheKey('project#2', fp));
  });

  it('changes when headSha changes', () => {
    assert.notEqual(
      repoCacheKey('project#1', { headSha: 'abc123', treeHash: 'def456' }),
      repoCacheKey('project#1', { headSha: 'abc124', treeHash: 'def456' }),
    );
  });

  it('changes when treeHash changes', () => {
    assert.notEqual(
      repoCacheKey('project#1', { headSha: 'abc123', treeHash: 'def456' }),
      repoCacheKey('project#1', { headSha: 'abc123', treeHash: 'def457' }),
    );
  });

  it('uses empty sentinels for non-git fingerprints while staying project scoped', () => {
    assert.equal(repoCacheKey('project#1', { headSha: '', treeHash: '' }), 'project#1@∅~∅');
    assert.notEqual(
      repoCacheKey('project#1', { headSha: '', treeHash: '' }),
      repoCacheKey('project#2', { headSha: '', treeHash: '' }),
    );
  });
});

describe('repoStateChanged', () => {
  it('returns false for identical fingerprints', () => {
    assert.equal(
      repoStateChanged({ headSha: 'abc123', treeHash: 'def456' }, { headSha: 'abc123', treeHash: 'def456' }),
      false,
    );
  });

  it('returns true when headSha differs', () => {
    assert.equal(
      repoStateChanged({ headSha: 'abc123', treeHash: 'def456' }, { headSha: 'abc124', treeHash: 'def456' }),
      true,
    );
  });

  it('returns true when treeHash differs', () => {
    assert.equal(
      repoStateChanged({ headSha: 'abc123', treeHash: 'def456' }, { headSha: 'abc123', treeHash: 'def457' }),
      true,
    );
  });
});
