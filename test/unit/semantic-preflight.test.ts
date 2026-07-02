import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseSemanticPreflight,
  fallbackSemanticPreflight,
  maxRisk,
  resolveSemanticPreflight,
  semanticToIntentFrame,
} from '../../src/core/semantic-preflight.ts';
import type { Classification } from '../../src/core/types.ts';

function makeValid(): Record<string, unknown> {
  return {
    objective: 'Add dark mode toggle to settings',
    taskShape: {
      kind: 'change',
      scope: 'multi-step',
      mutatesWorkspace: true,
    },
    route: {
      tier: 'ic',
      plan: true,
      rationale: 'Multi-step feature work across UI and persistence',
    },
    risk: {
      level: 'medium',
      reasons: ['Touches shared theme module', 'Involves settings persistence'],
    },
    uncertainty: {
      level: 'medium',
      reasons: ['Unclear which CSS approach the user prefers'],
      forks: [
        {
          id: 'F1',
          question: 'CSS Variables vs Tailwind?',
          options: ['CSS variables — portable', 'Tailwind — project standard'],
          assumeIfUnasked: 'Tailwind',
        },
      ],
    },
    evidenceNeeded: [
      {
        id: 'E1',
        kind: 'local-code',
        phase: 'before-execution',
        query: 'Find current theme system',
        required: true,
      },
    ],
    doneCondition: {
      status: 'specified',
      text: 'Dark mode toggle visible and working',
    },
    planSteps: [
      { text: 'Add state context', dependsOn: [] },
      { text: 'Build toggle component', dependsOn: [1] },
    ],
    proposedExecution: {
      provider: 'claude',
      effort: 'medium',
      rationale: 'Substantial multi-file change needs balanced model',
    },
  };
}

const deterministicIcLow: Classification = { tier: 'ic', risk: 'low', rationale: 'test' };
const deterministicWorkerCritical: Classification = { tier: 'worker', risk: 'critical', rationale: 'test' };
const deterministicWorkerHigh: Classification = { tier: 'worker', risk: 'high', rationale: 'test' };

describe('parseSemanticPreflight', () => {
  it('parses every required V1 field and reuses GoalPlanTodo dependencies', () => {
    const json = JSON.stringify(makeValid());
    const result = parseSemanticPreflight(json);
    assert.ok(result !== null, 'must parse valid JSON');
    assert.equal(result!.version, 1);
    assert.equal(result!.objective, 'Add dark mode toggle to settings');
    assert.equal(result!.taskShape.kind, 'change');
    assert.equal(result!.taskShape.scope, 'multi-step');
    assert.equal(result!.taskShape.mutatesWorkspace, true);
    assert.equal(result!.route.tier, 'ic');
    assert.equal(result!.route.plan, true);
    assert.equal(result!.risk.level, 'medium');
    assert.deepStrictEqual(result!.risk.reasons, [
      'Touches shared theme module',
      'Involves settings persistence',
    ]);
    assert.equal(result!.uncertainty.level, 'medium');
    assert.equal(result!.uncertainty.reasons[0], 'Unclear which CSS approach the user prefers');
    assert.equal(result!.uncertainty.forks.length, 1);
    assert.equal(result!.uncertainty.forks[0].id, 'F1');
    assert.equal(result!.evidenceNeeded.length, 1);
    assert.equal(result!.evidenceNeeded[0].id, 'E1');
    assert.equal(result!.doneCondition.status, 'specified');
    if (result!.doneCondition.status === 'specified') {
      assert.equal(result!.doneCondition.text, 'Dark mode toggle visible and working');
    }
    assert.equal(result!.planSteps.length, 2);
    assert.equal(result!.planSteps[0].text, 'Add state context');
    assert.equal(result!.planSteps[1].text, 'Build toggle component');
    assert.deepStrictEqual(result!.planSteps[1].dependsOn, [1]);
    assert.equal(result!.proposedExecution.provider, 'claude');
    assert.equal(result!.proposedExecution.effort, 'medium');
    assert.equal(result!.source, 'model');
  });

  it('rejects a missing objective task shape risk uncertainty evidence done or execution field', () => {
    const base = makeValid();

    const missingObjective = { ...base };
    delete (missingObjective as Record<string, unknown>)['objective'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingObjective)), null);

    const missingTaskShape = { ...base };
    delete (missingTaskShape as Record<string, unknown>)['taskShape'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingTaskShape)), null);

    const missingRisk = { ...base };
    delete (missingRisk as Record<string, unknown>)['risk'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingRisk)), null);

    const missingUncertainty = { ...base };
    delete (missingUncertainty as Record<string, unknown>)['uncertainty'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingUncertainty)), null);

    const missingEvidence = { ...base };
    delete (missingEvidence as Record<string, unknown>)['evidenceNeeded'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingEvidence)), null);

    const missingDone = { ...base };
    delete (missingDone as Record<string, unknown>)['doneCondition'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingDone)), null);

    const missingPlanSteps = { ...base };
    delete (missingPlanSteps as Record<string, unknown>)['planSteps'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingPlanSteps)), null);

    const missingExec = { ...base };
    delete (missingExec as Record<string, unknown>)['proposedExecution'];
    assert.equal(parseSemanticPreflight(JSON.stringify(missingExec)), null);
  });

  it('caps strings lists forks evidence and plan steps deterministically', () => {
    const long = 'A'.repeat(200);
    const over: Record<string, unknown> = {
      objective: long,
      taskShape: { kind: 'lookup', scope: 'single-step', mutatesWorkspace: false },
      route: { tier: 'worker', plan: false, rationale: long },
      risk: {
        level: 'low',
        reasons: [long, long, long, long, long, long],
      },
      uncertainty: {
        level: 'low',
        reasons: [long, long, long, long, long, long],
        forks: [
          { id: 'X1', question: long, options: [long, long, long, long, long, long] },
          { id: 'X2', question: long },
          { id: 'X3', question: long },
          { id: 'X4', question: long },
          { id: 'X5', question: long },
        ],
      },
      evidenceNeeded: [
        { id: 'E1', kind: 'local-code', phase: 'before-execution', query: long, required: true },
        { id: 'E2', kind: 'external-source', phase: 'before-answer', query: long, required: false },
        { id: 'E3', kind: 'command-output', phase: 'before-completion', query: long, required: true },
        { id: 'E4', kind: 'test-result', phase: 'before-completion', query: long, required: true },
        { id: 'E5', kind: 'user-input', phase: 'before-answer', query: long, required: true },
        { id: 'E6', kind: 'local-code', phase: 'before-execution', query: long, required: true },
        { id: 'E7', kind: 'external-source', phase: 'before-answer', query: long, required: true },
      ],
      doneCondition: { status: 'specified', text: long },
      planSteps: [
        { text: long }, { text: long }, { text: long }, { text: long },
        { text: long }, { text: long }, { text: long }, { text: long },
        { text: long }, { text: long },
      ],
      proposedExecution: {
        provider: 'claude',
        effort: 'low',
        rationale: long,
      },
    };

    const result = parseSemanticPreflight(JSON.stringify(over));
    assert.ok(result !== null);
    assert.ok(result!.objective.length <= 80);
    assert.ok(result!.route.rationale.length <= 120);
    assert.ok(result!.risk.reasons.length <= 4);
    assert.ok(result!.uncertainty.reasons.length <= 4);
    assert.ok(result!.uncertainty.forks.length <= 3);
    assert.ok(result!.evidenceNeeded.length <= 6);
    assert.ok(result!.planSteps.length <= 8);
    assert.ok(result!.proposedExecution.rationale.length <= 120);

    if (result!.doneCondition.status === 'specified') {
      assert.ok(result!.doneCondition.text.length <= 160);
    }
  });

  it('fallback is complete but labels done condition unavailable instead of inventing it', () => {
    const result = fallbackSemanticPreflight('fix the login bug', deterministicIcLow);
    assert.equal(result.version, 1);
    assert.ok(result.objective.length > 0);
    assert.equal(result.taskShape.kind, 'conversation');
    assert.equal(result.taskShape.scope, 'single-step');
    assert.equal(result.taskShape.mutatesWorkspace, false);
    assert.equal(result.route.tier, 'ic');
    assert.equal(result.route.plan, false);
    assert.equal(result.risk.level, 'low');
    assert.equal(result.risk.reasons.length, 0);
    assert.equal(result.uncertainty.level, 'high');
    assert.equal(result.uncertainty.reasons.length, 0);
    assert.equal(result.uncertainty.forks.length, 0);
    assert.equal(result.evidenceNeeded.length, 0);
    assert.equal(result.doneCondition.status, 'unknown');
    if (result.doneCondition.status === 'unknown') {
      assert.equal(result.doneCondition.reason, 'semantic-preflight-unavailable');
    }
    assert.equal(result.planSteps.length, 0);
    assert.equal(result.proposedExecution.provider, 'auto');
    assert.equal(result.proposedExecution.effort, 'none');
    assert.equal(result.source, 'rules-fallback');
  });

  it('semantic critical raises deterministic low', () => {
    const resolved = maxRisk('low', 'critical');
    assert.equal(resolved, 'critical');
  });

  it('semantic low cannot lower deterministic critical', () => {
    const resolved = maxRisk('critical', 'low');
    assert.equal(resolved, 'critical');
  });

  it('semantic tier may lower or raise without selecting a provider', () => {
    const valid = makeValid();
    const semantic = parseSemanticPreflight(JSON.stringify(valid))!;

    const resolvedLower = resolveSemanticPreflight(deterministicIcLow, semantic);
    assert.equal(resolvedLower.classification.tier, 'ic');
    assert.equal(resolvedLower.routePlan, true);

    const managerSemantic = parseSemanticPreflight(
      JSON.stringify({
        ...makeValid(),
        route: { tier: 'manager', plan: true, rationale: 'needs manager' },
      }),
    )!;
    const resolvedRaise = resolveSemanticPreflight(deterministicIcLow, managerSemantic);
    assert.equal(resolvedRaise.classification.tier, 'manager');

    assert.ok(
      resolvedLower.classification.rationale.includes('deterministic') ||
        resolvedLower.classification.rationale.includes('semantic'),
    );
  });

  it('parser never throws on proxies arrays primitives oversized and invalid JSON', () => {
    assert.doesNotThrow(() => parseSemanticPreflight(undefined as unknown as string));
    assert.doesNotThrow(() => parseSemanticPreflight(''));
    assert.doesNotThrow(() => parseSemanticPreflight('not json'));
    assert.doesNotThrow(() => parseSemanticPreflight('{"a":1'));
    assert.doesNotThrow(() => parseSemanticPreflight('null'));
    assert.doesNotThrow(() => parseSemanticPreflight('42'));
    assert.doesNotThrow(() => parseSemanticPreflight('[]'));
    assert.doesNotThrow(() => parseSemanticPreflight('"string"'));
    assert.doesNotThrow(() => parseSemanticPreflight('true'));
    assert.doesNotThrow(() => parseSemanticPreflight('x'.repeat(1_000_000)));
    assert.equal(parseSemanticPreflight(null as unknown as string), null);
    assert.doesNotThrow(() => parseSemanticPreflight(new Proxy({}, {}) as unknown as string));
  });

  it('rejects duplicate evidence IDs', () => {
    const dup = {
      ...makeValid(),
      evidenceNeeded: [
        { id: 'E1', kind: 'local-code', phase: 'before-execution', query: 'q1', required: true },
        { id: 'E1', kind: 'external-source', phase: 'before-answer', query: 'q2', required: false },
      ],
    };
    assert.equal(parseSemanticPreflight(JSON.stringify(dup)), null);
  });

  it('rejects invalid enum values in task shape risk uncertainty and evidence', () => {
    const badKind = { ...makeValid(), taskShape: { ...makeValid().taskShape, kind: 'invalid' } };
    assert.equal(parseSemanticPreflight(JSON.stringify(badKind)), null);

    const badTier = { ...makeValid(), route: { ...makeValid().route, tier: 'invalid' } };
    assert.equal(parseSemanticPreflight(JSON.stringify(badTier)), null);

    const badRisk = { ...makeValid(), risk: { ...makeValid().risk, level: 'invalid' } };
    assert.equal(parseSemanticPreflight(JSON.stringify(badRisk)), null);

    const badUncertainty = {
      ...makeValid(),
      uncertainty: { ...makeValid().uncertainty, level: 'invalid' },
    };
    assert.equal(parseSemanticPreflight(JSON.stringify(badUncertainty)), null);

    const badEvidence = {
      ...makeValid(),
      evidenceNeeded: [
        { id: 'E1', kind: 'invalid', phase: 'before-execution', query: 'q', required: true },
      ],
    };
    assert.equal(parseSemanticPreflight(JSON.stringify(badEvidence)), null);

    const badEffort = {
      ...makeValid(),
      proposedExecution: {
        ...makeValid().proposedExecution,
        effort: 'invalid',
      },
    };
    assert.equal(parseSemanticPreflight(JSON.stringify(badEffort)), null);
  });

  it('rejects evidence needs with invalid ids', () => {
    const badId = {
      ...makeValid(),
      evidenceNeeded: [
        { id: '1bad', kind: 'local-code', phase: 'before-execution', query: 'q', required: true },
      ],
    };
    assert.equal(parseSemanticPreflight(JSON.stringify(badId)), null);
  });

  it('rejects specified doneCondition with empty text', () => {
    const emptyText = {
      ...makeValid(),
      doneCondition: { status: 'specified', text: '' },
    };
    assert.equal(parseSemanticPreflight(JSON.stringify(emptyText)), null);
  });

  it('accepts unknown doneCondition with valid reason', () => {
    const unknownDone = {
      ...makeValid(),
      doneCondition: { status: 'unknown', reason: 'not-inferable' },
    };
    const result = parseSemanticPreflight(JSON.stringify(unknownDone));
    assert.ok(result !== null);
    assert.equal(result!.doneCondition.status, 'unknown');
    if (result!.doneCondition.status === 'unknown') {
      assert.equal(result!.doneCondition.reason, 'not-inferable');
    }
  });

  it('ignores extra JSON keys', () => {
    const withExtra = {
      ...makeValid(),
      extraField: 'should be ignored',
      nested: { also: 'ignored' },
    };
    const result = parseSemanticPreflight(JSON.stringify(withExtra));
    assert.ok(result !== null);
    assert.equal(result!.objective, 'Add dark mode toggle to settings');
  });

  it('parses prose-wrapped JSON (extracts last balanced object)', () => {
    const prose = 'Here is the result:\n```json\n' + JSON.stringify(makeValid()) + '\n```\nDone.';
    const result = parseSemanticPreflight(prose);
    assert.ok(result !== null);
    assert.equal(result!.objective, 'Add dark mode toggle to settings');
  });
});

describe('maxRisk', () => {
  it('returns the higher risk level', () => {
    assert.equal(maxRisk('low', 'low'), 'low');
    assert.equal(maxRisk('low', 'medium'), 'medium');
    assert.equal(maxRisk('low', 'high'), 'high');
    assert.equal(maxRisk('low', 'critical'), 'critical');

    assert.equal(maxRisk('medium', 'low'), 'medium');
    assert.equal(maxRisk('medium', 'medium'), 'medium');
    assert.equal(maxRisk('medium', 'high'), 'high');
    assert.equal(maxRisk('medium', 'critical'), 'critical');

    assert.equal(maxRisk('high', 'low'), 'high');
    assert.equal(maxRisk('high', 'medium'), 'high');
    assert.equal(maxRisk('high', 'high'), 'high');
    assert.equal(maxRisk('high', 'critical'), 'critical');

    assert.equal(maxRisk('critical', 'low'), 'critical');
    assert.equal(maxRisk('critical', 'medium'), 'critical');
    assert.equal(maxRisk('critical', 'high'), 'critical');
    assert.equal(maxRisk('critical', 'critical'), 'critical');
  });
});

describe('resolveSemanticPreflight', () => {
  it('semantic tier replaces deterministic tier', () => {
    const semantic = parseSemanticPreflight(JSON.stringify(makeValid()))!;
    const resolved = resolveSemanticPreflight(deterministicIcLow, semantic);
    assert.equal(resolved.classification.tier, 'ic');
    assert.equal(resolved.routePlan, true);
  });

  it('risk can only be raised never lowered', () => {
    const semantic = parseSemanticPreflight(JSON.stringify(makeValid()))!;
    const resolve1 = resolveSemanticPreflight(deterministicWorkerCritical, semantic);
    assert.equal(resolve1.classification.risk, 'critical');

    const resolve2 = resolveSemanticPreflight(deterministicWorkerHigh, semantic);
    assert.equal(resolve2.classification.risk, 'high');
  });

  it('rationale names both sources', () => {
    const semantic = parseSemanticPreflight(JSON.stringify(makeValid()))!;
    const resolved = resolveSemanticPreflight(deterministicIcLow, semantic);
    assert.ok(resolved.classification.rationale.includes('deterministic'));
    assert.ok(resolved.classification.rationale.includes('semantic'));
    assert.ok(resolved.classification.rationale.includes('max'));
  });
});

describe('semanticToIntentFrame', () => {
  it('converts losslessly for core fields', () => {
    const semantic = parseSemanticPreflight(JSON.stringify(makeValid()))!;
    const frame = semanticToIntentFrame(semantic);
    assert.equal(frame.version, 1);
    assert.equal(frame.goal, semantic.objective);

    assert.ok(frame.kind !== undefined);
    assert.equal(frame.confidence, 'medium');

    if (semantic.doneCondition.status === 'specified') {
      assert.equal(frame.doneWhen, semantic.doneCondition.text);
    }

    assert.equal(frame.forks?.length, 1);
    assert.equal(frame.forks![0].id, 'F1');
    assert.equal(frame.routeTier, 'ic');
    assert.equal(frame.routePlan, true);
    assert.equal(frame.operationRisk, 'medium');
  });
});

describe('semantic-preflight performance', () => {
  it('p95 under 1ms over 100k ops after 1k warmups', () => {
    const json = JSON.stringify(makeValid());

    for (let i = 0; i < 1_000; i++) {
      parseSemanticPreflight(json);
      resolveSemanticPreflight(deterministicIcLow, parseSemanticPreflight(json)!);
    }

    const times: number[] = [];
    for (let i = 0; i < 100_000; i++) {
      const start = performance.now();
      const parsed = parseSemanticPreflight(json);
      if (parsed) {
        resolveSemanticPreflight(deterministicIcLow, parsed);
      }
      times.push(performance.now() - start);
    }

    times.sort((a, b) => a - b);
    const p95Index = Math.ceil(times.length * 0.95) - 1;
    const p95 = times[p95Index]!;
    assert.ok(p95 < 1, `p95 was ${p95.toFixed(4)}ms, must be < 1ms`);
  });
});
