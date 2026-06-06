/**
 * test/unit/model-capability-refresh.test.ts — Capability Registry Stage 1, Layer 2.
 *
 * Pins the FAIL-SOFT merge over a FAKE CapabilityRefreshPort (no real fs):
 *  - merges the REAL Codex models_cache.json shape → reasoning efforts, default
 *    effort, context window, vision (derived only from input_modalities), tool flags;
 *  - missing cache → declarative+detect stand, efforts stay [] (unknown), info diag;
 *  - corrupt JSON / bad shape → warn diag, declarative preserved, NEVER throws;
 *  - throwing port → caught, declarative preserved;
 *  - unknown effort string is dropped, the rest kept; vision NOT fabricated when
 *    input_modalities is absent;
 *  - detect adds new ids with source ['detect'] and NO invented tier;
 *  - 'hide' visibility models are skipped.
 * NO real I/O, NO model call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  refreshCapabilities,
  type CapabilityRefreshPort,
  type ProviderDetectFacts,
} from '../../src/core/model-capability-refresh.ts';

const NOW = '2026-06-06T00:00:00Z';

function port(text: string | null | (() => never)): CapabilityRefreshPort {
  return {
    async readCodexModelsCache(): Promise<string | null> {
      if (typeof text === 'function') return text();
      return text;
    },
  };
}

const codexDetect: ProviderDetectFacts = {
  provider: 'codex',
  authenticated: true,
  availableModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
};

const REAL_CACHE = JSON.stringify({
  fetched_at: '2026-06-06T14:41:50Z',
  client_version: '0.137.0',
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
      ],
      context_window: 272000,
      max_context_window: 272000,
      input_modalities: ['text', 'image'],
      supports_search_tool: true,
      supports_parallel_tool_calls: true,
      visibility: 'list',
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      supported_reasoning_levels: [{ effort: 'high' }],
      visibility: 'hide',
    },
  ],
});

describe('refreshCapabilities — Codex cache merge (real shape)', () => {
  it('merges efforts, default effort, context, vision, tool flags from the cache', async () => {
    const { registry, diagnostics } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(REAL_CACHE),
    );
    const gpt55 = registry.codex.find((c) => c.id === 'gpt-5.5');
    assert.ok(gpt55);
    assert.deepEqual(gpt55.supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(gpt55.defaultReasoningEffort, 'medium');
    assert.equal(gpt55.contextWindow, 272000);
    assert.equal(gpt55.supportsVision, true);
    assert.deepEqual(gpt55.inputModalities, ['text', 'image']);
    assert.equal(gpt55.supportsSearchTool, true);
    assert.equal(gpt55.supportsParallelToolCalls, true);
    // source accumulates declarative + detect + codex-cache; lastRefreshedAt = fetched_at
    assert.deepEqual([...gpt55.source].sort(), ['codex-cache', 'declarative', 'detect']);
    assert.equal(gpt55.lastRefreshedAt, '2026-06-06T14:41:50Z');
    // tier hint stays declarative (manager); cache does not invent tier
    assert.equal(gpt55.tierHint, 'manager');
    assert.ok(diagnostics.some((d) => d.level === 'info' && d.source === 'codex-cache'));
  });

  it("skips 'hide' visibility models", async () => {
    const { registry } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(REAL_CACHE),
    );
    assert.equal(registry.codex.find((c) => c.id === 'codex-auto-review'), undefined);
  });

  it('drops unknown effort strings but keeps the valid ones', async () => {
    const cache = JSON.stringify({
      models: [
        {
          slug: 'gpt-5.5',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'high' }],
        },
      ],
    });
    const { registry } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(cache),
    );
    const gpt55 = registry.codex.find((c) => c.id === 'gpt-5.5');
    assert.deepEqual(gpt55?.supportedReasoningEfforts, ['low', 'high']);
  });

  it('does NOT fabricate vision when input_modalities is absent', async () => {
    const cache = JSON.stringify({
      models: [{ slug: 'gpt-5.5', supported_reasoning_levels: [{ effort: 'low' }] }],
    });
    const { registry } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(cache),
    );
    const gpt55 = registry.codex.find((c) => c.id === 'gpt-5.5');
    assert.equal(gpt55?.supportsVision, undefined);
    assert.equal(gpt55?.inputModalities, undefined);
  });
});

describe('refreshCapabilities — fail-soft', () => {
  it('missing cache → declarative+detect stand, efforts stay [] (unknown), info diag', async () => {
    const { registry, diagnostics } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(null),
    );
    assert.equal(registry.codex.length, 3);
    const gpt55 = registry.codex.find((c) => c.id === 'gpt-5.5');
    assert.deepEqual(gpt55?.supportedReasoningEfforts, [], 'efforts unknown, NOT fabricated');
    assert.deepEqual([...(gpt55?.source ?? [])].sort(), ['declarative', 'detect']);
    const diag = diagnostics.find((d) => d.source === 'codex-cache');
    assert.equal(diag?.level, 'info');
  });

  it('corrupt JSON → warn diag, declarative preserved, never throws', async () => {
    const { registry, diagnostics } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port('{ not valid json'),
    );
    assert.deepEqual(
      registry.codex.map((c) => c.id),
      ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    );
    assert.equal(registry.codex.find((c) => c.id === 'gpt-5.5')?.supportedReasoningEfforts.length, 0);
    assert.ok(diagnostics.some((d) => d.level === 'warn' && /corrupt/i.test(d.message)));
  });

  it('bad top-level shape (models not an array) → warn diag, declarative preserved', async () => {
    const { registry, diagnostics } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(JSON.stringify({ models: 'nope' })),
    );
    assert.equal(registry.codex.length, 3);
    assert.ok(diagnostics.some((d) => d.level === 'warn'));
  });

  it('throwing port → caught, declarative preserved', async () => {
    const { registry } = await refreshCapabilities(
      { providers: [codexDetect], nowIso: NOW },
      port(() => {
        throw new Error('boom');
      }),
    );
    assert.equal(registry.codex.length, 3);
  });
});

describe('refreshCapabilities — detect merge', () => {
  it('adds a new advertised id with source ["detect"] and NO invented tier', async () => {
    const { registry } = await refreshCapabilities(
      {
        providers: [
          { provider: 'codex', authenticated: true, availableModels: ['gpt-future-x'] },
        ],
        nowIso: NOW,
      },
      port(null),
    );
    const fresh = registry.codex.find((c) => c.id === 'gpt-future-x');
    assert.ok(fresh);
    assert.deepEqual(fresh.source, ['detect']);
    assert.equal(fresh.tierHint, undefined, 'unknown dynamic model gets NO tier');
    assert.deepEqual(fresh.supportedReasoningEfforts, []);
    assert.equal(fresh.lastRefreshedAt, NOW);
  });

  it('OpenCode advertised provider/model ids ride through with source ["detect"]', async () => {
    const { registry } = await refreshCapabilities(
      {
        providers: [
          {
            provider: 'opencode',
            authenticated: true,
            availableModels: ['github-copilot/gpt-4o'],
          },
        ],
        nowIso: NOW,
      },
      port(null),
    );
    const m = registry.opencode.find((c) => c.id === 'github-copilot/gpt-4o');
    assert.ok(m);
    assert.deepEqual(m.source, ['detect']);
    assert.equal(m.contextWindow, undefined);
  });

  it('does not mutate the shared DECLARATIVE defaults across calls', async () => {
    await refreshCapabilities({ providers: [codexDetect], nowIso: NOW }, port(REAL_CACHE));
    const second = await refreshCapabilities(
      { providers: [{ provider: 'codex', authenticated: false, availableModels: [] }], nowIso: NOW },
      port(null),
    );
    // gpt-5.5 efforts must be back to [] — the first call's mutation must not leak.
    assert.deepEqual(
      second.registry.codex.find((c) => c.id === 'gpt-5.5')?.supportedReasoningEfforts,
      [],
    );
  });
});
