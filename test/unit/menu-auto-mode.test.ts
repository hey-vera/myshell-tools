import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { legacyModeToIntensity } from '../../src/core/capacity-allocator.ts';
import { resolveIntensity } from '../../src/interface/menu-auto-mode.ts';
import type { AppConfig } from '../../src/infra/config.ts';

describe('resolveIntensity', () => {
  const baseConfig: AppConfig = { onboarded: true, setAsDefault: false };

  it('prefers a conversation numeric override over global and legacy config', () => {
    const resolved = resolveIntensity(
      { intensity: 2 },
      { ...baseConfig, intensity: 5, mode: 'quality-first', panel: true, hedge: true },
    );
    assert.deepEqual(resolved, { source: 'conversation', value: 2 });
  });

  it('falls back to the global numeric default when the conversation is absent or auto', () => {
    assert.deepEqual(
      resolveIntensity(undefined, { ...baseConfig, intensity: 4 }),
      { source: 'global', value: 4 },
    );
    assert.deepEqual(
      resolveIntensity({ intensity: 'auto' }, { ...baseConfig, intensity: 3 }),
      { source: 'global', value: 3 },
    );
  });

  it('falls through auto values to the legacy bridge when legacy keys are present', () => {
    const config = { ...baseConfig, intensity: 'auto', mode: 'cost-saver' as const, hedge: true };
    assert.deepEqual(
      resolveIntensity({ intensity: 'auto' }, config),
      { source: 'legacy', value: legacyModeToIntensity('cost-saver', { hedge: true }) },
    );
  });

  it('uses legacy mode/panel/hedge precedence when no new numeric override exists', () => {
    assert.deepEqual(
      resolveIntensity(undefined, { ...baseConfig, mode: 'balanced', panel: true }),
      { source: 'legacy', value: legacyModeToIntensity('balanced', { panel: true }) },
    );
    assert.deepEqual(
      resolveIntensity(undefined, { ...baseConfig, hedge: true }),
      { source: 'legacy', value: legacyModeToIntensity('balanced', { hedge: true }) },
    );
  });

  it('returns auto when neither new nor legacy settings are present', () => {
    assert.deepEqual(resolveIntensity(undefined, baseConfig), { source: 'auto', value: 'auto' });
  });
});
