/**
 * src/core/turn-routing-receipt.ts — pure end-of-turn "visible dispatch" line.
 *
 * One compact chrome line after a finished turn so the user can see *who ran
 * it* and *why*, without dumping full RouteTrace or inventing $ costs:
 *
 *   provider · model · effort · account? · why
 *
 * PURE: no I/O, no time, no secrets. Missing fields are omitted (never
 * fabricated). Returns '' when there is nothing truthful to show.
 *
 * @see docs/partner-principles-absorb-2026-07-09.md — Visible dispatch / PR-B
 */

/** Cap on the free-text reason segment (keep the line scannable). */
const REASON_MAX_CHARS = 72;

/**
 * Fields for one turn routing receipt. Every field is optional and honestly
 * absent when unknown — the formatter never invents provider/model/effort/
 * account/reason.
 *
 * `accountLabel` is preferred over raw `accountId` (ids may be opaque UUIDs).
 * Never pass secrets, tokens, env, or home paths into these fields.
 */
export interface TurnRoutingReceiptInput {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Human account label (preferred). */
  readonly accountLabel?: string;
  /** Fallback account id when no label is available (never a secret/token). */
  readonly accountId?: string;
  /** Short why: auto-brain reason, first capabilityReasons entry, or strategy. */
  readonly reason?: string;
}

/**
 * Format a single visible-dispatch receipt line from actual run fields.
 * PURE, total — never throws. Returns '' when no useful field is present.
 *
 * Example: `claude · claude-opus-4 · high · work — multi-file refactor`
 */
export function formatTurnRoutingReceipt(input: TurnRoutingReceiptInput): string {
  try {
    if (input == null || typeof input !== 'object') return '';

    const provider = cleanSegment(input.provider);
    const model = cleanSegment(input.model);
    // Need at least who (provider or model) — effort/account/reason alone is not
    // a routing receipt (would invent "who" by omission).
    if (provider === undefined && model === undefined) return '';

    const parts: string[] = [];
    if (provider !== undefined) parts.push(provider);
    if (model !== undefined) parts.push(model);

    const effort = cleanSegment(input.reasoningEffort);
    if (effort !== undefined) parts.push(effort);

    const account =
      cleanSegment(input.accountLabel) ?? cleanSegment(input.accountId);
    if (account !== undefined) parts.push(account);

    // Reasons are free text (rationale prose) — skip secret heuristics that
    // would strip long alphanumeric blobs; still refuse explicit key prefixes.
    const reason = truncateReason(cleanReason(input.reason));
    if (reason !== undefined) {
      return `${parts.join(' \u00b7 ')} \u2014 ${reason}`;
    }
    return parts.join(' \u00b7 ');
  } catch {
    return '';
  }
}

/**
 * Build a receipt string from a run-shaped object (accepted run / candidate /
 * final fields). Returns undefined when the line would be empty so callers can
 * omit the field entirely (no empty string pollution on CoreEvent).
 * PURE, total — never throws.
 */
export function routingReceiptFromRun(run: {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly accountLabel?: string;
  readonly accountId?: string;
  readonly routeReason?: string;
  readonly reason?: string;
}): string | undefined {
  try {
    if (run == null || typeof run !== 'object') return undefined;
    const line = formatTurnRoutingReceipt({
      ...(run.provider !== undefined ? { provider: run.provider } : {}),
      ...(run.model !== undefined ? { model: run.model } : {}),
      ...(run.reasoningEffort !== undefined
        ? { reasoningEffort: run.reasoningEffort }
        : {}),
      ...(run.accountLabel !== undefined ? { accountLabel: run.accountLabel } : {}),
      ...(run.accountId !== undefined ? { accountId: run.accountId } : {}),
      ...(run.routeReason !== undefined
        ? { reason: run.routeReason }
        : run.reason !== undefined
          ? { reason: run.reason }
          : {}),
    });
    return line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function cleanSegment(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return undefined;
  // Hard refuse anything that looks like a secret/token leak into chrome.
  if (looksLikeSecret(trimmed)) return undefined;
  return trimmed;
}

function cleanReason(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return undefined;
  // Only refuse explicit key prefixes — long rationales are normal prose.
  if (/^(sk-|rk-|pk-|xai-|Bearer\s)/i.test(trimmed)) return undefined;
  if (/^(ghp_|gho_|github_pat_)/i.test(trimmed)) return undefined;
  return trimmed;
}

function truncateReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= REASON_MAX_CHARS) return value;
  return `${value.slice(0, REASON_MAX_CHARS - 1).trimEnd()}\u2026`;
}

/**
 * Conservative secret heuristics — never surface API keys / bearer tokens /
 * long hex blobs as a "routing" field. Account UUIDs and short model ids pass.
 */
function looksLikeSecret(value: string): boolean {
  if (/^(sk-|rk-|pk-|xai-|Bearer\s)/i.test(value)) return true;
  if (/^(ghp_|gho_|github_pat_)/i.test(value)) return true;
  // Long contiguous base64-ish or hex blobs are not human account labels.
  if (value.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(value) && !value.includes('-')) {
    return true;
  }
  return false;
}
