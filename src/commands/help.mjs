/**
 * help.mjs — Rich help system with examples and visual formatting
 */

import { fmt, box, separator, createTree } from '../ui/formatter.mjs';
import { status, tier, actions } from '../ui/icons.mjs';

const VERSION = '1.0.0';

/**
 * Display comprehensive help information
 */
export function displayHelp() {
  // Header
  console.log(box(`Cortex v${VERSION} — AI Org Chart Orchestration`, {
    borderColor: fmt.brightBlue(''),
    textColor: fmt.bold(''),
    padding: 1,
    margin: 1
  }));

  // Quick Start
  displayQuickStart();

  // Commands
  displayCommands();

  // Hierarchy
  displayHierarchy();

  // Examples
  displayExamples();

  // Advanced Usage
  displayAdvancedUsage();

  console.log('');
}

/**
 * Display quick start section
 */
function displayQuickStart() {
  console.log(fmt.bold('\n🚀 Quick Start:'));
  console.log(separator(60, '─'));

  const quickSteps = [
    {
      text: fmt.green('cortex --doctor') + ' — Check system health',
      children: [
        { text: fmt.dim('Verify providers are installed and authenticated') }
      ]
    },
    {
      text: fmt.green('cortex') + ' — Start interactive chat',
      children: [
        { text: fmt.dim('Begin AI-powered development workflow') }
      ]
    },
    {
      text: fmt.dim('Type your request and press Enter'),
      children: [
        { text: fmt.dim('AI will route to appropriate tier automatically') }
      ]
    }
  ];

  const tree = createTree(quickSteps);
  tree.forEach(line => console.log('  ' + line));

  console.log('');
}

/**
 * Display all available commands
 */
function displayCommands() {
  console.log(fmt.bold('\n📋 Commands:'));
  console.log(separator(60, '─'));

  const commands = [
    {
      category: 'Main Usage',
      items: [
        { cmd: 'cortex', desc: 'Start interactive chat with AI hierarchy' },
        { cmd: 'cortex --help', desc: 'Show this help information' },
        { cmd: 'cortex --version', desc: 'Show version information' }
      ]
    },
    {
      category: 'System Health',
      items: [
        { cmd: 'cortex --doctor', desc: 'Run comprehensive health check' },
        { cmd: 'cortex --status', desc: 'Show current session and system status' }
      ]
    },
    {
      category: 'Session Management',
      items: [
        { cmd: 'cortex --reset [level]', desc: 'Reset state (sessions, state, all, nuclear)' },
        { cmd: 'cortex --cleanup', desc: 'Clean up old files and optimize storage' },
        { cmd: 'cortex --resume [plan-id]', desc: 'Resume interrupted work' },
        { cmd: 'cortex --recovery', desc: 'Show recovery options for interrupted work' }
      ]
    },
    {
      category: 'Analytics & Reporting',
      items: [
        { cmd: 'cortex --report', desc: 'Generate comprehensive session report' },
        { cmd: 'cortex --trends [days]', desc: 'Show performance trends (default: 7 days)' }
      ]
    }
  ];

  for (const category of commands) {
    console.log(`\n  ${fmt.bold(category.category)}:`);

    for (const item of category.items) {
      console.log(`    ${fmt.cyan(item.cmd.padEnd(25))} ${fmt.dim('—')} ${item.desc}`);
    }
  }

  console.log('');
}

/**
 * Display AI hierarchy information
 */
function displayHierarchy() {
  console.log(fmt.bold('\n🏢 AI Org Chart Hierarchy:'));
  console.log(separator(60, '─'));

  const hierarchyLevels = [
    {
      name: 'MANAGER',
      icon: tier.manager,
      color: fmt.red,
      description: 'Complex decisions, architecture, code review, escalations',
      models: 'Claude Opus, GPT-5.5',
      when: 'High complexity, architecture decisions, final reviews'
    },
    {
      name: 'IC (Individual Contributor)',
      icon: tier.ic,
      color: fmt.yellow,
      description: 'Main workhorses for implementation and coding tasks',
      models: 'Claude Sonnet, GPT-5.4',
      when: 'Implementation, bug fixes, feature development'
    },
    {
      name: 'WORKER',
      icon: tier.worker,
      color: fmt.blue,
      description: 'Fast, cheap models for simple tasks',
      models: 'Claude Haiku, GPT-4.1-mini',
      when: 'File search, grep, simple lookups, documentation'
    }
  ];

  for (const level of hierarchyLevels) {
    console.log(`  ${level.icon} ${level.color(fmt.bold(level.name))}`);
    console.log(`    ${fmt.dim('Description:')} ${level.description}`);
    console.log(`    ${fmt.dim('Models:')} ${fmt.green(level.models)}`);
    console.log(`    ${fmt.dim('Best for:')} ${level.when}`);
    console.log('');
  }

  console.log(fmt.bold('📈 How Escalation Works:'));
  console.log(`  1. Tasks start at appropriate tier (usually ${fmt.yellow('IC')})`);
  console.log(`  2. Models escalate ${fmt.red('UP')} when they need help or hit complexity`);
  console.log(`  3. Managers can delegate ${fmt.blue('DOWN')} to workers for simple subtasks`);
  console.log(`  4. Everything is transparent — you see the org chart in action`);

  console.log('');
}

/**
 * Display usage examples
 */
function displayExamples() {
  console.log(fmt.bold('\n💡 Usage Examples:'));
  console.log(separator(60, '─'));

  const examples = [
    {
      category: 'Development Tasks',
      examples: [
        {
          input: 'Fix the authentication bug in login.ts',
          flow: 'IC → implements fix → Manager review if complex'
        },
        {
          input: 'Find all files that import React hooks',
          flow: 'Worker → searches codebase → returns file list'
        },
        {
          input: 'Design a new microservices architecture',
          flow: 'Manager → architectural planning → delegates implementation'
        }
      ]
    },
    {
      category: 'Code Analysis',
      examples: [
        {
          input: 'Explain how the authentication system works',
          flow: 'Worker → reads files → IC → explains patterns'
        },
        {
          input: 'Review this pull request for security issues',
          flow: 'Manager → comprehensive security review'
        },
        {
          input: 'What are the performance bottlenecks?',
          flow: 'IC → analyzes code → Manager → strategic recommendations'
        }
      ]
    },
    {
      category: 'Documentation',
      examples: [
        {
          input: 'Write API documentation for the user service',
          flow: 'Worker → reads code → IC → writes documentation'
        },
        {
          input: 'Create a deployment guide',
          flow: 'Manager → strategic overview → Worker → detailed steps'
        }
      ]
    }
  ];

  for (const category of examples) {
    console.log(`\n  ${fmt.bold(category.category)}:`);

    for (const example of category.examples) {
      console.log(`    ${status.info} ${fmt.green(`"${example.input}"`)}`);
      console.log(`      ${fmt.dim('→')} ${fmt.dim(example.flow)}`);
      console.log('');
    }
  }
}

/**
 * Display advanced usage information
 */
function displayAdvancedUsage() {
  console.log(fmt.bold('\n🔧 Advanced Usage:'));
  console.log(separator(60, '─'));

  console.log(fmt.bold('\n  Provider Setup:'));
  const providers = [
    {
      name: 'Claude',
      install: 'pip install anthropic-cli',
      auth: 'claude auth login',
      models: 'Opus (Manager), Sonnet (IC), Haiku (Worker)'
    },
    {
      name: 'Codex',
      install: 'npm install -g @openai/codex',
      auth: 'codex login',
      models: 'GPT-5.5 (Manager), GPT-5.4 (IC), GPT-4.1-mini (Worker)'
    }
  ];

  for (const provider of providers) {
    console.log(`\n    ${fmt.bold(provider.name)}:`);
    console.log(`      Install: ${fmt.cyan(provider.install)}`);
    console.log(`      Auth: ${fmt.cyan(provider.auth)}`);
    console.log(`      Models: ${fmt.dim(provider.models)}`);
  }

  console.log(fmt.bold('\n  Reset Levels:'));
  const resetLevels = [
    { level: 'sessions', desc: 'Clear current session but keep archives and auth' },
    { level: 'state', desc: 'Clear all state files but keep auth and archives' },
    { level: 'all', desc: 'Clear everything except authentication' },
    { level: 'nuclear', desc: 'Clear absolutely everything including authentication' }
  ];

  for (const level of resetLevels) {
    console.log(`    ${fmt.cyan(level.level.padEnd(10))} — ${level.desc}`);
  }

  console.log(fmt.bold('\n  Flags:'));
  const flags = [
    { flag: '--force', desc: 'Skip confirmations for destructive operations' },
    { flag: '--preview', desc: 'Show what would be affected without doing it' },
    { flag: '--verbose', desc: 'Show detailed output and debug information' }
  ];

  for (const flag of flags) {
    console.log(`    ${fmt.cyan(flag.flag.padEnd(12))} — ${flag.desc}`);
  }

  console.log(fmt.bold('\n  Interactive Commands:'));
  const interactiveCommands = [
    { cmd: '/help', desc: 'Show available chat commands' },
    { cmd: '/clear', desc: 'Clear screen and show session info' },
    { cmd: '/status', desc: 'Show current session statistics' },
    { cmd: '/quit or /exit', desc: 'Exit Cortex gracefully' }
  ];

  for (const cmd of interactiveCommands) {
    console.log(`    ${fmt.cyan(cmd.cmd.padEnd(15))} — ${cmd.desc}`);
  }

  console.log(fmt.bold('\n  Tips:'));
  const tips = [
    'You need at least one authenticated provider to use Cortex',
    'Both providers enable redundancy and different model capabilities',
    'Cortex automatically chooses the best model for each task',
    'Sessions are automatically saved and can be resumed later',
    'Use --doctor if you encounter any issues'
  ];

  for (const tip of tips) {
    console.log(`    ${status.info} ${tip}`);
  }

  console.log('');
}