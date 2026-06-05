/**
 * src/core/autonomy.ts — pure decisions for autonomy offers and auto-engage.
 *
 * No I/O, time, randomness, or provider imports. The interface layer owns
 * rendering and execution; this module only decides whether autonomy is allowed.
 */

import type { Classification } from './types.js';
import type { Mode } from './policy.js';

type AutonomyReason = 'multi_step';

export type AutonomyDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'auto_engage'; readonly reason: AutonomyReason };

export interface DecideAutonomyOfferOptions {
  readonly mode: Mode;
  readonly classification: Classification;
  readonly autoGoalEnabled: boolean;
}

/**
 * Auto-goal engagement policy.
 *
 * Explicit timeout and model keep-going offers live in the interface layer. This
 * pure helper decides only the opt-in auto-engage path: Max/quality-first,
 * enabled by config, and deterministic multi-step evidence (`manager` tier plus
 * at least two classifier tier signals).
 */
export function decideAutonomyOffer(opts: DecideAutonomyOfferOptions): AutonomyDecision {
  if (
    opts.mode === 'quality-first' &&
    opts.autoGoalEnabled &&
    opts.classification.tier === 'manager' &&
    tierSignalCount(opts.classification.rationale) >= 2
  ) {
    return { kind: 'auto_engage', reason: 'multi_step' };
  }
  return { kind: 'none' };
}

function tierSignalCount(rationale: string): number {
  const match = /tier:\s+\w+\s+\(matched:\s+([^)]+)\)/.exec(rationale);
  if (match === null) return 0;
  const signals = match[1];
  if (signals === undefined) return 0;
  return signals.split(',').map((s) => s.trim()).filter((s) => s.length > 0).length;
}
