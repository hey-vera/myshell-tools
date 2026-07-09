/**
 * src/core/verify.ts — THE VERIFICATION CENTERPIECE (master-plan PHASE 3), pure half.
 *
 * "Done" must be trustworthy. After a turn produces a code change, the verify stage
 * runs a GRADUATED, HONEST check and surfaces an honest FOUR-STATE result:
 *
 *     unverified | reviewed | passing | failing
 *
 * This module is the PURE half — the four-state mapping, the diff-scoped critic
 * prompt, and the honest receipt strings. Every impure act (the `git diff`, the
 * test-command detection, the bounded test-runner exec) lives behind an INJECTED
 * {@link VerifyPort} whose production impl is `src/infra/verify-port.ts` — exactly
 * mirroring the RepoScanPort / repo-scan.ts split, so core stays pure (the purity
 * guard, test/arch/guards.test.ts).
 *
 * THE HONESTY NON-NEGOTIABLES (load-bearing):
 *   - NEVER claim `passing` without tests that executed GREEN.
 *   - `reviewed` is NOT `passing` (a critic looked, no tests ran).
 *   - `unverified` is the honest default when nothing ran (empty diff, no test
 *     command detected, tests timed out, a crash in verification).
 *   - NEVER fabricate a test result or a critic verdict.
 *   - Fail-soft: a crash anywhere in verification degrades to `unverified` + an
 *     honest note, and NEVER breaks the turn.
 *
 * SUBSCRIPTION-ONLY: tests are FREE local exec; the critic reuses the existing
 * provider routing (a seat the user owns) — no API keys, no metered services.
 *
 * @see .tmp-master-golden.md §2.2 — the verification centerpiece (the spec)
 * @see .tmp-master-build.md PHASE 3 — change-capture + verify
 */

import type { CommandGatePort } from './command-gate.js';

// ---------------------------------------------------------------------------
// The four honest states
// ---------------------------------------------------------------------------

/**
 * The honest four-state verification result threaded out of the verify stage.
 *
 *   - `unverified` : nothing ran (no diff, no test command, timeout, or a
 *                    verification crash). The honest default — NEVER faked green.
 *   - `reviewed`   : a critic looked at the diff but NO tests executed. NOT
 *                    `passing` — a weaker, labelled signal.
 *   - `passing`    : the project's own tests RAN and went GREEN. The only state
 *                    that may claim "verified".
 *   - `failing`    : the project's own tests RAN and went RED. Surfaced honestly.
 */
export type VerifiedState = 'unverified' | 'reviewed' | 'passing' | 'failing';

// ---------------------------------------------------------------------------
// The injected port (impure git/test exec lives behind this — infra impl)
// ---------------------------------------------------------------------------

/**
 * The captured change THIS turn produced. `files` is the set of repo-relative
 * paths that changed; `patch` is the unified diff text (bounded). An EMPTY diff
 * (`files.length === 0`) means NO code change → NO verification (the honest
 * `unverified` default, satisfying the Governor's no-diff⇒no-verify invariant).
 */
export interface CapturedDiff {
  /** Repo-relative POSIX paths that changed this turn. Empty ⇒ no verification. */
  readonly files: readonly string[];
  /** The unified diff text (bounded by the port). Empty when nothing changed. */
  readonly patch: string;
}

/** The detected project test command (conservative detection — see the port). */
export interface DetectedTestCommand {
  /** A human-displayable label, e.g. `npm test` or `pytest`. */
  readonly label: string;
  /** The executable + args the port will run (already split, never a shell string). */
  readonly command: string;
  readonly args: readonly string[];
}

/** The bounded result of running the project's own test command. */
export interface TestRunResult {
  /**
   * The OUTCOME of the run, honestly:
   *   - `green`     : the runner exited 0 — tests passed.
   *   - `red`       : the runner exited non-zero — tests failed.
   *   - `timeout`   : the runner exceeded the bound (uncertain → never a pass).
   *   - `errored`   : the runner could not be executed (uncertain → never a pass).
   */
  readonly outcome: 'green' | 'red' | 'timeout' | 'errored';
  /** Combined stdout+stderr, bounded (the honest failing output to surface). */
  readonly output: string;
  /** Wall-clock duration in ms (for the receipt). */
  readonly durationMs: number;
}

/**
 * The injected verification port. The production impl (`src/infra/verify-port.ts`)
 * wraps `git`/`execa` with the SAME best-effort, no-throw discipline as
 * repo-scan.ts. Every method MUST be fail-soft: a missing `git`, a non-repo dir,
 * a hanging test, or any error degrades to a null/empty/`errored` result rather
 * than throwing — the pure caller never has to try/catch the port, though it does
 * anyway (belt-and-suspenders) so a misbehaving port can never break the turn.
 */
export interface VerifyPort {
  /**
   * Capture the change THIS turn produced. `editedFiles` is the turn's real
   * edited-files signal when work-call tracks it; when absent the port falls back
   * to a `git diff` of the working tree. Returns an EMPTY {@link CapturedDiff}
   * (no files, no patch) when nothing changed or git is unavailable.
   */
  captureDiff(cwd: string, editedFiles?: readonly string[]): Promise<CapturedDiff>;
  /**
   * Detect the project's test command CONSERVATIVELY (package.json "test" script
   * primarily; known runners). Returns `null` when nothing is clearly detected —
   * which maps to the honest `unverified (no test command detected)`, NEVER a
   * fabricated pass.
   */
  detectTestCommand(cwd: string): Promise<DetectedTestCommand | null>;
  /**
   * Run the detected test command in `cwd`, with the given timeout, output
   * captured, non-destructive. Returns the honest {@link TestRunResult}. Must
   * never throw — a spawn failure degrades to `{ outcome: 'errored' }`.
   */
  runTests(
    cwd: string,
    command: DetectedTestCommand,
    timeoutMs: number,
    commandGate?: CommandGatePort,
  ): Promise<TestRunResult>;
}

// ---------------------------------------------------------------------------
// The verification level (mirrors the Governor's `verify` lever values)
// ---------------------------------------------------------------------------

/**
 * The verification level for a turn — the SAME vocabulary the Governor's `verify`
 * lever encodes (governor.ts::Verify). The verify stage reads this to decide how
 * far up the cost ladder to climb:
 *   - `none`         : skip verification entirely.
 *   - `tests`        : tests-first only (free local exec), no critic.
 *   - `tests+critic` : tests-first, then ONE diff-scoped cross-vendor critic.
 *   - `reviewed`     : the critic is the primary signal (used when no tests exist).
 */
export type VerifyLevel = 'none' | 'tests' | 'tests+critic' | 'reviewed';

/** Whether the level wants a critic pass at all (after tests-first runs). */
export function levelWantsCritic(level: VerifyLevel): boolean {
  return level === 'tests+critic' || level === 'reviewed';
}

// ---------------------------------------------------------------------------
// Test-result → four-state mapping (the load-bearing honesty boundary)
// ---------------------------------------------------------------------------

/**
 * Map a {@link TestRunResult} to the honest {@link VerifiedState}. ONLY a `green`
 * run becomes `passing`; ONLY a `red` run becomes `failing`. A `timeout` or an
 * `errored` run is UNCERTAIN and maps to `unverified` — NEVER a fabricated pass.
 * Pure, total.
 */
export function stateFromTestRun(result: TestRunResult): VerifiedState {
  switch (result.outcome) {
    case 'green':
      return 'passing';
    case 'red':
      return 'failing';
    case 'timeout':
    case 'errored':
    default:
      return 'unverified';
  }
}

// ---------------------------------------------------------------------------
// The four-state outcome threaded out of the stage
// ---------------------------------------------------------------------------

/**
 * Where each piece of the verdict came from — kept on the outcome so the receipt
 * is honest about WHAT actually ran (never overclaiming).
 */
export interface VerifyOutcome {
  /** The honest four-state result. */
  readonly verified: VerifiedState;
  /** The test command that ran (label), when one was detected and executed. */
  readonly testCommand?: string;
  /**
   * Optional repo/map facts captured for CompletionResultV1 worktree + durable orientation.
   * Present only when completion binding enriches; does not affect 4 states or receipts.
   */
  readonly mapOrientationRef?: { rankedCount?: number; symbolsSample?: readonly string[] };
  /** The test run, when tests executed (any outcome). */
  readonly testRun?: TestRunResult;
  /**
   * The cross-vendor critic that ran, when one ran. `vendor` is the reviewer's
   * provider id; `sameVendor` is true when only one vendor was connected and the
   * critic fell back to the SAME vendor as the author (labelled honestly).
   */
  readonly critic?: {
    readonly vendor: string;
    readonly sameVendor: boolean;
    readonly parsed?: boolean;
    readonly verdict?: 'approve' | 'revise' | 'escalate';
    readonly notes?: string;
  };
  /** The number of files the diff touched (0 ⇒ no verification ran). */
  readonly changedFiles: number;
  /**
   * The repo-relative paths the diff actually touched (the REAL grounding for the
   * trust receipt's auditable confidence line). Present only when a diff was captured
   * (changedFiles > 0); ABSENT/empty otherwise — never a fabricated file name. The
   * trust surface (core/trust-receipt.ts) lists these so confidence points at real
   * files the turn genuinely changed, never a claim it didn't earn.
   */
  readonly changedPaths?: readonly string[];
  /**
   * A short, honest reason the verdict is what it is — surfaced in the receipt for
   * the non-`passing` states (e.g. "no test command detected", "tests timed out").
   */
  readonly note?: string;
}

/** The honest `unverified` outcome with a reason — the fail-soft default. */
export function unverified(reason: string, changedFiles = 0): VerifyOutcome {
  return { verified: 'unverified', changedFiles, note: reason };
}

// ---------------------------------------------------------------------------
// The receipt (honest, concise, never overclaiming)
// ---------------------------------------------------------------------------

/**
 * Build the honest one-line receipt surfaced to the user as a `notice` CoreEvent.
 * The strings are PINNED by the verify tests so the honesty can never silently
 * regress. NEVER reads `passing` unless tests executed green; `reviewed` NEVER
 * reads as `passing`.
 *
 * Examples (the pinned shapes):
 *   ✓ tests passing (npm test, 4600ms) · cross-checked by codex
 *   ✗ tests failing (npm test, 1200ms)
 *   ~ reviewed by codex (no tests run — weak signal)
 *   ~ reviewed by claude (self-check, no tests run — weak signal)
 *   ⚠ unverified — no test command detected
 */
export function buildVerifyReceipt(outcome: VerifyOutcome): string {
  const critic = outcome.critic;
  const criticVerdictTail =
    critic?.parsed === true && critic.verdict === 'revise'
      ? ' · critic requested revision'
      : critic?.parsed === true && critic.verdict === 'escalate'
        ? ' · critic requested escalation'
        : '';
  const criticTail = (() => {
    if (critic === undefined) return '';
    const vendor = critic.sameVendor
      ? ` · self-checked by ${critic.vendor} (same vendor)`
      : ` · cross-checked by ${critic.vendor}`;
    return `${vendor}${criticVerdictTail}`;
  })();

  switch (outcome.verified) {
    case 'passing': {
      const cmd = outcome.testCommand ?? 'tests';
      const ms = outcome.testRun?.durationMs;
      const timing = typeof ms === 'number' && ms >= 0 ? `, ${ms}ms` : '';
      return `✓ tests passing (${cmd}${timing})${criticTail}`;
    }
    case 'failing': {
      const cmd = outcome.testCommand ?? 'tests';
      const ms = outcome.testRun?.durationMs;
      const timing = typeof ms === 'number' && ms >= 0 ? `, ${ms}ms` : '';
      // NOTE: even with a critic, a red test owns the state — surface it honestly.
      return `✗ tests failing (${cmd}${timing})${criticTail}`;
    }
    case 'reviewed': {
      const vendor = critic?.vendor ?? 'a reviewer';
      const kind = critic?.sameVendor === true ? 'self-check' : 'review';
      return `~ reviewed by ${vendor} (${kind}, no tests run — weak signal)${criticVerdictTail}`;
    }
    case 'unverified':
    default: {
      const reason = outcome.note !== undefined && outcome.note.length > 0
        ? ` — ${outcome.note}`
        : '';
      return `⚠ unverified${reason}`;
    }
  }
}

// ---------------------------------------------------------------------------
// The diff-scoped critic prompt (rewritten to take the DIFF + TEST OUTPUT)
// ---------------------------------------------------------------------------

/** Inputs to the diff-scoped critic prompt — REALITY, not the author's prose. */
export interface DiffReviewInput {
  /** The original user task (orientation only). */
  readonly task: string;
  /** The unified diff THIS turn produced (the thing under review). */
  readonly diff: string;
  /**
   * The project's test output, when tests ran. Present ⇒ the critic ANNOTATES
   * (tests own the pass/fail state); absent ⇒ the critic is the primary signal.
   */
  readonly testOutput?: string;
  /** The test outcome label, when tests ran (`green`/`red`/...). */
  readonly testOutcome?: TestRunResult['outcome'];
}

/** Cap the diff/test-output injected into the critic prompt (token-safety). */
const MAX_DIFF_CHARS = 24_000;
const MAX_TEST_OUTPUT_CHARS = 8_000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Build the DIFF-SCOPED critic prompt — the single most important review change in
 * the plan: the critic reviews REALITY (the diff + the test output), NOT the
 * author's self-description. Reuses the same trailing-JSON-verdict envelope that
 * `parseReviewVerdict` (review.ts) already parses, so the existing verdict parser
 * works unchanged.
 *
 * When test output is present the prompt tells the critic the tests already own
 * the pass/fail state — the critic's job is to find what tests CAN'T catch
 * (security, hidden regressions, missed requirements). When absent, the critic is
 * the primary signal.
 */
export function buildDiffReviewPrompt(input: DiffReviewInput): string {
  const diff = clip(input.diff, MAX_DIFF_CHARS);
  const testSection = (() => {
    if (input.testOutput === undefined || input.testOutput.length === 0) {
      return `\nNO automated tests ran for this change — your review is the primary signal. Be thorough: a missed defect here reaches the user unchecked.`;
    }
    const outcome = input.testOutcome ?? 'unknown';
    return `\nThe project's own tests ALREADY RAN and went ${outcome.toUpperCase()}. The tests own the pass/fail verdict — do NOT re-litigate it. Your job is what tests CAN'T catch: security holes, hidden regressions, missed requirements, unsafe assumptions. Test output:\n${clip(input.testOutput, MAX_TEST_OUTPUT_CHARS)}`;
  })();

  return `\
You are a senior staff-engineer reviewer performing a critical quality gate on a code change.

You are reviewing the ACTUAL DIFF a teammate just produced for this task — not a
description of it, the real change. Identify any correctness, security, or
completeness problem that would harm the user if this shipped.

Original task:
${input.task}

THE DIFF UNDER REVIEW (the reality — judge THIS, not any prose):
${diff}
${testSection}

Review checklist (assess each against the diff itself):
1. CORRECTNESS — does the diff actually do what the task needs? Logic errors,
   off-by-ones, wrong assumptions, broken edge cases introduced by THIS change?
2. SECURITY — injection, secret leaks, missing validation, privilege paths added
   by the diff?
3. COMPLETENESS — does the diff address the task, or leave a gap / TODO / half-fix?
4. REGRESSION — could the diff break something the tests don't cover?

Anchor every finding to a specific file path and line range from the diff.

After your review, append EXACTLY the following JSON object on its own line at the
very end of your response (no trailing text after it):
{"verdict": "approve|revise|escalate", "notes": "<specific, file-anchored feedback>", "confidence": <0.0-1.0>}

verdict choices:
  approve   — the diff is correct, complete, and safe; ship it.
  revise    — the diff has fixable issues; provide actionable, file-anchored notes.
  escalate  — the change needs architectural judgement or has critical defects.

confidence: your honest estimate that your review is complete and correct (1.0 = certain).`;
}

// ---------------------------------------------------------------------------
// The graduated state composer (tests-first, critic annotates)
// ---------------------------------------------------------------------------

/**
 * Compose the final {@link VerifiedState} from the tests-first signal and an
 * optional critic. The load-bearing rules (master-plan §2.2 layer 3):
 *
 *   - tests ran & GREEN  → `passing` (a critic, if any, only annotates).
 *   - tests ran & RED    → `failing` (a critic only annotates; red owns the state).
 *   - tests did NOT run, a critic ran → `reviewed` (NOT `passing`).
 *   - nothing settled it → `unverified`.
 *
 * `testState` is the state from {@link stateFromTestRun} when tests executed, or
 * `undefined` when no tests ran. `criticRan` is whether a critic produced a real
 * verdict. Pure, total.
 */
export function composeVerifiedState(
  testState: VerifiedState | undefined,
  criticRan: boolean,
): VerifiedState {
  // Tests, when they actually executed, OWN the pass/fail state.
  if (testState === 'passing') return 'passing';
  if (testState === 'failing') return 'failing';
  // No decisive test signal. A critic with no tests → `reviewed` (weak signal).
  if (criticRan) return 'reviewed';
  // Nothing settled it.
  return 'unverified';
}
