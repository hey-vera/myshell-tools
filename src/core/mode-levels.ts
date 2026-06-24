/**
 * src/core/mode-levels.ts — the 5-LEVEL user-facing dial (redesign Phase 0, slice 2).
 *
 * The locked model: five levels — Budget / Balanced / High / Max / Auto — layered
 * OVER the existing 3-stop `Mode` (cost-saver | balanced | quality-first) and its
 * `POLICY_PRESETS`. This is a thin PURE mapping, NOT a parallel policy system: every
 * level resolves to (a) an existing-or-derived `Mode`, (b) a `Policy` built from the
 * shipped presets, (c) a sensible default `Intensity`, and (d) a base reasoning
 * effort — reusing `Tier`, `ReasoningEffort`, `Mode`, `Policy`, and `Intensity`
 * rather than introducing new firepower types.
 *
 *   - Budget   ≈ cost-saver. Cheapest models, low/no effort, local-first, no panel.
 *   - Balanced ≈ balanced (DEFAULT_POLICY). Mid models, medium effort, standard verify.
 *   - High     = a NEW mid-high rung: quality-first reachability + thorough review,
 *                but a narrower (2-provider) panel than Max — "Balanced + raised
 *                effort + thorough review", expressed on the existing machinery.
 *   - Max      ≈ quality-first with the broadest cross-provider deliberation (panel
 *                + hedge + review, up to 3 providers) — the existing panel/hedge/
 *                review machinery turned fully on.
 *   - Auto     = the smart default: NO fixed mode/policy of its own. It resolves
 *                per-turn from a difficulty signal. That signal is meant to arrive as
 *                a BYPRODUCT of the turn the user is already having (no separate
 *                classification call); until that byproduct lands, Auto falls back to
 *                the existing autonomy/escalation heuristics — the user's persisted
 *                `config.mode` (if any) or the plan-derived auto mode. `resolveLevel`
 *                is the clean seam for that byproduct.
 *
 * PURE — no I/O, no time, no randomness, no module state (matches the src/core/
 * purity guard in test/arch/guards.test.ts). It imports `Mode`, `Policy`,
 * `Intensity`, `Tier`, and `ReasoningEffort` as the SAME types the rest of core
 * uses, and builds policies by extending the shipped `POLICY_PRESETS`.
 *
 * SCAFFOLDING ONLY (slice 2): these functions sit behind the default-OFF
 * `levelDialEnabled` flag (src/interface/ui/level-flag.ts). When the flag is OFF the
 * live path reads `config.mode` exactly as today — ZERO behavior change. See
 * docs/one-chat-redesign-plan.md "Phase 0 — Implementation Spec (slice 2)".
 */

import type { Policy } from './types.js';
import type { Mode } from './policy.js';
import { POLICY_PRESETS } from './policy.js';
import type { Intensity } from './capacity-allocator.js';
import type { ReasoningEffort } from './model-capabilities.js';

// ---------------------------------------------------------------------------
// The level type + metadata.
// ---------------------------------------------------------------------------

/**
 * The five user-facing firepower levels. `auto` is the DEFAULT and is special: it
 * carries no fixed mode/policy and is resolved per-turn (see {@link resolveLevel}).
 */
export type Level = 'budget' | 'balanced' | 'high' | 'max' | 'auto';

/** The closed set, weakest → strongest, with `auto` last (the smart default). */
export const ALL_LEVELS: readonly Level[] = ['budget', 'balanced', 'high', 'max', 'auto'] as const;

/** True for a value that is a known {@link Level}. PURE. */
export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (ALL_LEVELS as readonly string[]).includes(value);
}

/** User-facing label per level (display only). */
const LEVEL_LABEL: Record<Level, string> = {
  budget: 'Budget',
  balanced: 'Balanced',
  high: 'High',
  max: 'Max',
  auto: 'Auto',
};

/** One-line description per level (display only). */
export const LEVEL_DESC: Record<Level, string> = {
  budget:
    'cheapest models, low/no reasoning effort, local-first — no cross-provider deliberation',
  balanced: 'mid models, medium effort, standard verification — the sensible middle',
  high: 'strong models, high effort, thorough review — deeper than Balanced',
  max: 'strongest models, cross-provider deliberation (panel + hedge), deepest effort',
  auto: 'smart default — picks the effective level per task from how the turn is going',
};

export function levelLabel(level: Level): string {
  return LEVEL_LABEL[level];
}

// ---------------------------------------------------------------------------
// Level → existing Mode (the bridge onto the shipped 3-stop dial).
// ---------------------------------------------------------------------------

/**
 * The `Mode` a level projects onto, or `undefined` for `auto` (which has no fixed
 * mode — it is resolved per-turn). Budget≈cost-saver, Balanced≈balanced, and BOTH
 * High and Max ride the quality-first envelope (High narrows the panel via
 * {@link policyForLevel}; the underlying escalation/effort posture is the same
 * quality-first ladder so the reasoning-effort selector stays consistent). PURE.
 */
export function levelToMode(level: Level): Mode | undefined {
  switch (level) {
    case 'budget':
      return 'cost-saver';
    case 'balanced':
      return 'balanced';
    case 'high':
      return 'quality-first';
    case 'max':
      return 'quality-first';
    case 'auto':
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Level → Policy (built from the shipped POLICY_PRESETS, never invented).
// ---------------------------------------------------------------------------

/**
 * The `Policy` a level engages, built FROM the shipped {@link POLICY_PRESETS} so the
 * level dial never invents a parallel policy:
 *
 *   - budget   → POLICY_PRESETS['cost-saver'] verbatim (no panel/hedge).
 *   - balanced → POLICY_PRESETS['balanced'] verbatim (DEFAULT_POLICY).
 *   - high     → the quality-first preset but with the panel NARROWED to 2 providers
 *                (vs Max's 3): thorough review + deep effort, gentler deliberation.
 *   - max      → POLICY_PRESETS['quality-first'] verbatim (panel + hedge, ≤3).
 *   - auto     → `undefined`: Auto has no fixed policy; the caller resolves a level
 *                first (see {@link resolveLevel}) then asks for THAT level's policy.
 *
 * PURE and total. Returns a fresh object for `high` (never mutates the shared
 * preset); the others return the shared preset reference unchanged.
 */
export function policyForLevel(level: Level): Policy | undefined {
  switch (level) {
    case 'budget':
      return POLICY_PRESETS['cost-saver'];
    case 'balanced':
      return POLICY_PRESETS['balanced'];
    case 'high':
      // Mid-high rung: the quality-first escalation/review posture, but a narrower
      // 2-provider panel than Max's 3. Built by extension so it tracks any future
      // change to the quality-first preset automatically.
      return { ...POLICY_PRESETS['quality-first'], maxPanelProviders: 2 };
    case 'max':
      return POLICY_PRESETS['quality-first'];
    case 'auto':
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Level → default Intensity (Intensity folds UNDER the level).
// ---------------------------------------------------------------------------

/**
 * The default {@link Intensity} a level sets. Intensity (the 1–5 concurrency-regime
 * dial) is no longer a primary control — each level picks a sensible default, and a
 * power-user may still override it explicitly. `auto` keeps Intensity on `'auto'`
 * (let the per-turn heuristic decide). Mirrors `legacyModeToIntensity`'s envelope
 * (cost-saver→1, balanced→3, quality-first→5) so the two never disagree, with High
 * slotting at 4 between Balanced and Max. PURE.
 */
export function defaultIntensityForLevel(level: Level): Intensity {
  switch (level) {
    case 'budget':
      return 1;
    case 'balanced':
      return 3;
    case 'high':
      return 4;
    case 'max':
      return 5;
    case 'auto':
      return 'auto';
  }
}

// ---------------------------------------------------------------------------
// Level → base reasoning effort (informational; the selector still owns per-turn).
// ---------------------------------------------------------------------------

/**
 * A coarse BASE reasoning effort per level, for display / a future effort floor.
 * This is NOT the per-turn effort — `selectReasoningEffort` (route.ts) still owns
 * that, sized by mode×tier×risk. This is the level's headline depth, aligned with
 * `baseDesiredEffort`'s envelope: budget→low, balanced→medium, high→high, max→max.
 * `auto` returns `undefined` (no fixed base — resolved per turn). PURE.
 */
export function baseEffortForLevel(level: Level): ReasoningEffort | undefined {
  switch (level) {
    case 'budget':
      return 'low';
    case 'balanced':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      return 'max';
    case 'auto':
      return undefined;
  }
}

/**
 * Whether a level permits agent recursion (sub-agent fan-out). Budget explicitly
 * forbids it (cheapest, local-first, no recursion per the locked model); every
 * other level permits it. `auto` permits it (the resolved level governs the actual
 * run). PURE — a plain capability fact for callers to honor in a later slice.
 */
export function allowsAgentRecursion(level: Level): boolean {
  return level !== 'budget';
}

// ---------------------------------------------------------------------------
// A resolved level profile — everything a turn needs, in one shape.
// ---------------------------------------------------------------------------

/**
 * The fully-resolved firepower profile for a CONCRETE (non-auto) level: its mode,
 * the policy it engages, its default intensity, base effort, and recursion fact.
 * `mode`/`policy` are always present here because `profileForLevel` is only ever
 * called with a concrete level (Auto is resolved to a concrete level first).
 */
export interface LevelProfile {
  readonly level: Exclude<Level, 'auto'>;
  readonly mode: Mode;
  readonly policy: Policy;
  readonly intensity: Intensity;
  readonly baseEffort: ReasoningEffort;
  readonly allowsRecursion: boolean;
}

/**
 * Build the {@link LevelProfile} for a CONCRETE level (not `auto`). PURE, total.
 * `auto` must be resolved to a concrete level via {@link resolveLevel} first; this
 * function's input type forbids it.
 */
export function profileForLevel(level: Exclude<Level, 'auto'>): LevelProfile {
  // Every concrete level has a defined mode/policy/effort by construction.
  const mode = levelToMode(level) as Mode;
  const policy = policyForLevel(level) as Policy;
  const baseEffort = baseEffortForLevel(level) as ReasoningEffort;
  return {
    level,
    mode,
    policy,
    intensity: defaultIntensityForLevel(level),
    baseEffort,
    allowsRecursion: allowsAgentRecursion(level),
  };
}

// ---------------------------------------------------------------------------
// Backward-compat migration: persisted `config.mode` → a Level.
// ---------------------------------------------------------------------------

/**
 * Migrate a persisted legacy `config.mode` value (the shipped 3-stop dial) to a
 * {@link Level}, preserving the user's intent:
 *   - 'cost-saver'    → 'budget'   (the cheapest level)
 *   - 'balanced'      → 'balanced'
 *   - 'quality-first' → 'max'      (the strongest level; the old top stop)
 *   - absent/unknown  → 'auto'     (no explicit mode meant Auto already)
 *
 * Deliberately maps quality-first → Max (not High): High is a NEW rung that did not
 * exist before, so an existing quality-first user keeps the strongest posture they
 * had. PURE, total, never throws.
 */
export function migrateMode(mode: Mode | string | null | undefined): Level {
  switch (mode) {
    case 'cost-saver':
      return 'budget';
    case 'balanced':
      return 'balanced';
    case 'quality-first':
      return 'max';
    default:
      return 'auto';
  }
}

// ---------------------------------------------------------------------------
// Auto resolution — the clean seam for the byproduct difficulty signal.
// ---------------------------------------------------------------------------

/**
 * A per-turn difficulty signal that drives Auto. This is the SEAM for the byproduct
 * intelligence (plan principle #1): the difficulty is meant to fall out of the turn
 * the user is already having with their strong model — NOT a separate classifier
 * call. Until that byproduct lands (a later phase), every field is optional and
 * absent → Auto falls back to the existing heuristics. PURE reference data only.
 */
export interface AutoDifficulty {
  /** A directly-suggested level, if the byproduct emitted one. Wins when present. */
  readonly suggestedLevel?: Exclude<Level, 'auto'>;
  /** Coarse difficulty bucket derived as a byproduct of the turn. */
  readonly difficulty?: 'trivial' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Map a byproduct {@link AutoDifficulty} to a concrete level. An explicit
 * `suggestedLevel` always wins; otherwise the difficulty bucket projects onto the
 * ladder (trivial/low→budget … critical→max). Returns `undefined` when there is no
 * usable signal, so the caller falls back to the persisted/auto-mode path. PURE.
 */
export function levelFromAutoDifficulty(d: AutoDifficulty | undefined): Exclude<Level, 'auto'> | undefined {
  if (d === undefined) return undefined;
  if (d.suggestedLevel !== undefined) return d.suggestedLevel;
  switch (d.difficulty) {
    case 'trivial':
    case 'low':
      return 'budget';
    case 'medium':
      return 'balanced';
    case 'high':
      return 'high';
    case 'critical':
      return 'max';
    case undefined:
      return undefined;
  }
}

/**
 * Resolve the EFFECTIVE concrete level for a turn from the user's chosen level plus
 * the fallback chain. This is the single decision point Auto flows through:
 *
 *   1. A concrete chosen level (budget/balanced/high/max) wins outright.
 *   2. For `auto` (or an absent choice): if a byproduct difficulty signal is
 *      present, use it ({@link levelFromAutoDifficulty}).
 *   3. Else fall back to the EXISTING heuristics — the user's persisted legacy
 *      `config.mode` migrated to a level, or the plan-derived `autoMode`, in that
 *      order (mirroring today's `config.mode ?? resolveAutoMode` precedence).
 *   4. Final safety net: `balanced` (the safe middle), so this is total.
 *
 * PURE, total, never throws. The byproduct signal is intentionally a clean optional
 * seam: when it is absent (today), Auto behaves exactly like the existing auto path.
 */
export function resolveLevel(input: {
  /** The user's chosen level (absent → treated as `auto`). */
  readonly chosen?: Level;
  /** Per-turn byproduct difficulty (the future Auto driver; absent today). */
  readonly difficulty?: AutoDifficulty;
  /** Persisted legacy `config.mode`, if any (for migration fallback). */
  readonly persistedMode?: Mode | string | null;
  /** Plan-derived auto mode (today's `resolveAutoMode`), if computed. */
  readonly autoMode?: Mode;
}): Exclude<Level, 'auto'> {
  const { chosen, difficulty, persistedMode, autoMode } = input;

  // 1. A concrete chosen level wins.
  if (chosen !== undefined && chosen !== 'auto') return chosen;

  // 2. Auto with a byproduct signal.
  const fromByproduct = levelFromAutoDifficulty(difficulty);
  if (fromByproduct !== undefined) return fromByproduct;

  // 3a. Auto falling back to a persisted legacy mode (migrated).
  if (persistedMode !== undefined && persistedMode !== null) {
    const migrated = migrateMode(persistedMode);
    if (migrated !== 'auto') return migrated;
  }

  // 3b. Auto falling back to the plan-derived auto mode.
  if (autoMode !== undefined) {
    const migrated = migrateMode(autoMode);
    if (migrated !== 'auto') return migrated;
  }

  // 4. Safety net.
  return 'balanced';
}
