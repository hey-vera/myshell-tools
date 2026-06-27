/**
 * src/core/intent-version.ts — pure IntentVersion model, builder, and writer
 * interface for MYSHELL_INTENT_STORE_V1 (PR3).
 *
 * The intent-version is an append-only snapshot of a single captured turn intent,
 * keyed by the same `intentVersionId` that PR2's ledger correlation uses. This
 * module is PURE: no I/O, no side effects.
 */

import type { Risk } from './types.js';
import type { IntentConfidence, IntentFrame } from './intent.js';

export interface IntentVersion {
  readonly version: 1;
  readonly id: string;
  readonly parentId?: string | null;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly rawUserTurnText: string;
  readonly intent: {
    readonly objective: string;
    readonly assumptions?: readonly string[];
    readonly constraints?: readonly string[];
    readonly nonGoals?: readonly string[];
    readonly doneCriteria?: string;
    readonly risk?: Risk;
    readonly confidence?: IntentConfidence;
    readonly source?: IntentFrame['source'];
  };
}

/** Append-only writer port — the store must persist one line per call. */
export interface IntentStoreWriter {
  append(version: IntentVersion): Promise<void>;
}

export interface BuildIntentVersionInput {
  readonly id: string;
  readonly parentId?: string | null;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly rawUserTurnText: string;
  readonly frame: IntentFrame;
  readonly risk?: Risk;
}

/**
 * Build a valid IntentVersion from the settled turn data.
 *
 * Guards: requires non-empty `id`, `sessionId`, `createdAt`, `rawUserTurnText`,
 * and objective. If the objective is empty, returns `null` so the caller skips
 * the write. Omit empty optional fields (never set to `undefined`).
 *
 * PURE, never throws.
 */
export function buildIntentVersion(
  input: BuildIntentVersionInput,
): IntentVersion | null {
  const { id, parentId, sessionId, createdAt, rawUserTurnText, frame, risk } = input;

  if (
    typeof id !== 'string' ||
    id.trim().length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.trim().length === 0 ||
    typeof createdAt !== 'string' ||
    createdAt.trim().length === 0 ||
    typeof rawUserTurnText !== 'string' ||
    rawUserTurnText.trim().length === 0
  ) {
    return null;
  }

  const objective = frame.goal?.trim();
  if (objective === undefined || objective.length === 0) {
    return null;
  }

  const assumptions: string[] = [];
  if (frame.forks !== undefined) {
    for (const fork of frame.forks) {
      const a = fork.assumeIfUnasked;
      if (typeof a === 'string' && a.trim().length > 0) {
        assumptions.push(a);
      }
    }
  }

  const constraints =
    frame.constraints !== undefined && frame.constraints.length > 0
      ? frame.constraints
      : undefined;

  const nonGoals =
    frame.nonGoals !== undefined && frame.nonGoals.length > 0
      ? frame.nonGoals
      : undefined;

  const doneCriteria = frame.doneWhen?.trim();
  const resolvedRisk: Risk | undefined =
    frame.operationRisk ?? frame.blastRadius ?? risk;

  const version: IntentVersion = {
    version: 1,
    id,
    sessionId,
    createdAt,
    rawUserTurnText,
    intent: {
      objective,
      ...(assumptions.length > 0 ? { assumptions } : {}),
      ...(constraints !== undefined ? { constraints } : {}),
      ...(nonGoals !== undefined ? { nonGoals } : {}),
      ...(doneCriteria !== undefined && doneCriteria.length > 0
        ? { doneCriteria }
        : {}),
      ...(resolvedRisk !== undefined ? { risk: resolvedRisk } : {}),
      ...(frame.confidence !== undefined
        ? { confidence: frame.confidence }
        : {}),
      ...(frame.source !== undefined ? { source: frame.source } : {}),
    },
    ...(parentId !== undefined
      ? parentId !== null
        ? { parentId }
        : { parentId: null }
      : {}),
  };

  return version;
}
