/**
 * src/core/goal-replan-generator.ts — build a live AUTOMATIC RE-PLAN pass.
 *
 * goal-replan.ts decides + defines the re-plan (prompt builder, parse, apply); this
 * module supplies the model pass that PRODUCES the edit list. Route to the MANAGER
 * tier (the strongest model — maintaining the to-do list like a senior PM is the
 * headline behaviour, so it is read by a capable model against the product-vision /
 * quality bar), send the small `buildReplanPrompt` READ-ONLY with a SHORT timeout,
 * take the final text, and `parseReplanEdits` it. Every failure mode — no provider,
 * route throws, the run errors or times out, empty/unusable output — returns null,
 * so the caller proceeds with the existing roadmap UNCHANGED (today's P7 behaviour).
 * It never throws and never writes.
 *
 * Cost discipline: this is ONE pass, GATED by the menu so it runs at cycle start
 * and/or when a to-do failed (NOT every iteration) and BOUNDED by a per-activation
 * cap — exactly the throwaway-pass shape of goal-plan-generator.ts /
 * goal-objective-generator.ts. Subscription-auth only: it reuses the existing
 * provider machinery — no API key, no embeddings, no metered service.
 *
 * Purity: no fs/path/child_process imports — the I/O lives in the injected provider,
 * exactly like goal-plan-generator.ts. A thin, testable composer.
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import type { TurnCallBudget } from './turn-call-budget.js';
import { route } from './route.js';
import { runBudgetedProvider } from './budgeted-provider.js';
import { buildReplanPrompt, parseReplanEdits, type RoadmapEdit } from './goal-replan.js';
import type { Goal } from './goal-todo.js';
import type { SystemModel } from './understanding.js';
import type {
  GoalStore,
  RoadmapItemPatch,
  RemoveRoadmapItemResult,
} from '../infra/goal-store.js';
import type { RoadmapItem } from './work-contract.js';

/** Everything the re-planner needs to pick and run the manager-tier model. */
export interface GoalReplanGeneratorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the re-plan run. Keep TIGHT — it runs inside the cycle. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  /**
   * Optional whole-picture understanding of the REAL system (understanding.ts).
   * When present it GROUNDS the re-plan prompt (the edits fit the actual modules +
   * respect the hard constraints). ABSENT → the prompt is the ungrounded form.
   */
  readonly systemModel?: SystemModel;
  readonly turnCallBudget?: TurnCallBudget;
}

/**
 * The re-plan runs at the MANAGER tier (the strongest model). Deciding which steps
 * to add / edit / reorder / prune — keeping the plan the smartest path to done — is
 * the headline behaviour, so it must be written by a capable model reading the goal
 * against the product-vision / quality bar, not the cheapest worker. ONE gated pass,
 * fail-soft + tight timeout so it can never block the cycle.
 */
const GOAL_REPLAN_TIER: Tier = 'manager';
/** It reads the goal + roadmap and emits a tagged edit list — never touches files. */
const GOAL_REPLAN_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build a manager-tier re-plan pass. Returns a function that takes the current Goal
 * and resolves to the edit list ({@link RoadmapEdit}[]), or `null` on ANY failure
 * (so the caller leaves the roadmap unchanged). Mirrors `makeGoalPlanner` exactly.
 */
export function makeReplanner(
  deps: GoalReplanGeneratorDeps,
): (goal: Goal, signal: AbortSignal) => Promise<RoadmapEdit[] | null> {
  return async (goal: Goal, signal: AbortSignal): Promise<RoadmapEdit[] | null> => {
    const prompt = buildReplanPrompt(goal, deps.systemModel);
    if (prompt.trim().length === 0) return null;

    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      // As in goal-plan-generator.ts: deliberately NOT threading the learned
      // provider order — this throwaway pass is a cost decision about maintaining
      // the plan, not about doing the owner's work.
      const decision = route(
        GOAL_REPLAN_TIER,
        pool,
        deps.policy,
        deps.availableModels,
        deps.authenticatedProviders,
      );
      provider = deps.providers[decision.provider];
      model = decision.model;
    } catch {
      return null;
    }
    if (provider === undefined) return null;

    const req: ProviderRequest = {
      model,
      prompt,
      cwd: deps.cwd,
      sandbox: deps.sandbox ?? GOAL_REPLAN_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    try {
      for await (const ev of runBudgetedProvider(provider, req, signal, {
        ...(deps.turnCallBudget ? { budget: deps.turnCallBudget } : {}),
        purpose: 'goal-replan',
        bucket: 'discretionary',
        provider: provider.id,
      })) {
        if (ev.type === 'done') finalText = ev.text;
        else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    return parseReplanEdits(finalText);
  };
}

/** A verdict that marks an item as real, verified, completed work (sacred). */
function isVerifiedDone(item: RoadmapItem): boolean {
  const state = item.verdict?.state;
  return state === 'passing' || state === 'reviewed';
}

/** The outcome of applying a re-plan's edits to a goal via the store CRUD. */
export interface ApplyReplanResult {
  readonly added: number;
  readonly edited: number;
  readonly reordered: number;
  readonly pruned: number;
  /** `depends`/`group` structural edits that landed (dependency edges + grouping). */
  readonly structured: number;
}

/**
 * Apply a re-plan's {@link RoadmapEdit}s to ONE goal via the store CRUD
 * (addRoadmapItem / updateRoadmapItem / reorderRoadmap / removeRoadmapItem) — the
 * AUTOMATIC consumer of those methods (replacing the retired manual /todo commands).
 * Fail-soft: each store call is guarded so a single miss never aborts the rest; the
 * function never throws. Returns a count of what actually landed (for an honest
 * receipt + the board), or `null` when `edits` is null/empty (nothing to apply).
 *
 * HONESTY (enforced HERE, independent of the model + the pure reducer): a
 * verified-done item is NEVER edited, pruned, or moved out of place. EDIT / PRUNE
 * targeting a verified-done id are skipped client-side; REORDER ids are filtered to
 * PENDING items only (the store's reorder keeps any omitted item in place, so the
 * verified ones stay anchored). NO call ever writes a verdict — the CRUD methods
 * have no verdict-write path (anti-fabrication, by construction). The roadmap is
 * re-read between mutating phases so freshly-added ids are visible to a reorder.
 */
export async function applyReplanEditsViaStore(
  store: GoalStore,
  goalId: string,
  edits: readonly RoadmapEdit[] | null,
): Promise<ApplyReplanResult | null> {
  if (edits === null || edits.length === 0) return null;
  const result = { added: 0, edited: 0, reordered: 0, pruned: 0, structured: 0 };

  // A live snapshot of the goal so we resolve ids → verified status + know what's
  // safe to touch. Re-read after the mutating phases that change membership.
  let goal = await store.get(goalId).catch(() => null);
  if (goal === null) return null;

  // Phase 1: edits + prunes (membership/text changes), keyed by id. A verified-done
  // target is skipped here AND the store retains a verified item on remove — belt
  // and braces. Mint fresh ids for adds; the store caps the roadmap at 8.
  for (const edit of edits) {
    if (edit.kind === 'add') {
      const used = new Set(goal.roadmap.map((it) => it.id));
      let i = 1;
      while (used.has(`r${String(i)}`)) i += 1;
      const item: RoadmapItem = {
        id: `r${String(i)}`,
        text: edit.text,
        status: 'pending',
        ...(edit.acceptanceCriterion !== undefined
          ? { acceptanceCriterion: edit.acceptanceCriterion }
          : {}),
      };
      const added = await store.addRoadmapItem(goalId, item).catch(() => null);
      if (added !== null && added.ok) {
        result.added += 1;
        goal = added.goal;
      }
      continue;
    }
    if (edit.kind === 'edit') {
      const target = goal.roadmap.find((it) => it.id === edit.id);
      if (target === undefined || isVerifiedDone(target)) continue; // sacred / unknown
      const patch: RoadmapItemPatch = {
        ...(edit.text !== undefined ? { text: edit.text } : {}),
        ...(edit.acceptanceCriterion !== undefined
          ? { acceptanceCriterion: edit.acceptanceCriterion }
          : {}),
      };
      const updated = await store.updateRoadmapItem(goalId, edit.id, patch).catch(() => null);
      if (updated !== null) {
        result.edited += 1;
        goal = updated;
      }
      continue;
    }
    if (edit.kind === 'prune') {
      const target = goal.roadmap.find((it) => it.id === edit.id);
      if (target === undefined || isVerifiedDone(target)) continue; // sacred / unknown
      const removed: RemoveRoadmapItemResult | null = await store
        .removeRoadmapItem(goalId, edit.id)
        .catch(() => null);
      if (removed !== null && removed.ok) {
        result.pruned += 1;
        goal = removed.goal;
      }
      continue;
    }
  }

  // Phase 1.5: structural edits (depends / group) AFTER adds/prunes so referenced
  // ids resolve against the post-membership roadmap. A verified-done target is
  // skipped (sacred); the relational guards (sibling-existence/cycle/depth) re-run
  // inside the store on the round-trip, so a dangling/cyclic/over-depth edge can
  // never persist — these set the raw value and let normalizeRoadmapRelations clean.
  for (const edit of edits) {
    if (edit.kind === 'depends') {
      const target = goal.roadmap.find((it) => it.id === edit.id);
      if (target === undefined || isVerifiedDone(target)) continue;
      const updated = await store
        .updateRoadmapItem(goalId, edit.id, { dependsOn: edit.dependsOn })
        .catch(() => null);
      if (updated !== null) {
        result.structured += 1;
        goal = updated;
      }
      continue;
    }
    if (edit.kind === 'group') {
      const target = goal.roadmap.find((it) => it.id === edit.id);
      if (target === undefined || isVerifiedDone(target)) continue;
      const updated = await store
        .updateRoadmapItem(goalId, edit.id, { parentId: edit.parentId })
        .catch(() => null);
      if (updated !== null) {
        result.structured += 1;
        goal = updated;
      }
      continue;
    }
  }

  // Phase 2: a single reorder LAST (so it sees the post-add/prune membership). Only
  // the most-recent REORDER wins (a senior PM lands one final order). Filter the
  // requested ids to PENDING items only — the store keeps omitted (incl. verified)
  // items in place, so verified-done work stays anchored.
  let lastOrder: readonly string[] | null = null;
  for (const edit of edits) {
    if (edit.kind === 'reorder') lastOrder = edit.order;
  }
  if (lastOrder !== null) {
    const pendingIds = new Set(
      goal.roadmap.filter((it) => !isVerifiedDone(it)).map((it) => it.id),
    );
    const safeOrder = lastOrder.filter((id) => pendingIds.has(id));
    if (safeOrder.length > 0) {
      const reordered = await store.reorderRoadmap(goalId, safeOrder).catch(() => null);
      if (reordered !== null) {
        result.reordered += 1;
        goal = reordered;
      }
    }
  }

  return result;
}
