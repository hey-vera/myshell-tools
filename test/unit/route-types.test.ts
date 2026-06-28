/**
 * test/unit/route-types.test.ts — unit tests for vendor-neutral routing helpers:
 * vendorNeutralRouterEnabled, poolForModelId, opencodeTierRank (§2-§5).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  vendorNeutralRouterEnabled,
  poolForModelId,
  opencodeTierRank,
  sessionTokenLoadByPool,
  resolveCooldownPools,
} from '../../src/core/route-types.ts';
import type {
  OpencodeVerboseFacts,
  CredentialHints,
  QuotaPoolId,
} from '../../src/core/route-types.ts';
import type { LedgerEntry } from '../../src/core/types.ts';
import type { ProviderId } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// vendorNeutralRouterEnabled (§2 — DEFAULT ON / explicit opt-OUT)
// ---------------------------------------------------------------------------

describe('vendorNeutralRouterEnabled', () => {
  it('returns true with no env and no config (default-on — shipped default)', () => {
    assert.equal(vendorNeutralRouterEnabled(undefined, undefined), true);
  });

  it('returns true with empty env and no config', () => {
    assert.equal(vendorNeutralRouterEnabled({}, undefined), true);
  });

  it('returns true with garbage env value (unrecognised → default on)', () => {
    assert.equal(
      vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: 'maybe' }, undefined),
      true,
    );
  });

  it('returns false with explicit opt-out env values (case-insensitive, trimmed)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' FALSE ', 'Off']) {
      assert.equal(
        vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: v }, undefined),
        false,
      );
    }
  });

  it('returns true with env "1"', () => {
    assert.equal(
      vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: '1' }, undefined),
      true,
    );
  });

  it('returns true with env "true" (case-insensitive)', () => {
    assert.equal(
      vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: 'TRUE' }, undefined),
      true,
    );
  });

  it('returns true with env "on"', () => {
    assert.equal(
      vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: 'on' }, undefined),
      true,
    );
  });

  it('returns true with config.experimentalVendorNeutralRouter === true', () => {
    assert.equal(
      vendorNeutralRouterEnabled(undefined, { experimentalVendorNeutralRouter: true }),
      true,
    );
  });

  it('config opt-OUT (experimentalVendorNeutralRouter === false) ⇒ false', () => {
    assert.equal(
      vendorNeutralRouterEnabled(undefined, { experimentalVendorNeutralRouter: false }),
      false,
    );
  });

  it('explicit env opt-OUT overrides config true ⇒ false', () => {
    // env '0' is opt-OUT — processed first → returns false regardless of config
    assert.equal(
      vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: '0' }, { experimentalVendorNeutralRouter: true }),
      false,
    );
  });

  it('explicit env opt-IN overrides config false ⇒ true', () => {
    assert.equal(
      vendorNeutralRouterEnabled({ MYSHELL_VENDOR_NEUTRAL_ROUTER: 'yes' }, { experimentalVendorNeutralRouter: false }),
      true,
    );
  });

  it('never throws on a hostile env bag (defaults ON)', () => {
    const hostile = new Proxy({} as NodeJS.ProcessEnv, {
      get() { throw new Error('hostile'); },
    });
    assert.equal(vendorNeutralRouterEnabled(hostile, undefined), true);
  });
});

// ---------------------------------------------------------------------------
// poolForModelId (§3 — prefix-derived pools)
// ---------------------------------------------------------------------------

describe('poolForModelId', () => {
  it('opencode-go/* → opencode-go', () => {
    assert.equal(poolForModelId('opencode-go/kimi-k2.7-code'), 'opencode-go');
    assert.equal(poolForModelId('opencode-go/deepseek-v4-pro'), 'opencode-go');
    assert.equal(poolForModelId('opencode-go/glm-5.1'), 'opencode-go');
  });

  it('opencode/* → opencode-zen-or-free', () => {
    assert.equal(poolForModelId('opencode/deepseek-v4-flash-free'), 'opencode-zen-or-free');
    assert.equal(poolForModelId('opencode/mimo-v2.5-free'), 'opencode-zen-or-free');
    assert.equal(poolForModelId('opencode/big-pickle'), 'opencode-zen-or-free');
  });

  it('bare opencode → opencode-unknown-default', () => {
    assert.equal(poolForModelId('opencode', 'opencode'), 'opencode-unknown-default');
    assert.equal(poolForModelId('opencode', undefined), 'opencode-unknown-default');
  });

  it('claude models → claude pool', () => {
    assert.equal(poolForModelId('opus', 'claude'), 'claude');
    assert.equal(poolForModelId('sonnet', 'claude'), 'claude');
  });

  it('codex models → codex pool', () => {
    assert.equal(poolForModelId('gpt-5.5', 'codex'), 'codex');
    assert.equal(poolForModelId('gpt-5.4', 'codex'), 'codex');
  });

  it('grok models → grok pool', () => {
    assert.equal(poolForModelId('grok-build', 'grok'), 'grok');
    assert.equal(poolForModelId('grok-composer-2.5-fast', 'grok'), 'grok');
  });

  it('openCode model without provider hint still derives pool from prefix', () => {
    assert.equal(poolForModelId('opencode-go/kimi-k2.7-code', undefined), 'opencode-go');
    assert.equal(poolForModelId('opencode/deepseek-v4-flash-free', undefined), 'opencode-zen-or-free');
  });

  it('unknown model without provider → opencode-unknown-default', () => {
    assert.equal(poolForModelId('something-else', undefined), 'opencode-unknown-default');
  });

  it('case-insensitive prefix matching', () => {
    assert.equal(poolForModelId('OPENCODE-GO/kimi-k2.7-code'), 'opencode-go');
    assert.equal(poolForModelId('OpenCode/deepseek-v4-flash-free'), 'opencode-zen-or-free');
  });

  it('pool identity is derived from prefix, never credentials', () => {
    // Even with a provider hint of 'opencode', prefix determines pool
    assert.equal(poolForModelId('opencode-go/kimi', 'opencode'), 'opencode-go');
    assert.equal(poolForModelId('opencode/deepseek', 'opencode'), 'opencode-zen-or-free');
  });
});

// ---------------------------------------------------------------------------
// opencodeTierRank — detected-only (no verbose → worker-floor) (§3)
// ---------------------------------------------------------------------------

describe('opencodeTierRank — detected-only (no verbose facts)', () => {
  it('worker-only when verboseFacts is undefined', () => {
    const rank = opencodeTierRank('opencode-go/kimi-k2.7-code');
    assert.equal(rank.admission.worker, true);
    assert.equal(rank.admission.ic, false);
    assert.equal(rank.admission.manager, false);
    assert.equal(rank.ic, 0);
    assert.equal(rank.manager, 0);
    assert.ok(rank.worker > 0, 'worker score should be > 0 even without verbose facts');
  });

  it('all bands are 0 when no facts available', () => {
    const rank = opencodeTierRank('opencode-go/kimi-k2.7-code');
    assert.equal(rank.ctxBand, 0);
    assert.equal(rank.outBand, 0);
    assert.equal(rank.reasonBand, 0);
  });

  it('worker score from morphology only (no facts)', () => {
    const rank = opencodeTierRank('opencode-go/kimi-k2.7-code');
    // No morphology triggers → balanced → fastBonus=10, deepPenalty=0
    // worker = clamp(40 + 10 + 0 + 0*3 + 0*2 - 0, 0, 100) = 50
    assert.equal(rank.worker, 50);
    assert.equal(rank.speedClass, 'balanced');
  });

  it('fast morphology detected without verbose facts', () => {
    const rank = opencodeTierRank('opencode-go/kimi-flash');
    assert.equal(rank.speedClass, 'fast');
    // fastBonus=20, deepPenalty=0
    // worker = clamp(40 + 20 + 0 + 0*3 + 0*2 - 0, 0, 100) = 60
    assert.equal(rank.worker, 60);
  });

  it('deep morphology detected without verbose facts', () => {
    const rank = opencodeTierRank('opencode-go/kimi-pro');
    assert.equal(rank.speedClass, 'deep');
    // fastBonus=0, deepPenalty=10
    // worker = clamp(40 + 0 + 0 + 0*3 + 0*2 - 10, 0, 100) = 30
    assert.equal(rank.worker, 30);
  });

  it('free flag detected without verbose facts', () => {
    const rank = opencodeTierRank('opencode/deepseek-v4-flash-free');
    assert.equal(rank.freeFlag, true);
    // fast morphology + free → fastBonus=20, freeBonus=10
    // worker = clamp(40 + 20 + 10 + 0 + 0 - 0, 0, 100) = 70
    assert.equal(rank.worker, 70);
  });
});

// ---------------------------------------------------------------------------
// opencodeTierRank — speedClass determination (§3)
// ---------------------------------------------------------------------------

describe('opencodeTierRank — speedClass', () => {
  it('fast morphology matches fast/flash/turbo/mini/nano/lite', () => {
    assert.equal(opencodeTierRank('opencode/m-fast').speedClass, 'fast');
    assert.equal(opencodeTierRank('opencode/m-flash').speedClass, 'fast');
    assert.equal(opencodeTierRank('opencode/m-turbo').speedClass, 'fast');
    assert.equal(opencodeTierRank('opencode/m-mini').speedClass, 'fast');
    assert.equal(opencodeTierRank('opencode/m-nano').speedClass, 'fast');
    assert.equal(opencodeTierRank('opencode/m-lite').speedClass, 'fast');
  });

  it('deep morphology matches pro/max/plus/large/xl', () => {
    assert.equal(opencodeTierRank('opencode/m-pro').speedClass, 'deep');
    assert.equal(opencodeTierRank('opencode/m-max').speedClass, 'deep');
    assert.equal(opencodeTierRank('opencode/m-plus').speedClass, 'deep');
    assert.equal(opencodeTierRank('opencode/m-large').speedClass, 'deep');
    assert.equal(opencodeTierRank('opencode/m-xl').speedClass, 'deep');
  });

  it('deep from reasonBand >= 4 && ctxBand >= 3', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 300_000,
      maxOutputTokens: 32_000,
      reasoning: true,
      variantLevels: ['xhigh', 'max'],
    };
    // ctxBand: 256k → 3, reasonBand: max=5 → 5, >= 4 && ctxBand >= 3 → deep
    const rank = opencodeTierRank('opencode-go/kimi-k2.7-code', facts);
    assert.equal(rank.speedClass, 'deep');
  });

  it('balanced is default when no morphology matches', () => {
    assert.equal(opencodeTierRank('opencode-go/kimi-k2.7-code').speedClass, 'balanced');
    assert.equal(opencodeTierRank('opencode/some-model').speedClass, 'balanced');
  });
});

// ---------------------------------------------------------------------------
// opencodeTierRank — band calculations (§3)
// ---------------------------------------------------------------------------

describe('opencodeTierRank — band calculations', () => {
  it('ctxBand: unknown → 0, <64k → 0, 64k → 1, 128k → 2, 256k → 3, 512k → 4, 1M+ → 5', () => {
    const make = (ctx: number | undefined) =>
      opencodeTierRank('opencode-go/m', { contextWindow: ctx, reasoning: false, variantLevels: [] });

    assert.equal(make(undefined).ctxBand, 0);
    assert.equal(make(0).ctxBand, 0);
    assert.equal(make(32_000).ctxBand, 0);
    assert.equal(make(64_000).ctxBand, 1);
    assert.equal(make(128_000).ctxBand, 2);
    assert.equal(make(256_000).ctxBand, 3);
    assert.equal(make(512_000).ctxBand, 4);
    assert.equal(make(1_000_000).ctxBand, 5);
    assert.equal(make(2_000_000).ctxBand, 5);
  });

  it('outBand: unknown → 0, <8k → 0, 8k → 1, 16k → 2, 32k → 3, 64k+ → 4', () => {
    const make = (out: number | undefined) =>
      opencodeTierRank('opencode-go/m', { maxOutputTokens: out, reasoning: false, variantLevels: [] });

    assert.equal(make(undefined).outBand, 0);
    assert.equal(make(0).outBand, 0);
    assert.equal(make(4_000).outBand, 0);
    assert.equal(make(8_000).outBand, 1);
    assert.equal(make(16_000).outBand, 2);
    assert.equal(make(32_000).outBand, 3);
    assert.equal(make(64_000).outBand, 4);
    assert.equal(make(128_000).outBand, 4);
  });

  it('reasonBand: none/unknown → 0, reasoning true no variants → 1', () => {
    const noReasoning: OpencodeVerboseFacts = { reasoning: false, variantLevels: [] };
    assert.equal(opencodeTierRank('opencode-go/m', noReasoning).reasonBand, 0);

    const reasoningNoVariants: OpencodeVerboseFacts = { reasoning: true, variantLevels: [] };
    assert.equal(opencodeTierRank('opencode-go/m', reasoningNoVariants).reasonBand, 1);
  });

  it('reasonBand: max supported effort (low=1, medium=2, high=3, xhigh=4, max=5)', () => {
    const make = (levels: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]) =>
      opencodeTierRank('opencode-go/m', { reasoning: true, variantLevels: levels });

    assert.equal(make(['low']).reasonBand, 1);
    assert.equal(make(['medium']).reasonBand, 2);
    assert.equal(make(['high']).reasonBand, 3);
    assert.equal(make(['xhigh']).reasonBand, 4);
    assert.equal(make(['max']).reasonBand, 5);
    assert.equal(make(['low', 'high', 'max']).reasonBand, 5); // max wins
  });
});

// ---------------------------------------------------------------------------
// opencodeTierRank — admission rules (§3)
// ---------------------------------------------------------------------------

describe('opencodeTierRank — admission rules', () => {
  const baseFacts: OpencodeVerboseFacts = {
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
    variantLevels: ['high', 'xhigh'],
  };

  it('worker is always admitted', () => {
    const rank = opencodeTierRank('opencode-go/m', baseFacts);
    assert.equal(rank.admission.worker, true);
  });

  it('IC admitted with context >= 128_000', () => {
    const rank = opencodeTierRank('opencode-go/m', { ...baseFacts, contextWindow: 200_000 });
    assert.equal(rank.admission.ic, true);
  });

  it('IC admitted with context >= 64_000 plus reasoning', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      ...baseFacts,
      contextWindow: 96_000,
      reasoning: true,
    });
    assert.equal(rank.admission.ic, true);
  });

  it('IC NOT admitted with context < 64_000 even with reasoning', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      ...baseFacts,
      contextWindow: 48_000,
      reasoning: true,
    });
    assert.equal(rank.admission.ic, false);
    assert.equal(rank.ic, 0);
  });

  it('IC NOT admitted with context 64_000-127_999 but no reasoning', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      ...baseFacts,
      contextWindow: 96_000,
      reasoning: false,
    });
    assert.equal(rank.admission.ic, false);
  });

  it('manager admitted with context >= 128k + reasoning', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      ...baseFacts,
      contextWindow: 200_000,
      reasoning: true,
    });
    assert.equal(rank.admission.manager, true);
  });

  it('manager NOT admitted with unknown context', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      reasoning: true,
      variantLevels: ['high'],
      contextWindow: undefined,
    });
    assert.equal(rank.admission.manager, false);
    assert.equal(rank.manager, 0);
  });

  it('manager NOT admitted with context < 128k', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      ...baseFacts,
      contextWindow: 96_000,
    });
    assert.equal(rank.admission.manager, false);
  });

  it('manager admitted with context >= 128k + deep morphology (no reasoning)', () => {
    const rank = opencodeTierRank('opencode-go/m-pro', {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      reasoning: false,
      variantLevels: [],
    });
    assert.equal(rank.admission.manager, true);
  });

  it('manager NOT admitted with context >= 128k but no reasoning and no deep morphology', () => {
    const rank = opencodeTierRank('opencode-go/m', {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      reasoning: false,
      variantLevels: [],
    });
    assert.equal(rank.admission.manager, false);
  });
});

// ---------------------------------------------------------------------------
// opencodeTierRank — scoring formulas (§3)
// ---------------------------------------------------------------------------

describe('opencodeTierRank — scoring formulas match spec', () => {
  it('worker scoring with full known facts', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 262_144,  // ctxBand = 3 (256k)
      maxOutputTokens: 32_768, // outBand = 3 (32k)
      reasoning: true,
      variantLevels: ['high', 'xhigh'],  // reasonBand = 4
    };
    const rank = opencodeTierRank('opencode-go/kimi-k2.7-code', facts);
    // reasonBand=4 + ctxBand=3 → triggers deep speedClass (per §3 rule)
    // deep → fastBonus=0, deepPenalty=10
    // worker = clamp(40 + 0 + 0 + 3*3 + 4*2 - 10, 0, 100) = clamp(47, 0, 100) = 47
    assert.equal(rank.worker, 47);
    assert.equal(rank.speedClass, 'deep');
  });

  it('IC scoring with admitted model', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 131_072,  // ctxBand = 2 (128k) — qualifies for IC
      maxOutputTokens: 16_384, // outBand = 2 (16k)
      reasoning: true,
      variantLevels: ['high'], // reasonBand = 3
    };
    const rank = opencodeTierRank('opencode-go/m', facts);
    assert.equal(rank.admission.ic, true);
    // No morphology → balanced. balancedBonus=20, freePenalty=0
    // ic = clamp(35 + 20 + 2*5 + 3*5 + 2*2 - 0, 0, 100) = 35+20+10+15+4 = 84
    assert.equal(rank.ic, 84);
  });

  it('manager scoring with deep pro model', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 262_144,  // ctxBand = 3
      maxOutputTokens: 65_536, // outBand = 4 (64k+)
      reasoning: true,
      variantLevels: ['max'], // reasonBand = 5
    };
    // model = opencode-go/m-pro → deep morphology both ways
    const rank = opencodeTierRank('opencode-go/m-pro', facts);
    assert.equal(rank.admission.manager, true);
    assert.equal(rank.speedClass, 'deep');
    // deepBonus=25, freePenalty=0 (no 'free' in id)
    // manager = clamp(20 + 25 + 3*7 + 5*8 + 4*3 - 0, 0, 100) = 20+25+21+40+12 = 118 → clamp → 100
    assert.equal(rank.manager, 100);
  });

  it('free penalty reduces IC and manager scores', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      reasoning: true,
      variantLevels: ['high'],
    };
    const rankFree = opencodeTierRank('opencode/m-free', facts);
    assert.equal(rankFree.freeFlag, true);
    assert.equal(rankFree.admission.ic, true);
    // balanced model, freePenalty=1
    // ic = clamp(35 + 20 + 2*5 + 3*5 + 2*2 - 1, 0, 100) = 35+20+10+15+4-1 = 83
    const rankNoFree = opencodeTierRank('opencode/m', facts);
    assert.equal(rankFree.ic, rankNoFree.ic - 1); // free penalty of 1
  });

  it('free bonus boosts worker score', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 200_000,
      reasoning: true,
      variantLevels: ['high'],
    };
    const free = opencodeTierRank('opencode/m-free', facts);
    const noFree = opencodeTierRank('opencode/m', facts);
    // freeBonus=10 → worker should be +10
    assert.equal(free.worker, noFree.worker + 10);
  });

  it('deep penalty reduces worker score', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 200_000,
      reasoning: true,
      variantLevels: ['high'],
    };
    // pro triggers deep
    const deep = opencodeTierRank('opencode-go/m-pro', facts);
    const balanced = opencodeTierRank('opencode-go/m', facts);
    // deepPenalty=10, fastBonus=0 (vs balanced) 
    // worker deep: 40 + 0 + 0 + 3*2 + 3*3 - 10 = 40+0+0+6+9-10 = 45
    // worker balanced: 40 + 10 + 0 + 3*2 + 3*3 - 0 = 40+10+0+6+9 = 65
    assert.ok(deep.worker < balanced.worker, 'deep model should have lower worker score');
  });

  it('all scores clamped to 0..100', () => {
    // Extreme facts should clamp, not exceed 100 or go below 0
    const maxFacts: OpencodeVerboseFacts = {
      contextWindow: 2_000_000, // ctxBand = 5
      maxOutputTokens: 131_072, // outBand = 4
      reasoning: true,
      variantLevels: ['max'], // reasonBand = 5
    };
    const rank = opencodeTierRank('opencode-go/m-pro-max', maxFacts);
    assert.ok(rank.worker >= 0 && rank.worker <= 100);
    assert.ok(rank.ic >= 0 && rank.ic <= 100);
    assert.ok(rank.manager >= 0 && rank.manager <= 100);
  });

  it('worker score is at least 0 even for worst combo', () => {
    // deep + free (but freeBonus and deepPenalty cancel somewhat)
    // Let's try a combo that might go negative
    const badFacts: OpencodeVerboseFacts = {
      contextWindow: undefined,
      reasoning: false,
      variantLevels: [],
    };
    // deep model with no facts → fastBonus=0, deepPenalty=10, freeBonus=0
    // worker = 40 + 0 + 0 + 0*3 + 0*20 - 10 = 30 (still positive)
    const rank = opencodeTierRank('opencode/m-pro', badFacts);
    assert.ok(rank.worker >= 0);
  });
});

// ---------------------------------------------------------------------------
// opencodeTierRank — pure / deterministic
// ---------------------------------------------------------------------------

describe('opencodeTierRank — pure and deterministic', () => {
  it('same inputs produce identical output', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      reasoning: true,
      variantLevels: ['high', 'xhigh'],
    };
    const a = opencodeTierRank('opencode-go/kimi-k2.7-code', facts);
    const b = opencodeTierRank('opencode-go/kimi-k2.7-code', facts);
    assert.deepEqual(a, b);
  });

  it('credential hints do NOT affect rank (soft hints only)', () => {
    const facts: OpencodeVerboseFacts = {
      contextWindow: 200_000,
      reasoning: true,
      variantLevels: ['high'],
    };
    const withCreds: CredentialHints = { hasApiCredential: true, hasOAuthCredential: false };
    const withoutCreds: CredentialHints = { hasApiCredential: false, hasOAuthCredential: false };
    const a = opencodeTierRank('opencode-go/m', facts, withCreds);
    const b = opencodeTierRank('opencode-go/m', facts, withoutCreds);
    assert.deepEqual(a, b);
  });

  it('free morphology is case-insensitive', () => {
    assert.equal(opencodeTierRank('opencode/M-FREE').freeFlag, true);
    assert.equal(opencodeTierRank('opencode/M-Free').freeFlag, true);
    assert.equal(opencodeTierRank('opencode/m-free').freeFlag, true);
  });

  it('morphology matching is token-based (not substring)', () => {
    // 'codepro' should NOT match 'pro' as a token
    const rank = opencodeTierRank('opencode-go/codepro');
    assert.equal(rank.speedClass, 'balanced');
    // But 'code-pro' should match 'pro'
    const rank2 = opencodeTierRank('opencode-go/code-pro');
    assert.equal(rank2.speedClass, 'deep');
  });
});

// ---------------------------------------------------------------------------
// sessionTokenLoadByPool (§4 — slice 6)
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LedgerEntry> & {
  provider: ProviderId;
  model: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
}): LedgerEntry {
  return {
    timestamp: '2026-01-15T00:00:00Z',
    taskId: 'task-1',
    tier: 'worker',
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    usd: 0,
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

describe('sessionTokenLoadByPool', () => {
  it('empty entries → empty map', () => {
    const load = sessionTokenLoadByPool([], 'session-1');
    assert.equal(load.size, 0);
  });

  it('aggregates input + output tokens per pool for matching session', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'claude', model: 'sonnet', sessionId: 's1', inputTokens: 100, outputTokens: 50 }),
      makeEntry({ provider: 'claude', model: 'haiku', sessionId: 's1', inputTokens: 200, outputTokens: 80 }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.get('claude' as QuotaPoolId), 100 + 50 + 200 + 80);
  });

  it('ignores entries from other sessions', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'claude', model: 'sonnet', sessionId: 's1', inputTokens: 100, outputTokens: 50 }),
      makeEntry({ provider: 'codex', model: 'gpt-5.5', sessionId: 's2', inputTokens: 200, outputTokens: 100 }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.size, 1);
    assert.equal(load.get('claude' as QuotaPoolId), 150);
    assert.equal(load.get('codex' as QuotaPoolId), undefined);
  });

  it('derives pool from provider/model via poolForModelId', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'opencode', model: 'opencode-go/kimi-flash', sessionId: 's1', inputTokens: 100, outputTokens: 50 }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.get('opencode-go' as QuotaPoolId), 150);
  });

  it('openCode zEn models map to opencode-zen-or-free pool', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'opencode', model: 'opencode/deepseek-v4-flash-free', sessionId: 's1', inputTokens: 50, outputTokens: 50 }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.get('opencode-zen-or-free' as QuotaPoolId), 100);
  });

  it('multiple pools aggregated independently', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'claude', model: 'sonnet', sessionId: 's1', inputTokens: 100, outputTokens: 50 }),
      makeEntry({ provider: 'codex', model: 'gpt-5.5', sessionId: 's1', inputTokens: 200, outputTokens: 100 }),
      makeEntry({ provider: 'claude', model: 'haiku', sessionId: 's1', inputTokens: 30, outputTokens: 20 }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.get('claude' as QuotaPoolId), 100 + 50 + 30 + 20);
    assert.equal(load.get('codex' as QuotaPoolId), 200 + 100);
  });

  it('handles non-finite tokens gracefully (treats as 0)', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'claude', model: 'sonnet', sessionId: 's1', inputTokens: NaN, outputTokens: Infinity }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.get('claude' as QuotaPoolId), 0);
  });

  it('handles negative tokens (clamped to 0)', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ provider: 'claude', model: 'sonnet', sessionId: 's1', inputTokens: -5, outputTokens: -10 }),
    ];
    const load = sessionTokenLoadByPool(entries, 's1');
    assert.equal(load.get('claude' as QuotaPoolId), 0);
  });
});

// ---------------------------------------------------------------------------
// resolveCooldownPools (§4 — slice 7)
// ---------------------------------------------------------------------------

describe('resolveCooldownPools', () => {
  it('claude model → single claude pool', () => {
    const pools = resolveCooldownPools('sonnet', 'claude');
    assert.deepEqual(pools, ['claude']);
  });

  it('codex model → single codex pool', () => {
    const pools = resolveCooldownPools('gpt-5.5', 'codex');
    assert.deepEqual(pools, ['codex']);
  });

  it('grok model → single grok pool', () => {
    const pools = resolveCooldownPools('grok-build', 'grok');
    assert.deepEqual(pools, ['grok']);
  });

  it('opencode-go model → single opencode-go pool', () => {
    const pools = resolveCooldownPools('opencode-go/kimi-k2.7-code', 'opencode');
    assert.deepEqual(pools, ['opencode-go']);
  });

  it('opencode/ model → single opencode-zen-or-free pool', () => {
    const pools = resolveCooldownPools('opencode/deepseek-v4-flash-free', 'opencode');
    assert.deepEqual(pools, ['opencode-zen-or-free']);
  });

  it('bare opencode placeholder → ALL opencode pools cooled', () => {
    const pools = resolveCooldownPools('opencode', 'opencode');
    assert.deepEqual(pools, ['opencode-go', 'opencode-zen-or-free', 'opencode-unknown-default']);
  });

  it('unknown model → opencode-unknown-default pool', () => {
    const pools = resolveCooldownPools('something-else', undefined as unknown as ProviderId);
    // poolForModelId returns 'opencode-unknown-default' → resolveCooldownPools returns all opencode pools
    assert.deepEqual(pools, ['opencode-go', 'opencode-zen-or-free', 'opencode-unknown-default']);
  });
});
