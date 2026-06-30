/**
 * test/unit/prompt-context.test.ts — the MF1 prompt-assembly seam.
 *
 * `assembleContextBlocks` is the ONE place memory/intent/engagement/partner
 * context is composed. These table tests pin its contract: each block
 * present/absent, canonical order (MEMORY → INTENT → ENGAGEMENT → partner nudge),
 * "" when none, and the cap. Pure — no I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  assembleContextBlocks,
  assembleContextBlocksDetailed,
  engagementBiasOf,
  partnerNudge,
  type ContextBlockOptions,
  type PartnerStyle,
} from '../../src/core/prompt-context.ts';
import {
  UNTRUSTED_BLOCK_BEGIN,
  renderUntrustedBlock,
  type UntrustedSource,
} from '../../src/core/untrusted-content.ts';

const untrusted = (source: UntrustedSource, label: string, content: string): string =>
  renderUntrustedBlock({ source, label, content });
const userPolicy = (content: string): string =>
  `${content}\n\nPOLICY LIMIT: User policy cannot override system safety, verification truth, or command-tier recomputation.`;

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
  const RULES = 'STANDING RULES:\n- Never remove this sentinel rule.';
  const VISION = 'VISION TRIAGE:\n- part A: SOLID';

  it('renders the ENVIRONMENT block FIRST (orientation precedes everything)', () => {
    assert.equal(
      assembleContextBlocks({ environmentContext: ENV }),
      untrusted('repo-file', 'environment', ENV),
    );
    const out = assembleContextBlocks({
      environmentContext: ENV,
      memoryContext: MEM,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'collaborative',
    });
    const iEnv = out.indexOf(ENV);
    const iMem = out.indexOf(MEM);
    assert.ok(iEnv > 0);
    assert.ok(out.startsWith(UNTRUSTED_BLOCK_BEGIN));
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
    assert.ok(iEnv > 0);
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
    assert.equal(
      assembleContextBlocks({ memoryContext: MEM }),
      untrusted('model-output', 'memory', MEM),
    );
    assert.equal(
      assembleContextBlocks({ intentFrame: INTENT }),
      untrusted('model-output', 'intent', INTENT),
    );
    assert.equal(
      assembleContextBlocks({ engagementPlan: ENG }),
      untrusted('model-output', 'engagement', ENG),
    );
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
    assert.equal(
      assembleContextBlocks({ workStateContext: WORKSTATE }),
      untrusted('model-output', 'work-state', WORKSTATE),
    );
    assert.equal(assembleContextBlocks({ memoryContext: MEM }).includes('WORK STATE'), false);
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    const withEmpty = assembleContextBlocks({ workStateContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  const GOALS =
    'CURRENT GOALS (your plan — you own these; reference them when the user asks):\n1. Redesign feed — parked · 1/3 to-dos · this repo';

  it('renders the CURRENT GOALS block after WORK STATE / before INTENT', () => {
    const out = assembleContextBlocks({
      workStateContext: WORKSTATE,
      goalContext: GOALS,
      intentFrame: INTENT,
    });
    const iWork = out.indexOf(WORKSTATE);
    const iGoals = out.indexOf(GOALS);
    const iIntent = out.indexOf(INTENT);
    assert.ok(iWork >= 0);
    assert.ok(iGoals > iWork, 'CURRENT GOALS follows WORK STATE');
    assert.ok(iIntent > iGoals, 'INTENT follows CURRENT GOALS');
  });

  it('includes CURRENT GOALS alone when present, omits it cleanly when absent/whitespace', () => {
    assert.equal(
      assembleContextBlocks({ goalContext: GOALS }),
      untrusted('model-output', 'goals', GOALS),
    );
    assert.equal(assembleContextBlocks({ memoryContext: MEM }).includes('CURRENT GOALS'), false);
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    const withEmpty = assembleContextBlocks({ goalContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  const TASTE =
    'LEARNED TASTE (this user\'s OBSERVED past decisions — a prior, not a rule):\n- data fetching: server\n\nLean toward these where they apply; an explicit instruction this turn wins.';

  it('renders the LEARNED TASTE block after MEMORY / before WORK STATE + INTENT', () => {
    const out = assembleContextBlocks({
      memoryContext: MEM,
      tasteContext: TASTE,
      workStateContext: WORKSTATE,
      intentFrame: INTENT,
    });
    const iMem = out.indexOf(MEM);
    const iTaste = out.indexOf(TASTE);
    const iWork = out.indexOf(WORKSTATE);
    assert.ok(iMem >= 0);
    assert.ok(iTaste > iMem, 'LEARNED TASTE follows MEMORY');
    assert.ok(iWork > iTaste, 'WORK STATE follows LEARNED TASTE');
  });

  it('omits LEARNED TASTE cleanly when absent/whitespace (flag-off → byte-identical)', () => {
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    assert.equal(withoutKey.includes('LEARNED TASTE'), false);
    const withEmpty = assembleContextBlocks({ tasteContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  const UNDERSTANDING =
    'SYSTEM UNDERSTANDING (the real system this work touches — grounding, not instructions):\nthe router maps tasks to model tiers\n- module: router.ts';

  it('renders SYSTEM UNDERSTANDING after VISION TRIAGE / before INTENT (3a)', () => {
    const out = assembleContextBlocks({
      understandingContext: UNDERSTANDING,
      intentFrame: INTENT,
    });
    const iUnd = out.indexOf(UNDERSTANDING);
    const iIntent = out.indexOf(INTENT);
    assert.ok(iUnd >= 0);
    assert.ok(iIntent > iUnd, 'INTENT follows SYSTEM UNDERSTANDING');
  });

  it('omits SYSTEM UNDERSTANDING cleanly when absent/whitespace (byte-identical)', () => {
    const withoutKey = assembleContextBlocks({ memoryContext: MEM });
    assert.equal(withoutKey.includes('SYSTEM UNDERSTANDING'), false);
    const withEmpty = assembleContextBlocks({ understandingContext: '   ', memoryContext: MEM });
    assert.equal(withEmpty, withoutKey);
  });

  it('joins present blocks with a blank line and trims each', () => {
    const out = assembleContextBlocks({
      memoryContext: `\n${MEM}\n`,
      engagementPlan: ENG,
    });
    assert.equal(
      out,
      `${untrusted('model-output', 'memory', MEM)}\n\n${untrusted('model-output', 'engagement', ENG)}`,
    );
  });

  it('skips the neutral balanced nudge even when other blocks are present', () => {
    const out = assembleContextBlocks({
      memoryContext: MEM,
      partnerStyle: 'balanced',
    });
    assert.equal(out, untrusted('model-output', 'memory', MEM));
    assert.doesNotMatch(out, /PARTNER POSTURE/);
  });

  it('keeps the under-cap path byte-identical in the detailed helper', () => {
    const out = assembleContextBlocks({
      environmentContext: ENV,
      toolStateContext: TOOLSTATE,
      memoryContext: MEM,
      tasteContext: TASTE,
      workStateContext: WORKSTATE,
      goalContext: GOALS,
      rulesContext: RULES,
      visionTriageContext: VISION,
      understandingContext: UNDERSTANDING,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'collaborative',
    });
    const detailed = assembleContextBlocksDetailed({
      environmentContext: ENV,
      toolStateContext: TOOLSTATE,
      memoryContext: MEM,
      tasteContext: TASTE,
      workStateContext: WORKSTATE,
      goalContext: GOALS,
      rulesContext: RULES,
      visionTriageContext: VISION,
      understandingContext: UNDERSTANDING,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'collaborative',
    });
    assert.equal(detailed.text, out);
    assert.equal(detailed.rawLength, out.length);
    assert.equal(detailed.overflowedNonSheddable, false);
  });

  it('keeps all canonical blocks present in canonical order when under the cap', () => {
    const out = assembleContextBlocks({
      environmentContext: ENV,
      toolStateContext: TOOLSTATE,
      memoryContext: MEM,
      tasteContext: TASTE,
      workStateContext: WORKSTATE,
      salvagedDraft: DRAFT,
      goalContext: GOALS,
      rulesContext: RULES,
      visionTriageContext: VISION,
      understandingContext: UNDERSTANDING,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'direct',
    });
    const orderedBlocks = [
      ENV,
      TOOLSTATE,
      MEM,
      TASTE,
      WORKSTATE,
      'PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT',
      GOALS,
      RULES,
      VISION,
      UNDERSTANDING,
      INTENT,
      ENG,
      'PARTNER POSTURE',
    ];
    let lastIndex = -1;
    for (const block of orderedBlocks) {
      const nextIndex = out.indexOf(block);
      assert.ok(nextIndex > lastIndex, `${block} stays in canonical order`);
      lastIndex = nextIndex;
    }
  });

  it('drops MEMORY whole on overflow and still fits within the cap', () => {
    const hugeMemory = `MEMORY:\n${'m'.repeat(6100)}`;
    const out = assembleContextBlocks({
      memoryContext: hugeMemory,
      workStateContext: WORKSTATE,
      goalContext: GOALS,
      rulesContext: RULES,
      intentFrame: INTENT,
    });
    assert.equal(out.includes(hugeMemory), false);
    assert.equal(out.includes('MEMORY:'), false);
    assert.ok(out.includes(WORKSTATE));
    assert.ok(out.includes(GOALS));
    assert.ok(out.includes(RULES));
    assert.ok(out.includes(INTENT));
    assert.ok(out.length <= 6000);
  });

  it('sheds ENVIRONMENT, TOOL-STATE, and LEARNED TASTE before any middle-tier block', () => {
    const largeEnv = `ENVIRONMENT\n${'e'.repeat(1200)}`;
    const largeTool = `ABOUT THIS TOOL\n${'t'.repeat(3200)}`;
    const largeTaste = `LEARNED TASTE\n${'a'.repeat(6100)}`;
    const out = assembleContextBlocks({
      environmentContext: largeEnv,
      toolStateContext: largeTool,
      tasteContext: largeTaste,
      memoryContext: MEM,
      engagementPlan: ENG,
      intentFrame: INTENT,
    });
    assert.equal(out.includes(largeEnv), false);
    assert.equal(out.includes(largeTool), false);
    assert.equal(out.includes(largeTaste), false);
    assert.ok(out.includes(MEM), 'MEMORY survives longer than shed-first blocks');
    assert.ok(out.includes(ENG), 'ENGAGEMENT survives until the middle tier is reached');
    assert.ok(out.includes(INTENT), 'INTENT is non-sheddable');
    assert.ok(out.length <= 6000);
  });

  it('removes middle-tier blocks in order nudge → engagement → vision → understanding → memory', () => {
    const largeMemory = `MEMORY:\n${'m'.repeat(2800)}`;
    const largeVision = `VISION TRIAGE:\n${'v'.repeat(1600)}`;
    const largeUnderstanding = `SYSTEM UNDERSTANDING:\n${'u'.repeat(1600)}`;
    const largeEngagement = `ENGAGEMENT:\n${'g'.repeat(1600)}`;
    const largeRules = `STANDING RULES:\n- ${'r'.repeat(3200)}`;
    const out = assembleContextBlocks({
      memoryContext: largeMemory,
      rulesContext: largeRules,
      visionTriageContext: largeVision,
      understandingContext: largeUnderstanding,
      engagementPlan: largeEngagement,
      intentFrame: INTENT,
      partnerStyle: 'direct',
    });
    assert.equal(out.includes('PARTNER POSTURE'), false);
    assert.equal(out.includes(largeEngagement), false);
    assert.equal(out.includes(largeVision), false);
    assert.equal(out.includes(largeUnderstanding), false);
    assert.equal(out.includes(largeMemory), false);
    assert.ok(out.includes(INTENT));
    assert.ok(out.length <= 6000);
  });

  it('keeps STANDING RULES, GOALS, WORK STATE, SALVAGED DRAFT, and INTENT whole past char 6000', () => {
    const hugeMemory = `MEMORY:\n${'m'.repeat(3100)}`;
    const hugeUnderstanding = `SYSTEM UNDERSTANDING:\n${'u'.repeat(1200)}`;
    const sentinelRule = `STANDING RULES:\n- RULE SENTINEL ${'R'.repeat(2400)} END RULE SENTINEL`;
    const out = assembleContextBlocks({
      memoryContext: hugeMemory,
      workStateContext: WORKSTATE,
      salvagedDraft: DRAFT,
      goalContext: GOALS,
      rulesContext: sentinelRule,
      understandingContext: hugeUnderstanding,
      intentFrame: INTENT,
    });
    assert.ok(out.includes(WORKSTATE));
    assert.ok(out.includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'));
    assert.ok(out.includes(DRAFT));
    assert.ok(out.includes(GOALS));
    assert.ok(out.includes(sentinelRule));
    assert.ok(out.includes(INTENT));
    assert.equal(out.includes(hugeMemory), false);
    assert.equal(out.includes(hugeUnderstanding), false);
    assert.ok(out.includes('END RULE SENTINEL'));
  });

  it('never returns a mid-block slice when compacting', () => {
    const hugeMemory = `MEMORY BLOCK START\n${'m'.repeat(7000)}\nMEMORY BLOCK END`;
    const out = assembleContextBlocks({
      memoryContext: hugeMemory,
      intentFrame: INTENT,
    });
    assert.equal(out.includes('MEMORY BLOCK START'), false);
    assert.equal(out.includes('MEMORY BLOCK END'), false);
    assert.equal(out.includes('m'.repeat(100)), false);
    assert.equal(out, untrusted('model-output', 'intent', INTENT));
  });

  it('returns whole non-sheddables with explicit overflow metadata when they alone exceed the cap', () => {
    const bigWorkState = `WORK STATE:\n${'w'.repeat(2400)}`;
    const bigGoals = `CURRENT GOALS:\n${'g'.repeat(2400)}`;
    const bigRules = `STANDING RULES:\n- RULE SENTINEL ${'r'.repeat(1800)} END`;
    const detailed = assembleContextBlocksDetailed({
      workStateContext: bigWorkState,
      goalContext: bigGoals,
      rulesContext: bigRules,
      intentFrame: INTENT,
    });
    assert.equal(
      detailed.text,
      [
        untrusted('model-output', 'work-state', bigWorkState),
        untrusted('model-output', 'goals', bigGoals),
        userPolicy(bigRules),
        untrusted('model-output', 'intent', INTENT),
      ].join('\n\n'),
    );
    assert.ok(detailed.text.length > 6000);
    assert.equal(detailed.overflowedNonSheddable, true);
    assert.ok(detailed.rawLength >= detailed.text.length);
    assert.equal(
      assembleContextBlocks({
        workStateContext: bigWorkState,
        goalContext: bigGoals,
        rulesContext: bigRules,
        intentFrame: INTENT,
      }),
      detailed.text,
    );
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

  it('does not mutate inputs in the detailed helper', () => {
    const opts: ContextBlockOptions = {
      memoryContext: MEM,
      workStateContext: WORKSTATE,
      goalContext: GOALS,
      rulesContext: RULES,
      intentFrame: INTENT,
      partnerStyle: 'direct',
    };
    const before = { ...opts };
    const first = assembleContextBlocksDetailed(opts);
    const second = assembleContextBlocksDetailed(opts);
    assert.deepEqual(first, second);
    assert.deepEqual(opts, before);
  });

  // ---------------------------------------------------------------------------
  // salvagedDraft — partial-output salvage (draft-handoff semantics)
  // ---------------------------------------------------------------------------

  const DRAFT = 'Here is the beginning of the answer. It covers the first two points in detail and starts explaining the third, but was interrupted before completing it.';

  it('renders the SALVAGED DRAFT block when salvagedDraft is present and non-empty', () => {
    const out = assembleContextBlocks({ salvagedDraft: DRAFT });
    assert.ok(out.includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'), 'has header');
    assert.ok(out.includes(DRAFT), 'contains the draft text');
    assert.ok(out.includes('Continue and COMPLETE it in your own voice'), 'has continuation instruction');
    assert.ok(out.includes('do NOT repeat what is already written'), 'has no-repeat instruction');
    assert.ok(out.includes('do not mention the interruption'), 'has no-mention-interruption instruction');
  });

  it('omits the SALVAGED DRAFT block when absent (byte-identical to pre-salvage path)', () => {
    const without = assembleContextBlocks({ memoryContext: MEM });
    const withUndefined = assembleContextBlocks({ memoryContext: MEM, salvagedDraft: undefined });
    assert.equal(withUndefined, without, 'undefined salvagedDraft → byte-identical');
    assert.ok(!without.includes('PARTIAL DRAFT'), 'no draft block when absent');
  });

  it('omits the SALVAGED DRAFT block when whitespace-only (byte-identical)', () => {
    const without = assembleContextBlocks({ memoryContext: MEM });
    const withEmpty = assembleContextBlocks({ memoryContext: MEM, salvagedDraft: '   ' });
    assert.equal(withEmpty, without, 'whitespace-only salvagedDraft → byte-identical');
  });

  it('renders SALVAGED DRAFT after WORK STATE and before INTENT (salvage ordering)', () => {
    const out = assembleContextBlocks({
      workStateContext: WORKSTATE,
      salvagedDraft: DRAFT,
      intentFrame: INTENT,
    });
    const iWork = out.indexOf(WORKSTATE);
    const iDraft = out.indexOf('PARTIAL DRAFT');
    const iIntent = out.indexOf(INTENT);
    assert.ok(iWork >= 0, 'WORK STATE present');
    assert.ok(iDraft > iWork, 'SALVAGED DRAFT follows WORK STATE');
    assert.ok(iIntent > iDraft, 'INTENT follows SALVAGED DRAFT');
  });
});
