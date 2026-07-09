import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout } from './state-layout.js';

export interface ActiveConversationMarker {
  readonly version: 1;
  readonly conversationId: string;
  readonly workspaceRoot: string | null;
  readonly enteredAt: string;
  readonly updatedAt: string;
  readonly pid: number;
  readonly argv: readonly string[];
  readonly reason: 'chat-active' | 'auto-recovered';
}

export interface ActiveConversationInput {
  readonly conversationId: string;
  readonly workspaceRoot?: string | null;
  readonly reason?: 'chat-active' | 'auto-recovered';
}

function isValidMarker(value: unknown): value is ActiveConversationMarker {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['version'] === 1 &&
    typeof obj['conversationId'] === 'string' &&
    obj['conversationId'].length > 0 &&
    (obj['workspaceRoot'] === null || typeof obj['workspaceRoot'] === 'string') &&
    typeof obj['enteredAt'] === 'string' &&
    typeof obj['updatedAt'] === 'string' &&
    typeof obj['pid'] === 'number' &&
    Array.isArray(obj['argv']) &&
    (obj['reason'] === 'chat-active' || obj['reason'] === 'auto-recovered')
  );
}

export async function readActiveConversation(): Promise<ActiveConversationMarker | null> {
  const filePath = defaultStateLayout().paths.activeConversationFile;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isValidMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeActiveConversation(
  input: ActiveConversationInput,
  existingMarker?: ActiveConversationMarker | null,
): Promise<void> {
  const filePath = defaultStateLayout().paths.activeConversationFile;
  await fs.mkdir(dirname(filePath), { recursive: true });
  const now = new Date().toISOString();
  const marker: ActiveConversationMarker = {
    version: 1,
    conversationId: input.conversationId,
    workspaceRoot: input.workspaceRoot ?? null,
    enteredAt: existingMarker?.conversationId === input.conversationId
      ? existingMarker.enteredAt
      : now,
    updatedAt: now,
    pid: process.pid,
    argv: process.argv.slice(2),
    reason: input.reason ?? 'chat-active',
  };
  await atomicWrite(filePath, JSON.stringify(marker, null, 2), 0o600);
}

export async function clearActiveConversation(): Promise<void> {
  const filePath = defaultStateLayout().paths.activeConversationFile;
  try {
    await fs.unlink(filePath);
  } catch {
    /* best-effort: stale marker handled by validation on startup */
  }
}

export async function refreshActiveConversationUpdatedAt(): Promise<void> {
  const existing = await readActiveConversation();
  if (existing === null) return;
  await writeActiveConversation(
    {
      conversationId: existing.conversationId,
      workspaceRoot: existing.workspaceRoot,
      reason: existing.reason,
    },
    existing,
  );
}
