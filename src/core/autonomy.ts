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

export type GoalConfidence =
  | { readonly kind: 'confident' }
  | { readonly kind: 'needs-clarification'; readonly missing: 'fork' }
  | {
      readonly kind: 'not-confident';
      readonly reason: 'no-stage' | 'no-goal' | 'no-done-when' | 'no-verification';
    };

export type GoalActivationOverride = 'adaptive' | 'go-when-confident' | 'always-plan-first';

export type GoalActivation =
  | { readonly kind: 'auto-run' }
  | { readonly kind: 'await-greenlight' }
  | { readonly kind: 'hold' };

/**
 * Detect an explicit standing preference for confident-goal activation.
 * Ordinary work requests and one-off sequencing language intentionally do not
 * match: this only recognizes clear persistent-policy phrasing.
 */
export function detectActivationOverride(line: string): GoalActivationOverride | null {
  const text = line.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (text.length === 0 || text.endsWith('?')) return null;

  if (
    /\b(?:back|go back|switch back|return) to adaptive\b/.test(text) ||
    /\buse (?:your )?best judgment(?: from now on)?\b/.test(text)
  ) {
    return 'adaptive';
  }

  if (
    /\b(?:always|from now on)\b.{0,40}\b(?:relay|show|share|give|present) (?:me )?(?:the )?plan first\b/.test(text) ||
    /\b(?:always|from now on)\b.{0,40}\brun it by me first\b/.test(text) ||
    /^run it by me first[.!]?$/.test(text)
  ) {
    return 'always-plan-first';
  }

  if (
    /\b(?:from now on|always|by default)\b.{0,40}\b(?:just go|go ahead|auto-run|run automatically)\b/.test(text) &&
    /\bconfident\b/.test(text)
  ) {
    return 'go-when-confident';
  }

  return null;
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

/**
 * Goal confidence gate.
 *
 * Confidence requires a staged work turn, a non-empty intended outcome, no
 * genuine owner-only fork, an explicit done-when, and a real verification
 * route. Missing done-when or verification parks the goal rather than turning
 * the gap into a fake question.
 */
export function assessGoalConfidence(input: {
  readonly hasWorkIntent: boolean;
  readonly plannerStaged: boolean;
  readonly goal: string;
  readonly hasGenuineFork: boolean;
  readonly hasDoneWhen: boolean;
  readonly verificationAvailable: boolean;
}): GoalConfidence {
  if (!input.hasWorkIntent || !input.plannerStaged) {
    return { kind: 'not-confident', reason: 'no-stage' };
  }
  if (input.goal.trim().length === 0) {
    return { kind: 'not-confident', reason: 'no-goal' };
  }
  if (input.hasGenuineFork) {
    return { kind: 'needs-clarification', missing: 'fork' };
  }
  if (!input.hasDoneWhen) {
    return { kind: 'not-confident', reason: 'no-done-when' };
  }
  if (!input.verificationAvailable) {
    return { kind: 'not-confident', reason: 'no-verification' };
  }
  return { kind: 'confident' };
}

/**
 * Goal activation policy.
 *
 * Activation is gated first by confidence, then by an explicit per-conversation
 * override. In adaptive mode, simple reversible `quick`/`build`/`explain` work
 * auto-runs; substantial, high-stakes, forked, or investigative work waits for
 * approval.
 */
export function decideGoalActivation(input: {
  readonly confident: boolean;
  readonly shape: 'quick' | 'risky' | 'decide' | 'investigate' | 'build' | 'explain';
  readonly substantial: boolean;
  readonly highStakes: boolean;
  readonly hasGenuineFork: boolean;
  readonly override: GoalActivationOverride;
}): GoalActivation {
  if (!input.confident) {
    return { kind: 'hold' };
  }
  if (input.override === 'always-plan-first') {
    return { kind: 'await-greenlight' };
  }
  if (input.override === 'go-when-confident') {
    return { kind: 'auto-run' };
  }
  const autoRun =
    (input.shape === 'quick' || input.shape === 'build' || input.shape === 'explain') &&
    !input.substantial &&
    !input.highStakes &&
    !input.hasGenuineFork;
  return autoRun ? { kind: 'auto-run' } : { kind: 'await-greenlight' };
}

function tierSignalCount(rationale: string): number {
  const match = /tier:\s+\w+\s+\(matched:\s+([^)]+)\)/.exec(rationale);
  if (match === null) return 0;
  const signals = match[1];
  if (signals === undefined) return 0;
  return signals.split(',').map((s) => s.trim()).filter((s) => s.length > 0).length;
}
