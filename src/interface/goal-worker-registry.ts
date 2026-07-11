/**
 * Process-scoped multi-conversation goal worker registry (multi-chat PR-B).
 *
 * Live background-goal AbortControllers, keyed first by conversationId then
 * goalId. Leaving chat (`/back`, idle Esc → home) must NOT abort workers —
 * only explicit NL pause, worker completion, or process exit ends them.
 *
 * Entering chat B while A’s goals run is independent: each conversation has
 * its own inner map. `running` in the store with no entry here is a zombie
 * healed by reconcile-on-enter for that conversation.
 */

/** Outer: conversationId → inner goalId → AbortController */
const registry = new Map<string, Map<string, AbortController>>();

function convMap(conversationId: string): Map<string, AbortController> {
  let inner = registry.get(conversationId);
  if (inner === undefined) {
    inner = new Map();
    registry.set(conversationId, inner);
  }
  return inner;
}

function pruneIfEmpty(conversationId: string): void {
  const inner = registry.get(conversationId);
  if (inner !== undefined && inner.size === 0) {
    registry.delete(conversationId);
  }
}

/**
 * Register (or replace) a live worker for `goalId` in `conversationId`.
 * If a prior controller exists for the same goal, it is aborted first.
 */
export function registerGoalWorker(
  conversationId: string,
  goalId: string,
  ac: AbortController,
): void {
  const inner = convMap(conversationId);
  const prior = inner.get(goalId);
  if (prior !== undefined && prior !== ac) {
    prior.abort();
  }
  inner.set(goalId, ac);
}

/**
 * Remove a worker registration. When `ac` is provided, only removes if it is
 * still the registered controller (race-safe finally cleanup after replace).
 * Returns true when an entry was removed.
 */
export function unregisterGoalWorker(
  conversationId: string,
  goalId: string,
  ac?: AbortController,
): boolean {
  const inner = registry.get(conversationId);
  if (inner === undefined) return false;
  if (ac !== undefined && inner.get(goalId) !== ac) return false;
  const had = inner.delete(goalId);
  pruneIfEmpty(conversationId);
  return had;
}

/** Live AbortController for a goal, if any. */
export function getGoalWorker(
  conversationId: string,
  goalId: string,
): AbortController | undefined {
  return registry.get(conversationId)?.get(goalId);
}

/**
 * Abort one goal’s worker. Does not remove the map entry — the spawn’s
 * finally path unregisters after the run settles (same as pre-PR-B).
 * Returns true if a controller was found and aborted.
 */
export function abortGoalWorker(conversationId: string, goalId: string): boolean {
  const ac = getGoalWorker(conversationId, goalId);
  if (ac === undefined) return false;
  ac.abort();
  return true;
}

/**
 * Abort every live worker for one conversation (NL “pause all”).
 * Does not touch other conversations. Returns how many controllers were aborted.
 */
export function abortConversationGoalWorkers(conversationId: string): number {
  const inner = registry.get(conversationId);
  if (inner === undefined) return 0;
  let n = 0;
  for (const ac of inner.values()) {
    ac.abort();
    n += 1;
  }
  return n;
}

/** Live goal ids with an in-process worker for this conversation. */
export function liveGoalIds(conversationId: string): ReadonlySet<string> {
  const inner = registry.get(conversationId);
  return inner === undefined ? new Set() : new Set(inner.keys());
}

/** Count of live workers for one conversation. */
export function conversationWorkerCount(conversationId: string): number {
  return registry.get(conversationId)?.size ?? 0;
}

/** Process-wide live worker count (all conversations). */
export function totalWorkerCount(): number {
  let n = 0;
  for (const inner of registry.values()) n += inner.size;
  return n;
}

/**
 * Test-only: clear the process registry so unit tests do not leak across cases.
 * Not for production leave-chat / pause paths.
 */
export function resetGoalWorkerRegistryForTests(): void {
  registry.clear();
}
