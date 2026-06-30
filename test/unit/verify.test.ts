/**
 * Unit tests for the VERIFICATION CENTERPIECE (master-plan PHASE 3).
 * Run with: node --import ./test/register.mjs --test "test/unit/verify.test.ts"
 *
 * ZERO live model calls, ZERO real exec — the VerifyPort and the critic runner are
 * faked. These pin the HONESTY non-negotiables:
 *   - the four-state mapping (green⇒passing, red⇒failing, no-tests+critic⇒reviewed,
 *     nothing⇒unverified);
 *   - empty diff ⇒ no verification (unverified);
 *   - the diff-scoped review prompt contains the DIFF + TEST OUTPUT (not prose);
 *   - the single-vendor critic fallback is LABELLED same-vendor;
 *   - flag-off / unarmed ⇒ verifyStage is the byte-for-byte no-op (undefined);
 *   - fail-soft on a port crash ⇒ unverified;
 *   - the receipt NEVER reads 'passing' without green tests; 'reviewed' != 'passing'.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  stateFromTestRun,
  composeVerifiedState,
  buildVerifyReceipt,
  buildDiffReviewPrompt,
  levelWantsCritic,
  unverified,
  type VerifyPort,
  type CapturedDiff,
  type DetectedTestCommand,
  type TestRunResult,
  type VerifyOutcome,
} from '../../src/core/verify.ts';
import { defaultVerifyLevel } from '../../src/core/verify-policy.ts';
import {
  verifyStage,
  type VerifyStageContext,
  type CriticRunInput,
  type CriticRunOutput,
} from '../../src/core/work-call.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakePort(over: Partial<VerifyPort> = {}): VerifyPort {
  return {
    async captureDiff(): Promise<CapturedDiff> {
      return { files: ['a.ts'], patch: 'diff --git a/a.ts b/a.ts\n+const x = 1;' };
    },
    async detectTestCommand(): Promise<DetectedTestCommand | null> {
      return { label: 'npm test', command: 'npm', args: ['test'] };
    },
    async runTests(): Promise<TestRunResult> {
      return { outcome: 'green', output: 'ok 4 tests', durationMs: 4600 };
    },
    ...over,
  };
}

const greenRun = (): TestRunResult => ({ outcome: 'green', output: 'all pass', durationMs: 4600 });
const redRun = (): TestRunResult => ({ outcome: 'red', output: '1 failing: auth.test.ts', durationMs: 1200 });

// ---------------------------------------------------------------------------
// stateFromTestRun — the load-bearing honesty boundary
// ---------------------------------------------------------------------------

describe('stateFromTestRun — only real green/red maps to passing/failing', () => {
  it('green ⇒ passing', () => {
    assert.equal(stateFromTestRun({ outcome: 'green', output: '', durationMs: 1 }), 'passing');
  });
  it('red ⇒ failing', () => {
    assert.equal(stateFromTestRun({ outcome: 'red', output: '', durationMs: 1 }), 'failing');
  });
  it('timeout ⇒ unverified (NEVER a fabricated pass)', () => {
    assert.equal(stateFromTestRun({ outcome: 'timeout', output: '', durationMs: 1 }), 'unverified');
  });
  it('errored ⇒ unverified (NEVER a fabricated pass)', () => {
    assert.equal(stateFromTestRun({ outcome: 'errored', output: '', durationMs: 1 }), 'unverified');
  });
});

// ---------------------------------------------------------------------------
// composeVerifiedState — tests own pass/fail; critic-only ⇒ reviewed
// ---------------------------------------------------------------------------

describe('composeVerifiedState — the four-state composition', () => {
  it('green tests own the state ⇒ passing (even with a critic)', () => {
    assert.equal(composeVerifiedState('passing', true), 'passing');
    assert.equal(composeVerifiedState('passing', false), 'passing');
  });
  it('red tests own the state ⇒ failing (even with a critic)', () => {
    assert.equal(composeVerifiedState('failing', true), 'failing');
  });
  it('no tests + a critic ⇒ reviewed (NOT passing)', () => {
    assert.equal(composeVerifiedState(undefined, true), 'reviewed');
  });
  it('no tests + no critic ⇒ unverified', () => {
    assert.equal(composeVerifiedState(undefined, false), 'unverified');
  });
});

// ---------------------------------------------------------------------------
// buildVerifyReceipt — pinned honesty strings
// ---------------------------------------------------------------------------

describe('buildVerifyReceipt — never overclaims', () => {
  it('passing reads "tests passing" with command + timing', () => {
    const r = buildVerifyReceipt({
      verified: 'passing',
      changedFiles: 1,
      testCommand: 'npm test',
      testRun: greenRun(),
    });
    assert.match(r, /tests passing/);
    assert.match(r, /npm test/);
    assert.match(r, /4600ms/);
    assert.doesNotMatch(r, /reviewed/);
  });

  it('passing + cross-vendor critic shows the cross-check', () => {
    const r = buildVerifyReceipt({
      verified: 'passing',
      changedFiles: 1,
      testCommand: 'npm test',
      testRun: greenRun(),
      critic: { vendor: 'codex', sameVendor: false },
    });
    assert.match(r, /tests passing/);
    assert.match(r, /cross-checked by codex/);
  });

  it('failing reads "tests failing" honestly (even with a critic)', () => {
    const r = buildVerifyReceipt({
      verified: 'failing',
      changedFiles: 1,
      testCommand: 'npm test',
      testRun: redRun(),
      critic: { vendor: 'codex', sameVendor: false },
    });
    assert.match(r, /tests failing/);
    assert.doesNotMatch(r, /passing/);
  });

  it('reviewed NEVER reads as passing — labels it a weak signal', () => {
    const r = buildVerifyReceipt({
      verified: 'reviewed',
      changedFiles: 2,
      critic: { vendor: 'codex', sameVendor: false },
    });
    assert.match(r, /reviewed by codex/);
    assert.match(r, /weak signal/);
    assert.doesNotMatch(r, /passing/);
  });

  it('reviewed same-vendor is labelled self-check (no faked cross-vendor)', () => {
    const r = buildVerifyReceipt({
      verified: 'reviewed',
      changedFiles: 2,
      critic: { vendor: 'claude', sameVendor: true },
    });
    assert.match(r, /reviewed by claude/);
    assert.match(r, /self-check/);
  });

  it('unverified surfaces the honest reason, never a pass', () => {
    const r = buildVerifyReceipt(unverified('no test command detected', 1));
    assert.match(r, /unverified/);
    assert.match(r, /no test command detected/);
    assert.doesNotMatch(r, /passing/);
  });
});

// ---------------------------------------------------------------------------
// buildDiffReviewPrompt — reviews REALITY (diff + test output), not prose
// ---------------------------------------------------------------------------

describe('buildDiffReviewPrompt — diff-scoped, not prose-scoped', () => {
  it('contains the DIFF and the TEST OUTPUT, and the verdict envelope', () => {
    const prompt = buildDiffReviewPrompt({
      task: 'add a logout button',
      diff: 'diff --git a/ui.ts b/ui.ts\n+ export const Logout = () => {}',
      testOutput: 'FAIL ui.test.ts: Logout is not wired',
      testOutcome: 'red',
    });
    assert.match(prompt, /THE DIFF UNDER REVIEW/);
    assert.match(prompt, /export const Logout/);
    assert.match(prompt, /Logout is not wired/);
    assert.match(prompt, /tests ALREADY RAN/i);
    assert.match(prompt, /"verdict": "approve\|revise\|escalate"/);
  });

  it('without test output, says the critic is the primary signal', () => {
    const prompt = buildDiffReviewPrompt({
      task: 'add a logout button',
      diff: '+ const Logout = () => {}',
    });
    assert.match(prompt, /NO automated tests ran/);
    assert.match(prompt, /primary signal/);
  });
});

// ---------------------------------------------------------------------------
// verifyStage — flag-off / unarmed neutrality (the no-op contract)
// ---------------------------------------------------------------------------

describe('verifyStage — unarmed is the byte-for-byte no-op (undefined)', () => {
  it('no port ⇒ undefined (the Phase-1 reserved-slot behaviour)', async () => {
    const ctx: VerifyStageContext = { output: 'done', provider: 'claude', tier: 'ic' };
    assert.equal(await verifyStage(ctx), undefined);
  });
  it('level "none" ⇒ undefined even with a port', async () => {
    const ctx: VerifyStageContext = {
      output: 'done',
      provider: 'claude',
      tier: 'ic',
      port: fakePort(),
      level: 'none',
      cwd: '/repo',
    };
    assert.equal(await verifyStage(ctx), undefined);
  });
  it('no cwd ⇒ undefined', async () => {
    const ctx: VerifyStageContext = {
      output: 'done',
      provider: 'claude',
      tier: 'ic',
      port: fakePort(),
      level: 'tests',
    };
    assert.equal(await verifyStage(ctx), undefined);
  });
});

// ---------------------------------------------------------------------------
// verifyStage — the graduated ladder, end to end (faked port)
// ---------------------------------------------------------------------------

function armedCtx(over: Partial<VerifyStageContext> = {}): VerifyStageContext {
  return {
    output: 'done',
    provider: 'claude',
    tier: 'ic',
    port: fakePort(),
    level: 'tests',
    task: 'add a feature',
    cwd: '/repo',
    available: ['claude'],
    ...over,
  };
}

describe('verifyStage — change-capture + tests-first mapping', () => {
  it('empty diff ⇒ unverified, NO verification (no-diff⇒no-verify)', async () => {
    const ctx = armedCtx({
      port: fakePort({ async captureDiff(): Promise<CapturedDiff> { return { files: [], patch: '' }; } }),
    });
    const out = await verifyStage(ctx);
    assert.equal(out?.verified, 'unverified');
    assert.equal(out?.changedFiles, 0);
  });

  it('green tests ⇒ passing', async () => {
    const out = await verifyStage(armedCtx());
    assert.equal(out?.verified, 'passing');
    assert.equal(out?.testCommand, 'npm test');
  });

  it('red tests ⇒ failing (the failing output is surfaced honestly)', async () => {
    const out = await verifyStage(
      armedCtx({ port: fakePort({ async runTests(): Promise<TestRunResult> { return redRun(); } }) }),
    );
    assert.equal(out?.verified, 'failing');
    assert.match(out?.testRun?.output ?? '', /failing/);
  });

  it('no test command ⇒ unverified with the honest reason (never fabricated)', async () => {
    const out = await verifyStage(
      armedCtx({ port: fakePort({ async detectTestCommand(): Promise<DetectedTestCommand | null> { return null; } }) }),
    );
    assert.equal(out?.verified, 'unverified');
    assert.match(out?.note ?? '', /no test command detected/);
  });

  it('tests timed out ⇒ unverified (never a pass)', async () => {
    const out = await verifyStage(
      armedCtx({
        port: fakePort({
          async runTests(): Promise<TestRunResult> {
            return { outcome: 'timeout', output: '', durationMs: 99999 };
          },
        }),
      }),
    );
    assert.equal(out?.verified, 'unverified');
    assert.match(out?.note ?? '', /timed out/);
  });
});

// ---------------------------------------------------------------------------
// verifyStage — the diff-scoped critic (tests+critic / reviewed)
// ---------------------------------------------------------------------------

describe('verifyStage — diff-scoped critic, gated + labelled', () => {
  it('tests+critic with green tests ⇒ passing, critic cross-checks (different vendor)', async () => {
    let seenPrompt = '';
    const runCritic = async (input: CriticRunInput): Promise<CriticRunOutput> => {
      seenPrompt = input.prompt;
      assert.equal(input.reviewer, 'codex', 'cross-vendor reviewer preferred');
      return { ran: true };
    };
    const out = await verifyStage(
      armedCtx({ level: 'tests+critic', available: ['claude', 'codex'], runCritic }),
    );
    assert.equal(out?.verified, 'passing'); // tests own the state
    assert.equal(out?.critic?.vendor, 'codex');
    assert.equal(out?.critic?.sameVendor, false);
    // The critic prompt reviewed the DIFF + the TEST OUTPUT, not prose.
    assert.match(seenPrompt, /THE DIFF UNDER REVIEW/);
    assert.match(seenPrompt, /const x = 1/);
  });

  it('no tests + a critic ⇒ reviewed (NOT passing)', async () => {
    const runCritic = async (): Promise<CriticRunOutput> => ({ ran: true });
    const out = await verifyStage(
      armedCtx({
        level: 'reviewed',
        available: ['claude', 'codex'],
        runCritic,
        port: fakePort({ async detectTestCommand(): Promise<DetectedTestCommand | null> { return null; } }),
      }),
    );
    assert.equal(out?.verified, 'reviewed');
    assert.equal(out?.critic?.sameVendor, false);
  });

  it('single-vendor critic falls back to the SAME vendor, LABELLED', async () => {
    const runCritic = async (input: CriticRunInput): Promise<CriticRunOutput> => {
      assert.equal(input.reviewer, 'claude', 'only one vendor ⇒ same-vendor critic');
      return { ran: true };
    };
    const out = await verifyStage(
      armedCtx({
        level: 'reviewed',
        available: ['claude'],
        runCritic,
        port: fakePort({ async detectTestCommand(): Promise<DetectedTestCommand | null> { return null; } }),
      }),
    );
    assert.equal(out?.verified, 'reviewed');
    assert.equal(out?.critic?.vendor, 'claude');
    assert.equal(out?.critic?.sameVendor, true, 'same-vendor fallback is labelled honestly');
  });

  it('a critic that did NOT produce a verdict ⇒ NOT counted (never faked reviewed)', async () => {
    const runCritic = async (): Promise<CriticRunOutput> => ({ ran: false });
    const out = await verifyStage(
      armedCtx({
        level: 'reviewed',
        available: ['claude', 'codex'],
        runCritic,
        port: fakePort({ async detectTestCommand(): Promise<DetectedTestCommand | null> { return null; } }),
      }),
    );
    // No tests, critic didn't really run ⇒ unverified, not a fake reviewed.
    assert.equal(out?.verified, 'unverified');
    assert.equal(out?.critic, undefined);
  });
});

// ---------------------------------------------------------------------------
// verifyStage — fail-soft (a port crash ⇒ unverified, never breaks the turn)
// ---------------------------------------------------------------------------

describe('verifyStage — fail-soft on a crash', () => {
  it('a throwing captureDiff degrades to unverified (turn unbroken)', async () => {
    const out = await verifyStage(
      armedCtx({
        port: fakePort({ async captureDiff(): Promise<CapturedDiff> { throw new Error('git exploded'); } }),
      }),
    );
    // captureDiff's own .catch yields an empty diff ⇒ no-diff⇒unverified.
    assert.equal(out?.verified, 'unverified');
  });

  it('a throwing runTests degrades to unverified, NOT a fabricated pass', async () => {
    const out = await verifyStage(
      armedCtx({
        port: fakePort({ async runTests(): Promise<TestRunResult> { throw new Error('boom'); } }),
      }),
    );
    assert.equal(out?.verified, 'unverified');
    assert.doesNotMatch(buildVerifyReceipt(out as VerifyOutcome), /passing/);
  });
});

// ---------------------------------------------------------------------------
// defaultVerifyLevel — the conservative built-in (Governor OFF)
// ---------------------------------------------------------------------------

describe('defaultVerifyLevel — conservative built-in policy', () => {
  it('no change ⇒ none', () => {
    assert.equal(defaultVerifyLevel({ highStakes: false, changedFiles: 0, authedProviderCount: 2 }), 'none');
  });
  it('a small low-stakes change ⇒ tests-first only (NEVER a critic on trivial)', () => {
    assert.equal(defaultVerifyLevel({ highStakes: false, changedFiles: 1, authedProviderCount: 2 }), 'tests');
  });
  it('a large diff + 2 vendors ⇒ tests+critic', () => {
    assert.equal(defaultVerifyLevel({ highStakes: false, changedFiles: 8, authedProviderCount: 2 }), 'tests+critic');
  });
  it('high stakes but single-vendor ⇒ tests-only (no faked cross-vendor critic)', () => {
    assert.equal(defaultVerifyLevel({ highStakes: true, changedFiles: 8, authedProviderCount: 1 }), 'tests');
  });
});

// ---------------------------------------------------------------------------
// levelWantsCritic — the gate
// ---------------------------------------------------------------------------

describe('levelWantsCritic', () => {
  it('tests+critic and reviewed want a critic; none and tests do not', () => {
    assert.equal(levelWantsCritic('tests+critic'), true);
    assert.equal(levelWantsCritic('reviewed'), true);
    assert.equal(levelWantsCritic('tests'), false);
    assert.equal(levelWantsCritic('none'), false);
  });
});
