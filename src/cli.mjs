#!/usr/bin/env node

/**
 * cli.mjs — NPX Cortex main entry point
 */

import { detectEnvironment, getAvailableModels } from './providers/detect.mjs';
import { startREPL } from './repl.mjs';
import { startEnhancedREPL } from './repl-enhanced.mjs';
import { backgroundRefresh, displayRefreshStatus } from './auth/refresh.mjs';
import { autoRecovery } from './auth/recovery.mjs';
import { runDoctorCheck } from './commands/doctor.mjs';
import { displayStatus, getQuickStatus } from './commands/status.mjs';
import { displayHelp } from './commands/help.mjs';
import { performReset, previewReset, getResetLevels } from './cli/reset.mjs';
import { recoverInterruptedWork, resumePlan } from './state/recovery.mjs';
import { performStateCleanup } from './state/cleanup.mjs';
import { generateSessionReport, generateTrendsReport, displayQuickSummary } from './monitor/report.mjs';
import { endPerformanceSession } from './monitor/performance.mjs';
import { fmt, box, createTree, formatModel } from './ui/formatter.mjs';
import { status, tier, provider as providerIcons } from './ui/icons.mjs';
import { displayError, displayWarning, displaySuccess, handleError } from './ui/errors.mjs';
import { createSpinner, withSpinner } from './ui/progress.mjs';

const VERSION = '1.0.0';

/**
 * Get provider usage balance for today (mockup for now)
 */
export function getProviderBalance() {
  // TODO: Replace with actual usage tracking
  // This would read from usage logs and calculate today's balance
  return {
    claude: 45,
    openai: 55,
    total: 12,
    label: 'Well balanced'
  };
}

/**
 * Display enhanced banner and system status (inspired by dual-brain polish)
 */
export function displayBanner(env, models) {
  // Enhanced header with gradient-like effect
  console.log(box(`🧠 Cortex v${VERSION}\nAI Org Chart in Your Shell`, {
    borderColor: fmt.brightBlue(''),
    textColor: fmt.bold(''),
    padding: 1,
    margin: 1
  }));

  // Provider status line (dual-brain style)
  const claudeStatus = env.claude.authed ? status.success : env.claude.installed ? status.warning : status.error;
  const codexStatus = env.codex.authed ? status.success : env.codex.installed ? status.warning : status.error;

  console.log(`  ${providerIcons.claude} Claude ${claudeStatus}  ${providerIcons.codex} Codex ${codexStatus}`);

  // Status summary line
  if (env.claude.authed && env.codex.authed) {
    console.log(`  ${fmt.green('Dual-brain mode active — full AI orchestration available')}`);
  } else if (env.claude.authed) {
    console.log(`  ${fmt.yellow('Claude ready')} ${fmt.dim('· Add Codex for dual-brain features')}`);
  } else if (env.codex.authed) {
    console.log(`  ${fmt.yellow('Codex ready')} ${fmt.dim('· Add Claude for full features')}`);
  } else {
    console.log(`  ${fmt.red('No providers authenticated')} ${fmt.dim('· Run: cortex --doctor')}`);
  }

  // Provider balance bar (dual-brain inspired)
  const balance = getProviderBalance();
  if (balance.total > 0) {
    console.log(`  ${fmt.providerBalanceBar(balance.claude, balance.openai)}`);
  }

  console.log('');

  // Compact org chart hierarchy (dual-brain style)
  console.log(fmt.bold('Org Chart:'));
  const tiers = [
    { name: 'MANAGER', key: 'manager', icon: tier.manager, color: fmt.redBold },
    { name: 'IC', key: 'ic', icon: tier.ic, color: fmt.yellowBold },
    { name: 'WORKER', key: 'worker', icon: tier.worker, color: fmt.blueBold }
  ];

  for (const tierInfo of tiers) {
    const tierModels = models[tierInfo.key] || [];
    const count = tierModels.length;
    const modelSummary = count > 0
      ? fmt.dim(`${count} model${count !== 1 ? 's' : ''}`)
      : fmt.red('none');

    console.log(`  ${tierInfo.icon} ${tierInfo.color(tierInfo.name.padEnd(7))} ${modelSummary}`);

    if (count > 0 && tierModels.length <= 3) {
      // Show models inline for small lists
      const modelList = tierModels.map(m => `${m.provider}/${m.model}`).join(', ');
      console.log(`    ${fmt.dim('├─ ' + modelList)}`);
    } else if (count > 3) {
      // Show summary for large lists
      console.log(`    ${fmt.dim(`├─ ${tierModels[0].provider}/${tierModels[0].model} +${count-1} more`)}`);
    }
  }

  console.log(`\n${fmt.dim('💡 Type your request and press Enter — AI will route automatically')}`);
}

/**
 * Display enhanced installation guidance for missing CLIs
 */
function displayInstallationHelp(env) {
  console.log('\n' + fmt.bold('🚀 Getting Started:'));
  console.log('');

  const steps = [];

  if (!env.claude.installed) {
    steps.push({
      text: fmt.orange('Install Claude CLI:'),
      children: [
        { text: fmt.cyan('pip install anthropic-cli') },
        { text: fmt.cyan('claude auth login') }
      ]
    });
  } else if (!env.claude.authed) {
    steps.push({
      text: fmt.yellow('Authenticate Claude CLI:'),
      children: [
        { text: fmt.cyan('claude auth login') }
      ]
    });
  }

  if (!env.codex.installed) {
    steps.push({
      text: fmt.green('Install Codex CLI:'),
      children: [
        { text: fmt.cyan('npm install -g @openai/codex') },
        { text: fmt.cyan('codex login') }
      ]
    });
  } else if (!env.codex.authed) {
    steps.push({
      text: fmt.yellow('Authenticate Codex CLI:'),
      children: [
        { text: fmt.cyan('codex login') }
      ]
    });
  }

  if (steps.length > 0) {
    const helpTree = createTree(steps);
    helpTree.forEach(line => console.log(line));
    console.log('');
  }

  console.log(fmt.warning('You need at least one authenticated CLI to use Cortex.'));
  console.log(fmt.dim('Both CLIs enable different model tiers and redundancy.'));
  console.log('');
}

/**
 * Handle command line arguments
 */
function parseArgs(argv) {
  const args = {
    help: false,
    version: false,
    doctor: false,
    status: false,
    reset: null,
    resetForce: false,
    resetPreview: false,
    cleanup: false,
    resume: null,
    recovery: false,
    verbose: false,
    report: null,
    trends: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--doctor':
        args.doctor = true;
        break;
      case '--status':
        args.status = true;
        break;
      case '--reset':
        args.reset = argv[i + 1] || 'sessions';
        i++; // Skip next arg since it's the reset level
        break;
      case '--force':
        args.resetForce = true;
        break;
      case '--preview':
        args.resetPreview = true;
        break;
      case '--cleanup':
        args.cleanup = true;
        break;
      case '--resume':
        args.resume = argv[i + 1] || true;
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
        break;
      case '--recovery':
        args.recovery = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--report':
        args.report = true;
        break;
      case '--trends':
        args.trends = argv[i + 1] || '7';
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
        break;
    }
  }

  return args;
}

// Help display is now handled by the enhanced help command

// Doctor check is now handled by the enhanced doctor command

/**
 * Main entry point
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(`Cortex v${VERSION}`);
    return;
  }

  if (args.help) {
    displayHelp();
    return;
  }

  // Detect environment and available models
  const env = detectEnvironment();
  const models = getAvailableModels(env);

  if (args.doctor) {
    await runDoctorCheck();
    return;
  }

  if (args.status) {
    displayStatus(process.cwd(), { verbose: args.verbose });
    return;
  }

  if (args.reset) {
    if (args.resetPreview) {
      previewReset(args.reset);
    } else {
      await performReset(args.reset, { force: args.resetForce, verbose: args.verbose });
    }
    return;
  }

  if (args.cleanup) {
    console.log('🧹 Running state cleanup...\n');
    const cleanupResults = performStateCleanup({ verbose: args.verbose });
    console.log(`\n✅ Cleanup completed. Saved ${Math.round(cleanupResults.spaceSaved / 1024)}KB`);
    return;
  }

  if (args.recovery) {
    const recovery = await recoverInterruptedWork();
    if (!recovery.hasInterrupted) {
      console.log('✅ No interrupted work found');
    }
    return;
  }

  if (args.resume) {
    if (args.resume === true) {
      // Show available sessions to resume
      const recovery = await recoverInterruptedWork();
      return;
    } else {
      // Resume specific plan
      try {
        const plan = resumePlan(args.resume);
        console.log(`✅ Resumed plan: ${plan.description}`);
      } catch (error) {
        console.log(`❌ Failed to resume: ${error.message}`);
        return;
      }
    }
  }

  if (args.report) {
    await generateSessionReport();
    return;
  }

  if (args.trends) {
    const days = parseInt(args.trends) || 7;
    await generateTrendsReport(process.cwd(), days);
    return;
  }

  // Background token refresh (non-blocking) with visual feedback
  if (env.hasProviders) {
    const refreshSpinner = createSpinner('Refreshing credentials...', 'dots');
    refreshSpinner.start();

    backgroundRefresh()
      .then((result) => {
        refreshSpinner.success('Credentials refreshed');
        displayRefreshStatus(result);
      })
      .catch(() => {
        refreshSpinner.stop(); // Silent failure for background refresh
      });
  }

  // Display banner and status
  displayBanner(env, models);

  // Check if we can run
  if (!env.hasProviders) {
    displayInstallationHelp(env);

    // Try auto-recovery with enhanced feedback
    console.log('');
    const recoveryResult = await withSpinner(
      autoRecovery(env),
      '🔧 Attempting auto-recovery...',
      {
        successText: 'Auto-recovery completed',
        errorText: 'Auto-recovery failed'
      }
    );

    if (!recoveryResult.recovered) {
      displayError(new Error('No authenticated providers found'), {
        operation: 'system startup',
        suggestions: ['Run: cortex --doctor', 'Authenticate at least one provider']
      });
      process.exit(1);
    } else {
      displaySuccess('Auto-recovery successful', { nextStep: 'Continuing startup...' });
      // Re-detect after recovery
      const newEnv = detectEnvironment();
      const newModels = getAvailableModels(newEnv);
      if (!newEnv.hasProviders) {
        console.log('❌ Recovery failed: Still no authenticated providers');
        process.exit(1);
      }
      // Update context with recovered environment
      env.claude = newEnv.claude;
      env.codex = newEnv.codex;
      env.hasProviders = newEnv.hasProviders;
      models.worker = newModels.worker;
      models.ic = newModels.ic;
      models.manager = newModels.manager;
    }
  }

  if (models.manager.length === 0 && models.ic.length === 0 && models.worker.length === 0) {
    handleError(new Error('No models available in any tier'), {
      operation: 'model detection',
      tier: 'all'
    });
    process.exit(1);
  }

  // Start the REPL with context
  const context = {
    environment: env,
    availableModels: models,
    options: {
      timeoutMs: 120000 // 2 minutes
    }
  };

  await startEnhancedREPL(context);
}

// Handle uncaught errors gracefully with rich formatting
process.on('unhandledRejection', (reason, promise) => {
  console.log(''); // Add spacing
  handleError(reason instanceof Error ? reason : new Error(String(reason)), {
    operation: 'async operation',
    context: 'unhandled promise rejection'
  });
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.log(''); // Add spacing
  handleError(error, {
    operation: 'system operation',
    context: 'uncaught exception'
  });
  process.exit(1);
});

// Run the CLI with enhanced error handling
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.log(''); // Add spacing
    handleError(error, {
      operation: 'CLI startup',
      context: 'main execution'
    });
    process.exit(1);
  });
}