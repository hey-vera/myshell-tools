import { describe, it, expect } from 'vitest';
import { attachCompletionIfFlag, attachTerminalCompletionIfFlag, finalizeAcceptTurn } from '../../src/core/accept-stage.ts';
import type { OrchestrateDeps, CandidateResult, CompletionResultVersion } from '../../src/core/types.ts';
import { reconstructUsingCompletionMapSnapshot } from '../../src/core/history.ts';
// reference for knip (dark spine symbols used in feature tests)
void (1 as CompletionResultVersion);
void reconstructUsingCompletionMapSnapshot;

describe('accept-finalize (pure contract per strategy)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseFinal = { type: 'final', success: true, output: 'ok' } as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseCandidate = { task: 'test', content: 'ok', changedPaths: ['a.ts'] } as any as CandidateResult;

  it('completionResultV1 false/undefined -> final unchanged, no completionResult key', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: false } as any as OrchestrateDeps;
    const result = attachCompletionIfFlag(deps, baseFinal, baseCandidate);
    expect(result).toEqual(baseFinal);
    expect('completionResult' in result).toBe(false);
  });

  it('completionResultV1 === true -> has completionResult attached', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    const result = attachCompletionIfFlag(deps, baseFinal, baseCandidate);
    expect(result).not.toEqual(baseFinal);
    expect('completionResult' in result).toBe(true);
  });

  it('attachCompletionIfFlag stays synchronous even when finalizeAcceptTurn yields patchWork', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cand = { ...baseCandidate, changedPaths: ['x.ts'] } as any;
    // attachCompletionIfFlag should only attach completion metadata here.
    attachCompletionIfFlag(deps, baseFinal, cand);
  });


  it('terminal needs-user CompletionResult preserves legacy final while marking goal unsettled', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: true, clock: { isoNow: () => '2026-07-06T00:00:00.000Z' }, session: { id: 's1' } } as any as OrchestrateDeps;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyQuestionFinal = { type: 'final', success: true, output: '', attempts: 0 } as any;
    const result = attachTerminalCompletionIfFlag({
      deps,
      final: legacyQuestionFinal,
      task: 'pick a strategy',
      terminal: 'needs-user',
    });
    expect(result.success).toBe(true);
    expect(result.completionResult?.terminal).toBe('needs-user');
    expect(result.completionResult?.success).toBe(false);
    expect(result.completionResult?.goalSettlement.state).toBe('needs-user');
    expect(result.completionResult?.replayPolicy.replay).toBe('needs-user');
    expect(result.completionResult?.verification.obligationsUnmet).toEqual(['waiting for user answer']);
  });
  it('finalizeAcceptTurn pure: flag false returns unchanged final', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: false } as any as OrchestrateDeps;
    const res = finalizeAcceptTurn({ deps, final: baseFinal, candidate: baseCandidate });
    expect(res.final).toEqual(baseFinal);
    expect(res.patchWork).toBeUndefined();
  });

  it('finalizeAcceptTurn pure: flag true returns final with completionResult and patchWork', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    const res = finalizeAcceptTurn({ deps, final: baseFinal, candidate: baseCandidate });
    expect('completionResult' in res.final).toBe(true);
    expect(res.patchWork).toBeDefined();
  });

  it('doneCondition binds from deps.completionDoneCondition when present', () => {
    const deps = {
      completionResultV1: true,
      completionDoneCondition: 'acceptance tests pass',
      clock: { isoNow: () => '2026-07-09T00:00:00.000Z' },
      session: { id: 's1' },
    } as unknown as OrchestrateDeps;
    const res = finalizeAcceptTurn({ deps, final: baseFinal, candidate: baseCandidate });
    expect(res.final.completionResult?.doneCondition).toBe('acceptance tests pass');
    // Without verify, settlement is denied (done=check).
    expect(res.final.completionResult?.goalSettlement.allowed).toBe(false);
  });
});

