/**
 * test/unit/grok-args.test.ts — unit tests for Grok CLI arg construction.
 * Pure: no spawn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildGrokArgs } from '../../src/providers/grok.ts';
import type { ProviderRequest } from '../../src/providers/port.ts';

function makeReq(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'grok-build',
    prompt: 'do the thing',
    cwd: '/tmp',
    sandbox: 'workspace-write',
    timeoutMs: 120000,
    ...overrides,
  };
}

describe('buildGrokArgs', () => {
  it('builds the stateless one-shot args by default', () => {
    const args = buildGrokArgs(makeReq());
    assert.deepEqual(args, [
      '--single',
      '--output-format',
      'streaming-json',
      '-m',
      'grok-build',
      '--disable-web-search',
      '--permission-mode',
      'acceptEdits',
    ]);
    assert.ok(!args.includes('--resume'), 'no --resume when sessionId is unset');
    assert.ok(!args.includes('--session-id'), 'no --session-id when sessionId is unset');
  });

  it('passes the concrete model id through unchanged', () => {
    const args = buildGrokArgs(makeReq({ model: 'grok-4.3' }));
    assert.ok(args.includes('grok-4.3'));
  });

  it('uses --session-id to ESTABLISH a session (resume=false)', () => {
    const args = buildGrokArgs(makeReq({ sessionId: 'conv-1', resume: false }));
    const i = args.indexOf('--session-id');
    assert.ok(i >= 0, 'should include --session-id');
    assert.strictEqual(args[i + 1], 'conv-1');
    assert.ok(!args.includes('--resume'), 'must not also pass --resume when establishing');
  });

  it('uses --resume to CONTINUE a session (resume=true)', () => {
    const args = buildGrokArgs(makeReq({ sessionId: 'conv-1', resume: true }));
    const i = args.indexOf('--resume');
    assert.ok(i >= 0, 'should include --resume');
    assert.strictEqual(args[i + 1], 'conv-1');
    assert.ok(!args.includes('--session-id'), 'must not also pass --session-id when resuming');
  });

  it('ignores an empty sessionId (treated as stateless)', () => {
    const args = buildGrokArgs(makeReq({ sessionId: '', resume: true }));
    assert.ok(!args.includes('--resume') && !args.includes('--session-id'));
  });

  // ---- Reasoning effort (--effort) -----------------------------------------

  it('appends --effort <level> when reasoningEffort is set (grok supports max)', () => {
    const args = buildGrokArgs(makeReq({ reasoningEffort: 'max' }));
    const i = args.indexOf('--effort');
    assert.ok(i >= 0, 'should include --effort');
    assert.strictEqual(args[i + 1], 'max');
  });

  it('appends --effort xhigh when that level is selected', () => {
    const args = buildGrokArgs(makeReq({ reasoningEffort: 'xhigh' }));
    const i = args.indexOf('--effort');
    assert.strictEqual(args[i + 1], 'xhigh');
  });

  it('OMITS --effort when reasoningEffort is absent', () => {
    assert.ok(!buildGrokArgs(makeReq()).includes('--effort'));
  });

  it("OMITS --effort when reasoningEffort is 'none'", () => {
    assert.ok(!buildGrokArgs(makeReq({ reasoningEffort: 'none' })).includes('--effort'));
  });

  it('--effort precedes the permission-mode flag', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'read-only', reasoningEffort: 'high' }));
    assert.ok(args.indexOf('--effort') < args.indexOf('--permission-mode'));
  });

  // ---- Sandbox / privilege ladder ------------------------------------------

  it('read-only uses --permission-mode restrictive', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'read-only' }));
    const i = args.indexOf('--permission-mode');
    assert.ok(i >= 0, 'read-only must set a permission mode');
    assert.strictEqual(args[i + 1], 'restrictive');
    assert.ok(!args.includes('bypassPermissions'), 'read-only must not bypass permissions');
  });

  it('workspace-write uses --permission-mode acceptEdits', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'workspace-write' }));
    const i = args.indexOf('--permission-mode');
    assert.ok(i >= 0, 'workspace-write must set a permission mode');
    assert.strictEqual(args[i + 1], 'acceptEdits');
  });

  it('full-access uses --permission-mode bypassPermissions', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'full-access' }));
    const i = args.indexOf('--permission-mode');
    assert.ok(i >= 0, 'full-access must set a permission mode');
    assert.strictEqual(args[i + 1], 'bypassPermissions');
  });

  // ---- Web search (inverse of claude) --------------------------------------

  it('adds --disable-web-search by default (grok search is opt-out)', () => {
    const args = buildGrokArgs(makeReq());
    assert.ok(args.includes('--disable-web-search'));
  });

  it('OMITS --disable-web-search when webSearch is explicitly requested', () => {
    const args = buildGrokArgs(makeReq({ webSearch: true }));
    assert.ok(!args.includes('--disable-web-search'));
  });

  it('keeps --disable-web-search when webSearch is explicitly false', () => {
    const args = buildGrokArgs(makeReq({ webSearch: false }));
    assert.ok(args.includes('--disable-web-search'));
  });
});
