/**
 * src/core/autonomy.ts — pure decisions for autonomy offers and auto-engage.
 *
 * No I/O, time, randomness, or provider imports. The interface layer owns
 * rendering and execution; this module only decides whether autonomy is allowed.
 */

import type { Classification, Tier } from './types.js';
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

export type PlanningDepth = 1 | 2;

export type PlanningSelectionEntitlement = 'locked' | 'unlocked';

export interface FirstPlanSelectionEvidence {
  readonly judgment: 'none' | 'stage' | 'clarify' | 'fallback';
  readonly substantialGoalMissingApproach: boolean;
  readonly nonTrivialGoalMissingDoneWhen: boolean;
  readonly capDropped: boolean;
  readonly genericFallbackOnly: boolean;
  readonly confidenceNoDoneWhen: boolean;
  readonly onlyGapIsNoVerification: boolean;
}

export interface PlanningSelectionScope {
  readonly shape: 'quick' | 'risky' | 'decide' | 'investigate' | 'build' | 'explain';
  readonly substantial: boolean;
  readonly repoOriented: boolean;
  readonly risk: 'low' | 'medium' | 'high' | 'critical';
  readonly engagementDepth: 0 | 1 | 2;
}

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

/**
 * Planning depth ceiling.
 *
 * Tuning can unlock deeper planning, but never force it: `quick` and `explain`
 * work stay at a single planning pass, and all other inputs combine by minimum.
 */
export function planningDepthCap(input: {
  readonly resolvedIntensity: 1 | 2 | 3 | 4 | 5;
  readonly callBudgetCeiling: 1 | 2 | 3;
  readonly shape: 'quick' | 'risky' | 'decide' | 'investigate' | 'build' | 'explain';
}): PlanningDepth {
  if (input.shape === 'quick' || input.shape === 'explain') return 1;

  const intensityCap: PlanningDepth = input.resolvedIntensity >= 3 ? 2 : 1;
  const callCap: PlanningDepth = input.callBudgetCeiling >= 2 ? 2 : 1;

  return Math.min(intensityCap, callCap) as PlanningDepth;
}

/**
 * Choose the shallowest sufficient initial planning depth from task scope.
 *
 * Resolved tuning does not appear here; callers pass the already-computed cap.
 */
export function chooseInitialPlanningDepth(input: {
  readonly cap: PlanningDepth;
  readonly shape: 'quick' | 'risky' | 'decide' | 'investigate' | 'build' | 'explain';
  readonly substantial: boolean;
  readonly repoOriented: boolean;
  readonly risk: 'low' | 'medium' | 'high' | 'critical';
  readonly engagementDepth: 0 | 1 | 2;
}): PlanningDepth {
  if (input.cap === 1) return 1;

  const groundingNeed =
    (input.repoOriented && input.substantial) ||
    input.shape === 'investigate' ||
    input.shape === 'risky' ||
    input.engagementDepth >= 2 ||
    input.risk === 'high' ||
    input.risk === 'critical';

  return groundingNeed ? 2 : 1;
}

/**
 * Planning-selection entitlement ceiling.
 *
 * Selection is unlocked only when the gate, tuning, call budget, governor
 * allowance, and provider availability all permit it.
 */
export function planningSelectionEntitlement(input: {
  readonly gateOn: boolean;
  readonly resolvedIntensity: 1 | 2 | 3 | 4 | 5;
  readonly turnCallBudget: 1 | 2 | 3;
  readonly panelAllowed: boolean;
  readonly authenticatedProviderCount: number;
}): PlanningSelectionEntitlement {
  const unlocked =
    input.gateOn &&
    input.resolvedIntensity >= 4 &&
    input.turnCallBudget >= 3 &&
    input.panelAllowed &&
    input.authenticatedProviderCount >= 2;
  return unlocked ? 'unlocked' : 'locked';
}

/**
 * Decide whether multi-brain planning selection should run.
 *
 * Tuning appears only through entitlement: this need check looks first for
 * absolute exclusions, then requires both a plan-fixable deficiency and a
 * genuinely hard or high-stakes goal.
 */
export function shouldRunPlanningSelection(input: {
  readonly entitlement: PlanningSelectionEntitlement;
  readonly scope: PlanningSelectionScope;
  readonly firstPlan: FirstPlanSelectionEvidence;
}): boolean {
  if (input.entitlement === 'locked') return false;
  const s = input.scope;
  const f = input.firstPlan;

  if (s.shape === 'quick' || s.shape === 'explain') return false;
  if ((s.risk === 'low' || s.risk === 'medium') && !s.substantial && s.shape === 'build') return false;
  if (f.judgment === 'clarify' || f.judgment === 'none') return false;
  if (f.onlyGapIsNoVerification) return false;

  const deficiency =
    f.judgment === 'fallback' ||
    f.substantialGoalMissingApproach ||
    f.nonTrivialGoalMissingDoneWhen ||
    f.capDropped ||
    f.genericFallbackOnly ||
    f.confidenceNoDoneWhen;
  if (!deficiency) return false;

  const hard =
    s.shape === 'risky' ||
    s.shape === 'investigate' ||
    (s.shape === 'decide' && s.substantial) ||
    s.risk === 'high' ||
    s.risk === 'critical' ||
    (s.repoOriented && s.substantial) ||
    s.engagementDepth >= 2;

  return hard;
}

/**
 * Planner tier ceiling from resolved tuning intensity.
 *
 * Lower tuning keeps planning on the cheaper IC tier. Only intensity 4-5 can
 * permit the stronger manager planner tier.
 */
export function plannerTierCeiling(resolvedIntensity: 1 | 2 | 3 | 4 | 5): Extract<Tier, 'ic' | 'manager'> {
  return resolvedIntensity >= 4 ? 'manager' : 'ic';
}

/**
 * Whether the task genuinely needs the stronger planner tier.
 *
 * This need predicate is tuning-independent. It only reflects hard scope or a
 * substantial decision task with a plan-fixable deficiency.
 */
export function needStrongPlanner(input: {
  readonly scope: PlanningSelectionScope;
  readonly planFixableDeficiency: boolean;
}): boolean {
  const s = input.scope;
  return (
    s.risk === 'high' ||
    s.risk === 'critical' ||
    s.shape === 'risky' ||
    s.shape === 'investigate' ||
    (s.shape === 'decide' && s.substantial && input.planFixableDeficiency)
  );
}

/**
 * Choose the planner tier after applying the tuning ceiling.
 *
 * Need can request manager, but low tuning still clamps to IC. Absent need,
 * planning stays on the cheaper IC tier even at maximum tuning.
 */
export function choosePlannerTier(input: {
  readonly resolvedIntensity: 1 | 2 | 3 | 4 | 5;
  readonly needStrongPlanner: boolean;
}): Extract<Tier, 'ic' | 'manager'> {
  const ceiling = plannerTierCeiling(input.resolvedIntensity);
  return input.needStrongPlanner && ceiling === 'manager' ? 'manager' : 'ic';
}

/**
 * Human-readable label for the selected planning depth.
 */
export function planningDepthReason(depth: PlanningDepth): string {
  return depth === 1 ? 'single planning pass' : 'grounded planning pass';
}

function tierSignalCount(rationale: string): number {
  const match = /tier:\s+\w+\s+\(matched:\s+([^)]+)\)/.exec(rationale);
  if (match === null) return 0;
  const signals = match[1];
  if (signals === undefined) return 0;
  return signals.split(',').map((s) => s.trim()).filter((s) => s.length > 0).length;
}
