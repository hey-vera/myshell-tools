/**
 * src/infra/pricing.ts
 *
 * Corrected price table — Appendix A of the myshell-tools project plan.
 *
 * Provenance
 * ----------
 * Claude pricing  : https://www.anthropic.com/pricing
 * OpenAI pricing  : https://platform.openai.com/docs/pricing
 * Captured        : 2026-05-29
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPricing {
  readonly provider: 'claude' | 'codex';
  readonly model: string; // full model ID
  readonly aliases: readonly string[]; // e.g. ['opus', 'opus-4.7']
  readonly tier: 'worker' | 'ic' | 'manager';
  readonly inputPer1M: number; // USD per 1 M input tokens
  readonly outputPer1M: number; // USD per 1 M output tokens
  readonly contextWindow: number; // tokens
}

export interface PricingTable {
  readonly asOf: string; // ISO date
  readonly sourceUrls: readonly string[];
  readonly models: readonly ModelPricing[];
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const PRICING_TABLE: PricingTable = {
  asOf: '2026-05-29',
  sourceUrls: [
    'https://www.anthropic.com/pricing',
    'https://platform.openai.com/docs/pricing',
  ],
  models: [
    // ---- Anthropic / Claude ------------------------------------------------
    {
      provider: 'claude',
      model: 'claude-opus-4-7',
      aliases: ['opus', 'opus-4.7', 'claude-opus-4.7'],
      tier: 'manager',
      inputPer1M: 5,
      outputPer1M: 25,
      contextWindow: 200_000,
    },
    {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      aliases: ['sonnet', 'sonnet-4.6', 'claude-sonnet-4.6'],
      tier: 'ic',
      inputPer1M: 3,
      outputPer1M: 15,
      contextWindow: 200_000,
    },
    {
      provider: 'claude',
      model: 'claude-haiku-4-5',
      aliases: ['haiku', 'haiku-4.5', 'claude-haiku-4.5'],
      tier: 'worker',
      inputPer1M: 0.8,
      outputPer1M: 4,
      contextWindow: 200_000,
    },

    // ---- OpenAI / Codex ----------------------------------------------------
    {
      provider: 'codex',
      model: 'gpt-5.5',
      aliases: ['gpt5.5', 'gpt-5-5'],
      tier: 'manager',
      inputPer1M: 5,
      outputPer1M: 30,
      contextWindow: 128_000,
    },
    {
      provider: 'codex',
      model: 'gpt-5.4',
      aliases: ['gpt5.4', 'gpt-5-4'],
      tier: 'ic',
      inputPer1M: 2.5,
      outputPer1M: 15,
      contextWindow: 128_000,
    },
    {
      provider: 'codex',
      model: 'gpt-5.4-mini',
      aliases: ['gpt5.4-mini', 'gpt-5-4-mini'],
      tier: 'worker',
      inputPer1M: 0.75,
      outputPer1M: 4.5,
      contextWindow: 128_000,
    },
    {
      provider: 'codex',
      model: 'gpt-5.4-nano',
      aliases: ['gpt5.4-nano', 'gpt-5-4-nano'],
      tier: 'worker',
      inputPer1M: 0.2,
      outputPer1M: 1.25,
      contextWindow: 128_000,
    },
    {
      provider: 'codex',
      model: 'gpt-5.2-codex',
      aliases: ['codex', 'gpt5.2-codex', 'gpt-5-2-codex'],
      tier: 'ic',
      inputPer1M: 1.75,
      outputPer1M: 14,
      contextWindow: 128_000,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a model entry by exact model ID or any of its aliases.
 * The lookup is case-insensitive.
 */
export function getModelPricing(
  provider: string,
  model: string,
): ModelPricing | undefined {
  const needle = model.toLowerCase();
  return PRICING_TABLE.models.find(
    (m) =>
      m.provider === provider &&
      (m.model.toLowerCase() === needle ||
        m.aliases.some((a) => a.toLowerCase() === needle)),
  );
}

/**
 * Calculate the USD cost for a given number of input and output tokens.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Return the cheapest model (lowest inputPer1M) for a given tier,
 * optionally restricted to the supplied provider IDs.
 *
 * Throws if no matching model exists.
 */
export function getCheapestForTier(
  tier: 'worker' | 'ic' | 'manager',
  availableProviders?: string[],
): ModelPricing {
  let candidates = PRICING_TABLE.models.filter((m) => m.tier === tier);

  if (availableProviders && availableProviders.length > 0) {
    candidates = candidates.filter((m) =>
      availableProviders.includes(m.provider),
    );
  }

  if (candidates.length === 0) {
    throw new Error(
      `No models available for tier "${tier}"` +
        (availableProviders ? ` with providers [${availableProviders.join(', ')}]` : ''),
    );
  }

  // Primary sort: inputPer1M ascending; secondary: outputPer1M ascending
  return candidates.reduce((cheapest, m) =>
    m.inputPer1M < cheapest.inputPer1M ||
    (m.inputPer1M === cheapest.inputPer1M && m.outputPer1M < cheapest.outputPer1M)
      ? m
      : cheapest,
  );
}

/**
 * Returns true when the pricing table is older than maxAgeDays (default 90).
 * Useful for emitting a staleness warning at runtime.
 */
export function isPricingStale(maxAgeDays = 90): boolean {
  const asOf = new Date(PRICING_TABLE.asOf);
  const now = new Date();
  const diffMs = now.getTime() - asOf.getTime();
  const diffDays = diffMs / (1_000 * 60 * 60 * 24);
  return diffDays > maxAgeDays;
}
