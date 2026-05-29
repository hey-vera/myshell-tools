/**
 * repl-enhanced.mjs — Enhanced REPL with dual-brain style orchestration display
 */

import * as readline from 'readline';
import { fmt, separator, formatTier, formatDuration, timeAgo } from './ui/formatter.mjs';
import { status, tier, session as sessionIcons, progress } from './ui/icons.mjs';
import { HierarchicalProgress, createSpinner } from './ui/progress.mjs';
import { displayError, handleError } from './ui/errors.mjs';
import { chef } from './chef.mjs';

/**
 * Enhanced REPL loop with visual orchestration
 */
export async function startEnhancedREPL(context) {
  const rl = createReadlineInterface();

  displayWelcome(context);
  displaySessionResume();

  console.log(''); // Add spacing before prompt

  while (true) {
    try {
      const userInput = await askUser(rl);

      if (!userInput.trim()) continue;

      // Handle built-in commands
      if (userInput.startsWith('/')) {
        const handled = await handleCommand(userInput.trim(), context);
        if (handled) continue;
      }

      // Exit commands
      if (['exit', 'quit', '/exit', '/quit'].includes(userInput.toLowerCase())) {
        break;
      }

      // Process user input through AI orchestration
      await processWithOrchestration(userInput, context);

    } catch (error) {
      handleError(error, { operation: 'user input processing' });
    }
  }

  // Graceful shutdown
  const shutdownSpinner = createSpinner('Saving session...');
  shutdownSpinner.start();

  setTimeout(() => {
    shutdownSpinner.success('Session saved');
    console.log(fmt.success('Goodbye! 👋'));
    rl.close();
  }, 500);
}

/**
 * Create readline interface with enhanced features
 */
function createReadlineInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: fmt.dim('You: '),
    history: [],
    historySize: 100
  });

  // Enhanced Ctrl+C handling
  rl.on('SIGINT', () => {
    console.log('\n');
    const spinner = createSpinner('Finalizing session...');
    spinner.start();

    setTimeout(() => {
      spinner.success('Session finalized');
      console.log(fmt.success('Session saved. Goodbye! 👋'));
      process.exit(0);
    }, 500);
  });

  return rl;
}

/**
 * Display welcome message with context
 */
function displayWelcome(context) {
  const { environment, availableModels } = context;

  console.log('');
  console.log(fmt.bold('🎯 Ready for AI orchestration'));

  // Show available capabilities
  const capabilities = [];
  if (availableModels.manager.length > 0) capabilities.push('🏢 Strategic planning');
  if (availableModels.ic.length > 0) capabilities.push('⚡ Code implementation');
  if (availableModels.worker.length > 0) capabilities.push('🔍 Quick lookups');

  if (capabilities.length > 0) {
    console.log(`  ${fmt.dim('Available:')} ${capabilities.join(', ')}`);
  }

  console.log(`  ${fmt.dim('Tip: Commands start with')} ${fmt.cyan('/')} ${fmt.dim('• Press')} ${fmt.cyan('Ctrl+C')} ${fmt.dim('to exit')}`);
}

/**
 * Ask user for input with enhanced prompt
 */
async function askUser(rl) {
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Handle built-in slash commands
 */
async function handleCommand(command, context) {
  const [cmd, ...args] = command.split(' ');

  switch (cmd.toLowerCase()) {
    case '/help':
      displayHelpCommands();
      return true;

    case '/clear':
      console.clear();
      displayWelcome(context);
      displaySessionResume();
      return true;

    case '/status':
      displaySessionStatus();
      return true;

    case '/models':
      displayAvailableModels(context.availableModels);
      return true;

    case '/balance':
      displayProviderBalance();
      return true;

    case '/reset':
      const resetSpinner = createSpinner('Resetting session...');
      resetSpinner.start();
      setTimeout(() => {
        resetSpinner.success('Session reset');
        console.log(fmt.success('Session cleared. Starting fresh! ✨'));
      }, 1000);
      return true;

    default:
      console.log(fmt.warning(`Unknown command: ${cmd}`));
      console.log(fmt.dim('Type /help to see available commands'));
      return true;
  }
}

/**
 * Process user input with visual orchestration
 */
async function processWithOrchestration(userInput, context) {
  console.log('');

  // Create hierarchical progress display
  const orchestration = new HierarchicalProgress();

  try {
    // Start with initial agent
    const initialTier = determineInitialTier(userInput);
    const agentId = 'agent-' + Date.now();

    orchestration.addAgent(agentId, {
      tier: initialTier,
      text: `${initialTier.toUpperCase()}: Processing request`,
      status: 'thinking'
    });

    // Simulate AI processing with realistic delays
    await simulateAIWork(orchestration, agentId, userInput, context);

    // Show completion
    orchestration.complete(agentId, 'Task completed successfully');

  } catch (error) {
    console.log('\n');
    handleError(error, {
      operation: 'AI orchestration',
      tier: 'unknown'
    });
  }
}

/**
 * Determine the initial tier based on user input complexity
 */
function determineInitialTier(input) {
  const words = input.toLowerCase();

  // Manager tier triggers
  if (words.includes('architecture') || words.includes('design') ||
      words.includes('strategy') || words.includes('review') ||
      words.includes('security') || words.includes('complex')) {
    return 'manager';
  }

  // Worker tier triggers
  if (words.includes('find') || words.includes('search') ||
      words.includes('list') || words.includes('show') ||
      words.includes('grep') || words.includes('what is')) {
    return 'worker';
  }

  // Default to IC tier
  return 'ic';
}

/**
 * Simulate AI work with realistic orchestration patterns
 */
async function simulateAIWork(orchestration, agentId, input, context) {
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Initial thinking phase
  await delay(800);
  orchestration.updateAgent(agentId, { status: 'working' });

  // Simulate complexity check - sometimes escalate
  await delay(1200);

  const shouldEscalate = Math.random() > 0.7; // 30% chance
  const shouldDelegate = Math.random() > 0.8; // 20% chance

  if (shouldEscalate) {
    // Escalate to manager
    const managerId = 'manager-' + Date.now();
    orchestration.escalate(agentId, managerId, 'manager', 'Complexity detected - requesting manager review');

    await delay(1500);
    orchestration.updateAgent(managerId, {
      status: 'working',
      text: 'MANAGER: Analyzing requirements and creating plan'
    });

    await delay(2000);

    if (shouldDelegate) {
      // Delegate subtask to worker
      const workerId = 'worker-' + Date.now();
      orchestration.delegate(managerId, workerId, 'worker', 'Gathering preliminary information');

      await delay(1000);
      orchestration.updateAgent(workerId, { status: 'working' });

      await delay(1500);
      orchestration.complete(workerId, 'Information gathered');

      await delay(500);
    }

    orchestration.complete(managerId, 'Strategic analysis complete');
    await delay(300);
  }

  await delay(500);

  // Show realistic response
  console.log('\n' + separator(60, '═', fmt.green('')));
  console.log(`${status.success} ${fmt.green('Response generated successfully')}`);

  // Mock AI response based on input
  const response = generateMockResponse(input);
  console.log('\n' + response);
  console.log('\n' + fmt.dim('───────────────────────────────────────────────────────────'));

  // Show model info
  const usedModel = context.availableModels.ic[0] || context.availableModels.worker[0] || context.availableModels.manager[0];
  if (usedModel) {
    console.log(`${fmt.dim('Model:')} ${fmt.formatModel(usedModel.provider, usedModel.model)}`);
    console.log(`${fmt.dim('Confidence:')} ${fmt.green('87%')}`);
  }

  console.log('');
}

/**
 * Generate a mock response based on input type
 */
function generateMockResponse(input) {
  const lower = input.toLowerCase();

  if (lower.includes('find') || lower.includes('search')) {
    return `🔍 Found 3 relevant files:\n  • src/components/auth.tsx\n  • lib/auth-utils.ts\n  • tests/auth.spec.ts`;
  }

  if (lower.includes('fix') || lower.includes('bug')) {
    return `🔧 I've identified the issue and created a fix:\n\n1. The authentication token wasn't being properly refreshed\n2. Added token validation middleware\n3. Updated error handling for expired sessions\n\nThe fix has been applied to your codebase.`;
  }

  if (lower.includes('architecture') || lower.includes('design')) {
    return `🏗️ Here's a recommended architecture:\n\n**Frontend Layer:**\n• Next.js with TypeScript\n• React Query for state management\n• TailwindCSS for styling\n\n**API Layer:**\n• Express.js REST API\n• JWT authentication\n• Rate limiting middleware\n\n**Database Layer:**\n• PostgreSQL for relational data\n• Redis for caching\n• Database migrations with Prisma`;
  }

  if (lower.includes('explain') || lower.includes('how')) {
    return `💡 Let me break this down:\n\n**How it works:**\n1. The system uses a three-tier architecture\n2. Requests flow through authentication middleware\n3. Business logic is handled in service layers\n4. Data persistence uses the repository pattern\n\nThis design provides separation of concerns and makes the codebase maintainable.`;
  }

  // Default response
  return `✅ I've processed your request. The implementation follows best practices and includes proper error handling, logging, and documentation.`;
}

/**
 * Display help for slash commands
 */
function displayHelpCommands() {
  console.log('\n' + fmt.bold('📋 Available Commands:'));
  console.log(separator(50, '─'));

  const commands = [
    { cmd: '/help', desc: 'Show this help message' },
    { cmd: '/clear', desc: 'Clear screen and show session info' },
    { cmd: '/status', desc: 'Show current session statistics' },
    { cmd: '/models', desc: 'Show available AI models by tier' },
    { cmd: '/balance', desc: 'Show provider usage balance' },
    { cmd: '/reset', desc: 'Reset current session' },
    { cmd: '/quit or /exit', desc: 'Exit Cortex' }
  ];

  for (const { cmd, desc } of commands) {
    console.log(`  ${fmt.cyan(cmd.padEnd(15))} ${fmt.dim('—')} ${desc}`);
  }

  console.log('');
}

/**
 * Display current session status
 */
function displaySessionStatus() {
  console.log('\n' + fmt.bold('📊 Session Status:'));
  console.log(separator(50, '─'));

  console.log(`  ${fmt.dim('Messages:')} ${fmt.bold('12')} exchanges`);
  console.log(`  ${fmt.dim('Duration:')} ${fmt.bold('8m 23s')}`);
  console.log(`  ${fmt.dim('Models used:')} Worker: 3, IC: 7, Manager: 2`);
  console.log(`  ${fmt.dim('Last activity:')} ${fmt.bold('just now')}`);
  console.log(`  ${fmt.dim('Session ID:')} ${fmt.cyan('sess-abc123...')}`);

  console.log('');
}

/**
 * Display available models by tier
 */
function displayAvailableModels(models) {
  console.log('\n' + fmt.bold('🤖 Available Models:'));
  console.log(separator(50, '─'));

  const tiers = [
    { name: 'MANAGER', key: 'manager', icon: tier.manager, color: fmt.red },
    { name: 'IC', key: 'ic', icon: tier.ic, color: fmt.yellow },
    { name: 'WORKER', key: 'worker', icon: tier.worker, color: fmt.blue }
  ];

  for (const tierInfo of tiers) {
    const tierModels = models[tierInfo.key] || [];
    console.log(`\n  ${tierInfo.icon} ${tierInfo.color(fmt.bold(tierInfo.name))} (${tierModels.length} available)`);

    for (const model of tierModels) {
      const modelDisplay = `${model.provider}/${model.model}`;
      console.log(`    ${fmt.dim('├─')} ${fmt.formatModel(model.provider, model.model)}`);
    }

    if (tierModels.length === 0) {
      console.log(`    ${fmt.dim('└─')} ${fmt.red('No models available')}`);
    }
  }

  console.log('');
}

/**
 * Display provider balance (mock for now)
 */
function displayProviderBalance() {
  console.log('\n' + fmt.bold('⚖️ Provider Balance:'));
  console.log(separator(50, '─'));

  console.log(`  ${fmt.providerBalanceBar(45, 55)}`);
  console.log(`  ${fmt.dim('Total calls today:')} ${fmt.bold('23')}`);
  console.log(`  ${fmt.dim('Status:')} ${fmt.green('Well balanced')}`);

  console.log('');
}

/**
 * Enhanced session resume display
 */
function displaySessionResume() {
  // Mock session data - would come from actual session state
  const sessionActive = Math.random() > 0.5;

  if (sessionActive) {
    console.log(`\n${sessionIcons.active} ${fmt.cyan('Resuming active session')}`);
    console.log(`  ${fmt.dim('Messages:')} 8 exchanges • ${fmt.dim('Duration:')} 5m 12s`);
    console.log(`  ${fmt.dim('Last:')} "Fix the authentication bug in login.ts"`);
  } else {
    console.log(`\n${sessionIcons.new} ${fmt.green('Starting fresh session')}`);
    console.log(`  ${fmt.dim('AI orchestration ready for your requests')}`);
  }
}