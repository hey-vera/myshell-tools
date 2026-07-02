import type { OrchestrateDeps, SessionEntry, Tier } from '../core/types.js';
import type { RoadmapItem } from '../core/work-contract.js';
import {
  chooseInitialPlanningDepth,
  choosePlannerTier,
  needStrongPlanner,
  planningDepthCap,
  planningSelectionEntitlement,
  shouldRunPlanningSelection,
  type FirstPlanSelectionEvidence,
  type PlanningSelectionScope,
} from '../core/autonomy.js';
import { classify } from '../core/classify.js';
import { autoIntensityForTurn } from '../core/capacity-allocator.js';
import type { QuotaPressure } from '../core/capability-budget.js';
import type { GoalPlan, GoalPlanTodo } from '../core/goal-plan.js';
import { isDuplicateGoalTitle } from '../core/goal-todo.js';
import { formatAutoStageNote } from '../core/goal-proposal.js';
import {
  formatGoalPlanSelectionDisclosure,
  formatGoalPlanSelectionNotice,
  selectGoalPlan,
} from '../core/ensemble.js';
import { panelAllowedForShape } from '../core/governor.js';
import type { Mode } from '../core/policy.js';
import { repoStateChanged, type RepoFingerprint } from '../core/repo-identity.js';
import type { SystemModel } from '../core/understanding.js';
import type { GoalStore } from '../infra/goal-store.js';
import { helperSandbox } from '../infra/sandbox.js';
import type { AppConfig } from '../infra/config.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { ProviderId } from '../providers/port.js';
import type { TurnCallBudget } from '../core/turn-call-budget.js';
import { dim } from '../ui/theme.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import { resolveAutoMode, resolveIntensity, planBudgetCeiling } from './menu-auto-mode.js';
import { autoSmartEnabled } from './ui/auto-smart-flag.js';

export type WarmUnderstanding = (cacheKey: string, line: string) => void;

export interface AutoStageContext {
  upstreamBlockingCalls: number;
}

export interface AutoStageEngineContext {
  upstreamBlockingCalls: number;
  systemModelCache: Map<string, { model: SystemModel; atTurn: number; fp?: RepoFingerprint }>;
  understandingWarmInFlight: Set<string>;
  autoStageTurns: number;
  /** Per-turn latch so the stale-repo re-grounding note is emitted at most once. */
  staleRepoFlagged: boolean;
}

export interface JudgedGoal {
  judgment: GoalPlan['judgment'];
  title: string;
  roadmap: RoadmapItem[];
  clarifyingQuestion?: string;
  /** The goal's best-approach (chosen + why), when the planner stated one. */
  approach?: GoalPlan['goals'][number]['approach'];
  /** The FULL judged plan (vision + every goal's todos/deps/approach), when the
   *  planner produced one — the raw material the PROPOSAL renderer renders.
   *  Absent on the smart-label fallback (no model plan to show). */
  plan?: GoalPlan;
  /** The warm whole-picture SystemModel used to ground this judgment (when one
   *  was cached) — the source of the proactive heads-up findings. */
  systemModel?: SystemModel;
}

export interface AutoStageEngine {
  judgeGoal: (goalText: string) => Promise<JudgedGoal>;
  warmUnderstanding: WarmUnderstanding;
  resolveAutoStage: (line: string, opts?: { intentVersionId?: string; linkIntentVersion?: boolean }) => Promise<void>;
}

type GoalPlanner = (userMessage: string, signal: AbortSignal, opts?: { intentVersionId?: string }) => Promise<GoalPlan | null>;
type GoalPlannerAttempt = {
  readonly plan: GoalPlan | null;
  readonly provider: ProviderId;
  readonly model: string;
  readonly raw: string;
};
type GoalPlannerAttemptRunner = (
  userMessage: string,
  signal: AbortSignal,
  opts?: { intentVersionId?: string },
) => Promise<GoalPlannerAttempt | null>;
type TasteContext = {
  tasteContext?: string;
  memoryBias?: -1 | 0 | 1;
  tastePlaybookLines?: readonly string[];
};

export interface AutoStageEngineDeps {
  readonly autoCtx: AutoStageEngineContext;
  readonly autoStageOn: boolean;
  readonly understandingOn: boolean;
  readonly planningDepthOn: boolean;
  readonly tasteOn: boolean;
  readonly ROADMAP_LIMIT: number;
  readonly UNDERSTANDING_REFRESH_TURNS: number;
  readonly ctx: MenuContext;
  readonly mutableCtx: { config: AppConfig; env: EnvironmentStatus };
  readonly out: OutputSink;
  readonly convId: string;
  readonly goalStore: GoalStore;
  readonly syncBoard: () => Promise<void>;
  readonly currentPressure: () => QuotaPressure;
  readonly resolveProjectKeyOnce: () => Promise<string | null>;
  readonly resolveCacheKey: () => Promise<string>;
  readonly resolveRepoFingerprintOnce: () => Promise<RepoFingerprint>;
  /** The (memoized) repo fingerprint for THIS turn, or undefined before it is resolved. */
  readonly repoFingerprint: () => RepoFingerprint | undefined;
  readonly verificationAvailableForCwd: (cwd: string) => Promise<boolean>;
  readonly todosToRoadmap: (todos: readonly GoalPlanTodo[]) => RoadmapItem[];
  readonly buildGoalPlanner: (systemModel?: SystemModel, tasteContext?: string, turnCallBudget?: TurnCallBudget) => GoalPlanner | null;
  readonly buildGoalPlannerAttempt: (
    tier: Extract<Tier, 'ic' | 'manager'>,
    systemModel?: SystemModel,
    tasteContext?: string,
  ) => GoalPlannerAttemptRunner | null;
  readonly getBudgetForTurn?: (turnId: string) => TurnCallBudget | undefined;
  readonly getCurrentTurnId?: () => string | undefined;
  readonly buildUnderstandingPass: (
    repoContext: string,
    highStakes: boolean,
    timeoutMs?: number,
  ) => ((task: string, signal: AbortSignal) => Promise<SystemModel | null>) | null;
  readonly buildDeps: (
    hist: readonly SessionEntry[],
    memoryContext?: string,
    environmentContext?: string,
    taste?: TasteContext,
    turnCallBudget?: TurnCallBudget,
    sink?: OutputSink,
  ) => OrchestrateDeps;
  /** Resolve the distilled taste-playbook prompt block for a planning pass, or
   *  undefined when taste is off / empty. Mirrors the per-call inline body the
   *  closures used before extraction. */
  readonly resolvePlannerTasteContext: () => Promise<string | undefined>;
  readonly formGoalLabel: (rawText: string) => Promise<string>;
  readonly resolveEnvironmentOnce: () => Promise<string>;
  readonly conversationLive: () => boolean;
}

export function createAutoStageContext(): AutoStageContext {
  return {
    upstreamBlockingCalls: 0,
  };
}

export function createAutoStageEngineContext(
  upstreamCtx: AutoStageContext,
): AutoStageEngineContext {
  return {
    get upstreamBlockingCalls(): number {
      return upstreamCtx.upstreamBlockingCalls;
    },
    set upstreamBlockingCalls(value: number) {
      upstreamCtx.upstreamBlockingCalls = value;
    },
    systemModelCache: new Map<string, { model: SystemModel; atTurn: number; fp?: RepoFingerprint }>(),
    understandingWarmInFlight: new Set<string>(),
    autoStageTurns: 0,
    staleRepoFlagged: false,
  };
}

export function createAutoStageEngine(deps: AutoStageEngineDeps): AutoStageEngine {
  // Detect a warm entry built under a PRIOR fingerprint that differs from the
  // current one; emit one dim re-grounding line. Fail-soft + once-per-turn. We
  // search by project (cacheKey is already fingerprint-qualified, so a changed
  // repo simply misses; this scans for a stale-but-warm sibling to explain why).
  const noteStaleRepoIfNeeded = (): void => {
    const current = deps.repoFingerprint();
    if (deps.autoCtx.staleRepoFlagged || !deps.understandingOn || current === undefined) return;
    for (const entry of deps.autoCtx.systemModelCache.values()) {
      if (entry.fp !== undefined && repoStateChanged(entry.fp, current)) {
        deps.autoCtx.staleRepoFlagged = true;
        deps.out.write(dim('  (repo changed since last understanding — re-grounding)\n', deps.out.color));
        return;
      }
    }
  };

  const warmUnderstanding = (cacheKey: string, line: string): void => {
    if (deps.autoCtx.understandingWarmInFlight.has(cacheKey)) return;
    deps.autoCtx.understandingWarmInFlight.add(cacheKey);
    // Snapshot the (already-memoized) fingerprint so the warm entry records the
    // repo state it was built under — lets a later turn detect staleness.
    const fp = deps.repoFingerprint();
    void (async (): Promise<void> => {
      try {
        const risk = classify(line).risk;
        const highStakes = risk === 'high' || risk === 'critical';
        const repoContext = await deps.resolveEnvironmentOnce().catch(() => '');
        const pass = deps.buildUnderstandingPass(repoContext, highStakes); // generous bg budget
        if (pass !== null) {
          // rank-10: understanding warmup is a blocking pre-answer model call
          // upstream of the turn that benefits from it.
          deps.autoCtx.upstreamBlockingCalls += 1;
          const model = (await pass(line, new AbortController().signal)) ?? undefined;
          if (model !== undefined) {
            deps.autoCtx.systemModelCache.set(cacheKey, {
              model,
              atTurn: deps.autoCtx.autoStageTurns,
              ...(fp !== undefined ? { fp } : {}),
            });
          }
        }
      } catch {
        /* fail-soft: stays ungrounded until a future warm lands */
      } finally {
        deps.autoCtx.understandingWarmInFlight.delete(cacheKey);
      }
    })();
  };

  const judgeGoal = async (goalText: string): Promise<JudgedGoal> => {
    if (!deps.planningDepthOn) {
      const cacheKey = await deps.resolveCacheKey();
      const warm = deps.autoCtx.systemModelCache.get(cacheKey)?.model;
      if (deps.understandingOn && warm === undefined) {
        noteStaleRepoIfNeeded();
        warmUnderstanding(cacheKey, goalText);
      }
      const roadmapFor = (todos: readonly GoalPlanTodo[]): RoadmapItem[] =>
        todos.length > 0
          ? deps.todosToRoadmap(todos.slice(0, deps.ROADMAP_LIMIT))
          : deps.todosToRoadmap([{ text: goalText }]);
      const tasteCtx = await deps.resolvePlannerTasteContext();
      const planner = deps.buildGoalPlanner(warm, tasteCtx);
      if (planner !== null) {
        try {
          const plan = await planner(goalText, new AbortController().signal);
          if (plan !== null) {
            const g0 = plan.goals[0];
            const title = g0?.title.trim();
            if (plan.judgment === 'clarify') {
              const q = plan.clarifyingQuestion?.trim();
              return {
                judgment: 'clarify',
                title: title !== undefined && title.length > 0 ? title : await deps.formGoalLabel(goalText),
                roadmap: roadmapFor(g0?.todos ?? []),
                ...(q !== undefined && q.length > 0 ? { clarifyingQuestion: q } : {}),
                ...(g0?.approach !== undefined ? { approach: g0.approach } : {}),
                plan,
                ...(warm !== undefined ? { systemModel: warm } : {}),
              };
            }
            if (g0 !== undefined && title !== undefined && title.length > 0 && g0.todos.length > 0) {
              return {
                judgment: 'stage',
                title,
                roadmap: roadmapFor(g0.todos),
                ...(g0.approach !== undefined ? { approach: g0.approach } : {}),
                plan,
                ...(warm !== undefined ? { systemModel: warm } : {}),
              };
            }
          }
        } catch {
          /* fall through to the smart-label + single-item fallback */
        }
      }
      return { judgment: 'stage', title: await deps.formGoalLabel(goalText), roadmap: deps.todosToRoadmap([{ text: goalText }]) };
    }

    const cacheKey = await deps.resolveCacheKey();
    let warm = deps.autoCtx.systemModelCache.get(cacheKey)?.model;
    const signal = new AbortController().signal;
    const classification = classify(goalText);
    const highStakes = classification.risk === 'high' || classification.risk === 'critical';
    const repoOriented = (await deps.resolveProjectKeyOnce()) !== null;
    const shape = highStakes
      ? 'risky'
      : classification.tier === 'manager'
        ? 'decide'
        : repoOriented
          ? 'build'
          : 'explain';
    const resolved = resolveIntensity(
      (await deps.ctx.store.list()).find((meta) => meta.id === deps.convId),
      deps.mutableCtx.config,
    );
    const resolvedIntensity = resolved.value === 'auto'
      ? autoIntensityForTurn({
          tier: classification.tier,
          risk: classification.risk,
          depth: 0,
          escalate: false,
          ...(highStakes ? { needsReview: true } : {}),
        })
      : resolved.value;
    const autoSmartOn = autoSmartEnabled(process.env, deps.mutableCtx.config);
    const effectiveMode: Mode = deps.mutableCtx.config.mode ??
      (autoSmartOn ? 'balanced' : resolveAutoMode(deps.mutableCtx.env));
    const modeBudget = effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;
    const planCeiling = autoSmartOn && deps.mutableCtx.config.mode === undefined
      ? planBudgetCeiling(deps.mutableCtx.env)
      : modeBudget;
    const callBudgetCeiling = Math.max(1, Math.max(modeBudget, planCeiling) - deps.currentPressure()) as 1 | 2 | 3;
    const cap = planningDepthCap({ resolvedIntensity, callBudgetCeiling, shape });
    const depth = chooseInitialPlanningDepth({
      cap,
      shape,
      substantial: classification.tier === 'manager',
      repoOriented,
      risk: classification.risk,
      engagementDepth: 0,
    });
    const scope: PlanningSelectionScope = {
      shape,
      substantial: classification.tier === 'manager',
      repoOriented,
      risk: classification.risk,
      engagementDepth: 0,
    };
    const authenticatedProviders: ProviderId[] = [];
    if (deps.mutableCtx.env.claude.authenticated) authenticatedProviders.push('claude');
    if (deps.mutableCtx.env.codex.authenticated) authenticatedProviders.push('codex');
    if (deps.mutableCtx.env.opencode.authenticated) authenticatedProviders.push('opencode');
    if (deps.mutableCtx.env.grok.authenticated) authenticatedProviders.push('grok');
    const selectionEntitlement = planningSelectionEntitlement({
      gateOn: deps.planningDepthOn,
      resolvedIntensity,
      turnCallBudget: callBudgetCeiling,
      panelAllowed: panelAllowedForShape(
        shape,
        effectiveMode,
        authenticatedProviders.length >= 2,
        callBudgetCeiling,
      ),
      authenticatedProviderCount: authenticatedProviders.length,
    });

    if (
      selectionEntitlement === 'locked' &&
      depth === 2 &&
      warm === undefined &&
      deps.understandingOn
    ) {
      noteStaleRepoIfNeeded();
      deps.out.write('  Planning deeper: grounding this first (one extra pass).\n');
      try {
        const repoContext = await deps.resolveEnvironmentOnce().catch(() => '');
        const pass = deps.buildUnderstandingPass(repoContext, highStakes, 8_000);
        const model = pass === null ? null : await pass(goalText, signal);
        if (model !== null) {
          warm = model;
          deps.autoCtx.systemModelCache.set(cacheKey, {
            model,
            atTurn: deps.autoCtx.autoStageTurns,
            fp: await deps.resolveRepoFingerprintOnce(),
          });
        } else {
          deps.out.write('  Grounding unavailable; planning ungrounded.\n');
        }
      } catch {
        deps.out.write('  Grounding unavailable; planning ungrounded.\n');
      }
    } else if (warm === undefined && deps.understandingOn) {
      noteStaleRepoIfNeeded();
      warmUnderstanding(cacheKey, goalText);
    }
    const roadmapFor = (todos: readonly GoalPlanTodo[]): RoadmapItem[] =>
      todos.length > 0
        ? deps.todosToRoadmap(todos.slice(0, deps.ROADMAP_LIMIT))
        : deps.todosToRoadmap([{ text: goalText }]);
    const initialTier = choosePlannerTier({
      resolvedIntensity,
      needStrongPlanner: needStrongPlanner({ scope, planFixableDeficiency: false }),
    });
    const tasteCtx = await deps.resolvePlannerTasteContext();
    const planner = deps.buildGoalPlannerAttempt(initialTier, warm, tasteCtx);
    if (planner !== null) {
      try {
        const attempt = await planner(goalText, signal);
        let plan = attempt?.plan ?? null;
        if (attempt !== null && plan !== null) {
          const substantialGoalMissingApproach =
            scope.substantial && plan.goals.some((goal) => goal.approach === undefined);
          const nonTrivialGoalMissingDoneWhen =
            plan.judgment === 'stage' &&
            plan.goals.some(
              (goal) => goal.doneWhen === undefined || goal.doneWhen.trim().length === 0,
            );
          const capDropped =
            plan.dropped !== undefined &&
            (plan.dropped.goals > 0 ||
              [...plan.dropped.perGoalTodos.values()].some((count) => count > 0));
          const genericFallbackOnly =
            plan.judgment === 'stage' &&
            (plan.goals.length === 0 ||
              plan.goals.every(
                (goal) => goal.title.trim().length === 0 || goal.todos.length === 0,
              ));
          const verificationAvailable = await deps.verificationAvailableForCwd(deps.ctx.cwd);
          const firstPlan: FirstPlanSelectionEvidence = {
            judgment: plan.judgment,
            substantialGoalMissingApproach,
            nonTrivialGoalMissingDoneWhen,
            capDropped,
            genericFallbackOnly,
            confidenceNoDoneWhen: nonTrivialGoalMissingDoneWhen,
            onlyGapIsNoVerification:
              !verificationAvailable &&
              !substantialGoalMissingApproach &&
              !nonTrivialGoalMissingDoneWhen &&
              !capDropped &&
              !genericFallbackOnly,
          };
          const planFixableDeficiency =
            substantialGoalMissingApproach ||
            nonTrivialGoalMissingDoneWhen ||
            capDropped ||
            genericFallbackOnly;
          if (shouldRunPlanningSelection({ entitlement: selectionEntitlement, scope, firstPlan })) {
            const providerB = authenticatedProviders.find(
              (provider) => provider !== attempt.provider && deps.ctx.providers[provider] !== undefined,
            );
            if (providerB !== undefined) {
              const reason = substantialGoalMissingApproach
                ? 'first plan lacked a complete approach'
                : nonTrivialGoalMissingDoneWhen
                  ? 'first plan lacked DONE criteria'
                  : capDropped
                    ? 'first plan dropped scope at parser caps'
                    : 'first plan retained only generic fallback structure';
              deps.out.write(
                `  ${formatGoalPlanSelectionNotice({
                  candidateA: attempt.provider,
                  candidateB: providerB,
                  reason,
                })}\n`,
              );
              const selectionTier = choosePlannerTier({
                resolvedIntensity,
                needStrongPlanner: needStrongPlanner({ scope, planFixableDeficiency }),
              });
              const selectionDeps: OrchestrateDeps = {
                ...deps.buildDeps([]),
                sandbox: helperSandbox(deps.ctx.sandbox),
                timeoutMs: Math.min(deps.ctx.timeoutMs, 8_000),
              };
              const selection = await selectGoalPlan({
                ownerTask: goalText,
                candidateA: {
                  plan,
                  provider: attempt.provider,
                  model: attempt.model,
                  rawText: attempt.raw,
                },
                deps: selectionDeps,
                tier: selectionTier,
                classification,
                signal,
                ...(warm !== undefined ? { systemModel: warm } : {}),
                candidateProviders: authenticatedProviders,
              });
              plan = selection.plan;
              deps.out.write(`  ${formatGoalPlanSelectionDisclosure(selection.receipt)}\n`);
            }
          }
        }
        if (plan !== null) {
          const g0 = plan.goals[0];
          const title = g0?.title.trim();
          if (plan.judgment === 'clarify') {
            const q = plan.clarifyingQuestion?.trim();
            return {
              judgment: 'clarify',
              title: title !== undefined && title.length > 0 ? title : await deps.formGoalLabel(goalText),
              roadmap: roadmapFor(g0?.todos ?? []),
              ...(q !== undefined && q.length > 0 ? { clarifyingQuestion: q } : {}),
              ...(g0?.approach !== undefined ? { approach: g0.approach } : {}),
              plan,
              ...(warm !== undefined ? { systemModel: warm } : {}),
            };
          }
          if (g0 !== undefined && title !== undefined && title.length > 0 && g0.todos.length > 0) {
            return {
              judgment: 'stage',
              title,
              roadmap: roadmapFor(g0.todos),
              ...(g0.approach !== undefined ? { approach: g0.approach } : {}),
              plan,
              ...(warm !== undefined ? { systemModel: warm } : {}),
            };
          }
        }
      } catch {
        /* fall through to the smart-label + single-item fallback */
      }
    }
    return { judgment: 'stage', title: await deps.formGoalLabel(goalText), roadmap: deps.todosToRoadmap([{ text: goalText }]) };
  };

  const resolveAutoStage = async (line: string, opts?: { intentVersionId?: string; linkIntentVersion?: boolean }): Promise<void> => {
    if (!deps.autoStageOn) return;
    // Quota gate: skip when ALL detected providers are in rate-limit cooldown
    // (pressure at the 3 ceiling) — honest cost discipline. (We do not have a
    // dedicated Governor allocate() poll at this post-turn seam; this is the
    // honest, in-process pressure signal the rest of the loop already reads.)
    if (deps.currentPressure() >= 3) return;
    deps.autoCtx.autoStageTurns += 1;

    // Capture the IMMUTABLE originating turn ID BEFORE any await — so the
    // fire-and-forget post-turn planner cannot drift into the next turn's budget.
    const originTurnId = deps.getCurrentTurnId?.();
    const originBudget = originTurnId !== undefined ? deps.getBudgetForTurn?.(originTurnId) : undefined;

    // WHOLE-PICTURE UNDERSTANDING (Part 2) — CACHE-AHEAD, never blocking. When the
    // flag is on, the planner is grounded from a WARM per-project SystemModel if
    // one is fresh; otherwise it runs UNGROUNDED this turn (exactly as when
    // understanding is off) and we kick off a BACKGROUND warm to ground the NEXT
    // planning moment. The understanding pass is NEVER awaited on the turn's
    // critical path (its latency is too variable), so it adds ZERO latency here.
    let systemModel: SystemModel | undefined;
    if (deps.understandingOn) {
      const cacheKey = await deps.resolveCacheKey();
      const cached = deps.autoCtx.systemModelCache.get(cacheKey);
      const fresh =
        cached !== undefined && deps.autoCtx.autoStageTurns - cached.atTurn < deps.UNDERSTANDING_REFRESH_TURNS;
      if (fresh) {
        systemModel = cached.model; // ground THIS turn from the warm cache
      } else {
        noteStaleRepoIfNeeded();
        warmUnderstanding(cacheKey, line); // ungrounded now; grounded next time
      }
    }
    const tasteCtx = await deps.resolvePlannerTasteContext();
    const planner = deps.buildGoalPlanner(systemModel, tasteCtx, originBudget);
    if (planner === null) return;
    let plan: GoalPlan | null = null;
    try {
      plan = await planner(line, new AbortController().signal, { ...(opts?.intentVersionId !== undefined ? { intentVersionId: opts.intentVersionId } : {}) });
    } catch {
      plan = null;
    }
    if (plan === null || plan.judgment === 'none') return; // frictionless, zero noise

    if (plan.judgment === 'clarify') {
      // Surface the single sharp question — do NOT auto-create goals here.
      // LIVENESS GUARD: this runs fire-and-forget (~up to 8s after the turn), so
      // the user may already have left to the menu — never paint a stray question
      // into it (mirrors the concurrent-recap guard).
      const q = plan.clarifyingQuestion?.trim();
      if (deps.conversationLive() && q !== undefined && q.length > 0) {
        deps.out.write('\n' + dim('? ', deps.out.color) + q + '\n');
      }
      return;
    }

    // judgment === 'stage' → born-parked goals (non-destructive, parked-only
    // execution policy — the planner never auto-executes work), then board sync.
    const projectKey = await deps.resolveProjectKeyOnce();
    // SMART DEDUP (not a dumb cap): an elite partner recognizes "we already have
    // a goal for that" instead of stamping out near-duplicate parked goals when
    // the owner circles the same topic across turns. Gather the titles of the
    // LIVE goals (parked/queued/running — not the historical done/failed) in this
    // scope, plus whatever we stage in THIS batch, and skip any candidate that is
    // a near-duplicate. Fail-soft: a list error just means we dedup within-batch.
    const seenTitles: string[] = [];
    try {
      const existing = await deps.goalStore.list(
        projectKey !== null ? { scope: 'project', projectKey } : { scope: 'global' },
      );
      for (const e of existing) {
        if (e.state === 'parked' || e.state === 'queued' || e.state === 'running') {
          seenTitles.push(e.title);
        }
      }
    } catch {
      /* no existing snapshot → still dedup within this batch */
    }
    let staged = 0;
    // Track what actually LANDED (titles + total to-dos) so the note can say
    // something REAL — the confident "here's what I parked, shall I start?" that
    // replaces the old content-free "※ Staged N goals" whisper.
    const stagedTitles: string[] = [];
    let stagedTodos = 0;
    for (const g of plan.goals) {
      const title = g.title.trim();
      if (title.length === 0) continue;
      // Skip a goal we already track (or already staged this turn) — no clutter.
      if (isDuplicateGoalTitle(title, seenTitles)) continue;
      seenTitles.push(title);
      try {
        await deps.goalStore.create({
          title,
          roadmap: deps.todosToRoadmap(g.todos),
          scope: projectKey !== null ? 'project' : 'global',
          projectKey,
          conversationId: deps.convId,
          // HONEST provenance: these were judged + staged by the planning
          // brain, NOT typed by the owner — the audit trail must say so.
          source: 'auto-staged',
          // The best-approach the planner stated for this goal (when any).
          ...(g.approach !== undefined ? { approach: g.approach } : {}),
          ...(opts?.linkIntentVersion === true && opts?.intentVersionId !== undefined
            ? { intentVersionId: opts.intentVersionId }
            : {}),
        });
        // Parked-only: goals created by auto-stage are NEVER auto-executed.
        // The owner promotes from the board or via /goal when ready.
        staged += 1;
        stagedTitles.push(title);
        stagedTodos += g.todos.length;
      } catch {
        /* one create miss must not block the rest — best-effort staging */
      }
    }
    if (staged === 0) return; // nothing landed → no note (honest)
    // LIVENESS GUARD: this runs fire-and-forget, so the user may already have left
    // to the menu by the time the planner resolves. The goals are persisted either
    // way (they'll appear on the board next turn); but never paint the board/note
    // into the menu or smear the next prompt (mirrors the concurrent-recap guard).
    if (!deps.conversationLive()) return;
    await deps.syncBoard(); // the new parked goals landed → refresh the board
    // Brief but REAL one-line note — names the goal(s) + to-do count + the
    // frictionless go-ahead, replacing the dim content-free whisper. Still a
    // single non-blocking line (we never block on the answer here — the owner
    // promotes from the board / `/goal` when ready). Fail-soft: an empty render
    // (defensive) degrades to the prior bare count.
    const note = formatAutoStageNote(stagedTitles, stagedTodos);
    if (note.length > 0) {
      deps.out.write('\n' + dim(`※ ${note}`, deps.out.color) + '\n');
    } else {
      const noun = staged === 1 ? 'goal' : 'goals';
      deps.out.write('\n' + dim(`※ Staged ${String(staged)} ${noun} on the board.`, deps.out.color) + '\n');
    }
  };

  return { judgeGoal, warmUnderstanding, resolveAutoStage };
}
