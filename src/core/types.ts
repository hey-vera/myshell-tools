/**
 * src/core/types.ts — shared types and ports for the orchestration core.
 *
 * This is the type hub. The pure core imports only types here (plus the
 * Provider port). I/O is reached exclusively through the injected port
 * interfaces below (Clock, SessionWriter, LedgerWriter), which infra
 * implements — that is what keeps `src/core/` free of fs/child_process while
 * remaining fully testable with fakes.
 *
 * Purity rule (enforced by test/arch/guards.test.ts): core code must obtain all
 * time, ids, and randomness from the injected `Clock`, never from Date/Math.
 */

import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import type { NativeSessionPlan } from './native-session.js';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Tier = 'worker' | 'ic' | 'manager';
export type Risk = 'low' | 'medium' | 'high' | 'critical';

export interface Classification {
  readonly tier: Tier;
  readonly risk: Risk;
  /** Human-readable reason the classifier chose this tier/risk. */
  readonly rationale: string;
}

/** A concrete routing decision: which provider+model runs a tier. */
export interface RouteDecision {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string; // concrete model id
}

/**
 * Result of assessing a model's output for real, verifiable signals.
 * `confidence` is null when the model emitted no parseable confidence envelope —
 * we never fabricate a number (Honesty Contract).
 */
export interface Assessment {
  readonly confidence: number | null;
  readonly escalate: boolean;
  readonly reason: string;
  readonly needsReview: boolean;
}

// ---------------------------------------------------------------------------
// Injected ports (infra implements these; core only sees the interfaces)
// ---------------------------------------------------------------------------

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** ISO-8601 timestamp string. */
  isoNow(): string;
  /** A unique identifier (uuid-like). */
  uuid(): string;
  /** A float in [0, 1). */
  random(): number;
}

export interface SessionEntry {
  readonly timestamp: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly tier?: Tier;
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly confidence?: number | null;
  readonly costUsd?: number;
  readonly durationMs?: number;
  /**
   * Provider-assigned native session/thread id for this turn, when the CLI
   * reported one (e.g. Codex thread id). Persisted in the append-only log so a
   * later turn can resume that provider's native session without a separate
   * store. Absent for providers that don't surface an id (Claude uses the
   * conversation id directly) or when native sessions are off.
   */
  readonly sessionId?: string;
}

export interface SessionWriter {
  readonly id: string;
  append(entry: SessionEntry): Promise<void>;
}

export interface LedgerEntry {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: Tier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly usd: number;
  readonly durationMs: number;
  readonly success: boolean;
}

export interface LedgerWriter {
  record(entry: LedgerEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Policy (thresholds & routing preferences; concrete values in policy.ts)
// ---------------------------------------------------------------------------

export interface Policy {
  /** Hard cap on tier attempts per task (loop/cost guard). */
  readonly maxAttempts: number;
  /** Escalate when self-reported confidence is strictly below this, indexed by risk. */
  readonly escalateBelowConfidence: Record<Risk, number>;
  /** Ordered provider preference per tier; route() honours availability. */
  readonly providerOrderByTier: Record<Tier, readonly ProviderId[]>;
  /**
   * Controls when cross-vendor review runs automatically.
   *
   * - `'auto'`          : review when risk is high/critical OR the model sets needsReview
   *                       (current default behaviour).
   * - `'critical-only'` : review only when risk is `critical` (or needsReview AND critical).
   * - `'off'`           : never trigger an automatic cross-vendor review.
   *
   * Omitting the field is equivalent to `'auto'` (backward-compatible).
   */
  readonly reviewPolicy?: 'auto' | 'critical-only' | 'off';
  /**
   * Per-task cost budget cap in USD.  When `totalCostUsd` reaches or exceeds
   * this value, orchestrate() stops spending (no new escalation, no new review)
   * and accepts the best result produced so far.
   *
   * `null` or `undefined` (the default) means no cap is applied.
   */
  readonly maxCostUsd?: number | null;
}

// ---------------------------------------------------------------------------
// Orchestration dependencies & event stream
// ---------------------------------------------------------------------------

export interface OrchestrateDeps {
  /** Available providers, keyed by id. Absent key = provider unavailable. */
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly clock: Clock;
  readonly session: SessionWriter;
  readonly ledger: LedgerWriter;
  readonly policy: Policy;
  readonly cwd: string;
  readonly sandbox: SandboxLevel;
  readonly timeoutMs: number;
  /**
   * Prior conversation history for context continuity. When provided, the most
   * recent turns are compacted and injected into the first provider prompt so
   * stateless one-shot providers (claude -p / codex exec) have multi-turn
   * awareness. Leave undefined for fresh (one-shot) sessions.
   */
  readonly history?: readonly SessionEntry[];
  /**
   * Advertised model lists from provider detection, keyed by provider id.
   * When supplied, route() restricts candidates to models that the provider CLI
   * actually advertises, preventing the CLI from routing to a model it cannot run.
   *
   * Absence (undefined) or an empty list for a provider → fall back to the
   * standard cheapest-for-tier pricing-table behaviour (backward-compatible).
   *
   * Only include providers that are installed; exactOptionalPropertyTypes is ON.
   */
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  /**
   * The set of provider IDs that are currently signed in (authenticated).
   *
   * When supplied and non-empty, route() prefers authenticated providers over
   * signed-out ones within the same tier, preventing wasted attempts against
   * providers that are installed but not logged in.
   *
   * When absent or empty → routing falls back to the existing fixed-preference-
   * order behaviour (backward-compatible).
   *
   * Only include providers whose `authenticated` flag is `true`; exactOptionalPropertyTypes is ON.
   */
  readonly authenticatedProviders?: readonly ProviderId[];
  /**
   * EXPERIMENTAL native session plans (opt-in via config.nativeSessions), one
   * per provider that has an active native session for this conversation. When
   * a turn routes to a provider that has a plan, orchestrate skips the replayed
   * history block and passes that provider's native session id instead, so the
   * provider carries prior context server-side. A turn routing to a provider
   * with no plan falls back to history replay (so switching providers is safe).
   *
   * Computed by the caller (the conversation layer) — absent for one-shot runs
   * and when the feature is disabled. See core/native-session.ts.
   */
  readonly nativeSession?: readonly NativeSessionPlan[];
}

/**
 * High-level events emitted by orchestrate(). The interface/render layer
 * consumes these; every field is a real measurement (no fabricated values).
 */
export type CoreEvent =
  | { readonly type: 'classified'; readonly classification: Classification }
  | {
      readonly type: 'tier-start';
      readonly tier: Tier;
      readonly provider: ProviderId;
      readonly model: string;
      readonly attempt: number;
    }
  | {
      readonly type: 'provider-event';
      readonly tier: Tier;
      readonly event: import('../providers/port.js').ProviderEvent;
    }
  | {
      readonly type: 'tier-done';
      readonly tier: Tier;
      readonly success: boolean;
      readonly confidence: number | null;
      /** Estimated USD — retained for the ledger and the on-demand `cost` view;
       *  NOT shown on the hot path (this is a subscription tool, not API-billed). */
      readonly costUsd: number;
      /** Real, measured token counts — the transparent primary signal shown live. */
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'escalate';
      readonly from: Tier;
      readonly to: Tier;
      readonly reason: string;
    }
  | {
      readonly type: 'failover';
      readonly from: ProviderId;
      readonly to: ProviderId;
      readonly tier: Tier;
      readonly reason: string;
    }
  | {
      readonly type: 'notice';
      readonly level: 'info' | 'warn' | 'error';
      readonly message: string;
    }
  | {
      readonly type: 'final';
      readonly success: boolean;
      readonly output: string;
      readonly tier: Tier;
      readonly totalCostUsd: number;
      readonly sessionId: string;
      readonly attempts: number;
      /** Set on failing finals only: the error category that caused the failure. */
      readonly errorCategory?: import('../providers/port.js').CliError['category'];
      /** Set on failing finals only: the provider that was being used when failure occurred. */
      readonly provider?: import('../providers/port.js').ProviderId;
    };
