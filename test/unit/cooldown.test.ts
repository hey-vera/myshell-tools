/**
 * test/unit/cooldown.test.ts — unit tests for the per-conversation provider
 * rate-limit cooldown (pure core helpers).
 *
 * Honesty Contract: no fabricated data; all times are explicit fixtures.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  RATE_LIMIT_COOLDOWN_MS,
  cooldownExpiry,
  availableAfterCooldown,
} from '../../src/core/cooldown.ts';
import type { ProviderId } from '../../src/providers/port.ts';

describe('cooldownExpiry', () => {
  it('adds RATE_LIMIT_COOLDOWN_MS to now', () => {
    assert.equal(cooldownExpiry(1_000), 1_000 + RATE_LIMIT_COOLDOWN_MS);
  });

  it('is pure (same input → same output)', () => {
    assert.equal(cooldownExpiry(42), cooldownExpiry(42));
  });
});

describe('availableAfterCooldown', () => {
  const all: readonly ProviderId[] = ['claude', 'codex', 'opencode'];

  it('returns the full list when no cooldowns are set', () => {
    assert.deepEqual(availableAfterCooldown(all, new Map(), 1_000), all);
  });

  it('drops a provider whose cooldown has not expired', () => {
    const cd = new Map<ProviderId, number>([['claude', 10_000]]);
    assert.deepEqual(availableAfterCooldown(all, cd, 5_000), ['codex', 'opencode']);
  });

  it('keeps a provider whose cooldown has expired (until <= now)', () => {
    const cd = new Map<ProviderId, number>([['claude', 5_000]]);
    assert.deepEqual(availableAfterCooldown(all, cd, 5_000), all);
  });

  it('preserves order of the surviving providers', () => {
    const cd = new Map<ProviderId, number>([['codex', 10_000]]);
    assert.deepEqual(availableAfterCooldown(all, cd, 1_000), ['claude', 'opencode']);
  });

  it('NEVER strands the user: all cooling down → returns the full original list', () => {
    const cd = new Map<ProviderId, number>([
      ['claude', 10_000],
      ['codex', 10_000],
      ['opencode', 10_000],
    ]);
    assert.deepEqual(availableAfterCooldown(all, cd, 1_000), all);
  });

  it('single provider in cooldown → still returned (no stranding)', () => {
    const cd = new Map<ProviderId, number>([['claude', 10_000]]);
    assert.deepEqual(availableAfterCooldown(['claude'], cd, 1_000), ['claude']);
  });

  it('empty input → empty output', () => {
    assert.deepEqual(availableAfterCooldown([], new Map(), 1_000), []);
  });
});
