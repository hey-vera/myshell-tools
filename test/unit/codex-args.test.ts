/**
 * test/unit/codex-args.test.ts — unit tests for Codex CLI arg construction,
 * including the EXPERIMENTAL native-session resume form. Pure: no spawn.
 */

import { describe, it } from 'vitest';
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

describe('buildCodexArgs — reasoning effort (capability registry §5)', () => {
  it('omits model_reasoning_effort when reasoningEffort is absent (byte-for-byte unchanged)', () => {
    const args = buildCodexArgs(makeReq());
    assert.ok(
      !args.some((a) => a.startsWith('model_reasoning_effort')),
      'no effort flag when none was selected',
    );
    assert.ok(!args.includes('-c'), 'no -c override at all when no effort');
  });

  it('appends `-c model_reasoning_effort=xhigh` when reasoningEffort is xhigh', () => {
    const args = buildCodexArgs(makeReq({ reasoningEffort: 'xhigh' }));
    const i = args.indexOf('-c');
    assert.ok(i >= 0, 'a -c override is present');
    assert.strictEqual(args[i + 1], 'model_reasoning_effort=xhigh');
  });

  it('appends the flag for each supported effort level', () => {
    for (const e of ['low', 'medium', 'high'] as const) {
      const args = buildCodexArgs(makeReq({ reasoningEffort: e }));
      assert.ok(
        args.includes('-c') && args.includes(`model_reasoning_effort=${e}`),
        `effort=${e} threads the flag`,
      );
    }
  });

  it('omits the flag for the degenerate `none` effort (never emits =none)', () => {
    const args = buildCodexArgs(makeReq({ reasoningEffort: 'none' }));
    assert.ok(
      !args.some((a) => a.startsWith('model_reasoning_effort')),
      'no reasoning flag for none',
    );
  });

  it('threads the flag on a resume invocation too', () => {
    const args = buildCodexArgs(makeReq({ sessionId: 't1', resume: true, reasoningEffort: 'high' }));
    assert.strictEqual(args[0], 'exec');
    assert.strictEqual(args[1], 'resume');
    assert.ok(args.includes('model_reasoning_effort=high'));
  });
});

describe('buildCodexArgs — native web search (provider-capability audit #3)', () => {
  // `codex exec` REJECTS top-level `--search`; web search is enabled via the config
  // override `-c tools.web_search=true` (CLI-verified with --strict-config).
  it('omits tools.web_search when webSearch is absent (byte-for-byte unchanged)', () => {
    const args = buildCodexArgs(makeReq());
    assert.ok(!args.some((a) => a.startsWith('tools.web_search')), 'no web_search override by default');
  });

  it('omits tools.web_search when webSearch is false', () => {
    const args = buildCodexArgs(makeReq({ webSearch: false }));
    assert.ok(!args.some((a) => a.startsWith('tools.web_search')));
  });

  it('appends `-c tools.web_search=true` when webSearch+search-capable model', () => {
    // gpt-5.5 declares supportsSearchTool:true in the registry.
    const args = buildCodexArgs(makeReq({ model: 'gpt-5.5', webSearch: true }));
    const i = args.indexOf('tools.web_search=true');
    assert.ok(i > 0, 'web_search override present');
    assert.strictEqual(args[i - 1], '-c', 'it is a -c config override');
  });

  it('enables web search for an unknown codex model (no registry entry) since the CLI tool exists', () => {
    const args = buildCodexArgs(makeReq({ model: 'gpt-5-codex', webSearch: true }));
    assert.ok(args.includes('tools.web_search=true'), 'unknown model still allows the tool');
  });

  it('threads tools.web_search alongside model_reasoning_effort', () => {
    const args = buildCodexArgs(makeReq({ model: 'gpt-5.5', webSearch: true, reasoningEffort: 'high' }));
    assert.ok(args.includes('model_reasoning_effort=high'));
    assert.ok(args.includes('tools.web_search=true'));
  });
});
