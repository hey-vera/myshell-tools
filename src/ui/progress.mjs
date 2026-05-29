/**
 * progress.mjs — Progress indicators and loading animations
 */

import { colors, fmt } from './formatter.mjs';
import { progress as progressIcons, getSpinnerFrame } from './icons.mjs';

/**
 * Spinner class for animated loading indicators
 */
export class Spinner {
  constructor(options = {}) {
    this.frames = options.frames || progressIcons.spinner;
    this.interval = options.interval || 100;
    this.text = options.text || '';
    this.color = options.color || colors.blue;

    this.currentFrame = 0;
    this.timer = null;
    this.isSpinning = false;
  }

  start(text) {
    if (text) this.text = text;
    this.isSpinning = true;
    this.currentFrame = 0;

    this.timer = setInterval(() => {
      this.render();
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, this.interval);

    // Initial render
    this.render();
    return this;
  }

  stop(finalText = null) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isSpinning = false;

    // Clear the line and show final message
    process.stdout.write('\r\x1b[K');
    if (finalText !== null) {
      process.stdout.write(finalText + '\n');
    }

    return this;
  }

  updateText(text) {
    this.text = text;
    if (this.isSpinning) {
      this.render();
    }
    return this;
  }

  render() {
    const frame = this.frames[this.currentFrame];
    const coloredFrame = `${this.color}${frame}${colors.reset}`;
    const line = `\r${coloredFrame} ${this.text}`;
    process.stdout.write(line);
  }

  success(text) {
    return this.stop(fmt.green(`✅ ${text || this.text}`));
  }

  error(text) {
    return this.stop(fmt.red(`❌ ${text || this.text}`));
  }

  warning(text) {
    return this.stop(fmt.yellow(`⚠️ ${text || this.text}`));
  }

  info(text) {
    return this.stop(fmt.blue(`💡 ${text || this.text}`));
  }
}

/**
 * Progress bar for deterministic progress
 */
export class ProgressBar {
  constructor(options = {}) {
    this.total = options.total || 100;
    this.width = options.width || 30;
    this.format = options.format || ':bar :current/:total (:percent)';
    this.complete = options.complete || '█';
    this.incomplete = options.incomplete || '░';
    this.color = options.color || colors.green;
    this.clear = options.clear !== false;

    this.current = 0;
    this.startTime = Date.now();
  }

  tick(delta = 1, tokens = {}) {
    this.current = Math.min(this.current + delta, this.total);
    this.render(tokens);

    if (this.current >= this.total && this.clear) {
      this.complete();
    }
  }

  update(current, tokens = {}) {
    this.current = Math.min(current, this.total);
    this.render(tokens);

    if (this.current >= this.total && this.clear) {
      this.complete();
    }
  }

  render(tokens = {}) {
    const percent = Math.round((this.current / this.total) * 100);
    const completed = Math.round((this.current / this.total) * this.width);
    const remaining = this.width - completed;

    const completedBar = this.complete.repeat(completed);
    const remainingBar = this.incomplete.repeat(remaining);
    const bar = `${this.color}${completedBar}${colors.dim}${remainingBar}${colors.reset}`;

    const elapsed = Date.now() - this.startTime;
    const rate = this.current / (elapsed / 1000);
    const eta = this.current > 0 ? (this.total - this.current) / rate : 0;

    const formatTokens = {
      ':bar': bar,
      ':current': this.current,
      ':total': this.total,
      ':percent': `${percent}%`,
      ':elapsed': this.formatTime(elapsed / 1000),
      ':eta': this.formatTime(eta),
      ':rate': rate.toFixed(1),
      ...tokens
    };

    let output = this.format;
    for (const [token, value] of Object.entries(formatTokens)) {
      output = output.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    }

    process.stdout.write(`\r${output}`);
  }

  complete() {
    process.stdout.write('\n');
  }

  formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  }
}

/**
 * Multi-line progress tracker for complex operations
 */
export class MultiProgress {
  constructor() {
    this.items = new Map();
    this.isRendering = false;
    this.renderTimer = null;
  }

  add(id, options = {}) {
    const item = {
      id,
      text: options.text || id,
      status: options.status || 'pending', // pending, running, success, error
      progress: options.progress || 0,
      total: options.total || 100,
      color: options.color || colors.blue,
      showProgress: options.showProgress !== false
    };

    this.items.set(id, item);
    this.render();
    return item;
  }

  update(id, updates) {
    const item = this.items.get(id);
    if (!item) return;

    Object.assign(item, updates);
    this.render();
    return item;
  }

  success(id, text) {
    return this.update(id, { status: 'success', text: text || this.items.get(id)?.text });
  }

  error(id, text) {
    return this.update(id, { status: 'error', text: text || this.items.get(id)?.text });
  }

  start(id, text) {
    return this.update(id, { status: 'running', text: text || this.items.get(id)?.text });
  }

  complete() {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.isRendering = false;
    process.stdout.write('\n');
  }

  render() {
    if (this.items.size === 0) return;

    // Move cursor to beginning of our section
    const lineCount = this.items.size;
    if (this.isRendering) {
      process.stdout.write(`\x1b[${lineCount}A`);
    }
    this.isRendering = true;

    for (const item of this.items.values()) {
      const statusIcon = this.getStatusIcon(item.status);
      const progressText = item.showProgress && item.total > 0
        ? this.formatProgress(item.progress, item.total)
        : '';

      const line = `${statusIcon} ${item.text}${progressText}`;
      process.stdout.write(`\r\x1b[K${line}\n`);
    }

    // Move cursor back up to the end of our section
    process.stdout.write(`\x1b[${lineCount}A`);
  }

  getStatusIcon(status) {
    switch (status) {
      case 'pending': return fmt.dim('○');
      case 'running': return fmt.blue('●');
      case 'success': return fmt.green('✅');
      case 'error': return fmt.red('❌');
      default: return fmt.dim('○');
    }
  }

  formatProgress(current, total) {
    if (total <= 0) return '';
    const percent = Math.round((current / total) * 100);
    return fmt.dim(` (${percent}%)`);
  }
}

/**
 * Simple loading dots animation
 */
export class LoadingDots {
  constructor(text = 'Loading', maxDots = 3) {
    this.baseText = text;
    this.maxDots = maxDots;
    this.currentDots = 0;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.render();
      this.currentDots = (this.currentDots + 1) % (this.maxDots + 1);
    }, 500);

    this.render();
    return this;
  }

  stop(finalText = null) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    process.stdout.write('\r\x1b[K');
    if (finalText !== null) {
      process.stdout.write(finalText + '\n');
    }

    return this;
  }

  render() {
    const dots = '.'.repeat(this.currentDots);
    const spaces = ' '.repeat(this.maxDots - this.currentDots);
    process.stdout.write(`\r${this.baseText}${dots}${spaces}`);
  }
}

/**
 * Hierarchical progress display for AI orchestration
 */
export class HierarchicalProgress {
  constructor() {
    this.agents = new Map(); // id -> { tier, status, text, confidence, model }
    this.isActive = false;
  }

  addAgent(id, options = {}) {
    const agent = {
      id,
      tier: options.tier || 'worker',
      status: 'starting',
      text: options.text || `${options.tier} agent`,
      confidence: options.confidence || null,
      model: options.model || null,
      startTime: Date.now(),
      ...options
    };

    this.agents.set(id, agent);
    this.render();
    return agent;
  }

  updateAgent(id, updates) {
    const agent = this.agents.get(id);
    if (!agent) return;

    Object.assign(agent, updates);
    this.render();
    return agent;
  }

  escalate(fromId, toId, toTier, reason) {
    this.updateAgent(fromId, { status: 'escalating' });

    this.addAgent(toId, {
      tier: toTier,
      text: `${toTier.toUpperCase()}: ${reason}`,
      status: 'thinking'
    });

    this.render();
  }

  delegate(fromId, toId, toTier, task) {
    this.addAgent(toId, {
      tier: toTier,
      text: `${toTier.toUpperCase()}: ${task}`,
      status: 'working'
    });

    this.render();
  }

  complete(id, result = null) {
    const agent = this.agents.get(id);
    if (!agent) return;

    this.updateAgent(id, {
      status: 'completed',
      text: result || agent.text,
      endTime: Date.now()
    });

    // Show final summary
    setTimeout(() => this.finish(), 1000);
  }

  fail(id, error) {
    this.updateAgent(id, {
      status: 'failed',
      text: `${error}`,
      endTime: Date.now()
    });
  }

  render() {
    if (this.agents.size === 0) return;

    console.log('\n' + fmt.bold('🔄 AI Orchestration Active:'));

    // Group by tier for hierarchical display
    const tiers = ['manager', 'ic', 'worker'];
    const tierColors = {
      manager: colors.red,
      ic: colors.yellow,
      worker: colors.blue
    };

    for (const tier of tiers) {
      const tierAgents = Array.from(this.agents.values()).filter(a => a.tier === tier);
      if (tierAgents.length === 0) continue;

      const tierColor = tierColors[tier];
      const tierIcon = tier === 'manager' ? '👔' : tier === 'ic' ? '👨‍💻' : '🏗️';

      console.log(`  ${tierColor}${tierIcon} ${tier.toUpperCase()}${colors.reset}`);

      for (const agent of tierAgents) {
        const statusIcon = this.getAgentStatusIcon(agent.status);
        const confidenceText = agent.confidence
          ? ` • confidence: ${fmt.dim((agent.confidence * 100).toFixed(0) + '%')}`
          : '';

        console.log(`    ${statusIcon} ${agent.text}${confidenceText}`);

        if (agent.model) {
          console.log(`      ${fmt.dim(`└─ ${agent.model}`)}`);
        }
      }
    }
  }

  getAgentStatusIcon(status) {
    switch (status) {
      case 'starting': return fmt.blue('🔄');
      case 'thinking': return fmt.blue('🧠');
      case 'working': return fmt.yellow('⚡');
      case 'escalating': return fmt.orange('↗️');
      case 'completed': return fmt.green('✅');
      case 'failed': return fmt.red('❌');
      default: return fmt.dim('○');
    }
  }

  finish() {
    console.log('');
    this.agents.clear();
    this.isActive = false;
  }
}

/**
 * Create a simple spinner with common presets
 */
export function createSpinner(text, preset = 'default') {
  const presets = {
    default: { frames: progressIcons.spinner, color: colors.blue },
    dots: { frames: progressIcons.dots, color: colors.green },
    clock: { frames: progressIcons.clock, color: colors.yellow },
    arrow: { frames: progressIcons.arrow, color: colors.cyan }
  };

  const options = presets[preset] || presets.default;
  return new Spinner({ text, ...options });
}

/**
 * Show a loading animation for a promise
 */
export async function withSpinner(promise, text, options = {}) {
  const spinner = createSpinner(text, options.preset);
  spinner.start();

  try {
    const result = await promise;
    spinner.success(options.successText || `${text} completed`);
    return result;
  } catch (error) {
    spinner.error(options.errorText || `${text} failed`);
    throw error;
  }
}