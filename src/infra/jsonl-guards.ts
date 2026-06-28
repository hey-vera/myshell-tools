/**
 * Runtime guards for persisted JSONL records.
 *
 * JSON.parse only proves syntax. These guards keep wrong-shape but valid JSON
 * records from poisoning resume history or usage summaries.
 */

import type { LedgerEntry, SessionEntry, Tier, Risk } from '../core/types.js';
import type { ProviderId } from '../providers/port.js';
import type { IntentVersion } from '../core/intent-version.js';

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

function isRoadmapStatus(value: unknown): boolean {
  return value === 'pending' || value === 'active' || value === 'done' || value === 'blocked';
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRoadmapItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string') return false;
  if (typeof value['text'] !== 'string') return false;
  if (!isRoadmapStatus(value['status'])) return false;
  return true;
}

function isCheckpoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string') return false;
  if (typeof value['summary'] !== 'string') return false;
  if (!isOptionalString(value['roadmapId'])) return false;
  if (!isOptionalString(value['evidence'])) return false;
  return true;
}

function isVerification(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value['verdict'] !== 'approve' &&
    value['verdict'] !== 'revise' &&
    value['verdict'] !== 'escalate'
  ) {
    return false;
  }
  if (!isOptionalString(value['notes'])) return false;
  const failedCheckpointIds = value['failedCheckpointIds'];
  if (failedCheckpointIds !== undefined && !isStringArray(failedCheckpointIds)) return false;
  return true;
}

export function isWorkTrace(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['version'] !== 1) return false;
  if (typeof value['objective'] !== 'string') return false;
  if (!isOptionalString(value['vision'])) return false;

  const roadmap = value['roadmap'];
  if (roadmap !== undefined) {
    if (!Array.isArray(roadmap) || !roadmap.every(isRoadmapItem)) return false;
  }

  const checkpoints = value['checkpoints'];
  if (checkpoints !== undefined) {
    if (!Array.isArray(checkpoints) || !checkpoints.every(isCheckpoint)) return false;
  }

  const verification = value['verification'];
  if (verification !== undefined && !isVerification(verification)) return false;

  return true;
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
  if (value['workTrace'] !== undefined && !isWorkTrace(value['workTrace'])) return false;
  // Optional engine BEHAVIOR version marker (AP2-F / Stage 6). Absent on legacy/
  // pre-fix entries — that is the valid "pre-fix" default and still loads. When
  // present it must be a finite number; a non-finite/non-number value fails the
  // guard (the entry is dropped) rather than being silently coerced — same
  // discipline as confidence/costUsd above. Backward-compatible by construction.
  const engineBehaviorVersion = value['engineBehaviorVersion'];
  if (
    engineBehaviorVersion !== undefined &&
    (typeof engineBehaviorVersion !== 'number' || !Number.isFinite(engineBehaviorVersion))
  ) {
    return false;
  }
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
  const cacheWrite = value['cacheWriteInputTokens'];
  if (cacheWrite !== undefined) {
    if (typeof cacheWrite !== 'number' || !Number.isFinite(cacheWrite)) return false;
  }
  const stage = value['stage'];
  if (
    stage !== undefined &&
    stage !== 'work' &&
    stage !== 'route' &&
    stage !== 'intent' &&
    stage !== 'reextract-web' &&
    stage !== 'reextract-local' &&
    stage !== 'recap' &&
    stage !== 'understanding' &&
    stage !== 'autostage' &&
    stage !== 'review' &&
    stage !== 'judgment' &&
    stage !== 'tribunal' &&
    stage !== 'escalation'
  ) return false;

  const intentVersionId = value['intentVersionId'];
  if (
    intentVersionId !== undefined &&
    (typeof intentVersionId !== 'string' || intentVersionId.trim().length === 0)
  ) return false;
  if (typeof value['usd'] !== 'number' || !Number.isFinite(value['usd'])) return false;
  if (typeof value['durationMs'] !== 'number' || !Number.isFinite(value['durationMs'])) {
    return false;
  }
  if (typeof value['success'] !== 'boolean') return false;
  // Optional accountId for OpenCode account-routed calls. Absent on old entries
  // and non-account paths. When present it must be a non-empty string.
  const accountId = value['accountId'];
  if (
    accountId !== undefined &&
    (typeof accountId !== 'string' || accountId.trim().length === 0)
  ) return false;
  // Optional capability-registry effort (Stage 3). Absent on old entries; when
  // present it must be a known reasoning-effort string.
  const effort = value['reasoningEffort'];
  if (
    effort !== undefined &&
    effort !== 'none' &&
    effort !== 'low' &&
    effort !== 'medium' &&
    effort !== 'high' &&
    effort !== 'xhigh'
  ) {
    return false;
  }
  // Optional capability-registry task kind (Stage 4). Absent on old entries; when
  // present it must be a known TaskKind string. An unknown string fails the guard
  // (the entry is dropped) rather than being silently coerced — same discipline as
  // reasoningEffort above.
  const taskKind = value['taskKind'];
  if (
    taskKind !== undefined &&
    taskKind !== 'trivial' &&
    taskKind !== 'implementation' &&
    taskKind !== 'debug' &&
    taskKind !== 'review' &&
    taskKind !== 'architecture' &&
    taskKind !== 'large-context' &&
    taskKind !== 'judgment' &&
    taskKind !== 'unknown'
  ) {
    return false;
  }
  return true;
}

function isIntentConfidence(value: unknown): boolean {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isIntentSource(value: unknown): boolean {
  return value === 'model' || value === 'rules-fallback' || value === 'skipped';
}

function isRisk(value: unknown): value is Risk {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

export function isIntentVersion(value: unknown): value is IntentVersion {
  if (!isRecord(value)) return false;
  if (value['version'] !== 1) return false;
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false;
  const parentId = value['parentId'];
  if (
    parentId !== undefined &&
    parentId !== null &&
    (typeof parentId !== 'string' || parentId.trim().length === 0)
  ) return false;
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].trim().length === 0) return false;
  if (typeof value['createdAt'] !== 'string' || value['createdAt'].trim().length === 0) return false;
  if (
    typeof value['rawUserTurnText'] !== 'string' ||
    value['rawUserTurnText'].trim().length === 0
  ) return false;

  const intent = value['intent'];
  if (!isRecord(intent)) return false;
  if (typeof intent['objective'] !== 'string' || intent['objective'].trim().length === 0) return false;

  if (intent['assumptions'] !== undefined && !isStringArray(intent['assumptions'])) return false;
  if (intent['constraints'] !== undefined && !isStringArray(intent['constraints'])) return false;
  if (intent['nonGoals'] !== undefined && !isStringArray(intent['nonGoals'])) return false;
  if (intent['doneCriteria'] !== undefined && typeof intent['doneCriteria'] !== 'string') return false;
  if (intent['risk'] !== undefined && !isRisk(intent['risk'])) return false;
  if (intent['confidence'] !== undefined && !isIntentConfidence(intent['confidence'])) return false;
  if (intent['source'] !== undefined && !isIntentSource(intent['source'])) return false;

  return true;
}
