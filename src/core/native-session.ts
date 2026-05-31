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
  /** The provider whose native session we intend to continue (Claude only). */
  readonly provider: ProviderId;
  /** Stable session id — the conversation id (a UUID Claude accepts). */
  readonly sessionId: string;
  /** true → continue an existing session (--resume); false → establish (--session-id). */
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
 * Decide whether to use Claude native session continuity for the next turn.
 *
 * Returns a plan only when enabled and a conversation id is present. `resume` is
 * true iff a prior Claude assistant turn already exists in this conversation
 * (so the session was established on an earlier turn); otherwise the next turn
 * establishes the session with our chosen id.
 *
 * Returns null when disabled or when no conversation id is available (e.g. the
 * one-shot `run` command), in which case orchestrate keeps the history-replay
 * behavior unchanged.
 */
export function planNativeSession(opts: PlanNativeSessionOpts): NativeSessionPlan | null {
  if (!opts.enabled) return null;
  if (opts.conversationId.length === 0) return null;

  const priorClaudeTurn = opts.history.some(
    (e) => e.role === 'assistant' && e.provider === 'claude',
  );

  return {
    provider: 'claude',
    sessionId: opts.conversationId,
    resume: priorClaudeTurn,
  };
}
