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
      '--output-format',
      'streaming-json',
      '-m',
      'grok-build',
      '--disable-web-search',
      '--sandbox',
      'workspace',
      '--permission-mode',
      'acceptEdits',
    ]);
    assert.ok(!args.includes('--single'), '--single does not combine with --prompt-file');
    assert.ok(!args.includes('--resume'), 'no --resume when sessionId is unset');
    assert.ok(!args.includes('--session-id'), 'no --session-id when sessionId is unset');
  });

  it('passes the concrete model id through unchanged', () => {
    const args = buildGrokArgs(makeReq({ model: 'grok-composer-2.5-fast' }));
    assert.ok(args.includes('grok-composer-2.5-fast'));
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

  // ---- Reasoning effort (--effort, MYSHELL_PROVIDER_EFFORT gate) -----------
  //
  // DEFAULT OFF: when effortEnabled is absent/false (the default), NO --effort
  // flag is emitted — byte-for-byte unchanged. Tests must pass effortEnabled=true
  // to exercise the on-path.

  it('DEFAULT OFF: OMITS --effort even when reasoningEffort is set (flag not enabled)', () => {
    // This is the byte-identity invariant: default-off means no --effort emitted.
    const args = buildGrokArgs(makeReq({ reasoningEffort: 'max' }));
    assert.ok(!args.includes('--effort'), 'no --effort by default (flag off)');
  });

  it('DEFAULT OFF: OMITS --effort for any effort level (flag not enabled)', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = buildGrokArgs(makeReq({ reasoningEffort: effort }));
      assert.ok(!args.includes('--effort'), `no --effort for ${effort} when flag off`);
    }
  });

  it('FLAG ON: appends --effort <level> when reasoningEffort is set and effortEnabled=true (max)', () => {
    const args = buildGrokArgs(makeReq({ reasoningEffort: 'max' }), true);
    const i = args.indexOf('--effort');
    assert.ok(i >= 0, 'should include --effort when flag on');
    assert.strictEqual(args[i + 1], 'max');
  });

  it('FLAG ON: appends --effort xhigh when that level is selected and effortEnabled=true', () => {
    const args = buildGrokArgs(makeReq({ reasoningEffort: 'xhigh' }), true);
    const i = args.indexOf('--effort');
    assert.ok(i >= 0, 'should include --effort when flag on');
    assert.strictEqual(args[i + 1], 'xhigh');
  });

  it('FLAG ON: maps all supported effort levels correctly', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const effort of levels) {
      const args = buildGrokArgs(makeReq({ reasoningEffort: effort }), true);
      const i = args.indexOf('--effort');
      assert.ok(i >= 0, `--effort should be present for ${effort} when flag on`);
      assert.strictEqual(args[i + 1], effort, `effort value should be ${effort}`);
    }
  });

  it('OMITS --effort when reasoningEffort is absent (byte-for-byte unchanged, flag on or off)', () => {
    assert.ok(!buildGrokArgs(makeReq()).includes('--effort'), 'no --effort when absent, flag off');
    assert.ok(!buildGrokArgs(makeReq(), true).includes('--effort'), 'no --effort when absent, flag on');
  });

  it("OMITS --effort when reasoningEffort is 'none' (no real thinking effort, flag on or off)", () => {
    assert.ok(!buildGrokArgs(makeReq({ reasoningEffort: 'none' })).includes('--effort'), 'flag off');
    assert.ok(!buildGrokArgs(makeReq({ reasoningEffort: 'none' }), true).includes('--effort'), 'flag on, none');
  });

  it('FLAG ON: --effort precedes the permission-mode flag', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'read-only', reasoningEffort: 'high' }), true);
    assert.ok(args.indexOf('--effort') < args.indexOf('--permission-mode'));
  });

  // ---- Sandbox / privilege ladder ------------------------------------------

  it('read-only uses --sandbox read-only + non-prompting --permission-mode dontAsk', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'read-only' }));
    const s = args.indexOf('--sandbox');
    assert.strictEqual(args[s + 1], 'read-only');
    const i = args.indexOf('--permission-mode');
    assert.strictEqual(args[i + 1], 'dontAsk');
    assert.ok(!args.includes('bypassPermissions'), 'read-only must not bypass permissions');
    assert.ok(!args.includes('restrictive'), 'restrictive is not a valid grok permission mode');
  });

  it('workspace-write uses --sandbox workspace + --permission-mode acceptEdits', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'workspace-write' }));
    assert.strictEqual(args[args.indexOf('--sandbox') + 1], 'workspace');
    assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  });

  it('full-access uses --sandbox off + --permission-mode bypassPermissions', () => {
    const args = buildGrokArgs(makeReq({ sandbox: 'full-access' }));
    assert.strictEqual(args[args.indexOf('--sandbox') + 1], 'off');
    assert.strictEqual(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
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
