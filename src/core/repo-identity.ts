export interface RepoFingerprint {
  readonly headSha: string;
  readonly treeHash: string;
}

const EMPTY_REPO_PART = '∅';

/** Stable cache key combining the project identity with the repo state. */
export function repoCacheKey(projectKey: string, fp: RepoFingerprint): string {
  return `${projectKey}@${fp.headSha || EMPTY_REPO_PART}~${fp.treeHash || EMPTY_REPO_PART}`;
}

/** True when two fingerprints describe a DIFFERENT repo state (HEAD or tree changed). */
export function repoStateChanged(a: RepoFingerprint, b: RepoFingerprint): boolean {
  return a.headSha !== b.headSha || a.treeHash !== b.treeHash;
}
