/**
 * PR-D: done=check binding — pure helpers + CompletionResultV1 settle honesty.
 * Model confidence / "looks good" must never promote goal settlement or terminal done.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCompletionResultV1,
  buildTerminalCompletionResultV1,
  buildGoalSettlement,
  resolveDoneConditionText,
  resolveCompletionTerminal,
  verificationStatusFromOutcome,
  terminalEarnedFromVerify,
  DONE_CONDITION_LIMIT,
} from '../../src/core/accept-stage.ts';
import type { OrchestrateDeps, CandidateResult } from '../../src/core/types.ts';
import type { VerifyOutcome } from '../../src/core/verify.ts';

function deps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: {},
    clock: {
      now: () => 1,
      isoNow: () => '2026-07-09T00:00:00.000Z',
      uuid: () => 'uuid',
      random: () => 0.5,
    },
    session: { id: 'sess-done-check', async append() {} },
    ledger: { async record() {} },
    policy: { maxAttempts: 3 } as OrchestrateDeps['policy'],
    cwd: '/repo',
    sandbox: 'workspace-write',
    timeoutMs: 1_000,
    completionResultV1: true,
    ...over,
  };
}

function candidate(over: Partial<CandidateResult> = {}): CandidateResult {
  return {
    content: 'looks good to me',
    tier: 'ic',
    provider: 'claude',
    model: 'model',
    confidence: 0.99,
    costUsd: 0,
    durationMs: 1,
    totalCostUsd: 0,
    attempts: 1,
    disposition: 'clean',
    task: 'ship the feature',
    cwd: '/repo',
    verifyLevel: 'tests',
    availableProviders: ['claude'],
    repair: async function* (evidence) {
      if (evidence.length < 0) yield { type: 'notice', level: 'info', message: evidence };
      return undefined;
    },
    ...over,
  };
}

function outcome(
  verified: VerifyOutcome['verified'],
  over: Partial<VerifyOutcome> = {},
): VerifyOutcome {
  return { verified, changedFiles: 1, changedPaths: ['src/a.ts'], ...over };
}

describe('resolveDoneConditionText', () => {
  it('binds specified semantic doneCondition text', () => {
    expect(
      resolveDoneConditionText({
        semanticDone: { status: 'specified', text: 'tests green and UI toggles' },
      }),
    ).toBe('tests green and UI toggles');
  });

  it('returns null for unknown semantic doneCondition (no invent)', () => {
    expect(
      resolveDoneConditionText({
        semanticDone: { status: 'unknown', reason: 'not-inferable' },
      }),
    ).toBeNull();
  });

  it('falls through to doneWhen when semantic is unknown', () => {
    expect(
      resolveDoneConditionText({
        semanticDone: { status: 'unknown', reason: 'semantic-preflight-unavailable' },
        doneWhen: 'legacy done when',
      }),
    ).toBe('legacy done when');
  });

  it('prefers semantic specified over doneWhen', () => {
    expect(
      resolveDoneConditionText({
        semanticDone: { status: 'specified', text: 'from semantic' },
        doneWhen: 'from intent',
      }),
    ).toBe('from semantic');
  });

  it('returns null for blank / absent', () => {
    expect(resolveDoneConditionText({})).toBeNull();
    expect(resolveDoneConditionText({ text: '   ' })).toBeNull();
    expect(resolveDoneConditionText({ semanticDone: { status: 'specified', text: '' } })).toBeNull();
  });

  it('caps at DONE_CONDITION_LIMIT', () => {
    const long = 'x'.repeat(DONE_CONDITION_LIMIT + 40);
    const got = resolveDoneConditionText({ text: long });
    expect(got).not.toBeNull();
    expect(got!.length).toBe(DONE_CONDITION_LIMIT);
  });
});

describe('done=check settle helpers', () => {
  it('verificationStatusFromOutcome never upgrades reviewed/unverified to verified', () => {
    expect(verificationStatusFromOutcome(outcome('passing'))).toBe('verified');
    expect(verificationStatusFromOutcome(outcome('failing'))).toBe('failing');
    expect(
      verificationStatusFromOutcome(
        outcome('reviewed', {
          critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
        }),
      ),
    ).toBe('reviewed');
    expect(verificationStatusFromOutcome(outcome('unverified'))).toBe('unverified');
    expect(verificationStatusFromOutcome(undefined)).toBe('unverified');
  });

  it('terminalEarnedFromVerify promotes done ONLY on passing', () => {
    expect(terminalEarnedFromVerify(outcome('passing'))).toBe('done');
    expect(terminalEarnedFromVerify(outcome('failing'))).toBe('failed');
    expect(terminalEarnedFromVerify(outcome('reviewed'))).toBe('answered');
    expect(terminalEarnedFromVerify(outcome('unverified'))).toBe('answered');
    expect(terminalEarnedFromVerify(undefined)).toBe('answered');
  });

  it('resolveCompletionTerminal refuses unearned done override (looks-good promotion)', () => {
    // High-confidence model claim without green tests cannot force terminal done.
    expect(
      resolveCompletionTerminal({
        terminalOverride: 'done',
        verifyOutcome: outcome('unverified', { note: 'looks good' }),
      }),
    ).toBe('answered');
    expect(
      resolveCompletionTerminal({
        terminalOverride: 'done',
        // no verifyOutcome
      }),
    ).toBe('answered');
    expect(
      resolveCompletionTerminal({
        terminalOverride: 'done',
        verifyOutcome: outcome('passing'),
      }),
    ).toBe('done');
  });

  it('buildGoalSettlement.allowed is false without verify truth', () => {
    expect(
      buildGoalSettlement({ terminal: 'done', verificationStatus: 'unverified' }).allowed,
    ).toBe(false);
    expect(
      buildGoalSettlement({ terminal: 'done', verificationStatus: 'unverified' }).reason,
    ).toBe('done-requires-check');
    expect(
      buildGoalSettlement({ terminal: 'answered', verificationStatus: 'unverified' }).allowed,
    ).toBe(false);
    expect(
      buildGoalSettlement({ terminal: 'done', verificationStatus: 'failing' }).allowed,
    ).toBe(false);
  });

  it('buildGoalSettlement.allowed is true only for done + verified/reviewed without conflicts', () => {
    expect(
      buildGoalSettlement({ terminal: 'done', verificationStatus: 'verified' }).allowed,
    ).toBe(true);
    expect(
      buildGoalSettlement({ terminal: 'done', verificationStatus: 'reviewed' }).allowed,
    ).toBe(true);
    expect(
      buildGoalSettlement({
        terminal: 'done',
        verificationStatus: 'verified',
        conflictPaths: ['src/a.ts'],
      }).allowed,
    ).toBe(false);
  });
});

describe('buildCompletionResultV1 done=check binding', () => {
  it('fills doneCondition from deps.completionDoneCondition', () => {
    const cr = buildCompletionResultV1({
      deps: deps({ completionDoneCondition: 'npm test green' }),
      candidate: candidate(),
      verifyOutcome: outcome('passing'),
    });
    expect(cr.doneCondition).toBe('npm test green');
    expect(cr.upstream.semanticPreflightVersion).toBe(1);
  });

  it('fills doneCondition from semanticDone param', () => {
    const cr = buildCompletionResultV1({
      deps: deps(),
      candidate: candidate(),
      verifyOutcome: outcome('passing'),
      semanticDone: { status: 'specified', text: 'dark mode works' },
    });
    expect(cr.doneCondition).toBe('dark mode works');
  });

  it('keeps doneCondition null when preflight absent (no invent)', () => {
    const cr = buildCompletionResultV1({
      deps: deps(),
      candidate: candidate(),
      verifyOutcome: outcome('passing'),
    });
    expect(cr.doneCondition).toBeNull();
  });

  it('goalSettlement.allowed false when unverified even if confidence is high', () => {
    const cr = buildCompletionResultV1({
      deps: deps({ completionDoneCondition: 'feature shipped' }),
      candidate: candidate({ confidence: 0.99, content: 'Looks good — all done!' }),
      verifyOutcome: outcome('unverified', { note: 'no test command detected' }),
    });
    expect(cr.terminal).toBe('answered');
    expect(cr.goalSettlement.allowed).toBe(false);
    expect(cr.verification.status).toBe('unverified');
    expect(cr.replayPolicy.replay).toBe('repair-only');
  });

  it('goalSettlement.allowed true only when tests verify done', () => {
    const cr = buildCompletionResultV1({
      deps: deps({ completionDoneCondition: 'tests pass' }),
      candidate: candidate(),
      verifyOutcome: outcome('passing', {
        testCommand: 'npm test',
        testRun: { outcome: 'green', output: 'ok', durationMs: 10 },
      }),
    });
    expect(cr.terminal).toBe('done');
    expect(cr.verification.status).toBe('verified');
    expect(cr.goalSettlement.allowed).toBe(true);
    expect(cr.goalSettlement.state).toBe('done');
    expect(cr.goalSettlement.reason).toBe('verified');
    expect(cr.replayPolicy.replay).toBe('forbidden-already-settled');
  });

  it('refuses terminalOverride done without passing verify (looks-good hole closed)', () => {
    const cr = buildCompletionResultV1({
      deps: deps(),
      candidate: candidate({ confidence: 1 }),
      verifyOutcome: outcome('unverified'),
      terminalOverride: 'done',
    });
    expect(cr.terminal).not.toBe('done');
    expect(cr.goalSettlement.allowed).toBe(false);
    expect(cr.goalSettlement.reason).not.toBe('verified');
  });

  it('critic approve alone is reviewed, not settle-done (no tests)', () => {
    const cr = buildCompletionResultV1({
      deps: deps(),
      candidate: candidate(),
      verifyOutcome: outcome('reviewed', {
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
    });
    // Without green tests, terminal is answered — reviewed is not test-verified done.
    expect(cr.terminal).toBe('answered');
    expect(cr.verification.status).toBe('reviewed');
    expect(cr.goalSettlement.allowed).toBe(false);
  });
});

describe('buildTerminalCompletionResultV1 done=check', () => {
  it('demotes terminal done without verify and forbids settlement', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const final = { type: 'final', success: true, output: 'ok', attempts: 0 } as any;
    const cr = buildTerminalCompletionResultV1({
      deps: deps({ completionDoneCondition: 'user said done' }),
      final,
      task: 'finish up',
      terminal: 'done',
    });
    expect(cr.terminal).toBe('answered');
    expect(cr.goalSettlement.allowed).toBe(false);
    expect(cr.goalSettlement.reason).toBe('done-requires-check');
    expect(cr.doneCondition).toBe('user said done');
  });

  it('needs-user still unsettled', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const final = { type: 'final', success: true, output: '', attempts: 0 } as any;
    const cr = buildTerminalCompletionResultV1({
      deps: deps(),
      final,
      task: 'pick a strategy',
      terminal: 'needs-user',
    });
    expect(cr.terminal).toBe('needs-user');
    expect(cr.goalSettlement.allowed).toBe(false);
    expect(cr.goalSettlement.state).toBe('needs-user');
  });
});
