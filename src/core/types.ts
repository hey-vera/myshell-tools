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
      readonly costUsd: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'escalate';
      readonly from: Tier;
      readonly to: Tier;
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
    };
