/**
 * test/unit/roles.test.ts — unit tests for the PURE logical role abstraction
 * (src/core/roles.ts; redesign Phase 0, slice 1). Covers the mode→(rung,effort)
 * mapping table, multi-provider resolution with tier hints, the graceful step-down
 * when a desired rung is missing, and — the load-bearing test for principle #8 — the
 * single-provider / single-model DEGRADATION (every role collapses to the one model).
 * Pure: no spawn, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_ROLES,
  roleProfileForMode,
  rolesForMode,
  resolveRole,
  resolveAllRoles,
  type ProviderModels,
} from '../../src/core/roles.ts';
import type { CapabilityRegistry } from '../../src/core/model-capabilities.ts';
import type { Mode } from '../../src/core/policy.ts';

// ---------------------------------------------------------------------------
// A small registry that hints model tiers (mirrors the declarative defaults).
// ---------------------------------------------------------------------------

const REGISTRY: CapabilityRegistry = {
  claude: [
    {
      provider: 'claude',
      id: 'opus',
      aliases: [],
      tierHint: 'manager',
      supportedReasoningEfforts: [],
      source: ['declarative'],
    },
    {
      provider: 'claude',
      id: 'sonnet',
      aliases: [],
      tierHint: 'ic',
      supportedReasoningEfforts: [],
      source: ['declarative'],
    },
    {
      provider: 'claude',
      id: 'haiku',
      aliases: [],
      tierHint: 'worker',
      supportedReasoningEfforts: [],
      source: ['declarative'],
    },
  ],
  codex: [
    {
      provider: 'codex',
      id: 'gpt-5.5',
      aliases: [],
      tierHint: 'manager',
      supportedReasoningEfforts: [],
      source: ['declarative'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.4-mini',
      aliases: [],
      tierHint: 'worker',
      supportedReasoningEfforts: [],
      source: ['declarative'],
    },
  ],
  grok: [],
  opencode: [],
};

const ALL_PROVIDERS: readonly ProviderModels[] = [
  { provider: 'claude', models: ['opus', 'sonnet', 'haiku'] },
  { provider: 'codex', models: ['gpt-5.5', 'gpt-5.4-mini'] },
];

// ---------------------------------------------------------------------------
// 1. Mode → (rung, effort) mapping table
// ---------------------------------------------------------------------------

describe('roleProfileForMode — the dial mapping', () => {
  it('ghost is ALWAYS the cheapest fast rung with low effort, mode-invariant', () => {
    for (const mode of ['cost-saver', 'balanced', 'quality-first'] as Mode[]) {
      assert.deepEqual(roleProfileForMode(mode, 'ghost'), { rung: 'worker', effort: 'low' });
    }
  });

  it('chat is never the worker rung (principle #2 — cheap models are throwaway only)', () => {
    for (const mode of ['cost-saver', 'balanced', 'quality-first'] as Mode[]) {
      assert.notEqual(roleProfileForMode(mode, 'chat').rung, 'worker');
    }
  });

  it('chat and execution deepen as the mode rises', () => {
    assert.equal(roleProfileForMode('cost-saver', 'chat').rung, 'ic');
    assert.equal(roleProfileForMode('balanced', 'chat').rung, 'ic');
    assert.equal(roleProfileForMode('quality-first', 'chat').rung, 'manager');

    assert.equal(roleProfileForMode('cost-saver', 'execution').rung, 'worker');
    assert.equal(roleProfileForMode('balanced', 'execution').rung, 'ic');
    assert.equal(roleProfileForMode('quality-first', 'execution').rung, 'manager');
  });

  it('rolesForMode returns all three lanes', () => {
    const map = rolesForMode('balanced');
    assert.deepEqual(Object.keys(map).sort(), [...ALL_ROLES].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-provider resolution against tier hints
// ---------------------------------------------------------------------------

describe('resolveRole — multi-provider, tier-hinted', () => {
  it('chat at Max resolves to a manager-rung model', () => {
    const r = resolveRole({
      role: 'chat',
      mode: 'quality-first',
      available: ALL_PROVIDERS,
      registry: REGISTRY,
    });
    assert.ok(r !== null);
    assert.equal(r.rung, 'manager');
    assert.equal(r.effort, 'high');
    assert.equal(r.collapsed, false);
    assert.ok(['opus', 'gpt-5.5'].includes(r.model));
  });

  it('ghost resolves to a worker-rung model on a rich setup', () => {
    const r = resolveRole({
      role: 'ghost',
      mode: 'balanced',
      available: ALL_PROVIDERS,
      registry: REGISTRY,
    });
    assert.ok(r !== null);
    assert.equal(r.rung, 'worker');
    assert.ok(['haiku', 'gpt-5.4-mini'].includes(r.model));
  });

  it('honors preferredOrder within a rung', () => {
    const claudeFirst = resolveRole({
      role: 'chat',
      mode: 'quality-first',
      available: ALL_PROVIDERS,
      registry: REGISTRY,
      preferredOrder: ['claude', 'codex'],
    });
    const codexFirst = resolveRole({
      role: 'chat',
      mode: 'quality-first',
      available: ALL_PROVIDERS,
      registry: REGISTRY,
      preferredOrder: ['codex', 'claude'],
    });
    assert.equal(claudeFirst?.provider, 'claude');
    assert.equal(codexFirst?.provider, 'codex');
  });

  it('resolveAllRoles returns all three roles for a rich setup', () => {
    const all = resolveAllRoles({ mode: 'balanced', available: ALL_PROVIDERS, registry: REGISTRY });
    assert.deepEqual(Object.keys(all).sort(), [...ALL_ROLES].sort());
  });
});

// ---------------------------------------------------------------------------
// 3. Graceful step-down when the desired rung is missing
// ---------------------------------------------------------------------------

describe('resolveRole — graceful step-down (collapse)', () => {
  it('chat at Max steps DOWN to ic when no manager model exists', () => {
    const noManager: ProviderModels[] = [{ provider: 'claude', models: ['sonnet', 'haiku'] }];
    const r = resolveRole({
      role: 'chat',
      mode: 'quality-first',
      available: noManager,
      registry: REGISTRY,
    });
    assert.ok(r !== null);
    assert.equal(r.rung, 'ic'); // stepped down from manager
    assert.equal(r.model, 'sonnet');
    assert.equal(r.collapsed, true);
    // The effort the role WANTED is preserved (adapters step it down per model).
    assert.equal(r.effort, 'high');
  });

  it('ghost steps UP to ic when only an ic model exists', () => {
    const onlyIc: ProviderModels[] = [{ provider: 'claude', models: ['sonnet'] }];
    const r = resolveRole({
      role: 'ghost',
      mode: 'balanced',
      available: onlyIc,
      registry: REGISTRY,
    });
    assert.ok(r !== null);
    assert.equal(r.model, 'sonnet');
    assert.equal(r.collapsed, true);
  });

  it('returns null when there is nothing at all to run', () => {
    assert.equal(resolveRole({ role: 'chat', mode: 'balanced', available: [] }), null);
    assert.equal(
      resolveRole({
        role: 'chat',
        mode: 'balanced',
        available: [{ provider: 'claude', models: [] }],
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. THE LOAD-BEARING DEGRADATION TEST — principle #8.
//    1 provider / 1 model: every role collapses to that single model.
// ---------------------------------------------------------------------------

describe('resolveAllRoles — single-provider / single-model degradation (principle #8)', () => {
  const single: readonly ProviderModels[] = [{ provider: 'claude', models: ['sonnet'] }];

  for (const mode of ['cost-saver', 'balanced', 'quality-first'] as Mode[]) {
    it(`every role collapses to the ONE model in ${mode} mode`, () => {
      const all = resolveAllRoles({ mode, available: single, registry: REGISTRY });
      // All three roles resolve (nothing is dropped).
      assert.deepEqual(Object.keys(all).sort(), [...ALL_ROLES].sort());
      for (const role of ALL_ROLES) {
        const r = all[role];
        assert.ok(r !== undefined, `${role} must resolve on a single-model setup`);
        assert.equal(r.provider, 'claude');
        assert.equal(r.model, 'sonnet');
      }
      // chat, ghost, and execution all point at the SAME concrete model — they
      // collapse, never downgrade to a model that does not exist.
      assert.equal(all.chat?.model, all.ghost?.model);
      assert.equal(all.ghost?.model, all.execution?.model);
    });
  }

  it('works with NO registry at all (no tier hints) — still collapses to the one model', () => {
    const all = resolveAllRoles({ mode: 'quality-first', available: single });
    for (const role of ALL_ROLES) {
      assert.equal(all[role]?.model, 'sonnet');
    }
  });

  it('a single provider with several models keeps every role ON that provider', () => {
    const oneProvider: readonly ProviderModels[] = [
      { provider: 'claude', models: ['opus', 'sonnet', 'haiku'] },
    ];
    const all = resolveAllRoles({ mode: 'balanced', available: oneProvider, registry: REGISTRY });
    for (const role of ALL_ROLES) {
      assert.equal(all[role]?.provider, 'claude');
    }
  });
});
