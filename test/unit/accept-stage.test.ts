import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildRepairEvidence,
  classifyGateOutcome,
  gateResult,
  runCandidateQualityGate,
  type CandidateResult,
  type GateResult,
} from '../../src/core/accept-stage.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { CoreEvent, OrchestrateDeps, SessionEntry } from '../../src/core/types.ts';
import type { VerifyOutcome } from '../../src/core/verify.ts';

function outcome(
  verified: VerifyOutcome['verified'],
  over: Partial<VerifyOutcome> = {},
): VerifyOutcome {
  return { verified, changedFiles: 1, changedPaths: ['src/a.ts'], ...over };
}

function deps(log: string[] = []): OrchestrateDeps & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    providers: {},
    clock: {
      now: () => 1,
      isoNow: () => '1970-01-01T00:00:00.001Z',
      uuid: () => 'uuid',
      random: () => 0.5,
    },
    session: {
      id: 'session',
      async append(entry): Promise<void> {
        log.push('append');
        entries.push(entry);
      },
    },
    ledger: { async record(): Promise<void> {} },
    policy: DEFAULT_POLICY,
    cwd: '/repo',
    sandbox: 'workspace-write',
    timeoutMs: 1_000,
    entries,
  };
}

function candidate(
  repair?: CandidateResult['repair'],
  over: Partial<CandidateResult> = {},
): CandidateResult {
  return {
    content: 'original',
    tier: 'ic',
    provider: 'claude',
    model: 'model',
    confidence: 0.9,
    costUsd: 1,
    durationMs: 10,
    totalCostUsd: 1,
    attempts: 1,
    disposition: 'clean',
    task: 'fix it',
    cwd: '/repo',
    verifyLevel: 'tests',
    availableProviders: ['claude'],
    repair: repair ?? repairResult(undefined),
    ...over,
  };
}

function repairResult(
  result: CandidateResult | undefined,
  observe?: (evidence: string) => void,
): CandidateResult['repair'] {
  return async function* (evidence) {
    observe?.(evidence);
    if (evidence.length < 0) yield { type: 'notice', level: 'info', message: evidence };
    return result;
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/** Drain a gate generator, capturing BOTH its events and its GateResult return. */
async function drainWithReturn(
  gen: AsyncGenerator<CoreEvent, GateResult>,
): Promise<{ events: CoreEvent[]; result: GateResult }> {
  const events: CoreEvent[] = [];
  let step = await gen.next();
  while (step.done !== true) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

function receiptEvents(result: VerifyOutcome | undefined): readonly CoreEvent[] {
  return result === undefined
    ? []
    : [{ type: 'notice', level: result.verified === 'failing' ? 'warn' : 'info', message: result.verified }];
}

describe('Candidate Quality Gate', () => {
  it('classifies only typed red as failing', () => {
    assert.equal(classifyGateOutcome(undefined), 'unverified');
    assert.equal(classifyGateOutcome(outcome('passing')), 'passing');
    assert.equal(classifyGateOutcome(outcome('failing')), 'failing');
    assert.equal(classifyGateOutcome(outcome('reviewed')), 'unverified');
    assert.equal(classifyGateOutcome(outcome('unverified')), 'unverified');
    const result: GateResult = gateResult(outcome('failing'));
    assert.equal(result.repairRequired, true);
  });

  it('accepts unarmed, green, no-diff, no-command, timeout, and errored without repair', async () => {
    const cases: Array<VerifyOutcome | undefined> = [
      undefined,
      outcome('passing'),
      outcome('unverified', { changedFiles: 0, changedPaths: undefined, note: 'no code change to verify' }),
      outcome('unverified', { note: 'no test command detected' }),
      outcome('unverified', { testRun: { outcome: 'timeout', output: '', durationMs: 10 } }),
      outcome('unverified', { testRun: { outcome: 'errored', output: '', durationMs: 10 } }),
    ];
    for (const verifyOutcome of cases) {
      let repairs = 0;
      const localDeps = deps();
      const events = await collect(runCandidateQualityGate({
        deps: localDeps,
        candidate: candidate(repairResult(undefined, () => { repairs++; })),
        goalTurn: false,
        verify: async () => verifyOutcome,
        receiptEvents,
      }));
      assert.equal(repairs, 0);
      assert.equal(localDeps.entries.length, 1);
      assert.equal(events.at(-1)?.type, 'final');
      assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
    }
  });

  it('red repairs once, re-verifies green, and accepts the replacement', async () => {
    const localDeps = deps();
    const checks = [
      outcome('failing', {
        testCommand: 'npm test',
        testRun: { outcome: 'red', output: 'FAIL a.test.ts', durationMs: 5 },
      }),
      outcome('passing', {
        testCommand: 'npm test',
        testRun: { outcome: 'green', output: 'ok', durationMs: 4 },
      }),
    ];
    let evidence = '';
    const repaired = candidate(undefined, { content: 'repaired', attempts: 2 });
    const original = candidate(repairResult(repaired, (note) => { evidence = note; }));
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: original,
      goalTurn: false,
      verify: async () => checks.shift(),
      receiptEvents,
    }));
    assert.match(evidence, /Test: npm test/);
    assert.match(evidence, /Changed paths: src\/a\.ts/);
    assert.match(evidence, /FAIL a\.test\.ts/);
    assert.equal(localDeps.entries[0]?.content, 'repaired');
    assert.equal(events.filter((event) => event.type === 'final').length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });

  it('deferFailingFinal SUPPRESSES the failing final and returns the failing GateResult (Layer B)', async () => {
    const localDeps = deps();
    const red = outcome('failing', {
      testCommand: 'npm test',
      testRun: { outcome: 'red', output: 'FAIL a.test.ts', durationMs: 5 },
    });
    // repair returns undefined → the candidate stays failing after the bounded repair.
    const original = candidate(repairResult(undefined, () => {}));
    const { events, result } = await drainWithReturn(
      runCandidateQualityGate({
        deps: localDeps,
        candidate: original,
        goalTurn: false,
        verify: async () => red,
        receiptEvents,
        deferFailingFinal: true,
      }),
    );
    assert.equal(result.classification, 'failing');
    assert.equal(
      events.some((event) => event.type === 'final'),
      false,
      'the failing final is deferred (left to the caller to escalate), not emitted',
    );
  });

  it('default (deferFailingFinal off) — the failing final IS emitted (byte-identical neutrality)', async () => {
    const localDeps = deps();
    const red = outcome('failing', {
      testCommand: 'npm test',
      testRun: { outcome: 'red', output: 'FAIL a.test.ts', durationMs: 5 },
    });
    const original = candidate(repairResult(undefined, () => {}));
    const { events, result } = await drainWithReturn(
      runCandidateQualityGate({
        deps: localDeps,
        candidate: original,
        goalTurn: false,
        verify: async () => red,
        receiptEvents,
      }),
    );
    assert.equal(result.classification, 'failing');
    const last = events.at(-1);
    assert.equal(last?.type, 'final');
    assert.equal(last?.type === 'final' && last.success, false);
  });

  it('emits evidence through an injected sink for a defined verify outcome', async () => {
    const seen: Parameters<NonNullable<OrchestrateDeps['evidenceSink']>>[0][] = [];
    const localDeps: OrchestrateDeps & { entries: SessionEntry[] } = {
      ...deps(),
      evidenceTaskId: 'task_1',
      evidenceTurnNumber: 3,
      evidenceSink: (snapshot) => { seen.push(snapshot); },
    };

    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(undefined, { availableProviders: ['claude', 'codex'] }),
      goalTurn: false,
      verify: async () => outcome('passing', {
        testCommand: 'npm test',
        testRun: { outcome: 'green', output: 'ok', durationMs: 4 },
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
      receiptEvents,
    }));

    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.taskId, 'task_1');
    assert.equal(seen[0]?.turnNumber, 3);
    assert.equal(seen[0]?.confidenceLabel, 'verified-by-tests-and-independent-review');
    assert.deepEqual(seen[0]?.conclusionsReached, ['verify:passing']);
  });

  it('keeps the turn unchanged with no evidence sink', async () => {
    const localDeps = deps();
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => outcome('passing'),
      receiptEvents,
    }));

    assert.equal(localDeps.entries.length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });

  it('persistent red blocks with no append and no memory proposal', async () => {
    const localDeps = deps();
    const red = outcome('failing', {
      testCommand: 'npm test',
      testRun: { outcome: 'red', output: 'FAIL', durationMs: 5 },
    });
    const repaired = candidate(undefined, { content: 'still red', attempts: 2 });
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(repairResult(repaired)),
      goalTurn: false,
      verify: async () => red,
      receiptEvents,
    }));
    const final = events.at(-1);
    assert.equal(localDeps.entries.length, 0);
    assert.ok(final?.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.output, 'still red');
    assert.equal(final.memoryProposal, undefined);
  });

  it('red then timeout accepts fail-soft after the single repair', async () => {
    const localDeps = deps();
    const checks = [
      outcome('failing', { testRun: { outcome: 'red', output: 'FAIL', durationMs: 5 } }),
      outcome('unverified', {
        note: 'tests timed out (npm test)',
        testRun: { outcome: 'timeout', output: '', durationMs: 50 },
      }),
    ];
    const repaired = candidate(undefined, { content: 'repaired', attempts: 2 });
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(repairResult(repaired)),
      goalTurn: false,
      verify: async () => checks.shift(),
      receiptEvents,
    }));
    assert.equal(localDeps.entries.length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });

  it('parsed critic revise repairs and repeated revise blocks', async () => {
    const localDeps = deps();
    const revise = outcome('reviewed', {
      critic: {
        vendor: 'codex',
        sameVendor: false,
        parsed: true,
        verdict: 'revise',
        notes: 'src/a.ts:1 is wrong',
      },
    });
    let evidence = '';
    const repaired = candidate(undefined, { content: 'revised', attempts: 2 });
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(repairResult(repaired, (note) => { evidence = note; })),
      goalTurn: false,
      verify: async () => revise,
      receiptEvents,
    }));
    assert.match(evidence, /Critic: src\/a\.ts:1 is wrong/);
    assert.equal(localDeps.entries.length, 0);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, false);
  });

  it('critic approve without tests remains unverified and accepts', async () => {
    const localDeps = deps();
    const reviewed = outcome('reviewed', {
      critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve', notes: '' },
    });
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => reviewed,
      receiptEvents,
    }));
    assert.equal(localDeps.entries.length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });

  it('appends only after verification and immediately before final', async () => {
    const log: string[] = [];
    const localDeps = deps(log);
    const events: CoreEvent[] = [];
    for await (const event of runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => { log.push('verify'); return outcome('passing'); },
      receiptEvents: (result) => { log.push('receipt'); return receiptEvents(result); },
    })) {
      log.push(event.type === 'final' ? 'final' : 'event');
      events.push(event);
    }
    assert.deepEqual(log, ['verify', 'receipt', 'event', 'append', 'final']);
    assert.equal(events.at(-1)?.type, 'final');
  });

  it('goal turns bypass verification and repair', async () => {
    let verifies = 0;
    let repairs = 0;
    const localDeps = deps();
    await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(repairResult(undefined, () => { repairs++; })),
      goalTurn: true,
      verify: async () => { verifies++; return outcome('failing'); },
      receiptEvents,
    }));
    assert.equal(verifies, 0);
    assert.equal(repairs, 0);
    assert.equal(localDeps.entries.length, 1);
  });

  it('bounds failure output in repair evidence', () => {
    const evidence = buildRepairEvidence(outcome('failing', {
      testRun: { outcome: 'red', output: 'x'.repeat(9_000), durationMs: 1 },
    }));
    assert.match(evidence, /truncated 1000 chars/);
    assert.ok(evidence.length < 8_300);
  });

  // --- Evidence receipt V2 tests -------------------------------------------------

  function depsWithReceipt(): OrchestrateDeps & { entries: SessionEntry[]; snapshot: ReturnType<OrchestrateDeps['receiptLedgerSnapshot']> } {
    const entries: SessionEntry[] = [];
    const snapshot: ReturnType<OrchestrateDeps['receiptLedgerSnapshot']> = () => [];
    return {
      providers: {},
      clock: {
        now: () => 1,
        isoNow: () => '1970-01-01T00:00:00.001Z',
        uuid: () => 'uuid',
        random: () => 0.5,
      },
      session: {
        id: 'session',
        async append(entry): Promise<void> {
          entries.push(entry);
        },
      },
      ledger: { async record(): Promise<void> {} },
      policy: DEFAULT_POLICY,
      cwd: '/repo',
      sandbox: 'workspace-write',
      timeoutMs: 1_000,
      evidenceReceiptV2: true,
      receiptLedgerSnapshot: snapshot,
      entries,
      snapshot,
    };
  }

  it('evidenceReceiptV2 always on attaches receipt to final', async () => {
    const localDeps = depsWithReceipt();
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => outcome('passing'),
      receiptEvents,
    }));
    const final = events.at(-1);
    assert.equal(final?.type, 'final');
    assert.equal(final?.type === 'final' && final.receipt !== undefined, true);
  });

  it('evidenceReceiptV2 on attaches verified receipt after passing verification', async () => {
    const localDeps = depsWithReceipt();
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => outcome('passing', {
        testCommand: 'npm test',
        testRun: { outcome: 'green', output: 'ok', durationMs: 1234 },
        changedPaths: ['src/a.ts', 'src/b.ts'],
      }),
      receiptEvents,
    }));
    const final = events.at(-1);
    assert.equal(final?.type, 'final');
    if (final?.type === 'final') {
      assert.ok(final.receipt !== undefined, 'receipt should be present');
      assert.equal(final.receipt!.verdict, 'verified');
      assert.deepEqual(final.receipt!.changedFiles, ['src/a.ts', 'src/b.ts']);
      assert.equal(final.receipt!.verifyVerdict, 'passing');
    }
  });

  it('evidenceReceiptV2 on marks reviewed as reviewed not verified', async () => {
    const localDeps = depsWithReceipt();
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => outcome('reviewed', {
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
      receiptEvents,
    }));
    const final = events.at(-1);
    assert.equal(final?.type, 'final');
    if (final?.type === 'final') {
      assert.equal(final.receipt?.verdict, 'reviewed');
      assert.notEqual(final.receipt?.verdict, 'verified');
    }
  });

  it('evidenceReceiptV2 on marks unverified accepted answer as unverified', async () => {
    const localDeps = depsWithReceipt();
    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => outcome('unverified', { note: 'no test command detected' }),
      receiptEvents,
    }));
    const final = events.at(-1);
    assert.equal(final?.type, 'final');
    if (final?.type === 'final') {
      assert.equal(final.receipt?.verdict, 'unverified');
      assert.equal(final.receipt?.verifyVerdict, 'unverified');
    }
  });

  it('evidenceReceiptV2 on attaches blocked receipt to verification failed final', async () => {
    const localDeps = depsWithReceipt();
    // repair returns undefined -> stays failing
    const red = outcome('failing', {
      testCommand: 'npm test',
      testRun: { outcome: 'red', output: 'FAIL', durationMs: 5 },
    });
    const original = candidate(repairResult(undefined, () => {}));
    const { events } = await drainWithReturn(
      runCandidateQualityGate({
        deps: localDeps,
        candidate: original,
        goalTurn: false,
        verify: async () => red,
        receiptEvents,
      }),
    );
    const final = events.at(-1);
    assert.equal(final?.type, 'final');
    assert.equal(final?.type === 'final' && final.success, false);
    if (final?.type === 'final') {
      assert.ok(final.receipt !== undefined, 'receipt should be present for failing final');
    }
  });

  it('appends only after verification and immediately before final (with receipt when on)', async () => {
    const log: string[] = [];
    const receiptDeps = depsWithReceipt();
    // Overwrite session with a log-tracking one
    const localDeps: OrchestrateDeps = {
      ...receiptDeps,
      session: {
        id: 'session',
        async append(): Promise<void> { log.push('append'); },
      },
    };
    const events: CoreEvent[] = [];
    for await (const event of runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => { log.push('verify'); return outcome('passing'); },
      receiptEvents: (result) => { log.push('receipt'); return receiptEvents(result); },
    })) {
      log.push(event.type === 'final' ? 'final' : 'event');
      events.push(event);
    }
    assert.deepEqual(log, ['verify', 'receipt', 'event', 'append', 'final']);
    const final = events.at(-1);
    assert.equal(final?.type, 'final');
    assert.ok(final?.type === 'final' && final.receipt !== undefined, 'final should have receipt when flag is on');
  });

  // --- P0-02b evidence tests ---

  it('fallback evidence omits unknown provenance and empty hashes', async () => {
    const seen: unknown[] = [];
    const localDeps: OrchestrateDeps & { entries: SessionEntry[] } = {
      ...deps(),
      evidenceTaskId: 'task_1',
      evidenceTurnNumber: 1,
      evidenceSink: (snapshot) => { seen.push(snapshot); },
    };

    await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(undefined, { availableProviders: ['claude'] }),
      goalTurn: false,
      verify: async () => outcome('passing', {
        changedPaths: ['src/a.ts'],
      }),
      receiptEvents,
    }));

    assert.equal(seen.length, 1);
    const snapshot = seen[0] as Record<string, unknown>;
    assert.equal(snapshot?.version, 2);
    assert.equal('providersAttempted' in (snapshot ?? {}), false);
    assert.equal('providersFailed' in (snapshot ?? {}), false);
    assert.equal('filesReadPre' in (snapshot ?? {}), false);
    const filesWritten = snapshot?.filesWritten as Array<Record<string, unknown>>;
    assert.equal(filesWritten.length, 1);
    assert.equal(filesWritten[0]?.path, 'src/a.ts');
    assert.equal('hashBefore' in (filesWritten[0] ?? {}), false);
    assert.equal('hashAfter' in (filesWritten[0] ?? {}), false);
  });

  it('evidence builder throw remains fail-soft', async () => {
    const localDeps: OrchestrateDeps & { entries: SessionEntry[] } = {
      ...deps(),
      evidenceTaskId: 'task_1',
      evidenceTurnNumber: 1,
      evidenceSnapshotBuilder: () => { throw new Error('boom'); },
      evidenceSink: () => {},
    };

    const events = await collect(runCandidateQualityGate({
      deps: localDeps,
      candidate: candidate(),
      goalTurn: false,
      verify: async () => outcome('passing'),
      receiptEvents,
    }));

    assert.equal(localDeps.entries.length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });
});
