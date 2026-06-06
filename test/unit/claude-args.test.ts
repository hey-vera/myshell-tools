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
    // --max-budget-usd is a global runaway safety rail on every `claude -p` run
    // (the CLI has no --max-turns), so it is part of the default arg set. The
    // default sandbox is workspace-write → --permission-mode acceptEdits (appended
    // last), without which headless writes would deadlock on permission prompts.
    assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--max-budget-usd', '25', '--permission-mode', 'acceptEdits']);
    assert.ok(!args.includes('--session-id'), 'no --session-id when sessionId is unset');
    assert.ok(!args.includes('--resume'), 'no --resume when sessionId is unset');
  });

  it('NEVER adds the codex web_search override even when webSearch is set (Codex-only feature)', () => {
    const args = buildClaudeArgs(makeReq({ webSearch: true }));
    assert.ok(!args.some((a) => a.includes('web_search')), 'claude args must not carry tools.web_search');
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

  // ---- Reasoning effort (--effort) ---------------------------------------

  it('appends --effort <level> when reasoningEffort is set (Claude supports max)', () => {
    const args = buildClaudeArgs(makeReq({ reasoningEffort: 'max' }));
    const i = args.indexOf('--effort');
    assert.ok(i >= 0, 'should include --effort');
    assert.strictEqual(args[i + 1], 'max');
  });

  it('appends --effort xhigh when that level is selected', () => {
    const args = buildClaudeArgs(makeReq({ reasoningEffort: 'xhigh' }));
    const i = args.indexOf('--effort');
    assert.strictEqual(args[i + 1], 'xhigh');
  });

  it('OMITS --effort when reasoningEffort is absent (byte-for-byte unchanged)', () => {
    assert.ok(!buildClaudeArgs(makeReq()).includes('--effort'));
  });

  it("OMITS --effort when reasoningEffort is 'none' (no real thinking effort)", () => {
    assert.ok(!buildClaudeArgs(makeReq({ reasoningEffort: 'none' })).includes('--effort'));
  });

  it('--effort precedes the variadic --disallowedTools (effort is not the tail)', () => {
    const args = buildClaudeArgs(makeReq({ sandbox: 'read-only', reasoningEffort: 'high' }));
    assert.ok(args.indexOf('--effort') < args.indexOf('--disallowedTools'));
    assert.strictEqual(args[args.length - 1], 'Bash', 'tool list is still the tail of argv');
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

  it('workspace-write uses --permission-mode acceptEdits (auto-accept edits, no deadlock)', () => {
    // REQUIRED: headless `-p` otherwise prompts before every write and deadlocks
    // (no human to approve), so autonomous file work never happens. acceptEdits
    // auto-accepts workspace edits without the full bypassPermissions of full-access.
    const args = buildClaudeArgs(makeReq({ sandbox: 'workspace-write' }));
    assert.ok(!args.includes('--disallowedTools'), 'workspace-write must not restrict tools');
    const i = args.indexOf('--permission-mode');
    assert.ok(i >= 0, 'workspace-write must set a permission mode');
    assert.equal(args[i + 1], 'acceptEdits', 'workspace-write must use acceptEdits (not bypassPermissions)');
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
