/**
 * src/core/opencode-model.ts — pick the best opencode model for a tier.
 *
 * opencode is a multi-provider agent: which `provider/model` ids are actually
 * usable depends entirely on what the user has connected (free opencode models,
 * an OpenCode Go subscription → `opencode-go/*` open models like Kimi/GLM/
 * DeepSeek, or OpenCode Zen credits → `opencode/*` Claude/GPT/etc.). So we never
 * hardcode model ids: detection runs `opencode models` and hands us the user's
 * REAL available list, and we rank it heuristically to map myshell's tiers
 * (worker / ic / manager) onto the best model the user genuinely has.
 *
 * Fail-safe by contract: we only ever return a model that was in the supplied
 * list (or undefined when the list is empty / unusable), so a caller can pass it
 * to `opencode run -m` knowing opencode advertises it. When undefined, the caller
 * should omit `-m` and let opencode use its own configured default.
 *
 * Pure — no I/O. The heuristic is keyword-based and deliberately conservative;
 * it degrades to "first model" rather than guessing wildly on unknown names.
 */

import type { Tier } from './types.js';

/**
 * Rough capability score for an opencode model id (higher = more capable).
 * Keyword-based because opencode's model roster changes often and carries no
 * machine-readable tier. Tuned against the documented OpenCode Go / Zen rosters
 * and the live free list (deepseek-v4-flash-free, mimo-v2.5-free, big-pickle, …).
 */
export function opencodeModelScore(model: string): number {
  const m = model.toLowerCase();
  let score = 3; // unknown → assume mid-capability

  // Model family (strongest coding/agentic families score highest).
  if (/big-pickle|pickle/.test(m)) score = 6;
  else if (/kimi|k2/.test(m)) score = 6;
  else if (/glm/.test(m)) score = 5;
  else if (/deepseek/.test(m)) score = 5;
  else if (/qwen/.test(m)) score = 5;
  else if (/minimax/.test(m)) score = 4;
  else if (/mimo/.test(m)) score = 3;
  else if (/nemotron/.test(m)) score = 3;
  else if (/opus/.test(m)) score = 7;
  else if (/sonnet|gpt-5\.5|gpt-5-5/.test(m)) score = 5;

  // Capability modifiers within a family.
  if (/\bmax\b|-max/.test(m)) score += 2;
  if (/\bpro\b|-pro/.test(m)) score += 1;
  if (/\bplus\b|-plus/.test(m)) score += 1;
  // Small/fast variants are weaker. \bmini\b avoids mis-matching "miniMAX",
  // which is a full-size family, not a mini model.
  if (/flash|\bmini\b|nano|lite|haiku/.test(m)) score -= 2;
  if (/free/.test(m)) score -= 1; // free variants are the weakest of a family

  return score;
}

/**
 * Choose the best opencode model id for a tier from the user's REAL available
 * list (as returned by `opencode models`). Returns undefined when the list is
 * empty so the caller omits `-m` and falls back to opencode's own default.
 *
 *   - manager → the most capable available model
 *   - worker  → the cheapest/fastest available model
 *   - ic      → a mid-capability model (closest to the middle of the range)
 *
 * @param tier   - Orchestration tier to select for.
 * @param models - The user's available `provider/model` ids (real, from detection).
 */
export function selectOpencodeModel(
  tier: Tier,
  models: readonly string[] | undefined,
): string | undefined {
  if (models === undefined || models.length === 0) return undefined;
  if (models.length === 1) return models[0];

  const scored = models.map((model) => ({ model, score: opencodeModelScore(model) }));

  if (tier === 'manager') {
    // Highest score; ties → keep the first (stable).
    return scored.reduce((best, c) => (c.score > best.score ? c : best)).model;
  }
  if (tier === 'worker') {
    // Lowest score; ties → keep the first (stable).
    return scored.reduce((best, c) => (c.score < best.score ? c : best)).model;
  }

  // ic → the model whose score is closest to the midpoint of the observed range.
  const scores = scored.map((s) => s.score);
  const mid = (Math.min(...scores) + Math.max(...scores)) / 2;
  return scored.reduce((best, c) =>
    Math.abs(c.score - mid) < Math.abs(best.score - mid) ? c : best,
  ).model;
}
