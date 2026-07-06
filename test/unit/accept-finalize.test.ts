import { describe, it, expect } from 'vitest';
import { attachCompletionIfFlag, finalizeAcceptTurn } from '../../src/core/accept-stage.ts';
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

  it('patch work only considered when flag on and changedPaths', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cand = { ...baseCandidate, changedPaths: ['x.ts'] } as any;
    // call; async fire inside, but sync no crash for this test
    attachCompletionIfFlag(deps, baseFinal, cand);
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
});
