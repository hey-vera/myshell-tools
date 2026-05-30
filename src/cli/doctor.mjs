/**
 * doctor.mjs — Comprehensive system health check
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { detectEnvironment, getAvailableModels } from '../providers/detect.mjs';
import { checkProviderHealth } from '../auth/recovery.mjs';
import { getCleanupStatus, getStorageStats } from '../state/cleanup.mjs';
import { getRecoveryStatus } from '../state/recovery.mjs';
import { loadRefreshState } from '../auth/refresh.mjs';

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
 * Status icons
 */
const icons = {
  pass: '✅',
  warn: '⚠️ ',
  fail: '❌',
  info: 'ℹ️ ',
  working: '🔍'
};

/**
 * Comprehensive health check
 */
export async function runDoctorCheck(workspace = process.cwd()) {
  console.log(`${colors.bold}${colors.blue}🔍 Cortex System Health Check${colors.reset}\n`);

  const results = {
    timestamp: new Date().toISOString(),
    workspace,
    checks: [],
    overall: { healthy: true, score: 0, maxScore: 0 },
    recommendations: []
  };

  // System Information
  await checkSystemInfo(results);

  // CLI Installation Check
  await checkCliInstallation(results);

  // Authentication Check
  await checkAuthentication(results);

  // Provider Health Check
  await checkProviders(results);

  // Token Refresh Status
  await checkTokenStatus(results);

  // State Integrity Check
  await checkStateIntegrity(results);

  // Storage and Cleanup Check
  await checkStorageStatus(results);

  // Recovery Status Check
  await checkRecoveryStatus(results);

  // Network Connectivity Check
  await checkNetworkConnectivity(results);

  // Performance Check
  await checkPerformance(results);

  // Calculate overall health score
  const passCount = results.checks.filter(c => c.status === 'pass').length;
  const totalChecks = results.checks.length;
  results.overall.score = passCount;
  results.overall.maxScore = totalChecks;
  results.overall.healthy = (passCount / totalChecks) >= 0.8;

  // Display results
  displayHealthResults(results);

  return results;
}

/**
 * Check system information
 */
async function checkSystemInfo(results) {
  const check = {
    name: 'System Information',
    status: 'info',
    details: {}
  };

  try {
    check.details.platform = process.platform;
    check.details.arch = process.arch;
    check.details.nodeVersion = process.version;
    check.details.memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    console.log(`${icons.info}${colors.dim}Platform: ${check.details.platform}/${check.details.arch}${colors.reset}`);
    console.log(`${colors.dim}Node.js: ${check.details.nodeVersion}${colors.reset}`);
    console.log(`${colors.dim}Memory: ${check.details.memory}MB${colors.reset}\n`);

  } catch (error) {
    check.details.error = error.message;
  }

  results.checks.push(check);
}

/**
 * Check CLI installation status
 */
async function checkCliInstallation(results) {
  console.log(`${colors.bold}CLI Installation${colors.reset}`);

  // Check Claude CLI
  const claudeCheck = checkSingleCLI('claude', ['--version']);
  displaySingleCheck('Claude CLI', claudeCheck);
  results.checks.push({
    name: 'Claude CLI Installation',
    status: claudeCheck.installed ? 'pass' : 'fail',
    details: claudeCheck
  });

  // Check Codex CLI
  const codexCheck = checkSingleCLI('codex', ['--version']);
  displaySingleCheck('Codex CLI', codexCheck);
  results.checks.push({
    name: 'Codex CLI Installation',
    status: codexCheck.installed ? 'pass' : 'fail',
    details: codexCheck
  });

  console.log();
}

/**
 * Check single CLI installation
 */
function checkSingleCLI(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
      shell: process.platform === 'win32'
    });

    return {
      installed: result.status === 0,
      version: result.status === 0 ? result.stdout.trim() : null,
      error: result.status !== 0 ? result.stderr || 'Command failed' : null
    };
  } catch (error) {
    return {
      installed: false,
      version: null,
      error: error.code === 'ENOENT' ? 'Command not found' : error.message
    };
  }
}

/**
 * Check authentication status
 */
async function checkAuthentication(results) {
  console.log(`${colors.bold}Authentication${colors.reset}`);

  const env = detectEnvironment();

  // Claude authentication
  const claudeStatus = env.claude.authed ? 'pass' : (env.claude.installed ? 'warn' : 'fail');
  const claudeMessage = env.claude.authed ? 'Authenticated' :
                       env.claude.installed ? 'CLI installed but not authenticated' :
                       'CLI not installed';

  displaySingleCheck('Claude Auth', { status: claudeStatus, message: claudeMessage });
  results.checks.push({
    name: 'Claude Authentication',
    status: claudeStatus,
    details: { authed: env.claude.authed, installed: env.claude.installed }
  });

  // Codex authentication
  const codexStatus = env.codex.authed ? 'pass' : (env.codex.installed ? 'warn' : 'fail');
  const codexMessage = env.codex.authed ? 'Authenticated' :
                      env.codex.installed ? 'CLI installed but not authenticated' :
                      'CLI not installed';

  displaySingleCheck('Codex Auth', { status: codexStatus, message: codexMessage });
  results.checks.push({
    name: 'Codex Authentication',
    status: codexStatus,
    details: { authed: env.codex.authed, installed: env.codex.installed }
  });

  console.log();
}

/**
 * Check provider health
 */
async function checkProviders(results) {
  console.log(`${colors.bold}Provider Health${colors.reset}`);

  const env = detectEnvironment();
  const models = getAvailableModels(env);
  const health = await checkProviderHealth(env);

  // Model tier availability
  ['manager', 'ic', 'worker'].forEach(tier => {
    const available = models[tier].length;
    const status = available > 0 ? 'pass' : 'fail';
    const message = available > 0 ? `${available} model(s) available` : 'No models available';

    displaySingleCheck(`${tier.toUpperCase()} tier`, { status, message });
    results.checks.push({
      name: `${tier} Tier Availability`,
      status,
      details: { available, models: models[tier] }
    });
  });

  // Overall provider health
  const overallStatus = health.overall.healthy ? 'pass' : 'fail';
  const overallMessage = `${health.overall.availableProviders} provider(s) healthy`;

  displaySingleCheck('Overall Health', { status: overallStatus, message: overallMessage });
  results.checks.push({
    name: 'Provider Health',
    status: overallStatus,
    details: health
  });

  console.log();
}

/**
 * Check token refresh status
 */
async function checkTokenStatus(results) {
  console.log(`${colors.bold}Token Management${colors.reset}`);

  const refreshState = loadRefreshState();

  if (refreshState) {
    const lastRefresh = new Date(refreshState.lastRefresh);
    const age = Math.round((Date.now() - lastRefresh.getTime()) / 1000 / 60 / 60); // hours

    const status = age < 24 ? 'pass' : age < 48 ? 'warn' : 'fail';
    const message = `Last refresh: ${age}h ago`;

    displaySingleCheck('Token Refresh', { status, message });
    results.checks.push({
      name: 'Token Refresh Status',
      status,
      details: { lastRefresh: refreshState.lastRefresh, ageHours: age }
    });
  } else {
    displaySingleCheck('Token Refresh', { status: 'warn', message: 'No refresh history' });
    results.checks.push({
      name: 'Token Refresh Status',
      status: 'warn',
      details: { lastRefresh: null }
    });
  }

  console.log();
}

/**
 * Check state integrity
 */
async function checkStateIntegrity(results) {
  console.log(`${colors.bold}State Integrity${colors.reset}`);

  const recoveryStatus = getRecoveryStatus();

  // Session integrity
  const sessionStatus = recoveryStatus.sessionIntegrity ? 'pass' : 'fail';
  const sessionMessage = recoveryStatus.sessionIntegrity ? 'Valid' : `${recoveryStatus.issues.length} issue(s)`;

  displaySingleCheck('Session Files', { status: sessionStatus, message: sessionMessage });
  results.checks.push({
    name: 'Session Integrity',
    status: sessionStatus,
    details: { valid: recoveryStatus.sessionIntegrity, issues: recoveryStatus.issues }
  });

  // Interrupted work
  const workStatus = recoveryStatus.hasInterruptedWork ? 'warn' : 'pass';
  const workMessage = recoveryStatus.hasInterruptedWork ?
    `${recoveryStatus.interruptedCount} interrupted session(s)` :
    'No interrupted work';

  displaySingleCheck('Work State', { status: workStatus, message: workMessage });
  results.checks.push({
    name: 'Work State',
    status: workStatus,
    details: { hasInterrupted: recoveryStatus.hasInterruptedWork, count: recoveryStatus.interruptedCount }
  });

  console.log();
}

/**
 * Check storage status
 */
async function checkStorageStatus(results) {
  console.log(`${colors.bold}Storage${colors.reset}`);

  const storageStats = getStorageStats();
  const cleanupStatus = getCleanupStatus();

  // Total storage usage
  const totalMB = Math.round(storageStats.totalSize / 1024 / 1024);
  const storageStatus = totalMB < 100 ? 'pass' : totalMB < 500 ? 'warn' : 'fail';
  const storageMessage = `${totalMB}MB used`;

  displaySingleCheck('Storage Usage', { status: storageStatus, message: storageMessage });
  results.checks.push({
    name: 'Storage Usage',
    status: storageStatus,
    details: { totalSize: storageStats.totalSize, totalMB }
  });

  // Cleanup recommendations
  const cleanupCount = cleanupStatus.recommendations.length;
  const cleanupStatus2 = cleanupCount === 0 ? 'pass' : cleanupCount < 3 ? 'warn' : 'fail';
  const cleanupMessage = cleanupCount === 0 ? 'No cleanup needed' : `${cleanupCount} recommendation(s)`;

  displaySingleCheck('Cleanup Status', { status: cleanupStatus2, message: cleanupMessage });
  results.checks.push({
    name: 'Cleanup Status',
    status: cleanupStatus2,
    details: { recommendations: cleanupStatus.recommendations, issues: cleanupStatus.issues }
  });

  console.log();
}

/**
 * Check recovery status
 */
async function checkRecoveryStatus(results) {
  console.log(`${colors.bold}Recovery${colors.reset}`);

  const recoveryStatus = getRecoveryStatus();

  const autoRecoveryStatus = recoveryStatus.canAutoRecover ? 'pass' : 'warn';
  const autoRecoveryMessage = recoveryStatus.canAutoRecover ? 'Available' : 'Manual intervention may be needed';

  displaySingleCheck('Auto Recovery', { status: autoRecoveryStatus, message: autoRecoveryMessage });
  results.checks.push({
    name: 'Auto Recovery',
    status: autoRecoveryStatus,
    details: recoveryStatus
  });

  console.log();
}

/**
 * Check network connectivity
 */
async function checkNetworkConnectivity(results) {
  console.log(`${colors.bold}Network Connectivity${colors.reset}`);

  const endpoints = [
    { name: 'Claude API', url: 'https://console.anthropic.com' },
    { name: 'OpenAI API', url: 'https://api.openai.com' }
  ];

  for (const endpoint of endpoints) {
    const connectCheck = await checkConnection(endpoint.url);
    const status = connectCheck.success ? 'pass' : 'fail';
    const message = connectCheck.success ? `${connectCheck.responseTime}ms` : connectCheck.error;

    displaySingleCheck(endpoint.name, { status, message });
    results.checks.push({
      name: `${endpoint.name} Connectivity`,
      status,
      details: connectCheck
    });
  }

  console.log();
}

/**
 * Simple connection check
 */
async function checkConnection(url) {
  return new Promise(resolve => {
    const startTime = Date.now();

    try {
      const https = require('https');
      const req = https.request(url, { timeout: 5000 }, (res) => {
        resolve({
          success: true,
          responseTime: Date.now() - startTime,
          statusCode: res.statusCode
        });
        req.destroy();
      });

      req.on('error', (error) => {
        resolve({
          success: false,
          error: error.code || error.message,
          responseTime: Date.now() - startTime
        });
      });

      req.on('timeout', () => {
        resolve({
          success: false,
          error: 'Timeout',
          responseTime: Date.now() - startTime
        });
        req.destroy();
      });

      req.end();
    } catch (error) {
      resolve({
        success: false,
        error: error.message,
        responseTime: Date.now() - startTime
      });
    }
  });
}

/**
 * Check performance metrics
 */
async function checkPerformance(results) {
  console.log(`${colors.bold}Performance${colors.reset}`);

  // Memory usage
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const memStatus = heapMB < 50 ? 'pass' : heapMB < 100 ? 'warn' : 'fail';
  const memMessage = `${heapMB}MB heap`;

  displaySingleCheck('Memory Usage', { status: memStatus, message: memMessage });
  results.checks.push({
    name: 'Memory Usage',
    status: memStatus,
    details: { heapMB, memUsage }
  });

  // Check for .cortex directory permissions
  const cortexDir = join(process.cwd(), '.cortex');
  const permStatus = await checkDirectoryPermissions(cortexDir);

  displaySingleCheck('File Permissions', { status: permStatus.status, message: permStatus.message });
  results.checks.push({
    name: 'File Permissions',
    status: permStatus.status,
    details: permStatus
  });

  console.log();
}

/**
 * Check directory permissions
 */
async function checkDirectoryPermissions(dir) {
  try {
    if (!existsSync(dir)) {
      return { status: 'pass', message: 'Directory will be created as needed' };
    }

    // Try to create a test file
    const testFile = join(dir, '.test-permissions');
    require('fs').writeFileSync(testFile, 'test');
    require('fs').unlinkSync(testFile);

    return { status: 'pass', message: 'Read/write access confirmed' };
  } catch (error) {
    return {
      status: 'fail',
      message: `Permission denied: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * Display single check result
 */
function displaySingleCheck(name, check) {
  const statusIcon = check.status === 'pass' ? icons.pass :
                    check.status === 'warn' ? icons.warn :
                    check.status === 'fail' ? icons.fail :
                    icons.info;

  const statusColor = check.status === 'pass' ? colors.green :
                     check.status === 'warn' ? colors.yellow :
                     check.status === 'fail' ? colors.red :
                     colors.cyan;

  console.log(`  ${statusIcon} ${colors.bold}${name}:${colors.reset} ${statusColor}${check.message}${colors.reset}`);
}

/**
 * Display comprehensive health results
 */
function displayHealthResults(results) {
  const score = results.overall.score;
  const maxScore = results.overall.maxScore;
  const percentage = Math.round((score / maxScore) * 100);

  console.log(`${colors.bold}${colors.blue}Health Summary${colors.reset}`);
  console.log(`${colors.bold}Score: ${score}/${maxScore} (${percentage}%)${colors.reset}`);

  const overallStatus = results.overall.healthy ?
    `${colors.green}${icons.pass} System is healthy${colors.reset}` :
    `${colors.red}${icons.fail} System needs attention${colors.reset}`;

  console.log(`${colors.bold}Status: ${overallStatus}${colors.reset}\n`);

  // Show recommendations if any
  const allRecommendations = results.checks
    .flatMap(check => check.details?.recommendations || [])
    .filter(Boolean);

  if (allRecommendations.length > 0) {
    console.log(`${colors.bold}${colors.yellow}Recommendations:${colors.reset}`);
    allRecommendations.forEach((rec, index) => {
      console.log(`  ${index + 1}. ${rec.message}`);
      if (rec.action) {
        console.log(`     ${colors.dim}→ ${rec.action}${colors.reset}`);
      }
    });
    console.log();
  }

  // Show critical issues
  const criticalIssues = results.checks.filter(check => check.status === 'fail');
  if (criticalIssues.length > 0) {
    console.log(`${colors.bold}${colors.red}Critical Issues:${colors.reset}`);
    criticalIssues.forEach((issue, index) => {
      console.log(`  ${index + 1}. ${issue.name}: ${issue.details?.message || 'Failed'}`);
    });
    console.log();
  }

  console.log(`${colors.dim}Report generated: ${new Date().toLocaleString()}${colors.reset}`);
}