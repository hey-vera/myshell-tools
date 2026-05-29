/**
 * icons.mjs — Unicode symbols and visual indicators
 */

/**
 * Status icons
 */
export const status = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: '💡',
  loading: '🔄',
  docs: '📖',
  checkmark: '✓',
  cross: '✗',
  bullet: '●',
  diamond: '◆',
  triangle: '▲',
  square: '■',
  circle: '○',
  star: '★',
  heart: '♥',
  brain: '🧠',
  robot: '🤖',
  gear: '⚙️',
  rocket: '🚀',
  fire: '🔥',
  lightning: '⚡',
  shield: '🛡️',
  crown: '👑',
  crystal: '💎',
  target: '🎯'
};

/**
 * Provider and model icons
 */
export const provider = {
  claude: '🟠',
  openai: '🟢',
  codex: '🟢',
  anthropic: '🟠',
  gpt: '🟢'
};

/**
 * Tier/role icons
 */
export const tier = {
  manager: '👔',
  ic: '👨‍💻',
  worker: '🏗️',
  search: '🔍',
  execute: '⚡',
  think: '🧠',
  review: '👀',
  architect: '🏛️',
  debug: '🐛',
  test: '🧪',
  deploy: '🚀',
  security: '🔒',
  docs: '📝'
};

/**
 * Progress and activity icons
 */
export const progress = {
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  dots: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  blocks: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
  clock: ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛']
};

/**
 * Tree structure characters
 */
export const tree = {
  branch: '├─',
  lastBranch: '└─',
  pipe: '│',
  space: ' ',
  tee: '├',
  corner: '└',
  horizontal: '─',
  vertical: '│'
};

/**
 * Box drawing characters
 */
export const box = {
  // Single line
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',

  // Double line
  doubleTopLeft: '╔',
  doubleTopRight: '╗',
  doubleBottomLeft: '╚',
  doubleBottomRight: '╝',
  doubleHorizontal: '═',
  doubleVertical: '║',

  // Heavy line
  heavyTopLeft: '┏',
  heavyTopRight: '┓',
  heavyBottomLeft: '┗',
  heavyBottomRight: '┛',
  heavyHorizontal: '━',
  heavyVertical: '┃'
};

/**
 * Progress bar characters
 */
export const progressChars = {
  filled: '█',
  empty: '░',
  partial: ['▏', '▎', '▍', '▌', '▋', '▊', '▉'],
  blocks: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  dots: '⣿',
  emptyDots: '⣀'
};

/**
 * Confidence level icons
 */
export const confidence = {
  high: '🟢',     // >= 80%
  medium: '🟡',   // 60-79%
  low: '🟠',      // 40-59%
  veryLow: '🔴'   // < 40%
};

/**
 * Get confidence icon based on numeric value
 */
export function getConfidenceIcon(value) {
  if (value >= 0.8) return confidence.high;
  if (value >= 0.6) return confidence.medium;
  if (value >= 0.4) return confidence.low;
  return confidence.veryLow;
}

/**
 * Model-specific icons
 */
export const models = {
  // Claude models
  opus: '👔',      // Manager tier
  sonnet: '👨‍💻',   // IC tier
  haiku: '🏗️',     // Worker tier

  // GPT models
  'gpt-5.5': '👔',
  'gpt-5.4': '👨‍💻',
  'gpt-4.1-mini': '🏗️',
  'gpt-4.1': '👨‍💻',
  'gpt-4': '👨‍💻',
  'gpt-3.5': '🏗️'
};

/**
 * Get model icon by name
 */
export function getModelIcon(modelName) {
  if (!modelName) return tier.worker;

  const name = modelName.toLowerCase();

  // Check exact matches first
  if (models[name]) return models[name];

  // Check partial matches
  if (name.includes('opus')) return models.opus;
  if (name.includes('sonnet')) return models.sonnet;
  if (name.includes('haiku')) return models.haiku;
  if (name.includes('gpt-5.5')) return models['gpt-5.5'];
  if (name.includes('gpt-5.4')) return models['gpt-5.4'];
  if (name.includes('gpt-4.1-mini') || name.includes('mini')) return models['gpt-4.1-mini'];
  if (name.includes('gpt-4.1')) return models['gpt-4.1'];
  if (name.includes('gpt-4')) return models['gpt-4'];
  if (name.includes('gpt-3.5')) return models['gpt-3.5'];

  // Default fallback
  return tier.worker;
}

/**
 * Activity/action icons
 */
export const actions = {
  start: '▶️',
  stop: '⏹️',
  pause: '⏸️',
  restart: '🔄',
  create: '➕',
  delete: '🗑️',
  edit: '✏️',
  save: '💾',
  load: '📂',
  upload: '⬆️',
  download: '⬇️',
  sync: '🔄',
  backup: '💾',
  restore: '🔄',
  configure: '⚙️',
  install: '📦',
  uninstall: '🗑️',
  upgrade: '⬆️',
  downgrade: '⬇️',
  reset: '🔄',
  clear: '🧹',
  search: '🔍',
  filter: '🔎',
  sort: '📊',
  export: '📤',
  import: '📥',
  copy: '📋',
  cut: '✂️',
  paste: '📋',
  undo: '↶',
  redo: '↷'
};

/**
 * Session state icons
 */
export const session = {
  new: '🆕',
  active: '🟢',
  paused: '⏸️',
  completed: '✅',
  failed: '❌',
  interrupted: '⚠️',
  archived: '📦',
  deleted: '🗑️'
};

/**
 * File operation icons
 */
export const files = {
  read: '📖',
  write: '✏️',
  create: '➕',
  delete: '🗑️',
  move: '📦',
  copy: '📋',
  folder: '📁',
  file: '📄',
  code: '💻',
  config: '⚙️',
  data: '📊',
  image: '🖼️',
  document: '📝',
  archive: '📦',
  lock: '🔒',
  unlock: '🔓'
};

/**
 * System health icons
 */
export const health = {
  healthy: '💚',
  warning: '💛',
  critical: '❤️',
  unknown: '🤍',
  offline: '💔',
  maintenance: '🔧',
  degraded: '⚠️'
};

/**
 * Networking icons
 */
export const network = {
  connected: '🌐',
  disconnected: '📡',
  uploading: '⬆️',
  downloading: '⬇️',
  syncing: '🔄',
  error: '💥',
  timeout: '⏰',
  retry: '🔄'
};

/**
 * Get a random spinner frame
 */
export function getSpinnerFrame(index) {
  return progress.spinner[index % progress.spinner.length];
}

/**
 * Create a simple spinner animation
 */
export function createSpinner() {
  let frame = 0;
  return {
    tick() {
      const icon = getSpinnerFrame(frame);
      frame++;
      return icon;
    },
    stop() {
      frame = 0;
    }
  };
}