/**
 * src/infra/config.ts — Global app configuration persisted at
 * <homeDir>/.myshell-tools/config.json.
 *
 * Reads merge over defaults so that new keys added in future versions are
 * always present even when the on-disk file pre-dates them.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';
import { defaultStateHome } from './state-dir.js';
import type { PartnerStyle } from '../core/prompt-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Keys for the per-user "I have shown the first-touch explainer for surface X"
 * map (whole-tool-finish-5.5.md §0.1). Each new chat surface gets a single dim,
 * shown-once explainer the first time the user encounters it. See
 * core/first-touch.ts for the pure decision seam and the line text.
 */
export type FirstTouchKey =
  | 'memorySave' // first memory Save/Skip approval selector
  | 'intentReflect' // first "here's what I understand" intent reflection
  | 'panelWaiting' // first "Waiting on N models" panel status
  | 'recap' // first ※ recap on resume
  | 'apeEngage'; // first time APE visibly chose to ask/plan/investigate

export interface AppConfig {
  onboarded: boolean;
  setAsDefault: boolean;
  /** Active routing mode. Absent → use DEFAULT_POLICY (same as 'balanced'). */
  mode?: 'cost-saver' | 'balanced' | 'quality-first';
  /**
   * When true or absent (default), myshell-tools automatically updates itself
   * at startup when a newer version is available and relaunches the updated
   * binary.  Set to false (or `MYSHELL_NO_UPDATE=1` in the environment) to
   * disable auto-update and show only the notification banner instead.
   */
  autoUpdate?: boolean;
  /**
   * EXPERIMENTAL (default off). When true, a conversation that stays on the same
   * provider reuses that provider's native session (Claude `--session-id`/
   * `--resume`) instead of replaying a compacted history block into each prompt
   * — better context fidelity and less re-sent context. Scoped to Claude for
   * now. Verify live behavior with `npm run test:integration` before relying on it.
   */
  nativeSessions?: boolean;
  /**
   * EXPERIMENTAL Parallel Subscription Panel (default off). When true, hard
   * (high/critical-risk) turns run as a CONCURRENT panel of the user's signed-in
   * providers — each answers independently — then a cross-vendor synthesizer
   * adjudicates them into one answer. Maps to policy `panelPolicy: 'hard-turns'`.
   * Uniquely a subscription-first move: extra concurrent runs cost $0 in dollars
   * on a flat-rate plan (the only budget is quota + latency), buying independent
   * cross-vendor judgment a per-token-billed tool could never afford. A panel
   * only forms when ≥2 providers are authenticated; otherwise the normal
   * single-model path runs. See core/ensemble.ts.
   */
  panel?: boolean;
  /**
   * EXPERIMENTAL Latency-Hedged Escalation (default off). When true, high/
   * critical-risk turns that are likely to escalate hedge against latency: if the
   * cheap primary attempt is slow, a flagship attempt is started IN PARALLEL and
   * whichever finishes first with adequate confidence wins (the loser is
   * cancelled). Maps to policy `hedgePolicy: 'on'`. Uniquely a subscription-first
   * move: the cancelled branch costs $0 in dollars on a flat-rate plan — it spends
   * quota to buy wall-clock. Needs a delay port (provided by the wiring) and ≥1
   * signed-in provider. See core/hedge.ts.
   */
  hedge?: boolean;
  /**
   * Output verbosity for the chat TUI. Absent → 'normal' (a clean conversation:
   * the model's prose and nothing else). 'quiet' additionally suppresses the
   * per-turn status line; 'verbose' shows tool activity and per-tier telemetry
   * for power users who want to see the orchestration. Only affects what the TUI
   * prints — never what the model is asked to do.
   */
  verbosity?: 'quiet' | 'normal' | 'verbose';
  /**
   * Per-provider-call timeout in milliseconds. Absent → 120000 (2 min). Raise
   * for large manager-tier tasks that legitimately need more wall-clock before
   * being killed.
   */
  timeoutMs?: number;
  /**
   * Smart routing. ON by default (absent or true = on); set false to disable.
   * When on, turns the deterministic keyword classifier can't route (no tier
   * keyword matched — the ambiguous default) are handed to a cheap worker-tier
   * model that reads the message and picks the tier. Clear keyword turns still
   * route instantly with no model call. Fixes the misrouting of
   * complex-but-unkeyworded requests; costs ~5-10s on ambiguous turns only (a
   * worker classification spawn), with graceful fallback to the rules on any
   * failure/timeout. See core/router.ts + core/route-classifier.ts.
   */
  smartRoute?: boolean;
  /**
   * EXPERIMENTAL Local Outcome Learner (default off). When true, myshell-tools
   * reads THIS user's own ledger once at the start of a chat session and learns,
   * per tier, which signed-in provider has historically performed best (by
   * observed success rate, then latency). That learned order is then tried first
   * when routing each turn, so a provider that actually finishes your work fastest
   * gets preferred over the static default order. Observed-only: derived purely
   * from recorded outcomes (success + duration) — never plan/quota/tokens, and
   * never fabricated. Absent/false → routing is unchanged. See
   * core/routing-memory.ts.
   */
  learnRouting?: boolean;
  /**
   * EXPERIMENTAL Auto-goal (default off). When true, quality-first mode may
   * automatically enter the existing /goal loop for conservatively detected
   * multi-step work. Ignored in Efficient/Balanced. Absent/false → unchanged.
   */
  autoGoal?: boolean;
  /**
   * Partner posture (conversational style). A SOFT BIAS, not a hard mode (APE
   * §2): `direct`/`balanced`/`collaborative` seed an `engagementBias` of
   * `-1/0/+1` that shifts the engagement thresholds without ever forcing an
   * action the turn's signals contradict or crossing the safety floor. Absent →
   * resolved from `mode` (cost-saver→direct, balanced/auto→balanced,
   * quality-first→collaborative). Separate from `verbosity`, which is render
   * chrome only. See core/prompt-context.ts.
   */
  partnerStyle?: PartnerStyle;
  /**
   * INTENT ENGINE master switch (intent-engine §4, default ON but gated). When
   * absent/true, on substantial/ambiguous turns orchestrate runs ONE cheap,
   * read-only, short-timeout extractor pass to produce a typed IntentFrame, which
   * drives the persona reflection, work-contract seed, ask_user forks, and the
   * Adaptive Partner Engine's engagement plan. Trivial/clear turns skip the pass
   * entirely (zero overhead, no model call). `false` disables the extractor wiring
   * → orchestrate uses only the deterministic rules frame (the engagement policy
   * still runs, purely from {tier,risk}/route.plan). Any failure falls back to
   * rules. See core/intent.ts + core/intent-extractor.ts + core/engagement.ts.
   */
  intentEngine?: boolean;
  /**
   * CODEBASE AWARENESS master switch (codebase-awareness §6.1, Phase E1). Absent/
   * true → the chat gathers a cheap, deterministic ENVIRONMENT / repo-map
   * orientation block once per session (repo name/branch/dirty, project type, doc
   * presence, entry points, a ranked file map) and injects it via the prompt seam.
   * NO model call, NO embeddings, fully fail-soft. `false` is the kill-switch: no
   * scan, no block, byte-identical to pre-E1 prompts. See core/repo-map.ts.
   */
  codebaseAwareness?: boolean;
  /**
   * USER MEMORY master switch (memory-architecture §9). Absent/true → memory on
   * (read + inject + capture); false → the privacy kill-switch: no retrieval, no
   * injection, no proposals (existing facts remain listable/exportable). The
   * Settings "Memory: on/off" row toggles this; advanced keys below are
   * config-file-only in v1 to keep the menu lean.
   */
  memory?: boolean;
  /**
   * Where new facts default when scope is unspecified (§9). Default 'project'.
   */
  memoryDefaultScope?: 'global' | 'project';
  /**
   * Approval posture for MODEL-proposed memory (§9). Default 'always-ask'.
   */
  memoryApproval?: 'always-ask' | 'auto-save-explicit';
  /**
   * Base decay window (days) for importance level 2; levels 1/3 scale ×⅓/×4
   * (§6, §9). Default 90.
   */
  memoryDecayDays?: number;
  /**
   * Hard cap on non-archived facts per scope before capacity eviction (§6, §9).
   * Default 200.
   */
  memoryMaxFactsPerScope?: number;
  /**
   * EXPERIMENTAL Ink chat UI (default off). When true (or with `MYSHELL_INK`
   * truthy in the environment), the interactive menu mounts the new Ink-based
   * renderer instead of the legacy raw-mode render/readline path. Step 1 ships a
   * minimal skeleton (transcript + input box) behind this flag; the legacy path
   * is byte-identical when it is absent/false. See src/interface/ui/.
   */
  experimentalInk?: boolean;
  /**
   * EXPERIMENTAL bounded concurrent multi-goal SCHEDULER (default off). When true
   * (or with `MYSHELL_SCHEDULER` truthy in the environment), the /goal runner
   * routes the confirmed goal through `runSchedule` (src/core/scheduler.ts)
   * instead of the sequential single-goal loop. This phase decomposes to exactly
   * ONE brain-validated GoalSpec, so live behaviour matches the sequential path;
   * it exercises the merge/cancel seam ahead of real >1-goal decomposition. The
   * legacy path is unchanged when this is absent/false. See
   * src/interface/ui/scheduler-flag.ts.
   */
  experimentalScheduler?: boolean;
  /**
   * EXPERIMENTAL PERFORMANCE GOVERNOR (default off). When true (or with
   * `MYSHELL_GOVERNOR` truthy in the environment), orchestrate consults the pure
   * Performance Governor (src/core/governor.ts) ONCE per turn at the admission
   * seam: it classifies the task shape and returns an AllocationPlan (a hard
   * tier-adaptive per-turn call budget + which existing levers — model tier, depth,
   * verbosity — to spend on by quality-per-token). In Phase 2 the governor
   * COORDINATES the existing Oracle tier request through the SAME
   * authorizeTier/admitManager gates — it never bypasses them. The admission path
   * is BYTE-FOR-BYTE unchanged when this is absent/false. See
   * src/interface/ui/governor-flag.ts.
   */
  experimentalGovernor?: boolean;
  /**
   * EXPERIMENTAL VERIFICATION CENTERPIECE (default off; master-plan PHASE 3). When
   * true (or with `MYSHELL_VERIFY` truthy in the environment), a code-changing turn
   * runs a graduated, honest verify stage at the accept point: capture the diff →
   * tests-first (FREE local exec) → ONE diff-scoped cross-vendor critic when the
   * Governor's `verify` lever (or the conservative built-in default) selects it →
   * an honest four-state `verified` result {unverified|reviewed|passing|failing} +
   * a concise receipt. Subscription-only (tests = free; critic = a seat the user
   * owns). The accept path is BYTE-FOR-BYTE unchanged when this is absent/false (the
   * verify port is simply not injected). See src/interface/ui/verify-flag.ts.
   */
  experimentalVerify?: boolean;
  /**
   * EXPERIMENTAL LEARNED-TASTE LEDGER (default off; the Phase-7 free judgment
   * layer). When true (or with `MYSHELL_TASTE` truthy in the environment), the
   * chat loop RECORDS observed decision signals (fork choices, push-back outcomes,
   * accept-unchanged vs. immediate-edit/rephrase) into an append-only JSONL ledger
   * (src/infra/taste-ledger.ts) and RECALLS a distilled taste playbook that feeds
   * the `memoryBias` ask-vs-proceed dial + a short taste-context prompt block.
   * Records ONLY observed signals (never inferred), project-scoped via
   * deriveProjectKey, fail-soft (a corrupt/missing ledger degrades to no-bias). The
   * legacy path is byte-identical when this is absent/false. See
   * src/core/taste-flag.ts / src/core/taste.ts.
   */
  experimentalTaste?: boolean;
  /**
   * Per-user "first-touch explainer shown" flags (whole-tool-finish-5.5.md §0.1).
   * Absent → nothing shown yet (each surface explains itself once on first
   * encounter). Each key flips to true the first time that surface is met.
   * Forward-compatible: `loadConfig`'s merge preserves it, so a downgrade then
   * re-upgrade is safe and upgraders are never re-onboarded for surfaces they
   * have already met. See core/first-touch.ts.
   */
  seen?: Partial<Record<FirstTouchKey, true>>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: AppConfig = {
  onboarded: false,
  setAsDefault: false,
  autoUpdate: true,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getConfigDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools');
}

function getConfigPath(homeDir: string): string {
  return join(getConfigDir(homeDir), 'config.json');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the global app config.  Returns defaults merged with any on-disk
 * values so unknown/corrupt files never throw and new keys are always present.
 */
export async function loadConfig(homeDir?: string): Promise<AppConfig> {
  const home = homeDir ?? defaultStateHome();
  let raw: string;
  try {
    raw = await readFile(getConfigPath(home), 'utf8');
  } catch {
    // Missing file — return defaults
    return { ...DEFAULTS };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // Merge: defaults first, then on-disk values (new keys default safely)
    return { ...DEFAULTS, ...parsed };
  } catch {
    // Corrupt JSON — return defaults
    return { ...DEFAULTS };
  }
}

/**
 * Persist the app config atomically.  Creates the `.myshell-tools` directory
 * if it does not exist.
 */
export async function saveConfig(config: AppConfig, homeDir?: string): Promise<void> {
  const home = homeDir ?? defaultStateHome();
  await mkdir(getConfigDir(home), { recursive: true });
  await atomicWrite(getConfigPath(home), JSON.stringify(config, null, 2));
}

/**
 * Resolve the effective partner posture (soft bias) for a turn. An explicit
 * `config.partnerStyle` always wins; otherwise it is derived from the effective
 * routing mode so the dial has a sensible default without interrogating the user:
 *
 *   cost-saver    → direct
 *   balanced/auto → balanced
 *   quality-first → collaborative
 *
 * `effectiveMode` is the mode actually in force (the user's explicit `config.mode`
 * or the plan-auto-detected mode the caller already computed). Pure.
 */
export function resolvePartnerStyle(
  config: Pick<AppConfig, 'partnerStyle'>,
  effectiveMode: 'cost-saver' | 'balanced' | 'quality-first',
): PartnerStyle {
  if (config.partnerStyle !== undefined) return config.partnerStyle;
  switch (effectiveMode) {
    case 'cost-saver':
      return 'direct';
    case 'quality-first':
      return 'collaborative';
    case 'balanced':
    default:
      return 'balanced';
  }
}
