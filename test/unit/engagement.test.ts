/**
 * test/unit/engagement.test.ts — the Adaptive Partner Engine pure core
 * (core/engagement.ts).
 *
 * Covers the headline planEngagement TABLE (trivial fast-path, safety floor,
 * bias-modulates-never-overrides, SMART knowledge boundary, ASK_CAP), the
 * efficiency guardrails, fail-soft, canonical order, work-contract seeding,
 * ask_user derivation, and the ENGAGEMENT block renderer. All pure — no model,
 * no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planEngagement,
  seedFromIntentAndPlan,
  deriveAskFromForks,
  renderEngagementBlock,
  isTrivial,
  isIrreversible,
  hasVisionPhrase,
  realForks,
  isAmbiguous,
  scopeScore,
  needsContext,
  needsExternal,
  isInvestigable,
  hasGenuineFork,
  forkBudget,
  ASK_CAP,
  type EngagementAction,
  type EngagementSignals,
} from '../../src/core/engagement.ts';
import type { IntentFrame, IntentConfidence, IntentFork } from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';

const CLS = (
  tier: Classification['tier'],
  risk: Classification['risk'] = 'low',
): Classification => ({ tier, risk, rationale: `tier: ${tier}; risk: ${risk}` });

const frame = (over: Partial<IntentFrame> = {}): IntentFrame => ({
  version: 1,
  goal: 'do the work',
  confidence: 'high',
  source: 'model',
  ...over,
});

const signals = (over: Partial<EngagementSignals>): EngagementSignals => ({
  classification: CLS('ic'),
  routePlan: false,
  engagementBias: 0,
  task: 'do the work',
  ...over,
});

// ---------------------------------------------------------------------------
// planEngagement TABLE — the headline
// ---------------------------------------------------------------------------

describe('planEngagement — table', () => {
  it('trivial → [EXECUTE_NOW] depth:0 fast-path (zero overhead)', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('worker', 'low'),
        task: 'what time is it?',
        frame: frame({ goal: 'tell the time', confidence: 'high' }),
      }),
    );
    assert.deepEqual([...plan.actions], ['EXECUTE_NOW']);
    assert.equal(plan.depth, 0);
    assert.equal(plan.asks, 0);
    assert.equal(plan.source, 'fast-path');
  });

  it('fully-specified reversible edit, direct → [EXECUTE_NOW] (no reflect, no ask)', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic', 'low'),
        engagementBias: -1,
        task: 'rename the variable foo to bar in utils.ts',
        frame: frame({ goal: 'rename foo to bar', kind: 'coding', confidence: 'high' }),
      }),
    );
    assert.deepEqual([...plan.actions], ['EXECUTE_NOW']);
    assert.equal(plan.asks, 0);
  });

  it('vision-phrase substantial → [REFLECT_VISION, EXECUTE_NOW], asks:0 at balanced', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 0,
        task: 'rebuild the frontend as I envisioned, a 2010-YouTube social feel',
        frame: frame({ goal: 'rebuild frontend, 2010-youtube feel', kind: 'design', confidence: 'medium' }),
      }),
    );
    assert.ok(plan.actions.includes('REFLECT_VISION'));
    assert.ok(plan.actions.includes('EXECUTE_NOW'));
    assert.equal(plan.asks, 0); // assumption stated, not asked
  });

  it('irreversible + ambiguous → DISCUSS_OPTIONS, asks ≤ 1, EVEN at direct (safety floor)', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic', 'high'),
        engagementBias: -1, // direct — would normally just-do
        task: 'deploy this to production',
        frame: frame({
          goal: 'deploy to prod',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'which region?', assumeIfUnasked: 'us-east' }],
        }),
      }),
    );
    assert.ok(plan.actions.includes('DISCUSS_OPTIONS'), 'safety floor adds discuss even for direct');
    assert.ok(plan.asks <= 1, 'at most one ask, even on the floor');
  });

  it('manager-tier multi-system + route.plan → planFirst:true, contains PLAN_FIRST', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('manager'),
        routePlan: true,
        task: 'redesign the auth, billing and notification subsystems together',
        frame: frame({ goal: 'redesign multiple subsystems', confidence: 'low' }),
      }),
    );
    assert.equal(plan.planFirst, true);
    assert.ok(plan.actions.includes('PLAN_FIRST'));
  });

  it('collaborative LOWERS the bar but a trivial turn is STILL [EXECUTE_NOW]', () => {
    // Mid-scope turn: balanced → no reflect; collaborative → reflect surfaces.
    const midBalanced = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 0,
        task: 'plan the migration approach',
        frame: frame({ goal: 'plan migration', kind: 'planning', confidence: 'medium' }),
      }),
    );
    const midCollab = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: 'add a small helper',
        frame: frame({ goal: 'add helper', kind: 'coding', confidence: 'high' }),
      }),
    );
    // planning kind always reflects; collaborative on a plain coding turn reaches
    // the ladder sooner than direct would. The key invariant: trivial stays instant.
    const trivialCollab = planEngagement(
      signals({
        classification: CLS('worker', 'low'),
        engagementBias: 1,
        task: 'what time is it?',
        frame: frame({ goal: 'time', confidence: 'high' }),
      }),
    );
    assert.equal(trivialCollab.source, 'fast-path');
    assert.deepEqual([...trivialCollab.actions], ['EXECUTE_NOW']);
    // sanity: the planning-kind turn reflects regardless of bias
    assert.ok(midBalanced.actions.includes('REFLECT_VISION'));
    assert.ok(midCollab.actions.includes('EXECUTE_NOW'));
  });

  it('SMART boundary: re-derivable context request → NO INVESTIGATE_CONTEXT', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        task: 'add a console.log to the function',
        frame: frame({ goal: 'add a log line', kind: 'coding', confidence: 'high' }),
      }),
    );
    assert.ok(!plan.actions.includes('INVESTIGATE_CONTEXT'));
  });

  it('SMART boundary: known-fact question → NO WEB_RESEARCH', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('worker'),
        task: 'explain how a hash map works',
        frame: frame({ goal: 'explain hash maps', kind: 'research', confidence: 'high' }),
      }),
    );
    assert.ok(!plan.actions.includes('WEB_RESEARCH'));
  });

  it('explicit "look up the latest" → WEB_RESEARCH selected', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        task: 'look up the latest React 19 release notes and summarize',
        frame: frame({ goal: 'summarize latest react notes', kind: 'research', confidence: 'medium' }),
      }),
    );
    assert.ok(plan.actions.includes('WEB_RESEARCH'));
  });

  // The webSearch provider signal (audit #3) is derived from EXACTLY this
  // WEB_RESEARCH determination — so these guard that ordinary coding turns never
  // request native web search.
  it('current/external queries → WEB_RESEARCH (the webSearch signal fires)', () => {
    for (const task of [
      "what's the latest version of Node?",
      'look up current AWS Lambda pricing',
      'search the web for the React 19 release date',
    ]) {
      const plan = planEngagement(signals({ classification: CLS('ic'), task }));
      assert.ok(plan.actions.includes('WEB_RESEARCH'), `WEB_RESEARCH for: ${task}`);
    }
  });

  it('ordinary coding turns → NO WEB_RESEARCH (webSearch stays off — conservative)', () => {
    for (const task of [
      'refactor this function',
      'fix the failing test',
      'rename the variable and update its callers',
    ]) {
      const plan = planEngagement(signals({ classification: CLS('ic'), task }));
      assert.ok(!plan.actions.includes('WEB_RESEARCH'), `no WEB_RESEARCH for: ${task}`);
    }
  });

  it('explicit "inspect the existing code" → INVESTIGATE_CONTEXT selected', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        task: 'inspect the existing auth module before changing it',
        frame: frame({ goal: 'understand then change auth', kind: 'coding', confidence: 'medium' }),
      }),
    );
    assert.ok(plan.actions.includes('INVESTIGATE_CONTEXT'));
  });
});

// ---------------------------------------------------------------------------
// INVESTIGATE-BEFORE-INTERROGATE (live-found friction)
// ---------------------------------------------------------------------------

describe('planEngagement — investigate before interrogate', () => {
  it('investigable-ambiguity fork → INVESTIGATE_CONTEXT, NO ASK (resolve by looking)', () => {
    // A code-detail fork the codebase would answer: investigate, don't interrogate.
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1, // collaborative — would normally permit an ask
        task: 'make the socials page real in this project',
        frame: frame({
          goal: 'finish the socials page',
          kind: 'coding',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'is the socials page a feed or just links?' }],
        }),
      }),
    );
    assert.ok(plan.actions.includes('INVESTIGATE_CONTEXT'), 'investigates the discoverable detail');
    assert.ok(!plan.actions.includes('ASK_CLARIFYING'), 'does NOT interrogate the user');
    assert.equal(plan.asks, 0);
  });

  it('INVESTIGATE_CONTEXT is ordered BEFORE any ASK in an investigable+genuine mix', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: 'rework the existing dashboard the way you prefer it',
        frame: frame({
          goal: 'rework dashboard',
          kind: 'coding',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'which color palette do you prefer?' }],
        }),
      }),
    );
    const iInv = plan.actions.indexOf('INVESTIGATE_CONTEXT');
    const iAsk = plan.actions.indexOf('ASK_CLARIFYING');
    assert.ok(iInv >= 0, 'investigates the existing dashboard first');
    if (iAsk >= 0) assert.ok(iInv < iAsk, 'INVESTIGATE_CONTEXT precedes ASK_CLARIFYING');
  });

  it('genuine non-investigable preference fork → may still ASK at collaborative', () => {
    // Pure preference, no codebase reference: the user is the only source.
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: 'help me pick a name for the launch',
        frame: frame({
          goal: 'choose a launch name',
          kind: 'writing',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'which tone do you prefer — playful or serious?' }],
        }),
      }),
    );
    assert.ok(hasGenuineFork(signals({
      task: 'help me pick a name for the launch',
      frame: frame({
        kind: 'writing',
        forks: [{ id: 'F1', question: 'which tone do you prefer — playful or serious?' }],
      }),
    })));
    assert.ok(plan.actions.includes('ASK_CLARIFYING'), 'a real preference fork can still ask');
    assert.equal(plan.asks, 1);
  });

  it('"project not in cwd" style reference does NOT just ASK abstractly — it investigates', () => {
    // The heyvera-socials live failure: a referenced page in a (possibly absent)
    // project must route through INVESTIGATE_CONTEXT, never an abstract ASK.
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: "we're making the heyvera socials page real",
        frame: frame({
          goal: 'make the heyvera socials page real',
          kind: 'coding',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'is it a social-links page or a feed?' }],
        }),
      }),
    );
    assert.ok(plan.actions.includes('INVESTIGATE_CONTEXT'));
    assert.ok(!plan.actions.includes('ASK_CLARIFYING'), 'no abstract interrogation of the user');
  });

  it('live generic blocker/next-step menu → INVESTIGATE_CONTEXT, NO ASK, NO derived ask_user', () => {
    const f = frame({
      goal: 'understand the frontend next step',
      kind: 'coding',
      confidence: 'low',
      forks: [
        {
          id: 'F1',
          question: "What's the actual blocker or next step right now?",
          options: [
            'Fixing something broken',
            'Adding a new feature',
            'Polishing the layout/UX',
            'Integrating the backend API',
          ],
        },
      ],
    });
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: 'look at the heyvera frontend and help me figure out what is going on',
        frame: f,
      }),
    );
    assert.ok(plan.actions.includes('INVESTIGATE_CONTEXT'), 'look at the repo/context first');
    assert.ok(!hasGenuineFork(signals({ task: 'look at the heyvera frontend', frame: f })));
    assert.ok(!plan.actions.includes('ASK_CLARIFYING'), 'generic task menu is not a genuine fork');
    assert.equal(plan.asks, 0);
    assert.equal(deriveAskFromForks(f, plan), null, 'fallback ask_user must not surface the generic menu');
  });

  it('trivial still stays [EXECUTE_NOW] (no investigate, no ask)', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('worker', 'low'),
        task: 'what time is it?',
        frame: frame({ goal: 'time', confidence: 'high' }),
      }),
    );
    assert.deepEqual([...plan.actions], ['EXECUTE_NOW']);
    assert.equal(plan.source, 'fast-path');
  });

  it('irreversible+investigable+ambiguous still hits the safety floor (discuss, may ask)', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic', 'high'),
        engagementBias: -1,
        task: 'deploy the existing service to production',
        frame: frame({
          goal: 'deploy service',
          kind: 'ops',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'which region?' }],
        }),
      }),
    );
    assert.ok(plan.actions.includes('DISCUSS_OPTIONS'), 'safety floor intact');
    assert.ok(plan.asks <= ASK_CAP);
  });

  it('genuine narrow external fork can still ask after the generic-menu guard', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: 'help me pick a production deploy window',
        frame: frame({
          goal: 'choose deploy timing',
          kind: 'ops',
          confidence: 'low',
          forks: [
            {
              id: 'F1',
              question: 'Which deploy window do you prefer?',
              options: ['Today after market close', 'Tomorrow morning'],
            },
          ],
        }),
      }),
    );
    assert.ok(plan.actions.includes('ASK_CLARIFYING'), 'a concrete preference fork can still ask');
    assert.equal(plan.asks, 1);
  });

  it('isInvestigable / hasGenuineFork classify the codebase-vs-vision boundary', () => {
    assert.ok(isInvestigable(signals({ task: 'fix the existing module', frame: frame({ kind: 'coding' }) })));
    assert.ok(isInvestigable(signals({ task: 'make the socials page real', frame: frame() })));
    assert.ok(!isInvestigable(signals({ task: 'pick a name for the launch', frame: frame({ kind: 'writing' }) })));
    // an investigable code-detail fork is NOT genuine (investigate instead)
    assert.ok(
      !hasGenuineFork(
        signals({
          task: 'fix the existing module',
          frame: frame({ kind: 'coding', forks: [{ id: 'F1', question: 'is it a feed or links?' }] }),
        }),
      ),
    );
    // a non-investigable preference fork IS genuine
    assert.ok(
      hasGenuineFork(
        signals({
          task: 'pick a launch name',
          frame: frame({ kind: 'writing', forks: [{ id: 'F1', question: 'playful or serious tone?' }] }),
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe('planEngagement — guardrails', () => {
  it('ASK_CAP=1 is never exceeded even with multiple forks at collaborative', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 1,
        task: 'set up the new project',
        frame: frame({
          goal: 'set up project',
          confidence: 'low',
          forks: [
            { id: 'F1', question: 'a?' },
            { id: 'F2', question: 'b?' },
            { id: 'F3', question: 'c?' },
          ],
        }),
      }),
    );
    assert.ok(plan.asks <= ASK_CAP);
  });

  it('prefers stated assumptions over asks at the default (balanced) bias', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        engagementBias: 0,
        task: 'build the form',
        frame: frame({
          goal: 'build a form',
          confidence: 'medium',
          forks: [{ id: 'F1', question: 'validation library?', assumeIfUnasked: 'zod' }],
        }),
      }),
    );
    assert.equal(plan.asks, 0);
    assert.ok(!plan.actions.includes('ASK_CLARIFYING'));
  });

  it('depth never reaches 2 without stakes ∧ scope ∧ ambiguity', () => {
    // High scope but LOW risk → not deep.
    const lowRisk = planEngagement(
      signals({
        classification: CLS('manager', 'low'),
        routePlan: true,
        task: 'plan the big refactor across modules',
        frame: frame({ goal: 'big refactor', confidence: 'low' }),
      }),
    );
    assert.ok(lowRisk.depth < 2);
    // High risk + high scope + ambiguous → depth 2 permitted.
    const deep = planEngagement(
      signals({
        classification: CLS('manager', 'critical'),
        routePlan: true,
        task: 'migrate the production database across regions',
        frame: frame({ goal: 'multi-region prod migration', confidence: 'low' }),
      }),
    );
    assert.equal(deep.depth, 2);
  });

  it('reversible → act; irreversible → discuss (reversibility-aware)', () => {
    const reversible = planEngagement(
      signals({
        classification: CLS('ic', 'low'),
        task: 'edit the README wording',
        frame: frame({ goal: 'edit readme', confidence: 'medium' }),
      }),
    );
    assert.ok(!reversible.actions.includes('DISCUSS_OPTIONS'));

    const irreversible = planEngagement(
      signals({
        classification: CLS('ic', 'high'),
        task: 'delete the old user records',
        frame: frame({ goal: 'delete records', confidence: 'low' }),
      }),
    );
    assert.ok(irreversible.actions.includes('DISCUSS_OPTIONS'));
  });
});

// ---------------------------------------------------------------------------
// Fail-soft + order
// ---------------------------------------------------------------------------

describe('planEngagement — fail-soft + order', () => {
  it('absent frame → never throws, returns a non-empty plan', () => {
    const plan = planEngagement(signals({ task: 'fix the bug', classification: CLS('ic') }));
    assert.ok(plan.actions.length > 0);
  });

  it('garbage signal object → fail-soft [EXECUTE_NOW]', () => {
    const plan = planEngagement(null as unknown as EngagementSignals);
    assert.deepEqual([...plan.actions], ['EXECUTE_NOW']);
    assert.equal(plan.source, 'fail-soft');
  });

  it('always ends with EXECUTE_NOW unless terminal on an ask', () => {
    const acting = planEngagement(
      signals({
        classification: CLS('ic'),
        task: 'rebuild the homepage as I imagined',
        frame: frame({ goal: 'rebuild homepage', kind: 'design', confidence: 'medium' }),
      }),
    );
    assert.equal(acting.actions[acting.actions.length - 1], 'EXECUTE_NOW');
  });

  it('selected actions follow the canonical precedence', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('manager', 'high'),
        routePlan: true,
        engagementBias: 1,
        task: 'inspect the existing system, then redesign it as I envisioned',
        frame: frame({
          goal: 'inspect then redesign',
          kind: 'design',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'which framework?' }],
        }),
      }),
    );
    const order = [
      'INVESTIGATE_CONTEXT',
      'WEB_RESEARCH',
      'REFLECT_VISION',
      'PLAN_FIRST',
      'DISCUSS_OPTIONS',
      'ASK_CLARIFYING',
      'EXECUTE_NOW',
    ];
    const idx = plan.actions.map((a) => order.indexOf(a));
    const sorted = [...idx].sort((x, y) => x - y);
    assert.deepEqual(idx, sorted, 'actions are in canonical precedence');
  });
});

// ---------------------------------------------------------------------------
// Pure heuristics
// ---------------------------------------------------------------------------

describe('pure heuristics', () => {
  it('isIrreversible matches the conservative-broad lexicon', () => {
    assert.ok(isIrreversible('deploy to prod'));
    assert.ok(isIrreversible('please delete the table'));
    assert.ok(isIrreversible('force-push the branch'));
    assert.ok(isIrreversible('send the email now'));
    assert.ok(!isIrreversible('rename a local variable'));
  });

  it('isTrivial requires worker + low-risk + short + single-clause + no fork', () => {
    assert.ok(
      isTrivial(signals({ classification: CLS('worker', 'low'), task: 'what is 2+2', frame: frame() })),
    );
    assert.ok(
      !isTrivial(signals({ classification: CLS('manager'), task: 'what is 2+2', frame: frame() })),
    );
    assert.ok(
      !isTrivial(
        signals({
          classification: CLS('worker', 'low'),
          task: 'x',
          frame: frame({ forks: [{ id: 'F1', question: 'q' }] }),
        }),
      ),
    );
  });

  it('hasVisionPhrase detects vision lexicon hits', () => {
    assert.ok(hasVisionPhrase('build it as I envisioned'));
    assert.ok(hasVisionPhrase('it should feel like 2010'));
    assert.ok(!hasVisionPhrase('add two numbers'));
  });

  it('realForks / isAmbiguous read the frame', () => {
    const fork: IntentFork = { id: 'F1', question: 'q?' };
    const conf: IntentConfidence = 'low';
    assert.equal(realForks(signals({ frame: frame({ forks: [fork] }) })), 1);
    assert.ok(isAmbiguous(signals({ frame: frame({ confidence: conf }) })));
    assert.ok(!isAmbiguous(signals({ frame: frame({ confidence: 'high' }) })));
  });

  it('scopeScore rises with route.plan + manager + size', () => {
    const small = scopeScore(signals({ classification: CLS('ic'), routePlan: false, task: 'tiny' }));
    const big = scopeScore(
      signals({ classification: CLS('manager'), routePlan: true, task: 'a'.repeat(250) }),
    );
    assert.ok(big > small);
  });

  it('needsContext / needsExternal honor the SMART boundary', () => {
    assert.ok(needsContext(signals({ task: 'inspect the existing module first' })) >= 2);
    assert.equal(needsContext(signals({ task: 'add a log' })), 0);
    assert.ok(needsExternal(signals({ task: 'look up the latest news' })) >= 2);
    assert.equal(needsExternal(signals({ task: 'explain recursion' })), 0);
  });

  it('forkBudget is 0 for direct/balanced and up to ASK_CAP for collaborative', () => {
    assert.equal(forkBudget(-1, 0), 0);
    assert.equal(forkBudget(0, 0), 0);
    assert.equal(forkBudget(1, 0), ASK_CAP);
  });

  it('EngagementAction type covers the closed set used by the plan', () => {
    const all: readonly EngagementAction[] = [
      'EXECUTE_NOW',
      'REFLECT_VISION',
      'ASK_CLARIFYING',
      'PLAN_FIRST',
      'INVESTIGATE_CONTEXT',
      'WEB_RESEARCH',
      'DISCUSS_OPTIONS',
      'ESCALATE_DEPTH',
    ];
    const plan = planEngagement(signals({ task: 'x', classification: CLS('ic'), frame: frame() }));
    assert.ok(plan.actions.every((a) => all.includes(a)));
  });
});

// ---------------------------------------------------------------------------
// Work-contract seeding (§6.3)
// ---------------------------------------------------------------------------

describe('seedFromIntentAndPlan', () => {
  it('seeds objective ← goal and vision ← doneWhen', () => {
    const plan = planEngagement(signals({ classification: CLS('ic'), task: 'x', frame: frame() }));
    const contract = seedFromIntentAndPlan(
      frame({ goal: 'ship the dashboard', doneWhen: 'all charts render' }),
      plan,
      'raw task text',
    );
    assert.equal(contract?.objective, 'ship the dashboard');
    assert.equal(contract?.vision, 'all charts render');
  });

  it('seeds a roadmap ONLY when planFirst', () => {
    const noPlan = planEngagement(
      signals({ classification: CLS('ic'), routePlan: false, task: 'x', frame: frame() }),
    );
    const c1 = seedFromIntentAndPlan(frame({ goal: 'g' }), noPlan, 'x');
    assert.equal(c1?.roadmap, undefined);

    const withPlan = planEngagement(
      signals({
        classification: CLS('manager'),
        routePlan: true,
        task: 'big multi-step plan across systems',
        frame: frame({ goal: 'big plan', confidence: 'low' }),
      }),
    );
    assert.equal(withPlan.planFirst, true);
    const c2 = seedFromIntentAndPlan(frame({ goal: 'big plan' }), withPlan, 'x');
    assert.ok((c2?.roadmap?.length ?? 0) >= 1);
  });

  it('falls back to the raw task when there is no usable goal; low-confidence still safe', () => {
    const plan = planEngagement(signals({ classification: CLS('ic'), task: 'raw', frame: frame() }));
    const c = seedFromIntentAndPlan(frame({ goal: '', confidence: 'low' }), plan, 'raw task');
    assert.equal(c?.objective, 'raw task');
    const none = seedFromIntentAndPlan(undefined, plan, '   ');
    assert.equal(none, undefined);
  });
});

// ---------------------------------------------------------------------------
// ask_user derivation (§6.2)
// ---------------------------------------------------------------------------

describe('deriveAskFromForks', () => {
  it('returns null when asks is 0', () => {
    const plan = planEngagement(signals({ classification: CLS('ic'), task: 'x', frame: frame() }));
    assert.equal(deriveAskFromForks(frame({ forks: [{ id: 'F1', question: 'q?' }] }), plan), null);
  });

  it('builds a bounded QuestionSet from the forks when asks > 0', () => {
    const f = frame({
      goal: 'set up',
      confidence: 'low',
      forks: [
        { id: 'F1', question: 'which db?', options: ['Postgres', 'MySQL'] },
        { id: 'F2', question: 'which orm?' },
      ],
    });
    const plan = planEngagement(
      signals({ classification: CLS('ic'), engagementBias: 1, task: 'set up the project', frame: f }),
    );
    const qs = deriveAskFromForks(f, plan);
    assert.ok(qs !== null);
    assert.ok(qs.questions.length >= 1 && qs.questions.length <= ASK_CAP);
    assert.equal(qs.questions[0]?.id, 'F1');
    assert.equal(qs.questions[0]?.prompt, 'which db?');
    assert.deepEqual(
      qs.questions[0]?.options.map((o) => o.label),
      ['Postgres', 'MySQL'],
    );
  });

  it('PHASE 1b: REJECTS a generic order-taker menu fork (proceeds on assumption instead)', () => {
    // A shallow "are you fixing / adding?" menu is NOT a senior fork — it must be
    // dropped so the partner states its assumption rather than surface a vacuous ask.
    const f = frame({
      goal: 'work on the app',
      confidence: 'low',
      forks: [
        {
          id: 'F1',
          question: 'Are you trying to fix something or add a feature?',
          options: ['fixing something broken', 'adding a new feature', 'polishing the UI'],
        },
      ],
    });
    const plan = planEngagement(
      signals({ classification: CLS('ic'), engagementBias: 1, task: 'work on the app', frame: f }),
    );
    assert.equal(
      deriveAskFromForks(f, plan),
      null,
      'a generic open-menu fork is rejected, not surfaced as an ask',
    );
  });

  it('PHASE 1b: a code-grounded fork survives and tags the recommended default', () => {
    // The senior-grade fork: real competing approaches with tradeoffs + a default.
    // Phrased as a genuine preference fork (a non-investigable decision the user
    // owns) so the engagement layer budgets the ask; the OPTIONS stay repo-grounded.
    const f = frame({
      goal: 'make the feed load real data',
      confidence: 'low',
      forks: [
        {
          id: 'F1',
          question: 'Which approach would you prefer for loading the feed?',
          options: [
            'Server-Component streaming in app/feed/page.tsx — fewer round-trips',
            'Client SWR via a new /api/feed route — simpler, more requests',
          ],
          assumeIfUnasked: 'Server-Component streaming in app/feed/page.tsx — fewer round-trips',
        },
      ],
    });
    const plan = planEngagement(
      signals({ classification: CLS('ic'), engagementBias: 1, task: 'make the feed load real data', frame: f }),
    );
    const qs = deriveAskFromForks(f, plan);
    assert.ok(qs !== null);
    const opts = qs.questions[0]?.options ?? [];
    assert.equal(opts.length, 2, 'both real approaches are carried as options');
    assert.ok(
      opts[0]?.label.includes('app/feed/page.tsx'),
      'options name the real repo file (grounded, not generic)',
    );
    assert.equal(opts[0]?.description, 'recommended', 'the stated default is marked recommended');
    assert.equal(opts[1]?.description, undefined, 'the non-default option is not marked');
  });
});

// ---------------------------------------------------------------------------
// ENGAGEMENT block renderer (§6.4)
// ---------------------------------------------------------------------------

describe('renderEngagementBlock', () => {
  it('renders "" on a fast-path / bare-execute plan (silent)', () => {
    const fast = planEngagement(
      signals({
        classification: CLS('worker', 'low'),
        task: 'what time is it?',
        frame: frame({ goal: 'time', confidence: 'high' }),
      }),
    );
    assert.equal(renderEngagementBlock(fast), '');
    assert.equal(renderEngagementBlock(undefined), '');
  });

  it('renders the visible actions in order when present', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        task: 'rebuild the page as I envisioned',
        frame: frame({ goal: 'rebuild', kind: 'design', confidence: 'medium' }),
      }),
    );
    const block = renderEngagementBlock(plan);
    assert.ok(block.startsWith('ENGAGEMENT'));
    assert.ok(block.toLowerCase().includes('reflect'));
  });

  it('investigate guidance tells the model to recommend the concrete next step', () => {
    const plan = planEngagement(
      signals({
        classification: CLS('ic'),
        task: 'look at the existing frontend and figure out the next step',
        frame: frame({
          goal: 'figure out frontend next step',
          kind: 'coding',
          confidence: 'low',
          forks: [{ id: 'F1', question: 'what is the blocker?' }],
        }),
      }),
    );
    const block = renderEngagementBlock(plan);
    assert.ok(block.includes('inspect ONLY the relevant existing files/code'));
    assert.ok(block.includes('recommend the concrete next step'));
  });
});
