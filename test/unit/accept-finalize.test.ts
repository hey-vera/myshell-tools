import { describe, it, expect } from 'vitest';
import { attachCompletionIfFlag, finalizeAcceptTurn } from '../../src/core/accept-stage.ts';
import type { OrchestrateDeps, CandidateResult } from '../../src/core/types.ts';

describe('accept-finalize (pure contract per strategy)', () => {
  const baseFinal = { type: 'final', success: true, output: 'ok' } as any;
  const baseCandidate = { task: 'test', content: 'ok', changedPaths: ['a.ts'] } as any as CandidateResult;

  it('completionResultV1 false/undefined -> final unchanged, no completionResult key', () => {
    const deps = { completionResultV1: false } as any as OrchestrateDeps;
    const result = attachCompletionIfFlag(deps, baseFinal, baseCandidate);
    expect(result).toEqual(baseFinal);
    expect('completionResult' in result).toBe(false);
  });

  it('completionResultV1 === true -> has completionResult attached', () => {
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    const result = attachCompletionIfFlag(deps, baseFinal, baseCandidate);
    expect(result).not.toEqual(baseFinal);
    expect('completionResult' in result).toBe(true);
  });

  it('patch work only considered when flag on and changedPaths', () => {
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    const cand = { ...baseCandidate, changedPaths: ['x.ts'] } as any;
    // call; async fire inside, but sync no crash for this test
    attachCompletionIfFlag(deps, baseFinal, cand);
  });

  it('finalizeAcceptTurn pure: flag false returns unchanged final', () => {
    const deps = { completionResultV1: false } as any as OrchestrateDeps;
    const res = finalizeAcceptTurn({ deps, final: baseFinal, candidate: baseCandidate });
    expect(res.final).toEqual(baseFinal);
    expect(res.patchWork).toBeUndefined();
  });

  it('finalizeAcceptTurn pure: flag true returns final with completionResult and patchWork', () => {
    const deps = { completionResultV1: true, clock: { isoNow: () => new Date().toISOString() }, session: { id: 's1' } } as any as OrchestrateDeps;
    const res = finalizeAcceptTurn({ deps, final: baseFinal, candidate: baseCandidate });
    expect('completionResult' in res.final).toBe(true);
    expect(res.patchWork).toBeDefined();
  });
});
