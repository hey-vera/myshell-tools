/**
 * formatter.mjs — Rich terminal output formatting utilities
 */

/**
 * Colors and formatting
 */
export const colors = {
  // Basic colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Extended colors
  orange: '\x1b[38;5;208m',
  brightBlue: '\x1b[38;5;33m',
  brightGreen: '\x1b[38;5;40m',
  purple: '\x1b[38;5;135m',

  // Formatting
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

/**
 * Helper functions for color formatting
 */
export const fmt = {
  red: (text) => `${colors.red}${text}${colors.reset}`,
  green: (text) => `${colors.green}${text}${colors.reset}`,
  yellow: (text) => `${colors.yellow}${text}${colors.reset}`,
  blue: (text) => `${colors.blue}${text}${colors.reset}`,
  magenta: (text) => `${colors.magenta}${text}${colors.reset}`,
  cyan: (text) => `${colors.cyan}${text}${colors.reset}`,
  orange: (text) => `${colors.orange}${text}${colors.reset}`,
  brightBlue: (text) => `${colors.brightBlue}${text}${colors.reset}`,
  brightGreen: (text) => `${colors.brightGreen}${text}${colors.reset}`,
  purple: (text) => `${colors.purple}${text}${colors.reset}`,

  bold: (text) => `${colors.bold}${text}${colors.reset}`,
  dim: (text) => `${colors.dim}${text}${colors.reset}`,
  italic: (text) => `${colors.italic}${text}${colors.reset}`,
  underline: (text) => `${colors.underline}${text}${colors.reset}`,

  success: (text) => `${colors.bold}${colors.green}${text}${colors.reset}`,
  error: (text) => `${colors.bold}${colors.red}${text}${colors.reset}`,
  warning: (text) => `${colors.bold}${colors.yellow}${text}${colors.reset}`,
  info: (text) => `${colors.bold}${colors.blue}${text}${colors.reset}`,

  // Combinations
  redBold: (text) => `${colors.bold}${colors.red}${text}${colors.reset}`,
  greenBold: (text) => `${colors.bold}${colors.green}${text}${colors.reset}`,
  yellowBold: (text) => `${colors.bold}${colors.yellow}${text}${colors.reset}`,
  blueBold: (text) => `${colors.bold}${colors.blue}${text}${colors.reset}`,
  orangeBold: (text) => `${colors.bold}${colors.orange}${text}${colors.reset}`,

  // Add formatModel to fmt object for easier access
  formatModel: formatModel,
  // Add providerBalanceBar to fmt object
  providerBalanceBar: providerBalanceBar
};

/**
 * Tier color mapping for consistent hierarchy display
 */
export const tierColors = {
  worker: colors.blue,
  ic: colors.yellow,
  manager: colors.red,
  system: colors.cyan
};

/**
 * Format tier name with appropriate color
 */
export function formatTier(tier) {
  const color = tierColors[tier] || colors.white;
  return `${color}${colors.bold}${tier.toUpperCase()}${colors.reset}`;
}

/**
 * Create a visual tree structure
 */
export function createTree(items, options = {}) {
  const { indent = '  ', branch = '├─', lastBranch = '└─', continuation = '│ ' } = options;
  const lines = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = i === items.length - 1;
    const prefix = isLast ? lastBranch : branch;

    if (typeof item === 'string') {
      lines.push(`${indent}${prefix} ${item}`);
    } else if (item.text) {
      lines.push(`${indent}${prefix} ${item.text}`);
      if (item.children && item.children.length > 0) {
        const childLines = createTree(item.children, {
          ...options,
          indent: indent + (isLast ? '  ' : continuation)
        });
        lines.push(...childLines);
      }
    }
  }

  return lines;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(milliseconds) {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }

  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }

  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

/**
 * Format confidence level with color coding
 */
export function formatConfidence(confidence) {
  const percent = Math.round(confidence * 100);

  if (confidence >= 0.8) {
    return `${colors.green}${percent}%${colors.reset}`;
  } else if (confidence >= 0.6) {
    return `${colors.yellow}${percent}%${colors.reset}`;
  } else {
    return `${colors.red}${percent}%${colors.reset}`;
  }
}

/**
 * Create a horizontal separator line
 */
export function separator(length = 60, char = '═', color = colors.blue) {
  return `${color}${char.repeat(length)}${colors.reset}`;
}

/**
 * Create a bordered box around text
 */
export function box(text, options = {}) {
  const {
    padding = 1,
    margin = 0,
    borderColor = colors.blue,
    textColor = colors.reset,
    width = null
  } = options;

  const lines = text.split('\n');
  const maxLineLength = width || Math.max(...lines.map(line => line.length));
  const totalWidth = maxLineLength + (padding * 2);

  const topBorder = `${borderColor}╭${'─'.repeat(totalWidth)}╮${colors.reset}`;
  const bottomBorder = `${borderColor}╰${'─'.repeat(totalWidth)}╯${colors.reset}`;

  const result = [];

  // Add margin above
  for (let i = 0; i < margin; i++) {
    result.push('');
  }

  result.push(topBorder);

  for (const line of lines) {
    const paddedLine = line.padEnd(maxLineLength);
    result.push(`${borderColor}│${' '.repeat(padding)}${textColor}${paddedLine}${' '.repeat(padding)}${borderColor}│${colors.reset}`);
  }

  result.push(bottomBorder);

  // Add margin below
  for (let i = 0; i < margin; i++) {
    result.push('');
  }

  return result.join('\n');
}

/**
 * Format a progress bar
 */
export function progressBar(current, total, options = {}) {
  const {
    width = 20,
    filled = '█',
    empty = '░',
    showPercent = true,
    color = colors.green
  } = options;

  const progress = Math.min(current / total, 1);
  const filledWidth = Math.round(progress * width);
  const emptyWidth = width - filledWidth;

  const bar = `${color}${filled.repeat(filledWidth)}${colors.dim}${empty.repeat(emptyWidth)}${colors.reset}`;

  if (showPercent) {
    const percent = Math.round(progress * 100);
    return `${bar} ${percent}%`;
  }

  return bar;
}

/**
 * Format provider balance bar (like dual-brain)
 */
export function providerBalanceBar(claudePercent, openaiPercent, options = {}) {
  const { width = 20, label = true } = options;

  if (claudePercent === 0 && openaiPercent === 0) {
    const bar = fmt.dim('░'.repeat(width));
    return label ? `${bar}  no activity` : bar;
  }

  const claudeFill = Math.round((claudePercent / 100) * width);
  const openaieFill = width - claudeFill;

  const claudeBar = fmt.orange('█'.repeat(claudeFill));
  const openaiBar = fmt.green('▓'.repeat(openaieFill));

  const bar = `${claudeBar}${openaiBar}`;

  if (label) {
    return `${bar}  ${fmt.orange(claudePercent + '%')} Claude · ${fmt.green(openaiPercent + '%')} GPT`;
  }

  return bar;
}

/**
 * Format time ago (like dual-brain)
 */
export function timeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text, maxLength = 50) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 1) + '…';
}

/**
 * Format model name consistently
 */
export function formatModel(provider, model) {
  if (provider === 'claude') {
    return fmt.orange(`${provider}/${model}`);
  } else if (provider === 'openai' || provider === 'codex') {
    return fmt.green(`GPT/${model}`);
  }
  return fmt.dim(`${provider}/${model}`);
}

/**
 * Create a status indicator
 */
export function statusIndicator(status) {
  switch (status) {
    case 'success':
    case 'ready':
    case 'active':
      return fmt.green('✅');
    case 'warning':
    case 'partial':
      return fmt.yellow('⚠️');
    case 'error':
    case 'failed':
      return fmt.red('❌');
    case 'loading':
    case 'processing':
      return fmt.blue('🔄');
    case 'info':
      return fmt.blue('💡');
    case 'docs':
      return fmt.blue('📖');
    default:
      return fmt.dim('●');
  }
}