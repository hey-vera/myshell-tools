/**
 * Pure decision/signal helpers extracted from orchestrate.ts (behavior-preserving).
 * No I/O, no shared mutable state — deterministic.
 */

import type { Tier, Risk, Classification, Assessment, Policy } from './types.js';
import type { ProviderId } from '../providers/port.js';
import { selectReasoningEffort, type CapabilityTaskSignals } from './route.js';
import { findCapability, type CapabilityRegistry, type ReasoningEffort, type TaskKind } from './model-capabilities.js';
import { type Mode } from './policy.js';

// ---------------------------------------------------------------------------
// Pure helper: should this output be cross-vendor reviewed?
// ---------------------------------------------------------------------------

/**
 * Decides whether a cross-vendor review should be triggered, given the task
 * classification, assessment signals, and the active review policy.
 *
 * @param classification - Task classification (tier + risk).
 * @param assessment     - Model self-assessment (confidence, escalate, needsReview).
 * @param reviewPolicy   - Policy field; `undefined` is treated as `'auto'` for
 *                         backward compatibility.
 */
export function shouldReview(
  classification: Classification,
  assessment: Assessment,
  reviewPolicy: Policy['reviewPolicy'],
): boolean {
  // 'off' — never auto-review.
  if (reviewPolicy === 'off') return false;

  // 'critical-only' — review only when risk is critical.
  if (reviewPolicy === 'critical-only') {
    return classification.risk === 'critical';
  }

  // 'auto' (or undefined, treated as 'auto') — original behaviour.
  return (
    classification.risk === 'high' ||
    classification.risk === 'critical' ||
    assessment.needsReview === true
  );
}

// ---------------------------------------------------------------------------
// Pure helpers: capability task-signal derivation (capability registry §3).
// These are deterministic (no model call, no I/O) and feed the optional
// CapabilityRouteContext that activates capability-fit + reasoning-effort.
// ---------------------------------------------------------------------------

/** Keyword sets for deterministic taskKind classification. Lowercased matching. */
const ARCHITECTURE_KEYWORDS = [
  'architect', 'architecture', 'design', 'migration plan', 'rearchitect',
  'system design', 'tradeoff', 'trade-off', 'high-level plan', 'roadmap',
] as const;
const DEBUG_KEYWORDS = ['debug', 'bug', 'fix the', 'stack trace', 'why is', "doesn't work", 'failing test', 'broken'] as const;
const REVIEW_KEYWORDS = ['review', 'audit', 'critique', 'assess the', 'evaluate the'] as const;
const TRIVIAL_KEYWORDS = ['what is', 'list', 'show me', 'print', 'rename', 'typo'] as const;

/** True when any keyword is a substring of the lowercased text. PURE. */
function hasAnyKeyword(lowerText: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => lowerText.includes(k));
}

/**
 * The large-context engage threshold (tokens) at/above which a turn is classified
 * `large-context` from size alone. Mirrors route.ts's LARGE_CONTEXT_ENGAGE_TOKENS
 * intent (kept as a local constant so this module stays decoupled). PURE.
 */
const LARGE_CONTEXT_TASKKIND_TOKENS = 100_000;

/**
 * Derive a deterministic {@link TaskKind} from the existing classification signals
 * (tier + risk), the route plan flag, the task text keywords, the estimated input
 * size, and whether the review path will run. PURE, conservative: uncertain →
 * 'unknown' (never guessed). Mirrors §2 Layer 3 / §3 examples:
 *  - manager + architecture keywords → 'architecture'
 *  - review path / review keywords   → 'review'
 *  - big input estimate              → 'large-context'
 *  - debug keywords                  → 'debug'
 *  - else IC/manager substantial     → 'implementation'; trivial worker → 'trivial'
 */
export function deriveTaskKind(input: {
  readonly task: string;
  readonly tier: Tier;
  readonly risk: Risk;
  readonly routePlan: boolean;
  readonly estimatedInputTokens: number;
}): TaskKind {
  const lower = input.task.toLowerCase();
  // Large-context wins first when the input is genuinely huge — a big repo-map /
  // prompt is a large-context turn regardless of phrasing.
  if (input.estimatedInputTokens >= LARGE_CONTEXT_TASKKIND_TOKENS) return 'large-context';
  // Architecture: a manager-tier (or plan-first) turn with design/architecture
  // language. Restricting to manager/plan keeps a casual "design a logo" worker
  // turn from claiming architecture.
  if (
    (input.tier === 'manager' || input.routePlan) &&
    hasAnyKeyword(lower, ARCHITECTURE_KEYWORDS)
  ) {
    return 'architecture';
  }
  if (hasAnyKeyword(lower, REVIEW_KEYWORDS)) return 'review';
  if (hasAnyKeyword(lower, DEBUG_KEYWORDS)) return 'debug';
  if (input.tier === 'worker' && input.risk === 'low' && hasAnyKeyword(lower, TRIVIAL_KEYWORDS)) {
    return 'trivial';
  }
  if (input.tier === 'ic' || input.tier === 'manager') return 'implementation';
  // Worker turns with no clearer signal: don't over-claim — 'unknown'.
  return 'unknown';
}

/** Cheap deterministic token estimate ≈ chars/4 over the prompt-shaped inputs. PURE. */
export function estimateInputTokens(parts: ReadonlyArray<string | undefined>): number {
  let chars = 0;
  for (const p of parts) if (p !== undefined) chars += p.length;
  return Math.floor(chars / 4);
}

/**
 * Select the reasoning effort for a resolved RouteDecision against the merged
 * registry, returning `undefined` when the registry is absent, the chosen model
 * has no capability record, or the model declares no efforts. The chosen tier
 * (decision.tier) is the tier the policy ALREADY granted (after route()'s clamp /
 * admission), so passing it here can never open manager or exceed policy — the
 * selector only decides how deep to think within the granted tier. PURE.
 */
export function effortForDecision(
  registry: CapabilityRegistry | undefined,
  provider: ProviderId,
  model: string,
  tier: Tier,
  mode: Mode,
  signals: CapabilityTaskSignals,
): ReasoningEffort | undefined {
  if (registry === undefined) return undefined;
  const cap = findCapability(registry, provider, model);
  if (cap === undefined) return undefined;
  return selectReasoningEffort({
    model: cap,
    mode,
    tier,
    risk: signals.risk,
    taskKind: signals.taskKind,
    routePlan: signals.routePlan,
    ...(signals.difficulty !== undefined ? { difficulty: signals.difficulty } : {}),
  });
}
