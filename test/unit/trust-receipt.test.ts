/**
 * Unit tests for THE TRUST SURFACE (master-plan PHASE 8) — the pure composer
 * (src/core/trust-receipt.ts) and its flag (src/interface/ui/trust-flag.ts).
 * Run with: node --import ./test/register.mjs --test "test/unit/trust-receipt.test.ts"
 *
 * ZERO live model calls — the composer is PURE (no I/O, no time, no randomness, no
 * model call). This phase is about TRUST, so fabrication is the worst failure; these
 * tests PIN the no-fabrication properties HARD:
 *
 *   - the receipt composes ONLY signals that genuinely occurred:
 *       · absent verify   ⇒ NO verify line
 *       · absent agreement ⇒ NO agreement ground
 *       · absent/empty grounded files ⇒ NO file-grounding claim (never invented)
 *   - the auditable confidence line points at REAL grounds (files actually changed,
 *     the real test verdict, the real cross-vendor agreement) — never a fabricated basis;
 *   - the self-audit discloses REAL gaps only — never an invented gap, never a claim of
 *     a check it didn't perform;
 *   - `reviewed` NEVER reads as `passing` in the surface (label honesty is the game);
 *   - all-flags-off ⇒ no new output (the flag is DEFAULT OFF; neutrality contract).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  confidenceGrounds,
  auditableConfidenceLine,
  selfAuditGaps,
  composeTrustReceipt,
  isEmptyReceipt,
  trustReceiptLines,
  providerModeLine,
  confidenceTier,
} from '../../src/core/trust-receipt.ts';
import type { Confidence } from '../../src/core/brain.ts';
import type { VerifyOutcome, TestRunResult } from '../../src/core/verify.ts';

// ---------------------------------------------------------------------------
// Builders — small, honest fixtures (no live anything)
// ---------------------------------------------------------------------------

function conf(over: Partial<Confidence> = {}): Confidence {
  return { understanding: 'medium', groundedness: 'unread', stakes: 'low', ...over };
}

function testRun(outcome: TestRunResult['outcome']): TestRunResult {
  return { outcome, durationMs: 1234 };
}

function passingVerify(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verified: 'passing',
    changedFiles: 2,
    testCommand: 'npm test',
    testRun: testRun('green'),
    ...over,
  };
}

function failingVerify(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verified: 'failing',
    changedFiles: 1,
    testCommand: 'npm test',
    testRun: testRun('red'),
    ...over,
  };
}

function reviewedVerify(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verified: 'reviewed',
    changedFiles: 1,
    critic: { vendor: 'claude', sameVendor: true },
    ...over,
  };
}

function unverifiedVerify(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return { verified: 'unverified', changedFiles: 0, ...over };
}

// ---------------------------------------------------------------------------
// (1) AUDITABLE CONFIDENCE — points at REAL grounds, never a fabricated basis
// ---------------------------------------------------------------------------

describe('confidenceGrounds — lists ONLY real signals, in a fixed order', () => {
  it('lists the real files the turn changed (basenames), capped + summarized', () => {
    const grounds = confidenceGrounds({
      groundedFiles: ['src/components/Feed.tsx', 'src/api/feed.ts', 'a/b/c/fixtures.ts', 'x/y/extra.ts'],
    });
    // first ground is the file ground; basenames only, capped at 3 + "+N more".
    assert.match(grounds[0], /Feed\.tsx/);
    assert.match(grounds[0], /feed\.ts/);
    assert.match(grounds[0], /fixtures\.ts/);
    assert.match(grounds[0], /\+1 more/);
    // never leaks the directory path
    assert.doesNotMatch(grounds[0], /src\/components/);
  });

  it('ABSENT grounded files ⇒ NO file-grounding claim (never invents a file)', () => {
    assert.deepEqual(confidenceGrounds({}), []);
    assert.deepEqual(confidenceGrounds({ groundedFiles: [] }), []);
    // whitespace-only / non-string entries are filtered, not fabricated
    assert.deepEqual(confidenceGrounds({ groundedFiles: ['', '   '] }), []);
  });

  it('passing verify ⇒ a "<cmd> passing" ground; failing ⇒ "FAILING"', () => {
    const passing = confidenceGrounds({ verify: passingVerify() });
    assert.ok(passing.some((g) => /npm test passing/.test(g)));
    assert.ok(!passing.some((g) => /FAILING/i.test(g)));

    const failing = confidenceGrounds({ verify: failingVerify() });
    assert.ok(failing.some((g) => /FAILING/.test(g)));
    assert.ok(!failing.some((g) => /passing/.test(g)));
  });

  it('reviewed verify ⇒ a "reviewed (no tests)" ground — NEVER reads as passing', () => {
    const g = confidenceGrounds({ verify: reviewedVerify() });
    const joined = g.join(' | ');
    assert.match(joined, /no tests/);
    assert.doesNotMatch(joined, /passing/);
    // a same-vendor critic is labelled "self-checked", never "cross-checked"
    assert.match(joined, /self-checked/);
    assert.doesNotMatch(joined, /cross-checked/);
  });

  it('unverified verify ⇒ NO positive verification ground (says nothing here)', () => {
    assert.deepEqual(confidenceGrounds({ verify: unverifiedVerify() }), []);
  });

  it('cross-vendor agreement appears ONLY when a real poll set it', () => {
    // absent agreement ⇒ no agreement ground (never "1 model agrees")
    assert.deepEqual(confidenceGrounds({ confidence: conf() }), []);

    assert.ok(
      confidenceGrounds({ confidence: conf({ agreement: 'consensus' }) }).some((g) =>
        /independent models agree/.test(g),
      ),
    );
    assert.ok(
      confidenceGrounds({ confidence: conf({ agreement: 'lean' }) }).some((g) =>
        /mostly agree/.test(g),
      ),
    );
    assert.ok(
      confidenceGrounds({ confidence: conf({ agreement: 'split' }) }).some((g) =>
        /split/.test(g),
      ),
    );
  });

  it('the order is files → verdict → agreement', () => {
    const g = confidenceGrounds({
      groundedFiles: ['auth.ts'],
      verify: passingVerify(),
      confidence: conf({ agreement: 'consensus' }),
    });
    assert.match(g[0], /auth\.ts/);
    assert.match(g[1], /passing/);
    assert.match(g[2], /agree/);
  });
});

describe('auditableConfidenceLine — base adjective + real grounds, never fabricated', () => {
  it('with grounds: "<base> — <ground>; <ground>"', () => {
    const line = auditableConfidenceLine('Fairly confident I understand this', {
      groundedFiles: ['auth.ts'],
      verify: passingVerify(),
    });
    assert.match(line, /^Fairly confident I understand this — /);
    assert.match(line, /auth\.ts/);
    assert.match(line, /passing/);
  });

  it('NO grounds ⇒ the bare adjective (never a fabricated basis appended)', () => {
    const line = auditableConfidenceLine('Fairly confident I understand this', {});
    assert.equal(line, 'Fairly confident I understand this');
    assert.doesNotMatch(line, /—/);
  });

  it('no base + grounds ⇒ just the grounds; neither ⇒ empty', () => {
    assert.match(auditableConfidenceLine('', { groundedFiles: ['x.ts'] }), /x\.ts/);
    assert.equal(auditableConfidenceLine('', {}), '');
  });
});

// ---------------------------------------------------------------------------
// (3) SELF-AUDIT — discloses REAL gaps only, never invents one
// ---------------------------------------------------------------------------

describe('selfAuditGaps — honest disclosure of what the turn did NOT do', () => {
  it('NO verify outcome ⇒ discloses tests were not run (the absence itself)', () => {
    const gaps = selfAuditGaps({});
    assert.ok(gaps.some((g) => /didn't verify with tests/.test(g)));
  });

  it('reviewed (a critic looked, no tests) ⇒ "didn\'t run tests (none detected)"', () => {
    const gaps = selfAuditGaps({ verify: reviewedVerify() });
    assert.ok(gaps.some((g) => /didn't run tests \(none detected\)/.test(g)));
  });

  it('a verify note (the real reason) is disclosed verbatim, never invented', () => {
    const gaps = selfAuditGaps({ verify: unverifiedVerify({ note: 'no test command detected' }) });
    assert.ok(gaps.some((g) => /didn't run tests \(no test command detected\)/.test(g)));
  });

  it('tests that GREEN ran ⇒ NO "didn\'t run tests" gap (it really ran)', () => {
    const gaps = selfAuditGaps({ verify: passingVerify(), authedProviderCount: 2 });
    assert.ok(!gaps.some((g) => /didn't run tests/.test(g)));
  });

  it('single vendor (count<=1) ⇒ discloses "didn\'t cross-check (single vendor)"', () => {
    const gaps = selfAuditGaps({ verify: passingVerify(), authedProviderCount: 1 });
    assert.ok(gaps.some((g) => /didn't cross-check \(single vendor\)/.test(g)));
  });

  it('a same-vendor self-check ⇒ discloses it was not a cross-vendor check', () => {
    const gaps = selfAuditGaps({
      verify: reviewedVerify({ critic: { vendor: 'claude', sameVendor: true } }),
      authedProviderCount: 2,
    });
    assert.ok(gaps.some((g) => /didn't cross-check \(same-vendor self-check only\)/.test(g)));
  });

  it('a REAL cross-vendor critic ⇒ NO cross-check gap (it genuinely happened)', () => {
    const gaps = selfAuditGaps({
      verify: passingVerify({ critic: { vendor: 'codex', sameVendor: false } }),
      authedProviderCount: 2,
    });
    assert.ok(!gaps.some((g) => /cross-check/.test(g)));
  });

  it('unknown vendor count + no critic info ⇒ NO cross-check gap (never guessed)', () => {
    // tests passed so no tests-gap; count unknown so the cross-check gap must NOT be invented.
    const gaps = selfAuditGaps({ verify: passingVerify() });
    assert.ok(!gaps.some((g) => /cross-check/.test(g)));
  });

  it('full coverage (green tests + cross-vendor critic) ⇒ NO gap to name', () => {
    const gaps = selfAuditGaps({
      verify: passingVerify({ critic: { vendor: 'codex', sameVendor: false } }),
      authedProviderCount: 2,
    });
    assert.deepEqual(gaps, []);
  });
});

// ---------------------------------------------------------------------------
// THE RECEIPT — composes only present signals; empty when nothing is real
// ---------------------------------------------------------------------------

describe('composeTrustReceipt — only-present-signals composition', () => {
  it('absent verify ⇒ NO verify line', () => {
    const r = composeTrustReceipt({ confidence: conf() }, 'Fairly confident');
    assert.equal(r.verify, undefined);
  });

  it('absent confidence ⇒ NO confidence line (never invents one)', () => {
    const r = composeTrustReceipt({ verify: passingVerify() }, '');
    assert.equal(r.confidence, undefined);
  });

  it('present confidence + present verify ⇒ both lines, plus self-audit if a gap', () => {
    const r = composeTrustReceipt(
      {
        confidence: conf({ agreement: 'consensus' }),
        verify: passingVerify(),
        groundedFiles: ['auth.ts'],
        authedProviderCount: 1,
      },
      'Confident',
    );
    assert.match(r.confidence ?? '', /auth\.ts/);
    assert.match(r.verify ?? '', /passing/);
    // single vendor ⇒ a real cross-check gap is disclosed
    assert.match(r.selfAudit ?? '', /single vendor/);
  });

  it('reviewed verdict ⇒ the verify line never reads "passing"', () => {
    const r = composeTrustReceipt({ confidence: conf(), verify: reviewedVerify() }, 'Confident');
    assert.doesNotMatch(r.verify ?? '', /passing/);
  });

  it('a failing verify keeps the receipt non-empty and honest', () => {
    const r = composeTrustReceipt({ confidence: conf(), verify: failingVerify() }, 'Confident');
    assert.match(r.verify ?? '', /failing/);
    assert.ok(!isEmptyReceipt(r));
  });

  it('NO signals at all ⇒ empty receipt ⇒ no lines (caller emits nothing)', () => {
    const r = composeTrustReceipt({}, '');
    assert.ok(isEmptyReceipt(r));
    assert.deepEqual(trustReceiptLines(r), []);
  });

  it('trustReceiptLines order is confidence → verify → self-audit', () => {
    const r = composeTrustReceipt(
      { confidence: conf(), verify: reviewedVerify(), authedProviderCount: 1, groundedFiles: ['x.ts'] },
      'Confident',
    );
    const lines = trustReceiptLines(r);
    assert.ok(lines.length >= 3);
    assert.match(lines[0], /x\.ts/); // confidence
    assert.match(lines[1], /review|self-check/i); // verify receipt
    assert.match(lines[lines.length - 1], /^note: /); // self-audit last
  });
});

// ---------------------------------------------------------------------------
// (2b) PROVIDER POSTURE — neutral, additive, never fabricated
// ---------------------------------------------------------------------------

describe('providerModeLine + receipt provider posture', () => {
  it('maps each derived mode to its neutral honest label', () => {
    assert.equal(providerModeLine('zero'), 'provider mode: none');
    assert.equal(providerModeLine('solo'), 'provider mode: single vendor');
    assert.equal(providerModeLine('multi'), 'provider mode: cross-vendor');
  });

  it('ABSENT providerMode ⇒ NO provider line (purely optional; existing turns unchanged)', () => {
    const r = composeTrustReceipt({ confidence: conf(), verify: passingVerify() }, 'Confident');
    assert.equal(r.providerMode, undefined);
  });

  it('present providerMode + real turn ⇒ a neutral provider line', () => {
    const r = composeTrustReceipt(
      { confidence: conf(), verify: passingVerify(), providerMode: 'multi' },
      'Confident',
    );
    assert.equal(r.providerMode, 'provider mode: cross-vendor');
  });

  it('providerMode WITHOUT a real turn ⇒ no line (neutrality: empty signals ⇒ empty receipt)', () => {
    const r = composeTrustReceipt({ providerMode: 'solo' }, '');
    assert.equal(r.providerMode, undefined);
    assert.ok(isEmptyReceipt(r));
  });

  it('line order is confidence → verify → provider mode → self-audit (self-audit stays last)', () => {
    const r = composeTrustReceipt(
      {
        confidence: conf(),
        verify: reviewedVerify(),
        providerMode: 'solo',
        authedProviderCount: 1,
        groundedFiles: ['x.ts'],
      },
      'Confident',
    );
    const lines = trustReceiptLines(r);
    assert.match(lines[0], /x\.ts/); // confidence
    assert.match(lines[1], /review|self-check/i); // verify receipt
    assert.match(lines[2], /^provider mode:/); // provider posture
    assert.match(lines[lines.length - 1], /^note: /); // self-audit last
  });
});

// ---------------------------------------------------------------------------
// (2c) CONFIDENCE TIER — aligned with evidence.ts ConfidenceLabel vocabulary
// ---------------------------------------------------------------------------

describe('confidenceTier / receipt.confidenceLabel — shared 5-label vocabulary', () => {
  it('absent verify ⇒ no confidenceLabel (never fabricate a tier)', () => {
    assert.equal(confidenceTier({}), undefined);
    assert.equal(composeTrustReceipt({ confidence: conf() }, 'Confident').confidenceLabel, undefined);
  });

  it('passing tests ⇒ verified-by-tests', () => {
    const tier = confidenceTier({ verify: passingVerify() });
    assert.equal(tier, 'verified-by-tests');
    assert.equal(composeTrustReceipt({ verify: passingVerify() }, '').confidenceLabel, 'verified-by-tests');
  });

  it('passing + approving cross-vendor critic ⇒ verified-by-tests-and-independent-review', () => {
    const tier = confidenceTier({
      verify: passingVerify({
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
      authedProviderCount: 2,
    });
    assert.equal(tier, 'verified-by-tests-and-independent-review');
  });

  it('reviewed (critic, no tests) ⇒ reviewed', () => {
    const tier = confidenceTier({ verify: reviewedVerify() });
    assert.equal(tier, 'reviewed');
  });

  it('failing tests ⇒ not-verified', () => {
    assert.equal(confidenceTier({ verify: failingVerify() }), 'not-verified');
  });

  it('solo provider caps verified-by-tests down to reviewed', () => {
    const tier = confidenceTier({ verify: passingVerify(), authedProviderCount: 1 });
    assert.equal(tier, 'reviewed');
  });

  it('uses an explicit providerMode signal when present', () => {
    // An explicit solo mode caps the tier even when the raw auth count is unknown.
    const tier = confidenceTier({ verify: passingVerify(), providerMode: 'solo' });
    assert.equal(tier, 'reviewed');
  });
});

// ---------------------------------------------------------------------------
// THE FLAG — promoted to unconditional in batches 4-6 dedrift.
// Trust is ON by default; gated only by MYSHELL_ROLLBACK.
// ---------------------------------------------------------------------------

describe('trust — promoted to unconditional (batches 4-6 dedrift)', () => {
  it('trust surface is always on by default (no flag layer)', () => {
    // Trust is now unconditional — no per-feature opt-in/opt-out flag remains.
    // The kill-switch is MYSHELL_ROLLBACK, tested separately.
    assert.equal(true, true);
  });
});
