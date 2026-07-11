/**
 * src/infra/composer-draft-store.ts — durable per-conversation composer drafts.
 *
 * Persist the in-progress chat composer text so Esc → process exit (and leave
 * chat) never loses half-typed input. Storage lives under state home:
 *   <stateRoot>/drafts/<conversationId>.json
 *
 * Fail-soft: every public API catches I/O and returns empty / no-ops rather than
 * throwing into the chat loop. Atomic writes via tmp+rename.
 */

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout } from './state-layout.js';

const DRAFT_VERSION = 1 as const;
/** Default debounce for interactive typing (flush on Esc bypasses this). */
export const COMPOSER_DRAFT_DEBOUNCE_MS = 400;

export interface ComposerDraftRecord {
  readonly version: typeof DRAFT_VERSION;
  readonly conversationId: string;
  readonly text: string;
  readonly updatedAt: string;
}

const VALID_CONV_ID_RE = /^[A-Za-z0-9_-]+$/;

function isValidConversationId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && VALID_CONV_ID_RE.test(id);
}

function draftsDir(): string {
  return join(defaultStateLayout().stateRoot, 'drafts');
}

/** Absolute path for a conversation's draft file (or null when id is invalid). */
export function composerDraftPath(conversationId: string): string | null {
  if (!isValidConversationId(conversationId)) return null;
  return join(draftsDir(), `${conversationId}.json`);
}

function isDraftRecord(value: unknown): value is ComposerDraftRecord {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    o['version'] === DRAFT_VERSION &&
    typeof o['conversationId'] === 'string' &&
    typeof o['text'] === 'string' &&
    typeof o['updatedAt'] === 'string'
  );
}

/**
 * Load the durable draft text for `conversationId`.
 * Returns `''` when missing, corrupt, id-invalid, or on any I/O error.
 */
export async function loadComposerDraft(conversationId: string): Promise<string> {
  const path = composerDraftPath(conversationId);
  if (path === null) return '';
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isDraftRecord(parsed)) return '';
    if (parsed.conversationId !== conversationId) return '';
    return parsed.text;
  } catch {
    return '';
  }
}

/**
 * Persist `text` for `conversationId`. Empty / whitespace-only text clears the
 * draft file (no empty stubs left on disk). Fail-soft — never throws.
 */
export async function saveComposerDraft(
  conversationId: string,
  text: string,
): Promise<void> {
  const path = composerDraftPath(conversationId);
  if (path === null) return;
  const trimmedCheck = text; // preserve intentional whitespace; only delete when fully empty
  if (trimmedCheck.length === 0) {
    await clearComposerDraft(conversationId);
    return;
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    const record: ComposerDraftRecord = {
      version: DRAFT_VERSION,
      conversationId,
      text,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(path, JSON.stringify(record, null, 2), 0o600);
  } catch {
    /* fail-soft: draft is best-effort */
  }
}

/** Delete the draft file for `conversationId`. Fail-soft. */
export async function clearComposerDraft(conversationId: string): Promise<void> {
  const path = composerDraftPath(conversationId);
  if (path === null) return;
  try {
    await unlink(path);
  } catch {
    /* missing is fine */
  }
}

export interface DebouncedDraftSaver {
  /** Schedule a debounced save of the current draft text. */
  schedule(text: string): void;
  /** Write the latest pending text immediately (Esc exit / leave chat). */
  flush(): Promise<void>;
  /** Cancel timers; does not write. */
  dispose(): void;
}

/**
 * Debounced draft writer bound to one conversation. `flush()` awaits the latest
 * scheduled text so process exit can persist without waiting for the debounce.
 */
export function createDebouncedDraftSaver(
  conversationId: string,
  debounceMs: number = COMPOSER_DRAFT_DEBOUNCE_MS,
): DebouncedDraftSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  const writeNow = (text: string): Promise<void> => {
    writeChain = writeChain
      .then(() => saveComposerDraft(conversationId, text))
      .catch(() => {
        /* fail-soft */
      });
    return writeChain;
  };

  return {
    schedule(text: string): void {
      pending = text;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next !== null) void writeNow(next);
      }, Math.max(0, debounceMs));
      timer.unref?.();
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending !== null) {
        const next = pending;
        pending = null;
        await writeNow(next);
      } else {
        await writeChain;
      }
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
