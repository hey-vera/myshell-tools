import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoalPlanAdjudicationPrompt,
  formatGoalPlanSelectionDisclosure,
  formatGoalPlanSelectionNotice,
  isAcceptableGoalPlanSynthesis,
  selectGoalPlan,
  selectGoalPlanFromAdjudication,
  type CandidateOutcome,
  type GoalPlanSelectionCandidate,
  type GoalPlanSelectionRunner,
} from '../../src/core/ensemble.ts';
import { parseGoalPlan, type GoalPlan } from '../../src/core/goal-plan.ts';
import type { OrchestrateDeps } from '../../src/core/types.ts';
import type { ProviderId } from '../../src/providers/port.ts';

const RAW_A = `JUDGMENT: stage
VISION: Ship safely
GOAL: Harden the release
APPROACH: Add a bounded release gate
WHY: It catches regressions before rollout
TODO: Implement the gate
DONE: The release test passes`;
const RAW_B = `JUDGMENT: stage
VISION: Ship safely
GOAL: Verify the release
APPROACH: Exercise the real release path
WHY: It validates behavior end to end
TODO: Add release coverage
DONE: The release test passes`;

function plan(raw: string): GoalPlan {
  const parsed = parseGoalPlan(raw);
  assert.ok(parsed !== null);
  return parsed;
}

const A: GoalPlanSelectionCandidate = {
  plan: plan(RAW_A),
  provider: 'claude',
  model: 'claude-model',
  rawText: RAW_A,
};
const B: GoalPlanSelectionCandidate = {
  plan: plan(RAW_B),
  provider: 'codex',
  model: 'codex-model',
  rawText: RAW_B,
};

function outcome(provider: ProviderId, text?: string, failed = false): CandidateOutcome {
  return {
    provider,
    model: `${provider}-model`,
    finalText: text,
    usage: undefined,
    providerCostUsd: undefined,
    errored: failed
      ? { category: 'unknown', recoverable: false, message: 'failed', suggestion: 'retry later' }
      : undefined,
    durationMs: 1,
    reasoningEffort: undefined,
    taskKind: 'judgment',
  };
}

function deps(): OrchestrateDeps {
  return {
    authenticatedProviders: ['claude', 'codex'],
    providers: { claude: {}, codex: {} },
  } as unknown as OrchestrateDeps;
}

function runner(candidate: CandidateOutcome, adjudicator?: CandidateOutcome): GoalPlanSelectionRunner {
  return async (request) => request.role === 'candidate' ? candidate : (adjudicator ?? outcome('claude', undefined, true));
}

function synthesized(choice: 'P1' | 'P2', raw = choice === 'P1' ? RAW_A : RAW_B): string {
  return `${raw}\n{"choice":"${choice}","confidence":0.8,"why":"stronger","key_risk":"scope"}`;
}

async function runWith(fakeRunner: GoalPlanSelectionRunner) {
  return selectGoalPlan({
    ownerTask: 'Harden the release',
    candidateA: A,
    deps: deps(),
    tier: 'manager',
    classification: { tier: 'manager', risk: 'high', rationale: 'release risk' },
    signal: new AbortController().signal,
    runner: fakeRunner,
  });
}

describe('goal-plan selection pure pieces', () => {
  it('builds a provider-labelled, grounded, tagged adjudication prompt', () => {
    const prompt = buildGoalPlanAdjudicationPrompt({
      ownerTask: 'Harden the release',
      plannerPrompt: 'EXACT GROUNDED PLANNER PROMPT',
      candidateA: A,
      candidateB: B,
    });
    assert.match(prompt, /P1 \(claude \/ claude-model\)/);
    assert.match(prompt, /P2 \(codex \/ codex-model\)/);
    assert.match(prompt, /EXACT GROUNDED PLANNER PROMPT/);
    assert.match(prompt, /JUDGMENT: stage/);
    assert.match(prompt, /"choice":"P1"/);
  });

  it('rejects clarify and doneWhen regression', () => {
    assert.equal(isAcceptableGoalPlanSynthesis(plan('JUDGMENT: clarify\nASK: Which release?'), A.plan), false);
    const missingDone = plan(`JUDGMENT: stage
GOAL: Harden release
APPROACH: Add checks
WHY: They prevent regressions
TODO: Add checks`);
    assert.equal(isAcceptableGoalPlanSynthesis(missingDone, A.plan), false);
  });

  it('rejects new cap drops', () => {
    const capped = plan(`${RAW_A}\nTODO: 2\nTODO: 3\nTODO: 4\nTODO: 5\nTODO: 6\nTODO: 7\nTODO: 8\nTODO: 9`);
    assert.ok(capped.dropped !== undefined);
    assert.equal(isAcceptableGoalPlanSynthesis(capped, A.plan), false);
  });

  it('formats honest notices without price, percentage, free, or consensus claims', () => {
    const notice = formatGoalPlanSelectionNotice({
      candidateA: 'claude', candidateB: 'codex', reason: 'the first plan lacked DONE criteria',
    });
    assert.match(notice, /3 total planning runs/);
    assert.doesNotMatch(notice, /\$|%|\bfree\b|consensus/i);
    const result = selectGoalPlanFromAdjudication({
      candidateA: A, candidateB: B, adjudicatorProvider: 'claude', rawText: synthesized('P2'),
    });
    const disclosure = formatGoalPlanSelectionDisclosure({
      status: 'ran', reason: 'selected',
      candidates: [
        { choice: 'P1', provider: 'claude', model: 'claude-model' },
        { choice: 'P2', provider: 'codex', model: 'codex-model' },
      ],
      adjudicator: { choice: 'P2', provider: 'claude', model: 'claude-model' },
      selectedProvider: 'codex', selectedChoice: 'P2', totalCalls: 3,
      selection: result.selection,
    });
    assert.match(disclosure, /one adjudicator chose P2/);
    assert.doesNotMatch(disclosure, /\$|%|\bfree\b|consensus/i);
  });
});

describe('goal-plan selection failure matrix', () => {
  it('keeps A when B fails', async () => {
    const result = await runWith(runner(outcome('codex', undefined, true)));
    assert.equal(result.plan, A.plan);
    assert.equal(result.receipt.reason, 'candidate-failed');
    assert.equal(result.receipt.totalCalls, 2);
    assert.equal(result.receipt.failedCandidate, 'codex');
  });

  it('keeps A when B is empty or unparseable', async () => {
    const empty = await runWith(runner(outcome('codex', '')));
    assert.equal(empty.receipt.reason, 'candidate-failed');
    const invalid = await runWith(runner(outcome('codex', 'not a tagged plan')));
    assert.equal(invalid.receipt.reason, 'candidate-invalid');
    assert.equal(invalid.plan, A.plan);
  });

  it('keeps A when B parses but the adjudicator fails', async () => {
    const result = await runWith(runner(outcome('codex', RAW_B), outcome('claude', undefined, true)));
    assert.equal(result.plan, A.plan);
    assert.equal(result.receipt.reason, 'adjudicator-failed');
    assert.equal(result.receipt.totalCalls, 3);
  });

  it('accepts synthesis when the adjudicator picks P1', async () => {
    const result = await runWith(runner(outcome('codex', RAW_B), outcome('claude', synthesized('P1'))));
    assert.equal(result.receipt.selectedChoice, 'P1');
    assert.equal(result.receipt.selection, 'synthesis');
    assert.notEqual(result.plan, A.plan);
  });

  it('accepts synthesis when the adjudicator picks P2', async () => {
    const calls: { role: string; provider: ProviderId; prompt: string }[] = [];
    const fakeRunner: GoalPlanSelectionRunner = async (request) => {
      calls.push(request);
      return request.role === 'candidate'
        ? outcome('codex', RAW_B)
        : outcome('claude', synthesized('P2'));
    };
    const result = await runWith(fakeRunner);
    assert.equal(result.receipt.selectedChoice, 'P2');
    assert.equal(result.receipt.selectedProvider, 'codex');
    assert.equal(result.receipt.selection, 'synthesis');
    assert.deepEqual(calls.map(({ role, provider }) => ({ role, provider })), [
      { role: 'candidate', provider: 'codex' },
      { role: 'adjudicator', provider: 'claude' },
    ]);
    assert.match(calls[0]?.prompt ?? '', /OWNER'S LATEST TURN:\nHarden the release/);
  });

  it('uses the named original when the body is invalid but the envelope is valid', async () => {
    const raw = 'JUDGMENT: clarify\nASK: Which release?\n{"choice":"P2","confidence":0.5}';
    const result = await runWith(runner(outcome('codex', RAW_B), outcome('claude', raw)));
    assert.deepEqual(result.plan, B.plan);
    assert.equal(result.receipt.selectedChoice, 'P2');
    assert.equal(result.receipt.selection, 'fallback');
  });

  it('uses A when both the body and envelope are invalid', async () => {
    const result = await runWith(runner(outcome('codex', RAW_B), outcome('claude', 'not a plan')));
    assert.equal(result.plan, A.plan);
    assert.equal(result.receipt.reason, 'invalid-adjudication');
    assert.equal(result.receipt.selectedChoice, 'P1');
  });

  it('uses the named original when synthesis regresses doneWhen', async () => {
    const regressive = `JUDGMENT: stage
GOAL: Verify release
APPROACH: Add checks
WHY: They prevent regressions
TODO: Add checks
{"choice":"P2","confidence":0.7}`;
    const result = await runWith(runner(outcome('codex', RAW_B), outcome('claude', regressive)));
    assert.deepEqual(result.plan, B.plan);
    assert.equal(result.receipt.selection, 'fallback');
  });
});
