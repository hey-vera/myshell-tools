/**
 * src/providers/claude-parse.ts — pure JSONL parser for `claude -p --output-format stream-json`.
 *
 * PURE MODULE: no I/O, no execa, no side effects. All logic is a function from
 * string → ProviderEvent[]. This is the hermetic, fixture-tested heart of the
 * Claude adapter.
 *
 * Stream-json schema (matched from the captured fixture):
 *  - rate_limit_event           → emit nothing
 *  - system/init                → emit nothing
 *  - assistant                  → text/tool events per content[] item
 *  - result/success             → usage event + done event
 *  - result/is_error or !success → usage event + error event
 *  - unparseable line           → emit nothing (skip)
 */

import type { ProviderEvent, Usage } from './port.js';
import { classifyError } from './errors.js';

// ---------------------------------------------------------------------------
// Internal shape of the wire format (just what we need)
// ---------------------------------------------------------------------------

interface WireUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface WireContentText {
  readonly type: 'text';
  readonly text: string;
}

interface WireContentToolUse {
  readonly type: 'tool_use';
  readonly name: string;
}

type WireContent = WireContentText | WireContentToolUse | { readonly type: string };

interface WireAssistantEvent {
  readonly type: 'assistant';
  readonly message: {
    readonly content: readonly WireContent[];
    readonly usage?: WireUsage;
  };
}

interface WireResultEvent {
  readonly type: 'result';
  readonly subtype: string;
  readonly is_error: boolean;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly usage?: WireUsage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(u: WireUsage): Usage {
  const base: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };

  // exactOptionalPropertyTypes: only include cachedInputTokens if it is a
  // number — omit the key entirely otherwise.
  if (typeof u.cache_read_input_tokens === 'number') {
    return { ...base, cachedInputTokens: u.cache_read_input_tokens };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line from `claude --output-format stream-json` stdout.
 *
 * Returns 0 or more {@link ProviderEvent}s. Returns an empty array for:
 *  - Lines that fail JSON.parse
 *  - Event types we intentionally ignore (rate_limit_event, system/init)
 */
export function parseClaudeLine(line: string): ProviderEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];

  const obj = parsed as Record<string, unknown>;
  const eventType = obj['type'];

  // -------------------------------------------------------------------------
  // rate_limit_event / system — emit nothing
  // -------------------------------------------------------------------------
  if (eventType === 'rate_limit_event' || eventType === 'system') {
    return [];
  }

  // -------------------------------------------------------------------------
  // assistant — emit text/tool events per content[] item
  // Do NOT emit usage from assistant events (it's intermediate).
  // -------------------------------------------------------------------------
  if (eventType === 'assistant') {
    const ev = parsed as WireAssistantEvent;
    const events: ProviderEvent[] = [];

    for (const item of ev.message.content) {
      if (item.type === 'text') {
        const textItem = item as WireContentText;
        events.push({ type: 'text', delta: textItem.text });
      } else if (item.type === 'tool_use') {
        const toolItem = item as WireContentToolUse;
        events.push({ type: 'tool', name: toolItem.name, phase: 'start' });
      }
      // Other content types: ignore
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // result — emit usage event + done or error event
  // -------------------------------------------------------------------------
  if (eventType === 'result') {
    const ev = parsed as WireResultEvent;
    const events: ProviderEvent[] = [];

    const usage: Usage = ev.usage ? mapUsage(ev.usage) : { inputTokens: 0, outputTokens: 0 };

    // Always emit usage first
    events.push({ type: 'usage', usage });

    const isFailure = ev.is_error === true || ev.subtype !== 'success';

    if (isFailure) {
      const errorText = String(ev.result ?? ev.subtype ?? 'unknown error');
      events.push({ type: 'error', error: classifyError(errorText, 1) });
    } else {
      const resultText = ev.result ?? '';
      const doneEvent: ProviderEvent = {
        type: 'done',
        text: resultText,
        usage,
        ...(typeof ev.total_cost_usd === 'number' ? { costUsd: ev.total_cost_usd } : {}),
        raw: parsed,
      };
      events.push(doneEvent);
    }

    return events;
  }

  // Unknown event type — emit nothing
  return [];
}
