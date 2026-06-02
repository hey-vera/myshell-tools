/**
 * test/unit/codex-args.test.ts — unit tests for Codex CLI arg construction,
 * including the EXPERIMENTAL native-session resume form. Pure: no spawn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildCodexArgs } from '../../src/providers/codex.ts';
import type { ProviderRequest } from '../../src/providers/port.ts';

function makeReq(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'gpt-5-codex',
    prompt: 'do the thing',
    cwd: '/tmp',
    sandbox: 'workspace-write',
    timeoutMs: 120000,
    ...overrides,
  };
}

describe('buildCodexArgs', () => {
  it('builds a one-shot `exec` by default (no resume)', () => {
    const args = buildCodexArgs(makeReq());
    // --skip-git-repo-check lets codex run outside a git repo (claude has no such
    // gate); the --sandbox level is the real privilege boundary.
    assert.deepEqual(args, ['exec', '--json', '-m', 'gpt-5-codex', '--sandbox', 'workspace-write', '--skip-git-repo-check']);
    assert.ok(!args.includes('resume'), 'no resume subcommand by default');
  });

  it('maps sandbox levels to --sandbox values', () => {
    assert.ok(buildCodexArgs(makeReq({ sandbox: 'read-only' })).includes('read-only'));
    assert.ok(buildCodexArgs(makeReq({ sandbox: 'full-access' })).includes('danger-full-access'));
  });

  it('uses `exec resume <id>` when resuming a captured thread', () => {
    const args = buildCodexArgs(makeReq({ sessionId: 'thread-42', resume: true }));
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-42']);
    assert.ok(args.includes('--json'), 'resume must still request --json output (we parse it)');
  });

  it('does NOT resume when sessionId is set but resume is not true (establish a fresh thread)', () => {
    const args = buildCodexArgs(makeReq({ sessionId: 'thread-42', resume: false }));
    assert.strictEqual(args[0], 'exec');
    assert.ok(!args.includes('resume'), 'no resume subcommand when resume!==true');
  });

  it('ignores an empty sessionId', () => {
    const args = buildCodexArgs(makeReq({ sessionId: '', resume: true }));
    assert.ok(!args.includes('resume'));
  });
});
