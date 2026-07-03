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
 *   - High     = a NEW genuinely-lighter rung BELOW Max (not just a narrower panel):
 *                quality-first flagship reachability, but a LOWER reasoning-effort
 *                floor (`high` vs Max's `max`), LIGHTER verification (`reviewPolicy`
 *                `critical-only` vs Max's `auto`), a less-eager escalation posture
 *                (lower `escalateBelowConfidence`), AND a narrower (2-provider) panel.
 *                "Strong but restrained" — the rung you reach for when you want depth
 *                without Max's full cross-provider deliberation + double-checking.
 *   - Max      ≈ quality-first turned fully on: deepest effort (`max`), the most
 *                thorough verification (`reviewPolicy` `auto`, eager escalation), and
 *                the broadest cross-provider deliberation (panel + hedge, up to 3
 *                providers). The top rung — strongest on every lever, not just panel.
 *   - Auto     = the smart default: NO fixed mode/policy of its own. It resolves
 *                per-turn from a PER-TURN ROUTE HINT that yields a rung tuple — a
 *                suggested rung ({@link AutoRouteHint}, NOT a coarse difficulty
 *                bucket), expanded into the six-dial {@link RungTuple}. The hint is
 *                meant to arrive as a BYPRODUCT of the turn the user is already having
 *                (no separate classification call); until that byproduct lands, Auto
 *                falls back to the existing autonomy/escalation heuristics — the
 *                user's persisted `config.mode` (if any) or the plan-derived auto
 *                mode. `resolveLevel` / `resolveRungTuple` are the clean seam for that
 *                byproduct; with the hint absent the fallback is byte-identical to
 *                today's session-`Mode` behavior.
 *
 * PURE — no I/O, no time, no randomness, no module state (matches the src/core/
 * purity guard in test/arch/guards.test.ts). It imports `Mode`, `Policy`,
 * `Intensity`, `Tier`, and `ReasoningEffort` as the SAME types the rest of core
 * uses, and builds policies by extending the shipped `POLICY_PRESETS`.
 *
 * PURE firepower-profile helpers — consumed by auto-brain, the menu, and the
 * orchestrator to resolve the effective `Level` / `RungTuple` from mode + config.
 */

import type { Policy, Tier } from './types.js';
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
  high: 'strong models, high effort, review on critical turns — deep but restrained (lighter than Max)',
  max: 'strongest models, deepest effort, thorough review + full cross-provider deliberation (panel + hedge)',
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
 * High and Max ride the quality-first envelope so flagship reachability + the
 * reasoning-effort selector's mode dimension stay consistent. They are then
 * DIFFERENTIATED below the mode layer: {@link policyForLevel} gives High lighter
 * verification + escalation + a narrower panel, and {@link baseEffortForLevel} gives
 * High a lower effort floor (`high` vs Max's `max`). So `levelToMode` is the same for
 * High/Max by design; the real High<Max gap lives in policy + effort. PURE.
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
 *   - high     → a GENUINELY-LIGHTER rung than Max, built FROM the quality-first
 *                preset (so it keeps `flagshipAdmission: 'always-eligible'` — High can
 *                still reach the flagship) but stepped DOWN on three independent
 *                levers, not just the panel:
 *                  • verification: `reviewPolicy` → `'critical-only'` (vs Max's
 *                    `'auto'`) — High reviews only the critical turns; Max reviews
 *                    high/critical + any model-requested review.
 *                  • escalation eagerness: `escalateBelowConfidence` stepped DOWN to
 *                    sit BETWEEN Balanced and Max — High escalates less readily than
 *                    Max (which escalates the soonest).
 *                  • panel width: `maxPanelProviders` → 2 (vs Max's 3).
 *                The reasoning-effort floor is ALSO lower (see {@link baseEffortForLevel}:
 *                High → `high`, Max → `max`). Built by extension so it tracks any
 *                future change to the quality-first preset's other fields.
 *   - max      → POLICY_PRESETS['quality-first'] verbatim — the TOP rung: deepest
 *                effort, most thorough verification (`reviewPolicy: 'auto'`, eager
 *                escalation), full panel + hedge (≤3 providers).
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
      // Genuinely-lighter-than-Max rung. Starts from the quality-first preset (keeps
      // flagship reachability + provider order) but steps DOWN on verification,
      // escalation eagerness, and panel width — so High < Max on real firepower, not
      // just panel count. Thresholds sit strictly between Balanced (0.4/0.5/0.7/0.8)
      // and Max (0.6/0.7/0.85/0.92): High escalates less eagerly than Max.
      return {
        ...POLICY_PRESETS['quality-first'],
        // Lighter verification than Max's 'auto': review only critical turns.
        reviewPolicy: 'critical-only',
        // Less-eager escalation than Max (between Balanced and Max on every risk).
        escalateBelowConfidence: {
          low: 0.5,
          medium: 0.6,
          high: 0.78,
          critical: 0.88,
        },
        // Narrower cross-provider panel than Max's 3.
        maxPanelProviders: 2,
      };
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
// Auto resolution — the clean seam for the byproduct PER-TURN ROUTE HINT.
// ---------------------------------------------------------------------------

/**
 * The RUNG TUPLE Auto resolves per turn — the locked predict-and-commit shape (see
 * docs/auto-mode-design.md §2.1 and "Auto — Locked Design Decisions"). Auto does NOT
 * emit a coarse difficulty bucket; it commits a concrete `level` (the rung) and the
 * six dials that rung implies. Every field is derived purely from the resolved level
 * via {@link rungTupleForLevel} — no new firepower types, no I/O.
 *
 *   - `level`        : the committed rung (budget…max), the headline of the tuple.
 *   - `modelRung`    : the {@link Tier} the rung wants route() to reach for (worker/
 *                      ic/manager). On a 1-model setup this collapses and `effort`
 *                      becomes the primary lever (design §2.6).
 *   - `effort`       : the normalized reasoning-effort floor for the rung.
 *   - `verifyDepth`  : how much verification the rung runs — `'none'` / `'self-check'`
 *                      / `'cross-vendor'` (1-model maps cross-vendor → a 2nd self pass).
 *   - `decompDepth`  : JIT-decomposition depth the rung favors (`'shallow'`/`'deep'`).
 *   - `concurrency`  : the rung's default {@link Intensity} (panel/hedge fan-out).
 *   - `contextBudget`: how much curated manager state the rung injects.
 */
export interface RungTuple {
  readonly level: Exclude<Level, 'auto'>;
  readonly modelRung: Tier;
  readonly effort: ReasoningEffort;
  readonly verifyDepth: 'none' | 'self-check' | 'cross-vendor';
  readonly decompDepth: 'shallow' | 'deep';
  readonly concurrency: Intensity;
  readonly contextBudget: 'lean' | 'standard' | 'rich';
}

/**
 * Derive the full {@link RungTuple} for a concrete level — PURE, total. This is how
 * a resolved rung expands into the six dials Auto commits, all read off the same
 * level so the tuple can never disagree with {@link profileForLevel}. The model rung,
 * effort, and concurrency reuse the existing per-level facts; verifyDepth / decompDepth
 * / contextBudget are the rung's deterministic posture on the remaining design dials.
 */
export function rungTupleForLevel(level: Exclude<Level, 'auto'>): RungTuple {
  const effort = baseEffortForLevel(level) as ReasoningEffort;
  const concurrency = defaultIntensityForLevel(level);
  switch (level) {
    case 'budget':
      return {
        level,
        modelRung: 'worker',
        effort,
        verifyDepth: 'none',
        decompDepth: 'shallow',
        concurrency,
        contextBudget: 'lean',
      };
    case 'balanced':
      return {
        level,
        modelRung: 'ic',
        effort,
        verifyDepth: 'self-check',
        decompDepth: 'shallow',
        concurrency,
        contextBudget: 'standard',
      };
    case 'high':
      return {
        level,
        modelRung: 'manager',
        effort,
        // Lighter than Max: a single self-check, not a cross-vendor pass.
        verifyDepth: 'self-check',
        decompDepth: 'deep',
        concurrency,
        contextBudget: 'rich',
      };
    case 'max':
      return {
        level,
        modelRung: 'manager',
        effort,
        // Top rung: full cross-vendor verification.
        verifyDepth: 'cross-vendor',
        decompDepth: 'deep',
        concurrency,
        contextBudget: 'rich',
      };
  }
}

/**
 * The per-turn ROUTE HINT that drives Auto — the SEAM for byproduct intelligence
 * (plan principle #1 + the locked predict-and-commit design). The hint is meant to
 * fall out of the turn the user is already having with their strong model (intent +
 * routeTier + risk emitted as structured byproduct), NOT a separate classifier call.
 *
 * The locked decision (resolving slice-2 open question Q3 in favor of a PER-TURN
 * SUGGESTED RUNG): the byproduct emits a `suggestedLevel` (the rung itself), NOT a
 * coarse difficulty bucket. The rung yields the whole {@link RungTuple}. The hint MAY
 * lower the deterministic floor, but {@link resolveRouteHint} NEVER lets it fall below
 * `floor` (which itself never drops below Budget — locked decision #3). Until the
 * byproduct lands (a later phase) every field is optional → Auto falls back to the
 * existing heuristics. PURE reference data only.
 */
export interface AutoRouteHint {
  /**
   * The rung the byproduct suggests for this turn — the primary, per-turn signal.
   * When present it drives the tuple (subject to the `floor` clamp below).
   */
  readonly suggestedLevel?: Exclude<Level, 'auto'>;
  /**
   * The deterministic floor the suggestion is clamped UP to (never below). Absent →
   * `'budget'` (the locked hard floor — the hint can never route below Budget).
   */
  readonly floor?: Exclude<Level, 'auto'>;
}

/** Rank of a concrete level on the budget→max ladder (for floor clamping). PURE. */
function levelRank(level: Exclude<Level, 'auto'>): number {
  switch (level) {
    case 'budget':
      return 0;
    case 'balanced':
      return 1;
    case 'high':
      return 2;
    case 'max':
      return 3;
  }
}

/**
 * Resolve a byproduct {@link AutoRouteHint} to a concrete level, clamping the
 * suggestion UP to its deterministic `floor` (default `'budget'`). Returns
 * `undefined` when there is no usable suggestion, so the caller falls back to the
 * persisted/auto-mode path. The clamp is the locked guard that the hint MAY lower the
 * floor but NEVER below Budget (decision #3). PURE, total.
 */
export function resolveRouteHint(
  hint: AutoRouteHint | undefined,
): Exclude<Level, 'auto'> | undefined {
  if (hint === undefined || hint.suggestedLevel === undefined) return undefined;
  const floor: Exclude<Level, 'auto'> = hint.floor ?? 'budget';
  // Clamp the suggestion UP to the floor (never below it).
  return levelRank(hint.suggestedLevel) >= levelRank(floor) ? hint.suggestedLevel : floor;
}

/**
 * Resolve the EFFECTIVE concrete level for a turn from the user's chosen level plus
 * the fallback chain. This is the single decision point Auto flows through:
 *
 *   1. A concrete chosen level (budget/balanced/high/max) wins outright.
 *   2. For `auto` (or an absent choice): if a byproduct ROUTE HINT with a suggested
 *      rung is present, use it ({@link resolveRouteHint}) — clamped to its floor.
 *   3. Else fall back to the EXISTING heuristics — the user's persisted legacy
 *      `config.mode` migrated to a level, or the plan-derived `autoMode`, in that
 *      order (mirroring today's `config.mode ?? resolveAutoMode` precedence).
 *   4. Final safety net: `balanced` (the safe middle), so this is total.
 *
 * PURE, total, never throws. The byproduct signal is intentionally a clean optional
 * seam: when it is absent (today), Auto behaves exactly like the existing auto path —
 * byte-identical fallback to today's session `Mode` behavior.
 */
export function resolveLevel(input: {
  /** The user's chosen level (absent → treated as `auto`). */
  readonly chosen?: Level;
  /** Per-turn byproduct route hint (the future Auto driver; absent today). */
  readonly routeHint?: AutoRouteHint;
  /** Persisted legacy `config.mode`, if any (for migration fallback). */
  readonly persistedMode?: Mode | string | null;
  /** Plan-derived auto mode (today's `resolveAutoMode`), if computed. */
  readonly autoMode?: Mode;
}): Exclude<Level, 'auto'> {
  const { chosen, routeHint, persistedMode, autoMode } = input;

  // 1. A concrete chosen level wins.
  if (chosen !== undefined && chosen !== 'auto') return chosen;

  // 2. Auto with a byproduct route hint (per-turn suggested rung, floor-clamped).
  const fromByproduct = resolveRouteHint(routeHint);
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

/**
 * Resolve the EFFECTIVE per-turn {@link RungTuple} for a turn — the same decision as
 * {@link resolveLevel}, expanded into the full six-dial tuple Auto commits. This is
 * the seam's TUPLE-shaped entry point: callers that want the whole predict-and-commit
 * tuple (not just the headline level) go through here. PURE, total. Defaults to the
 * `resolveLevel` fallback chain, so when the byproduct is absent it is byte-identical
 * to today's session-mode behavior.
 */
export function resolveRungTuple(input: {
  readonly chosen?: Level;
  readonly routeHint?: AutoRouteHint;
  readonly persistedMode?: Mode | string | null;
  readonly autoMode?: Mode;
}): RungTuple {
  return rungTupleForLevel(resolveLevel(input));
}
