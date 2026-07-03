/**
 * src/core/trust-receipt.ts — THE TRUST SURFACE (master-plan PHASE 8, pure half).
 *
 * After a SUBSTANTIAL turn, the partner presents — in ONE clean, scannable place —
 * WHAT actually happened this turn, so the user can TRUST and AUDIT it:
 *
 *   1. AUDITABLE CONFIDENCE — the confidence statement points at its GROUNDS (the
 *      real files it changed, the real test result, whether independent minds
 *      agreed), never a bare adjective and never a fabricated basis.
 *   2. THE VERIFY RECEIPT — the four-state `verified` line (passing/failing/reviewed
 *      /unverified), reused VERBATIM from {@link buildVerifyReceipt}.
 *   3. A LIGHTWEIGHT SELF-AUDIT — a single honest line naming what it did NOT do, so
 *      the user can audit (`didn't run tests (none detected)`, `didn't cross-check
 *      (single vendor)`). NO extra model call — pure composition of the SAME real
 *      signals already on the turn.
 *
 * THIS MODULE IS PURE (no I/O, no time, no randomness, no model call — enforced by
 * test/arch/guards.test.ts). It is a COMPOSER over signals the last six phases made
 * real; it INVENTS no signal.
 *
 * THE HONESTY NON-NEGOTIABLES (this whole phase is about TRUST — fabrication here is
 * the worst failure):
 *   - Present ONLY signals that genuinely occurred. An ABSENT signal ⇒ an ABSENT
 *     line — never a zero, never a placeholder, never "1 model agrees" when no poll
 *     ran, never a "tests passing" implication when no tests ran.
 *   - The self-audit discloses REAL gaps only — it never invents a gap and never
 *     claims a check it didn't do.
 *   - `reviewed` NEVER reads as `passing` (the verify receipt already enforces this;
 *     the confidence grounds mirror it — a reviewed turn says "reviewed", not "tests
 *     passing").
 *   - Subscription-only: no new model call (pure composition of existing signals).
 *
 * @see .tmp-master-experience.md §1.3, §4.2, §4.3 — the felt receipt / trust surface
 * @see .tmp-master-build.md PHASE 8 — THE TRUST SURFACE + SELF-AUDIT
 */

import type { Confidence } from './brain.js';
import type { ProviderMode } from './evidence.js';
import { ConfidenceLabel, deriveConfidenceLabel } from './evidence.js';
import type { VerifyOutcome } from './verify.js';
import { buildVerifyReceipt } from './verify.js';

// ---------------------------------------------------------------------------
// The real signals present on the turn (every field optional + honestly absent)
// ---------------------------------------------------------------------------

/**
 * The REAL signals a turn carries into the trust receipt. EVERY field is optional
 * and honestly ABSENT when the signal did not occur — the composer reads only what
 * is present and emits a line only for what genuinely happened.
 */
export interface TrustSignals {
  /**
   * The brain's per-turn confidence tuple (understanding / groundedness / stakes /
   * optional agreement). ABSENT ⇒ no confidence line (we never invent a confidence
   * claim). Its `agreement` is set ONLY when a real cross-vendor poll ran.
   */
  readonly confidence?: Confidence;
  /**
   * The four-state verification outcome from the verify stage. ABSENT ⇒ no verify
   * line and the self-audit honestly notes verification did not run. Verification is
   * unconditional; the port is absent only when MYSHELL_ROLLBACK is engaged.
   */
  readonly verify?: VerifyOutcome;
  /**
   * The repo-relative paths the turn actually changed/read (the grounding). Used to
   * make the confidence line point at REAL files. ABSENT/empty ⇒ no file-grounding
   * claim (we never claim to have read files we didn't). Typically the verify diff's
   * changed-files set when present.
   */
  readonly groundedFiles?: readonly string[];
  /**
   * How many DISTINCT vendors were authenticated this turn — used ONLY for the honest
   * self-audit gap ("didn't cross-check (single vendor)") and the locked-cross-vendor
   * affordance. ABSENT ⇒ the cross-vendor gap is not asserted (we don't guess vendor
   * count).
   */
  readonly authedProviderCount?: number;
  /**
   * The per-turn PROVIDER POSTURE derived at the verify/accept point (the SAME
   * `zero | solo | multi` vocabulary {@link buildSnapshotFromVerify} emits): `zero` no
   * provider engaged, `solo` a single vendor ran, `multi` independent vendors checked.
   * ABSENT ⇒ no provider-mode line (we never assert a posture we didn't derive). Purely
   * additive — its presence never alters any other line.
   */
  readonly providerMode?: ProviderMode;
}

/** Cap on how many grounded file names the confidence line lists (the rest summarized). */
const MAX_LISTED_FILES = 3;

// ---------------------------------------------------------------------------
// (1) AUDITABLE CONFIDENCE — the confidence statement that points at its grounds
// ---------------------------------------------------------------------------

/**
 * Derive the honest per-turn provider mode from the trust signals when an explicit
 * mode is not already present. Mirrors the evidence module's cap discipline:
 * zero providers → `zero`, one provider (or a same-vendor critic) → `solo`,
 * otherwise `multi`. PURE; never throws.
 */
function deriveReceiptProviderMode(signals: TrustSignals): ProviderMode {
  const count = signals.authedProviderCount;
  const critic = signals.verify?.critic;
  if (count === 0) return 'zero';
  if (count === 1 || critic?.sameVendor === true) return 'solo';
  return 'multi';
}

/**
 * The canonical 5-label confidence tier for the receipt, mapped onto the SAME
 * {@link ConfidenceLabel} vocabulary {@link buildSnapshotFromVerify} uses in
 * evidence.ts. Absent when verification did not run (no fabricated label).
 * PURE; never throws.
 */
export function confidenceTier(signals: TrustSignals): ConfidenceLabel | undefined {
  if (signals.verify === undefined) return undefined;
  const providerMode = signals.providerMode ?? deriveReceiptProviderMode(signals);
  const providerCount =
    typeof signals.authedProviderCount === 'number'
      ? signals.authedProviderCount
      : Number.POSITIVE_INFINITY;
  return deriveConfidenceLabel(signals.verify, providerMode, providerCount);
}

/**
 * Compose the human grounds the confidence rests on — REAL signals only, in a fixed
 * order: files actually touched, the test/critic verdict, cross-vendor agreement.
 * PURE; never throws. Returns the grounds phrases (e.g. `read Feed.tsx, api/feed.ts`,
 * `tests passing`, `gpt + claude agree`); EMPTY when no real ground exists (the caller
 * then omits the "— because …" clause entirely rather than fabricate a basis).
 */
export function confidenceGrounds(signals: TrustSignals): string[] {
  const grounds: string[] = [];

  // (a) GROUNDING — the real files the turn touched. Never a claim it didn't earn.
  const files = (signals.groundedFiles ?? []).filter((f) => typeof f === 'string' && f.trim().length > 0);
  if (files.length > 0) {
    const shown = files.slice(0, MAX_LISTED_FILES).map((f) => baseName(f.trim()));
    const extra = files.length - shown.length;
    const list = extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ');
    grounds.push(`changed ${list}`);
  }

  // (b) VERIFICATION — the real four-state verdict, mirrored honestly. `reviewed`
  //     NEVER reads as passing; an unverified/absent verify never claims a pass.
  const v = signals.verify;
  if (v !== undefined) {
    switch (v.verified) {
      case 'passing':
        grounds.push(v.testCommand !== undefined ? `${v.testCommand} passing` : 'tests passing');
        break;
      case 'failing':
        grounds.push(v.testCommand !== undefined ? `${v.testCommand} FAILING` : 'tests failing');
        break;
      case 'reviewed':
        // A weak signal — say "reviewed", never "verified"/"passing".
        grounds.push(
          v.critic !== undefined
            ? `${v.critic.sameVendor ? 'self-checked' : 'cross-checked'} by ${v.critic.vendor} (no tests)`
            : 'reviewed (no tests)',
        );
        break;
      case 'unverified':
      default:
        // No honest positive ground from an unverified verify — say nothing here;
        // the self-audit line below discloses the gap.
        break;
    }
  }

  // (c) CROSS-VENDOR AGREEMENT — ONLY when a real poll ran (agreement present). An
  //     absent agreement ⇒ NO agreement ground (never "1 model agrees").
  const agreement = signals.confidence?.agreement;
  if (agreement === 'consensus') {
    grounds.push('independent models agree');
  } else if (agreement === 'lean') {
    grounds.push('models mostly agree (one dissent)');
  } else if (agreement === 'split') {
    grounds.push('models split — your call');
  }

  return grounds;
}

/**
 * The AUDITABLE confidence line: the honest confidence ADJECTIVE (composed elsewhere
 * by the brain's {@link confidenceLine} and passed in as `base`) followed by the REAL
 * grounds it rests on. PURE; never throws.
 *
 * Composition:
 *   - With grounds:  `<base> — <ground>; <ground>; …`  (the auditable form)
 *   - No grounds:    `<base>`  (the bare adjective, when there is genuinely nothing
 *                    real to point at — never a fabricated basis)
 *   - No base:       just the grounds joined, or `''` when neither exists.
 *
 * This is the "fairly sure of the goal (changed auth.ts; tests passing; models agree)"
 * shape — confidence pointed at its evidence, exactly as the trust surface demands.
 */
export function auditableConfidenceLine(base: string, signals: TrustSignals): string {
  const grounds = confidenceGrounds(signals);
  const trimmedBase = (base ?? '').trim();
  if (grounds.length === 0) return trimmedBase;
  const groundsClause = grounds.join('; ');
  if (trimmedBase.length === 0) return groundsClause;
  return `${trimmedBase} — ${groundsClause}`;
}

// ---------------------------------------------------------------------------
// (3) LIGHTWEIGHT SELF-AUDIT — what it did NOT do (honest, never invented)
// ---------------------------------------------------------------------------

/**
 * Compose the honest self-audit gaps — what the turn did NOT do, so the user can
 * audit. PURE; never throws. EVERY gap is a REAL absence read off the same signals
 * (never an invented gap, never a claim of a check it didn't perform):
 *
 *   - tests did NOT run (no verify outcome, or verify ran but no tests executed) →
 *     `didn't run tests (none detected)` / `didn't run tests`.
 *   - NO cross-vendor critic ran (single vendor, or no critic on this turn) →
 *     `didn't cross-check (single vendor)` (only when we KNOW there was one vendor).
 *
 * Returns the gap phrases; EMPTY when there is genuinely nothing honest to disclose
 * (e.g. tests passed AND a cross-vendor critic ran — full coverage, no gap to name).
 */
export function selfAuditGaps(signals: TrustSignals): string[] {
  const gaps: string[] = [];
  const v = signals.verify;

  // GAP 1: tests did not run. Real cases: no verify outcome at all, or a verify
  // outcome whose verdict is reviewed/unverified with no executed test run.
  const testsRan = v?.testRun !== undefined && (v.testRun.outcome === 'green' || v.testRun.outcome === 'red');
  if (!testsRan) {
    if (v === undefined) {
      // Verification did not run on this turn (the gap is the absence itself).
      gaps.push("didn't verify with tests");
    } else if (v.verified === 'reviewed') {
      // A critic looked but no tests ran — name it as the no-tests gap honestly.
      gaps.push("didn't run tests (none detected)");
    } else if (v.note !== undefined && v.note.length > 0) {
      // The verify outcome already carries the honest reason (e.g. "no test command
      // detected", "tests timed out") — disclose THAT real reason, never invented.
      gaps.push(`didn't run tests (${v.note})`);
    } else {
      gaps.push("didn't run tests");
    }
  }

  // GAP 2: no cross-vendor critic. Only asserted when we KNOW the vendor count — a
  // single-vendor turn genuinely COULDN'T cross-check (the honest locked affordance).
  const crossChecked = v?.critic !== undefined && v.critic.sameVendor === false;
  if (!crossChecked) {
    const count = signals.authedProviderCount;
    if (typeof count === 'number' && count <= 1) {
      gaps.push("didn't cross-check (single vendor)");
    } else if (v?.critic !== undefined && v.critic.sameVendor === true) {
      // A same-vendor self-check ran (weak) — disclose it wasn't a cross-vendor check.
      gaps.push("didn't cross-check (same-vendor self-check only)");
    }
    // When count is unknown and no critic info exists, we say NOTHING (never guess a
    // gap we can't ground — silence over a fabricated disclosure).
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// (2b) PROVIDER POSTURE — the honest per-turn provider mode, neutrally stated
// ---------------------------------------------------------------------------

/**
 * The honest provider-posture line for a derived {@link ProviderMode}. PURE; never
 * throws. A NEUTRAL statement of what genuinely ran this turn (not a gap, not a boast)
 * — it complements, never contradicts, the self-audit's cross-check disclosure:
 *
 *   - `multi` → `provider mode: cross-vendor`   (independent vendors checked)
 *   - `solo`  → `provider mode: single vendor`  (one vendor ran)
 *   - `zero`  → `provider mode: none`           (no provider engaged this turn)
 *
 * Returns `undefined` for an unrecognized value (never fabricates a posture).
 */
export function providerModeLine(mode: ProviderMode): string | undefined {
  switch (mode) {
    case 'multi':
      return 'provider mode: cross-vendor';
    case 'solo':
      return 'provider mode: single vendor';
    case 'zero':
      return 'provider mode: none';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// THE TRUST RECEIPT — one scannable block of notice lines, composed from reality
// ---------------------------------------------------------------------------

/**
 * The composed trust receipt: an ordered list of notice-message lines (the caller
 * emits each as a `notice` CoreEvent, matching the existing verify-receipt idiom).
 * Each line is present ONLY when its underlying signal is real:
 *
 *   - `confidence` : the auditable confidence line (adjective + real grounds), or
 *                    absent when there is no confidence tuple at all.
 *   - `verify`     : the four-state verify receipt ({@link buildVerifyReceipt}),
 *                    absent when verification did not run.
 *   - `selfAudit`  : the honest "didn't …" gap disclosure, absent when there is
 *                    genuinely no gap to name.
 *
 * Returns `[]` when NO signal is real (so the caller emits nothing — neutrality).
 */
export interface TrustReceipt {
  /** The auditable confidence line, when a confidence tuple is present. */
  readonly confidence?: string;
  /** The four-state verify receipt, when verification ran. */
  readonly verify?: string;
  /** The honest provider-posture line, when a provider mode was derived this turn. */
  readonly providerMode?: string;
  /** The honest self-audit gap line, when there is a real gap to disclose. */
  readonly selfAudit?: string;
  /**
   * The canonical 5-label confidence tier, when verification ran. This is the
   * SAME vocabulary evidence.ts uses ({@link ConfidenceLabel}) — the receipt and
   * the evidence store are now explicitly aligned, not two divergent wordings.
   */
  readonly confidenceLabel?: ConfidenceLabel;
}

/**
 * Compose the trust receipt from the real signals on the turn. PURE; never throws.
 *
 * `confidenceBase` is the brain's own honest confidence ADJECTIVE line
 * ({@link confidenceLine} output) — passed in so this pure module doesn't re-derive
 * it; the composer appends the real grounds to it.
 *
 * The receipt emits ONLY real lines: an absent verify ⇒ no verify line; an absent
 * agreement ⇒ no agreement ground; no grounded files ⇒ no file-grounding claim; no
 * gap ⇒ no self-audit line. When NOTHING is real, returns an empty receipt
 * ({@link isEmptyReceipt} true) and the caller emits nothing.
 */
export function composeTrustReceipt(signals: TrustSignals, confidenceBase: string): TrustReceipt {
  const receipt: { confidence?: string; verify?: string; providerMode?: string; selfAudit?: string; confidenceLabel?: ConfidenceLabel } = {};

  // (1) AUDITABLE CONFIDENCE — only when a confidence tuple is genuinely present.
  if (signals.confidence !== undefined) {
    const line = auditableConfidenceLine(confidenceBase, signals);
    if (line.length > 0) receipt.confidence = line;
  }

  // (2) THE VERIFY RECEIPT — reused verbatim, only when verification ran.
  if (signals.verify !== undefined) {
    receipt.verify = buildVerifyReceipt(signals.verify);
  }

  // (2c) CONFIDENCE TIER — mapped to the canonical 5-label vocabulary shared with
  //      evidence.ts, only when verification ran (no fabricated label).
  if (signals.verify !== undefined) {
    const tier = confidenceTier(signals);
    if (tier !== undefined) {
      receipt.confidenceLabel = tier;
    }
  }

  const hasTurnContext = signals.confidence !== undefined || signals.verify !== undefined;

  // (2b) PROVIDER POSTURE — the neutral per-turn provider mode, only when one was
  //      genuinely derived AND anchored to a real turn (same neutrality contract as the
  //      self-audit: an empty signal set ⇒ an empty receipt). Purely additive; it never
  //      alters another line.
  if (hasTurnContext && signals.providerMode !== undefined) {
    const line = providerModeLine(signals.providerMode);
    if (line !== undefined) receipt.providerMode = line;
  }

  // (3) THE SELF-AUDIT — only when there is a REAL gap to disclose honestly, AND
  //     only ANCHORED to a real turn. The self-audit is a disclosure ABOUT a
  //     substantial turn's trust signals ("didn't verify", "didn't cross-check"); with
  //     NO confidence and NO verify outcome there is no turn context to audit, and a
  //     bare "didn't verify with tests" would be noise on a turn where verification was
  //     never even applicable — violating the neutrality contract (an empty signal set
  //     ⇒ an empty receipt ⇒ emit nothing). So the audit rides on a present positive
  //     signal; it never STANDS ALONE.
  if (hasTurnContext) {
    const gaps = selfAuditGaps(signals);
    if (gaps.length > 0) {
      receipt.selfAudit = `note: ${gaps.join('; ')}`;
    }
  }

  return receipt;
}

/** True when the receipt has no real line to surface (the caller emits nothing). */
export function isEmptyReceipt(receipt: TrustReceipt): boolean {
  return (
    receipt.confidence === undefined &&
    receipt.verify === undefined &&
    receipt.providerMode === undefined &&
    receipt.selfAudit === undefined
  );
}

/**
 * Flatten the receipt into the ordered list of notice-message lines the caller emits
 * (confidence → verify → provider mode → self-audit). PURE; never throws. Empty receipt
 * ⇒ `[]`.
 */
export function trustReceiptLines(receipt: TrustReceipt): string[] {
  const lines: string[] = [];
  if (receipt.confidence !== undefined) lines.push(receipt.confidence);
  if (receipt.verify !== undefined) lines.push(receipt.verify);
  if (receipt.providerMode !== undefined) lines.push(receipt.providerMode);
  if (receipt.selfAudit !== undefined) lines.push(receipt.selfAudit);
  return lines;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Last path segment (repo-relative POSIX or OS path); the readable file label. */
function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}
