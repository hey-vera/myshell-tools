/**
 * src/infra/conversation-store.ts — the persistent conversation contract.
 *
 * The menu UX manages multiple named, persistent conversations. This is the
 * port both the file-backed implementation (infra) and the menu (interface)
 * build against. Conversations live in a GLOBAL store (the user's home dir) so
 * they follow the user across projects; each one is an append-only message log
 * plus lightweight metadata.
 *
 * A conversation's `SessionWriter` is what gets injected into orchestrate() so a
 * run's messages persist into that conversation.
 */

import type { SessionEntry, SessionWriter } from '../core/types.js';

export interface ConversationMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string; // ISO
  readonly updatedAt: string; // ISO
  readonly messageCount: number;
  /** Whether this conversation is pinned (sorted to the top of the list). */
  readonly pinned: boolean;
  /** Optional short category tag (e.g. "ui", "refactor"); null when unset. */
  readonly category: string | null;
}

export interface ConversationStore {
  /** All conversations, pinned first then most-recently-updated first. */
  list(): Promise<ConversationMeta[]>;
  /** Create a new conversation; returns its metadata (with a fresh id). */
  create(title: string): Promise<ConversationMeta>;
  /** Read a conversation's full message history (oldest first); [] if missing. */
  load(id: string): Promise<SessionEntry[]>;
  /** Rename a conversation. No-op if the id does not exist. */
  rename(id: string, title: string): Promise<void>;
  /** Delete a conversation and its messages. No-op if missing. */
  remove(id: string): Promise<void>;
  /** A SessionWriter bound to `id` — appends entries and bumps updatedAt/count. */
  writer(id: string): SessionWriter;
  /** Pin or unpin a conversation. No-op if the id does not exist. */
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** Set or clear the category tag for a conversation. No-op if id missing. */
  setCategory(id: string, category: string | null): Promise<void>;
}
