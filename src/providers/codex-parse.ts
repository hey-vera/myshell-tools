/**
 * src/providers/codex-parse.ts — stateful JSONL parser for `codex exec --json`.
 *
 * STATEFUL MODULE: codex streams assistant text across multiple `agent_message`
 * items and the final `turn.completed` event does NOT repeat the full text, so
 * we accumulate text in a closure and surface the complete value in `done`.
 *
 * Pure in all other respects: no I/O, no execa, no side effects. The factory
 * function `createCodexParser()` returns a closure that is hermetic and
 * fixture-testable.
 *
 * Codex `codex exec --json` event schema (JSONL, one object per line):
 *  - thread.started / turn.started      → emit nothing
 *  - item.completed (agent_message)     → text event + accumulate to buffer
 *  - item.completed (reasoning)         → reasoning event (if text present)
 *  - item.completed (command_execution / file_change / mcp_tool_call) → tool event
 *  - turn.completed                     → usage event + done event (no costUsd)
 *  - turn.failed / error                → error event
 *  - unknown / malformed JSON           → emit nothing (never throw)
 */

import type { ProviderEvent, Usage } from './port.js';
import { classifyError } from './errors.js';

// ---------------------------------------------------------------------------
// Internal wire-format shapes (only what we need)
// ---------------------------------------------------------------------------

interface WireItemAgentMessage {
  readonly type: 'agent_message';
  readonly text: string;
}

interface WireItemReasoning {
  readonly type: 'reasoning';
  readonly text?: string;
}

interface WireItemActivity {
  readonly type: 'command_execution' | 'file_change' | 'mcp_tool_call';
  readonly detail?: string;
}

type WireItem =
  | WireItemAgentMessage
  | WireItemReasoning
  | WireItemActivity
  | { readonly type: string };

interface WireItemCompleted {
  readonly type: 'item.completed';
  readonly item: WireItem;
}

interface WireTurnUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cached_input_tokens?: number;
}

interface WireTurnCompleted {
  readonly type: 'turn.completed';
  readonly usage?: WireTurnUsage;
}

interface WireTurnFailed {
  readonly type: 'turn.failed';
  readonly error?: { readonly message?: string };
}

interface WireError {
  readonly type: 'error';
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(u: WireTurnUsage): Usage {
  const base: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };

  // exactOptionalPropertyTypes: only include cachedInputTokens when it is a
  // number — omit the key entirely otherwise.
  if (typeof u.cached_input_tokens === 'number') {
    return { ...base, cachedInputTokens: u.cached_input_tokens };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a stateful parser for `codex exec --json` stdout.
 *
 * Returns a function that accepts one JSONL line at a time and returns 0 or
 * more {@link ProviderEvent}s. The closure accumulates agent_message text so
 * that `done.text` contains the full concatenated assistant reply.
 *
 * The returned parser never throws — malformed JSON or unknown event types
 * silently return [].
 */
export function createCodexParser(): (line: string) => ProviderEvent[] {
  let accumulatedText = '';
  // Captured from `thread.started` so the terminal `done` event can carry the
  // Codex thread id — used to resume the native session on a later turn.
  let threadId: string | undefined;

  return function parseCodexLine(line: string): ProviderEvent[] {
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

    // -----------------------------------------------------------------------
    // thread.started — capture the thread id (for native-session resume).
    // turn.started — emit nothing.
    // -----------------------------------------------------------------------
    if (eventType === 'thread.started') {
      const tid = obj['thread_id'];
      if (typeof tid === 'string' && tid.length > 0) {
        threadId = tid;
      }
      return [];
    }
    if (eventType === 'turn.started') {
      return [];
    }

    // -----------------------------------------------------------------------
    // item.completed — dispatch on item.type
    // -----------------------------------------------------------------------
    if (eventType === 'item.completed') {
      const ev = parsed as WireItemCompleted;
      const item = ev.item;
      if (typeof item !== 'object' || item === null) return [];

      const itemType = (item as { type: string }).type;

      if (itemType === 'agent_message') {
        const msg = item as WireItemAgentMessage;
        const delta = typeof msg.text === 'string' ? msg.text : '';
        accumulatedText += delta;
        return [{ type: 'text', delta }];
      }

      if (itemType === 'reasoning') {
        const r = item as WireItemReasoning;
        if (typeof r.text === 'string' && r.text.length > 0) {
          return [{ type: 'reasoning', delta: r.text }];
        }
        return [];
      }

      if (
        itemType === 'command_execution' ||
        itemType === 'file_change' ||
        itemType === 'mcp_tool_call'
      ) {
        const act = item as WireItemActivity;
        const toolEvent: ProviderEvent =
          typeof act.detail === 'string'
            ? { type: 'tool', name: itemType, phase: 'end', detail: act.detail }
            : { type: 'tool', name: itemType, phase: 'end' };
        return [toolEvent];
      }

      // Unknown item type — emit nothing
      return [];
    }

    // -----------------------------------------------------------------------
    // turn.completed — emit usage + done (no costUsd)
    // -----------------------------------------------------------------------
    if (eventType === 'turn.completed') {
      const ev = parsed as WireTurnCompleted;
      const usage: Usage =
        ev.usage !== undefined && ev.usage !== null
          ? mapUsage(ev.usage)
          : { inputTokens: 0, outputTokens: 0 };

      return [
        { type: 'usage', usage },
        {
          type: 'done',
          text: accumulatedText,
          usage,
          ...(threadId !== undefined ? { sessionId: threadId } : {}),
          raw: parsed,
        },
      ];
    }

    // -----------------------------------------------------------------------
    // turn.failed — emit error
    // -----------------------------------------------------------------------
    if (eventType === 'turn.failed') {
      const ev = parsed as WireTurnFailed;
      const message = ev.error?.message ?? 'turn failed';
      return [{ type: 'error', error: classifyError(message, 1) }];
    }

    // -----------------------------------------------------------------------
    // error — emit error
    // -----------------------------------------------------------------------
    if (eventType === 'error') {
      const ev = parsed as WireError;
      const message = ev.message ?? 'unknown error';
      return [{ type: 'error', error: { ...classifyError(message, 1), message } }];
    }

    // Unknown event type — emit nothing
    return [];
  };
}
