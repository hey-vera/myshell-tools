/**
 * balance.mjs — Provider load balancing and health monitoring
 */

import { getRecentHandoffs, getHandoffStats } from '../orchestrator/handoffs.mjs';

/**
 * Balance load across providers by tracking recent usage
 */
export function balanceProviderLoad(availableModels, tier, context = {}) {
  const tierModels = availableModels[tier] || [];
  if (tierModels.length <= 1) {
    return tierModels[0] || null;
  }

  const { sessionId } = context;
  const timeWindow = 1; // 1 hour window

  // Get recent usage per provider
  const usage = getProviderUsage(sessionId, timeWindow);
  const health = getProviderHealthStatus();

  // Score each model based on usage and health
  const scoredModels = tierModels.map(model => {
    const providerUsage = usage[model.provider] || 0;
    const providerHealth = health[model.provider] || { score: 1.0 };

    // Lower usage = higher score (load balancing)
    const usageScore = Math.max(0, 1 - (providerUsage / 10)); // Penalize after 10 uses

    // Health score (0.0 = unhealthy, 1.0 = healthy)
    const healthScore = providerHealth.score;

    // Combined score
    const totalScore = (usageScore * 0.6) + (healthScore * 0.4);

    return {
      ...model,
      score: totalScore,
      usage: providerUsage,
      health: providerHealth,
      reasoning: `usage: ${providerUsage}, health: ${healthScore.toFixed(2)}, score: ${totalScore.toFixed(2)}`
    };
  });

  // Sort by score and return best
  scoredModels.sort((a, b) => b.score - a.score);
  return scoredModels[0];
}

/**
 * Get provider usage statistics for load balancing
 */
function getProviderUsage(sessionId, timeWindowHours) {
  const handoffs = getRecentHandoffs(timeWindowHours, sessionId);

  const usage = {};

  for (const handoff of handoffs) {
    // Count operations initiated by each provider
    if (handoff.provider_from) {
      usage[handoff.provider_from] = (usage[handoff.provider_from] || 0) + 1;
    }
  }

  return usage;
}

/**
 * Get provider health status based on recent failures
 */
function getProviderHealthStatus() {
  const handoffs = getRecentHandoffs(0.5); // Last 30 minutes
  const health = {};

  // Track failures per provider
  const failures = {};
  const total = {};

  for (const handoff of handoffs) {
    if (!handoff.provider_from) continue;

    const provider = handoff.provider_from;
    total[provider] = (total[provider] || 0) + 1;

    // Count escalations due to failures as failures
    if (handoff.op === 'escalate_up' && (
      handoff.reason.includes('failure') ||
      handoff.reason.includes('error') ||
      handoff.reason.includes('timeout')
    )) {
      failures[provider] = (failures[provider] || 0) + 1;
    }
  }

  // Calculate health scores
  for (const provider of ['claude', 'codex']) {
    const totalOps = total[provider] || 0;
    const failedOps = failures[provider] || 0;

    let score = 1.0; // Default healthy

    if (totalOps > 0) {
      const failureRate = failedOps / totalOps;
      score = Math.max(0, 1 - (failureRate * 2)); // Penalize failures heavily
    }

    // Severely degraded if no operations completed successfully recently
    if (totalOps === 0 && failedOps > 0) {
      score = 0.1;
    }

    health[provider] = {
      score,
      failures: failedOps,
      total: totalOps,
      failure_rate: totalOps > 0 ? (failedOps / totalOps) : 0,
      status: score > 0.8 ? 'healthy' : score > 0.5 ? 'degraded' : 'unhealthy'
    };
  }

  return health;
}

/**
 * Check if we should redistribute load
 */
export function shouldRedistributeLoad(sessionId, threshold = 5) {
  const usage = getProviderUsage(sessionId, 1);
  const providers = Object.keys(usage);

  if (providers.length < 2) return false;

  const usageValues = Object.values(usage);
  const maxUsage = Math.max(...usageValues);
  const minUsage = Math.min(...usageValues);

  // Redistribute if difference is greater than threshold
  return (maxUsage - minUsage) > threshold;
}

/**
 * Get load balancing recommendations
 */
export function getLoadBalanceRecommendations(sessionId) {
  const usage = getProviderUsage(sessionId, 1);
  const health = getProviderHealthStatus();
  const shouldRedist = shouldRedistributeLoad(sessionId);

  const recommendations = [];

  if (shouldRedist) {
    // Find overused and underused providers
    const sorted = Object.entries(usage).sort(([,a], [,b]) => b - a);
    const [overused] = sorted[0] || [];
    const [underused] = sorted[sorted.length - 1] || [];

    if (overused && underused && health[underused]?.status === 'healthy') {
      recommendations.push({
        type: 'redistribute',
        from: overused,
        to: underused,
        reason: `${overused} is overloaded (${usage[overused]} ops), prefer ${underused} (${usage[underused]} ops)`
      });
    }
  }

  // Health-based recommendations
  for (const [provider, healthInfo] of Object.entries(health)) {
    if (healthInfo.status === 'unhealthy') {
      recommendations.push({
        type: 'avoid',
        provider,
        reason: `${provider} is unhealthy (${Math.round(healthInfo.failure_rate * 100)}% failure rate)`
      });
    }
  }

  return {
    should_redistribute: shouldRedist,
    recommendations,
    current_usage: usage,
    provider_health: health
  };
}

/**
 * Force a provider offline for maintenance
 */
export function setProviderMaintenance(provider, offline = true) {
  // This would integrate with a persistent config or state system
  // For now, just log the maintenance status
  console.log(`Provider ${provider} maintenance mode: ${offline ? 'ON' : 'OFF'}`);

  // Return updated health status
  return {
    provider,
    maintenance: offline,
    timestamp: new Date().toISOString()
  };
}