/**
 * R2.1 — turn lane inventory freeze + selected-lane snapshot.
 *
 * Proves:
 *  1. After freeze, mutating source availableModels / accounts does not change
 *     the frozen inventory or selectExecutionLane results that use it.
 *  2. A second turn freeze from updated inventory can select a different model.
 *  3. turnLaneSnapshotFromLane captures provider/account/model + generation.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  freezeTurnInventory,
  freezeTurnInventoryFromDeps,
  turnLaneSnapshotFromLane,
  sameInventoryGeneration,
  deriveInventoryGeneration,
} from '../../src/core/turn-lane-snapshot.ts';
import {
  selectExecutionLane,
} from '../../src/core/execution-lane.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { ProviderId } from '../../src/providers/port.ts';

const nowMs = 1_000_000;
const emptyCooldown = new Map<string, number>();

describe('freezeTurnInventory (R2.1)', () => {
  it('deep-copies availableModels so later mutation does not change the freeze', () => {
    const liveModels: Partial<Record<ProviderId, string[]>> = {
      claude: ['claude-sonnet-4-6'],
      codex: ['gpt-5.3-codex'],
    };
    const freeze = freezeTurnInventory({
      availableModels: liveModels,
      frozenAt: 'work-call-dispatch',
    });

    // Mutate the caller's live inventory (mid-turn refresh simulation).
    liveModels.claude!.push('claude-opus-4-7');
    liveModels.claude![0] = 'mutated-model';
    delete liveModels.codex;

    assert.deepEqual(freeze.availableModels?.claude, ['claude-sonnet-4-6']);
    assert.deepEqual(freeze.availableModels?.codex, ['gpt-5.3-codex']);
    assert.equal(
      freeze.inventoryGeneration,
      deriveInventoryGeneration({
        availableModels: {
          claude: ['claude-sonnet-4-6'],
          codex: ['gpt-5.3-codex'],
        },
      }),
    );
  });

  it('explicit inventoryGeneration is frozen and not re-derived after mutation', () => {
    const liveModels: Partial<Record<ProviderId, string[]>> = {
      claude: ['model-a'],
    };
    const freeze = freezeTurnInventory({
      availableModels: liveModels,
      inventoryGeneration: 7,
      frozenAt: 'work-call-dispatch',
    });
    liveModels.claude = ['model-b', 'model-c'];
    assert.equal(freeze.inventoryGeneration, 7);
    assert.deepEqual(freeze.availableModels?.claude, ['model-a']);
  });

  it('selectExecutionLane using frozen inventory ignores post-freeze model mutation', () => {
    // worker-tier haiku is the only cheap model; freeze pins it.
    const liveModels: Partial<Record<ProviderId, string[]>> = {
      claude: ['claude-haiku-4-5'],
    };
    const freeze = freezeTurnInventory({
      availableModels: liveModels,
      inventoryGeneration: 'turn-gen-1',
      frozenAt: 'work-call-dispatch',
    });

    // Catalog refresh mid-turn: live inventory now only lists sonnet (ic).
    liveModels.claude = ['claude-sonnet-4-6'];

    const frozenResult = selectExecutionLane({
      tier: 'worker',
      available: ['claude'] as const,
      policy: DEFAULT_POLICY,
      availableModels: freeze.availableModels,
      inventoryGeneration: freeze.inventoryGeneration,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(frozenResult.ok, true);
    if (!frozenResult.ok) return;
    assert.equal(frozenResult.lane.model, 'claude-haiku-4-5');
    assert.equal(frozenResult.lane.inventoryGeneration, 'turn-gen-1');

    // Control: the same tier against *live* inventory after mutation would still
    // only allow haiku in pricing for worker if sonnet is the only live id —
    // use ic tier against live sonnet list to show a different selection.
    const liveIc = selectExecutionLane({
      tier: 'ic',
      available: ['claude'] as const,
      policy: DEFAULT_POLICY,
      availableModels: liveModels,
      inventoryGeneration: 'turn-gen-live',
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(liveIc.ok, true);
    if (!liveIc.ok) return;
    assert.equal(liveIc.lane.model, 'claude-sonnet-4-6');
    assert.notEqual(frozenResult.lane.model, liveIc.lane.model);
  });

  it('second turn freeze can adopt a new model when inventory updates between turns', () => {
    const modelsTurn1: Partial<Record<ProviderId, string[]>> = {
      claude: ['claude-haiku-4-5'],
    };
    const freeze1 = freezeTurnInventoryFromDeps(
      { availableModels: modelsTurn1, inventoryGeneration: 1 },
      'work-call-dispatch',
    );
    const lane1 = selectExecutionLane({
      tier: 'worker',
      available: ['claude'] as const,
      policy: DEFAULT_POLICY,
      availableModels: freeze1.availableModels,
      inventoryGeneration: freeze1.inventoryGeneration,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(lane1.ok, true);
    if (!lane1.ok) return;
    assert.equal(lane1.lane.model, 'claude-haiku-4-5');

    // Safe boundary: next turn sees refreshed inventory + different tier need.
    const modelsTurn2: Partial<Record<ProviderId, string[]>> = {
      claude: ['claude-sonnet-4-6'],
    };
    const freeze2 = freezeTurnInventoryFromDeps(
      { availableModels: modelsTurn2, inventoryGeneration: 2 },
      'work-call-dispatch',
    );
    assert.equal(
      sameInventoryGeneration(freeze1.inventoryGeneration, freeze2.inventoryGeneration),
      false,
    );

    const lane2 = selectExecutionLane({
      tier: 'ic',
      available: ['claude'] as const,
      policy: DEFAULT_POLICY,
      availableModels: freeze2.availableModels,
      inventoryGeneration: freeze2.inventoryGeneration,
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(lane2.ok, true);
    if (!lane2.ok) return;
    assert.equal(lane2.lane.model, 'claude-sonnet-4-6');
    assert.equal(lane2.lane.inventoryGeneration, 2);
    assert.notEqual(lane1.lane.model, lane2.lane.model);
  });

  it('deep-copies availableModelsByAccount rows', () => {
    const byAccount = {
      claude: {
        'acc-a': ['model-a'],
      },
    };
    const freeze = freezeTurnInventory({
      availableModelsByAccount: byAccount,
      frozenAt: 'hedge-primary-dispatch',
    });
    byAccount.claude['acc-a'] = ['model-mutated'];
    byAccount.claude['acc-b'] = ['model-new'];
    assert.deepEqual(freeze.availableModelsByAccount?.claude?.['acc-a'], ['model-a']);
    assert.equal(freeze.availableModelsByAccount?.claude?.['acc-b'], undefined);
    assert.equal(freeze.frozenAt, 'hedge-primary-dispatch');
  });
});

describe('turnLaneSnapshotFromLane (R2.1)', () => {
  it('captures provider, model, account id, tier, generation, and freeze reason', () => {
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'] as const,
      policy: DEFAULT_POLICY,
      availableModels: { claude: ['claude-sonnet-4-6'] },
      inventoryGeneration: 'snap-gen',
      nowMs,
      cooldownUntil: emptyCooldown,
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const snap = turnLaneSnapshotFromLane(result.lane, 'work-call-dispatch');
    assert.equal(snap.provider, 'claude');
    assert.equal(snap.model, 'claude-sonnet-4-6');
    assert.equal(snap.accountId, null);
    assert.equal(snap.tier, 'ic');
    assert.equal(snap.inventoryGeneration, 'snap-gen');
    assert.equal(snap.frozenAt, 'work-call-dispatch');
  });
});
