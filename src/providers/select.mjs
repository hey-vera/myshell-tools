/**
 * select.mjs — Intelligent provider selection and load balancing
 */

import { getRecentHandoffs, getHandoffStats } from '../orchestrator/handoffs.mjs';

/**
 * Select the best provider for a task based on load balancing and context
 */
export function selectProvider(tier, context = {}) {
  const { availableModels, sessionId } = context;

  if (!availableModels) {
    console.warn('No available models provided to selectProvider');
    return null;
  }

  const tierModels = availableModels[tier] || [];
  if (tierModels.length === 0) {
    return null;
  }

  // If only one provider available, use it
  if (tierModels.length === 1) {
    return tierModels[0];
  }

  // Get load balancing data
  const loadBalance = getProviderLoadBalance(sessionId);
  const modelStrengths = getModelStrengths(tier);

  // Score each available model
  const scoredModels = tierModels.map(model => {
    let score = 0;

    // Base score from model strength for this tier
    score += modelStrengths[model.provider] || 0.5;

    // Load balancing bonus (prefer less-used providers)
    const providerLoad = loadBalance[model.provider] || 0;
    const avgLoad = Object.values(loadBalance).reduce((sum, load) => sum + load, 0) / Object.keys(loadBalance).length || 0;

    if (providerLoad < avgLoad - 2) {
      score += 0.3; // Bonus for underused provider
    } else if (providerLoad > avgLoad + 2) {
      score -= 0.2; // Penalty for overused provider
    }

    // Prefer models that haven't failed recently
    const recentFailures = getRecentFailures(model.provider, 0.5); // Last 30 min
    score -= recentFailures * 0.1;

    return {
      ...model,
      score,
      load: providerLoad,
      failures: recentFailures
    };
  });

  // Sort by score (highest first) and return best
  scoredModels.sort((a, b) => b.score - a.score);

  const selected = scoredModels[0];

  console.log(`  🎯 Provider selection for ${tier}: ${selected.provider}/${selected.model} (score: ${selected.score.toFixed(2)})`);

  return selected;
}

/**
 * Get provider load balance statistics
 */
function getProviderLoadBalance(sessionId, timeWindowHours = 1) {
  const handoffs = getRecentHandoffs(timeWindowHours, sessionId);

  const loadBalance = {};

  for (const handoff of handoffs) {
    if (handoff.provider_from) {
      loadBalance[handoff.provider_from] = (loadBalance[handoff.provider_from] || 0) + 1;
    }
    if (handoff.provider_to) {
      loadBalance[handoff.provider_to] = (loadBalance[handoff.provider_to] || 0) + 1;
    }
  }

  return loadBalance;
}

/**
 * Get model strengths by tier based on empirical performance
 */
function getModelStrengths(tier) {
  const strengths = {
    worker: {
      claude: 0.8,   // Excellent for search and analysis
      codex: 0.6     // Good for quick lookups
    },
    ic: {
      codex: 0.8,    // Excellent for implementation
      claude: 0.7    // Good for code generation
    },
    manager: {
      claude: 0.9,   // Excellent for architecture and review
      codex: 0.7     // Good for complex reasoning
    }
  };

  return strengths[tier] || { claude: 0.5, codex: 0.5 };
}

/**
 * Get recent failure count for a provider
 */
function getRecentFailures(provider, timeWindowHours = 0.5) {
  const handoffs = getRecentHandoffs(timeWindowHours);

  return handoffs.filter(handoff =>
    handoff.provider_from === provider &&
    handoff.op === 'escalate_up' &&
    handoff.reason.includes('failure')
  ).length;
}

/**
 * Check if provider is currently available
 */
export function checkProviderHealth(provider) {
  const recentFailures = getRecentFailures(provider, 0.25); // Last 15 minutes

  return {
    available: recentFailures < 3, // Healthy if fewer than 3 failures in 15 min
    failures: recentFailures,
    status: recentFailures >= 3 ? 'degraded' : 'healthy'
  };
}

/**
 * Get provider usage statistics for debugging
 */
export function getProviderStats(timeWindowHours = 1) {
  const stats = getHandoffStats(timeWindowHours);

  const providerStats = {};

  for (const [provider, count] of Object.entries(stats.by_provider)) {
    providerStats[provider] = {
      handoffs: count,
      percentage: Math.round((count / stats.total) * 100),
      health: checkProviderHealth(provider)
    };
  }

  return {
    total_handoffs: stats.total,
    time_window_hours: timeWindowHours,
    providers: providerStats,
    avg_duration_ms: stats.avg_duration_ms,
    success_rate: Math.round(stats.success_rate * 100)
  };
}