/**
 * handoffs.mjs — Comprehensive handoff logging and audit trail
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Log a handoff operation to the audit trail
 */
export function logHandoff(operation, fromTier, toTier, metadata = {}) {
  const handoffDir = getCortexDir();
  ensureHandoffDir(handoffDir);

  const entry = {
    ts: Date.now(),
    timestamp: new Date().toISOString(),
    plan_id: metadata.planId || generatePlanId(),
    op: operation,
    from: fromTier,
    to: toTier,
    reason: metadata.reason || 'unknown',
    confidence_in: metadata.confidenceIn || null,
    confidence_out: metadata.confidenceOut || null,
    duration_ms: metadata.durationMs || null,
    provider_from: metadata.providerFrom || null,
    provider_to: metadata.providerTo || null,
    attempt: metadata.attempt || 1,
    session_id: metadata.sessionId || 'unknown',
    notes: metadata.notes || null
  };

  const logPath = join(handoffDir, 'handoffs.jsonl');

  try {
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
  } catch (error) {
    console.warn(`Failed to log handoff: ${error.message}`);
  }

  return entry;
}

/**
 * Log escalation from one tier to another
 */
export function logEscalation(fromTier, toTier, reason, metadata = {}) {
  return logHandoff('escalate_up', fromTier, toTier, {
    reason,
    ...metadata
  });
}

/**
 * Log delegation down to a lower tier
 */
export function logDelegation(fromTier, toTier, reason, metadata = {}) {
  return logHandoff('delegate_down', fromTier, toTier, {
    reason,
    ...metadata
  });
}

/**
 * Log manager bounce back to IC with feedback
 */
export function logBounce(fromTier, toTier, feedback, attempt, metadata = {}) {
  return logHandoff('bounce_down', fromTier, toTier, {
    reason: 'manager review failure',
    notes: feedback,
    attempt,
    ...metadata
  });
}

/**
 * Load recent handoffs for analysis and load balancing
 */
export function getRecentHandoffs(timeWindowHours = 1, sessionId = null) {
  const handoffDir = getCortexDir();
  const logPath = join(handoffDir, 'handoffs.jsonl');

  if (!existsSync(logPath)) {
    return [];
  }

  const cutoffTime = Date.now() - (timeWindowHours * 60 * 60 * 1000);
  const handoffs = [];

  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Filter by time window
        if (entry.ts < cutoffTime) continue;

        // Filter by session if specified
        if (sessionId && entry.session_id !== sessionId) continue;

        handoffs.push(entry);
      } catch (error) {
        // Skip malformed lines
        continue;
      }
    }
  } catch (error) {
    console.warn(`Failed to read handoff log: ${error.message}`);
    return [];
  }

  return handoffs.sort((a, b) => b.ts - a.ts); // Most recent first
}

/**
 * Get handoff statistics for load balancing
 */
export function getHandoffStats(timeWindowHours = 1) {
  const handoffs = getRecentHandoffs(timeWindowHours);

  const stats = {
    total: handoffs.length,
    by_operation: {},
    by_provider: {},
    by_tier: {},
    avg_duration_ms: 0,
    success_rate: 0
  };

  let totalDuration = 0;
  let durationsCount = 0;
  let successful = 0;

  for (const handoff of handoffs) {
    // Count by operation
    stats.by_operation[handoff.op] = (stats.by_operation[handoff.op] || 0) + 1;

    // Count by provider (from)
    if (handoff.provider_from) {
      stats.by_provider[handoff.provider_from] = (stats.by_provider[handoff.provider_from] || 0) + 1;
    }

    // Count by tier
    stats.by_tier[handoff.from] = (stats.by_tier[handoff.from] || 0) + 1;

    // Track durations
    if (handoff.duration_ms) {
      totalDuration += handoff.duration_ms;
      durationsCount++;
    }

    // Track success (escalations are "success" for routing, bounces are not)
    if (handoff.op !== 'bounce_down') {
      successful++;
    }
  }

  stats.avg_duration_ms = durationsCount > 0 ? Math.round(totalDuration / durationsCount) : 0;
  stats.success_rate = stats.total > 0 ? successful / stats.total : 0;

  return stats;
}

/**
 * Check for failure loops similar to dual-brain pattern
 */
export function checkFailureLoop(taskHash, timeWindowHours = 2) {
  const handoffs = getRecentHandoffs(timeWindowHours);

  // Count bounces and escalations for this task
  const taskHandoffs = handoffs.filter(h =>
    h.plan_id === taskHash ||
    h.notes?.includes(taskHash) ||
    h.reason?.includes(taskHash)
  );

  const bounces = taskHandoffs.filter(h => h.op === 'bounce_down');
  const escalations = taskHandoffs.filter(h => h.op === 'escalate_up');

  // Apply decay weight to recent failures (similar to dual-brain)
  const now = Date.now();
  let weightedScore = 0;

  for (const handoff of bounces) {
    const ageMs = now - handoff.ts;
    const ageMin = ageMs / (60 * 1000);

    let weight = 1.0;
    if (ageMin > 30) weight = 0.5;
    if (ageMin > 60) weight = 0.25;

    weightedScore += weight;
  }

  const isLoop = weightedScore >= 2.0;

  return {
    isLoop,
    bounceCount: bounces.length,
    escalationCount: escalations.length,
    weightedScore,
    suggestion: isLoop ? 'escalate_to_manager' : null,
    recentHandoffs: taskHandoffs.slice(0, 5) // Last 5 for context
  };
}

/**
 * Generate a plan/session ID for tracking related handoffs
 */
function generatePlanId() {
  return `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

/**
 * Get or create .cortex directory
 */
function getCortexDir(cwd = process.cwd()) {
  return join(cwd, '.cortex');
}

/**
 * Ensure handoff directory exists
 */
function ensureHandoffDir(cortexDir) {
  if (!existsSync(cortexDir)) {
    mkdirSync(cortexDir, { recursive: true });
  }
}