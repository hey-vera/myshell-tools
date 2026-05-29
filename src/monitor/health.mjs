/**
 * health.mjs — System health checks and monitoring
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { atomicAppendJSONL, lockedReadModifyWrite } from '../state/atomic.mjs';

/**
 * Health monitoring class
 */
export class HealthMonitor {
  constructor(workspace = process.cwd()) {
    this.workspace = workspace;
    this.healthDir = join(workspace, '.cortex', 'health');
    this.startTime = Date.now();
    this.checks = new Map();
  }

  /**
   * Ensure health directory exists
   */
  ensureHealthDir() {
    if (!existsSync(this.healthDir)) {
      require('fs').mkdirSync(this.healthDir, { recursive: true });
    }
    return this.healthDir;
  }

  /**
   * Check CLI availability and response time
   */
  async checkCliHealth(provider, command, args = ['--version']) {
    const startTime = Date.now();

    try {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000 // 10 second timeout
      });

      const responseTime = Date.now() - startTime;

      const healthData = {
        provider,
        command,
        timestamp: Date.now(),
        available: result.status === 0,
        responseTime,
        version: result.status === 0 ? result.stdout.trim().split('\n')[0] : null,
        error: result.status !== 0 ? (result.stderr || 'Command failed') : null
      };

      this.recordHealthCheck(provider, healthData);
      return healthData;

    } catch (error) {
      const responseTime = Date.now() - startTime;

      const healthData = {
        provider,
        command,
        timestamp: Date.now(),
        available: false,
        responseTime,
        version: null,
        error: error.code === 'ENOENT' ? 'Command not found' : error.message
      };

      this.recordHealthCheck(provider, healthData);
      return healthData;
    }
  }

  /**
   * Check network connectivity to provider APIs
   */
  async checkNetworkHealth(provider, endpoint) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      try {
        const https = require('https');
        const url = new URL(endpoint);

        const req = https.request({
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'HEAD',
          timeout: 5000
        }, (res) => {
          const responseTime = Date.now() - startTime;

          const healthData = {
            provider,
            endpoint,
            timestamp: Date.now(),
            available: res.statusCode < 400,
            responseTime,
            statusCode: res.statusCode,
            error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null
          };

          this.recordHealthCheck(`${provider}_network`, healthData);
          resolve(healthData);
        });

        req.on('error', (error) => {
          const responseTime = Date.now() - startTime;

          const healthData = {
            provider,
            endpoint,
            timestamp: Date.now(),
            available: false,
            responseTime,
            statusCode: null,
            error: error.message
          };

          this.recordHealthCheck(`${provider}_network`, healthData);
          resolve(healthData);
        });

        req.on('timeout', () => {
          const responseTime = Date.now() - startTime;

          const healthData = {
            provider,
            endpoint,
            timestamp: Date.now(),
            available: false,
            responseTime,
            statusCode: null,
            error: 'Timeout'
          };

          this.recordHealthCheck(`${provider}_network`, healthData);
          resolve(healthData);
          req.destroy();
        });

        req.end();
      } catch (error) {
        const responseTime = Date.now() - startTime;

        const healthData = {
          provider,
          endpoint,
          timestamp: Date.now(),
          available: false,
          responseTime,
          statusCode: null,
          error: error.message
        };

        this.recordHealthCheck(`${provider}_network`, healthData);
        resolve(healthData);
      }
    });
  }

  /**
   * Check system resources
   */
  checkSystemHealth() {
    const memUsage = process.memoryUsage();

    const healthData = {
      timestamp: Date.now(),
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024)
      },
      uptime: Math.round(process.uptime() * 1000), // ms
      loadAverage: process.platform !== 'win32' ? process.loadavg() : null,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    };

    this.recordHealthCheck('system', healthData);
    return healthData;
  }

  /**
   * Record health check result
   */
  recordHealthCheck(component, data) {
    this.checks.set(component, data);

    // Persist to file
    this.ensureHealthDir();
    const logPath = join(this.healthDir, `${component}-health.jsonl`);

    try {
      atomicAppendJSONL(logPath, data);
    } catch (error) {
      console.warn(`Failed to log health check for ${component}:`, error.message);
    }
  }

  /**
   * Get recent health status for a component
   */
  getRecentHealth(component, timeWindowMs = 5 * 60 * 1000) {
    const logPath = join(this.healthDir, `${component}-health.jsonl`);

    if (!existsSync(logPath)) {
      return [];
    }

    try {
      const content = require('fs').readFileSync(logPath, 'utf8');
      const cutoff = Date.now() - timeWindowMs;

      return content
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
        .filter(entry => entry.timestamp > cutoff)
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      return [];
    }
  }

  /**
   * Calculate component health score
   */
  calculateHealthScore(component, timeWindowMs = 15 * 60 * 1000) {
    const recent = this.getRecentHealth(component, timeWindowMs);

    if (recent.length === 0) {
      return { score: 0, status: 'unknown', message: 'No recent data' };
    }

    const availabilityRatio = recent.filter(entry => entry.available).length / recent.length;
    const avgResponseTime = recent
      .filter(entry => entry.available && entry.responseTime)
      .reduce((sum, entry) => sum + entry.responseTime, 0) / Math.max(recent.length, 1);

    let score = availabilityRatio * 100;

    // Penalize high response times
    if (avgResponseTime > 5000) {
      score *= 0.7; // High latency
    } else if (avgResponseTime > 2000) {
      score *= 0.9; // Moderate latency
    }

    const status = score >= 90 ? 'healthy' :
                  score >= 70 ? 'degraded' :
                  score >= 50 ? 'unhealthy' : 'critical';

    return {
      score: Math.round(score),
      status,
      availabilityRatio,
      avgResponseTime: Math.round(avgResponseTime),
      recentChecks: recent.length,
      message: this.getHealthMessage(status, availabilityRatio, avgResponseTime)
    };
  }

  /**
   * Get health status message
   */
  getHealthMessage(status, availability, responseTime) {
    switch (status) {
      case 'healthy':
        return `Healthy - ${(availability * 100).toFixed(1)}% availability`;

      case 'degraded':
        if (availability < 0.8) {
          return `Degraded - ${(availability * 100).toFixed(1)}% availability`;
        } else {
          return `Degraded - High latency (${responseTime}ms)`;
        }

      case 'unhealthy':
        return `Unhealthy - ${(availability * 100).toFixed(1)}% availability, ${responseTime}ms latency`;

      case 'critical':
        return `Critical - ${(availability * 100).toFixed(1)}% availability`;

      default:
        return 'Unknown status';
    }
  }

  /**
   * Comprehensive health check
   */
  async runComprehensiveCheck() {
    const results = {
      timestamp: Date.now(),
      workspace: this.workspace,
      components: {},
      overall: { score: 0, status: 'unknown' }
    };

    // Check CLI health
    results.components.claude = await this.checkCliHealth('claude', 'claude');
    results.components.codex = await this.checkCliHealth('codex', 'codex');

    // Check network health
    results.components.claude_network = await this.checkNetworkHealth('claude', 'https://console.anthropic.com');
    results.components.openai_network = await this.checkNetworkHealth('openai', 'https://api.openai.com');

    // Check system health
    results.components.system = this.checkSystemHealth();

    // Calculate health scores
    for (const [component, data] of Object.entries(results.components)) {
      if (data.timestamp) {
        const score = this.calculateHealthScore(component);
        results.components[component].healthScore = score;
      }
    }

    // Calculate overall score
    const scores = Object.values(results.components)
      .map(comp => comp.healthScore?.score || 0)
      .filter(score => score > 0);

    if (scores.length > 0) {
      results.overall.score = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
      results.overall.status = results.overall.score >= 80 ? 'healthy' :
                              results.overall.score >= 60 ? 'degraded' :
                              results.overall.score >= 40 ? 'unhealthy' : 'critical';
    }

    // Update running health statistics
    this.updateHealthStats(results);

    return results;
  }

  /**
   * Update running health statistics
   */
  updateHealthStats(results) {
    const statsPath = join(this.healthDir, 'running-health-stats.json');

    try {
      return lockedReadModifyWrite(statsPath, (stats) => {
        const updated = stats || {
          totalChecks: 0,
          averageScore: 0,
          downtimeEvents: 0,
          lastCheck: null,
          components: {}
        };

        updated.totalChecks++;
        updated.lastCheck = results.timestamp;

        // Update overall average
        const newScore = results.overall.score;
        updated.averageScore = ((updated.averageScore * (updated.totalChecks - 1)) + newScore) / updated.totalChecks;

        // Track component statistics
        for (const [component, data] of Object.entries(results.components)) {
          if (!updated.components[component]) {
            updated.components[component] = {
              checks: 0,
              averageScore: 0,
              downtimeEvents: 0,
              lastDowntime: null
            };
          }

          const compStats = updated.components[component];
          compStats.checks++;

          if (data.healthScore) {
            compStats.averageScore = ((compStats.averageScore * (compStats.checks - 1)) + data.healthScore.score) / compStats.checks;

            // Track downtime events
            if (data.healthScore.status === 'critical' || data.healthScore.status === 'unhealthy') {
              if (compStats.lastDowntime === null || (results.timestamp - compStats.lastDowntime) > 60 * 60 * 1000) {
                compStats.downtimeEvents++;
                compStats.lastDowntime = results.timestamp;
              }
            }
          }
        }

        return updated;
      });
    } catch (error) {
      console.warn('Failed to update health stats:', error.message);
      return null;
    }
  }

  /**
   * Get health trends
   */
  getHealthTrends(component, timeWindowMs = 24 * 60 * 60 * 1000) {
    const recent = this.getRecentHealth(component, timeWindowMs);

    if (recent.length < 2) {
      return { trend: 'insufficient_data', slope: 0 };
    }

    // Calculate availability trend over time
    const dataPoints = recent.map((entry, index) => ({
      x: index,
      y: entry.available ? 1 : 0
    }));

    // Simple linear regression to determine trend
    const n = dataPoints.length;
    const sumX = dataPoints.reduce((sum, p) => sum + p.x, 0);
    const sumY = dataPoints.reduce((sum, p) => sum + p.y, 0);
    const sumXY = dataPoints.reduce((sum, p) => sum + (p.x * p.y), 0);
    const sumXX = dataPoints.reduce((sum, p) => sum + (p.x * p.x), 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

    const trend = slope > 0.01 ? 'improving' :
                  slope < -0.01 ? 'declining' : 'stable';

    return {
      trend,
      slope: slope.toFixed(4),
      dataPoints: dataPoints.length,
      availability: (sumY / n).toFixed(3)
    };
  }
}

/**
 * Global health monitor instance
 */
let globalHealthMonitor = null;

/**
 * Get or create global health monitor
 */
export function getHealthMonitor(workspace = process.cwd()) {
  if (!globalHealthMonitor) {
    globalHealthMonitor = new HealthMonitor(workspace);
  }
  return globalHealthMonitor;
}

/**
 * Run health check
 */
export async function runHealthCheck(workspace = process.cwd()) {
  const monitor = getHealthMonitor(workspace);
  return await monitor.runComprehensiveCheck();
}

/**
 * Get component health score
 */
export function getComponentHealth(component, workspace = process.cwd()) {
  const monitor = getHealthMonitor(workspace);
  return monitor.calculateHealthScore(component);
}

/**
 * Check if a provider is healthy
 */
export function isProviderHealthy(provider, workspace = process.cwd()) {
  const monitor = getHealthMonitor(workspace);
  const health = monitor.calculateHealthScore(provider);
  return health.status === 'healthy' || health.status === 'degraded';
}