// PROVISIONAL: schema modeled on claude-parse; pending live-transcript reconciliation (G2).

/**
 * src/providers/grok-parse.ts — pure JSONL parser for `grok --single --output-format streaming-json`.
 *
 * PURE MODULE: no I/O, no execa, no side effects. All logic is a function from
 * string → ProviderEvent[]. This is the hermetic, fixture-tested heart of the
 * grok adapter.
 *
 * grok is a Claude-Code clone, so its streaming-json schema is modeled on the
 * captured Claude fixtures. The parser is intentionally TOLERANT: it never
 * throws on a malformed line. Event types that do not map cleanly are skipped
 * rather than surfacing as errors, because the live grok transcript has not yet
 * been reconciled (see DESIGN-GROK.md G2).
 *
 * Modeled event handling:
 *  - rate_limit_event           → emit nothing
 *  - system/init                → emit nothing
 *  - stream_event/content_block_delta/text_delta → ONE text event per delta
 *    (this is how prose streams LIVE). All other stream_event subtypes
 *    (message_start, content_block_start, content_block_stop, message_delta,
 *    message_stop, thinking_delta, signature_delta, input_json_delta) → nothing.
 *  - assistant                  → tool events for tool_use blocks ONLY.
 *    Text blocks are INTENTIONALLY NOT emitted: the full text already streamed
 *    via text_delta deltas above, so re-emitting the assistant text block would
 *    DOUBLE the visible prose. Deltas own text; the assistant event owns tools.
 *    A tool_use block's `input` yields an optional human-readable `detail`
 *    (file_path/path/command/pattern) for the live-action target.
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

interface WireContentToolUse {
  readonly type: 'tool_use';
  readonly name: string;
  readonly input?: unknown;
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

/**
 * Derive a human-readable live-action target from a tool_use block's `input`.
 * Pure and fail-soft: returns the raw target string (the UI layer truncates /
 * formats it, matching claude/codex/opencode's raw-detail convention) or `undefined`
 * when no recognizable field is present. Never throws.
 *
 * Preference order mirrors the common Claude tool shapes (grok's tool schema is
 * expected to be similar, but this is PROVISIONAL — see top comment):
 *  file_path → path → command (capped) → pattern → undefined.
 */
function toolDetail(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const inp = input as Record<string, unknown>;

  if (typeof inp['file_path'] === 'string' && inp['file_path'].length > 0) {
    return inp['file_path'];
  }
  if (typeof inp['path'] === 'string' && inp['path'].length > 0) {
    return inp['path'];
  }
  if (typeof inp['command'] === 'string' && inp['command'].length > 0) {
    return inp['command'].slice(0, 60);
  }
  if (typeof inp['pattern'] === 'string' && inp['pattern'].length > 0) {
    return inp['pattern'];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line from `grok --output-format streaming-json` stdout.
 *
 * Returns 0 or more {@link ProviderEvent}s. Returns an empty array for:
 *  - Lines that fail JSON.parse
 *  - Event types we intentionally ignore (rate_limit_event, system/init)
 *
 * PROVISIONAL: modeled on claude-parse.ts. Reconcile against a real grok
 * streaming-json transcript during G2 live verification.
 */
export function parseGrokLine(line: string): ProviderEvent[] {
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
  // stream_event — raw API SSE deltas.
  // We stream PROSE live from content_block_delta/text_delta. Every other
  // subtype (message_start, content_block_start/stop, message_delta/stop,
  // thinking_delta, signature_delta, input_json_delta, …) is IGNORED — thinking
  // is not surfaced as prose, and structural frames carry no visible text.
  // -------------------------------------------------------------------------
  if (eventType === 'stream_event') {
    const event = obj['event'];
    if (typeof event !== 'object' || event === null) return [];

    const ev = event as Record<string, unknown>;
    if (ev['type'] !== 'content_block_delta') return [];

    const delta = ev['delta'];
    if (typeof delta !== 'object' || delta === null) return [];

    const d = delta as Record<string, unknown>;
    if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
      return [{ type: 'text', delta: d['text'] }];
    }
    // thinking_delta / signature_delta / input_json_delta → no prose
    return [];
  }

  // -------------------------------------------------------------------------
  // assistant — emit tool events for tool_use blocks ONLY.
  //
  // Text blocks are intentionally NOT emitted: the full text already streamed
  // via stream_event/text_delta above, so re-emitting the assistant text block
  // here would DOUBLE the visible prose. Deltas own text; the assistant event
  // owns tools.
  //
  // Do NOT emit usage from assistant events (it's intermediate).
  // -------------------------------------------------------------------------
  if (eventType === 'assistant') {
    const message = obj['message'];
    if (typeof message !== 'object' || message === null) return [];

    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) return [];

    const events: ProviderEvent[] = [];

    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;

      const block = item as Record<string, unknown>;
      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const toolItem = item as WireContentToolUse;
        const detail = toolDetail(toolItem.input);
        events.push(
          detail !== undefined
            ? { type: 'tool', name: toolItem.name, phase: 'start', detail }
            : { type: 'tool', name: toolItem.name, phase: 'start' },
        );
      }
      // text blocks: intentionally ignored (deltas own prose). Other content
      // types (thinking, …): ignore.
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
