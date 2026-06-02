/**
 * src/core/native-session.ts — pure planning for native provider session reuse.
 *
 * EXPERIMENTAL, opt-in (config.nativeSessions). The default path replays a
 * compacted history block into each turn's prompt so stateless `-p` invocations
 * have context. That is correct and provider-portable, but re-sends prior
 * context every turn. When enabled, and when consecutive turns of a conversation
 * hit the SAME provider, we can instead use the provider's native session
 * continuity (Claude `--session-id`/`--resume`) and skip the replayed history —
 * the provider already holds the prior context server-side.
 *
 * Scope: Claude only. Claude lets the caller CHOOSE the session id
 * (`--session-id <uuid>`), so we reuse the conversation id directly — no output
 * parsing or extra persistence needed. Codex generates its own ids (would need
 * capture + storage) and opencode is unconfirmed, so both stay on history replay
 * for now; this function returns a plan only for Claude.
 *
 * Cross-provider safety: if a turn routes to a DIFFERENT provider than the plan
 * names, orchestrate ignores the plan for that tier and falls back to history
 * replay — so switching providers never loses context.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import type { ProviderId } from '../providers/port.js';
import type { SessionEntry } from './types.js';

export interface NativeSessionPlan {
  /** The provider whose native session this plan continues. */
  readonly provider: ProviderId;
  /** The native session/thread id to pass to that provider. */
  readonly sessionId: string;
  /** true → continue an existing session (--resume); false → establish it. */
  readonly resume: boolean;
}

export interface PlanNativeSessionOpts {
  /** Whether native sessions are enabled (config.nativeSessions === true). */
  readonly enabled: boolean;
  /** The conversation id; used directly as the Claude session id. */
  readonly conversationId: string;
  /** Prior turns of this conversation (oldest first). */
  readonly history: readonly SessionEntry[];
}

/**
 * Find the most recent persisted native session id for a provider in the
 * conversation history (the id a prior turn captured from the provider CLI).
 */
function latestSessionId(
  history: readonly SessionEntry[],
  provider: ProviderId,
): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e?.role === 'assistant' && e.provider === provider && e.sessionId !== undefined && e.sessionId.length > 0) {
      return e.sessionId;
    }
  }
  return undefined;
}

/**
 * Build the native-session plans for the next turn — one per provider that can
 * continue a native session for this conversation.
 *
 * Two id models:
 *  - Claude lets us CHOOSE the session id, so we use the conversation id
 *    directly: establish it on the first Claude turn (`resume: false`), resume
 *    it thereafter (`resume: true`).
 *  - Codex GENERATES its own thread id, so we can only resume when a prior Codex
 *    turn captured one (persisted on its SessionEntry). No captured id → no plan
 *    (that turn establishes a fresh thread, captured for next time).
 *
 * Returns [] when disabled or no conversation id (e.g. the one-shot `run`).
 * Orchestrate falls back to history replay for any provider without a plan.
 */
export function planNativeSession(opts: PlanNativeSessionOpts): NativeSessionPlan[] {
  if (!opts.enabled) return [];
  if (opts.conversationId.length === 0) return [];

  const plans: NativeSessionPlan[] = [];

  // Claude: we own the id (the conversation id). resume once established.
  const priorClaude = opts.history.some((e) => e.role === 'assistant' && e.provider === 'claude');
  plans.push({ provider: 'claude', sessionId: opts.conversationId, resume: priorClaude });

  // Codex: resume only if a prior Codex turn captured a thread id.
  const codexId = latestSessionId(opts.history, 'codex');
  if (codexId !== undefined) {
    plans.push({ provider: 'codex', sessionId: codexId, resume: true });
  }

  return plans;
}
