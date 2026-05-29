/**
 * errors.mjs — Rich error displays with actionable solutions
 */

import { fmt, box, createTree } from './formatter.mjs';
import { status, actions, health, files } from './icons.mjs';

/**
 * Display a rich error with context and solutions
 */
export function displayError(error, context = {}) {
  const errorInfo = parseError(error);

  // Header with error type
  console.log(box(`${status.error} ${errorInfo.title}`, {
    borderColor: fmt.red(''),
    textColor: fmt.bold(''),
    padding: 1,
    margin: 1
  }));

  // Error message
  if (errorInfo.message) {
    console.log(`${fmt.red('Message:')} ${errorInfo.message}`);
    console.log('');
  }

  // Context information
  if (context.operation) {
    console.log(`${fmt.dim('Operation:')} ${context.operation}`);
  }
  if (context.model) {
    console.log(`${fmt.dim('Model:')} ${context.model.provider}/${context.model.model}`);
  }
  if (context.tier) {
    console.log(`${fmt.dim('Tier:')} ${context.tier.toUpperCase()}`);
  }

  if (context.operation || context.model || context.tier) {
    console.log('');
  }

  // Solutions
  if (errorInfo.solutions.length > 0) {
    console.log(fmt.bold('💡 Suggested Solutions:'));

    const solutionTree = errorInfo.solutions.map((solution, index) => ({
      text: `${fmt.cyan((index + 1) + '.')} ${solution.title}`,
      children: solution.steps ? solution.steps.map(step => ({ text: fmt.dim(step) })) : []
    }));

    const tree = createTree(solutionTree);
    tree.forEach(line => console.log(line));
    console.log('');
  }

  // Quick commands
  if (errorInfo.commands.length > 0) {
    console.log(fmt.bold('🔧 Quick Commands:'));
    for (const cmd of errorInfo.commands) {
      console.log(`  ${actions.configure} ${fmt.cyan(cmd.command)} ${fmt.dim('—')} ${cmd.description}`);
    }
    console.log('');
  }

  // Help information
  if (errorInfo.helpUrl || errorInfo.helpCommand) {
    console.log(fmt.bold('📖 Need More Help?'));
    if (errorInfo.helpCommand) {
      console.log(`  Run: ${fmt.cyan(errorInfo.helpCommand)}`);
    }
    if (errorInfo.helpUrl) {
      console.log(`  Docs: ${fmt.cyan(errorInfo.helpUrl)}`);
    }
    console.log('');
  }
}

/**
 * Parse error and categorize with solutions
 */
function parseError(error) {
  const message = error.message || String(error);

  // Provider authentication errors
  if (message.includes('not authenticated') || message.includes('invalid credentials')) {
    return {
      title: 'Authentication Error',
      message: 'AI provider is not properly authenticated',
      solutions: [
        {
          title: 'Authenticate Claude CLI',
          steps: [
            'Run: claude auth login',
            'Follow the browser authentication flow',
            'Verify with: claude auth status'
          ]
        },
        {
          title: 'Authenticate Codex CLI',
          steps: [
            'Run: codex login',
            'Enter your OpenAI API key',
            'Test with: codex --version'
          ]
        }
      ],
      commands: [
        { command: 'cortex --doctor', description: 'Check authentication status' },
        { command: 'cortex --status', description: 'Show provider health' }
      ],
      helpCommand: 'cortex --help',
      helpUrl: null
    };
  }

  // Provider not found errors
  if (message.includes('command not found') || message.includes('not installed')) {
    return {
      title: 'Provider Not Found',
      message: 'Required AI provider CLI is not installed',
      solutions: [
        {
          title: 'Install Claude CLI',
          steps: [
            'Run: pip install anthropic-cli',
            'Or: curl -fsSL https://claude.ai/install.sh | sh',
            'Verify with: claude --version'
          ]
        },
        {
          title: 'Install Codex CLI',
          steps: [
            'Run: npm install -g @openai/codex',
            'Or: pip install openai-codex',
            'Verify with: codex --version'
          ]
        }
      ],
      commands: [
        { command: 'cortex --doctor', description: 'Check provider installation' }
      ],
      helpCommand: 'cortex --doctor',
      helpUrl: null
    };
  }

  // Network/timeout errors
  if (message.includes('timeout') || message.includes('network') || message.includes('ECONNREFUSED')) {
    return {
      title: 'Connection Error',
      message: 'Unable to reach AI provider service',
      solutions: [
        {
          title: 'Check Internet Connection',
          steps: [
            'Verify you can reach external sites',
            'Check if you are behind a corporate firewall',
            'Try connecting to a different network'
          ]
        },
        {
          title: 'Check Provider Status',
          steps: [
            'Visit status.anthropic.com for Claude',
            'Visit status.openai.com for OpenAI',
            'Wait for service restoration if there are issues'
          ]
        },
        {
          title: 'Retry Operation',
          steps: [
            'Wait 30 seconds and try again',
            'Providers may have temporary rate limits'
          ]
        }
      ],
      commands: [
        { command: 'cortex --status', description: 'Check system status' },
        { command: 'ping anthropic.com', description: 'Test Claude connectivity' },
        { command: 'ping api.openai.com', description: 'Test OpenAI connectivity' }
      ],
      helpCommand: 'cortex --doctor',
      helpUrl: null
    };
  }

  // Rate limit errors
  if (message.includes('rate limit') || message.includes('quota exceeded') || message.includes('429')) {
    return {
      title: 'Rate Limit Exceeded',
      message: 'AI provider rate limit has been reached',
      solutions: [
        {
          title: 'Wait and Retry',
          steps: [
            'Wait for rate limit window to reset',
            'Most limits reset within an hour',
            'Try again with simpler requests'
          ]
        },
        {
          title: 'Use Alternative Provider',
          steps: [
            'Cortex can route to other available models',
            'Ensure both Claude and Codex are configured',
            'System will automatically balance load'
          ]
        },
        {
          title: 'Check Usage Patterns',
          steps: [
            'Run: cortex --trends',
            'Review recent usage patterns',
            'Consider breaking large tasks into smaller ones'
          ]
        }
      ],
      commands: [
        { command: 'cortex --trends', description: 'Check usage patterns' },
        { command: 'cortex --status', description: 'Check provider balance' }
      ],
      helpCommand: 'cortex --help',
      helpUrl: null
    };
  }

  // File permission errors
  if (message.includes('EACCES') || message.includes('permission denied')) {
    return {
      title: 'Permission Error',
      message: 'Insufficient permissions to access files or directories',
      solutions: [
        {
          title: 'Check Directory Permissions',
          steps: [
            'Ensure you can write to the current directory',
            'Check .cortex directory permissions',
            'Run: ls -la .cortex'
          ]
        },
        {
          title: 'Fix Permissions',
          steps: [
            'Run: chmod 755 .cortex',
            'Or: sudo chown -R $USER .cortex',
            'Retry the operation'
          ]
        }
      ],
      commands: [
        { command: 'ls -la .cortex', description: 'Check directory permissions' },
        { command: 'cortex --doctor', description: 'Run system health check' }
      ],
      helpCommand: 'cortex --doctor',
      helpUrl: null
    };
  }

  // Model not available errors
  if (message.includes('model not available') || message.includes('no models')) {
    return {
      title: 'No Models Available',
      message: 'No AI models are available for the requested tier',
      solutions: [
        {
          title: 'Check Provider Authentication',
          steps: [
            'Run: cortex --doctor',
            'Ensure at least one provider is authenticated',
            'Verify API keys are valid'
          ]
        },
        {
          title: 'Check Model Assignments',
          steps: [
            'Verify models are correctly assigned to tiers',
            'Check provider health status',
            'Try with a different tier'
          ]
        }
      ],
      commands: [
        { command: 'cortex --doctor', description: 'Check model availability' },
        { command: 'cortex --status', description: 'Show tier assignments' }
      ],
      helpCommand: 'cortex --doctor',
      helpUrl: null
    };
  }

  // Session/state errors
  if (message.includes('session') || message.includes('state')) {
    return {
      title: 'Session Error',
      message: 'Problem with session state management',
      solutions: [
        {
          title: 'Reset Session State',
          steps: [
            'Run: cortex --reset sessions',
            'This will clear current session but keep history',
            'Start a new session'
          ]
        },
        {
          title: 'Clean State Files',
          steps: [
            'Run: cortex --cleanup',
            'This will remove corrupted state files',
            'Keeps important data and settings'
          ]
        }
      ],
      commands: [
        { command: 'cortex --reset sessions', description: 'Reset current session' },
        { command: 'cortex --cleanup', description: 'Clean state files' },
        { command: 'cortex --recovery', description: 'Show recovery options' }
      ],
      helpCommand: 'cortex --help',
      helpUrl: null
    };
  }

  // Generic error fallback
  return {
    title: 'Unexpected Error',
    message: message,
    solutions: [
      {
        title: 'Run System Diagnostics',
        steps: [
          'Run: cortex --doctor',
          'Check for known issues and fixes',
          'Review system configuration'
        ]
      },
      {
        title: 'Reset if Needed',
        steps: [
          'Try: cortex --cleanup',
          'If problem persists: cortex --reset state',
          'Last resort: cortex --reset all'
        ]
      }
    ],
    commands: [
      { command: 'cortex --doctor', description: 'Comprehensive system check' },
      { command: 'cortex --cleanup', description: 'Clean temporary files' }
    ],
    helpCommand: 'cortex --help',
    helpUrl: null
  };
}

/**
 * Display a warning with context
 */
export function displayWarning(message, context = {}) {
  console.log(`${status.warning} ${fmt.warning(message)}`);

  if (context.suggestion) {
    console.log(`  ${status.info} ${context.suggestion}`);
  }

  if (context.command) {
    console.log(`  ${fmt.dim('Try:')} ${fmt.cyan(context.command)}`);
  }

  console.log('');
}

/**
 * Display an info message with context
 */
export function displayInfo(message, context = {}) {
  console.log(`${status.info} ${fmt.info(message)}`);

  if (context.details) {
    console.log(`  ${fmt.dim(context.details)}`);
  }

  console.log('');
}

/**
 * Display a success message with context
 */
export function displaySuccess(message, context = {}) {
  console.log(`${status.success} ${fmt.success(message)}`);

  if (context.details) {
    console.log(`  ${fmt.dim(context.details)}`);
  }

  if (context.nextStep) {
    console.log(`  ${fmt.dim('Next:')} ${context.nextStep}`);
  }

  console.log('');
}

/**
 * Create a formatted error box for critical errors
 */
export function createErrorBox(title, message, options = {}) {
  const content = [title];
  if (message) {
    content.push('');
    content.push(message);
  }

  return box(content.join('\n'), {
    borderColor: fmt.red(''),
    textColor: options.color || fmt.bold(''),
    padding: 1,
    margin: options.margin || 1
  });
}

/**
 * Handle graceful error display with context preservation
 */
export function handleError(error, context = {}) {
  // Log the full error for debugging if verbose
  if (process.env.DEBUG || process.argv.includes('--verbose')) {
    console.error('Full error:', error);
  }

  // Display user-friendly error
  displayError(error, context);

  // Offer to run doctor if this looks like a system issue
  if (isSystemIssue(error)) {
    console.log(fmt.dim('💡 Tip: Run ') + fmt.cyan('cortex --doctor') + fmt.dim(' to diagnose system issues'));
    console.log('');
  }
}

/**
 * Check if this looks like a system configuration issue
 */
function isSystemIssue(error) {
  const message = error.message || String(error);
  const systemIndicators = [
    'not authenticated',
    'command not found',
    'not installed',
    'permission denied',
    'no models available',
    'EACCES',
    'ECONNREFUSED'
  ];

  return systemIndicators.some(indicator => message.includes(indicator));
}