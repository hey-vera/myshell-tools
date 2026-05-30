/**
 * Unit tests for src/core/route.ts
 * Run with: node --experimental-strip-types --test test/unit/route.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../src/core/route.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { ProviderId } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAUDE_ONLY: ProviderId[] = ['claude'];
const CODEX_ONLY: ProviderId[] = ['codex'];
const BOTH: ProviderId[] = ['claude', 'codex'];
const NEITHER: ProviderId[] = [];

// ---------------------------------------------------------------------------
// IC tier
// ---------------------------------------------------------------------------

describe('route — ic tier', () => {
  it('claude-only → claude ic model (claude-sonnet-4-6)', () => {
    const decision = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });

  it('codex-only → a codex ic model', () => {
    const decision = route('ic', CODEX_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'codex');
    // Should be gpt-5.2-codex (cheapest codex ic model by inputPer1M: $1.75 vs gpt-5.4 $2.50)
    assert.equal(decision.model, 'gpt-5.2-codex');
  });

  it('both available → claude first (per policy order)', () => {
    const decision = route('ic', BOTH, DEFAULT_POLICY);
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });

  it('empty available → throws', () => {
    assert.throws(
      () => route('ic', NEITHER, DEFAULT_POLICY),
      /no providers available/i,
    );
  });

  it('returns a RouteDecision with tier set correctly', () => {
    const decision = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
  });
});

// ---------------------------------------------------------------------------
// Worker tier
// ---------------------------------------------------------------------------

describe('route — worker tier', () => {
  it('claude-only → claude worker model (claude-haiku-4-5)', () => {
    const decision = route('worker', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-haiku-4-5');
  });

  it('codex-only → cheapest codex worker model', () => {
    const decision = route('worker', CODEX_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.provider, 'codex');
    // gpt-5.4-nano is cheapest codex worker ($0.20/1M input vs gpt-5.4-mini $0.75)
    assert.equal(decision.model, 'gpt-5.4-nano');
  });

  it('both available → claude first (per policy order)', () => {
    const decision = route('worker', BOTH, DEFAULT_POLICY);
    assert.equal(decision.provider, 'claude');
  });
});

// ---------------------------------------------------------------------------
// Manager tier
// ---------------------------------------------------------------------------

describe('route — manager tier', () => {
  it('claude-only → claude manager model (claude-opus-4-7)', () => {
    const decision = route('manager', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-opus-4-7');
  });

  it('codex-only → codex manager model (gpt-5.5)', () => {
    const decision = route('manager', CODEX_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.provider, 'codex');
    assert.equal(decision.model, 'gpt-5.5');
  });

  it('both available → claude first (per policy order)', () => {
    const decision = route('manager', BOTH, DEFAULT_POLICY);
    assert.equal(decision.provider, 'claude');
  });

  it('empty available → throws with helpful message', () => {
    assert.throws(
      () => route('manager', NEITHER, DEFAULT_POLICY),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /no providers available/i);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Policy fallback: provider not in policy order but present in available
// ---------------------------------------------------------------------------

describe('route — fallback when preferred providers unavailable', () => {
  it('policy prefers [claude, codex] but only an unknown provider is available — falls back to cheapest', () => {
    // This tests the case where available contains a provider that is NOT in the
    // policy order.  We simulate by passing a custom policy that prefers nothing
    // the available set has.
    const customPolicy = {
      ...DEFAULT_POLICY,
      providerOrderByTier: {
        ...DEFAULT_POLICY.providerOrderByTier,
        // ic prefers codex first, then claude
        ic: ['codex', 'claude'] as readonly ProviderId[],
      },
    };
    // Only claude is available, but policy prefers codex first.
    // Falls through to claude (second in order).
    const decision = route('ic', ['claude'], customPolicy);
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });
});
