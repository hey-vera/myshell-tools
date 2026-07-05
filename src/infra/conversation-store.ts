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
import type { Intensity } from '../core/capacity-allocator.js';
import type { GoalActivationOverride } from '../core/autonomy.js';

/** Per-conversation mode — the user-facing firepower level for this conversation's turns. */
export type ConversationMode = 'auto' | 'budget' | 'balanced' | 'high' | 'max';

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
  /**
   * Cached conversation RECAP — the last model-written ※ orientation line for
   * this thread (docs/recap-feature-5.5.md §5.2). Conversation-scoped, regenerated
   * as the thread grows, discarded with it; DISTINCT from durable user memory.
   * Optional + null-when-unset so legacy index entries forward-migrate cleanly.
   */
  readonly recap?: string | null;
  /** ISO time the cached recap was generated; null when none. */
  readonly recapAt?: string | null;
  /** `messageCount` at recap generation, for the staleness check; absent when none. */
  readonly recapMessageCount?: number;
  /** Conversation-scoped intensity override; absent means inherit global/Auto. */
  readonly intensity?: Intensity;
  /** Conversation-scoped goal activation preference; absent means adaptive. */
  readonly activation?: Exclude<GoalActivationOverride, 'adaptive'>;
  /**
   * Per-conversation override for the firepower mode used by this conversation's
   * turns. Absent (or 'auto') → inherits the global default (config.mode or Auto).
   */
  readonly mode?: ConversationMode;
  /**
   * The workspace (repo root, else exact cwd) this conversation is bound to —
   * `git root else cwd` at creation time, LOCKED for the life of the
   * conversation. `null`/absent means global/unknown: a legacy conversation
   * created before this field existed, or one deliberately created without a
   * workspace. Never inferred or backfilled from the CURRENT cwd on read —
   * that would silently rebind an old conversation to wherever the process
   * happens to be running now.
   */
  readonly workspaceRoot?: string | null;
}

/** Options accepted by {@link ConversationStore.create}'s object-options overload. */
export interface CreateConversationOptions {
  /** Stamp the conversation with this firepower mode; 'auto'/absent → inherit global. */
  readonly mode?: ConversationMode;
  /** Stamp the conversation with this workspace root; null/absent → global/unknown. */
  readonly workspaceRoot?: string | null;
}

export interface ConversationStore {
  /** All conversations, pinned first then most-recently-updated first. */
  list(): Promise<ConversationMeta[]>;
  /**
   * Create a new conversation; accepts a firepower mode string or an options object.
   * If `mode` (string) is provided, the conversation is stamped with it; otherwise the
   * caller should set the mode via {@link setMode} after creation.
   * If `options` (object) is provided, it can include `mode` and/or `workspaceRoot`.
   * `workspaceRoot` absent/null means global/unknown (never inferred).
   */
  create(title: string, modeOrOptions?: ConversationMode | CreateConversationOptions): Promise<ConversationMeta>;
  /** Read a conversation's full message history (oldest first); [] if missing. */
  load(id: string): Promise<SessionEntry[]>;
  /** Rename a conversation. No-op if the id does not exist. */
  rename(id: string, title: string): Promise<void>;
  /** Delete a conversation and its messages. No-op if missing. */
  remove(id: string): Promise<void>;
  /** A SessionWriter bound to `id` — appends entries and bumps updatedAt/count. */
  writer(id: string): SessionWriter;
  /**
   * Truncate a conversation to its first `keepCount` entries, discarding every
   * entry after that point — the one deliberate, user-initiated departure from
   * the otherwise APPEND-ONLY log (it powers /retry and /edit: regenerate the
   * last answer, or edit a prior message and re-run from there).
   *
   * Semantics:
   *   - `keepCount` is clamped to `[0, currentLength]`; a no-op when it already
   *     covers the whole log (returns the unchanged length).
   *   - Atomic: the message file is rewritten via the same atomic tmp+rename path
   *     as the index, under the index lock — a crash mid-truncate never leaves a
   *     half-written log.
   *   - Updates `messageCount` to the new length and CLEARS any cached recap (the
   *     recap may describe turns that no longer exist).
   *   - Path/id-validated and fail-soft: an invalid id or missing conversation is
   *     a no-op (returns the would-be length / 0), never a throw that could crash
   *     the chat loop or corrupt the conversation.
   *
   * Returns the conversation's entry count AFTER the operation.
   */
  truncateAfter(id: string, keepCount: number): Promise<number>;
  /** Pin or unpin a conversation. No-op if the id does not exist. */
  setPinned(id: string, pinned: boolean): Promise<void>;
  /** Set or clear the category tag for a conversation. No-op if id missing. */
  setCategory(id: string, category: string | null): Promise<void>;
  /**
   * Cache the conversation recap (text + the messageCount it was generated at, for
   * staleness). Pass `recap: null` to clear it. No-op if the id does not exist.
   * Best-effort orientation cache — never the durable-memory write path.
   */
  setRecap(id: string, recap: string | null, atMessageCount: number): Promise<void>;
  /** Set or clear the conversation intensity override. No-op if id missing. */
  setIntensity(id: string, intensity: Intensity | undefined): Promise<void>;
  /** Set or clear the conversation goal activation preference. No-op if id missing. */
  setActivation(id: string, activation: GoalActivationOverride | undefined): Promise<void>;
  /**
   * Set or clear the per-conversation firepower mode override. No-op if id
   * missing. Pass `'auto'` or `undefined` to clear the override (inherit global).
   */
  setMode(id: string, mode: ConversationMode | undefined): Promise<void>;
}
