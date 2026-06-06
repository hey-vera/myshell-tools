/**
 * test/unit/model-capabilities.test.ts — Model Capability Registry Stage 1, Layer 1.
 *
 * Pins the declarative defaults' WELL-FORMEDNESS (the §2 invariant: facts only,
 * unknown = absent): every provider key present, ids unique per provider, aliases
 * never collide within a provider, every enum value known, NO fabricated reasoning
 * efforts (all declarative efforts are empty), NO Gemini data, OpenCode empty.
 * Plus the findCapability id/alias matcher. PURE — no I/O, no model call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECLARATIVE_MODEL_CAPABILITIES,
  KNOWN_REASONING_EFFORTS,
  isReasoningEffort,
  findCapability,
  type CapabilityRegistry,
} from '../../src/core/model-capabilities.ts';
import type { ProviderId } from '../../src/providers/port.ts';

const KNOWN_TIERS = new Set(['worker', 'ic', 'manager']);

describe('DECLARATIVE_MODEL_CAPABILITIES — well-formed, facts only', () => {
  const reg: CapabilityRegistry = DECLARATIVE_MODEL_CAPABILITIES;

  it('has exactly the three current provider keys (no Gemini)', () => {
    assert.deepEqual(Object.keys(reg).sort(), ['claude', 'codex', 'opencode']);
    assert.ok(!('gemini' in reg), 'no Gemini data in Stage 1');
  });

  it('OpenCode declarative defaults are empty (meta-provider; models come from detect)', () => {
    assert.deepEqual(reg.opencode, []);
  });

  it('ids are unique per provider and aliases never collide within a provider', () => {
    for (const provider of Object.keys(reg) as ProviderId[]) {
      const ids = new Set<string>();
      const aliasOwners = new Map<string, string>();
      for (const cap of reg[provider]) {
        const id = cap.id.toLowerCase();
        assert.ok(!ids.has(id), `${provider}: duplicate id ${cap.id}`);
        ids.add(id);
        for (const a of cap.aliases) {
          const al = a.toLowerCase();
          assert.ok(!aliasOwners.has(al), `${provider}: alias ${a} collides`);
          assert.ok(al !== id, `${provider}: alias ${a} equals its own id`);
          aliasOwners.set(al, cap.id);
        }
      }
    }
  });

  it('every enum value is known and provider field matches its key', () => {
    for (const provider of Object.keys(reg) as ProviderId[]) {
      for (const cap of reg[provider]) {
        assert.equal(cap.provider, provider);
        if (cap.tierHint !== undefined) assert.ok(KNOWN_TIERS.has(cap.tierHint));
        for (const e of cap.supportedReasoningEfforts) {
          assert.ok(isReasoningEffort(e), `unknown effort ${e}`);
        }
        assert.ok(cap.source.length > 0 && cap.source.includes('declarative'));
      }
    }
  });

  it('fabricates NO reasoning efforts and NO context windows in declarative layer', () => {
    for (const provider of Object.keys(reg) as ProviderId[]) {
      for (const cap of reg[provider]) {
        assert.deepEqual(
          cap.supportedReasoningEfforts,
          [],
          `${cap.id}: declarative efforts must be empty (unknown), filled only by dynamic sources`,
        );
        assert.equal(cap.contextWindow, undefined, `${cap.id}: no guessed context window`);
        assert.equal(cap.supportsVision, undefined, `${cap.id}: no guessed vision`);
      }
    }
  });

  it('declares native-session support for the real providers (a stable objective fact)', () => {
    for (const cap of [...reg.claude, ...reg.codex]) {
      assert.equal(cap.supportsNativeSession, true);
    }
  });

  it('declares Claude provider-native features (Skills + sub-agents) with a source; Codex/OpenCode leave them ABSENT (Stage 5)', () => {
    // Claude Code natively supports Skills + sub-agents (claude-code-docs). These are
    // NON-ROUTABLE inventory facts only — set true with a providerFeatureSource.
    for (const cap of reg.claude) {
      assert.equal(cap.supportsProviderSkills, true, `${cap.id}: Claude supports Skills`);
      assert.equal(cap.supportsProviderSubagents, true, `${cap.id}: Claude supports sub-agents`);
      assert.equal(cap.providerFeatureSource, 'claude-code-docs', `${cap.id}: names its source`);
    }
    // Codex/OpenCode have no grounded local fact → unknown = ABSENT (never false).
    for (const cap of [...reg.codex, ...reg.opencode]) {
      assert.equal(cap.supportsProviderSkills, undefined, `${cap.id}: no fabricated Skills fact`);
      assert.equal(cap.supportsProviderSubagents, undefined, `${cap.id}: no fabricated sub-agent fact`);
      assert.equal(cap.providerFeatureSource, undefined, `${cap.id}: no fabricated feature source`);
    }
  });
});

describe('isReasoningEffort / KNOWN_REASONING_EFFORTS', () => {
  it('accepts known efforts and rejects unknown strings', () => {
    for (const e of KNOWN_REASONING_EFFORTS) assert.ok(isReasoningEffort(e));
    assert.equal(isReasoningEffort('ultra'), false);
    assert.equal(isReasoningEffort(''), false);
    assert.equal(isReasoningEffort('LOW'), false);
  });
});

describe('findCapability', () => {
  it('matches by id and by alias, case-insensitively; misses are undefined', () => {
    const reg = DECLARATIVE_MODEL_CAPABILITIES;
    assert.equal(findCapability(reg, 'claude', 'opus')?.id, 'opus');
    assert.equal(findCapability(reg, 'claude', 'OPUS')?.id, 'opus');
    assert.equal(findCapability(reg, 'claude', 'claude-opus-4-7')?.id, 'opus');
    assert.equal(findCapability(reg, 'codex', 'gpt-5.5')?.id, 'gpt-5.5');
    assert.equal(findCapability(reg, 'codex', 'nope'), undefined);
    assert.equal(findCapability(reg, 'opencode', 'anything'), undefined);
  });
});
