/**
 * src/core/native-session.ts — pure planning for native provider session reuse.
 *
 * When enabled, and when consecutive turns of a conversation hit the SAME
 * compatible provider lineage, we can use the provider's native session
 * continuity (Claude `--session-id`/`--resume`, Codex captured thread id) and
 * skip the replayed history — the provider already holds prior context
 * server-side.
 *
 * Native sessions are only an execution cache. The visible myshell conversation
 * is canonical. Resume is allowed only for proven consecutive compatible
 * lineage (same provider, same account when known, model compatible). On
 * A→B→A, account mismatch, or model incompatibility, withhold native resume
 * so portable history is replayed — intervening context is never dropped.
 *
 * Scope: Claude (caller-chosen session id = conversation id) and Codex
 * (resume only when a prior turn captured a thread id). OpenCode/Grok stay
 * on history replay.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import type { ProviderId } from '../providers/port.js';
import type { SessionEntry } from './types.js';
import type { HistoryPolicy } from './turn-directive.js';

export interface NativeSessionPlan {
  /** The provider whose native session this plan continues. */
  readonly provider: ProviderId;
  /** The native session/thread id to pass to that provider. */
  readonly sessionId: string;
  /** true → continue an existing session (--resume); false → establish it. */
  readonly resume: boolean;
  /**
   * Optional concise reason when a plan is withheld by the lineage gate
   * (for transition receipts/telemetry — not user chat spam).
   */
  readonly withholdReason?: NativeLineageWithholdReason;
}

/** Why native resume was withheld (transition receipt / telemetry). */
export type NativeLineageWithholdReason =
  | 'provider-gap'
  | 'account-mismatch'
  | 'model-incompatible'
  | 'no-prior-native'
  | 'quarantined';

/**
 * Minimal history shape for lineage checks. SessionEntry is assignable;
 * optional accountId is accepted when callers persist/pass it (structural).
 */
export interface NativeLineageEntry {
  readonly role: 'user' | 'assistant' | 'system' | string;
  readonly provider?: ProviderId;
  readonly model?: string;
  /** Present when the turn recorded which subscription/account ran it. */
  readonly accountId?: string;
  readonly sessionId?: string;
}

export interface ShouldResumeNativeLineageInput {
  /** Prior turns (oldest first). */
  readonly history: readonly NativeLineageEntry[];
  /** Provider that would resume a native session this turn. */
  readonly provider: ProviderId;
  /**
   * Account selected for this turn, when known. Compared to the trailing
   * lineage account when that is also known; if either side is unknown, the
   * account check is skipped (fail-open on missing data).
   */
  readonly accountId?: string;
  /**
   * Model selected for this turn, when known. Documented rule: if both the
   * current model and the trailing lineage model are known and differ, treat
   * as incompatible (withhold resume). Same model or either unknown → OK.
   */
  readonly model?: string;
}

export interface ShouldResumeNativeLineageResult {
  readonly resume: boolean;
  readonly reason?: NativeLineageWithholdReason;
  /** Account observed on the trailing same-provider assistant, when any. */
  readonly lineageAccountId?: string;
  /** Model observed on the trailing same-provider assistant, when any. */
  readonly lineageModel?: string;
}

export interface PlanNativeSessionOpts {
  /** Whether native sessions are enabled (config.nativeSessions === true). */
  readonly enabled: boolean;
  /** The conversation id; used directly as the Claude session id. */
  readonly conversationId: string;
  /** Prior turns of this conversation (oldest first). */
  readonly history: readonly SessionEntry[];
  /**
   * The history-replay policy for THIS turn (AP2-F / Stage 6, §3 "Native session
   * caveat"). When `replayMode === 'quarantine_assistant_prose'` — a prior assistant
   * turn was a generic menu OR predates the enforced-ask engine version — the
   * provider's native session would resume its SERVER-SIDE memory of that poisoned/
   * legacy prose, re-introducing the old order-taker behavior past the cleaned
   * replay. So we WITHHOLD the native-session plan for that turn, forcing the
   * replayed/compact-state path (orchestrate falls back to history replay when no
   * plan is returned). This is a NARROW per-turn policy: a `normal`/absent policy
   * keeps native sessions behaving EXACTLY as before (the feature is not disabled
   * for clean turns). Absent → treated as `normal` (backward-compatible).
   */
  readonly historyPolicy?: HistoryPolicy;
  /**
   * Optional account for the upcoming turn (when known). Threaded into the
   * lineage gate so account switches withhold native resume.
   */
  readonly accountId?: string;
  /**
   * Optional model for the upcoming turn (when known). Threaded into the
   * lineage gate for model-compatibility checks.
   */
  readonly model?: string;
}

/**
 * Most recent assistant entry that has a provider id (skips user/system and
 * provider-less assistants).
 */
export function latestAssistantWithProvider(
  history: readonly NativeLineageEntry[],
): NativeLineageEntry | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e?.role === 'assistant' && e.provider !== undefined) {
      return e;
    }
  }
  return undefined;
}

/**
 * Whether models are compatible for native resume.
 *
 * Documented rule: resume only when both are unknown, or both are known and
 * equal (exact id match). Differing known models → incompatible. This is
 * intentionally strict — family-level aliases are a follow-on.
 */
export function modelsCompatibleForNativeResume(
  current: string | undefined,
  lineage: string | undefined,
): boolean {
  if (current === undefined || current.length === 0) return true;
  if (lineage === undefined || lineage.length === 0) return true;
  return current === lineage;
}

/**
 * Pure gate: may this turn resume a native provider session without dropping
 * intervening portable context?
 *
 * Resume only when consecutive compatible lineage holds:
 * 1. There is a prior assistant turn for this provider.
 * 2. The most recent assistant-with-provider is this same provider (A→A OK;
 *    A→B→A is a provider gap → no resume).
 * 3. When both current and lineage account ids are known, they match.
 * 4. When both current and lineage models are known, they are equal.
 *
 * Does not decide establish-vs-absent for first contact — only resume.
 */
export function shouldResumeNativeLineage(
  input: ShouldResumeNativeLineageInput,
): ShouldResumeNativeLineageResult {
  const { history, provider } = input;

  const priorSame = history.some(
    (e) => e.role === 'assistant' && e.provider === provider,
  );
  if (!priorSame) {
    return { resume: false, reason: 'no-prior-native' };
  }

  const latest = latestAssistantWithProvider(history);
  if (latest === undefined || latest.provider !== provider) {
    // A→B→A (or any intervening other provider): native session for A lacks B.
    return { resume: false, reason: 'provider-gap' };
  }

  const lineageAccountId =
    typeof latest.accountId === 'string' && latest.accountId.length > 0
      ? latest.accountId
      : undefined;
  const lineageModel =
    typeof latest.model === 'string' && latest.model.length > 0
      ? latest.model
      : undefined;

  const currentAccount =
    typeof input.accountId === 'string' && input.accountId.length > 0
      ? input.accountId
      : undefined;
  if (
    currentAccount !== undefined &&
    lineageAccountId !== undefined &&
    currentAccount !== lineageAccountId
  ) {
    return {
      resume: false,
      reason: 'account-mismatch',
      ...(lineageAccountId !== undefined ? { lineageAccountId } : {}),
      ...(lineageModel !== undefined ? { lineageModel } : {}),
    };
  }

  if (!modelsCompatibleForNativeResume(input.model, lineageModel)) {
    return {
      resume: false,
      reason: 'model-incompatible',
      ...(lineageAccountId !== undefined ? { lineageAccountId } : {}),
      ...(lineageModel !== undefined ? { lineageModel } : {}),
    };
  }

  return {
    resume: true,
    ...(lineageAccountId !== undefined ? { lineageAccountId } : {}),
    ...(lineageModel !== undefined ? { lineageModel } : {}),
  };
}

/**
 * Find the most recent persisted native session id for a provider in the
 * conversation history (the id a prior turn captured from the provider CLI),
 * restricted to the unbroken trailing same-provider assistant streak so an
 * older id from before a provider gap is never reused.
 */
function latestSessionIdInTrailingStreak(
  history: readonly NativeLineageEntry[],
  provider: ProviderId,
): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e?.role !== 'assistant' || e.provider === undefined) continue;
    if (e.provider !== provider) break;
    if (e.sessionId !== undefined && e.sessionId.length > 0) {
      return e.sessionId;
    }
  }
  return undefined;
}

/**
 * True when any assistant turn names a provider other than `provider`.
 */
function historyHasOtherProvider(
  history: readonly NativeLineageEntry[],
  provider: ProviderId,
): boolean {
  return history.some(
    (e) => e.role === 'assistant' && e.provider !== undefined && e.provider !== provider,
  );
}

/**
 * Build the native-session plans for the next turn — one per provider that can
 * continue a native session for this conversation.
 *
 * Two id models:
 *  - Claude lets us CHOOSE the session id, so we use the conversation id
 *    directly: establish it on the first Claude turn (`resume: false`) only when
 *    no other provider has spoken yet; resume only when
 *    {@link shouldResumeNativeLineage} allows.
 *  - Codex GENERATES its own thread id, so we can only resume when a prior Codex
 *    turn in the trailing compatible streak captured one.
 *
 * On A→B→A (or account/model incompatibility): no plan for the broken provider
 * → orchestrate/work-call fall back to history replay.
 *
 * Returns [] when disabled or no conversation id (e.g. the one-shot `run`).
 */
export function planNativeSession(opts: PlanNativeSessionOpts): NativeSessionPlan[] {
  if (!opts.enabled) return [];
  if (opts.conversationId.length === 0) return [];

  // STALE-HISTORY HARDENING (AP2-F / Stage 6, §3): on a quarantined turn, withhold
  // every native-session plan so orchestrate replays the CLEANED/compact history
  // instead of resuming the provider's server-side memory of poisoned/legacy prose.
  // Narrow + fail-soft: any other (or absent) policy plans natively as before.
  if (opts.historyPolicy?.replayMode === 'quarantine_assistant_prose') return [];

  const history = opts.history as readonly NativeLineageEntry[];
  const plans: NativeSessionPlan[] = [];

  const lineageInputBase = {
    history,
    ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  };

  // Claude: we own the id (the conversation id).
  const claudeLineage = shouldResumeNativeLineage({
    ...lineageInputBase,
    provider: 'claude',
  });
  if (claudeLineage.resume) {
    plans.push({
      provider: 'claude',
      sessionId: opts.conversationId,
      resume: true,
    });
  } else {
    const anyClaude = history.some(
      (e) => e.role === 'assistant' && e.provider === 'claude',
    );
    const otherProvider = historyHasOtherProvider(history, 'claude');
    // Establish only on first Claude contact in a single-provider (or empty)
    // conversation. After any other provider has spoken — or after a broken
    // Claude lineage — force the portable history path (no plan).
    if (!anyClaude && !otherProvider) {
      plans.push({
        provider: 'claude',
        sessionId: opts.conversationId,
        resume: false,
      });
    }
    // else: withheld (provider-gap / account / model / post-foreign establish)
  }

  // Codex: resume only with a thread id captured inside the trailing streak.
  const codexLineage = shouldResumeNativeLineage({
    ...lineageInputBase,
    provider: 'codex',
  });
  if (codexLineage.resume) {
    const codexId = latestSessionIdInTrailingStreak(history, 'codex');
    if (codexId !== undefined) {
      plans.push({ provider: 'codex', sessionId: codexId, resume: true });
    }
  }

  return plans;
}

/**
 * Defense-in-depth: given a candidate native plan and history, return the plan
 * only when lineage still allows resume (or non-resume establish). Otherwise
 * undefined so the caller forces history replay.
 *
 * `resume: false` establish plans are allowed only when no other provider has
 * spoken and there is no prior same-provider assistant (mirrors planner).
 */
export function filterNativePlanByLineage(input: {
  readonly plan: NativeSessionPlan | undefined;
  readonly history: readonly NativeLineageEntry[];
  readonly accountId?: string;
  readonly model?: string;
}): {
  readonly plan: NativeSessionPlan | undefined;
  readonly withholdReason?: NativeLineageWithholdReason;
} {
  const { plan, history } = input;
  if (plan === undefined) return { plan: undefined };

  // Fail-open when no history is available (one-shot / unit fixtures that inject
  // a plan without replaying conversation turns). The planner already applied the
  // gate when history was present; this filter only blocks on positive evidence
  // of a lineage break.
  const hasAssistantProvider = history.some(
    (e) => e.role === 'assistant' && e.provider !== undefined,
  );
  if (!hasAssistantProvider) return { plan };

  if (!plan.resume) {
    const anySame = history.some(
      (e) => e.role === 'assistant' && e.provider === plan.provider,
    );
    const other = historyHasOtherProvider(history, plan.provider);
    if (anySame || other) {
      return { plan: undefined, withholdReason: other ? 'provider-gap' : 'no-prior-native' };
    }
    return { plan };
  }

  const gate = shouldResumeNativeLineage({
    history,
    provider: plan.provider,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  });
  if (!gate.resume) {
    return {
      plan: undefined,
      ...(gate.reason !== undefined ? { withholdReason: gate.reason } : {}),
    };
  }
  return { plan };
}
