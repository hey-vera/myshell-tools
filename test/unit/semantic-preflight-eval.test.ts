/**
 * test/unit/semantic-preflight-eval.test.ts — unit tests for the
 * semantic-preflight eval harness and frozen suite integrity.
 *
 * Tests all named cases from P1-08d of the Item-8 contract.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  SEMANTIC_PREFLIGHT_SUITE,
  SEMANTIC_PREFLIGHT_SUITE_SUMMARY,
  type SemanticPreflightEvalCase,
} from '../../src/core/eval/semantic-preflight-suite.ts';
import {
  scoreSemanticPreflightRun,
  type SemanticPreflightCaseOutcome,

  type SemanticPreflightHarnessOptions,
} from '../../src/core/eval/semantic-preflight-harness.ts';
import type {
  SemanticPreflightV1,
  SemanticTaskKind,
  SemanticTaskScope,
  EvidenceKind,
  EvidencePhase,
} from '../../src/core/semantic-preflight.ts';
import type { TurnCallBudgetReceipt, TurnCallBudgetEvent, TurnCallPurpose } from '../../src/core/turn-call-budget.js';
import type { Risk, Tier } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers to build synthetic test fixtures
// ---------------------------------------------------------------------------

function makeSemantic(
  kind: SemanticTaskKind = 'change',
  scope: SemanticTaskScope = 'single-step',
  mutates: boolean = true,
  tier: Tier = 'ic',
  plan: boolean = true,
  risk: Risk = 'medium',
  objective: string = 'fix a bug',
  doneText: string = 'bug is fixed',
  evidenceNeeded: readonly { id: string; kind: EvidenceKind; phase: EvidencePhase; query: string; required: boolean }[] = [],
): SemanticPreflightV1 {
  return {
    version: 1,
    objective,
    taskShape: { kind, scope, mutatesWorkspace: mutates },
    route: { tier, plan, rationale: 'test rationale' },
    risk: { level: risk, reasons: ['test reason'] },
    uncertainty: { level: 'low', reasons: [], forks: [] },
    evidenceNeeded: evidenceNeeded.map((e) => ({ ...e })),
    doneCondition: { status: 'specified', text: doneText },
    planSteps: [],
    proposedExecution: { provider: 'auto', effort: 'medium', rationale: 'test' },
    source: 'model',
  };
}

function makeReceipt(
  events: readonly TurnCallBudgetEvent[] = [],
): TurnCallBudgetReceipt {
  return {
    turnId: 'test-turn',
    mode: 'observe',
    totalUnits: 20,
    begun: events.filter((e) => e.type === 'call-begun').length,
    settled: 0,
    denied: 0,
    workRemaining: 10,
    failoverRemaining: 1,
    verificationRemaining: 1,
    discretionaryRemaining: 5,
    released: false,
    events,
  };
}

function makeCallBegun(purpose: TurnCallPurpose): TurnCallBudgetEvent {
  return {
    type: 'call-begun',
    seq: 1,
    callId: 'test-call',
    purpose,
    bucket: 'discretionary',
  };
}

function makeOutcome(
  caseId: string,
  disposition: string = 'run',
  semantic: SemanticPreflightV1 | null = null,
  ms: number = 100,
  receipt?: TurnCallBudgetReceipt,
  error?: string,
): SemanticPreflightCaseOutcome {
  return {
    caseId,
    disposition: disposition as SemanticPreflightCaseOutcome['disposition'],
    semantic,
    ms,
    receipt,
    error,
  };
}

function firstPhrases(concepts: readonly (readonly string[])[]): string {
  return concepts
    .map((synset) => synset[0] ?? '')
    .filter((phrase) => phrase.length > 0)
    .join(' ');
}

function makeGoldSemanticForCase(c: SemanticPreflightEvalCase): SemanticPreflightV1 {
  const evidenceNeeded = c.allowedEvidenceKinds.flatMap((kind, kindIndex) =>
    c.allowedEvidencePhases.map((phase, phaseIndex) => ({
      id: `E${kindIndex}_${phaseIndex}`,
      kind,
      phase,
      query: c.task,
      required: true,
    })),
  );
  return makeSemantic(
    c.goldTaskKind,
    c.goldTaskScope,
    c.goldMutatesWorkspace,
    'ic',
    c.goldTaskScope === 'multi-step',
    c.goldMinimumRisk,
    firstPhrases(c.goldObjectiveKeyConcepts) || c.task,
    firstPhrases(c.goldDoneKeyConcepts) || 'done',
    evidenceNeeded,
  );
}

const defaultOpts: SemanticPreflightHarnessOptions = {
  commit: 'abc1234',
  node: 'v22.0.0',
  os: 'linux',
  cpu: 'x64',
  provider: 'claude',
  model: 'sonnet',
  effort: 'medium',
  timeoutMs: 8000,
  warmups: 0,
  startedAt: '2026-07-02T00:00:00.000Z',
  completedAt: '2026-07-02T00:05:00.000Z',
};

const allCases = [...SEMANTIC_PREFLIGHT_SUITE] as readonly SemanticPreflightEvalCase[];

// ---------------------------------------------------------------------------
// 1. Suite contains exactly 200 unique stable ids and required category counts
// ---------------------------------------------------------------------------

describe('suite contains exactly 200 unique stable ids and required category counts', () => {
  it('has exactly 200 cases', () => {
    assert.equal(SEMANTIC_PREFLIGHT_SUITE.length, 200);
  });

  it('has all unique ids', () => {
    const ids = new Set<string>();
    for (const c of SEMANTIC_PREFLIGHT_SUITE) {
      assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
      ids.add(c.id);
    }
    assert.equal(ids.size, 200);
  });

  it('has exactly 50 trivial cases with ids T001 through T050', () => {
    const trivial = SEMANTIC_PREFLIGHT_SUITE.filter(
      (c) => c.goldDisposition === 'bypass-trivial',
    );
    assert.equal(trivial.length, 50);
    for (let i = 1; i <= 50; i++) {
      const id = `T${String(i).padStart(3, '0')}`;
      assert.ok(trivial.some((c) => c.id === id), `missing trivial case ${id}`);
    }
  });

  it('has exactly 100 nontrivial cases with ids N001 through N100', () => {
    const nontrivial = SEMANTIC_PREFLIGHT_SUITE.filter(
      (c) => c.goldDisposition === 'run' && c.id.startsWith('N'),
    );
    assert.equal(nontrivial.length, 100);
    for (let i = 1; i <= 100; i++) {
      const id = `N${String(i).padStart(3, '0')}`;
      assert.ok(nontrivial.some((c) => c.id === id), `missing nontrivial case ${id}`);
    }
  });

  it('has exactly 50 risk cases with ids R001 through R050', () => {
    const risk = SEMANTIC_PREFLIGHT_SUITE.filter((c) => c.id.startsWith('R'));
    assert.equal(risk.length, 50);
    for (let i = 1; i <= 50; i++) {
      const id = `R${String(i).padStart(3, '0')}`;
      assert.ok(risk.some((c) => c.id === id), `missing risk case ${id}`);
    }
  });

  it('has 30 dangerous positives among R-cases (no goldMaximumRisk)', () => {
    const dangerous = SEMANTIC_PREFLIGHT_SUITE.filter(
      (c) => c.id.startsWith('R') && c.goldMaximumRisk === undefined,
    );
    assert.equal(dangerous.length, 30);
  });

  it('has 20 benign lookalikes among R-cases (goldMaximumRisk defined)', () => {
    const benign = SEMANTIC_PREFLIGHT_SUITE.filter(
      (c) => c.id.startsWith('R') && c.goldMaximumRisk !== undefined,
    );
    assert.equal(benign.length, 20);
  });

  it('has 25 unique paraphrase groups (PG01-PG25), each with exactly 4 cases', () => {
    const groups = new Map<string, SemanticPreflightEvalCase[]>();
    for (const c of SEMANTIC_PREFLIGHT_SUITE) {
      if (c.paraphraseGroupId !== undefined) {
        const existing = groups.get(c.paraphraseGroupId);
        if (existing !== undefined) {
          existing.push(c);
        } else {
          groups.set(c.paraphraseGroupId, [c]);
        }
      }
    }
    assert.equal(groups.size, 25);
    for (const [gid, group] of groups) {
      assert.ok(
        gid.match(/^PG\d{2}$/),
        `group id ${gid} does not match PG01-PG25 pattern`,
      );
      assert.equal(
        group.length,
        4,
        `group ${gid} has ${group.length} cases, expected 4`,
      );
    }
  });

  it('has at least 40 local evidence, 20 external, 30 before-completion', () => {
    let localCount = 0;
    let externalCount = 0;
    let beforeCompletionCount = 0;
    for (const c of SEMANTIC_PREFLIGHT_SUITE) {
      if (c.allowedEvidenceKinds.includes('local-code')) localCount++;
      if (c.allowedEvidenceKinds.includes('external-source')) externalCount++;
      if (c.allowedEvidencePhases.includes('before-completion')) beforeCompletionCount++;
    }
    assert.ok(localCount >= 40, `local evidence: ${localCount} < 40`);
    assert.ok(externalCount >= 20, `external evidence: ${externalCount} < 20`);
    assert.ok(beforeCompletionCount >= 30, `before-completion: ${beforeCompletionCount} < 30`);
  });

  it('summary matches the observed counts', () => {
    const s = SEMANTIC_PREFLIGHT_SUITE_SUMMARY;
    assert.equal(s.totalCount, 200);
    assert.equal(s.trivialCount, 50);
    assert.equal(s.nontrivialCount, 100);
    assert.equal(s.riskCount, 50);
    assert.equal(s.dangerousPositiveCount, 30);
    assert.equal(s.benignLookalikeCount, 20);
    assert.equal(s.paraphraseGroupCount, 25);
  });
});

// ---------------------------------------------------------------------------
// 2. Paraphrase scorer requires all compared semantic dimensions
// ---------------------------------------------------------------------------

describe('paraphrase scorer requires all compared semantic dimensions', () => {
  // Use actual PG01 cases (N001-N004) — 4 cases that should agree on everything
  const pg01Cases = SEMANTIC_PREFLIGHT_SUITE.filter(
    (c) => c.paraphraseGroupId === 'PG01',
  );
  assert.equal(pg01Cases.length, 4, 'PG01 must have 4 cases');

  it('all-four-agree passes the paraphrase group', () => {
    const semantic = makeSemantic('lookup', 'single-step', false, 'worker', false, 'low',
      'find the definition of handleError',
      'found the definition in a file');
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      ...pg01Cases.map((c) => makeOutcome(c.id, 'run', semantic, 100)),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 1);
  });

  it('kind mismatch fails the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('change', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'kind mismatch should fail the group');
  });

  it('scope mismatch fails the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('lookup', 'multi-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'scope mismatch should fail the group');
  });

  it('mutation mismatch fails the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('lookup', 'single-step', true, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'mutation mismatch should fail the group');
  });

  it('risk level mismatch fails the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'medium', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'risk mismatch should fail the group');
  });

  it('evidence kind set mismatch fails the paraphrase group', () => {
    const withEvidence = (kinds: EvidenceKind[]) => makeSemantic(
      'lookup', 'single-step', false, 'worker', false, 'low',
      'find handleError', 'found in file',
      kinds.map((k) => ({ id: `E_${k}`, kind: k, phase: 'before-answer' as EvidencePhase, query: 'q', required: true })),
    );
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', withEvidence(['local-code']), 100),
      makeOutcome('N002', 'run', withEvidence(['local-code']), 100),
      makeOutcome('N003', 'run', withEvidence(['local-code']), 100),
      makeOutcome('N004', 'run', withEvidence(['external-source']), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'evidence kind set mismatch should fail the group');
  });

  it('evidence phase set mismatch fails the paraphrase group', () => {
    const withPhase = (phase: EvidencePhase) => makeSemantic(
      'lookup', 'single-step', false, 'worker', false, 'low',
      'find handleError', 'found in file',
      [{ id: 'E1', kind: 'local-code', phase, query: 'q', required: true }],
    );
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', withPhase('before-answer'), 100),
      makeOutcome('N002', 'run', withPhase('before-answer'), 100),
      makeOutcome('N003', 'run', withPhase('before-answer'), 100),
      makeOutcome('N004', 'run', withPhase('before-execution'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'evidence phase set mismatch should fail the group');
  });

  it('route plan mismatch fails the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', true, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'worker', true, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'worker', true, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'route plan mismatch should fail the group');
  });

  it('tier difference of two rungs fails the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'ic', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'ic', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('lookup', 'single-step', false, 'manager', false, 'low', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 0,
      'tier distance 2 (worker to manager) should fail the group');
  });

  it('tier difference of one rung passes the paraphrase group', () => {
    const outcomes: SemanticPreflightCaseOutcome[] = [
      ...allCases.slice(0, 50).map((c) => makeOutcome(c.id, 'bypass-trivial', null, 10)),
      makeOutcome('N001', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N002', 'run', makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N003', 'run', makeSemantic('lookup', 'single-step', false, 'ic', false, 'low', 'find handleError', 'found in file'), 100),
      makeOutcome('N004', 'run', makeSemantic('lookup', 'single-step', false, 'ic', false, 'low', 'find handleError', 'found in file'), 100),
    ];
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.paraphraseEquivalence.passedGroups, 1,
      'tier distance 1 should pass the group');
  });
});

// ---------------------------------------------------------------------------
// 3. One dangerous undercall fails risk false-negative gate
// ---------------------------------------------------------------------------

describe('one dangerous undercall fails risk false-negative gate', () => {
  it('dangerous case below gold minimumRisk produces a risk false-negative failure', () => {
    // R001 has goldMinimumRisk: 'high'
    const r001 = SEMANTIC_PREFLIGHT_SUITE.find((c) => c.id === 'R001');
    assert.ok(r001 !== undefined, 'R001 must exist');
    assert.equal(r001.goldMinimumRisk, 'high');
    assert.equal(r001.goldMaximumRisk, undefined);

    // Create a semantic result with risk 'medium' — below the gold 'high'
    const semantic = makeSemantic('change', 'multi-step', true, 'ic', false, 'medium',
      r001.task, 'done');
    const outcomes = allCases.map((c) => {
      if (c.id === 'R001') return makeOutcome(c.id, 'run', semantic, 100);
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      // Other R cases: set risk at or above their goldMinimumRisk
      if (c.id.startsWith('R') && c.goldMaximumRisk === undefined) {
        return makeOutcome(c.id, 'run',
          makeSemantic('change', 'single-step', true, 'ic', false, c.goldMinimumRisk, c.task, 'done'), 100);
      }
      if (c.id.startsWith('R') && c.goldMaximumRisk !== undefined) {
        return makeOutcome(c.id, 'run',
          makeSemantic('change', 'single-step', false, 'ic', false, 'low', c.task, 'done'), 100);
      }
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.riskFalseNegatives.failed, 1,
      'one dangerous case below gold min risk should produce exactly 1 false-negative');
    assert.ok(artifact.aggregate.riskFalseNegatives.failed > artifact.aggregate.riskFalseNegatives.allowed,
      `risk FN failed=${artifact.aggregate.riskFalseNegatives.failed} must exceed allowed=${artifact.aggregate.riskFalseNegatives.allowed}`);
  });

  it('dangerous case at gold minimumRisk passes (not a false-negative)', () => {
    const r001 = SEMANTIC_PREFLIGHT_SUITE.find((c) => c.id === 'R001');
    assert.ok(r001 !== undefined);

    // Risk at 'high' matches gold minimum
    const semantic = makeSemantic('change', 'multi-step', true, 'ic', false, 'high',
      r001.task, 'done');
    const outcomes = allCases.map((c) => {
      if (c.id === 'R001') return makeOutcome(c.id, 'run', semantic, 100);
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      if (c.id.startsWith('R') && c.goldMaximumRisk === undefined) {
        return makeOutcome(c.id, 'run',
          makeSemantic('change', 'single-step', true, 'ic', false, c.goldMinimumRisk, c.task, 'done'), 100);
      }
      if (c.id.startsWith('R') && c.goldMaximumRisk !== undefined) {
        return makeOutcome(c.id, 'run',
          makeSemantic('change', 'single-step', false, 'ic', false, 'low', c.task, 'done'), 100);
      }
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.riskFalseNegatives.failed, 0,
      'dangerous case at gold min risk should NOT be a false-negative');
  });

  it('dangerous case above gold minimumRisk passes (not a false-negative)', () => {
    const r001 = SEMANTIC_PREFLIGHT_SUITE.find((c) => c.id === 'R001');
    assert.ok(r001 !== undefined);

    // Risk at 'critical' is above gold minimum 'high'
    const semantic = makeSemantic('change', 'multi-step', true, 'ic', false, 'critical',
      r001.task, 'done');
    const outcomes = allCases.map((c) => {
      if (c.id === 'R001') return makeOutcome(c.id, 'run', semantic, 100);
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      if (c.id.startsWith('R') && c.goldMaximumRisk === undefined) {
        return makeOutcome(c.id, 'run',
          makeSemantic('change', 'single-step', true, 'ic', false, c.goldMinimumRisk, c.task, 'done'), 100);
      }
      if (c.id.startsWith('R') && c.goldMaximumRisk !== undefined) {
        return makeOutcome(c.id, 'run',
          makeSemantic('change', 'single-step', false, 'ic', false, 'low', c.task, 'done'), 100);
      }
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.riskFalseNegatives.failed, 0,
      'dangerous case above gold min risk should NOT be a false-negative');
  });
});

// ---------------------------------------------------------------------------
// 4. 50 of 50 trivial is required rather than rounded percentage
// ---------------------------------------------------------------------------

describe('50 of 50 trivial is required rather than rounded percentage', () => {
  it('49/50 trivial bypass reports 49 passed with required 50 and fails', () => {
    // All trivial cases bypass correctly except one (T001 gets 'run' instead)
    const outcomes = allCases.map((c) => {
      if (c.id === 'T001') return makeOutcome(c.id, 'run', null, 10); // should be bypass-trivial
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.trivialBypass.passed, 49);
    assert.equal(artifact.aggregate.trivialBypass.total, 50);
    assert.equal(artifact.aggregate.trivialBypass.required, 50);
    assert.equal(artifact.status, 'fail',
      '49/50 trivial bypass should NOT pass — required is exactly 50, not a rounded percentage');
  });

  it('50/50 trivial bypass with all zero ledger counts passes', () => {
    const receipt = makeReceipt([]); // zero events of any kind
    const outcomes = allCases.map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10, receipt);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.trivialBypass.passed, 50);
  });

  it('50/50 trivial bypass but one has an intent call in receipt fails', () => {
    const cleanReceipt = makeReceipt([]);
    const badReceipt = makeReceipt([makeCallBegun('intent')]);
    const outcomes = allCases.map((c) => {
      if (c.id === 'T001') return makeOutcome(c.id, 'bypass-trivial', null, 10, badReceipt);
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10, cleanReceipt);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.ok(artifact.aggregate.trivialBypass.passed < 50,
      `expected <50 trivial passed with an intent receipt event, got ${artifact.aggregate.trivialBypass.passed}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Ledger scorer rejects route reextract and second intent calls
// ---------------------------------------------------------------------------

describe('ledger scorer rejects route reextract and second intent calls', () => {
  it('nontrivial case with a route begun event fails ledger check', () => {
    const badReceipt = makeReceipt([makeCallBegun('intent'), makeCallBegun('route')]);
    const outcome = makeOutcome('N001', 'run',
      makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'),
      100, badReceipt);
    const outcomes = allCases.map((c) => {
      if (c.id === 'N001') return outcome;
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    const n001Result = artifact.caseResults.find((r) => r.caseId === 'N001');
    assert.ok(n001Result !== undefined);
    assert.equal(n001Result.checks['ledger-nontrivial'], false,
      'route event should fail ledger-nontrivial check');
    assert.ok(artifact.aggregate.nontrivialPreflight.passed < 150);
  });

  it('nontrivial case with a reextract-local event fails ledger check', () => {
    const badReceipt = makeReceipt([makeCallBegun('intent'), makeCallBegun('reextract-local')]);
    const outcome = makeOutcome('N001', 'run',
      makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'),
      100, badReceipt);
    const outcomes = allCases.map((c) => {
      if (c.id === 'N001') return outcome;
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    const n001Result = artifact.caseResults.find((r) => r.caseId === 'N001');
    assert.ok(n001Result !== undefined);
    assert.equal(n001Result.checks['ledger-nontrivial'], false,
      'reextract-local event should fail ledger-nontrivial check');
  });

  it('nontrivial case with two intent calls fails ledger check', () => {
    const badReceipt = makeReceipt([makeCallBegun('intent'), makeCallBegun('intent')]);
    const outcome = makeOutcome('N001', 'run',
      makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'),
      100, badReceipt);
    const outcomes = allCases.map((c) => {
      if (c.id === 'N001') return outcome;
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    const n001Result = artifact.caseResults.find((r) => r.caseId === 'N001');
    assert.ok(n001Result !== undefined);
    assert.equal(n001Result.checks['ledger-nontrivial'], false,
      'two intent events should fail ledger-nontrivial check (requires exactly 1)');
  });

  it('nontrivial case with reextract-web event fails ledger check', () => {
    const badReceipt = makeReceipt([makeCallBegun('intent'), makeCallBegun('reextract-web')]);
    const outcome = makeOutcome('N001', 'run',
      makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'),
      100, badReceipt);
    const outcomes = allCases.map((c) => {
      if (c.id === 'N001') return outcome;
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    const n001Result = artifact.caseResults.find((r) => r.caseId === 'N001');
    assert.ok(n001Result !== undefined);
    assert.equal(n001Result.checks['ledger-nontrivial'], false,
      'reextract-web event should fail ledger-nontrivial check');
  });

  it('nontrivial case with exactly one intent and nothing else passes ledger check', () => {
    const goodReceipt = makeReceipt([makeCallBegun('intent')]);
    const outcome = makeOutcome('N001', 'run',
      makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', 'find handleError', 'found in file'),
      100, goodReceipt);
    const outcomes = allCases.map((c) => {
      if (c.id === 'N001') return outcome;
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });

    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    const n001Result = artifact.caseResults.find((r) => r.caseId === 'N001');
    assert.ok(n001Result !== undefined);
    assert.equal(n001Result.checks['ledger-nontrivial'], true,
      'exactly one intent event should pass ledger-nontrivial check');
  });
});

// ---------------------------------------------------------------------------
// 6. Nearest-rank p95 and p99 exclude five warmups
// ---------------------------------------------------------------------------

describe('nearest-rank p95 and p99 exclude five warmups', () => {
  // Create a simplified suite with just 10 nontrivial cases + the 50 trivial
  // We'll use a subset of nontrivial cases
  const trivialCases = allCases.filter((c) => c.goldDisposition === 'bypass-trivial');
  const firstTenNontrivial = allCases.filter((c) => c.goldDisposition === 'run').slice(0, 10);
  const miniSuite = [...trivialCases, ...firstTenNontrivial];

  it('with warmups=5, only the last 5 nontrivial ms values are used for p95/p99', () => {
    // 10 nontrivial cases with ms 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    const outcomes = miniSuite.map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      const idx = firstTenNontrivial.indexOf(c);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'),
        (idx + 1) * 10,
        makeReceipt([makeCallBegun('intent')]));
    });

    const opts = { ...defaultOpts, warmups: 5 };
    const artifact = scoreSemanticPreflightRun(miniSuite, outcomes, opts);

    // After excluding first 5 warmups, the remaining values are: 60, 70, 80, 90, 100
    // p95 via nearest-rank: index = ceil(95/100 * 5) - 1 = ceil(4.75) - 1 = 5 - 1 = 4 => sorted[4] = 100
    // p99 via nearest-rank: index = ceil(99/100 * 5) - 1 = ceil(4.95) - 1 = 5 - 1 = 4 => sorted[4] = 100
    assert.equal(artifact.aggregate.p95Ms, 100);
    assert.equal(artifact.aggregate.p99Ms, 100);
  });

  it('with warmups=0, all 10 values are used', () => {
    const outcomes = miniSuite.map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      const idx = firstTenNontrivial.indexOf(c);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'),
        (idx + 1) * 10,
        makeReceipt([makeCallBegun('intent')]));
    });

    const opts = { ...defaultOpts, warmups: 0 };
    const artifact = scoreSemanticPreflightRun(miniSuite, outcomes, opts);

    // All 10 values: 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
    // p95: ceil(95/100 * 10) - 1 = ceil(9.5) - 1 = 10 - 1 = 9 => sorted[9] = 100
    // p99: ceil(99/100 * 10) - 1 = ceil(9.9) - 1 = 10 - 1 = 9 => sorted[9] = 100
    assert.equal(artifact.aggregate.p95Ms, 100);
    assert.equal(artifact.aggregate.p99Ms, 100);
  });

  it('p95/p99 return null when no nontrivial ms values remain after warmup exclusion', () => {
    // 10 nontrivial, warmups=10 => all excluded
    const outcomes = miniSuite.map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      const idx = firstTenNontrivial.indexOf(c);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'),
        (idx + 1) * 10,
        makeReceipt([makeCallBegun('intent')]));
    });

    const opts = { ...defaultOpts, warmups: 10 };
    const artifact = scoreSemanticPreflightRun(miniSuite, outcomes, opts);
    assert.equal(artifact.aggregate.p95Ms, null,
      'p95 should be null when all samples excluded as warmups');
    assert.equal(artifact.aggregate.p99Ms, null,
      'p99 should be null when all samples excluded as warmups');
  });

  it('p95/p99 with a distribution of values returns correct nearest-rank', () => {
    // Only nontrivial cases
    const justThree = firstTenNontrivial.slice(0, 3);
    const simpleSuite = [...trivialCases, ...justThree];
    const outcomes = simpleSuite.map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      const idx = justThree.indexOf(c);
      // values: 100, 200, 300
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'),
        (idx + 1) * 100,
        makeReceipt([makeCallBegun('intent')]));
    });

    const opts = { ...defaultOpts, warmups: 0 };
    const artifact = scoreSemanticPreflightRun(simpleSuite, outcomes, opts);

    // p95: ceil(95/100 * 3) - 1 = ceil(2.85) - 1 = 3 - 1 = 2 => sorted[2] = 300
    // p99: ceil(99/100 * 3) - 1 = ceil(2.97) - 1 = 3 - 1 = 2 => sorted[2] = 300
    assert.equal(artifact.aggregate.p95Ms, 300);
    assert.equal(artifact.aggregate.p99Ms, 300);
  });
});

// ---------------------------------------------------------------------------
// 7. Incomplete aborted and thrown runs never report pass
// ---------------------------------------------------------------------------

describe('incomplete aborted and thrown runs never report pass', () => {
  // Build a fully-passing outcome set
  function buildPerfectOutcomes(): SemanticPreflightCaseOutcome[] {
    return allCases.map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeGoldSemanticForCase(c), 100,
        makeReceipt([makeCallBegun('intent')]));
    });
  }

  it('runAborted=true forces status incomplete even when all thresholds pass', () => {
    const outcomes = buildPerfectOutcomes();
    const opts = { ...defaultOpts, runAborted: true };
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, opts);
    assert.equal(artifact.status, 'incomplete',
      'aborted runs must report incomplete, never pass');
  });

  it('runThrew=true forces status incomplete even when all thresholds pass', () => {
    const outcomes = buildPerfectOutcomes();
    const opts = { ...defaultOpts, runThrew: true };
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, opts);
    assert.equal(artifact.status, 'incomplete',
      'thrown runs must report incomplete, never pass');
  });

  it('runThrew=true even with one case missing still reports incomplete, not pass', () => {
    // Remove one outcome
    const outcomes = buildPerfectOutcomes().slice(0, -1);
    const opts = { ...defaultOpts, runThrew: true };
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, opts);
    assert.equal(artifact.status, 'incomplete');
  });

  it('missing outcomes produce status incomplete (fewer outcomes than cases)', () => {
    // Only provide 100 outcomes for 200 cases
    const outcomes = allCases.slice(0, 100).map((c) => {
      if (c.goldDisposition === 'bypass-trivial') return makeOutcome(c.id, 'bypass-trivial', null, 10);
      return makeOutcome(c.id, 'run',
        makeSemantic('lookup', 'single-step', false, 'worker', false, 'low', c.task, 'done'), 100);
    });
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.status, 'incomplete',
      'partial outcomes must report incomplete, never pass');
  });

  it('duplicate outcome ids produce status incomplete even when outcome length matches', () => {
    const outcomes = buildPerfectOutcomes();
    const duplicated = [...outcomes.slice(0, -1), outcomes[0] as SemanticPreflightCaseOutcome];
    const artifact = scoreSemanticPreflightRun(allCases, duplicated, defaultOpts);
    assert.equal(artifact.status, 'incomplete');
    assert.ok(
      artifact.failures.some((failure) => failure.detail.includes('duplicate outcome')),
      'duplicate outcome should be recorded in failures',
    );
  });

  it('empty outcomes produces status incomplete', () => {
    const artifact = scoreSemanticPreflightRun(allCases, [], defaultOpts);
    assert.equal(artifact.status, 'incomplete',
      'empty outcomes must report incomplete, never pass');
  });

  it('a perfect run with all cases passing reports pass', () => {
    const outcomes = buildPerfectOutcomes();
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.status, 'pass');
  });

  it('one non-dangerous null extraction is not given fabricated key-concept credit', () => {
    const outcomes = buildPerfectOutcomes().map((outcome) =>
      outcome.caseId === 'N001'
        ? makeOutcome(
            'N001',
            'run',
            null,
            100,
            makeReceipt([makeCallBegun('intent')]),
            'parse returned null',
          )
        : outcome,
    );
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    const n001 = artifact.caseResults.find((result) => result.caseId === 'N001');
    assert.ok(n001 !== undefined);
    assert.equal(n001.checks['schema-valid'], false);
    assert.equal(n001.checks['key-concepts-objective'], false);
    assert.equal(n001.checks['key-concepts-done'], false);
    assert.equal(artifact.aggregate.schemaValidity.passed, 149);
    assert.equal(artifact.aggregate.keyConceptRecall.score, 99.33);
    assert.equal(artifact.status, 'pass');
  });

  it('a dangerous null extraction is a risk false negative and cannot pass', () => {
    const outcomes = buildPerfectOutcomes().map((outcome) =>
      outcome.caseId === 'R001'
        ? makeOutcome(
            'R001',
            'run',
            null,
            100,
            makeReceipt([makeCallBegun('intent')]),
            'parse returned null',
          )
        : outcome,
    );
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, defaultOpts);
    assert.equal(artifact.aggregate.riskFalseNegatives.failed, 1);
    assert.equal(artifact.status, 'fail');
  });

  it('artifact records start and completion timestamps and abort/threw flags', () => {
    const opts: SemanticPreflightHarnessOptions = {
      commit: 'abc',
      node: 'v22',
      os: 'linux',
      cpu: 'x64',
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      timeoutMs: 8000,
      warmups: 5,
      startedAt: '2026-07-02T10:00:00.000Z',
      completedAt: '2026-07-02T10:05:00.000Z',
      runAborted: true,
      runThrew: false,
    };
    const outcomes = buildPerfectOutcomes();
    const artifact = scoreSemanticPreflightRun(allCases, outcomes, opts);
    assert.equal(artifact.status, 'incomplete');
    assert.equal(artifact.startedAt, '2026-07-02T10:00:00.000Z');
    assert.equal(artifact.completedAt, '2026-07-02T10:05:00.000Z');
    assert.equal(artifact.runAborted, true);
    assert.equal(artifact.runThrew, false);
    assert.equal(artifact.commit, 'abc');
    assert.equal(artifact.node, 'v22');
    assert.equal(artifact.os, 'linux');
    assert.equal(artifact.cpu, 'x64');
    assert.equal(artifact.provider, 'claude');
    assert.equal(artifact.model, 'sonnet');
    assert.equal(artifact.effort, 'medium');
    assert.equal(artifact.timeoutMs, 8000);
    assert.equal(artifact.warmups, 5);
    assert.equal(artifact.aggregate.p95Ms, 100);
    assert.equal(artifact.aggregate.p99Ms, 100);
    assert.equal(artifact.aggregate.latency.p95LimitMs, 4000);
    assert.equal(artifact.receipts.length, 150);
  });
});
