/**
 * src/core/types.ts — shared types and ports for the orchestration core.
 *
 * This is the type hub. The pure core imports only types here (plus the
 * Provider port). I/O is reached exclusively through the injected port
 * interfaces below (Clock, SessionWriter, LedgerWriter), which infra
 * implements — that is what keeps `src/core/` free of fs/child_process while
 * remaining fully testable with fakes.
 *
 * Purity rule (enforced by test/arch/guards.test.ts): core code must obtain all
 * time, ids, and randomness from the injected `Clock`, never from Date/Math.
 */

import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import type { NativeSessionPlan } from './native-session.js';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Tier = 'worker' | 'ic' | 'manager';
export type Risk = 'low' | 'medium' | 'high' | 'critical';

// ---------------------------------------------------------------------------
// Structured user questions (assistant → user elicitation)
// ---------------------------------------------------------------------------

/**
 * A single selectable option for a {@link Question}. `label` is the short
 * machine/display value; `description` is optional human context.
 */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/**
 * A single multiple-choice question the assistant asks the user, mirroring
 * Claude Code's AskUserQuestion / MCP elicitation but transported in TEXT (the
 * model emits an `ask_user` JSON block; the orchestrator detects it; the TUI
 * renders a selector; the user's choice is fed back as the next turn).
 *
 * Flat, primitive-only by design (bounds enforced in questions.ts): 1–4
 * questions per set, each with 2–4 options.
 */
export interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly allowFreeText: boolean;
}

/** An ordered set of {@link Question}s the assistant asks in one turn. */
export interface QuestionSet {
  readonly questions: readonly Question[];
}

export interface Classification {
  readonly tier: Tier;
  readonly risk: Risk;
  /** Human-readable reason the classifier chose this tier/risk. */
  readonly rationale: string;
}

/** A concrete routing decision: which provider+model runs a tier. */
export interface RouteDecision {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string; // concrete model id
  /**
   * The selected reasoning-effort knob for this run, when the registry knows the
   * model supports one (capability registry §3/§5). ADDED to the type in Stage 2
   * for the shape, but NOT selected or threaded to any provider here — effort
   * selection + adapter wiring is Stage 3. Absent in Stage 2. Type-only import to
   * keep types.ts a leaf module.
   */
  readonly reasoningEffort?: import('./model-capabilities.js').ReasoningEffort;
  /**
   * Human-readable, audit-grade reasons capability-fit ranking chose this
   * provider/model (e.g. "context window 272k ≥ estimated 180k", "vision
   * supported for image input"). Populated ONLY when a `capabilityContext` is
   * passed to route(); ABSENT otherwise so the no-context path is byte-for-byte
   * unchanged. Capability-fit is a BOUNDED re-rank — these reasons never reflect a
   * provider outside `available`, a signed-out provider preferred over a signed-in
   * one, a bypass of authorizeTier/maxTier, or a model not in availableModels.
   */
  readonly capabilityReasons?: readonly string[];
}

/**
 * Result of assessing a model's output for real, verifiable signals.
 * `confidence` is null when the model emitted no parseable confidence envelope —
 * we never fabricate a number (Honesty Contract).
 */
export interface Assessment {
  readonly confidence: number | null;
  readonly escalate: boolean;
  readonly reason: string;
  readonly needsReview: boolean;
}

// ---------------------------------------------------------------------------
// Injected ports (infra implements these; core only sees the interfaces)
// ---------------------------------------------------------------------------

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** ISO-8601 timestamp string. */
  isoNow(): string;
  /** A unique identifier (uuid-like). */
  uuid(): string;
  /** A float in [0, 1). */
  random(): number;
}

export interface SessionEntry {
  readonly timestamp: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly tier?: Tier;
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly confidence?: number | null;
  readonly costUsd?: number;
  readonly durationMs?: number;
  /**
   * Provider-assigned native session/thread id for this turn, when the CLI
   * reported one (e.g. Codex thread id). Persisted in the append-only log so a
   * later turn can resume that provider's native session without a separate
   * store. Absent for providers that don't surface an id (Claude uses the
   * conversation id directly) or when native sessions are off.
   */
  readonly sessionId?: string;
  /**
   * Append-only AUDIT trail for multi-turn work contracts. Persisted and
   * validated for traceability; not consumed by runtime routing, review, or
   * goal-loop decisions today.
   */
  readonly workTrace?: import('./work-contract.js').WorkContract;
  /**
   * The engine BEHAVIOR version this turn was produced under (AP2-F / Stage 6,
   * adaptive-partner-v2-5.6.md §3, §4). Stamped onto ACCEPTED assistant entries
   * when persisted (see core/engine-version.ts::ENGINE_BEHAVIOR_VERSION), so a
   * later turn can IDENTIFY which transcript period a prior assistant turn was
   * written in and quarantine pre-fix prose even when its text is not an obvious
   * menu. ABSENT on legacy/pre-fix entries (and user/system turns) — an absent
   * marker is the pre-fix state and still loads (backward-compatible); the guard
   * accepts both present (a finite number) and absent.
   */
  readonly engineBehaviorVersion?: number;
}

export interface SessionWriter {
  readonly id: string;
  append(entry: SessionEntry): Promise<void>;
}

export interface LedgerEntry {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: Tier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly usd: number;
  readonly durationMs: number;
  readonly success: boolean;
  /**
   * The reasoning-effort knob this run used, when one was selected for the model
   * (capability registry §5). Recorded so a later outcome learner (Stage 4) can
   * weigh model/effort by task type, and so a reviewer can confirm the effort was
   * actually applied. Absent when no effort was threaded (the default) — old
   * ledger entries are unaffected and aggregate as "no effort". Type-only import
   * to keep types.ts a leaf module.
   */
  readonly reasoningEffort?: import('./model-capabilities.js').ReasoningEffort;
  /**
   * The deterministic task category this run served (capability registry §2
   * Layer 3 / Stage 4). Recorded so the model-level outcome learner can weigh a
   * (provider, model) by the KIND of task it tends to handle well, not just
   * overall. Reuses the SAME value orchestrate derives for routing
   * (deriveTaskKind), so the ledger records exactly what the router saw.
   *
   * Absent on old entries (and whenever it wasn't derived) — the aggregator
   * treats a missing value as `'unknown'`, so prior ledgers are unaffected and
   * `learnProviderOrder` output is byte-for-byte unchanged. Type-only import to
   * keep types.ts a leaf module.
   */
  readonly taskKind?: import('./model-capabilities.js').TaskKind;
}

export interface LedgerWriter {
  record(entry: LedgerEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Policy (thresholds & routing preferences; concrete values in policy.ts)
// ---------------------------------------------------------------------------

export interface Policy {
  /** Hard cap on tier attempts per task (loop/cost guard). */
  readonly maxAttempts: number;
  /** Escalate when self-reported confidence is strictly below this, indexed by risk. */
  readonly escalateBelowConfidence: Record<Risk, number>;
  /** Ordered provider preference per tier; route() honours availability. */
  readonly providerOrderByTier: Record<Tier, readonly ProviderId[]>;
  /**
   * Controls when cross-vendor review runs automatically.
   *
   * - `'auto'`          : review when risk is high/critical OR the model sets needsReview
   *                       (current default behaviour).
   * - `'critical-only'` : review only when risk is `critical` (or needsReview AND critical).
   * - `'off'`           : never trigger an automatic cross-vendor review.
   *
   * Omitting the field is equivalent to `'auto'` (backward-compatible).
   */
  readonly reviewPolicy?: 'auto' | 'critical-only' | 'off';
  /**
   * Hard ceiling on the tier a task may run at, regardless of how the message
   * was classified. e.g. `'ic'` clamps a message classified `'manager'` down to
   * `'ic'`, so a single soft keyword (e.g. "plan") can't launch the most
   * expensive model on a low-risk chat. Absent → no ceiling (classifier wins).
   *
   * @deprecated Superseded by {@link flagshipAdmission} as the primary control
   *   for manager-tier access. Retained as a compatibility fallback: when
   *   `flagshipAdmission` is absent, authorizeTier() derives it from this field
   *   (`'ic'` → `'never-auto'`, `'manager'`/absent → `'always-eligible'`).
   *   route()'s clampTier still honours it as a final safety net.
   */
  readonly maxTier?: Tier;

  /**
   * Flagship (manager-tier) admission posture — the modern replacement for the
   * static {@link maxTier} ceiling. On a flat-rate subscription the scarce
   * resource is quota/rate-limit headroom, not dollars, so manager access is an
   * adaptive per-turn decision (see core/flagship.ts::authorizeTier), not a fixed
   * cap.
   *
   * - `'never-auto'`      : never auto-open manager (Efficient). The user can
   *                         still pick Max explicitly.
   * - `'adaptive'`        : earn manager when the turn proves it needs it — high/
   *                         critical risk, low confidence, or a reviewer escalation —
   *                         bounded by {@link maxFlagshipAttemptsPerTurn} and vetoed
   *                         for an observed `free` plan (Balanced).
   * - `'always-eligible'` : manager allowed whenever classification/escalation asks
   *                         for it (Max).
   *
   * Absent → derived from {@link maxTier} for backward compatibility.
   */
  readonly flagshipAdmission?: 'never-auto' | 'adaptive' | 'always-eligible';

  /**
   * Under `'adaptive'` admission, the maximum number of manager-tier attempts a
   * single turn may earn (quota guard). Absent → 1. Ignored for the other
   * admission postures.
   */
  readonly maxFlagshipAttemptsPerTurn?: number;

  /**
   * EXPERIMENTAL — Parallel Subscription Panel. When/whether to run a turn as a
   * concurrent panel of the user's signed-in providers (each answers
   * independently) followed by a cross-vendor synthesizer, instead of the
   * sequential single-model path. This is uniquely a subscription-first move: on a
   * flat-rate plan extra model runs cost $0 in dollars — the budget is quota +
   * latency — so spending several concurrent runs on a hard turn buys independent
   * judgment an API-key tool would never afford.
   *
   * - `'off'`        : never (default; the sequential engine runs).
   * - `'hard-turns'` : panel only on high/critical-risk turns.
   * - `'always'`     : panel every turn (Max-style; quota-heavy).
   *
   * Absent → `'off'`. A panel still only forms when ≥2 authenticated providers are
   * available (see core/ensemble.ts::planPanel); otherwise the turn falls back to
   * the normal path.
   */
  readonly panelPolicy?: 'off' | 'hard-turns' | 'always';

  /**
   * Maximum number of providers to run concurrently in a panel (quota guard).
   * Absent → 2. Ignored when `panelPolicy` is `'off'`.
   */
  readonly maxPanelProviders?: number;

  /**
   * EXPERIMENTAL — Latency-Hedged Escalation. The sequential engine waits for a
   * cheap-tier attempt to finish (and be judged low-confidence) BEFORE it starts
   * a stronger escalation, so a slow weak attempt serially delays the strong one.
   * Hedging hides that latency: when the primary attempt is SLOW, it speculatively
   * starts a flagship attempt IN PARALLEL and takes whichever finishes first with
   * adequate confidence, cancelling the loser.
   *
   * - `'off'` : never hedge (default; the sequential engine runs unchanged).
   * - `'on'`  : on the turns likely to escalate (high/critical risk, flagship
   *             admittable), speculatively start the flagship if the primary is
   *             slow.
   *
   * Subscription-first rationale: on a flat-rate plan the wasted (cancelled)
   * branch costs $0 in dollars — the only budget is quota + the cancelled run —
   * so hedging SPENDS quota to buy wall-clock. Absent → `'off'`. Hedging only
   * happens when {@link OrchestrateDeps.sleep} is injected (the delay port).
   * See core/hedge.ts.
   */
  readonly hedgePolicy?: 'off' | 'on';

  /**
   * Under `'on'` hedging, how long the primary attempt may run before the
   * speculative flagship is started in parallel (the latency the user is willing
   * to wait before spending quota on a hedge). Absent → 4000 (4s). Ignored when
   * `hedgePolicy` is `'off'` or `OrchestrateDeps.sleep` is absent.
   */
  readonly hedgeDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Orchestration dependencies & event stream
// ---------------------------------------------------------------------------

export interface OrchestrateDeps {
  /** Available providers, keyed by id. Absent key = provider unavailable. */
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly clock: Clock;
  readonly session: SessionWriter;
  readonly ledger: LedgerWriter;
  readonly policy: Policy;
  readonly cwd: string;
  readonly sandbox: SandboxLevel;
  readonly timeoutMs: number;
  /**
   * Prior conversation history for context continuity. When provided, the most
   * recent turns are compacted and injected into the first provider prompt so
   * stateless one-shot providers (claude -p / codex exec) have multi-turn
   * awareness. Leave undefined for fresh (one-shot) sessions.
   */
  readonly history?: readonly SessionEntry[];
  /**
   * Advertised model lists from provider detection, keyed by provider id.
   * When supplied, route() restricts candidates to models that the provider CLI
   * actually advertises, preventing the CLI from routing to a model it cannot run.
   *
   * Absence (undefined) or an empty list for a provider → fall back to the
   * standard cheapest-for-tier pricing-table behaviour (backward-compatible).
   *
   * Only include providers that are installed; exactOptionalPropertyTypes is ON.
   */
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  /**
   * Image attachments for THIS turn (provider-capability audit opportunity #4,
   * image scope). Populated by the interface layer (menu.ts / cli.ts) from the
   * user's message: the PURE extractor (core/attachments.ts) finds candidate image
   * paths, then the interface layer keeps only those that EXIST on disk (the fs
   * existence check lives there, never in core). When present + non-empty,
   * orchestrate sets taskSignals.needsVision = true (so the shipped cross-provider
   * routing prefers a vision-capable provider) AND threads these onto every provider
   * request. ABSENT/empty → needsVision stays false and provider args are
   * byte-for-byte unchanged. Type-only import to keep types.ts a leaf module.
   */
  readonly attachments?: readonly import('./attachments.js').Attachment[];
  /**
   * The merged, structured capability registry (capability registry Layer 2 —
   * the SAME snapshot the self-awareness summary is derived from in cli.ts /
   * menu.ts; it is REUSED here, never recomputed). When present, orchestrate
   * builds a CapabilityRouteContext and passes it to route() so capability-fit
   * re-ranks models WITHIN the bounded candidate set and selectReasoningEffort
   * chooses the run's reasoning effort against the chosen model's facts.
   *
   * ABSENT (the default, and on any fail-soft refresh failure) → orchestrate
   * passes NO capability context to route() and selects NO effort, so behaviour
   * is byte-for-byte unchanged. Type-only import to keep types.ts a leaf module.
   */
  readonly capabilityRegistry?: import('./model-capabilities.js').CapabilityRegistry;
  /**
   * The set of provider IDs that are currently signed in (authenticated).
   *
   * When supplied and non-empty, route() prefers authenticated providers over
   * signed-out ones within the same tier, preventing wasted attempts against
   * providers that are installed but not logged in.
   *
   * When absent or empty → routing falls back to the existing fixed-preference-
   * order behaviour (backward-compatible).
   *
   * Only include providers whose `authenticated` flag is `true`; exactOptionalPropertyTypes is ON.
   */
  readonly authenticatedProviders?: readonly ProviderId[];
  /**
   * EXPERIMENTAL native session plans (opt-in via config.nativeSessions), one
   * per provider that has an active native session for this conversation. When
   * a turn routes to a provider that has a plan, orchestrate skips the replayed
   * history block and passes that provider's native session id instead, so the
   * provider carries prior context server-side. A turn routing to a provider
   * with no plan falls back to history replay (so switching providers is safe).
   *
   * Computed by the caller (the conversation layer) — absent for one-shot runs
   * and when the feature is disabled. See core/native-session.ts.
   */
  readonly nativeSession?: readonly NativeSessionPlan[];
  /**
   * Optional structured trace for genuinely multi-step work. The interface layer
   * owns long-running goal state and passes the current capped contract here;
   * orchestrate may persist it on the accepted assistant entry without rendering
   * it into conversation prose.
   */
  readonly workContract?: import('./work-contract.js').WorkContract;
  /**
   * True only for autonomous /goal turns. Suppresses the normal confidence
   * envelope prompt requirement because goal turns use GOAL_COMPLETE or
   * GOAL_CONTINUE as their sole trailing status marker.
   */
  readonly goalTurn?: boolean;
  /**
   * Soft partner posture (APE §2 — a SOFT BIAS, never a hard mode). Threaded
   * once per turn into every executor (sequential, hedge, panel) and rendered as
   * a one-line posture nudge via `assembleContextBlocks`. Absent → no nudge.
   * Resolved from config (`partnerStyle`, else default from `mode`) in the
   * deps-assembly layer. See core/prompt-context.ts.
   */
  readonly partnerStyle?: import('./prompt-context.js').PartnerStyle;
  /**
   * Pre-rendered, capped MEMORY block injected into every executor's prompt via
   * `assembleContextBlocks`. Populated by Phase 4 (memory injection); absent for
   * now. Threaded here so memory rides sequential, hedge, AND panel turns with no
   * further plumbing.
   */
  readonly memoryContext?: string;
  /**
   * Pre-rendered, truthful WORK STATE block (adaptive-partner-v2-5.6.md §2.3 B):
   * objective / evidence-backed done / model-stated next / blocked, derived from
   * accepted prior turns' persisted `workTrace` by `deriveWorkStateFromHistory`
   * (core/work-state.ts). Threaded here so it rides sequential, hedge, AND panel
   * prompts via `assembleContextBlocks` with no further plumbing. This is
   * task/session CONTINUITY, NOT memory (durable preference) — kept distinct and
   * seeded only from `workTrace`. Absent → omitted (truthful or absent). PURE
   * derivation: NO model call, no API key, no metered service.
   */
  readonly workStateContext?: string;
  /**
   * Pre-rendered, capped ENVIRONMENT / repo-map orientation block (codebase-
   * awareness §1.2, Phase E1) for the prompt seam. Deterministic, NO model call:
   * repo name/branch/dirty, project type, doc presence, key entry points, and a
   * ranked file map fit to a token budget. Gathered ONCE per chat session (the
   * repo map is stable within a session) and threaded here so orientation rides
   * sequential, hedge, AND panel prompts via `assembleContextBlocks`, where it is
   * rendered FIRST (orientation precedes MEMORY → INTENT → ENGAGEMENT → partner).
   * Absent → byte-identical to pre-E1 prompts. Producer: core/repo-map.ts.
   */
  readonly environmentContext?: string;
  /**
   * Pre-rendered, capped TOOL-STATE / "ABOUT THIS TOOL" block (tool self-awareness)
   * for the prompt seam. Deterministic, NO model call: authed subscriptions + plans
   * + count, the effective mode (auto vs explicit) + canonical mode meanings, smart-
   * routing state, and what the tool/partner can do. Assembled from the live
   * EnvironmentStatus + Config + version in the deps layer and rendered ADJACENT to
   * the ENVIRONMENT block by `assembleContextBlocks` so the model answers questions
   * about the user's own setup/mode accurately instead of hallucinating. Absent →
   * byte-identical to pre-self-awareness prompts. Producer: core/tool-state.ts.
   */
  readonly toolStateContext?: string;
  /**
   * Pre-rendered, capped VISION TRIAGE block (adaptive-partner-v2-5.6.md §2.4 C)
   * for the prompt seam. Computed ONCE per turn INSIDE orchestrate from the same
   * gated intent data (PURE, NO extra model call): a broad multi-part vision is
   * decomposed into SOLID / DISCUSS / MIGRATE_REARCHITECT / INVESTIGATE_THEN_PROPOSE
   * parts, with the instruction to address each per its disposition and recommend a
   * SEQUENCE rather than a generic menu. Threaded onto the per-turn deps copy so it
   * rides sequential, hedge, AND panel prompts via `assembleContextBlocks`. Absent
   * on a plain single-claim turn → byte-identical to pre-triage prompts.
   * Producer/consumer: core/vision-triage.ts.
   */
  readonly visionTriageContext?: string;
  /**
   * Pre-rendered, capped INTENT block (intent-engine §5.4) for the prompt seam.
   * Computed ONCE per turn INSIDE orchestrate (gated — substantial/ambiguous
   * turns only) and threaded onto a per-turn deps copy so it rides sequential,
   * hedge, AND panel prompts via `assembleContextBlocks`. Absent on trivial turns
   * → byte-identical to pre-intent prompts. Producers/consumers: core/intent.ts.
   */
  readonly intentFrame?: string;
  /**
   * Pre-rendered ENGAGEMENT block (APE §6.4) for the prompt seam. Computed ONCE
   * per turn INSIDE orchestrate alongside the intent block; surfaced ONLY when the
   * engagement plan produces a visible action (else absent — the silent mechanics
   * are never rendered). Rides sequential, hedge, AND panel via
   * `assembleContextBlocks`. Producers/consumers: core/engagement.ts.
   */
  readonly engagementPlan?: string;
  /**
   * Optional model-brained INTENT extractor — the gated cheap subscription pass
   * that populates an `IntentFrame` on substantial/ambiguous turns (intent-engine
   * §5.1). Mirrors `routeClassifier` exactly: orchestrate consults it ONLY behind
   * the pure `shouldExtractIntent` gate, and falls back to `rulesIntentFrame` on
   * any failure/timeout (returns null). Absent → the intent engine is skipped,
   * byte-identical to the pre-intent behaviour. The infra layer builds it from the
   * cheapest available provider (see core/intent-extractor.ts).
   *
   * Typed inline (not imported) to keep types.ts a leaf module; structurally
   * identical to intent.ts's IntentExtractor.
   */
  readonly intentExtractor?: (
    task: string,
    signal: AbortSignal,
  ) => Promise<import('./intent.js').IntentFrame | null>;
  /**
   * Optional model-brained route classifier. When wired, orchestrate consults it
   * ONLY on turns the deterministic keyword classifier couldn't route (no tier
   * evidence — see core/router.ts), and falls back to the rules on any failure or
   * timeout (returns null). Absent → routing is purely deterministic, identical
   * to the pre-router behaviour. The infra layer builds this from the cheapest
   * available provider so the routing decision itself stays cheap.
   *
   * Typed inline (not imported from router.ts) to keep types.ts a leaf module;
   * structurally identical to router.ts's ModelClassifier.
   */
  readonly routeClassifier?: (
    task: string,
    signal: AbortSignal,
  ) => Promise<{ readonly tier: Tier; readonly plan: boolean; readonly reason: string } | null>;
  /**
   * Observed plan classification per provider (from classifyPlan), supplied by
   * the conversation layer as an immutable snapshot. Consulted by the adaptive
   * flagship-admission gate (core/flagship.ts) to veto auto-opening the flagship
   * when the only observed plan is `free` (quota preservation). Absent → no plan
   * signal, so the veto never fires (we never fabricate a plan). The value type is
   * `PlanInfo` from core/policy.ts; typed structurally here to keep types.ts a leaf.
   */
  readonly planInfos?: Partial<
    Record<
      ProviderId,
      {
        readonly raw: string | null;
        readonly tier: 'max' | 'pro' | 'free' | 'unknown';
        readonly confidence: 'observed' | 'inferred' | 'none';
      }
    >
  >;
  /**
   * EXPERIMENTAL learned provider-preference order per tier (opt-in via
   * config.learnRouting; default absent). An immutable snapshot computed ONCE by
   * the conversation layer from THIS user's own ledger (core/routing-memory.ts):
   * for each tier, the providers ranked by observed success rate then latency.
   *
   * When present for a tier, route() tries that order FIRST (still auth-aware:
   * it prefers the first learned provider that is available AND, when auth info
   * is present, authenticated), falling back to the static `providerOrderByTier`
   * only when the learned order yields no eligible provider.
   *
   * OBSERVED-ONLY: derived purely from recorded outcomes (success + duration) —
   * never from plan/quota/tokens, and never fabricated. Absent (the default, and
   * for one-shot runs / when the feature is off) → routing is unchanged.
   */
  readonly learnedProviderOrder?: Partial<Record<Tier, readonly ProviderId[]>>;
  /**
   * EXPERIMENTAL learned MODEL-level outcome order, keyed by task kind (capability
   * registry §2 Layer 3 / Stage 4; opt-in via config.learnRouting, default absent).
   * An immutable snapshot computed ONCE by the conversation layer from THIS user's
   * own ledger (core/routing-memory.ts::learnModelOutcomeOrder): for each task kind
   * with enough signal, the (provider, model) pairs ranked by smoothed success
   * rate, then latency, then token use.
   *
   * When present for the turn's taskKind, orchestrate threads that order into the
   * CapabilityRouteContext as a WEAK tie-break that route() applies ONLY AFTER hard
   * capability requirements and ONLY within the already-bounded candidate models of
   * the already-chosen provider — it never overrides a capability fit, never changes
   * provider, and never bypasses auth/cooldown/authorizeTier.
   *
   * Below the conservative thresholds (min runs per provider/model/taskKind, min
   * candidates) the aggregator returns null and no entry is added, so behaviour is
   * byte-for-byte unchanged. Absent (the default, one-shot runs, feature off, or
   * cold start) → routing is unchanged. Type-only import to keep types.ts a leaf.
   */
  readonly modelOutcomeOrderByTaskKind?: Partial<
    Record<
      import('./model-capabilities.js').TaskKind,
      readonly import('./model-capabilities.js').ModelPreference[]
    >
  >;
  /**
   * Injected delay port for Latency-Hedged Escalation (core/hedge.ts). Resolves
   * after roughly `ms` milliseconds. Injected (rather than calling setTimeout
   * directly) so the core stays pure AND so hedging's timing is deterministically
   * testable: the real wiring provides a setTimeout-based impl, while tests
   * provide a controllable one (e.g. a never-resolving promise to force "primary
   * finishes first", or an immediately-resolving one to force "delay elapses
   * first"). Absent → hedging cannot run (planHedge returns null), so the
   * sequential path is used. See Policy.hedgePolicy.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * High-level events emitted by orchestrate(). The interface/render layer
 * consumes these; every field is a real measurement (no fabricated values).
 */
export type CoreEvent =
  | { readonly type: 'classified'; readonly classification: Classification }
  | {
      /**
       * The turn's extracted INTENT frame (intent-engine §5.3). Emitted once per
       * turn after classification, ONLY on substantial/ambiguous turns that ran
       * the gate (trivial turns skip it entirely). Render-optional: the render
       * layer may surface a one-line reflection or ignore it, like other notices.
       */
      readonly type: 'intent';
      readonly frame: import('./intent.js').IntentFrame;
    }
  | {
      /**
       * The turn's ENGAGEMENT plan (APE §6.1). Emitted once per turn after the
       * intent stage. Render-optional and per the locked default surfaced ONLY
       * when it produces a visible action; the silent mechanics are never shown.
       */
      readonly type: 'engagement';
      readonly plan: import('./engagement.js').EngagementPlan;
    }
  | {
      /**
       * A typed execution-PHASE signal for the presentation layer (Phase 8). It
       * lets the renderer drive the multi-agent "Waiting on N models" panel state
       * machine from a real, explicit event instead of sniffing the composition
       * `notice("Panel: …")` string or guessing from the count of up-front
       * `tier-start`s.
       *
       * - `'panel'`     : emitted ONCE by `runPanel` at composition time, right
       *                   after the panel notice and BEFORE the up-front candidate
       *                   `tier-start`s. `participants` lists the candidate
       *                   providers that are about to run concurrently, in order.
       *                   The renderer enters panel mode and shows "Waiting on N
       *                   models", ticking each off as its real `tier-done` arrives.
       * - `'synthesis'` : emitted ONCE after all candidate `tier-done`s and before
       *                   the synthesizer `tier-start`. `count` is the number of
       *                   SUCCESSFUL candidate answers being synthesized. The
       *                   renderer switches the line to "Synthesizing N answers…".
       *
       * Purely additive chrome: every existing consumer ignores an unknown event
       * type, so this changes no behaviour. The sequential and hedge paths never
       * emit it, so they keep their single-model presentation (no fake race).
       */
      readonly type: 'phase';
      readonly phase: 'panel' | 'synthesis';
      /** The concurrent panel candidates (phase 'panel' only), in run order. */
      readonly participants?: readonly ProviderId[];
      /** The number of successful candidate answers (phase 'synthesis' only). */
      readonly count?: number;
    }
  | {
      readonly type: 'tier-start';
      readonly tier: Tier;
      readonly provider: ProviderId;
      readonly model: string;
      readonly attempt: number;
      /**
       * A human, one-line GOAL LABEL for the live status panel (orchestration-UX
       * redesign Phase 2). Derived from the cheapest TRUTHFUL signal already in
       * scope at the emit site — the work-contract `objective`, else the intent
       * frame's `goal`, else the capped user task. Capped to ~72 visible chars by
       * `capGoalLabel`. NEVER fabricated; absent on a turn with no usable signal,
       * in which case the renderer falls back to the bare tier id. The tier itself
       * stays the dim secondary badge alongside this title.
       */
      readonly title?: string;
      /**
       * The turn's classified RISK (low/medium/high/critical), passed through for
       * the dim "tier · risk" secondary badge on the goal card. A real measurement
       * from the classifier (never fabricated); absent → the badge shows the tier
       * only. Phase 2 of the orchestration-UX redesign.
       */
      readonly risk?: Risk;
    }
  | {
      readonly type: 'provider-event';
      readonly tier: Tier;
      readonly event: import('../providers/port.js').ProviderEvent;
    }
  | {
      readonly type: 'tier-done';
      readonly tier: Tier;
      readonly success: boolean;
      readonly confidence: number | null;
      /** Estimated USD — retained for the ledger and the on-demand `cost` view;
       *  NOT shown on the hot path (this is a subscription tool, not API-billed). */
      readonly costUsd: number;
      /** Real, measured token counts — the transparent primary signal shown live. */
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly durationMs: number;
    }
  | {
      readonly type: 'escalate';
      readonly from: Tier;
      readonly to: Tier;
      readonly reason: string;
    }
  | {
      readonly type: 'failover';
      readonly from: ProviderId;
      readonly to: ProviderId;
      readonly tier: Tier;
      readonly reason: string;
    }
  | {
      readonly type: 'notice';
      readonly level: 'info' | 'warn' | 'error';
      readonly message: string;
    }
  | {
      readonly type: 'final';
      readonly success: boolean;
      readonly output: string;
      readonly tier: Tier;
      readonly totalCostUsd: number;
      readonly sessionId: string;
      readonly attempts: number;
      /** Set on user-initiated cancellation finals so renderers do not present it as an error. */
      readonly canceled?: boolean;
      /** Set on failing finals only: the error category that caused the failure. */
      readonly errorCategory?: import('../providers/port.js').CliError['category'];
      /** Set on failing finals only: the provider that was being used when failure occurred. */
      readonly provider?: import('../providers/port.js').ProviderId;
      /**
       * Set when the model ended its turn by asking the user one or more
       * structured questions (an `ask_user` block) instead of completing work.
       * The interface layer renders a selector for these and feeds the answer
       * back as the next turn in the same conversation. When present the turn is
       * a complete success that needs a reply — NOT low-confidence work — so
       * orchestrate does not escalate or review. Absent for normal turns.
       */
      readonly questions?: QuestionSet;
      /**
       * Set when the model proposed durable user memory via a trailing
       * `remember_user` block (parsed by `parseRememberUser`, carried INSIDE the
       * confidence envelope). Attached only on NORMAL successful turns and NEVER
       * alongside `questions` (the model never emits `ask_user` with
       * `remember_user` — memory doc §8). At least one proposed fact has passed
       * `worthGate`; the interface renders a Save/Skip/Edit selector for it via
       * the post-turn slot (MASTER-PLAN MF3). Unlike `questions` it does NOT
       * short-circuit the turn — the turn is still a complete success.
       */
      readonly memoryProposal?: import('./user-memory.js').RememberProposal;
      /**
       * Set on a SUCCESS final that the loop returned as a best-effort answer:
       * the bounded escalation/review loop exhausted its attempt budget without
       * a clean accept, but a substantive answer WAS produced. We return that
       * answer (never discard usable work as "Failed") and flag it best-effort so
       * the renderer can honestly note it was not fully verified / stayed under
       * the confidence bar. Absent on a normal, fully-accepted success.
       */
      readonly bestEffort?: true;
    };
