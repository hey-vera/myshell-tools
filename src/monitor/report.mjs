/**
 * report.mjs — Usage reporting and analytics
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { generatePerformanceReport } from './performance.mjs';
import { runHealthCheck } from './health.mjs';
import { getSessionSummary } from '../state/session.mjs';
import { getStorageStats } from '../state/cleanup.mjs';

/**
 * Colors for terminal output
 */
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

/**
 * Generate comprehensive session report
 */
export async function generateSessionReport(workspace = process.cwd()) {
  const timestamp = new Date().toISOString();

  console.log(`${colors.bold}${colors.blue}📊 Cortex Session Report${colors.reset}\n`);
  console.log(`${colors.dim}Generated: ${new Date().toLocaleString()}${colors.reset}\n`);

  // Gather data from all monitoring sources
  const performance = generatePerformanceReport(workspace);
  const session = getSessionSummary(workspace);
  const health = await runHealthCheck(workspace);
  const storage = getStorageStats(workspace);

  const report = {
    timestamp,
    workspace,
    session,
    performance,
    health,
    storage
  };

  // Display session overview
  displaySessionOverview(session);

  // Display performance metrics
  displayPerformanceMetrics(performance);

  // Display efficiency analysis
  displayEfficiencyAnalysis(performance);

  // Display system health
  displayHealthStatus(health);

  // Display recommendations
  displayRecommendations(performance, health);

  return report;
}

/**
 * Display session overview
 */
function displaySessionOverview(session) {
  console.log(`${colors.bold}Session Overview${colors.reset}`);

  if (session.messageCount === 0) {
    console.log(`  ${colors.dim}No active session${colors.reset}\n`);
    return;
  }

  const duration = session.duration ? formatDuration(session.duration) : 'ongoing';
  const avgResponseTime = session.duration && session.assistantMessageCount > 0 ?
    formatDuration(session.duration / session.assistantMessageCount) : 'N/A';

  console.log(`  📝 Messages: ${session.messageCount} (${session.userMessageCount} user, ${session.assistantMessageCount} assistant)`);
  console.log(`  ⏱️  Duration: ${duration}`);
  console.log(`  📊 Avg Response: ${avgResponseTime}`);

  if (session.lastMessage) {
    const lastTime = new Date(session.lastMessage.timestamp).toLocaleString();
    console.log(`  🕐 Last Activity: ${lastTime}`);
  }

  console.log();
}

/**
 * Display performance metrics
 */
function displayPerformanceMetrics(performance) {
  console.log(`${colors.bold}Performance Metrics${colors.reset}`);

  if (!performance.taskCount) {
    console.log(`  ${colors.dim}No tasks completed in this session${colors.reset}\n`);
    return;
  }

  console.log(`  📋 Tasks Completed: ${performance.taskCount}`);
  console.log(`  🔄 Total Handoffs: ${performance.totalHandoffs}`);
  console.log(`  📈 Escalations: ${performance.escalationCount} (${performance.escalationRate})`);

  if (performance.averageConfidence) {
    const confidenceColor = parseFloat(performance.averageConfidence) >= 75 ? colors.green :
                           parseFloat(performance.averageConfidence) >= 60 ? colors.yellow : colors.red;
    console.log(`  🎯 Avg Confidence: ${confidenceColor}${performance.averageConfidence}%${colors.reset}`);
  }

  // Cost metrics
  if (performance.totalCostUSD) {
    console.log(`  💰 Total Cost: $${performance.totalCostUSD}`);
    if (performance.averageCostPerTask) {
      console.log(`  💵 Avg Cost/Task: $${performance.averageCostPerTask}`);
    }
  }

  // Tier distribution
  if (performance.tierDistribution) {
    console.log(`  🏗️  Tier Usage:`);
    ['worker', 'ic', 'manager'].forEach(tier => {
      const dist = performance.tierDistribution[tier];
      if (dist && dist.count > 0) {
        const tierColor = tier === 'worker' ? colors.blue :
                         tier === 'ic' ? colors.yellow : colors.red;
        console.log(`     ${tierColor}${tier.toUpperCase()}${colors.reset}: ${dist.count} (${dist.percentage}%)`);
      }
    });
  }

  console.log();
}

/**
 * Display efficiency analysis
 */
function displayEfficiencyAnalysis(performance) {
  console.log(`${colors.bold}Efficiency Analysis${colors.reset}`);

  if (!performance.efficiency) {
    console.log(`  ${colors.dim}Insufficient data for efficiency analysis${colors.reset}\n`);
    return;
  }

  const efficiency = performance.efficiency;

  // Token savings
  const savingsPercentage = parseFloat(efficiency.tokenSavingsPercentage);
  const savingsColor = savingsPercentage >= 50 ? colors.green :
                      savingsPercentage >= 25 ? colors.yellow : colors.red;
  console.log(`  💾 Token Savings: ${savingsColor}${efficiency.tokenSavingsPercentage}% vs dual-verification${colors.reset}`);

  if (efficiency.costSavingsUSD) {
    console.log(`  💰 Cost Savings: ${savingsColor}$${efficiency.costSavingsUSD}${colors.reset}`);
  }

  // Escalation efficiency
  const escalationRate = parseFloat(efficiency.escalationRate);
  const escalationColor = escalationRate <= 25 ? colors.green :
                         escalationRate <= 40 ? colors.yellow : colors.red;
  console.log(`  📈 Escalation Rate: ${escalationColor}${efficiency.escalationRate}%${colors.reset}`);

  // Performance indicators
  if (performance.indicators && performance.indicators.length > 0) {
    console.log(`\n  ${colors.bold}Key Insights:${colors.reset}`);
    performance.indicators.forEach(indicator => {
      const indicatorColor = indicator.type === 'excellent' ? colors.green :
                            indicator.type === 'good' ? colors.yellow :
                            indicator.type === 'warning' ? colors.red : colors.white;

      const icon = indicator.type === 'excellent' ? '✅' :
                  indicator.type === 'good' ? '👍' :
                  indicator.type === 'warning' ? '⚠️' : 'ℹ️';

      console.log(`    ${icon} ${indicatorColor}${indicator.message}${colors.reset}`);
      if (indicator.recommendation) {
        console.log(`      ${colors.dim}→ ${indicator.recommendation}${colors.reset}`);
      }
    });
  }

  console.log();
}

/**
 * Display health status
 */
function displayHealthStatus(health) {
  console.log(`${colors.bold}System Health${colors.reset}`);

  const overallColor = health.overall.status === 'healthy' ? colors.green :
                      health.overall.status === 'degraded' ? colors.yellow : colors.red;

  console.log(`  🏥 Overall: ${overallColor}${health.overall.status.toUpperCase()} (${health.overall.score}/100)${colors.reset}`);

  // Component health
  const healthyComponents = Object.entries(health.components)
    .filter(([_, comp]) => comp.healthScore?.status === 'healthy').length;
  const totalComponents = Object.keys(health.components).length;

  console.log(`  🧩 Components: ${healthyComponents}/${totalComponents} healthy`);

  // Show critical issues
  const criticalComponents = Object.entries(health.components)
    .filter(([_, comp]) => comp.healthScore?.status === 'critical' || comp.healthScore?.status === 'unhealthy')
    .map(([name, _]) => name);

  if (criticalComponents.length > 0) {
    console.log(`  ${colors.red}⚠️  Issues: ${criticalComponents.join(', ')}${colors.reset}`);
  }

  console.log();
}

/**
 * Display recommendations
 */
function displayRecommendations(performance, health) {
  console.log(`${colors.bold}Recommendations${colors.reset}`);

  const recommendations = [];

  // Performance recommendations
  if (performance.efficiency) {
    const savingsPercentage = parseFloat(performance.efficiency.tokenSavingsPercentage);
    const escalationRate = parseFloat(performance.efficiency.escalationRate);

    if (savingsPercentage < 25) {
      recommendations.push({
        priority: 'high',
        type: 'efficiency',
        message: 'Low token efficiency detected',
        action: 'Review task routing and tier assignment logic'
      });
    }

    if (escalationRate > 40) {
      recommendations.push({
        priority: 'medium',
        type: 'escalation',
        message: 'High escalation rate',
        action: 'Consider starting complex tasks at higher tiers'
      });
    }

    if (performance.averageConfidence && parseFloat(performance.averageConfidence) < 60) {
      recommendations.push({
        priority: 'medium',
        type: 'confidence',
        message: 'Low average confidence scores',
        action: 'Review task complexity vs model capabilities'
      });
    }
  }

  // Health recommendations
  const unhealthyComponents = Object.entries(health.components)
    .filter(([_, comp]) => comp.healthScore?.status !== 'healthy')
    .map(([name, comp]) => ({ name, status: comp.healthScore?.status }));

  unhealthyComponents.forEach(({ name, status }) => {
    recommendations.push({
      priority: status === 'critical' ? 'critical' : 'medium',
      type: 'health',
      message: `${name} component is ${status}`,
      action: 'Run --doctor for detailed diagnostics'
    });
  });

  // Cost recommendations
  if (performance.totalCostUSD && parseFloat(performance.totalCostUSD) > 1.0) {
    recommendations.push({
      priority: 'low',
      type: 'cost',
      message: 'High session cost detected',
      action: 'Consider using lower tiers for simple tasks'
    });
  }

  // Display recommendations
  if (recommendations.length === 0) {
    console.log(`  ${colors.green}✅ No issues found - system is performing well${colors.reset}`);
  } else {
    recommendations
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      })
      .forEach((rec, index) => {
        const priorityColor = rec.priority === 'critical' ? colors.red :
                             rec.priority === 'high' ? colors.red :
                             rec.priority === 'medium' ? colors.yellow : colors.cyan;

        console.log(`  ${index + 1}. ${priorityColor}[${rec.priority.toUpperCase()}]${colors.reset} ${rec.message}`);
        console.log(`     ${colors.dim}→ ${rec.action}${colors.reset}`);
      });
  }

  console.log();
}

/**
 * Generate historical trends report
 */
export async function generateTrendsReport(workspace = process.cwd(), days = 7) {
  console.log(`${colors.bold}${colors.blue}📈 Trends Report (${days} days)${colors.reset}\n`);

  const metricsDir = join(workspace, '.cortex', 'metrics');
  const reportsPath = join(metricsDir, 'session-reports.jsonl');

  if (!existsSync(reportsPath)) {
    console.log(`${colors.dim}No historical data available${colors.reset}\n`);
    return null;
  }

  try {
    const content = readFileSync(reportsPath, 'utf8');
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    const reports = content
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter(report => new Date(report.timestamp).getTime() > cutoff)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (reports.length === 0) {
      console.log(`${colors.dim}No data available for the last ${days} days${colors.reset}\n`);
      return null;
    }

    // Analyze trends
    const trends = analyzeTrends(reports);

    displayTrends(trends, days);

    return trends;

  } catch (error) {
    console.log(`${colors.red}Error loading historical data: ${error.message}${colors.reset}\n`);
    return null;
  }
}

/**
 * Analyze trends from historical reports
 */
function analyzeTrends(reports) {
  const trends = {
    sessions: reports.length,
    totalTasks: reports.reduce((sum, r) => sum + (r.taskCount || 0), 0),
    totalCost: reports.reduce((sum, r) => sum + parseFloat(r.totalCostUSD || 0), 0),

    efficiency: {
      average: calculateAverage(reports, 'efficiency.tokenSavingsPercentage'),
      trend: calculateTrend(reports, 'efficiency.tokenSavingsPercentage')
    },

    escalationRate: {
      average: calculateAverage(reports, 'escalationRate'),
      trend: calculateTrend(reports, 'escalationRate')
    },

    confidence: {
      average: calculateAverage(reports, 'averageConfidence'),
      trend: calculateTrend(reports, 'averageConfidence')
    },

    costPerTask: {
      average: calculateAverage(reports, 'averageCostPerTask'),
      trend: calculateTrend(reports, 'averageCostPerTask')
    }
  };

  return trends;
}

/**
 * Calculate average of a metric across reports
 */
function calculateAverage(reports, metricPath) {
  const values = reports
    .map(report => getNestedValue(report, metricPath))
    .filter(val => val !== null && !isNaN(parseFloat(val)))
    .map(val => parseFloat(val));

  return values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : null;
}

/**
 * Calculate trend direction for a metric
 */
function calculateTrend(reports, metricPath) {
  const values = reports
    .map(report => getNestedValue(report, metricPath))
    .filter(val => val !== null && !isNaN(parseFloat(val)))
    .map(val => parseFloat(val));

  if (values.length < 2) return 'insufficient_data';

  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const secondHalf = values.slice(Math.floor(values.length / 2));

  const firstAvg = firstHalf.reduce((sum, val) => sum + val, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, val) => sum + val, 0) / secondHalf.length;

  const change = ((secondAvg - firstAvg) / firstAvg) * 100;

  return change > 5 ? 'improving' :
         change < -5 ? 'declining' : 'stable';
}

/**
 * Get nested object value by path
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Display trends
 */
function displayTrends(trends, days) {
  console.log(`${colors.bold}Summary${colors.reset}`);
  console.log(`  📊 Sessions: ${trends.sessions}`);
  console.log(`  📋 Total Tasks: ${trends.totalTasks}`);
  console.log(`  💰 Total Cost: $${trends.totalCost.toFixed(4)}`);
  console.log();

  console.log(`${colors.bold}Performance Trends${colors.reset}`);

  if (trends.efficiency.average !== null) {
    const trendIcon = getTrendIcon(trends.efficiency.trend);
    console.log(`  💾 Token Efficiency: ${trends.efficiency.average.toFixed(1)}% ${trendIcon}`);
  }

  if (trends.escalationRate.average !== null) {
    const trendIcon = getTrendIcon(trends.escalationRate.trend);
    console.log(`  📈 Escalation Rate: ${trends.escalationRate.average.toFixed(1)}% ${trendIcon}`);
  }

  if (trends.confidence.average !== null) {
    const trendIcon = getTrendIcon(trends.confidence.trend);
    console.log(`  🎯 Avg Confidence: ${trends.confidence.average.toFixed(1)}% ${trendIcon}`);
  }

  if (trends.costPerTask.average !== null) {
    const trendIcon = getTrendIcon(trends.costPerTask.trend);
    console.log(`  💵 Cost/Task: $${trends.costPerTask.average.toFixed(4)} ${trendIcon}`);
  }

  console.log();
}

/**
 * Get trend icon
 */
function getTrendIcon(trend) {
  switch (trend) {
    case 'improving':
      return `${colors.green}📈 improving${colors.reset}`;
    case 'declining':
      return `${colors.red}📉 declining${colors.reset}`;
    case 'stable':
      return `${colors.yellow}➡️ stable${colors.reset}`;
    default:
      return `${colors.dim}❓ unknown${colors.reset}`;
  }
}

/**
 * Format duration for display
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Quick status summary
 */
export function displayQuickSummary(workspace = process.cwd()) {
  const performance = generatePerformanceReport(workspace);
  const session = getSessionSummary(workspace);

  if (session.messageCount === 0) {
    console.log(`${colors.dim}No active session${colors.reset}`);
    return;
  }

  let status = `📊 ${session.messageCount} msgs`;

  if (performance.taskCount > 0) {
    status += ` | 📋 ${performance.taskCount} tasks`;

    if (performance.efficiency?.tokenSavingsPercentage) {
      const savings = parseFloat(performance.efficiency.tokenSavingsPercentage);
      const savingsColor = savings >= 50 ? colors.green : savings >= 25 ? colors.yellow : colors.red;
      status += ` | ${savingsColor}💾 ${performance.efficiency.tokenSavingsPercentage}%${colors.reset}`;
    }

    if (performance.escalationRate) {
      const escalations = parseFloat(performance.escalationRate);
      const escalationColor = escalations <= 25 ? colors.green : escalations <= 40 ? colors.yellow : colors.red;
      status += ` | ${escalationColor}📈 ${performance.escalationRate}${colors.reset}`;
    }
  }

  console.log(status);
}