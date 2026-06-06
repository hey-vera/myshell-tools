/**
 * test/unit/opencode-args.test.ts — unit tests for `buildOpencodeArgs`, the pure
 * argv builder for `opencode run`. Covers the `--variant <level>` reasoning-effort
 * adapter (appended only when a supported effort is set; omitted otherwise) and the
 * existing -m / byte-for-byte default behaviour. Pure: no spawn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpencodeArgs } from '../../src/providers/opencode.ts';
import type { ProviderRequest } from '../../src/providers/port.ts';

function makeReq(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'opencode',
    prompt: 'hello',
    cwd: '/tmp',
    sandbox: 'workspace-write',
    timeoutMs: 120000,
    ...overrides,
  };
}

describe('buildOpencodeArgs — defaults (byte-for-byte unchanged)', () => {
  it('omits -m and --variant for the bare placeholder + no effort', () => {
    assert.deepEqual(buildOpencodeArgs(makeReq()), ['run', '--format', 'json']);
  });

  it('passes -m for a concrete provider/model id', () => {
    const args = buildOpencodeArgs(makeReq({ model: 'opencode-go/kimi-k2.6' }));
    assert.deepEqual(args, ['run', '--format', 'json', '-m', 'opencode-go/kimi-k2.6']);
  });

  it('NEVER adds the codex web_search override even when webSearch is set (Codex-only feature)', () => {
    const args = buildOpencodeArgs(makeReq({ webSearch: true }));
    assert.ok(!args.some((a) => a.includes('web_search')), 'opencode args must not carry tools.web_search');
  });
});

describe('buildOpencodeArgs — --variant reasoning-effort adapter', () => {
  it('appends --variant <level> for a supported effort', () => {
    for (const lvl of ['low', 'medium', 'high', 'max'] as const) {
      const args = buildOpencodeArgs(
        makeReq({ model: 'opencode/deepseek-v4-flash-free', reasoningEffort: lvl }),
      );
      assert.deepEqual(args.slice(-2), ['--variant', lvl], `effort ${lvl} → --variant ${lvl}`);
    }
  });

  it('appends --variant alongside -m when both are present', () => {
    const args = buildOpencodeArgs(
      makeReq({ model: 'opencode-go/kimi-k2.6', reasoningEffort: 'high' }),
    );
    assert.deepEqual(args, ['run', '--format', 'json', '-m', 'opencode-go/kimi-k2.6', '--variant', 'high']);
  });

  it('OMITS --variant for none (no reasoning)', () => {
    const args = buildOpencodeArgs(makeReq({ reasoningEffort: 'none' }));
    assert.ok(!args.includes('--variant'), 'none must not pass a variant');
    assert.deepEqual(args, ['run', '--format', 'json']);
  });

  it('OMITS --variant for xhigh (not an opencode variant level)', () => {
    const args = buildOpencodeArgs(
      makeReq({ model: 'opencode/deepseek-v4-flash-free', reasoningEffort: 'xhigh' }),
    );
    assert.ok(!args.includes('--variant'), 'xhigh is Claude-only; opencode has no such variant');
    assert.deepEqual(args, ['run', '--format', 'json', '-m', 'opencode/deepseek-v4-flash-free']);
  });

  it('OMITS --variant when reasoningEffort is absent', () => {
    const args = buildOpencodeArgs(makeReq({ model: 'opencode-go/kimi-k2.6' }));
    assert.ok(!args.includes('--variant'));
  });
});
