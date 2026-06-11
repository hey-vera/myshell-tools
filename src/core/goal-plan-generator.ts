/**
 * src/core/goal-plan-generator.ts — build a live PLANNING-BRAIN pass.
 *
 * goal-plan.ts decides + defines the plan (prompt builder, parse); this module
 * supplies the model pass that PRODUCES the judged plan. Route to the MANAGER tier
 * (the strongest model — the judgment of WHAT to stage is the headline behaviour,
 * so it is read by a capable model against the product-vision / quality bar), send
 * the small `buildGoalPlanPrompt` read-only with a SHORT timeout, take the final
 * text, and `parseGoalPlan` it. Every failure mode — no provider, route throws,
 * the run errors or times out, empty/unusable output — returns null, so the caller
 * simply does nothing (auto-staging is silent when it can't fire, never fabricated).
 * It never throws and never writes.
 *
 * Cost discipline: this is ONE pass per qualifying turn (the menu gates it on the
 * non-trivial signal + the flag + quota pressure), run POST-turn, non-blocking and
 * fail-soft — exactly the throwaway-pass shape of goal-objective-generator.ts /
 * recap-generator.ts. Subscription-auth only: it reuses the existing provider
 * machinery — no API key, no embeddings, no metered service.
 *
 * Purity: no fs/path/child_process imports — the I/O lives in the injected
 * provider, exactly like goal-objective-generator.ts. A thin, testable composer.
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import { route } from './route.js';
import { buildGoalPlanPrompt, parseGoalPlan, type GoalPlan } from './goal-plan.js';
import type { SystemModel } from './understanding.js';

/** Everything the planner needs to pick and run the manager-tier model. */
export interface GoalPlanGeneratorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the planning run. Keep TIGHT — it runs post-turn. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  /**
   * Optional whole-picture understanding of the REAL system (understanding.ts).
   * When present it GROUNDS the planner prompt (the staged goals fit the actual
   * modules + respect the hard constraints, and a clarify verdict can draw on the
   * understanding's genuinely-open questions). ABSENT → the planner prompt is byte-
   * for-byte today's (the planner runs exactly as before understanding existed).
   */
  readonly systemModel?: SystemModel;
}

/**
 * The planning brain runs at the MANAGER tier (the strongest model). Judging
 * WHAT constitutes substantial work — and decomposing it like a senior — is the
 * headline behaviour of the vision, so it must be written by a capable model
 * reading the turn against the product-vision / quality bar, not the cheapest
 * worker. ONE pass per qualifying turn, fail-soft + tight timeout so it can never
 * block the conversation.
 */
const GOAL_PLAN_TIER: Tier = 'manager';
/** It reads the turn text and emits a tagged plan — it never touches files. */
const GOAL_PLAN_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build a manager-tier planning-brain pass. Returns a function that takes the
 * owner's turn text and resolves to a judged {@link GoalPlan}, or `null` on ANY
 * failure (so the caller does nothing). Mirrors `makeGoalObjectiveGenerator`
 * exactly.
 */
export function makeGoalPlanner(
  deps: GoalPlanGeneratorDeps,
): (userMessage: string, signal: AbortSignal) => Promise<GoalPlan | null> {
  return async (userMessage: string, signal: AbortSignal): Promise<GoalPlan | null> => {
    // Ground the planner in the whole-picture understanding when one is injected;
    // absent (the default) → the prompt is byte-for-byte today's. assistantReply /
    // frameGoal stay undefined here, as before — only the optional systemModel is
    // threaded through.
    const prompt = buildGoalPlanPrompt(userMessage, undefined, undefined, deps.systemModel);
    if (prompt.trim().length === 0) return null;

    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      // As in goal-objective-generator.ts: deliberately NOT threading the learned
      // provider order — this throwaway pass is a cost decision about judging the
      // turn, not about doing the owner's work.
      const decision = route(
        GOAL_PLAN_TIER,
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
      sandbox: deps.sandbox ?? GOAL_PLAN_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    try {
      for await (const ev of provider.run(req, signal)) {
        if (ev.type === 'done') finalText = ev.text;
        else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    return parseGoalPlan(finalText);
  };
}
