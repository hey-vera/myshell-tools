/**
 * src/core/completion-truth-chrome.ts — pure end-of-turn completion honesty line
 * for receipt chrome (P2.5 partner continuity).
 *
 * Surfaces real {@link CompletionResultV1} verify/settle truth without theater:
 * verified vs unverified, terminal, and whether goal settlement was allowed.
 * PURE: no I/O, no time, no secrets. Absent/invalid → undefined (omit the line).
 *
 * Flag-off path never attaches completionResult, so callers that pass undefined
 * emit nothing — byte-identical chrome when CompletionResultV1 is not present.
 */

import type {
  CompletionEvidenceStatus,
  CompletionResultV1,
  CompletionTerminal,
} from './types.js';

/** Cap so the chrome stays one scannable line. */
export const COMPLETION_TRUTH_CHROME_MAX_CHARS = 160;

/**
 * Format a single completion-truth chrome line from a real CompletionResultV1.
 * PURE, total — never throws. Returns undefined when input is absent/invalid
 * or would invent truth.
 *
 * Examples:
 * - `check: verified · done · settled`
 * - `check: unverified · answered · not settled (done-requires-check)`
 * - `check: failing · failed`
 * - `check: reviewed · done · settled (reviewed)`
 */
export function formatCompletionTruthChrome(
  cr: CompletionResultV1 | null | undefined,
): string | undefined {
  try {
    if (cr == null || typeof cr !== 'object') return undefined;
    if (cr.version !== 1) return undefined;
    if (typeof cr.terminal !== 'string' || cr.terminal.length === 0) return undefined;
    const verification = cr.verification;
    if (verification == null || typeof verification !== 'object') return undefined;
    if (typeof verification.status !== 'string' || verification.status.length === 0) {
      return undefined;
    }

    const status = verification.status as CompletionEvidenceStatus;
    const terminal = cr.terminal as CompletionTerminal;
    const settlement = cr.goalSettlement;
    const settled =
      settlement != null &&
      typeof settlement === 'object' &&
      settlement.allowed === true;

    const parts: string[] = [`check: ${statusLabel(status)}`, terminalLabel(terminal)];

    if (settled) {
      const how =
        settlement.reason === 'reviewed' || settlement.reason === 'verified'
          ? `settled (${settlement.reason})`
          : 'settled';
      parts.push(how);
    } else if (shouldNameUnsettled(status, terminal, settlement?.reason)) {
      const why =
        typeof settlement?.reason === 'string' && settlement.reason.trim().length > 0
          ? settlement.reason.trim()
          : undefined;
      parts.push(why !== undefined ? `not settled (${shortReason(why)})` : 'not settled');
    }

    // Surface doneCondition only when real and short enough to not bloat chrome.
    if (
      typeof cr.doneCondition === 'string' &&
      cr.doneCondition.trim().length > 0 &&
      cr.doneCondition.trim().length <= 48
    ) {
      parts.push(`doneWhen: ${cr.doneCondition.trim()}`);
    }

    const line = parts.join(' · ');
    return capChrome(line);
  } catch {
    return undefined;
  }
}

/**
 * Extract completion-truth chrome from a final-shaped object that may carry
 * `completionResult`. PURE; returns undefined when absent.
 */
export function completionTruthChromeFromFinal(final: {
  readonly completionResult?: CompletionResultV1;
} | null | undefined): string | undefined {
  try {
    if (final == null || typeof final !== 'object') return undefined;
    return formatCompletionTruthChrome(final.completionResult);
  } catch {
    return undefined;
  }
}

/**
 * Merge completion-truth honesty into a recap/orientation line when the last
 * completion was not fully verified/settled. Verified-settled turns leave the
 * orientation unchanged (no noise). PURE; never invents goals or verify claims.
 *
 * Returns null when both sides empty; orientation alone when chrome is clean
 * or absent; chrome alone when orientation empty and honesty needed.
 */
export function mergeCompletionTruthIntoOrientation(
  orientation: string | null | undefined,
  chrome: string | null | undefined,
): string | null {
  try {
    const orient =
      typeof orientation === 'string' ? orientation.replace(/\s+/g, ' ').trim() : '';
    const truth =
      typeof chrome === 'string' ? chrome.replace(/\s+/g, ' ').trim() : '';
    if (truth.length === 0) return orient.length > 0 ? orient : null;
    // Only surface when honesty is needed (unverified / not settled / failing).
    if (!needsHonestySurface(truth)) {
      return orient.length > 0 ? orient : null;
    }
    if (orient.length === 0) return truth;
    const merged = `${orient} · ${truth}`;
    return capChrome(merged) ?? merged;
  } catch {
    return typeof orientation === 'string' && orientation.trim().length > 0
      ? orientation.trim()
      : null;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function statusLabel(status: CompletionEvidenceStatus): string {
  switch (status) {
    case 'verified':
      return 'verified';
    case 'reviewed':
      return 'reviewed';
    case 'unverified':
      return 'unverified';
    case 'failing':
      return 'failing';
    case 'not-applicable':
      return 'n/a';
    default:
      return String(status);
  }
}

function terminalLabel(terminal: CompletionTerminal): string {
  return String(terminal);
}

function shouldNameUnsettled(
  status: CompletionEvidenceStatus,
  terminal: CompletionTerminal,
  reason: string | undefined,
): boolean {
  if (status === 'verified' || status === 'reviewed') {
    // Verified path that still did not settle (e.g. conflict) — name it.
    return reason === 'conflict-paths' || reason === 'done-requires-check';
  }
  // Unverified / failing / n/a on any terminal that looks like work completion.
  if (terminal === 'done' || terminal === 'answered' || terminal === 'failed' || terminal === 'blocked') {
    return true;
  }
  if (reason === 'done-requires-check') return true;
  return false;
}

function needsHonestySurface(chrome: string): boolean {
  const s = chrome.toLowerCase();
  return (
    s.includes('unverified') ||
    s.includes('not settled') ||
    s.includes('failing') ||
    s.includes('done-requires-check') ||
    s.includes('conflict')
  );
}

function shortReason(reason: string): string {
  const r = reason.replace(/\s+/g, ' ').trim();
  return r.length > 40 ? `${r.slice(0, 39).trimEnd()}…` : r;
}

function capChrome(text: string): string | undefined {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return undefined;
  if (s.length <= COMPLETION_TRUTH_CHROME_MAX_CHARS) return s;
  return `${s.slice(0, COMPLETION_TRUTH_CHROME_MAX_CHARS - 1).trimEnd()}…`;
}
