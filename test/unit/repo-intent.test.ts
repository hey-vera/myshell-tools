import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { inferRepoIntent } from '../../src/core/repo-intent.ts';

const cases: ReadonlyArray<readonly [string, ReturnType<typeof inferRepoIntent>['operation']]> = [
  ['undo that', 'undo_last_ai_change'],
  ['undo the last edit', 'undo_last_ai_change'],
  ['please revert the last change', 'undo_last_ai_change'],
  ['roll back what you just did', 'undo_last_ai_change'],
  ['back out the auth patch', 'undo_last_ai_change'],
  ['go back before that refactor', 'undo_last_ai_change'],
  ['put it back how it was', 'undo_last_ai_change'],
  ['restore the previous version', 'undo_last_ai_change'],
  ['what changed?', 'summarize_diff'],
  ['what did you change?', 'summarize_diff'],
  ['show me the diff', 'summarize_diff'],
  ['diff please', 'summarize_diff'],
  ['show me the changes', 'summarize_diff'],
  ['summarize the changes', 'summarize_diff'],
  ['give me a change summary', 'summarize_diff'],
  ['commit this', 'commit_current_ai_change'],
  ['commit the changes', 'commit_current_ai_change'],
  ['make a commit for the fix', 'commit_current_ai_change'],
  ['create a commit', 'commit_current_ai_change'],
  ['git commit this', 'commit_current_ai_change'],
  ['save this change', 'commit_current_ai_change'],
  ['checkpoint this work', 'commit_current_ai_change'],
  ['run the tests', 'verify_only'],
  ['run checks', 'verify_only'],
  ['test this please', 'verify_only'],
  ['verify the work', 'verify_only'],
  ['typecheck it', 'verify_only'],
  ['lint the repo', 'verify_only'],
  ['make sure it passes', 'verify_only'],
  ['get the suite green', 'verify_only'],
  ['fix the failing auth test', 'edit_and_verify'],
  ['repair the broken menu flow and run tests', 'edit_and_verify'],
  ['implement the login retry', 'edit_and_verify'],
  ['actualize the undo checkpoint', 'edit_and_verify'],
  ['wire the new status receipt', 'edit_and_verify'],
  ['build the repo editing layer', 'edit_and_verify'],
  ['change the config parser', 'edit_and_verify'],
  ['update the README badge', 'edit_and_verify'],
  ['refactor provider detection', 'edit_and_verify'],
  ['cleanup the dead branch', 'edit_and_verify'],
  ['add support for pyproject tests', 'edit_and_verify'],
  ['remove the stale code', 'edit_and_verify'],
  ['make the CLI work again', 'edit_and_verify'],
  ['plan the auth migration', 'plan_only'],
  ['design the undo strategy', 'plan_only'],
  ['think through the approach', 'plan_only'],
  ['use claude for this one', 'provider_steering'],
  ['with codex please', 'provider_steering'],
  ['ask grok for a second opinion', 'provider_steering'],
  ['try another model', 'provider_steering'],
  ['status', 'status'],
  ["what's left?", 'status'],
  ['where are we on this repo?', 'status'],
  ['is the repo clean?', 'status'],
  // P1.6 thin — GitHub PR status (must not collapse to local git status)
  ['pr status', 'github_pr_status'],
  ["what's the PR status", 'github_pr_status'],
  ['what is the pull request status?', 'github_pr_status'],
  ['github status', 'github_pr_status'],
  ['github pr status', 'github_pr_status'],
  ['status of the pr', 'github_pr_status'],
  ['show me the pr status', 'github_pr_status'],
  ['how is the pr?', 'github_pr_status'],
  ['current pr', 'github_pr_status'],
  // P1.6 thin extension — GitHub PR checks (must not steal "pr status" / create / local status)
  ['pr checks', 'github_pr_checks'],
  ['check status', 'github_pr_checks'],
  ['ci status', 'github_pr_checks'],
  ['github checks', 'github_pr_checks'],
  ['gh pr checks', 'github_pr_checks'],
  ['are checks green', 'github_pr_checks'],
  ['are the checks green?', 'github_pr_checks'],
  ['show me the checks', 'github_pr_checks'],
  ['how are the checks', 'github_pr_checks'],
  ['status of the checks', 'github_pr_checks'],
  // P1.6 thin extension — GitHub PR review (must not steal status / checks / create)
  ['pr review', 'github_pr_review'],
  ['pull request review', 'github_pr_review'],
  ['show reviews', 'github_pr_review'],
  ['show me the reviews', 'github_pr_review'],
  ['review comments', 'github_pr_review'],
  ['pr feedback', 'github_pr_review'],
  ['github reviews', 'github_pr_review'],
  ['pr comments', 'github_pr_review'],
  ['feedback on the pr', 'github_pr_review'],
  ['gh pr view comments', 'github_pr_review'],
  // P1.6 thin extension — GitHub PR create (must not steal "pr status")
  ['create a pr', 'github_pr_create'],
  ['create a pull request', 'github_pr_create'],
  ['open a pr', 'github_pr_create'],
  ['open a pull request', 'github_pr_create'],
  ['make a pr', 'github_pr_create'],
  ['submit a pull request', 'github_pr_create'],
  ['new pr', 'github_pr_create'],
  ['gh pr create', 'github_pr_create'],
  ['pr create', 'github_pr_create'],
  ['create a pr for the fix', 'github_pr_create'],
  // P1.7 thin — GitLab MR status
  ['mr status', 'gitlab_mr_status'],
  ["what's the MR status", 'gitlab_mr_status'],
  ['gitlab status', 'gitlab_mr_status'],
  ['list the merge requests', 'gitlab_mr_status'],
  ['how is the mr?', 'gitlab_mr_status'],
  // P1.7 thin extension — GitLab MR create (must not steal "mr status" / "mr list")
  ['create a mr', 'gitlab_mr_create'],
  ['create a merge request', 'gitlab_mr_create'],
  ['open a mr', 'gitlab_mr_create'],
  ['open a merge request', 'gitlab_mr_create'],
  ['make a mr', 'gitlab_mr_create'],
  ['submit a merge request', 'gitlab_mr_create'],
  ['new mr', 'gitlab_mr_create'],
  ['glab mr create', 'gitlab_mr_create'],
  ['mr create', 'gitlab_mr_create'],
  ['create a mr for the fix', 'gitlab_mr_create'],
];

describe('inferRepoIntent', () => {
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(inferRepoIntent(input).operation, expected);
    });
  }

  it('sets workspace mutation and verification posture', () => {
    assert.equal(inferRepoIntent('fix the failing test').mutatesWorkspace, true);
    assert.equal(inferRepoIntent('fix the failing test').needsVerification, true);
    assert.equal(inferRepoIntent('what changed?').mutatesWorkspace, false);
    assert.equal(inferRepoIntent('run tests').needsVerification, true);
    assert.equal(inferRepoIntent('create a pr').mutatesWorkspace, true);
    assert.equal(inferRepoIntent('create a mr').mutatesWorkspace, true);
    assert.equal(inferRepoIntent('pr status').mutatesWorkspace, false);
    assert.equal(inferRepoIntent('mr status').mutatesWorkspace, false);
    assert.equal(inferRepoIntent('pr checks').mutatesWorkspace, false);
    assert.equal(inferRepoIntent('ci status').mutatesWorkspace, false);
    assert.equal(inferRepoIntent('pr review').mutatesWorkspace, false);
    assert.equal(inferRepoIntent('review comments').mutatesWorkspace, false);
  });

  it('extracts constraints from natural language steering', () => {
    const result = inferRepoIntent(
      'fix the auth tests with codex, small patch only, no new dependencies, do not touch UI, run unit tests, do not commit',
    );
    assert.equal(result.operation, 'edit_and_verify');
    assert.deepEqual(
      result.constraints.map((c) => `${c.kind}:${c.text}`).sort(),
      [
        'do_not_commit:do not commit',
        'exclude_ui:do not touch UI',
        'no_new_dependencies:no new dependencies',
        'provider_steering:codex',
        'small_patch:small patch',
        'test_scope:unit',
      ],
    );
  });

  it('keeps ordinary chat as no repo operation', () => {
    const result = inferRepoIntent('hmm interesting');
    assert.equal(result.operation, 'none');
    assert.equal(result.confidence, 'low');
  });
});
