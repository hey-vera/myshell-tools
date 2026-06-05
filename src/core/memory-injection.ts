/**
 * src/core/memory-injection.ts — Phase 4 retrieval/injection wiring
 * (docs/memory-architecture-5.5.md §7).
 *
 * This is the seam that turns the persisted store (Phase 3) into the
 * `deps.memoryContext` string that the Phase-2 prompt seam
 * (`assembleContextBlocks`) flows into EVERY prompt builder — sequential, hedge,
 * AND panel. Callers (menu chat loop + one-shot `run`) call `resolveMemoryContext`
 * once per turn with the task line; they never touch the store directly.
 *
 * Two pieces:
 *   - `applyInjectGate` — PURE. The inject-time gate (§7 "Inject-time gate"):
 *     `constraint`/`identity` facts ALWAYS ride (load-bearing — an allergy /
 *     "Node 22" must never be gated out); `preference`/`correction`/`project`
 *     facts ride only on a substantial work request. Same boundary APE's
 *     `isTrivial` fast-path uses; reuses the router's `hasTierEvidence` upstream.
 *   - `resolveMemoryContext` — the IMPURE orchestration: sweep decay on open,
 *     load facts, gate, select, markUsed the relevance-selected ids, render.
 *     Fail-soft: ANY store error degrades to "no memory injected" (returns ''),
 *     never throws into the turn. NO model call (selection is deterministic).
 */

import { hasTierEvidence } from './classify.js';
import {
  selectRelevant,
  renderMemoryContext,
  type UserMemoryFact,
} from './user-memory.js';
import type { PartnerStyle } from './prompt-context.js';

/**
 * The store surface this seam needs. A narrow structural type (NOT the full
 * `UserMemoryStore`) so tests can supply a tiny fake and so this core module
 * does not depend on the infra store implementation.
 */
export interface MemoryReadStore {
  /** All facts (incl. archived/superseded — `selectRelevant` filters them). */
  listAll(): Promise<UserMemoryFact[]>;
  /** Mark facts used (decay-reset) — relevance-selected ids only (RC-5). */
  markUsed(ids: readonly string[]): Promise<void>;
  /** Lazy decay sweep on open (§6) — the CLI's "idle". */
  sweepDecay(opts?: { base?: number; max?: number }): Promise<string[]>;
}

/** Memory-relevant slice of `AppConfig` (§9). */
export interface MemoryConfig {
  /** Master switch — `false` is the kill-switch (no read, no inject). */
  readonly memory?: boolean;
  /** Base decay window (days) for importance 2. */
  readonly memoryDecayDays?: number;
  /** Hard cap on non-archived facts per scope before capacity eviction. */
  readonly memoryMaxFactsPerScope?: number;
}

/** Kinds that always ride regardless of the inject-time gate (§7). */
const ALWAYS_RIDE_KINDS: ReadonlySet<UserMemoryFact['kind']> = new Set([
  'identity',
  'constraint',
]);

/**
 * Inject-time gate (§7). When the turn is NOT a substantial work request,
 * `preference`/`correction`/`project` facts are excluded (1200 chars of dated
 * prefs on "what's 2+2" is pure attentional dilution); `constraint`/`identity`
 * facts always survive. On a work request, everything passes through to scoring.
 * Pure; never throws.
 *
 * @param facts - The candidate facts (already loaded).
 * @param isWorkRequest - Whether this turn is a substantial work request
 *   (caller passes `hasTierEvidence(task)`, the same boundary APE uses).
 */
export function applyInjectGate(
  facts: readonly UserMemoryFact[],
  isWorkRequest: boolean,
): readonly UserMemoryFact[] {
  if (isWorkRequest) return facts;
  return facts.filter((f) => ALWAYS_RIDE_KINDS.has(f.kind));
}

/** Whether memory is enabled (absent/true → on; explicit false → kill-switch). */
export function isMemoryEnabled(config: MemoryConfig): boolean {
  return config.memory !== false;
}

export interface ResolveMemoryContextInput {
  /** The store (Phase 3). When undefined → no memory (returns ''). */
  readonly store: MemoryReadStore | undefined;
  /** The raw user task/line this turn. */
  readonly task: string;
  /** Resolved project key (deriveProjectKey/resolveProjectKey) or null. */
  readonly projectKey: string | null;
  /** Soft partner posture (ranking tie-break hint). */
  readonly partnerStyle?: PartnerStyle;
  /** ISO clock for deterministic recency scoring + sweep. */
  readonly nowIso: string;
  /** Memory-relevant config (kill-switch + decay/cap knobs). */
  readonly config: MemoryConfig;
  /**
   * Run the lazy decay sweep on open (§6). Default true. The caller may pass
   * false to skip it (e.g. a same-session second turn) — but the default mirrors
   * the doc ("sweep on store open").
   */
  readonly sweep?: boolean;
}

/**
 * Per-turn retrieval + injection (§7), fully fail-soft.
 *
 * 1. Kill-switch / no-store → '' (no memory).
 * 2. sweepDecay on open (lazy, §6) — best-effort, swallowed on error.
 * 3. listAll → applyInjectGate (gate prefs/corrections/project behind a real
 *    work request; identity+constraints always ride) → selectRelevant
 *    (deterministic scoring, 12-fact/1200-char budget) → render.
 * 4. markUsed the RELEVANCE-selected ids only (RC-5 — injection alone is not
 *    "validated use"); best-effort.
 *
 * ANY error anywhere returns '' — memory degrades, the turn proceeds. No model
 * call. Returns the pre-rendered, capped MEMORY block ('' when nothing applies).
 */
export async function resolveMemoryContext(
  input: ResolveMemoryContextInput,
): Promise<string> {
  const { store, task, projectKey, partnerStyle, nowIso, config } = input;

  // Kill-switch or no store → nothing injected.
  if (store === undefined || !isMemoryEnabled(config)) return '';

  try {
    // Lazy decay sweep on open — the CLI's "idle" (§6). Best-effort.
    if (input.sweep !== false) {
      try {
        const sweepOpts: { base?: number; max?: number } = {};
        if (config.memoryDecayDays !== undefined) sweepOpts.base = config.memoryDecayDays;
        if (config.memoryMaxFactsPerScope !== undefined) sweepOpts.max = config.memoryMaxFactsPerScope;
        await store.sweepDecay(Object.keys(sweepOpts).length > 0 ? sweepOpts : undefined);
      } catch {
        // A failed sweep must never block the turn.
      }
    }

    const all = await store.listAll();
    if (all.length === 0) return '';

    // Inject-time gate (§7): prefs/corrections/project ride only on real work.
    const gated = applyInjectGate(all, hasTierEvidence(task));
    if (gated.length === 0) return '';

    const selected = selectRelevant({
      task,
      projectKey,
      facts: gated,
      nowIso,
      ...(partnerStyle !== undefined ? { partnerStyle } : {}),
    });
    if (selected.facts.length === 0) return '';

    // RC-5: reset decay ONLY for relevance-selected facts. Best-effort.
    if (selected.resetDecayIds.length > 0) {
      try {
        await store.markUsed(selected.resetDecayIds);
      } catch {
        // A failed markUsed must never block the turn.
      }
    }

    return renderMemoryContext(selected.facts);
  } catch {
    // Any store/selection failure → no memory injected; turn proceeds.
    return '';
  }
}
