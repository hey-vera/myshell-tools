/**
 * Runtime guards for persisted JSONL records.
 *
 * JSON.parse only proves syntax. These guards keep wrong-shape but valid JSON
 * records from poisoning resume history or usage summaries.
 */

import type { LedgerEntry, SessionEntry, Tier } from '../core/types.js';
import type { ProviderId } from '../providers/port.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTier(value: unknown): value is Tier {
  return value === 'worker' || value === 'ic' || value === 'manager';
}

function isProviderId(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value)) return false;
  if (typeof value['timestamp'] !== 'string') return false;
  if (
    value['role'] !== 'user' &&
    value['role'] !== 'assistant' &&
    value['role'] !== 'system'
  ) {
    return false;
  }
  if (typeof value['content'] !== 'string') return false;
  if (value['tier'] !== undefined && !isTier(value['tier'])) return false;
  if (value['provider'] !== undefined && !isProviderId(value['provider'])) return false;
  if (!isOptionalString(value['model'])) return false;
  const confidence = value['confidence'];
  if (confidence !== undefined && confidence !== null) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return false;
  }
  if (!isOptionalNumber(value['costUsd'])) return false;
  if (!isOptionalNumber(value['durationMs'])) return false;
  if (!isOptionalString(value['sessionId'])) return false;
  return true;
}

export function isConversationMessage(value: unknown): value is SessionEntry {
  return isSessionEntry(value);
}

export function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isRecord(value)) return false;
  if (typeof value['timestamp'] !== 'string') return false;
  if (typeof value['sessionId'] !== 'string') return false;
  if (typeof value['taskId'] !== 'string') return false;
  if (!isProviderId(value['provider'])) return false;
  if (typeof value['model'] !== 'string') return false;
  if (!isTier(value['tier'])) return false;
  if (typeof value['inputTokens'] !== 'number' || !Number.isFinite(value['inputTokens'])) {
    return false;
  }
  if (typeof value['outputTokens'] !== 'number' || !Number.isFinite(value['outputTokens'])) {
    return false;
  }
  if (
    typeof value['cachedInputTokens'] !== 'number' ||
    !Number.isFinite(value['cachedInputTokens'])
  ) {
    return false;
  }
  if (typeof value['usd'] !== 'number' || !Number.isFinite(value['usd'])) return false;
  if (typeof value['durationMs'] !== 'number' || !Number.isFinite(value['durationMs'])) {
    return false;
  }
  if (typeof value['success'] !== 'boolean') return false;
  return true;
}
