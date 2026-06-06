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
  GENERIC_MENU_REPAIR_NOTE,
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
  outputValidators: [{ kind: 'reject_generic_open_menu' }],
  historyPolicy: { replayMode: 'normal', reasons: [] },
  repoOriented: true,
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
