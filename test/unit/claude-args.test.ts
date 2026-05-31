/**
 * test/unit/claude-args.test.ts — unit tests for Claude CLI arg construction,
 * including the EXPERIMENTAL native-session flags. Pure: no spawn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeArgs } from '../../src/providers/claude.ts';
import type { ProviderRequest } from '../../src/providers/port.ts';

function makeReq(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'claude-sonnet-4-6',
    prompt: 'do the thing',
    cwd: '/tmp',
    sandbox: 'workspace-write',
    timeoutMs: 120000,
    ...overrides,
  };
}

describe('buildClaudeArgs', () => {
  it('builds the stateless one-shot args by default (no session flags)', () => {
    const args = buildClaudeArgs(makeReq());
    assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet']);
    assert.ok(!args.includes('--session-id'), 'no --session-id when sessionId is unset');
    assert.ok(!args.includes('--resume'), 'no --resume when sessionId is unset');
  });

  it('maps concrete model ids to CLI aliases', () => {
    assert.ok(buildClaudeArgs(makeReq({ model: 'claude-opus-4-7' })).includes('opus'));
    assert.ok(buildClaudeArgs(makeReq({ model: 'claude-haiku-4-5' })).includes('haiku'));
  });

  it('uses --session-id to ESTABLISH a session (resume=false)', () => {
    const args = buildClaudeArgs(makeReq({ sessionId: 'conv-1', resume: false }));
    const i = args.indexOf('--session-id');
    assert.ok(i >= 0, 'should include --session-id');
    assert.strictEqual(args[i + 1], 'conv-1');
    assert.ok(!args.includes('--resume'), 'must not also pass --resume when establishing');
  });

  it('uses --resume to CONTINUE a session (resume=true)', () => {
    const args = buildClaudeArgs(makeReq({ sessionId: 'conv-1', resume: true }));
    const i = args.indexOf('--resume');
    assert.ok(i >= 0, 'should include --resume');
    assert.strictEqual(args[i + 1], 'conv-1');
    assert.ok(!args.includes('--session-id'), 'must not also pass --session-id when resuming');
  });

  it('ignores an empty sessionId (treated as stateless)', () => {
    const args = buildClaudeArgs(makeReq({ sessionId: '', resume: true }));
    assert.ok(!args.includes('--resume') && !args.includes('--session-id'));
  });

  // ---- Sandbox / privilege ladder ----------------------------------------

  it('read-only removes mutation/execution tools via --disallowedTools', () => {
    const args = buildClaudeArgs(makeReq({ sandbox: 'read-only' }));
    const i = args.indexOf('--disallowedTools');
    assert.ok(i >= 0, 'read-only must pass --disallowedTools');
    const tools = args.slice(i + 1);
    for (const t of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
      assert.ok(tools.includes(t), `read-only must disallow ${t}`);
    }
    assert.ok(!args.includes('bypassPermissions'), 'read-only must not bypass permissions');
  });

  it('workspace-write adds no permission flag (default headless behavior)', () => {
    const args = buildClaudeArgs(makeReq({ sandbox: 'workspace-write' }));
    assert.ok(!args.includes('--disallowedTools'), 'workspace-write must not restrict tools');
    assert.ok(!args.includes('--permission-mode'), 'workspace-write must not set a permission mode');
  });

  it('full-access opts into --permission-mode bypassPermissions (never --dangerously-skip-permissions)', () => {
    const args = buildClaudeArgs(makeReq({ sandbox: 'full-access' }));
    const i = args.indexOf('--permission-mode');
    assert.ok(i >= 0, 'full-access must set a permission mode');
    assert.strictEqual(args[i + 1], 'bypassPermissions');
    assert.ok(
      !args.includes('--dangerously-skip-permissions'),
      'must never pass the dangerous skip flag',
    );
  });

  it('--disallowedTools is appended LAST (it is variadic)', () => {
    const args = buildClaudeArgs(makeReq({ sandbox: 'read-only', sessionId: 'c1', resume: true }));
    // The session flags must precede the variadic --disallowedTools.
    assert.ok(args.indexOf('--resume') < args.indexOf('--disallowedTools'));
    assert.strictEqual(args[args.length - 1], 'Bash', 'tool list is the tail of argv');
  });
});
