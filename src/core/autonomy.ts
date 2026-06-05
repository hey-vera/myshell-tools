/**
 * src/core/autonomy.ts — pure decisions for autonomy offers and auto-engage.
 *
 * No I/O, time, randomness, or provider imports. The interface layer owns
 * rendering and execution; this module only decides whether autonomy is allowed.
 */

import type { Classification } from './types.js';
import type { Mode } from './policy.js';

type AutonomyReason = 'timeout' | 'keep_going' | 'multi_step';

export type AutonomyDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'offer'; readonly reason: AutonomyReason }
  | { readonly kind: 'auto_engage'; readonly reason: AutonomyReason };

export interface DecideAutonomyOfferOptions {
  readonly mode: Mode;
  readonly classification: Classification;
  readonly routePlan: boolean;
  readonly finalErrorCategory?: string;
  readonly keepGoingOffered: boolean;
  readonly autoGoalEnabled: boolean;
}

/**
 * Central autonomy policy.
 *
 * Existing explicit offers are preserved for all modes: a timeout or model
 * keep-going offer still asks the user before entering the goal loop. The new
 * auto-engage path is stricter: only Max/quality-first, opt-in, and corroborated
 * multi-step work (`manager` tier plus route `plan:true` or at least two
 * classifier tier signals) can start `/goal` without a Y/n.
 */
export function decideAutonomyOffer(opts: DecideAutonomyOfferOptions): AutonomyDecision {
  if (opts.finalErrorCategory === 'timeout') {
    return { kind: 'offer', reason: 'timeout' };
  }
  if (opts.keepGoingOffered) {
    return { kind: 'offer', reason: 'keep_going' };
  }
  if (
    opts.mode === 'quality-first' &&
    opts.autoGoalEnabled &&
    opts.classification.tier === 'manager' &&
    (opts.routePlan || tierSignalCount(opts.classification.rationale) >= 2)
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
