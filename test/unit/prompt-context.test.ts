/**
 * test/unit/prompt-context.test.ts — the MF1 prompt-assembly seam.
 *
 * `assembleContextBlocks` is the ONE place memory/intent/engagement/partner
 * context is composed. These table tests pin its contract: each block
 * present/absent, canonical order (MEMORY → INTENT → ENGAGEMENT → partner nudge),
 * "" when none, and the cap. Pure — no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleContextBlocks,
  engagementBiasOf,
  partnerNudge,
  type ContextBlockOptions,
  type PartnerStyle,
} from '../../src/core/prompt-context.ts';

describe('engagementBiasOf', () => {
  it('maps partnerStyle to the signed soft bias (direct=-1, balanced=0, collaborative=+1)', () => {
    assert.equal(engagementBiasOf('direct'), -1);
    assert.equal(engagementBiasOf('balanced'), 0);
    assert.equal(engagementBiasOf('collaborative'), 1);
  });
});

describe('partnerNudge', () => {
  it('emits a posture line for direct and collaborative, nothing for balanced (neutral)', () => {
    assert.match(partnerNudge('direct'), /PARTNER POSTURE/);
    assert.match(partnerNudge('direct').toLowerCase(), /direct/);
    assert.match(partnerNudge('collaborative'), /PARTNER POSTURE/);
    assert.match(partnerNudge('collaborative').toLowerCase(), /collaborative/);
    assert.equal(partnerNudge('balanced'), '');
  });
});

describe('assembleContextBlocks', () => {
  const ENV = 'ENVIRONMENT\n  cwd:    /work\n  repo:   acme-web  (branch main)';
  const MEM = 'USER PREFERENCES AND MEMORY:\n- prefers concise answers';
  const INTENT = 'INTENT (your current understanding):\nShip the feature';
  const ENG = 'ENGAGEMENT:\nFirst inspect X. Then reflect the goal in one line.';

  it('renders the ENVIRONMENT block FIRST (orientation precedes everything)', () => {
    assert.equal(assembleContextBlocks({ environmentContext: ENV }), ENV);
    const out = assembleContextBlocks({
      environmentContext: ENV,
      memoryContext: MEM,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'collaborative',
    });
    const iEnv = out.indexOf(ENV);
    const iMem = out.indexOf(MEM);
    assert.equal(iEnv, 0);
    assert.ok(iMem > iEnv);
  });

  const TOOLSTATE = 'ABOUT THIS TOOL (authoritative):\n- You are the assistant inside myshell-tools v3.19.0';

  it('renders the TOOL-STATE block adjacent to ENVIRONMENT (right after it) when both present', () => {
    const out = assembleContextBlocks({
      environmentContext: ENV,
      toolStateContext: TOOLSTATE,
      memoryContext: MEM,
    });
    const iEnv = out.indexOf(ENV);
    const iTool = out.indexOf(TOOLSTATE);
    const iMem = out.indexOf(MEM);
    assert.equal(iEnv, 0);
    assert.ok(iTool > iEnv, 'tool-state follows ENVIRONMENT');
    assert.ok(iMem > iTool, 'MEMORY follows tool-state');
  });

  it('includes the TOOL-STATE block alone when present, omits it cleanly when absent/whitespace', () => {
    assert.equal(assembleContextBlocks({ toolStateContext: TOOLSTATE }), TOOLSTATE);
    // Absent → omitted entirely.
    assert.equal(assembleContextBlocks({ memoryContext: MEM }).includes('ABOUT THIS TOOL'), false);
    // Whitespace-only → treated as absent (byte-identical to omitting the key).
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    const withEmpty = assembleContextBlocks({ toolStateContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  it('omits the ENVIRONMENT block when absent or whitespace (byte-identical)', () => {
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    const withEmpty = assembleContextBlocks({ environmentContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  it('returns "" when no blocks apply', () => {
    assert.equal(assembleContextBlocks({}), '');
    // balanced is neutral → no nudge → still empty
    assert.equal(assembleContextBlocks({ partnerStyle: 'balanced' }), '');
    // whitespace-only blocks are treated as absent
    assert.equal(
      assembleContextBlocks({ memoryContext: '   ', intentFrame: '\n\t' }),
      '',
    );
  });

  it('renders each block independently when present', () => {
    assert.equal(assembleContextBlocks({ memoryContext: MEM }), MEM);
    assert.equal(assembleContextBlocks({ intentFrame: INTENT }), INTENT);
    assert.equal(assembleContextBlocks({ engagementPlan: ENG }), ENG);
    assert.match(assembleContextBlocks({ partnerStyle: 'direct' }), /PARTNER POSTURE/);
  });

  it('preserves the canonical order MEMORY → INTENT → ENGAGEMENT → partner nudge', () => {
    const out = assembleContextBlocks({
      memoryContext: MEM,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'collaborative',
    });
    const iMem = out.indexOf(MEM);
    const iIntent = out.indexOf(INTENT);
    const iEng = out.indexOf(ENG);
    const iNudge = out.indexOf('PARTNER POSTURE');
    assert.ok(iMem >= 0);
    assert.ok(iIntent > iMem);
    assert.ok(iEng > iIntent);
    assert.ok(iNudge > iEng);
  });

  const WORKSTATE =
    'WORK STATE (truthful, from accepted prior turns):\nOBJECTIVE: ship the dashboard\nDONE: wired route\nNEXT (model-stated, not yet verified): hydrate the chart\nBLOCKED: none';

  it('renders the WORK STATE block after MEMORY / before INTENT (AP2-B §2.3 B)', () => {
    const out = assembleContextBlocks({
      memoryContext: MEM,
      workStateContext: WORKSTATE,
      intentFrame: INTENT,
    });
    const iMem = out.indexOf(MEM);
    const iWork = out.indexOf(WORKSTATE);
    const iIntent = out.indexOf(INTENT);
    assert.ok(iMem >= 0);
    assert.ok(iWork > iMem, 'WORK STATE follows MEMORY');
    assert.ok(iIntent > iWork, 'INTENT follows WORK STATE');
  });

  it('includes WORK STATE alone when present, omits it cleanly when absent/whitespace', () => {
    assert.equal(assembleContextBlocks({ workStateContext: WORKSTATE }), WORKSTATE);
    assert.equal(assembleContextBlocks({ memoryContext: MEM }).includes('WORK STATE'), false);
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    const withEmpty = assembleContextBlocks({ workStateContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  it('joins present blocks with a blank line and trims each', () => {
    const out = assembleContextBlocks({
      memoryContext: `\n${MEM}\n`,
      engagementPlan: ENG,
    });
    assert.equal(out, `${MEM}\n\n${ENG}`);
  });

  it('skips the neutral balanced nudge even when other blocks are present', () => {
    const out = assembleContextBlocks({
      memoryContext: MEM,
      partnerStyle: 'balanced',
    });
    assert.equal(out, MEM);
    assert.doesNotMatch(out, /PARTNER POSTURE/);
  });

  it('caps the total injected length regardless of caller', () => {
    const huge = 'x'.repeat(20_000);
    const out = assembleContextBlocks({ memoryContext: huge });
    assert.ok(out.length <= 6000);
  });

  for (const [style, bias] of [
    ['direct', -1],
    ['balanced', 0],
    ['collaborative', 1],
  ] as ReadonlyArray<readonly [PartnerStyle, number]>) {
    it(`partnerStyle ${style} seeds engagementBias ${bias} (soft-bias contract)`, () => {
      assert.equal(engagementBiasOf(style), bias);
    });
  }

  it('is pure (same input → same output, no mutation of opts)', () => {
    const opts: ContextBlockOptions = { memoryContext: MEM, partnerStyle: 'direct' };
    const a = assembleContextBlocks(opts);
    const b = assembleContextBlocks(opts);
    assert.equal(a, b);
    assert.deepEqual(opts, { memoryContext: MEM, partnerStyle: 'direct' });
  });
});
