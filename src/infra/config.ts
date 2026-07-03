/**
 * src/infra/config.ts — Global app configuration persisted at
 * <homeDir>/.myshell-tools/config.json.
 *
 * Reads merge over defaults so that new keys added in future versions are
 * always present even when the on-disk file pre-dates them.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout, resolveStateLayout, type AppStateLayout } from './state-layout.js';
import type { Intensity } from '../core/capacity-allocator.js';
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
  | 'apeEngage' // first time APE visibly chose to ask/plan/investigate
  | 'parallelGoal'; // first smart parallel goal run (concurrent scheduler)

export interface AppConfig {
  onboarded: boolean;
  setAsDefault: boolean;
  /**
   * When true, the user has explicitly opted OUT of the default-shell feature
   * (e.g. via Settings toggle). Distinguishes a real opt-out from an old
   * inherited `setAsDefault: false` that pre-dates the default-on migration.
   * Absent → no explicit opt-out recorded.
   */
  defaultShellOptOut?: boolean;
  /**
   * Persistent rollback for verify, judgment, and trust only. The emergency
   * `MYSHELL_ROLLBACK=1` environment form also engages rollback.
   */
  rollback?: boolean;
  /** Active routing mode. Absent → use DEFAULT_POLICY (same as 'balanced'). */
  mode?: 'cost-saver' | 'balanced' | 'quality-first';
  /** User-facing Intensity dial default (1=Focused … 5=Max). Absent → Auto (the smart default). */
  intensity?: Intensity;
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
   * OVERSIGHT SPECTRUM (Phase 2b). The per-user EXECUTION-AUTONOMY level — DISTINCT
   * from `partnerStyle` (which is only a soft CONVERSATIONAL bias). This dial decides
   * how much the user reviews vs. lets the partner run:
   *
   *   'review-all'  → cautious: propose-then-confirm AND pause after each to-do's
   *                   diff for a one-tap [Approve & continue] / [Stop here].
   *   'checkpoint'  → the safe middle (DEFAULT when absent): propose-then-one-tap-go
   *                   before launch, then run the manager cycle without per-diff
   *                   pauses (the Phase-2 behaviour, byte-identical).
   *   'autonomous'  → "just do it": skip the launch confirm, run, then surface a
   *                   confident done-summary. The safety floor stays (it still asks
   *                   at a genuine mid-run fork).
   *
   * Absent → 'checkpoint' (see resolveOversight / src/interface/ui/oversight.ts,
   * where the `MYSHELL_OVERSIGHT` env override and the reusable launch-checkpoint
   * seam live). Modelled on Claude Code's permission modes (review-each /
   * acceptEdits / Auto). Persisted like every other config key.
   */
  oversight?: 'review-all' | 'checkpoint' | 'autonomous';
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
   * Terminal color theme. Absent/'dark' → optimize for dark terminal backgrounds
   * (the common default). 'light' → skip ANSI faint (dim), which is near-invisible
   * on white/light backgrounds, so secondary text remains readable. Takes effect on
   * the next launch (MYSHELL_THEME is set from this value at startup). Toggle via
   * Settings [f].
   */
  colorTheme?: 'dark' | 'light';
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
   * Global intelligence features are always on. The per-feature opt-out flags
   * (MYSHELL_BOARD, MYSHELL_AUTO_GOAL, MYSHELL_DRAFT_GOALS, MYSHELL_SCHEDULER,
   * MYSHELL_INTENT_STORE_V1, MYSHELL_BLOCKED_STATE_V1, MYSHELL_CORRECTION_FORK_V1)
   * have been promoted to unconditional. Old config files with these keys still
   * load safely (unknown keys tolerated).
   *
   * GLOBAL BASIC-MODE escape hatch (default off → full intelligence ON). The six
   * intelligence subsystems (governor, verify, taste, judgment, trust, tribunal) are
   * ON BY DEFAULT and UNCONDITIONAL at the CLI entry point so the tool is automatic
   * and frictionless. Verify, judgment, and trust are always on unless
   * MYSHELL_ROLLBACK is engaged; tribunal can be opted out individually. Set this to
   * true (or `MYSHELL_BASIC` truthy in the environment) to drop back to plain
   * mode — ALL six resolve to false. The pure per-feature flag helpers keep their
   * semantics (so the flag-off neutrality suites stay byte-identical); this switch
   * lives at the composition root. See src/interface/ui/experimental-default.ts.
   */
  experimentalBasic?: boolean;
  // --- Governor, Verify, Trust, Taste, Judgment config fields removed (promoted to unconditional). ---
  /**
   * EXPERIMENTAL UNIFIED PREFLIGHT (default off; rank-7). When true (or with
   * `MYSHELL_UNIFY_PREFLIGHT` truthy in the environment), on the affected turn class
   * (ambiguous — no keyword tier evidence — AND substantial, with the intent pass
   * already scheduled) the router's tier/plan judgment is folded into the intent
   * extractor's single model round-trip, REMOVING one serial worker-tier call. The
   * deterministic risk floor stays authoritative (never model-driven). Pure
   * consolidation: it never increases the model-call count on any turn. The legacy
   * path is byte-identical when this is absent/false (the unified branch is
   * structurally unreachable). See src/core/router.ts (preflightUnifyEnabled /
   * combineRoute / unifiedPreflightApplies).
   */
  experimentalUnifyPreflight?: boolean;
  /**
   * EXPERIMENTAL INTENT-DERIVED RISK SIGNALS (default off; rank-8). When true (or
   * with `MYSHELL_RISK_SIGNALS` truthy in the environment), the single gated intent
   * extraction may emit optional risk hints (operationRisk/blastRadius) that are
   * combined MONOTONICALLY with the deterministic keyword risk floor: the model may
   * RAISE risk on genuine evidence of a dangerous/wide-blast operation, but can NEVER
   * lower it. Absent/invalid hints are inert. The legacy path is byte-identical when
   * this is absent/false (the raised-risk branch is flag-gated and the hint fields are
   * stripped from the frame). See src/core/router.ts (preflightRiskSignalsEnabled /
   * combineRisk).
   */
  experimentalRiskSignals?: boolean;
  /**
   * EXPERIMENTAL ENFORCED LOCAL-INVESTIGATION DIRECTIVE (default off; audit rank 9).
   * When true (or with `MYSHELL_REQUIRED_INVESTIGATION` ∈ {1,true,on,yes}), on an
   * INVESTIGATE_CONTEXT turn that the confidence brain did NOT already ground,
   * orchestrate runs ONE bounded `buildRetrievalContext` read-only retrieval before
   * the work call and carries its findings into execution. Reuses the existing
   * `ResearchPort` and caps; no new model call, no network, no embeddings. Default
   * OFF (absent/false) → the directive has no `requiredInvestigation` field, the
   * preflight never fires, and every path is byte-identical to today.
   */
  experimentalRequiredInvestigation?: boolean;
  /**
   * EXPERIMENTAL AGGREGATE PREFLIGHT-OVERHEAD GUARD (default off; audit rank 10).
   * When true (or with `MYSHELL_PREFLIGHT_GUARD` ∈ {1,true,on,yes}), orchestrate
   * counts the blocking pre-answer model calls actually taken this turn and SHEDS
   * the next avoidable optional one when the count would exceed the turn-class
   * budget, using only the EXISTING `CAPABILITY_BUDGET` ceiling and the EXISTING
   * `QuotaPressure` signal. NO new probe, NO token meter, NO model call. Default
   * OFF (absent/false) → the guard fields are omitted and every path is byte-
   * identical to today.
   */
  experimentalPreflightGuard?: boolean;
  /**
   * DARK SEMANTIC PREFLIGHT V1 (default off). When true (or with
   * `MYSHELL_SEMANTIC_PREFLIGHT_V1` in {1,true,on,yes}), entry points compose the
   * complete Item-8 semantic/evidence path and set OrchestrateDeps
   * semanticPreflightV1 for that turn. Absent/false preserves the legacy
   * route/intent preflight path exactly.
   */
  experimentalSemanticPreflightV1?: boolean;
  /**
   * EXPERIMENTAL RIVAL TRIBUNAL (default off; master-plan PHASE 9). When true (or with
   * `MYSHELL_TRIBUNAL` truthy in the environment), a genuine load-bearing IMPLEMENTATION
   * fork with ≥2 distinct authed vendors may be settled by a build-off: each vendor
   * BUILDS its assigned approach as a real diff in its OWN isolated git worktree, the
   * project's own tests cull a broken build, each rival's diff is cross-red-teamed by
   * the other vendor, and an HONEST winner (or `chosen=null`) is adjudicated from real
   * verdicts. NEVER fabricates a rival; degrades honestly to the normal single-vendor
   * work-call when <2 vendors / no buildable fork / a worktree can't be created. The
   * legacy path is byte-identical when this is absent/false (orchestrate's tribunal
   * branch is structurally unreachable). See src/interface/ui/tribunal-flag.ts /
   * src/core/tribunal.ts.
   */
  experimentalTribunal?: boolean;
  /**
   * Opt-in for RESEARCH-UNTIL-CONFIDENT's SECOND-ANGLE web re-research (the brain's
   * `'web'` investigation move; master-plan Phase 3b). DEFAULT OFF — absent/false →
   * the brain's `decideNextMove` never emits the `'web'` move, so the loop is
   * byte-for-byte today's. When true (or `MYSHELL_RESEARCH` ∈ {1,true,on,yes}) the
   * brain may, after a local codebase round has grounded a still-low-confidence
   * external/novel turn, re-query the web from a fresh angle (native search) until
   * confident or the round budget is spent. See src/core/research-flag.ts /
   * src/core/research.ts. The local Read/Grep retrieval is gated separately (the
   * researchPort), not by this flag.
   */
  experimentalResearch?: boolean;

  // experimentalPlanningDepth promoted to unconditional (2026-07-03).
  /**
   * Internal default-off rollout gate for PER-ITEM BLOCK/CONTINUE PARKING (Phase
   * D). When absent/false the manager-cycle fork branch behaves exactly as today
   * (a worker fork stops the whole goal cycle). When true (or `MYSHELL_ITEM_PARK`
   * ∈ {1,true,on,yes}) a forked item is PARKED (`status='blocked'`) and the cycle
   * continues with the next unblocked sibling. Dark until the D5 wiring lands. See
   * src/interface/ui/item-park-flag.ts.
   */
  experimentalItemParking?: boolean;
  /**
   * EXPERIMENTAL PER-GOAL MANAGER CYCLE (default off). When true (or with
   * `MYSHELL_MANAGER` truthy in the environment) AND an activated goal has a real,
   * non-empty roadmap, runGoalLoop DRIVES execution by the goal's to-do list
   * (elite-partner Part 7, Shape C): pick the next actionable to-do → run ONE
   * worker turn scoped to it → run a REAL tests-only verification → record the
   * honest per-item verdict (evidence-only) → mark it done only when the verdict
   * is passing/reviewed, else spawn a bounded fix-it to-do. When every item is
   * verified-done the EXISTING goal-level verified-done gate decides whether the
   * goal can settle `done`. Bounded by the turn ceiling + a fix-it cap; fully
   * fail-soft; never fabricates a pass. When this is absent/false (or the goal has
   * no roadmap) runGoalLoop is byte-for-byte today's free turn loop. See
   * src/interface/ui/manager-flag.ts / src/core/goal-manager.ts.
   */
  experimentalManager?: boolean;


  /**
   * EXPERIMENTAL Claude/Grok provider effort wiring (redesign Phase 0; default off).
   * When true (or with `MYSHELL_PROVIDER_EFFORT` ∈ {1,true,on,yes} in the
   * environment) the Claude and Grok provider adapters thread the normalized
   * `reasoningEffort` field from `ProviderRequest` onto their respective CLI flags
   * (`--effort <low|medium|high|xhigh|max>`). This is a live behavior change for
   * any run where `selectReasoningEffort` returns a non-`none` effort — the
   * provider CLI receives an explicit effort directive instead of using its built-in
   * default. Default-off is mandatory until this is validated across real runs.
   * THE OFF-GUARANTEE: when absent/false, `buildClaudeArgs` and `buildGrokArgs`
   * emit ZERO `--effort` flag — argv is byte-for-byte unchanged. See
   * src/providers/provider-effort-flag.ts and docs/one-chat-redesign-plan.md (Q4).
   *
   * Enable: MYSHELL_PROVIDER_EFFORT=1  OR  set "experimentalProviderEffort": true
   *         in ~/.myshell-tools/config.json.
   */
  experimentalProviderEffort?: boolean;
  /**
   * EXPERIMENTAL OpenCode account subscriptions (default off).
   * When true, and/or MYSHELL_SUBSCRIPTIONS is truthy, myshell may read
   * subscriptions.json, show the OpenCode Accounts menu, and route OpenCode
   * model calls through account-scoped XDG_DATA_HOME.
   */
  experimentalSubscriptions?: boolean;
  /**
   * EXPERIMENTAL Account-Aware Parallelism for hedged escalation (default off).
   * When true, and/or MYSHELL_ACCOUNT_PARALLELISM is truthy (AND the base
   * experimentalSubscriptions / MYSHELL_SUBSCRIPTIONS flag is also on), the hedge
   * path may use a distinct same-provider subscription account for its speculative
   * sibling arm in quality-first mode. Gated behind the base subscriptions flag;
   * default OFF. Absent means off.
   */
  experimentalAccountParallelism?: boolean;
  /**
   * EXPERIMENTAL Goal Steward deterministic audit (default off).
   * When true, and/or MYSHELL_GOAL_STEWARD is truthy, the goal steward
   * audits live goals for stale/inactive/blocked/verified-complete states
   * and surfaces findings in-conversation. No autonomous execution.
   */
  experimentalGoalSteward?: boolean;
  /**
   * EXPERIMENTAL Auto Smart Default (default off).
   * When true, and/or MYSHELL_AUTO_SMART is truthy, the absent config.mode
   * (Auto) becomes a standalone smart default instead of resolving to a fixed
   * preset via plan detection. Auto uses a neutral base policy (balanced) and
   * lets the per-turn governor + capacity allocator decide effort per turn,
   * with subscription/account inventory as capacity/headroom — not as a mode
   * alias. Flag OFF → byte-identical to today (Auto resolves via plan detection).
   */
  experimentalAutoSmart?: boolean;
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
  setAsDefault: true,
  autoUpdate: true,
  nativeSessions: true,
  smartRoute: true,
  // NOTE: panel + hedge are intentionally NOT statically default-on. They spend
  // extra quota (concurrent multi-provider panel / latency hedge) and the design
  // calls for them to be GOVERNED PER TURN by Auto, not a static always-on switch.
  // Leaving them off avoids a quota spike; per-turn Auto governance is future work.
  learnRouting: true,
  intentEngine: true,
};

// ---------------------------------------------------------------------------
// Layout resolution (homeDir compat bridge)
// ---------------------------------------------------------------------------

function resolveLayout(homeDir?: string, layout?: AppStateLayout): AppStateLayout {
  if (layout) return layout;
  if (homeDir !== undefined) {
    return resolveStateLayout({
      env: {},
      platform: 'linux',
      cwd: homeDir,
      homeDir,
    });
  }
  return defaultStateLayout();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the global app config.  Returns defaults merged with any on-disk
 * values so unknown/corrupt files never throw and new keys are always present.
 */
export async function loadConfig(homeDir?: string, layout?: AppStateLayout): Promise<AppConfig> {
  const l = resolveLayout(homeDir, layout);
  let raw: string;
  try {
    raw = await readFile(l.paths.configFile, 'utf8');
  } catch {
    // Missing file — return defaults
    return { ...DEFAULTS };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // Merge: defaults first, then on-disk values (new keys default safely)
    const merged = { ...DEFAULTS, ...parsed };

    // One-time migration: old configs with setAsDefault:false but no explicit
    // opt-out are ambiguous pre-default-on state → flip to default-on (true).
    // An explicit defaultShellOptOut:true means a deliberate toggle-off after
    // the migration, so leave setAsDefault false in that case.
    if (!merged.defaultShellOptOut && merged.setAsDefault === false) {
      merged.setAsDefault = true;
    }

    return merged;
  } catch {
    // Corrupt JSON — return defaults
    return { ...DEFAULTS };
  }
}

/**
 * Persist the app config atomically.  Creates the `.myshell-tools` directory
 * if it does not exist.
 *
 * CONTRACT (silent-data-loss guard): this writes EXACTLY the object it is given —
 * it does NOT read-merge the on-disk file. That is deliberate. Callers (the
 * Settings setters) now build the next config by spreading the FULL prior config
 * (`{ ...config, <field>: <value> }`), so the in-memory object is authoritative
 * and already carries every key — including ones the setter doesn't know about
 * (codebaseAwareness, seen, experimental*). A read-merge here would be the WRONG
 * fix: it could resurrect a key a caller intentionally removed (e.g. clearing
 * `mode` for Auto, or clearing `memory: false` when re-enabling memory), turning
 * an intended clear into a no-op. The safety net is structural instead — the
 * spread in the setters plus loadConfig's `{ ...DEFAULTS, ...parsed }` round-trip
 * (which preserves every on-disk key) — not a lossy merge in the writer.
 */
export async function saveConfig(config: AppConfig, homeDir?: string, layout?: AppStateLayout): Promise<void> {
  const l = resolveLayout(homeDir, layout);
  await mkdir(dirname(l.paths.configFile), { recursive: true });
  await atomicWrite(l.paths.configFile, JSON.stringify(config, null, 2));
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
