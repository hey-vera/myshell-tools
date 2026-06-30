import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { planningDepthEnabled } from '../../src/interface/ui/planning-depth-flag.ts';

describe('planningDepthEnabled', () => {
  it('defaults off', () => {
    assert.equal(planningDepthEnabled(undefined, undefined), false);
    assert.equal(planningDepthEnabled({}, {}), false);
    assert.equal(planningDepthEnabled({}, { experimentalPlanningDepth: false }), false);
  });

  it('opts in through env or config', () => {
    for (const value of ['1', 'true', 'on', 'yes', ' TRUE ']) {
      assert.equal(planningDepthEnabled({ MYSHELL_PLANNING_DEPTH: value }, undefined), true);
    }
    assert.equal(planningDepthEnabled({}, { experimentalPlanningDepth: true }), true);
  });

  it('explicit env opt-out overrides config and ambiguous env values stay off', () => {
    assert.equal(
      planningDepthEnabled(
        { MYSHELL_PLANNING_DEPTH: 'off' },
        { experimentalPlanningDepth: true },
      ),
      false,
    );
    assert.equal(planningDepthEnabled({ MYSHELL_PLANNING_DEPTH: 'maybe' }, undefined), false);
  });

  it('fails closed for a hostile env bag', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
    assert.equal(planningDepthEnabled(hostile, { experimentalPlanningDepth: true }), false);
  });
});
