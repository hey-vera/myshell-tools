/**
 * src/core/blocked.ts — pure BlockedRecord type and builder for
 * MYSHELL_BLOCKED_STATE_V1 (PR4).
 *
 * A blocked record is a first-class terminal distinct from `failed`, carrying
 * an honest reason, a suggested next action, and a statement of preserved work.
 * Validation: all required strings must trim non-empty.
 *
 * PURE: no I/O, no side effects, never throws.
 */

export type BlockedReasonCode =
  | 'missing_authority'
  | 'intent_unclear'
  | 'verification_failed'
  | 'environment_unavailable'
  | 'quota_exhausted'
  | 'risk_requires_approval'
  | 'dependency_blocked';

export interface BlockedRecord {
  readonly reason: string;
  readonly nextAction: string;
  readonly preservedWork: string;
  readonly code?: BlockedReasonCode;
}

const VALID_CODES: ReadonlySet<string> = new Set<BlockedReasonCode>([
  'missing_authority',
  'intent_unclear',
  'verification_failed',
  'environment_unavailable',
  'quota_exhausted',
  'risk_requires_approval',
  'dependency_blocked',
]);

/**
 * Build a valid BlockedRecord from an input shape.
 * Returns null when any required string trims empty.
 */
export function buildBlockedRecord(input: {
  reason: string;
  nextAction: string;
  preservedWork: string;
  code?: string;
}): BlockedRecord | null {
  const reason = (input.reason ?? '').trim();
  const nextAction = (input.nextAction ?? '').trim();
  const preservedWork = (input.preservedWork ?? '').trim();

  if (reason.length === 0 || nextAction.length === 0 || preservedWork.length === 0) {
    return null;
  }

  const code =
    typeof input.code === 'string' && VALID_CODES.has(input.code)
      ? (input.code as BlockedReasonCode)
      : undefined;

  const record: BlockedRecord = { reason, nextAction, preservedWork };
  if (code !== undefined) {
    (record as { code?: BlockedReasonCode }).code = code;
  }
  return record;
}

/**
 * Type guard for BlockedRecord. Checks that the three required strings are
 * non-empty strings and that an optional code (if present) is a valid code.
 */
export function isBlockedRecord(value: unknown): value is BlockedRecord {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r['reason'] !== 'string' || r['reason'].trim().length === 0) return false;
  if (typeof r['nextAction'] !== 'string' || r['nextAction'].trim().length === 0) return false;
  if (typeof r['preservedWork'] !== 'string' || r['preservedWork'].trim().length === 0) return false;
  if (r['code'] !== undefined && !VALID_CODES.has(r['code'] as string)) return false;
  return true;
}
