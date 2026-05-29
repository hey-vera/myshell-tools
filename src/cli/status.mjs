/**
 * status.mjs — Current session and system status display
 */

import { detectEnvironment, getAvailableModels } from '../providers/detect.mjs';
import { getSessionSummary, loadSession } from '../state/session.mjs';
import { getRecoveryStatus, getPlans } from '../state/recovery.mjs';
import { getStorageStats } from '../state/cleanup.mjs';
import { listArchives } from '../state/archive.mjs';
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
  healthy: '✅',
  warning: '⚠️ ',
  error: '❌',
  info: 'ℹ️ ',
  active: '🟢',
  inactive: '⚪',
  working: '🔄',
  archive: '📦'
};

/**
 * Display comprehensive status information
 */
export function displayStatus(workspace = process.cwd(), options = {}) {
  const { verbose = false, format = 'table' } = options;

  console.log(`${colors.bold}${colors.blue}📊 Cortex Status Report${colors.reset}\n`);

  const statusData = gatherStatusData(workspace);

  if (format === 'json') {
    console.log(JSON.stringify(statusData, null, 2));
    return statusData;
  }

  // Display in human-readable format
  displaySystemStatus(statusData.system);
  displaySessionStatus(statusData.session);
  displayProviderStatus(statusData.providers);
  displayWorkStatus(statusData.work);
  displayStorageStatus(statusData.storage);

  if (verbose) {
    displayDetailedStatus(statusData);
  }

  return statusData;
}

/**
 * Gather all status information
 */
function gatherStatusData(workspace) {
  const env = detectEnvironment();
  const models = getAvailableModels(env);
  const sessionSummary = getSessionSummary(workspace);
  const recoveryStatus = getRecoveryStatus(workspace);
  const storageStats = getStorageStats(workspace);
  const refreshState = loadRefreshState();
  const archives = listArchives(workspace);
  const plans = getPlans(null, workspace);

  return {
    timestamp: new Date().toISOString(),
    workspace,
    system: {
      environment: env,
      models,
      healthy: env.hasProviders && models.manager.length > 0
    },
    session: {
      summary: sessionSummary,
      active: sessionSummary.messageCount > 0,
      lastActivity: sessionSummary.lastMessage?.timestamp || null
    },
    providers: {
      claude: {
        installed: env.claude.installed,
        authenticated: env.claude.authed,
        version: env.claude.version,
        models: env.claude.models
      },
      codex: {
        installed: env.codex.installed,
        authenticated: env.codex.authed,
        path: env.codex.path,
        models: env.codex.models
      }
    },
    auth: {
      refreshState,
      lastRefresh: refreshState?.lastRefresh || null,
      nextRefreshDue: refreshState?.nextRefreshDue || null
    },
    work: {
      plans: plans.length,
      interrupted: recoveryStatus.hasInterruptedWork,
      interruptedCount: recoveryStatus.interruptedCount,
      canRecover: recoveryStatus.canAutoRecover
    },
    storage: {
      stats: storageStats,
      archives: archives.length,
      totalSize: storageStats.totalSize,
      breakdown: storageStats.breakdown
    }
  };
}

/**
 * Display system status
 */
function displaySystemStatus(system) {
  console.log(`${colors.bold}System${colors.reset}`);

  // Overall health
  const healthIcon = system.healthy ? icons.healthy : icons.error;
  const healthStatus = system.healthy ? `${colors.green}Healthy${colors.reset}` : `${colors.red}Needs Attention${colors.reset}`;
  console.log(`  ${healthIcon} Status: ${healthStatus}`);

  // Model tiers
  const tierCounts = {
    manager: system.models.manager.length,
    ic: system.models.ic.length,
    worker: system.models.worker.length
  };

  console.log(`  🏗️  Model Tiers: M:${tierCounts.manager} IC:${tierCounts.ic} W:${tierCounts.worker}`);

  // Platform info
  console.log(`  💻 Platform: ${process.platform}/${process.arch}, Node ${process.version}`);
  console.log();
}

/**
 * Display session status
 */
function displaySessionStatus(session) {
  console.log(`${colors.bold}Current Session${colors.reset}`);

  if (session.active) {
    const duration = session.summary.duration ?
      formatDuration(session.summary.duration) : 'unknown';

    console.log(`  ${icons.active} Active session with ${session.summary.messageCount} messages`);
    console.log(`  💬 Messages: ${session.summary.userMessageCount} user, ${session.summary.assistantMessageCount} assistant`);
    console.log(`  ⏱️  Duration: ${duration}`);

    if (session.lastActivity) {
      const lastTime = new Date(session.lastActivity).toLocaleTimeString();
      console.log(`  🕐 Last activity: ${lastTime}`);
    }
  } else {
    console.log(`  ${icons.inactive} No active session`);
  }

  console.log();
}

/**
 * Display provider status
 */
function displayProviderStatus(providers) {
  console.log(`${colors.bold}Providers${colors.reset}`);

  // Claude status
  const claudeIcon = providers.claude.authenticated ? icons.healthy :
                    providers.claude.installed ? icons.warning : icons.error;
  const claudeStatus = providers.claude.authenticated ? 'Authenticated' :
                      providers.claude.installed ? 'Not authenticated' : 'Not installed';
  const claudeColor = providers.claude.authenticated ? colors.green :
                     providers.claude.installed ? colors.yellow : colors.red;

  console.log(`  ${claudeIcon} Claude: ${claudeColor}${claudeStatus}${colors.reset}`);
  if (providers.claude.version) {
    console.log(`    ${colors.dim}Version: ${providers.claude.version}${colors.reset}`);
  }

  // Codex status
  const codexIcon = providers.codex.authenticated ? icons.healthy :
                   providers.codex.installed ? icons.warning : icons.error;
  const codexStatus = providers.codex.authenticated ? 'Authenticated' :
                     providers.codex.installed ? 'Not authenticated' : 'Not installed';
  const codexColor = providers.codex.authenticated ? colors.green :
                    providers.codex.installed ? colors.yellow : colors.red;

  console.log(`  ${codexIcon} Codex: ${codexColor}${codexStatus}${colors.reset}`);
  if (providers.codex.path) {
    console.log(`    ${colors.dim}Path: ${providers.codex.path}${colors.reset}`);
  }

  console.log();
}

/**
 * Display work status
 */
function displayWorkStatus(work) {
  console.log(`${colors.bold}Work State${colors.reset}`);

  if (work.interrupted) {
    console.log(`  ${icons.warning} ${work.interruptedCount} interrupted session(s)`);
    const recoverStatus = work.canRecover ? 'automatic' : 'manual intervention needed';
    console.log(`  🔄 Recovery: ${recoverStatus}`);
  } else {
    console.log(`  ${icons.healthy} No interrupted work`);
  }

  if (work.plans > 0) {
    console.log(`  📋 Plans: ${work.plans} total`);
  }

  console.log();
}

/**
 * Display storage status
 */
function displayStorageStatus(storage) {
  console.log(`${colors.bold}Storage${colors.reset}`);

  const totalMB = Math.round(storage.totalSize / 1024 / 1024);
  const storageColor = totalMB < 50 ? colors.green :
                      totalMB < 200 ? colors.yellow : colors.red;

  console.log(`  💾 Total: ${storageColor}${totalMB}MB${colors.reset}`);

  // Breakdown
  if (storage.breakdown.sessions > 0) {
    const sessionsMB = Math.round(storage.breakdown.sessions / 1024 / 1024);
    console.log(`    Sessions: ${sessionsMB}MB`);
  }

  if (storage.breakdown.archives > 0) {
    const archivesMB = Math.round(storage.breakdown.archives / 1024 / 1024);
    console.log(`    ${icons.archive} Archives: ${archivesMB}MB (${storage.archives} files)`);
  }

  console.log();
}

/**
 * Display detailed status (verbose mode)
 */
function displayDetailedStatus(statusData) {
  console.log(`${colors.bold}${colors.cyan}Detailed Information${colors.reset}\n`);

  // Authentication details
  if (statusData.auth.refreshState) {
    console.log(`${colors.bold}Authentication${colors.reset}`);
    const lastRefresh = statusData.auth.lastRefresh ?
      new Date(statusData.auth.lastRefresh).toLocaleString() : 'Never';
    console.log(`  Last token refresh: ${lastRefresh}`);

    if (statusData.auth.nextRefreshDue) {
      const nextRefresh = new Date(statusData.auth.nextRefreshDue).toLocaleString();
      console.log(`  Next refresh due: ${nextRefresh}`);
    }
    console.log();
  }

  // Recent session activity
  if (statusData.session.active) {
    console.log(`${colors.bold}Recent Activity${colors.reset}`);
    const recentMessages = loadSession().slice(-5); // Last 5 messages

    recentMessages.forEach((msg, index) => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const role = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️ ';
      const preview = msg.content.length > 50 ?
        msg.content.substring(0, 50) + '...' : msg.content;

      console.log(`  ${role} ${colors.dim}${time}${colors.reset} ${preview}`);
    });
    console.log();
  }

  // Storage breakdown
  console.log(`${colors.bold}Storage Breakdown${colors.reset}`);
  Object.entries(statusData.storage.breakdown).forEach(([category, size]) => {
    if (size > 0) {
      const sizeMB = (size / 1024 / 1024).toFixed(1);
      const percentage = ((size / statusData.storage.totalSize) * 100).toFixed(1);
      console.log(`  ${category}: ${sizeMB}MB (${percentage}%)`);
    }
  });
  console.log();

  // Model availability
  console.log(`${colors.bold}Available Models${colors.reset}`);
  ['manager', 'ic', 'worker'].forEach(tier => {
    const models = statusData.system.models[tier];
    if (models.length > 0) {
      console.log(`  ${tier.toUpperCase()}:`);
      models.forEach(model => {
        console.log(`    ${model.provider}/${model.model}`);
      });
    } else {
      console.log(`  ${tier.toUpperCase()}: ${colors.red}None available${colors.reset}`);
    }
  });
  console.log();
}

/**
 * Get quick status summary for other commands
 */
export function getQuickStatus(workspace = process.cwd()) {
  const env = detectEnvironment();
  const sessionSummary = getSessionSummary(workspace);

  return {
    healthy: env.hasProviders,
    activeSession: sessionSummary.messageCount > 0,
    providers: {
      claude: env.claude.authed,
      codex: env.codex.authed
    },
    lastActivity: sessionSummary.lastMessage?.timestamp || null
  };
}

/**
 * Display status bar (compact format)
 */
export function displayStatusBar(workspace = process.cwd()) {
  const status = getQuickStatus(workspace);

  const healthIcon = status.healthy ? '🟢' : '🔴';
  const sessionIcon = status.activeSession ? '💬' : '💤';

  const providerStatus = [];
  if (status.providers.claude) providerStatus.push('C');
  if (status.providers.codex) providerStatus.push('O');

  const providerStr = providerStatus.length > 0 ?
    providerStatus.join('') : 'None';

  console.log(`${healthIcon} ${sessionIcon} [${providerStr}]`);
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}