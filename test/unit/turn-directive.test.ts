/**
 * test/unit/turn-directive.test.ts — Adaptive Partner Engine v2, STAGE 1.
 *
 * Pure-function coverage for the enforced TurnDirective keystone:
 *   - compileTurnDirective: sets terminalQuestion ONLY on a genuine, non-
 *     investigable fork with a derivable QuestionSet; omits it on investigable /
 *     trivial / no-fork turns. Always carries the reject_generic_open_menu
 *     validator + a history policy.
 *   - validateTurnOutput / detectGenericOpenMenu: flags the fix/add/polish/
 *     integrate menu; passes normal answers, grounded recommendations, and legit
 *     option lists; never blocks when the turn is not repo-oriented.
 *   - decideHistoryPolicy: quarantines prior generic-menu assistant prose.
 *
 * PURE — no model, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileTurnDirective,
  validateTurnOutput,
  detectGenericOpenMenu,
  decideHistoryPolicy,
  detectRecommendation,
  detectGrounding,
  detectBareOptionsList,
  detectHonestNoContext,
  shouldAppendGroundedFallback,
  GENERIC_MENU_REPAIR_NOTE,
  GROUNDED_RECOMMENDATION_FALLBACK,
  type TurnDirective,
} from '../../src/core/turn-directive.ts';
import { planEngagement, type EngagementSignals } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';

const IC: Classification = { tier: 'ic', risk: 'medium', rationale: 't' };

function signals(over: Partial<EngagementSignals> & { task: string }): EngagementSignals {
  return {
    classification: IC,
    routePlan: false,
    engagementBias: 1, // collaborative — raises the fork budget so asks > 0
    ...over,
  };
}

function frameWith(forks: IntentFrame['forks'], kind = 'product'): IntentFrame {
  return { version: 1, goal: 'g', kind, confidence: 'low', forks, source: 'model' };
}

// ---------------------------------------------------------------------------
// compileTurnDirective — terminalQuestion gating
// ---------------------------------------------------------------------------

describe('compileTurnDirective — terminalQuestion', () => {
  it('sets terminalQuestion on a GENUINE non-investigable (preference) fork', () => {
    const frame = frameWith([
      {
        id: 'F1',
        question: 'Which tone do you prefer for the brand voice?',
        options: ['Playful', 'Formal'],
        assumeIfUnasked: 'Playful',
      },
    ]);
    const s = signals({ frame, task: 'write the marketing landing copy for the launch' });
    const plan = planEngagement(s);
    const d = compileTurnDirective({ frame, plan, signals: s });

    assert.ok(plan.actions.includes('ASK_CLARIFYING'), 'plan should ask');
    assert.ok(d.terminalQuestion !== undefined, 'a genuine fork yields a terminal ask');
    assert.equal(d.terminalQuestion.questions[0]?.id, 'F1');
    assert.equal(
      d.terminalQuestion.questions[0]?.prompt,
      'Which tone do you prefer for the brand voice?',
    );
  });

  it('omits terminalQuestion on an INVESTIGABLE generic-menu fork (investigate, do not ask)', () => {
    const frame = frameWith([
      {
        id: 'F1',
        question: 'What are you trying to do with the page?',
        options: ['fix something broken', 'add a new feature', 'polish the layout'],
      },
    ]);
    // A coding turn referencing an existing page is investigable.
    const s = signals({
      frame,
      task: 'make the existing socials page in this repo feel like the real product',
      classification: { tier: 'ic', risk: 'medium', rationale: 't' },
    });
    const plan = planEngagement(s);
    const d = compileTurnDirective({ frame, plan, signals: s });
    assert.equal(d.terminalQuestion, undefined, 'investigable generic menu is NOT a terminal ask');
  });

  it('omits terminalQuestion on a trivial / no-fork turn', () => {
    const frame = frameWith(undefined, 'coding');
    const s = signals({ frame, task: 'rename the variable foo to bar' });
    const plan = planEngagement(s);
    const d = compileTurnDirective({ frame, plan, signals: s });
    assert.equal(d.terminalQuestion, undefined);
  });

  it('always carries the reject_generic_open_menu validator and a history policy', () => {
    const s = signals({ task: 'do a thing' });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.deepEqual(d.outputValidators, [{ kind: 'reject_generic_open_menu' }]);
    assert.equal(d.historyPolicy.replayMode, 'normal');
    assert.equal(d.version, 1);
  });

  it('repoOriented true when INVESTIGATE_CONTEXT planned or a repo is present', () => {
    const s = signals({
      frame: frameWith(undefined, 'coding'),
      task: 'investigate the existing auth module and explain how it works',
    });
    const plan = planEngagement(s);
    const d = compileTurnDirective({ frame: undefined, plan, signals: s });
    assert.equal(d.repoOriented, plan.actions.includes('INVESTIGATE_CONTEXT'));

    const d2 = compileTurnDirective({
      frame: undefined,
      plan: planEngagement(signals({ task: 'brainstorm names' })),
      signals: signals({ task: 'brainstorm names' }),
      repoPresent: true,
    });
    assert.equal(d2.repoOriented, true, 'repoPresent forces repoOriented');
  });
});

// ---------------------------------------------------------------------------
// detectGenericOpenMenu / validateTurnOutput
// ---------------------------------------------------------------------------

const REPO_DIRECTIVE: TurnDirective = {
  version: 1,
  requiredBeforeAnswer: [],
  outputValidators: [{ kind: 'reject_generic_open_menu' }],
  historyPolicy: { replayMode: 'normal', reasons: [] },
  repoOriented: true,
  substantial: false,
};
const NON_REPO_DIRECTIVE: TurnDirective = { ...REPO_DIRECTIVE, repoOriented: false };

describe('detectGenericOpenMenu', () => {
  it('flags the fix/add/polish/integrate order-taker menu', () => {
    const menu =
      'Happy to help! What are you trying to do here — are you fixing something ' +
      'broken, adding a new feature, polishing the layout, or integrating the backend?';
    assert.equal(detectGenericOpenMenu(menu), true);
  });

  it('flags a "which task type" debug/refactor menu', () => {
    const menu =
      'Which kind of task is this? I can debug the issue, refactor the module, or add tests.';
    assert.equal(detectGenericOpenMenu(menu), true);
  });

  it('passes a grounded recommendation that mentions one verb', () => {
    const ok =
      'I looked at src/auth/session.ts and the token refresh never fires. ' +
      'The concrete next step is to fix the expiry comparison on line 42. Want me to do that?';
    assert.equal(detectGenericOpenMenu(ok), false);
  });

  it('passes a normal answer with no question', () => {
    assert.equal(
      detectGenericOpenMenu('I added the route and wired the handler; tests pass.'),
      false,
    );
  });

  it('passes a legit specific option list (a real fork, not broad categories)', () => {
    const ok =
      'For the datastore you could use Postgres or DynamoDB. I recommend Postgres ' +
      'for the relational shape. Want me to scaffold it?';
    assert.equal(detectGenericOpenMenu(ok), false);
  });

  it('passes empty / non-string input', () => {
    assert.equal(detectGenericOpenMenu(''), false);
    assert.equal(detectGenericOpenMenu(undefined as unknown as string), false);
  });
});

describe('validateTurnOutput', () => {
  it('fails the generic menu when repoOriented', () => {
    const menu =
      'What do you want to do — fix the bug, add a feature, or refactor the code?';
    const f = validateTurnOutput(menu, REPO_DIRECTIVE);
    assert.ok(f !== null);
    assert.equal(f.kind, 'generic_open_menu');
    assert.equal(f.severity, 'repair');
  });

  it('does NOT fire when the turn is not repo-oriented (brainstorming is allowed)', () => {
    const menu =
      'What do you want to do — fix the bug, add a feature, or refactor the code?';
    assert.equal(validateTurnOutput(menu, NON_REPO_DIRECTIVE), null);
  });

  it('passes a grounded answer even when repoOriented', () => {
    const ok = 'I inspected the repo; the next step is to fix the failing import in main.ts.';
    assert.equal(validateTurnOutput(ok, REPO_DIRECTIVE), null);
  });

  it('the exported repair note names the failure and the fix', () => {
    assert.match(GENERIC_MENU_REPAIR_NOTE, /generic task-category menu/i);
    assert.match(GENERIC_MENU_REPAIR_NOTE, /repo path/i);
  });
});

// ---------------------------------------------------------------------------
// decideHistoryPolicy — quarantine
// ---------------------------------------------------------------------------

describe('decideHistoryPolicy', () => {
  it('normal when there is no prior assistant prose', () => {
    assert.equal(decideHistoryPolicy(undefined).replayMode, 'normal');
    assert.equal(decideHistoryPolicy([]).replayMode, 'normal');
    assert.equal(decideHistoryPolicy(['I added the route; tests pass.']).replayMode, 'normal');
  });

  it('quarantines when a prior assistant turn was a generic menu', () => {
    const p = decideHistoryPolicy([
      'I added the route; tests pass.',
      'What are you trying to do — fix something, add a feature, or polish the layout?',
    ]);
    assert.equal(p.replayMode, 'quarantine_assistant_prose');
    assert.ok(p.reasons.length > 0);
  });
});

// ---------------------------------------------------------------------------
// compileTurnDirective — workState passthrough (AP2-B §2.3 B)
// ---------------------------------------------------------------------------

describe('compileTurnDirective — workState', () => {
  it('carries the work-state snapshot onto the directive unchanged when provided', () => {
    const ws = {
      objective: 'ship the dashboard',
      roadmap: [{ id: 'R1', text: 'wired route', status: 'done' as const }],
      recentCheckpoints: [],
      verifiedDone: ['wired route'],
      claimedNext: 'hydrate the chart',
      source: 'session-workTrace' as const,
    };
    const d = compileTurnDirective({
      frame: undefined,
      plan: planEngagement(signals({ task: 'continue' })),
      signals: signals({ task: 'continue' }),
      workState: ws,
    });
    assert.deepEqual(d.workState, ws);
  });

  it('omits workState when not provided', () => {
    const d = compileTurnDirective({
      frame: undefined,
      plan: planEngagement(signals({ task: 'continue' })),
      signals: signals({ task: 'continue' }),
    });
    assert.equal(d.workState, undefined);
  });
});

// ---------------------------------------------------------------------------
// compileTurnDirective — vision triage (AP2-C §2.4 C)
// ---------------------------------------------------------------------------

function visionTriageAction(d: TurnDirective) {
  return d.requiredBeforeAnswer.find((a) => a.kind === 'vision_triage');
}

describe('compileTurnDirective — vision_triage', () => {
  it('carries a vision_triage action for a broad multi-part vision', () => {
    const task =
      'figure out why the planner is flaky, and maybe rewrite the planner core in Rust';
    const s = signals({ frame: frameWith(undefined, 'coding'), task });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    const action = visionTriageAction(d);
    assert.ok(action !== undefined, 'directive carries vision_triage');
    assert.ok(action.items.length >= 2, 'a broad vision decomposes into ≥2 items');
    const ds = action.items.map((i) => i.disposition);
    assert.ok(ds.includes('MIGRATE_REARCHITECT'));
    assert.ok(ds.includes('INVESTIGATE_THEN_PROPOSE'));
    assert.equal(action.requiresInvestigation, true);
  });

  it('carries NO vision_triage action on a plain single SOLID claim', () => {
    const s = signals({ frame: frameWith(undefined, 'coding'), task: 'rename foo to bar' });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.equal(visionTriageAction(d), undefined, 'a single clear claim needs no triage');
    assert.deepEqual(d.requiredBeforeAnswer, []);
  });

  it('MIGRATE routing is bounded by authorizeTier — gate DENIES → no manager request', () => {
    const s = signals({ task: 'rewrite the core in Rust' });
    const d = compileTurnDirective({
      frame: undefined,
      plan: planEngagement(s),
      signals: s,
      // The injected gate (free-plan / never-auto) denies manager.
      canAuthorizeManagerForMigration: () => false,
    });
    const action = visionTriageAction(d);
    assert.ok(action !== undefined, 'migration still triaged');
    assert.ok(action.items.some((i) => i.disposition === 'MIGRATE_REARCHITECT'));
    assert.equal(
      action.migrationNeedsArchitectureTier,
      false,
      'a denied authorizeTier gate must NOT request the manager tier (no bypass)',
    );
  });

  it('MIGRATE routing requests manager ONLY when authorizeTier admits it', () => {
    const s = signals({ task: 'rewrite the core in Rust' });
    const d = compileTurnDirective({
      frame: undefined,
      plan: planEngagement(s),
      signals: s,
      canAuthorizeManagerForMigration: () => true,
    });
    const action = visionTriageAction(d);
    assert.ok(action !== undefined);
    assert.equal(
      action.migrationNeedsArchitectureTier,
      true,
      'an admitting gate may request the manager tier',
    );
  });

  it('with no authorizeTier gate injected, never claims the manager tier', () => {
    const s = signals({ task: 'rewrite the core in Rust' });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    const action = visionTriageAction(d);
    assert.ok(action !== undefined);
    assert.equal(action.migrationNeedsArchitectureTier, false, 'absent gate → IC floor only, no manager');
  });

  it('a generic menu fork is NOT a genuine DISCUSS fork in the directive', () => {
    const frame = frameWith([
      {
        id: 'F1',
        question: 'What are you trying to do with the page?',
        options: ['fix something broken', 'add a new feature', 'polish the layout'],
      },
    ]);
    const s = signals({ frame, task: 'work on the existing socials page in this repo' });
    const d = compileTurnDirective({ frame, plan: planEngagement(s), signals: s });
    const action = visionTriageAction(d);
    assert.ok(action !== undefined);
    assert.ok(
      !action.items.some((i) => i.disposition === 'DISCUSS'),
      'a generic task-category fork never becomes a DISCUSS/ask item',
    );
  });
});

// ---------------------------------------------------------------------------
// STAGE 5 (AP2-E, §2.6 E) — grounded-recommendation validator
// ---------------------------------------------------------------------------

describe('require_grounded_recommendation — substantial detection', () => {
  it('a "should we X or Y" decision task is substantial → carries the validator', () => {
    const s = signals({ task: 'should we keep this in TypeScript or move the core to another language?' });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.equal(d.substantial, true, 'a should-we-X-or-Y fork is a substantial decision');
    assert.ok(
      d.outputValidators.some((v) => v.kind === 'require_grounded_recommendation'),
      'a substantial turn carries the grounded-recommendation validator',
    );
  });

  it('a migration/rearchitecture task is substantial (vision-triage MIGRATE)', () => {
    const s = signals({ task: 'rewrite the core in Rust' });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.equal(d.substantial, true);
    assert.ok(d.outputValidators.some((v) => v.kind === 'require_grounded_recommendation'));
  });

  it('a tiny factual/lookup turn is NOT substantial → no grounded validator (no over-fire)', () => {
    const s = signals({
      frame: frameWith(undefined, 'other'),
      task: 'what is 2+2',
      engagementBias: 0,
      classification: { tier: 'worker', risk: 'low', rationale: 't' },
    });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.equal(d.substantial, false, 'a trivial factual turn must stay exempt');
    assert.deepEqual(
      d.outputValidators,
      [{ kind: 'reject_generic_open_menu' }],
      'a trivial turn carries ONLY the generic-menu validator',
    );
  });

  it('a plain high-risk IMPLEMENTATION turn is NOT substantial (no over-fire on DISCUSS_OPTIONS floor)', () => {
    const s = signals({
      task: 'implement the payment handler',
      engagementBias: 0,
      classification: { tier: 'ic', risk: 'high', rationale: 't' },
    });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.equal(d.substantial, false, 'a high-risk implementation turn is not a decision turn');
  });
});

describe('detectRecommendation / detectGrounding / detectBareOptionsList / detectHonestNoContext', () => {
  it('detects a recommendation and a clear next step', () => {
    assert.equal(detectRecommendation('I recommend keeping TypeScript.'), true);
    assert.equal(detectRecommendation('The next step is to add tests.'), true);
    assert.equal(detectRecommendation('Here is a neutral paragraph about the weather.'), false);
  });

  it('detects file evidence as grounding', () => {
    const g = detectGrounding('Keep TypeScript — see src/core/orchestrate.ts:12 for the hot path.');
    assert.ok(g !== null && g.kind === 'file_evidence');
  });

  it('detects an honest no-context as the not_enough_context grounding', () => {
    const g = detectGrounding('I cannot see the requested repo in the current directory.');
    assert.ok(g !== null && g.kind === 'not_enough_context');
    assert.equal(detectHonestNoContext('I cannot see the requested repo here.'), true);
  });

  it('detects a stated assumption and an external source', () => {
    const a = detectGrounding('I will assume the build targets Node 22.');
    assert.ok(a !== null && a.kind === 'stated_assumption');
    const e = detectGrounding('According to the TypeScript docs, this is supported.');
    assert.ok(e !== null && (e.kind === 'external_source' || e.kind === 'repo_orientation'));
  });

  it('detects a bare options list / waffle (raw detector — recommendation-guard is in the validator)', () => {
    assert.equal(detectBareOptionsList('Here are some options: A, B, and C.'), true);
    assert.equal(
      detectBareOptionsList('- Apple\n- Banana\n- Cherry'),
      true,
      '≥3 enumerated bullets read as parallel choices',
    );
    assert.equal(detectBareOptionsList('A plain grounded sentence with no enumerated choices.'), false);
  });

  it('ungrounded prose has no grounding', () => {
    assert.equal(detectGrounding('I recommend rewriting everything, trust me.'), null);
  });
});

describe('validateTurnOutput — require_grounded_recommendation', () => {
  // A substantial directive carrying the grounded validator (decision task).
  const substantialDirective = (): TurnDirective => {
    const s = signals({ task: 'should we keep this in TypeScript or move the core to Rust?' });
    return compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
  };

  it('ACCEPTS a concrete file-grounded recommendation', () => {
    const d = substantialDirective();
    const text =
      'I recommend keeping TypeScript — see src/core/orchestrate.ts:12; the hot path is small. ' +
      'What would change this: a sustained CPU-bound indexing workload.';
    assert.equal(validateTurnOutput(text, d), null);
  });

  it('ACCEPTS an honest "I do not see that repo here"', () => {
    const d = substantialDirective();
    const text = 'I cannot see the requested repo in the current working directory; point the tool at it.';
    assert.equal(validateTurnOutput(text, d), null);
  });

  it('REJECTS a bare options list with no recommendation on a substantial turn', () => {
    const d = substantialDirective();
    const text = 'Here are some options: stay on TypeScript, move to Rust, or use Go. Up to you.';
    const f = validateTurnOutput(text, d);
    assert.ok(f !== null && f.kind === 'ungrounded_recommendation');
  });

  it('REJECTS a recommendation with zero grounding', () => {
    const d = substantialDirective();
    const text = 'I recommend rewriting the core in Rust. It will be better.';
    const f = validateTurnOutput(text, d);
    assert.ok(f !== null && f.kind === 'ungrounded_recommendation');
  });

  it('SKIPS the grounded check on a tiny factual turn (no fire)', () => {
    const s = signals({
      task: 'what is 2+2',
      engagementBias: 0,
      classification: { tier: 'worker', risk: 'low', rationale: 't' },
    });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    // Even an obviously ungrounded "answer" is not gated on a non-substantial turn.
    assert.equal(validateTurnOutput('Here are some options: A, B, C.', d), null);
  });
});

describe('shouldAppendGroundedFallback — truthful only', () => {
  const substantialDirective = (): TurnDirective => {
    const s = signals({ task: 'should we keep this in TypeScript or move the core to Rust?' });
    return compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
  };

  it('appends ONLY when the answer is still ungrounded on a substantial turn', () => {
    const d = substantialDirective();
    assert.equal(
      shouldAppendGroundedFallback('I recommend rewriting it. Trust me.', d),
      true,
      'an ungrounded recommendation on a substantial turn is groundless → fallback',
    );
    assert.ok(GROUNDED_RECOMMENDATION_FALLBACK.length > 0);
  });

  it('does NOT append when the recommendation is already grounded', () => {
    const d = substantialDirective();
    assert.equal(
      shouldAppendGroundedFallback('I recommend keeping TS — see src/core/orchestrate.ts:12.', d),
      false,
    );
  });

  it('does NOT append when the answer already honestly states no context', () => {
    const d = substantialDirective();
    assert.equal(
      shouldAppendGroundedFallback('I cannot see the requested repo here; share the path.', d),
      false,
      'an honest no-context answer makes the fallback redundant',
    );
  });

  it('does NOT append on a non-substantial turn', () => {
    const s = signals({
      task: 'what is 2+2',
      engagementBias: 0,
      classification: { tier: 'worker', risk: 'low', rationale: 't' },
    });
    const d = compileTurnDirective({ frame: undefined, plan: planEngagement(s), signals: s });
    assert.equal(shouldAppendGroundedFallback('A, B, or C.', d), false);
  });
});
