import type { Tier } from '../core/types.js';
import type { ProviderId } from '../providers/port.js';
import { formatTokens } from '../infra/insights.js';

export interface NarrationTier {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly attempt: number;
}

export interface NarrationTool {
  readonly name: string;
  readonly phase: 'start' | 'end';
  readonly detail?: string;
}

export interface NarrationTierResult {
  readonly success: boolean;
  readonly confidence: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
}

function normalizeReasoning(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function renderConfidence(confidence: number | null): string {
  if (confidence === null) return 'unrated';
  return `${Math.round(confidence * 100)}%`;
}

function renderTool(tool: NarrationTool): string {
  const detail = tool.detail !== undefined && tool.detail.length > 0 ? ` ${tool.detail}` : '';
  return `  - ${tool.name}${detail}`;
}

function toolKey(tool: NarrationTool): string {
  return `${tool.name}\u0000${tool.detail ?? ''}`;
}

export class VerboseNarrationFormatter {
  private reasoningLabelOpen = false;
  private toolsLabelOpen = false;
  private reasoningBuffer = '';
  private lastReasoningNormalized: string | null = null;
  private activeToolKey: string | null = null;
  private lastToolLine: string | null = null;

  beginTier(tier: NarrationTier): readonly string[] {
    return [`Activity: ${tier.tier} (${tier.provider}/${tier.model}) attempt ${tier.attempt}`];
  }

  pushReasoning(delta: string): readonly string[] {
    if (delta.length === 0) return [];
    this.reasoningBuffer += delta;
    return this.drainReasoning(false);
  }

  pushTool(tool: NarrationTool): readonly string[] {
    const key = toolKey(tool);
    if (tool.phase === 'start') {
      if (this.activeToolKey === key) return [];
      this.activeToolKey = key;
      return this.emitTool(renderTool(tool));
    }
    if (this.activeToolKey === key) {
      this.activeToolKey = null;
      return [];
    }
    return this.emitTool(`${renderTool(tool)} (${tool.phase})`);
  }

  endTier(result: NarrationTierResult): readonly string[] {
    const lines = [...this.flush()];
    const tokens = result.inputTokens + result.outputTokens;
    lines.push(
      `${result.success ? '✓' : '✗'} tier done — ` +
      `confidence: ${renderConfidence(result.confidence)}, ` +
      `${formatTokens(tokens)} tokens, duration: ${result.durationMs}ms`,
    );
    this.reset();
    return lines;
  }

  flush(): readonly string[] {
    return this.drainReasoning(true);
  }

  private emitTool(line: string): readonly string[] {
    if (line === this.lastToolLine) return [];
    const lines: string[] = [];
    if (!this.toolsLabelOpen) {
      lines.push('Tools:');
      this.toolsLabelOpen = true;
    }
    lines.push(line);
    this.lastToolLine = line;
    return lines;
  }

  private drainReasoning(flushTail: boolean): readonly string[] {
    const lines: string[] = [];
    while (true) {
      const newline = this.reasoningBuffer.indexOf('\n');
      if (newline === -1) break;
      const raw = this.reasoningBuffer.slice(0, newline);
      this.reasoningBuffer = this.reasoningBuffer.slice(newline + 1);
      this.emitReasoningLine(raw, lines);
    }
    if (flushTail && this.reasoningBuffer.length > 0) {
      const tail = this.reasoningBuffer;
      this.reasoningBuffer = '';
      this.emitReasoningLine(tail, lines);
    }
    return lines;
  }

  private emitReasoningLine(raw: string, lines: string[]): void {
    const normalized = normalizeReasoning(raw);
    if (normalized.length === 0) return;
    if (normalized === this.lastReasoningNormalized) return;
    if (!this.reasoningLabelOpen) {
      lines.push('Reasoning:');
      this.reasoningLabelOpen = true;
    }
    lines.push(`  - ${normalized}`);
    this.lastReasoningNormalized = normalized;
  }

  private reset(): void {
    this.reasoningLabelOpen = false;
    this.toolsLabelOpen = false;
    this.reasoningBuffer = '';
    this.lastReasoningNormalized = null;
    this.activeToolKey = null;
    this.lastToolLine = null;
  }
}
