/**
 * src/core/opencode-model.ts — thin fallback for the opt-out legacy path.
 *
 * opencode is a multi-provider agent: which `provider/model` ids are actually
 * usable depends entirely on what the user has connected (free opencode models,
 * an OpenCode Go subscription → `opencode-go/*` open models like Kimi/GLM/
 * DeepSeek, or OpenCode Zen credits → `opencode/*` Claude/GPT/etc.). In the
 * default vendor-neutral router, opencodeTierRank() drives OpenCode selection
 * from live verbose facts. This module is a THIN FALLBACK used ONLY by the
 * legacy opt-out path (route.ts::decisionFor); it returns the first available
 * model so the caller can pass it to `opencode run -m`.
 *
 * Fail-safe by contract: we only ever return a model that was in the supplied
 * list (or undefined when the list is empty / unusable). When undefined, the
 * caller omits `-m` and lets opencode use its own configured default.
 *
 * Pure — no I/O.
 */

import type { Tier } from './types.js';

/**
 * Thin fallback: return the first model from the user's available list.
 * The default vendor-neutral router uses opencodeTierRank() instead.
 */
export function selectOpencodeModel(
  tier: Tier,
  models: readonly string[] | undefined,
): string | undefined {
  if (models === undefined || models.length === 0) return undefined;
  return models[0];
}
