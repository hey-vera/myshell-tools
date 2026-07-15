/**
 * R4.2 — minimal adapter child env allowlist.
 */
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildProviderChildEnv,
  isProviderFullEnvEnabled,
  pickAllowlistedChildEnv,
  PROVIDER_FULL_ENV_FLAG,
  resetProviderFullEnvWarnForTests,
  resolveProviderParentEnv,
} from '../../src/providers/child-env.ts';
import { buildCodexEnv } from '../../src/providers/codex.ts';
import { buildGrokEnv } from '../../src/providers/grok.ts';
import { buildOpencodeEnv } from '../../src/providers/opencode.ts';
import { buildClaudeEnv } from '../../src/providers/claude.ts';
import type { ProviderRequest } from '../../src/providers/port.ts';

function baseReq(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    prompt: 'hi',
    cwd: '/tmp/ws',
    model: 'test',
    timeoutMs: 5_000,
    sandbox: 'read-only',
    ...over,
  };
}

afterEach(() => {
  resetProviderFullEnvWarnForTests();
});

describe('isProviderFullEnvEnabled', () => {
  it('defaults off', () => {
    assert.equal(isProviderFullEnvEnabled({}), false);
    assert.equal(isProviderFullEnvEnabled({ [PROVIDER_FULL_ENV_FLAG]: '0' }), false);
    assert.equal(isProviderFullEnvEnabled({ [PROVIDER_FULL_ENV_FLAG]: '' }), false);
  });

  it('opts in for 1/true/on/yes', () => {
    assert.equal(isProviderFullEnvEnabled({ [PROVIDER_FULL_ENV_FLAG]: '1' }), true);
    assert.equal(isProviderFullEnvEnabled({ [PROVIDER_FULL_ENV_FLAG]: 'true' }), true);
    assert.equal(isProviderFullEnvEnabled({ [PROVIDER_FULL_ENV_FLAG]: 'ON' }), true);
    assert.equal(isProviderFullEnvEnabled({ [PROVIDER_FULL_ENV_FLAG]: ' yes ' }), true);
  });
});

describe('pickAllowlistedChildEnv', () => {
  it('keeps PATH and HOME, strips secrets', () => {
    const out = pickAllowlistedChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/u',
        ANTHROPIC_API_KEY: 'sk-ant-leak',
        OPENAI_API_KEY: 'sk-openai',
        XAI_API_KEY: 'xai-secret',
        MY_SECRET: 'nope',
      },
      'claude',
    );
    assert.equal(out['PATH'], '/usr/bin');
    assert.equal(out['HOME'], '/home/u');
    assert.equal(out['ANTHROPIC_API_KEY'], undefined);
    assert.equal(out['OPENAI_API_KEY'], undefined);
    assert.equal(out['XAI_API_KEY'], undefined);
    assert.equal(out['MY_SECRET'], undefined);
  });

  it('preserves Windows Path key case (does not drop Path)', () => {
    const out = pickAllowlistedChildEnv(
      {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\josh',
        OPENAI_API_KEY: 'sk-no',
      },
      'codex',
    );
    assert.equal(out['Path'], 'C:\\Windows\\System32');
    assert.equal(out['SystemRoot'], 'C:\\Windows');
    assert.equal(out['USERPROFILE'], 'C:\\Users\\josh');
    assert.equal(out['OPENAI_API_KEY'], undefined);
  });

  it('allows provider home keys per adapter', () => {
    const claude = pickAllowlistedChildEnv(
      { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', GROK_HOME: '/g', XDG_DATA_HOME: '/o' },
      'claude',
    );
    assert.equal(claude['CLAUDE_CONFIG_DIR'], '/c');
    assert.equal(claude['CODEX_HOME'], undefined);
    assert.equal(claude['GROK_HOME'], undefined);

    const codex = pickAllowlistedChildEnv(
      { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' },
      'codex',
    );
    assert.equal(codex['CODEX_HOME'], '/x');
    assert.equal(codex['CLAUDE_CONFIG_DIR'], undefined);

    const grok = pickAllowlistedChildEnv({ GROK_HOME: '/g', XAI_API_KEY: 'no' }, 'grok');
    assert.equal(grok['GROK_HOME'], '/g');
    assert.equal(grok['XAI_API_KEY'], undefined);

    const oc = pickAllowlistedChildEnv(
      { XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/cfg', FOO: 'bar' },
      'opencode',
    );
    assert.equal(oc['XDG_DATA_HOME'], '/data');
    assert.equal(oc['XDG_CONFIG_HOME'], '/cfg');
    assert.equal(oc['FOO'], undefined);
  });
});

describe('buildProviderChildEnv', () => {
  it('applies accountEnv last over layers and base', () => {
    const env = buildProviderChildEnv({
      provider: 'codex',
      parentEnv: {
        PATH: '/usr/bin',
        CODEX_HOME: '/parent-codex',
        OPENAI_API_KEY: 'sk-leak',
      },
      layers: [{ CODEX_HOME: '/layer-codex', EXTRA_LAYER: 'L' }],
      accountEnv: { CODEX_HOME: '/account-codex' },
    });
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['CODEX_HOME'], '/account-codex');
    // Layer extras that are not in parent allowlist still merge (explicit layer)
    assert.equal(env['EXTRA_LAYER'], 'L');
    assert.equal(env['OPENAI_API_KEY'], undefined);
  });

  it('FULL_ENV=1 restores secrets from parent', () => {
    const env = buildProviderChildEnv({
      provider: 'claude',
      parentEnv: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant',
        [PROVIDER_FULL_ENV_FLAG]: '1',
      },
    });
    assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant');
    assert.equal(env['PATH'], '/usr/bin');
  });

  it('FULL_ENV warn is once per process', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      writes.push(String(chunk));
      return (orig as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    try {
      resolveProviderParentEnv({ [PROVIDER_FULL_ENV_FLAG]: '1', PATH: '/a' }, 'claude');
      resolveProviderParentEnv({ [PROVIDER_FULL_ENV_FLAG]: '1', PATH: '/b' }, 'codex');
      const hits = writes.filter((w) => w.includes('MYSHELL_PROVIDER_FULL_ENV'));
      assert.equal(hits.length, 1);
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('adapter env builders (R4.2)', () => {
  it('buildCodexEnv strips OPENAI_API_KEY; accountEnv wins', () => {
    const env = buildCodexEnv(baseReq({ accountEnv: { CODEX_HOME: '/acct' } }), {
      PATH: '/bin',
      HOME: '/home',
      CODEX_HOME: '/parent',
      OPENAI_API_KEY: 'sk-openai',
    });
    assert.equal(env['CODEX_HOME'], '/acct');
    assert.equal(env['OPENAI_API_KEY'], undefined);
    assert.equal(env['PATH'], '/bin');
  });

  it('buildGrokEnv strips XAI_API_KEY; accountEnv wins', () => {
    const env = buildGrokEnv(baseReq({ accountEnv: { GROK_HOME: '/acct-g' } }), {
      PATH: '/bin',
      GROK_HOME: '/parent-g',
      XAI_API_KEY: 'xai-no',
    });
    assert.equal(env['GROK_HOME'], '/acct-g');
    assert.equal(env['XAI_API_KEY'], undefined);
  });

  it('buildOpencodeEnv strips FOO; keeps XDG from accountEnv', () => {
    const env = buildOpencodeEnv(baseReq({ accountEnv: { XDG_DATA_HOME: '/acct-x' } }), {
      PATH: '/bin',
      HOME: '/home',
      FOO: 'bar',
      XDG_DATA_HOME: '/parent-x',
    });
    assert.equal(env['XDG_DATA_HOME'], '/acct-x');
    assert.equal(env['FOO'], undefined);
  });

  it('buildClaudeEnv strips ANTHROPIC_API_KEY; accountEnv CLAUDE_CONFIG_DIR wins', async () => {
    const env = await buildClaudeEnv(
      baseReq({ accountEnv: { CLAUDE_CONFIG_DIR: '/acct-c' } }),
      {
        PATH: '/bin',
        HOME: '/home',
        CLAUDE_CONFIG_DIR: '/parent-c',
        ANTHROPIC_API_KEY: 'sk-ant',
        MY_SECRET: 'nope',
      },
    );
    assert.equal(env['CLAUDE_CONFIG_DIR'], '/acct-c');
    assert.equal(env['ANTHROPIC_API_KEY'], undefined);
    assert.equal(env['MY_SECRET'], undefined);
    assert.equal(env['PATH'], '/bin');
  });

  it('buildClaudeEnv FULL_ENV keeps ambient API key', async () => {
    const env = await buildClaudeEnv(baseReq(), {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-ant-kept',
      [PROVIDER_FULL_ENV_FLAG]: '1',
    });
    assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant-kept');
  });
});
