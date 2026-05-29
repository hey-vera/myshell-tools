/**
 * recovery.mjs — Authentication failure recovery with helpful guidance
 */

import { spawnSync } from 'child_process';
import { backgroundRefresh, displayRefreshStatus } from './refresh.mjs';

/**
 * Check if a provider CLI is installed
 */
function isCliInstalled(command) {
  try {
    const result = spawnSync('which', [command], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect OS for platform-specific installation guidance
 */
function detectOS() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') {
    // Try to detect specific Linux distribution
    try {
      const result = spawnSync('cat', ['/etc/os-release'], {
        encoding: 'utf8',
        stdio: 'pipe'
      });
      if (result.status === 0) {
        if (result.stdout.includes('Ubuntu')) return 'Ubuntu';
        if (result.stdout.includes('Debian')) return 'Debian';
        if (result.stdout.includes('CentOS') || result.stdout.includes('Red Hat')) return 'RHEL/CentOS';
      }
    } catch {}
    return 'Linux';
  }

  return platform;
}

/**
 * Provide installation guidance for missing CLIs
 */
export function provideCLIInstallationGuidance(provider) {
  const os = detectOS();

  console.log(`\n❌ ${provider.toUpperCase()} CLI not found`);
  console.log(`📦 Installation Instructions for ${os}:`);

  if (provider === 'claude') {
    switch (os) {
      case 'macOS':
        console.log('  # Option 1: Using pip');
        console.log('  pip install anthropic-cli');
        console.log('\n  # Option 2: Using Homebrew (if available)');
        console.log('  brew install anthropic-cli');
        break;

      case 'Ubuntu':
      case 'Debian':
        console.log('  # Install pip if not available');
        console.log('  sudo apt update && sudo apt install python3-pip');
        console.log('\n  # Install Claude CLI');
        console.log('  pip3 install anthropic-cli');
        break;

      case 'RHEL/CentOS':
        console.log('  # Install pip if not available');
        console.log('  sudo yum install python3-pip');
        console.log('\n  # Install Claude CLI');
        console.log('  pip3 install anthropic-cli');
        break;

      case 'Windows':
        console.log('  # Install via pip (requires Python)');
        console.log('  pip install anthropic-cli');
        console.log('\n  # Or download from: https://claude.ai/cli');
        break;

      default:
        console.log('  pip install anthropic-cli');
        break;
    }

    console.log('\n🔐 After installation, authenticate:');
    console.log('  claude auth login');

  } else if (provider === 'codex') {
    switch (os) {
      case 'macOS':
        console.log('  # Using npm (recommended)');
        console.log('  npm install -g @openai/codex');
        console.log('\n  # Or using Homebrew');
        console.log('  brew install openai-codex');
        break;

      case 'Ubuntu':
      case 'Debian':
        console.log('  # Install Node.js if not available');
        console.log('  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -');
        console.log('  sudo apt-get install -y nodejs');
        console.log('\n  # Install Codex CLI');
        console.log('  sudo npm install -g @openai/codex');
        break;

      case 'RHEL/CentOS':
        console.log('  # Install Node.js if not available');
        console.log('  curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -');
        console.log('  sudo yum install nodejs npm');
        console.log('\n  # Install Codex CLI');
        console.log('  sudo npm install -g @openai/codex');
        break;

      case 'Windows':
        console.log('  # Install via npm (requires Node.js)');
        console.log('  npm install -g @openai/codex');
        console.log('\n  # Or download from: https://platform.openai.com/docs/tools/codex-cli');
        break;

      default:
        console.log('  npm install -g @openai/codex');
        break;
    }

    console.log('\n🔐 After installation, authenticate:');
    console.log('  codex login');
  }

  console.log('\n💡 You need at least one authenticated CLI to use Cortex.');
  console.log('   Both CLIs enable different model tiers and redundancy.');
}

/**
 * Provide authentication guidance for installed but unauth'd CLIs
 */
export function provideAuthGuidance(provider) {
  console.log(`\n⚠️  ${provider.toUpperCase()} CLI found but not authenticated`);

  if (provider === 'claude') {
    console.log('🔐 Authenticate Claude CLI:');
    console.log('  claude auth login');
    console.log('\n💡 This will open a browser to sign in to your Claude account.');
    console.log('   If running on a server, use: claude auth login --no-browser');

  } else if (provider === 'codex') {
    console.log('🔐 Authenticate Codex CLI:');
    console.log('  codex login');
    console.log('\n💡 This will prompt for your OpenAI API key.');
    console.log('   Get your key from: https://platform.openai.com/api-keys');
  }

  console.log('\n🔄 After authentication, restart Cortex to refresh provider status.');
}

/**
 * Handle authentication failures during operation
 */
export async function handleAuthFailure(provider, error) {
  console.log(`\n🔴 Authentication failed for ${provider.toUpperCase()}`);
  console.log(`   Error: ${error}`);

  // Try to refresh tokens first
  console.log('\n🔄 Attempting token refresh...');
  const refreshResult = await backgroundRefresh();

  if (refreshResult.success && !refreshResult.needReauth.includes(provider)) {
    console.log('✅ Token refresh successful! Please retry your request.');
    return { recovered: true, action: 'retry' };
  }

  // If refresh failed or this provider needs reauth
  console.log('❌ Token refresh failed or expired. Re-authentication required.');

  if (provider === 'claude') {
    console.log('\n🔐 Re-authenticate Claude CLI:');
    console.log('  claude auth login');

    // Check if it's a subscription issue
    if (error.includes('subscription') || error.includes('billing')) {
      console.log('\n💳 Possible subscription issue detected.');
      console.log('   Check your Claude Pro subscription at: https://claude.ai/settings');
    }

  } else if (provider === 'codex' || provider === 'openai') {
    console.log('\n🔐 Re-authenticate Codex CLI:');
    console.log('  codex login');

    // Check if it's an API quota/billing issue
    if (error.includes('quota') || error.includes('billing') || error.includes('insufficient')) {
      console.log('\n💳 Possible API quota/billing issue detected.');
      console.log('   Check your OpenAI account at: https://platform.openai.com/usage');
    }
  }

  return { recovered: false, action: 'reauth_required' };
}

/**
 * Comprehensive provider health check
 */
export async function checkProviderHealth(environment) {
  const health = {
    claude: { healthy: false, issues: [] },
    codex: { healthy: false, issues: [] },
    overall: { healthy: false, availableProviders: 0 }
  };

  // Check Claude
  if (!environment.claude.installed) {
    health.claude.issues.push('CLI not installed');
  } else if (!environment.claude.authed) {
    health.claude.issues.push('Not authenticated');
  } else {
    health.claude.healthy = true;
    health.overall.availableProviders++;
  }

  // Check Codex
  if (!environment.codex.installed) {
    health.codex.issues.push('CLI not installed');
  } else if (!environment.codex.authed) {
    health.codex.issues.push('Not authenticated');
  } else {
    health.codex.healthy = true;
    health.overall.availableProviders++;
  }

  health.overall.healthy = health.overall.availableProviders > 0;

  return health;
}

/**
 * Auto-recovery sequence with user guidance
 */
export async function autoRecovery(environment) {
  console.log('🔧 Running auto-recovery sequence...\n');

  const health = await checkProviderHealth(environment);

  // Try token refresh first if we have any auth'd providers
  if (health.overall.availableProviders > 0) {
    console.log('🔄 Refreshing authentication tokens...');
    const refreshResult = await backgroundRefresh();
    displayRefreshStatus(refreshResult);

    if (refreshResult.success && refreshResult.refreshed.length > 0) {
      console.log('✅ Some tokens refreshed successfully.');
      return { recovered: true, action: 'tokens_refreshed' };
    }
  }

  // Provide guidance for missing/unauth'd providers
  if (!health.claude.healthy) {
    if (health.claude.issues.includes('CLI not installed')) {
      provideCLIInstallationGuidance('claude');
    } else if (health.claude.issues.includes('Not authenticated')) {
      provideAuthGuidance('claude');
    }
  }

  if (!health.codex.healthy) {
    if (health.codex.issues.includes('CLI not installed')) {
      provideCLIInstallationGuidance('codex');
    } else if (health.codex.issues.includes('Not authenticated')) {
      provideAuthGuidance('codex');
    }
  }

  // Final status
  if (health.overall.healthy) {
    console.log('\n✅ At least one provider is healthy. Cortex can continue.');
    return { recovered: true, action: 'partial_recovery' };
  } else {
    console.log('\n❌ No healthy providers available. Please follow the guidance above.');
    return { recovered: false, action: 'manual_intervention_required' };
  }
}

/**
 * Recovery suggestions based on error type
 */
export function getRecoverySuggestions(error) {
  const errorString = error.toString().toLowerCase();
  const suggestions = [];

  if (errorString.includes('enoent') || errorString.includes('command not found')) {
    suggestions.push('CLI tool not installed or not in PATH');
    suggestions.push('Check installation instructions above');
  }

  if (errorString.includes('authentication') || errorString.includes('unauthorized') || errorString.includes('401')) {
    suggestions.push('Authentication failed or expired');
    suggestions.push('Try re-authenticating with the CLI');
  }

  if (errorString.includes('timeout') || errorString.includes('network') || errorString.includes('enotfound')) {
    suggestions.push('Network connectivity issue');
    suggestions.push('Check internet connection and try again');
  }

  if (errorString.includes('rate limit') || errorString.includes('429')) {
    suggestions.push('API rate limit exceeded');
    suggestions.push('Wait a few minutes before retrying');
  }

  if (errorString.includes('quota') || errorString.includes('billing') || errorString.includes('subscription')) {
    suggestions.push('Account/billing issue detected');
    suggestions.push('Check your account status and subscription');
  }

  if (suggestions.length === 0) {
    suggestions.push('Unknown error occurred');
    suggestions.push('Try running with --doctor for more details');
  }

  return suggestions;
}