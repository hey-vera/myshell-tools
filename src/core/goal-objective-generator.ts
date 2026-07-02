/**
 * src/core/goal-objective-generator.ts — build a live goal-objective former.
 *
 * goal-objective.ts decides + defines the objective (prompt builder, parse); this
 * module supplies the model pass that PRODUCES the text. Route to the MANAGER tier
 * (the strongest model), send the small `buildGoalObjectivePrompt` read-only with
 * a SHORT timeout, take the final text, and `parseGoalObjective` it. Every failure
 * mode — no provider, route throws, the run errors or times out, empty/unusable
 * output — returns null, so the caller falls straight back to the deterministic
 * `formConciseGoalLabel(deriveGoal(raw))` shaper (today's behaviour). It never
 * throws and never writes.
 *
 * Cost discipline: this is ONE pass at goal START (not per turn). It names the
 * objective the user will SEE on the goal line / title for the whole run, so it is
 * written by a capable model reading the request against the product-vision /
 * quality bar — the SAME machinery the recap uses (recap-generator.ts), not the
 * cheapest worker that parrots the raw text. Subscription-auth only: it reuses the
 * existing provider machinery — no API key, no embeddings, no metered service.
 *
 * Purity: no fs/path/child_process imports — the I/O lives in the injected
 * provider, exactly like recap-generator.ts. A thin, testable composer.
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import type { TurnCallBudget } from './turn-call-budget.js';
import { route } from './route.js';
import { runBudgetedProvider } from './budgeted-provider.js';
import { buildGoalObjectivePrompt, parseGoalObjective } from './goal-objective.js';

/** Everything the former needs to pick and run the manager-tier model. */
export interface GoalObjectiveGeneratorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the formation run. Keep TIGHT — it gates goal start. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly turnCallBudget?: TurnCallBudget;
}

/**
 * Objective formation runs at the MANAGER tier (the strongest model). The
 * objective is the most-seen string of an autonomous run (the goal line, the
 * contract OBJECTIVE, the conversation title), so it must be written by a capable
 * model naming the goal against the product-vision / quality bar — not the cheapest
 * worker that echoes the raw text. ONE pass at goal start, fail-soft + tight
 * timeout so it can never block.
 */
const GOAL_OBJECTIVE_TIER: Tier = 'manager';
/** It reads a request string and emits a label — it never touches files. */
const GOAL_OBJECTIVE_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build a manager-tier goal-objective former. Returns a function that takes the
 * user's raw goal text and resolves to a crisp professional objective string, or
 * `null` on ANY failure (so the caller degrades to the deterministic shaper).
 * Mirrors `makeRecapGenerator` exactly.
 */
export function makeGoalObjectiveGenerator(
  deps: GoalObjectiveGeneratorDeps,
): (rawText: string, signal: AbortSignal) => Promise<string | null> {
  return async (rawText: string, signal: AbortSignal): Promise<string | null> => {
    const prompt = buildGoalObjectivePrompt(rawText);
    if (prompt.trim().length === 0) return null;

    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      // As in recap-generator.ts: deliberately NOT threading the learned provider
      // order — this throwaway pass is a cost decision about naming the goal, not
      // about doing the user's work.
      const decision = route(
        GOAL_OBJECTIVE_TIER,
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
      sandbox: deps.sandbox ?? GOAL_OBJECTIVE_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    try {
      for await (const ev of runBudgetedProvider(provider, req, signal, {
        ...(deps.turnCallBudget ? { budget: deps.turnCallBudget } : {}),
        purpose: 'goal-objective',
        bucket: 'discretionary',
        provider: provider.id,
      })) {
        if (ev.type === 'done') finalText = ev.text;
        else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    return parseGoalObjective(finalText);
  };
}
