/**
 * performance.mjs — Performance tracking and efficiency monitoring
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicAppendJSONL, atomicWriteJSON, lockedReadModifyWrite } from '../state/atomic.mjs';

/**
 * Performance baselines for comparison
 */
const BASELINES = {
  // Estimated baseline costs for dual-verification vs. hierarchy
  dualVerificationMultiplier: 2.5, // Dual-verification uses 2.5x more tokens
  averageEscalationRate: 0.25, // 25% of tasks escalate
  targetConfidence: 0.75, // Target average confidence
  maxHandoffTime: 3000, // Maximum acceptable handoff time (ms)

  // Token usage baselines (rough estimates)
  tokenCosts: {
    worker: { input: 0.25, output: 1.25 }, // per 1K tokens (USD)
    ic: { input: 3.0, output: 15.0 },
    manager: { input: 15.0, output: 75.0 }
  }
};

/**
 * Get performance metrics directory
 */
function getMetricsDir(workspace = process.cwd()) {
  const metricsDir = join(workspace, '.cortex', 'metrics');
  if (!existsSync(metricsDir)) {
    mkdirSync(metricsDir, { recursive: true });
  }
  return metricsDir;
}

/**
 * Performance monitoring class
 */
export class PerformanceMonitor {
  constructor(workspace = process.cwd()) {
    this.workspace = workspace;
    this.metricsDir = getMetricsDir(workspace);
    this.currentSession = {
      startTime: Date.now(),
      handoffs: [],
      escalations: 0,
      totalTokensUsed: 0,
      totalCostUSD: 0,
      taskCount: 0
    };
  }

  /**
   * Track a handoff operation
   */
  trackHandoff(handoff) {
    const handoffData = {
      timestamp: Date.now(),
      operation: handoff.operation, // 'execute', 'escalate', 'delegate', 'review'
      fromTier: handoff.fromTier,
      toTier: handoff.toTier,
      provider: handoff.provider,
      model: handoff.model,
      confidence: handoff.confidence,
      success: handoff.success,
      durationMs: handoff.durationMs,
      tokensUsed: handoff.tokensUsed || this.estimateTokens(handoff),
      costUSD: handoff.costUSD || this.calculateCost(handoff),
      sessionId: this.currentSession.startTime
    };

    this.currentSession.handoffs.push(handoffData);
    this.currentSession.totalTokensUsed += handoffData.tokensUsed;
    this.currentSession.totalCostUSD += handoffData.costUSD;

    if (handoff.operation === 'escalate') {
      this.currentSession.escalations++;
    }

    if (handoff.operation === 'execute') {
      this.currentSession.taskCount++;
    }

    // Append to persistent log
    const logPath = join(this.metricsDir, 'handoffs.jsonl');
    atomicAppendJSONL(logPath, handoffData);

    return handoffData;
  }

  /**
   * Estimate token usage for a handoff
   */
  estimateTokens(handoff) {
    const promptLength = handoff.prompt?.length || 1000;
    const outputLength = handoff.output?.length || 500;

    // Rough estimation: 4 characters per token
    const inputTokens = Math.ceil(promptLength / 4);
    const outputTokens = Math.ceil(outputLength / 4);

    return {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens
    };
  }

  /**
   * Calculate cost based on tier and tokens
   */
  calculateCost(handoff) {
    const tier = handoff.toTier || handoff.tier;
    const tokens = handoff.tokensUsed || this.estimateTokens(handoff);
    const rates = BASELINES.tokenCosts[tier] || BASELINES.tokenCosts.ic;

    const inputCost = (tokens.input / 1000) * rates.input / 100; // Convert to USD
    const outputCost = (tokens.output / 1000) * rates.output / 100;

    return inputCost + outputCost;
  }

  /**
   * Calculate efficiency vs baseline
   */
  calculateEfficiencyVsBaseline() {
    const totalTasks = this.currentSession.taskCount;
    if (totalTasks === 0) return null;

    // Estimated cost if using dual-verification for all tasks
    const baselineCost = this.currentSession.totalCostUSD * BASELINES.dualVerificationMultiplier;
    const actualCost = this.currentSession.totalCostUSD;

    const efficiency = {
      tokenSavings: 1 - (actualCost / baselineCost),
      costSavingsUSD: baselineCost - actualCost,
      escalationRate: this.currentSession.escalations / totalTasks,
      averageConfidence: this.calculateAverageConfidence()
    };

    return efficiency;
  }

  /**
   * Calculate average confidence across successful operations
   */
  calculateAverageConfidence() {
    const successfulHandoffs = this.currentSession.handoffs.filter(h =>
      h.success && h.confidence !== null
    );

    if (successfulHandoffs.length === 0) return null;

    const totalConfidence = successfulHandoffs.reduce((sum, h) => sum + h.confidence, 0);
    return totalConfidence / successfulHandoffs.length;
  }

  /**
   * Calculate escalation rate
   */
  calculateEscalationRate() {
    const totalTasks = this.currentSession.taskCount;
    return totalTasks > 0 ? this.currentSession.escalations / totalTasks : 0;
  }

  /**
   * Generate comprehensive performance report
   */
  generateReport() {
    const efficiency = this.calculateEfficiencyVsBaseline();
    const duration = Date.now() - this.currentSession.startTime;

    const report = {
      timestamp: new Date().toISOString(),
      sessionDuration: duration,
      workspace: this.workspace,

      // Core metrics
      taskCount: this.currentSession.taskCount,
      totalHandoffs: this.currentSession.handoffs.length,
      escalationCount: this.currentSession.escalations,

      // Performance metrics
      escalationRate: this.calculateEscalationRate(),
      averageConfidence: this.calculateAverageConfidence(),

      // Efficiency metrics
      efficiency: efficiency ? {
        tokenSavingsPercentage: (efficiency.tokenSavings * 100).toFixed(1),
        costSavingsUSD: efficiency.costSavingsUSD.toFixed(4),
        escalationRate: (efficiency.escalationRate * 100).toFixed(1),
        averageConfidence: efficiency.averageConfidence ? (efficiency.averageConfidence * 100).toFixed(1) : null
      } : null,

      // Cost metrics
      totalCostUSD: this.currentSession.totalCostUSD.toFixed(4),
      totalTokensUsed: this.currentSession.totalTokensUsed,
      averageCostPerTask: this.currentSession.taskCount > 0 ?
        (this.currentSession.totalCostUSD / this.currentSession.taskCount).toFixed(4) : null,

      // Tier distribution
      tierDistribution: this.calculateTierDistribution(),

      // Performance indicators
      indicators: this.generatePerformanceIndicators(efficiency),

      // Raw session data
      session: this.currentSession
    };

    return report;
  }

  /**
   * Calculate tier usage distribution
   */
  calculateTierDistribution() {
    const tierCounts = { worker: 0, ic: 0, manager: 0 };

    this.currentSession.handoffs.forEach(handoff => {
      const tier = handoff.toTier || handoff.tier;
      if (tierCounts.hasOwnProperty(tier)) {
        tierCounts[tier]++;
      }
    });

    const total = Object.values(tierCounts).reduce((sum, count) => sum + count, 0);

    if (total === 0) return tierCounts;

    return {
      worker: { count: tierCounts.worker, percentage: (tierCounts.worker / total * 100).toFixed(1) },
      ic: { count: tierCounts.ic, percentage: (tierCounts.ic / total * 100).toFixed(1) },
      manager: { count: tierCounts.manager, percentage: (tierCounts.manager / total * 100).toFixed(1) }
    };
  }

  /**
   * Generate performance indicators and recommendations
   */
  generatePerformanceIndicators(efficiency) {
    const indicators = [];

    if (efficiency) {
      // Token savings indicator
      if (efficiency.tokenSavings > 0.5) {
        indicators.push({
          type: 'excellent',
          metric: 'token_efficiency',
          message: `Excellent token efficiency: ${(efficiency.tokenSavings * 100).toFixed(1)}% savings vs baseline`,
          recommendation: 'Continue current routing strategy'
        });
      } else if (efficiency.tokenSavings > 0.2) {
        indicators.push({
          type: 'good',
          metric: 'token_efficiency',
          message: `Good token efficiency: ${(efficiency.tokenSavings * 100).toFixed(1)}% savings`,
          recommendation: 'Consider optimizing task classification for better tier routing'
        });
      } else {
        indicators.push({
          type: 'warning',
          metric: 'token_efficiency',
          message: `Low token efficiency: only ${(efficiency.tokenSavings * 100).toFixed(1)}% savings`,
          recommendation: 'Review task routing - too many high-tier operations for simple tasks'
        });
      }

      // Escalation rate indicator
      if (efficiency.escalationRate <= BASELINES.averageEscalationRate) {
        indicators.push({
          type: 'good',
          metric: 'escalation_rate',
          message: `Healthy escalation rate: ${(efficiency.escalationRate * 100).toFixed(1)}%`,
          recommendation: 'Task complexity assessment is working well'
        });
      } else {
        indicators.push({
          type: 'warning',
          metric: 'escalation_rate',
          message: `High escalation rate: ${(efficiency.escalationRate * 100).toFixed(1)}%`,
          recommendation: 'Consider starting tasks at higher tiers or improving initial classification'
        });
      }

      // Confidence indicator
      if (efficiency.averageConfidence >= BASELINES.targetConfidence) {
        indicators.push({
          type: 'excellent',
          metric: 'confidence',
          message: `High confidence: ${(efficiency.averageConfidence * 100).toFixed(1)}%`,
          recommendation: 'Models are well-matched to task complexity'
        });
      } else if (efficiency.averageConfidence >= 0.6) {
        indicators.push({
          type: 'good',
          metric: 'confidence',
          message: `Moderate confidence: ${(efficiency.averageConfidence * 100).toFixed(1)}%`,
          recommendation: 'Consider task decomposition or tier adjustment'
        });
      } else {
        indicators.push({
          type: 'warning',
          metric: 'confidence',
          message: `Low confidence: ${(efficiency.averageConfidence * 100).toFixed(1)}%`,
          recommendation: 'Review task complexity vs model capabilities'
        });
      }
    }

    return indicators;
  }

  /**
   * Save session report to persistent storage
   */
  saveSessionReport() {
    const report = this.generateReport();
    const reportsPath = join(this.metricsDir, 'session-reports.jsonl');

    atomicAppendJSONL(reportsPath, report);

    // Also save as individual report file
    const reportId = `session-${this.currentSession.startTime}`;
    const reportPath = join(this.metricsDir, `${reportId}.json`);
    atomicWriteJSON(reportPath, report);

    return { reportId, reportPath, report };
  }

  /**
   * Update running statistics
   */
  updateRunningStats() {
    const statsPath = join(this.metricsDir, 'running-stats.json');

    const report = this.generateReport();

    return lockedReadModifyWrite(statsPath, (stats) => {
      const updated = stats || {
        totalSessions: 0,
        totalTasks: 0,
        totalCostUSD: 0,
        totalTokensUsed: 0,
        averageEfficiency: 0,
        averageConfidence: 0,
        averageEscalationRate: 0,
        lastUpdated: null
      };

      updated.totalSessions++;
      updated.totalTasks += report.taskCount;
      updated.totalCostUSD += parseFloat(report.totalCostUSD);
      updated.totalTokensUsed += report.totalTokensUsed;

      // Running averages
      if (report.efficiency) {
        const newEfficiency = parseFloat(report.efficiency.tokenSavingsPercentage) / 100;
        updated.averageEfficiency = ((updated.averageEfficiency * (updated.totalSessions - 1)) + newEfficiency) / updated.totalSessions;

        if (report.averageConfidence) {
          const newConfidence = parseFloat(report.efficiency.averageConfidence) / 100;
          updated.averageConfidence = ((updated.averageConfidence * (updated.totalSessions - 1)) + newConfidence) / updated.totalSessions;
        }

        const newEscalationRate = parseFloat(report.efficiency.escalationRate) / 100;
        updated.averageEscalationRate = ((updated.averageEscalationRate * (updated.totalSessions - 1)) + newEscalationRate) / updated.totalSessions;
      }

      updated.lastUpdated = new Date().toISOString();

      return updated;
    }, {
      totalSessions: 0,
      totalTasks: 0,
      totalCostUSD: 0,
      totalTokensUsed: 0,
      averageEfficiency: 0,
      averageConfidence: 0,
      averageEscalationRate: 0,
      lastUpdated: null
    });
  }

  /**
   * End session and finalize metrics
   */
  endSession() {
    const sessionReport = this.saveSessionReport();
    const runningStats = this.updateRunningStats();

    return {
      ...sessionReport,
      runningStats
    };
  }
}

/**
 * Global performance monitor instance
 */
let globalMonitor = null;

/**
 * Get or create global performance monitor
 */
export function getPerformanceMonitor(workspace = process.cwd()) {
  if (!globalMonitor) {
    globalMonitor = new PerformanceMonitor(workspace);
  }
  return globalMonitor;
}

/**
 * Track handoff with global monitor
 */
export function trackHandoff(handoff) {
  const monitor = getPerformanceMonitor();
  return monitor.trackHandoff(handoff);
}

/**
 * Generate performance report
 */
export function generatePerformanceReport(workspace = process.cwd()) {
  const monitor = getPerformanceMonitor(workspace);
  return monitor.generateReport();
}

/**
 * End session and save metrics
 */
export function endPerformanceSession(workspace = process.cwd()) {
  if (!globalMonitor) return null;

  const result = globalMonitor.endSession();
  globalMonitor = null; // Reset for next session

  return result;
}