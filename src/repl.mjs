/**
 * repl.mjs — Enhanced interactive conversation loop with rich hierarchy display
 */

import * as readline from 'readline';
import { chef } from './chef.mjs';
import { addMessage, loadSession, getSessionSummary } from './state/session.mjs';
import { endPerformanceSession } from './monitor/performance.mjs';
import { displayQuickSummary } from './monitor/report.mjs';
import { fmt, separator, formatTier, formatDuration, timeAgo, formatConfidence } from './ui/formatter.mjs';
import { status, tier, session as sessionIcons, getConfidenceIcon } from './ui/icons.mjs';
import { createSpinner, HierarchicalProgress } from './ui/progress.mjs';
import { displayError, handleError } from './ui/errors.mjs';

/**
 * Create and configure readline interface
 */
function createReadlineInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
    history: [],
    historySize: 100
  });

  // Handle Ctrl+C gracefully with enhanced output
  rl.on('SIGINT', () => {
    console.log('\n');
    const spinner = createSpinner('Finalizing session...');
    spinner.start();

    setTimeout(() => {
      spinner.success('Session finalized');
      endPerformanceSession();
      displayQuickSummary();
      console.log(fmt.success('Session saved. Goodbye!'));
      process.exit(0);
    }, 500);
  });

  return rl;
}

/**
 * Display enhanced session resume info
 */
function displaySessionResume() {
  const summary = getSessionSummary();

  if (summary.messageCount > 0) {
    const sessionIcon = sessionIcons.active;
    const lastTime = summary.lastMessage
      ? timeAgo(summary.lastMessage.timestamp)
      : 'Unknown';
    const duration = summary.duration ? formatDuration(summary.duration) : '';

    console.log(`\n${sessionIcon} ${fmt.cyan('Resuming active session')}`);
    console.log(`  ${fmt.dim('Messages:')} ${fmt.bold(summary.userMessageCount)} exchanges`);
    if (duration) {
      console.log(`  ${fmt.dim('Duration:')} ${fmt.bold(duration)}`);
    }
    console.log(`  ${fmt.dim('Last activity:')} ${fmt.bold(lastTime)}`);

    // Show recent context
    if (summary.lastMessage) {
      const preview = summary.lastMessage.content.slice(0, 80);
      const truncated = summary.lastMessage.content.length > 80 ? '...' : '';
      console.log(`  ${fmt.dim('Context:')} ${fmt.dim(`"${preview}${truncated}"`)}`);
    }
  } else {
    console.log(`\n${sessionIcons.new} ${fmt.green('Starting new session')}`);
    console.log(`  ${fmt.dim('Ready for AI-powered development workflow')}`);
  }
}

/**
 * Display enhanced result with rich formatting and visual hierarchy
 */
function displayResult(result) {
  if (result.success) {
    console.log('\n' + separator(60, '═', fmt.green('')));

    // Status line with tier and model info
    const tierIcon = tier[result.tier] || tier.worker;
    const formattedTier = formatTier(result.tier);
    console.log(`${status.success} ${fmt.success('Completed by')} ${tierIcon} ${formattedTier}`);

    // Model information
    if (result.model) {
      const modelDisplay = `${result.model.provider}/${result.model.model}`;
      console.log(`  ${fmt.dim('Model:')} ${fmt.formatModel(result.model.provider, result.model.model)}`);
    }

    // Confidence display with visual indicator
    if (result.confidence !== null) {
      const confidenceIcon = getConfidenceIcon(result.confidence);
      const confidenceText = formatConfidence(result.confidence);
      console.log(`  ${confidenceIcon} ${fmt.dim('Confidence:')} ${confidenceText}`);
    }

    // Escalation information
    if (result.totalAttempts > 1) {
      const escalations = result.totalAttempts - 1;
      console.log(`  ${status.loading} ${fmt.warning(`Escalations: ${escalations}`)}`);
    }

    // Duration with smart formatting
    if (result.durationMs) {
      const duration = formatDuration(result.durationMs);
      const durationColor = result.durationMs > 30000 ? fmt.yellow : fmt.green;
      console.log(`  ${fmt.dim('Duration:')} ${durationColor(duration)}`);
    }

    // Token efficiency (if available)
    if (result.tokensUsed) {
      console.log(`  ${fmt.dim('Tokens:')} ${fmt.cyan(result.tokensUsed.toLocaleString())}`);
    }

    console.log(separator(60, '═', fmt.green('')));
    console.log('\n' + result.output);

  } else {
    console.log('\n' + separator(60, '═', fmt.red('')));

    // Error status line
    const tierIcon = result.tier ? tier[result.tier] || tier.worker : status.error;
    console.log(`${status.error} ${fmt.error('Task Failed')}`);

    // Final tier information
    if (result.tier) {
      const formattedTier = formatTier(result.tier);
      console.log(`  ${fmt.dim('Final tier:')} ${tierIcon} ${formattedTier}`);
    }

    // Attempt information
    if (result.totalAttempts) {
      console.log(`  ${fmt.dim('Attempts:')} ${fmt.yellow(result.totalAttempts)}`);
    }

    // Duration
    if (result.durationMs) {
      const duration = formatDuration(result.durationMs);
      console.log(`  ${fmt.dim('Duration:')} ${fmt.dim(duration)}`);
    }

    console.log(separator(60, '═', fmt.red('')));

    // Error message with proper formatting
    const errorMsg = result.output || result.error || 'Unknown error';
    console.log('\n' + fmt.error(errorMsg));
  }
  console.log('\n');
}

/**
 * Main REPL loop
 */
export async function startREPL(context) {
  const rl = createReadlineInterface();

  displaySessionResume();

  console.log('\nType your request and press Enter. Use Ctrl+C to exit.\n');

  const askQuestion = () => {
    rl.prompt();
  };

  rl.on('line', async (input) => {
    const userInput = input.trim();

    if (!userInput) {
      askQuestion();
      return;
    }

    // Handle special commands
    if (userInput === '/quit' || userInput === '/exit') {
      console.log('\nGoodbye! Session saved.');
      rl.close();
      return;
    }

    if (userInput === '/clear') {
      console.clear();
      displaySessionResume();
      askQuestion();
      return;
    }

    if (userInput === '/help') {
      console.log(fmt.bold('\n📋 Available Commands:'));
      console.log(separator(50, '─'));

      const helpSections = [
        {
          title: 'Chat Commands:',
          commands: [
            { cmd: '/help', desc: 'Show this help' },
            { cmd: '/clear', desc: 'Clear screen and show session info' },
            { cmd: '/status', desc: 'Show detailed session status' },
            { cmd: '/quit or /exit', desc: 'Exit Cortex gracefully' }
          ]
        },
        {
          title: 'AI Org Chart Hierarchy:',
          commands: [
            { cmd: `${tier.worker} WORKER`, desc: 'Simple tasks, file search, documentation' },
            { cmd: `${tier.ic} IC`, desc: 'Implementation, coding, main development work' },
            { cmd: `${tier.manager} MANAGER`, desc: 'Architecture, reviews, complex decisions' }
          ]
        }
      ];

      for (const section of helpSections) {
        console.log(`\n  ${fmt.bold(section.title)}`);
        for (const item of section.commands) {
          const cmdPadded = item.cmd.padEnd(20);
          console.log(`    ${fmt.cyan(cmdPadded)} ${fmt.dim('—')} ${item.desc}`);
        }
      }

      console.log(`\n  ${fmt.dim('Cortex automatically routes tasks to the right tier and escalates when needed.')}`);
      console.log('');
      askQuestion();
      return;
    }

    if (userInput === '/status') {
      const summary = getSessionSummary();

      console.log('\n' + fmt.bold('📊 Session Status:'));
      console.log(separator(40, '─'));

      console.log(`  ${sessionIcons.active} ${fmt.bold('Active Session')}`);
      console.log(`    Messages: ${fmt.cyan(summary.messageCount)} (${summary.userMessageCount} user, ${summary.assistantMessageCount} assistant)`);

      if (summary.duration) {
        const duration = formatDuration(summary.duration);
        console.log(`    Duration: ${fmt.cyan(duration)}`);
      }

      if (summary.lastMessage) {
        const lastTime = timeAgo(summary.lastMessage.timestamp);
        console.log(`    Last activity: ${fmt.cyan(lastTime)}`);

        // Show performance stats if available
        const avgResponseTime = '1.3s'; // Mock - replace with real data
        const successRate = '96%'; // Mock - replace with real data
        console.log(`    Performance: ${fmt.green(avgResponseTime)} avg, ${fmt.green(successRate)} success`);
      }

      console.log('');
      askQuestion();
      return;
    }

    // Save user message
    addMessage('user', userInput);

    // Process with the chef with enhanced progress indication
    try {
      // Show processing indicator
      const spinner = createSpinner('Processing request...');
      spinner.start();

      const result = await chef(userInput, context);

      // Stop spinner and show result
      spinner.stop();

      // Save assistant response
      addMessage('assistant', result.output, {
        tier: result.tier,
        confidence: result.confidence,
        success: result.success,
        model: result.model ? `${result.model.provider}/${result.model.model}` : null,
        duration: result.durationMs,
        tokensUsed: result.tokensUsed
      });

      // Display enhanced result
      displayResult(result);

    } catch (error) {
      // Enhanced error display
      console.log('\n' + separator(60, '═', fmt.red('')));
      console.log(`${status.error} ${fmt.error('Orchestration Error')}`);
      console.log(`  ${fmt.dim('Details:')} ${error.message}`);
      console.log(`  ${status.info} Try rephrasing your request or check --doctor`);
      console.log(separator(60, '═', fmt.red('')) + '\n');

      // Save error message
      addMessage('assistant', `Error: ${error.message}`, {
        success: false,
        error: true,
        timestamp: Date.now()
      });
    }

    askQuestion();
  });

  rl.on('close', () => {
    console.log('\n');
    const spinner = createSpinner('Finalizing session...');
    spinner.start();

    setTimeout(() => {
      spinner.success('Session finalized');
      endPerformanceSession();
      displayQuickSummary();
      console.log(fmt.success('Session saved. Goodbye!'));
      process.exit(0);
    }, 500);
  });

  // Start the conversation
  askQuestion();
}