import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  decideEvidenceInvestigation,
  type EvidenceCapabilities,
  type EvidenceObservation,
} from '../../src/core/evidence-investigation.ts';
import type { EvidenceNeed, SemanticPreflightV1 } from '../../src/core/semantic-preflight.ts';

const ALL_CAPS: EvidenceCapabilities = {
  repoPresent: true,
  localReadAvailable: true,
  webSearchAvailable: true,
};

function need(over: Partial<EvidenceNeed>): EvidenceNeed {
  return {
    id: 'E1',
    kind: 'local-code',
    phase: 'before-execution',
    query: 'Find relevant evidence',
    required: true,
    ...over,
  };
}

function semantic(over: {
  readonly taskKind?: SemanticPreflightV1['taskShape']['kind'];
  readonly mutatesWorkspace?: boolean;
  readonly uncertainty?: SemanticPreflightV1['uncertainty']['level'];
  readonly evidenceNeeded?: readonly EvidenceNeed[];
} = {}): SemanticPreflightV1 {
  return {
    version: 1,
    objective: 'Test objective',
    taskShape: {
      kind: over.taskKind ?? 'conversation',
      scope: 'single-step',
      mutatesWorkspace: over.mutatesWorkspace ?? false,
    },
    route: {
      tier: 'ic',
      plan: false,
      rationale: 'test',
    },
    risk: {
      level: 'low',
      reasons: [],
    },
    uncertainty: {
      level: over.uncertainty ?? 'low',
      reasons: [],
      forks: [],
    },
    evidenceNeeded: over.evidenceNeeded ?? [],
    doneCondition: {
      status: 'unknown',
      reason: 'not-inferable',
    },
    planSteps: [],
    proposedExecution: {
      provider: 'auto',
      effort: 'none',
      rationale: 'test',
    },
    source: 'model',
  };
}

describe('decideEvidenceInvestigation', () => {
  it('medium uncertainty with required test obligation may start and preserves obligation', () => {
    const obligation = need({
      id: 'T1',
      kind: 'test-result',
      phase: 'before-completion',
      query: 'Run the relevant tests',
      required: true,
    });
    const decision = decideEvidenceInvestigation(
      'make the feed load real data',
      semantic({ uncertainty: 'medium', evidenceNeeded: [obligation] }),
      { repoPresent: false, localReadAvailable: false, webSearchAvailable: false },
    );
    assert.equal(decision.beforeWork, 'none');
    assert.equal(decision.mayStartWork, true);
    assert.deepEqual(decision.beforeCompletion, [obligation]);
  });

  it('medium uncertainty without cheap verification cannot start merely from confidence', () => {
    const decision = decideEvidenceInvestigation(
      'choose a direction',
      semantic({ uncertainty: 'medium' }),
      ALL_CAPS,
    );
    assert.equal(decision.beforeWork, 'cannot-ground');
    assert.equal(decision.mayStartWork, false);
    assert.deepEqual(decision.beforeCompletion, []);
  });

  it('high uncertainty requires obtained pre-work evidence', () => {
    const local = need({ id: 'L1', kind: 'local-code', phase: 'before-execution' });
    const s = semantic({ uncertainty: 'high', evidenceNeeded: [local] });
    const blocked = decideEvidenceInvestigation('inspect the auth module', s, ALL_CAPS);
    assert.equal(blocked.beforeWork, 'local');
    assert.equal(blocked.mayStartWork, false);

    const obtained: EvidenceObservation = { needId: 'L1', kind: 'local-code', status: 'obtained' };
    const allowed = decideEvidenceInvestigation('inspect the auth module', s, ALL_CAPS, [obtained]);
    assert.equal(allowed.beforeWork, 'none');
    assert.equal(allowed.mayStartWork, true);
  });

  it('existing code claim requires local read even when semantic omitted evidence', () => {
    const decision = decideEvidenceInvestigation(
      'change the existing settings page copy',
      semantic({ taskKind: 'change', mutatesWorkspace: true, uncertainty: 'low' }),
      ALL_CAPS,
    );
    assert.equal(decision.beforeWork, 'local');
    assert.equal(decision.mayStartWork, false);
    assert.deepEqual(decision.beforeCompletion, []);
  });

  it('fresh external claim requires web and never falls back to local', () => {
    const s = semantic({ taskKind: 'lookup', uncertainty: 'low' });
    const needsWeb = decideEvidenceInvestigation(
      'look up the latest React release notes',
      s,
      ALL_CAPS,
    );
    assert.equal(needsWeb.beforeWork, 'web');
    assert.equal(needsWeb.mayStartWork, false);

    const noWeb = decideEvidenceInvestigation(
      'look up the latest React release notes',
      s,
      { repoPresent: true, localReadAvailable: true, webSearchAvailable: false },
    );
    assert.equal(noWeb.beforeWork, 'cannot-ground');
    assert.equal(noWeb.mayStartWork, false);
  });

  it('missing capability returns cannot-ground rather than pretending grounded', () => {
    const s = semantic({
      uncertainty: 'low',
      evidenceNeeded: [need({ id: 'L1', kind: 'local-code', phase: 'before-execution' })],
    });
    const decision = decideEvidenceInvestigation(
      'review the existing login code',
      s,
      { repoPresent: true, localReadAvailable: false, webSearchAvailable: true },
    );
    assert.equal(decision.beforeWork, 'cannot-ground');
    assert.equal(decision.mayStartWork, false);
  });

  it('failed or unrelated observation does not satisfy a required need', () => {
    const external = need({
      id: 'W1',
      kind: 'external-source',
      phase: 'before-answer',
      query: 'Find current release status',
    });
    const observations: readonly EvidenceObservation[] = [
      { needId: 'W1', kind: 'external-source', status: 'failed' },
      { needId: 'W2', kind: 'external-source', status: 'obtained' },
      { needId: 'W1', kind: 'local-code', status: 'obtained' },
    ];
    const decision = decideEvidenceInvestigation(
      'what is the latest package release?',
      semantic({ taskKind: 'lookup', evidenceNeeded: [external] }),
      ALL_CAPS,
      observations,
    );
    assert.equal(decision.beforeWork, 'web');
    assert.equal(decision.mayStartWork, false);
  });

  it('obtained matching observation clears only its required pre-work need', () => {
    const local = need({ id: 'L1', kind: 'local-code', phase: 'before-execution' });
    const external = need({ id: 'W1', kind: 'external-source', phase: 'before-answer' });
    const s = semantic({ evidenceNeeded: [local, external] });

    const localOnly = decideEvidenceInvestigation(
      'update the current dashboard with latest uptime guidance',
      s,
      ALL_CAPS,
      [{ needId: 'L1', kind: 'local-code', status: 'obtained' }],
    );
    assert.equal(localOnly.beforeWork, 'web');
    assert.equal(localOnly.mayStartWork, false);

    const externalOnly = decideEvidenceInvestigation(
      'update the current dashboard with latest uptime guidance',
      s,
      ALL_CAPS,
      [{ needId: 'W1', kind: 'external-source', status: 'obtained' }],
    );
    assert.equal(externalOnly.beforeWork, 'local');
    assert.equal(externalOnly.mayStartWork, false);
  });

  it('low uncertainty preserves before-completion obligations', () => {
    const command = need({
      id: 'C1',
      kind: 'command-output',
      phase: 'before-completion',
      query: 'Show command output',
      required: false,
    });
    const local = need({
      id: 'LATE_LOCAL',
      kind: 'local-code',
      phase: 'before-completion',
      query: 'Check changed local files',
      required: true,
    });
    const decision = decideEvidenceInvestigation(
      'say how you would approach this',
      semantic({ uncertainty: 'low', evidenceNeeded: [command, local] }),
      { repoPresent: false, localReadAvailable: false, webSearchAvailable: false },
    );
    assert.equal(decision.beforeWork, 'none');
    assert.equal(decision.mayStartWork, true);
    assert.deepEqual(decision.beforeCompletion, [command, local]);
  });

  it('required user input before work blocks until an obtained user-turn observation exists', () => {
    const userInput = need({
      id: 'U1',
      kind: 'user-input',
      phase: 'before-execution',
      query: 'Which account should be changed?',
    });
    const s = semantic({ evidenceNeeded: [userInput] });
    const blocked = decideEvidenceInvestigation('change the account setting', s, ALL_CAPS);
    assert.equal(blocked.beforeWork, 'user-input');
    assert.equal(blocked.mayStartWork, false);

    const allowed = decideEvidenceInvestigation('change the account setting', s, ALL_CAPS, [
      { needId: 'U1', kind: 'user-input', status: 'obtained' },
    ]);
    assert.equal(allowed.beforeWork, 'none');
    assert.equal(allowed.mayStartWork, true);
  });

  it('keeps 100k pure decisions below the p95 budget', () => {
    const s = semantic({
      uncertainty: 'medium',
      evidenceNeeded: [
        need({
          id: 'T1',
          kind: 'test-result',
          phase: 'before-completion',
          query: 'Run tests',
          required: true,
        }),
      ],
    });
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      decideEvidenceInvestigation('make the feed load real data', s, ALL_CAPS);
    }
    for (let i = 0; i < 100_000; i++) {
      const start = performance.now();
      decideEvidenceInvestigation('make the feed load real data', s, ALL_CAPS);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    assert.ok(p95 < 0.1, `p95 ${p95.toFixed(4)}ms must stay below 0.1ms`);
  });
});
