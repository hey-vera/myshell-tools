import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout } from './state-layout.js';

export interface RelaunchAttempt {
  readonly at: string;
  readonly pid: number;
  readonly conversationId: string;
  readonly reason: string;
}

export interface RelaunchRecoveryState {
  readonly version: 1;
  readonly attempts: readonly RelaunchAttempt[];
}

export interface RelaunchGuardResult {
  readonly allowed: boolean;
  readonly reason: 'allowed' | 'per-conversation-limit' | 'global-limit';
  readonly attemptsInWindow: number;
  readonly conversationAttemptsInWindow: number;
}

const PER_CONVERSATION_LIMIT = 2;
const PER_CONVERSATION_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_LIMIT = 3;
const GLOBAL_WINDOW_MS = 30 * 60 * 1000;
const PRUNE_WINDOW_MS = 30 * 60 * 1000;

function isValidState(value: unknown): value is RelaunchRecoveryState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj['version'] !== 1) return false;
  if (!Array.isArray(obj['attempts'])) return false;
  return obj['attempts'].every(
    (a: unknown) =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as Record<string, unknown>)['at'] === 'string' &&
      typeof (a as Record<string, unknown>)['pid'] === 'number' &&
      typeof (a as Record<string, unknown>)['conversationId'] === 'string' &&
      typeof (a as Record<string, unknown>)['reason'] === 'string',
  );
}

export async function readRelaunchRecoveryState(): Promise<RelaunchRecoveryState> {
  const filePath = defaultStateLayout().paths.relaunchRecoveryFile;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isValidState(parsed) ? parsed : { version: 1, attempts: [] };
  } catch {
    return { version: 1, attempts: [] };
  }
}

function pruneAttempts(attempts: readonly RelaunchAttempt[], nowMs: number): RelaunchAttempt[] {
  const cutoff = nowMs - PRUNE_WINDOW_MS;
  return attempts.filter((a) => {
    const t = Date.parse(a.at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

export function checkRelaunchGuard(
  state: RelaunchRecoveryState,
  conversationId: string,
  nowMs: number = Date.now(),
): RelaunchGuardResult {
  const pruned = pruneAttempts(state.attempts, nowMs);
  const globalCutoff = nowMs - GLOBAL_WINDOW_MS;
  const globalAttempts = pruned.filter((a) => Date.parse(a.at) >= globalCutoff);
  const convCutoff = nowMs - PER_CONVERSATION_WINDOW_MS;
  const convAttempts = globalAttempts.filter(
    (a) => a.conversationId === conversationId && Date.parse(a.at) >= convCutoff,
  );
  if (convAttempts.length >= PER_CONVERSATION_LIMIT) {
    return {
      allowed: false,
      reason: 'per-conversation-limit',
      attemptsInWindow: globalAttempts.length,
      conversationAttemptsInWindow: convAttempts.length,
    };
  }
  if (globalAttempts.length >= GLOBAL_LIMIT) {
    return {
      allowed: false,
      reason: 'global-limit',
      attemptsInWindow: globalAttempts.length,
      conversationAttemptsInWindow: convAttempts.length,
    };
  }
  return {
    allowed: true,
    reason: 'allowed',
    attemptsInWindow: globalAttempts.length,
    conversationAttemptsInWindow: convAttempts.length,
  };
}

export async function recordRelaunchAttempt(
  conversationId: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<RelaunchRecoveryState> {
  const filePath = defaultStateLayout().paths.relaunchRecoveryFile;
  await fs.mkdir(dirname(filePath), { recursive: true });
  const existing = await readRelaunchRecoveryState();
  const pruned = pruneAttempts(existing.attempts, nowMs);
  const attempt: RelaunchAttempt = {
    at: new Date(nowMs).toISOString(),
    pid: process.pid,
    conversationId,
    reason,
  };
  const next: RelaunchRecoveryState = {
    version: 1,
    attempts: [...pruned, attempt],
  };
  await atomicWrite(filePath, JSON.stringify(next, null, 2), 0o600);
  return next;
}

export async function clearRelaunchRecoveryState(): Promise<void> {
  const filePath = defaultStateLayout().paths.relaunchRecoveryFile;
  try {
    await fs.unlink(filePath);
  } catch {
    /* best-effort */
  }
}

export function buildRecoveryEnv(
  conversationId: string,
  reason: string,
): Record<string, string> {
  return {
    MYSHELL_RECOVERY_RELAUNCH: '1',
    MYSHELL_RECOVERY_REASON: reason,
    MYSHELL_RECOVERY_CONVERSATION_ID: conversationId,
  };
}

export function isRecoveryRelaunch(env: NodeJS.ProcessEnv): boolean {
  return env['MYSHELL_RECOVERY_RELAUNCH'] === '1';
}

export function getRecoveryConversationId(env: NodeJS.ProcessEnv): string | null {
  return env['MYSHELL_RECOVERY_CONVERSATION_ID'] ?? null;
}

export function getRecoveryReason(env: NodeJS.ProcessEnv): string | null {
  return env['MYSHELL_RECOVERY_REASON'] ?? null;
}
