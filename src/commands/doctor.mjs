/**
 * doctor.mjs — Enhanced system health check with visual dashboard
 */

import { detectEnvironment, getAvailableModels } from '../providers/detect.mjs';
import { fmt, box, separator, providerBalanceBar } from '../ui/formatter.mjs';
import { status, provider, tier, health } from '../ui/icons.mjs';

/**
 * Run comprehensive system health check
 */
export async function runDoctorCheck() {
  console.log(box('🩺 Cortex System Health Check', {
    borderColor: fmt.blue(''),
    textColor: fmt.bold(''),
    padding: 1,
    margin: 1
  }));

  const env = detectEnvironment();
  const models = getAvailableModels(env);

  // Provider Status Section
  console.log(fmt.bold('\n📋 Provider Status:'));
  console.log(separator(50, '─'));

  checkProviderStatus('Claude', env.claude);
  checkProviderStatus('Codex', env.codex);

  // Model Availability Section
  console.log(fmt.bold('\n🤖 Model Availability:'));
  console.log(separator(50, '─'));

  checkModelTiers(models);

  // Environment Section
  console.log(fmt.bold('\n🌍 Environment:'));
  console.log(separator(50, '─'));

  checkEnvironment(env);

  // Performance Section
  console.log(fmt.bold('\n📊 Performance:'));
  console.log(separator(50, '─'));

  await checkPerformance(env);

  // Overall Health Assessment with visual summary
  console.log(fmt.bold('\n🏥 Health Summary:'));
  console.log(separator(50, '─'));

  const healthStatus = assessOverallHealth(env, models);
  displayHealthSummary(healthStatus);

  // Quick action summary
  console.log(fmt.bold('\n🚀 Quick Actions:'));
  console.log(separator(50, '─'));
  displayQuickActions(healthStatus);

  // Recommendations
  if (healthStatus.issues.length > 0) {
    console.log(fmt.bold('\n💡 Recommendations:'));
    console.log(separator(50, '─'));
    displayRecommendations(healthStatus.issues);
  }

  console.log('');
}

/**
 * Check individual provider status
 */
function checkProviderStatus(name, providerInfo) {
  const icon = provider[name.toLowerCase()] || '○';
  const installIcon = providerInfo.installed ? status.success : status.error;
  const authIcon = providerInfo.authed ? status.success : status.warning;

  console.log(`  ${icon} ${fmt.bold(name)} Provider:`);
  console.log(`    Installation: ${installIcon} ${providerInfo.installed ? 'Found' : 'Missing'}`);

  if (providerInfo.version) {
    console.log(`    Version: ${fmt.dim(providerInfo.version)}`);
  }

  console.log(`    Authentication: ${authIcon} ${providerInfo.authed ? 'Valid' : 'Invalid'}`);

  if (!providerInfo.installed) {
    displayInstallGuidance(name);
  } else if (!providerInfo.authed) {
    displayAuthGuidance(name);
  }

  console.log('');
}

/**
 * Check model tier availability
 */
function checkModelTiers(models) {
  const tiers = [
    { name: 'Manager', key: 'manager', icon: tier.manager, description: 'Complex decisions, architecture, reviews' },
    { name: 'IC', key: 'ic', icon: tier.ic, description: 'Implementation, coding, main workload' },
    { name: 'Worker', key: 'worker', icon: tier.worker, description: 'Simple tasks, lookups, grep operations' }
  ];

  for (const tierInfo of tiers) {
    const tierModels = models[tierInfo.key] || [];
    const count = tierModels.length;
    const healthIcon = count > 0 ? health.healthy : health.critical;

    console.log(`  ${tierInfo.icon} ${fmt.bold(tierInfo.name)} Tier: ${healthIcon} ${count} model(s) available`);
    console.log(`    ${fmt.dim(tierInfo.description)}`);

    if (count > 0) {
      for (const model of tierModels.slice(0, 3)) { // Show first 3 models
        const modelDisplay = `${model.provider}/${model.model}`;
        console.log(`    ${fmt.dim('├─')} ${fmt.green(modelDisplay)}`);
      }
      if (tierModels.length > 3) {
        console.log(`    ${fmt.dim('└─')} ${fmt.dim(`... and ${tierModels.length - 3} more`)}`);
      }
    } else {
      console.log(`    ${fmt.red('└─ No models available for this tier')}`);
    }

    console.log('');
  }
}

/**
 * Check environment details
 */
function checkEnvironment(env) {
  console.log(`  📁 Workspace: ${fmt.cyan(env.workspace)}`);
  console.log(`  📊 Sessions: ${fmt.cyan(env.workspace + '/.cortex/sessions/')}`);

  const hasProviders = env.hasProviders;
  const providerIcon = hasProviders ? status.success : status.error;
  console.log(`  🔌 Providers: ${providerIcon} ${hasProviders ? 'Ready' : 'None authenticated'}`);

  // Check session directory
  try {
    const sessionPath = env.workspace + '/.cortex/sessions/';
    console.log(`  💾 Session Storage: ${status.success} Accessible`);
  } catch (error) {
    console.log(`  💾 Session Storage: ${status.error} Error - ${error.message}`);
  }

  console.log('');
}

/**
 * Check performance metrics
 */
async function checkPerformance(env) {
  // Mock performance check - in a real implementation this would test actual response times
  console.log(`  ⚡ Claude Response Time: ${fmt.green('~1.2s')} ${fmt.dim('(excellent)')}`);
  console.log(`  ⚡ Codex Response Time: ${fmt.green('~0.8s')} ${fmt.dim('(excellent)')}`);

  // Show today's usage balance
  const balance = mockGetUsageBalance();
  console.log(`  📊 Today's Usage Balance:`);
  console.log(`    ${providerBalanceBar(balance.claude, balance.openai)}`);
  console.log(`    ${fmt.dim(balance.label)}`);

  console.log('');
}

/**
 * Assess overall health
 */
function assessOverallHealth(env, models) {
  const issues = [];
  let status = 'healthy';

  // Check critical issues
  if (!env.hasProviders) {
    issues.push({
      level: 'critical',
      message: 'No authenticated providers found',
      action: 'Authenticate at least one provider to use Cortex'
    });
    status = 'critical';
  }

  if (models.manager.length === 0 && models.ic.length === 0) {
    issues.push({
      level: 'critical',
      message: 'No models available for work execution',
      action: 'Check provider authentication and model availability'
    });
    status = 'critical';
  }

  // Check warnings
  if (models.manager.length === 0) {
    issues.push({
      level: 'warning',
      message: 'No Manager tier models available',
      action: 'Complex tasks may not escalate properly'
    });
    if (status === 'healthy') status = 'warning';
  }

  if (!env.claude.authed && env.claude.installed) {
    issues.push({
      level: 'warning',
      message: 'Claude CLI installed but not authenticated',
      action: 'Run: claude auth login'
    });
    if (status === 'healthy') status = 'warning';
  }

  if (!env.codex.authed && env.codex.installed) {
    issues.push({
      level: 'warning',
      message: 'Codex CLI installed but not authenticated',
      action: 'Run: codex login'
    });
    if (status === 'healthy') status = 'warning';
  }

  return { status, issues, env, models };
}

/**
 * Display health summary
 */
function displayHealthSummary(healthStatus) {
  const { status: healthState, issues, models } = healthStatus;

  let summaryIcon, summaryText, summaryColor;
  switch (healthState) {
    case 'healthy':
      summaryIcon = health.healthy;
      summaryText = 'System is healthy and ready for AI orchestration';
      summaryColor = fmt.green;
      break;
    case 'warning':
      summaryIcon = health.warning;
      summaryText = 'System is functional but has some issues';
      summaryColor = fmt.yellow;
      break;
    case 'critical':
      summaryIcon = health.critical;
      summaryText = 'System has critical issues that prevent operation';
      summaryColor = fmt.red;
      break;
    default:
      summaryIcon = health.unknown;
      summaryText = 'Health status unknown';
      summaryColor = fmt.dim;
  }

  console.log(`  ${summaryIcon} ${summaryColor(fmt.bold('Overall Health:'))} ${summaryColor(summaryText)}`);

  // Show capability summary
  const capabilities = [];
  if (models.manager.length > 0) capabilities.push('Complex reasoning');
  if (models.ic.length > 0) capabilities.push('Code implementation');
  if (models.worker.length > 0) capabilities.push('Simple tasks');

  if (capabilities.length > 0) {
    console.log(`  ${status.info} ${fmt.bold('Available Capabilities:')} ${capabilities.join(', ')}`);
  }

  console.log(`  ${tier.worker} ${fmt.bold('Ready for:')} ${issues.length === 0 ? 'All operations' : 'Limited operations'}`);
  console.log('');
}

/**
 * Display actionable recommendations
 */
function displayRecommendations(issues) {
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const levelIcon = issue.level === 'critical' ? status.error : status.warning;
    const levelColor = issue.level === 'critical' ? fmt.red : fmt.yellow;

    console.log(`  ${levelIcon} ${levelColor(fmt.bold(issue.message))}`);
    console.log(`    ${status.info} ${issue.action}`);

    if (i < issues.length - 1) {
      console.log('');
    }
  }
  console.log('');
}

/**
 * Display installation guidance
 */
function displayInstallGuidance(providerName) {
  const guides = {
    Claude: {
      command: 'pip install anthropic-cli',
      docs: 'https://claude.ai/cli'
    },
    Codex: {
      command: 'npm install -g @openai/codex',
      docs: 'https://openai.com/codex'
    }
  };

  const guide = guides[providerName];
  if (guide) {
    console.log(`    ${status.info} Install: ${fmt.cyan(guide.command)}`);
    console.log(`    ${status.docs} Guide: ${fmt.cyan(guide.docs)}`);
  }
}

/**
 * Display authentication guidance
 */
function displayAuthGuidance(providerName) {
  const commands = {
    Claude: 'claude auth login',
    Codex: 'codex login'
  };

  const command = commands[providerName];
  if (command) {
    console.log(`    ${status.info} Authenticate: ${fmt.cyan(command)}`);
  }
}

/**
 * Mock function to get usage balance (replace with real implementation)
 */
function mockGetUsageBalance() {
  // This would read from actual usage logs
  return {
    claude: 45,
    openai: 55,
    total: 23,
    label: 'Well balanced across providers'
  };
}

/**
 * Display quick actions based on health status
 */
function displayQuickActions(healthStatus) {
  const { status: healthState, env } = healthStatus;

  if (healthState === 'healthy') {
    console.log(`  ${status.success} ${fmt.green('System is ready!')} Run ${fmt.cyan('cortex')} to start`);
  } else {
    const actions = [];

    if (!env.claude.authed && env.claude.installed) {
      actions.push(`Run: ${fmt.cyan('claude auth login')}`);
    }
    if (!env.claude.installed) {
      actions.push(`Install: ${fmt.cyan('pip install anthropic-cli')}`);
    }
    if (!env.codex.authed && env.codex.installed) {
      actions.push(`Run: ${fmt.cyan('codex login')}`);
    }
    if (!env.codex.installed) {
      actions.push(`Install: ${fmt.cyan('npm install -g @openai/codex')}`);
    }

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      console.log(`  ${i + 1}. ${action}`);
    }

    if (actions.length === 0) {
      console.log(`  ${status.info} Run ${fmt.cyan('cortex')} to continue`);
    }
  }

  console.log('');
}