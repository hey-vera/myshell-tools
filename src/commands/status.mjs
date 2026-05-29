/**
 * status.mjs — Live session metrics and system status display
 */

import { getSessionSummary } from '../state/session.mjs';
import { detectEnvironment } from '../providers/detect.mjs';
import { fmt, box, separator, formatDuration, timeAgo, providerBalanceBar } from '../ui/formatter.mjs';
import { status, tier, session as sessionIcons, provider } from '../ui/icons.mjs';

/**
 * Display comprehensive system status
 */
export function displayStatus(workingDir, options = {}) {
  const { verbose = false } = options;

  console.log(box('Cortex Status Dashboard', {
    borderColor: fmt.blue(''),
    padding: 1,
    margin: 1
  }));

  // Current Session
  displayCurrentSession();

  // System Status
  displaySystemStatus();

  // Provider Status
  displayProviderStatus();

  // Performance Metrics
  displayPerformanceMetrics();

  if (verbose) {
    // Detailed Information
    displayDetailedInfo(workingDir);
  }

  // Quick Actions
  displayQuickActions();

  console.log('');
}

/**
 * Get quick status for minimal display
 */
export function getQuickStatus() {
  const sessionSummary = getSessionSummary();
  const env = detectEnvironment();

  const activeSession = sessionSummary.messageCount > 0;
  const sessionIcon = activeSession ? sessionIcons.active : sessionIcons.new;
  const providerCount = (env.claude.authed ? 1 : 0) + (env.codex.authed ? 1 : 0);

  return {
    session: {
      active: activeSession,
      messageCount: sessionSummary.messageCount,
      duration: sessionSummary.duration || 0
    },
    providers: {
      count: providerCount,
      claude: env.claude.authed,
      codex: env.codex.authed
    },
    status: providerCount > 0 ? 'ready' : 'needs_auth'
  };
}

/**
 * Display current session information
 */
function displayCurrentSession() {
  const sessionSummary = getSessionSummary();

  console.log(fmt.bold('\n💬 Current Session:'));
  console.log(separator(50, '─'));

  if (sessionSummary.messageCount === 0) {
    console.log(`  ${sessionIcons.new} ${fmt.dim('No active session')}`);
    console.log(`  ${status.info} Start chatting to begin a new session`);
  } else {
    const sessionStatus = sessionIcons.active;
    const duration = sessionSummary.duration ? formatDuration(sessionSummary.duration) : 'Unknown';
    const lastActivity = sessionSummary.lastMessage
      ? timeAgo(sessionSummary.lastMessage.timestamp)
      : 'Unknown';

    console.log(`  ${sessionStatus} ${fmt.bold('Active Session')}`);
    console.log(`    Messages: ${fmt.cyan(sessionSummary.messageCount)} (${sessionSummary.userMessageCount} user, ${sessionSummary.assistantMessageCount} assistant)`);
    console.log(`    Duration: ${fmt.cyan(duration)}`);
    console.log(`    Last Activity: ${fmt.cyan(lastActivity)}`);

    // Show recent activity
    if (sessionSummary.lastMessage) {
      const preview = sessionSummary.lastMessage.content.slice(0, 60);
      const truncated = sessionSummary.lastMessage.content.length > 60 ? '...' : '';
      console.log(`    Last Message: ${fmt.dim(`"${preview}${truncated}"`)}`);
    }
  }

  console.log('');
}

/**
 * Display system status overview
 */
function displaySystemStatus() {
  const env = detectEnvironment();
  const quickStatus = getQuickStatus();

  console.log(fmt.bold('\n🏥 System Status:'));
  console.log(separator(50, '─'));

  // Overall health
  let healthIcon, healthText;
  switch (quickStatus.status) {
    case 'ready':
      healthIcon = status.success;
      healthText = fmt.green('Operational');
      break;
    case 'needs_auth':
      healthIcon = status.warning;
      healthText = fmt.yellow('Needs Authentication');
      break;
    default:
      healthIcon = status.error;
      healthText = fmt.red('Unknown');
  }

  console.log(`  ${healthIcon} Health: ${healthText}`);
  console.log(`  📁 Workspace: ${fmt.cyan(env.workspace)}`);
  console.log(`  🔌 Providers: ${quickStatus.providers.count}/2 authenticated`);

  console.log('');
}

/**
 * Display provider status with details
 */
function displayProviderStatus() {
  const env = detectEnvironment();

  console.log(fmt.bold('\n🤝 Providers:'));
  console.log(separator(50, '─'));

  // Claude status
  const claudeIcon = provider.claude;
  const claudeStatus = env.claude.authed ? status.success : env.claude.installed ? status.warning : status.error;
  const claudeText = env.claude.authed ? 'Ready' : env.claude.installed ? 'Not authenticated' : 'Not installed';

  console.log(`  ${claudeIcon} Claude: ${claudeStatus} ${claudeText}`);

  if (env.claude.version) {
    console.log(`    Version: ${fmt.dim(env.claude.version)}`);
  }

  if (env.claude.authed) {
    console.log(`    Models: ${fmt.green('Opus, Sonnet, Haiku')}`);
  } else if (env.claude.installed) {
    console.log(`    ${status.info} Run: ${fmt.cyan('claude auth login')}`);
  } else {
    console.log(`    ${status.info} Install: ${fmt.cyan('pip install anthropic-cli')}`);
  }

  // Codex status
  const codexIcon = provider.codex;
  const codexStatus = env.codex.authed ? status.success : env.codex.installed ? status.warning : status.error;
  const codexText = env.codex.authed ? 'Ready' : env.codex.installed ? 'Not authenticated' : 'Not installed';

  console.log(`  ${codexIcon} Codex: ${codexStatus} ${codexText}`);

  if (env.codex.version) {
    console.log(`    Version: ${fmt.dim(env.codex.version)}`);
  }

  if (env.codex.authed) {
    console.log(`    Models: ${fmt.green('GPT-5.5, GPT-5.4, GPT-4.1-mini')}`);
  } else if (env.codex.installed) {
    console.log(`    ${status.info} Run: ${fmt.cyan('codex login')}`);
  } else {
    console.log(`    ${status.info} Install: ${fmt.cyan('npm install -g @openai/codex')}`);
  }

  // Usage balance
  const balance = mockGetTodaysBalance(); // Replace with real implementation
  if (balance.total > 0) {
    console.log(`\n  📊 Today's Usage Balance:`);
    console.log(`    ${providerBalanceBar(balance.claude, balance.openai)}`);
    console.log(`    ${fmt.dim(balance.label + ' • ' + balance.total + ' calls')}`);
  }

  console.log('');
}

/**
 * Display performance metrics
 */
function displayPerformanceMetrics() {
  console.log(fmt.bold('\n📈 Performance:'));
  console.log(separator(50, '─'));

  // Mock performance data - replace with real metrics
  const metrics = mockGetPerformanceMetrics();

  console.log(`  ⚡ Average Response Time: ${fmt.green(metrics.avgResponseTime)}`);
  console.log(`  🎯 Success Rate: ${fmt.green(metrics.successRate)}`);
  console.log(`  🔄 Escalation Rate: ${fmt.yellow(metrics.escalationRate)}`);

  if (metrics.tokensToday > 0) {
    console.log(`  🔢 Tokens Today: ${fmt.cyan(metrics.tokensToday.toLocaleString())}`);
  }

  if (metrics.costToday > 0) {
    console.log(`  💰 Estimated Cost Today: ${fmt.cyan('$' + metrics.costToday.toFixed(2))}`);
  }

  console.log('');
}

/**
 * Display detailed information (verbose mode)
 */
function displayDetailedInfo(workingDir) {
  console.log(fmt.bold('\n🔍 Detailed Information:'));
  console.log(separator(50, '─'));

  // Session directory details
  const sessionPath = `${workingDir}/.cortex/sessions/`;
  console.log(`  📂 Session Directory: ${fmt.cyan(sessionPath)}`);

  try {
    // Mock file count - replace with real directory reading
    const fileCount = 12; // Mock count
    const totalSize = '2.3MB'; // Mock size
    console.log(`    Files: ${fmt.dim(fileCount)} session files`);
    console.log(`    Size: ${fmt.dim(totalSize)} total`);
  } catch (error) {
    console.log(`    ${status.error} Error reading directory: ${error.message}`);
  }

  // Configuration status
  console.log(`  ⚙️ Configuration:`);
  console.log(`    Timeout: ${fmt.dim('120 seconds')}`);
  console.log(`    Auto-escalation: ${fmt.green('Enabled')}`);
  console.log(`    Session archiving: ${fmt.green('Enabled')}`);

  // Recent activity
  console.log(`  📋 Recent Activity:`);
  const recentSessions = mockGetRecentSessions(); // Replace with real data

  if (recentSessions.length === 0) {
    console.log(`    ${fmt.dim('No recent sessions')}`);
  } else {
    recentSessions.slice(0, 3).forEach((session, index) => {
      const timeDisplay = timeAgo(session.timestamp);
      const preview = session.preview.slice(0, 30);
      console.log(`    ${fmt.dim(`${index + 1}.`)} ${timeDisplay} - ${fmt.dim(`"${preview}..."`)}`);
    });
  }

  console.log('');
}

/**
 * Display available quick actions
 */
function displayQuickActions() {
  console.log(fmt.bold('\n⚡ Quick Actions:'));
  console.log(separator(50, '─'));

  console.log(`  ${fmt.cyan('cortex --doctor')}     Run full health check`);
  console.log(`  ${fmt.cyan('cortex --reset')}      Reset session state`);
  console.log(`  ${fmt.cyan('cortex --cleanup')}    Clean up old files`);
  console.log(`  ${fmt.cyan('cortex --help')}       Show all commands`);

  const quickStatus = getQuickStatus();
  if (quickStatus.status === 'needs_auth') {
    console.log(`\n  ${status.warning} ${fmt.yellow('Authentication needed to start chatting')}`);
  } else if (!quickStatus.session.active) {
    console.log(`\n  ${status.info} ${fmt.green('Ready to start chatting!')}`);
  }

  console.log('');
}

/**
 * Mock function for today's usage balance
 */
function mockGetTodaysBalance() {
  return {
    claude: 35,
    openai: 65,
    total: 18,
    label: 'GPT-heavy — Claude has capacity'
  };
}

/**
 * Mock function for performance metrics
 */
function mockGetPerformanceMetrics() {
  return {
    avgResponseTime: '1.4s',
    successRate: '94.2%',
    escalationRate: '12.5%',
    tokensToday: 45_230,
    costToday: 3.42
  };
}

/**
 * Mock function for recent sessions
 */
function mockGetRecentSessions() {
  return [
    {
      timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      preview: 'Fix the authentication bug in the login flow'
    },
    {
      timestamp: Date.now() - 5 * 60 * 60 * 1000, // 5 hours ago
      preview: 'Add error handling to the API endpoints'
    },
    {
      timestamp: Date.now() - 12 * 60 * 60 * 1000, // 12 hours ago
      preview: 'Implement user dashboard components'
    }
  ];
}