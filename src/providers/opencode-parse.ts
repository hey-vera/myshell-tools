/**
 * src/providers/opencode-parse.ts — stateful JSONL parser for `opencode run --format json`.
 *
 * STATEFUL MODULE: opencode streams assistant text via multiple `text` events;
 * there is NO single terminal "done" line — the stdout stream simply ends after
 * the last `text`/`step_finish` event. We therefore accumulate text, usage,
 * and cost in a closure. The adapter calls `finalize()` after the for-await
 * loop to obtain the final `done` event (or an error event on cancel/failure).
 *
 * Pure in all other respects: no I/O, no execa, no side effects. The factory
 * function `createOpencodeParser()` returns a hermetic, fixture-testable object.
 *
 * opencode `opencode run --format json` event schema (JSONL, one object per line):
 *  - step_start              → emit nothing (informational marker)
 *  - text (part.type=text)   → text event + accumulate to buffer
 *  - tool_use                → tool event (phase:'end', detail from state.title)
 *  - step_finish             → usage event; accumulate tokens + cost
 *  - error                   → error event
 *  - unknown / malformed JSON → emit nothing (never throw)
 */

import type { ProviderEvent, Usage } from './port.js';
import { classifyError } from './errors.js';

// ---------------------------------------------------------------------------
// Internal wire-format shapes (only what we need)
// ---------------------------------------------------------------------------

interface WireTextPart {
  readonly type: 'text';
  readonly text: string;
}

interface WireToolState {
  readonly status?: string;
  readonly input?: unknown;
  readonly output?: string;
  readonly title?: string;
}

interface WireToolPart {
  readonly type: 'tool';
  readonly tool?: string;
  readonly callID?: string;
  readonly state?: WireToolState;
}

interface WireStepFinishTokens {
  readonly total?: number;
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cache?: {
    readonly write?: number;
    readonly read?: number;
  };
}

interface WireStepFinishPart {
  readonly type: 'step-finish';
  readonly reason?: string;
  readonly tokens?: WireStepFinishTokens;
  readonly cost?: number;
}

interface WireTextEvent {
  readonly type: 'text';
  readonly sessionID?: string;
  readonly part?: WireTextPart;
}

interface WireToolEvent {
  readonly type: 'tool_use';
  readonly sessionID?: string;
  readonly part?: WireToolPart;
}

interface WireStepFinishEvent {
  readonly type: 'step_finish';
  readonly sessionID?: string;
  readonly part?: WireStepFinishPart;
}

interface WireErrorData {
  readonly message?: string;
  readonly ref?: string;
}

interface WireErrorPayload {
  readonly name?: string;
  readonly data?: WireErrorData;
}

interface WireErrorEvent {
  readonly type: 'error';
  readonly sessionID?: string;
  readonly error?: WireErrorPayload;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(tokens: WireStepFinishTokens): Usage {
  const base: Usage = {
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
  };

  // exactOptionalPropertyTypes: only include cachedInputTokens when it is a
  // number — omit the key entirely otherwise.
  const cacheRead = tokens.cache?.read;
  if (typeof cacheRead === 'number') {
    return { ...base, cachedInputTokens: cacheRead };
  }

  return base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpencodeParser {
  /**
   * Parse one JSONL line and return 0 or more ProviderEvents.
   * Never throws — malformed JSON or unknown event types silently return [].
   */
  parseLine(line: string): ProviderEvent[];

  /**
   * Called by the adapter after the subprocess stdout stream ends.
   *
   * Returns a `done` event built from accumulated text/usage/cost, OR an
   * `error` event if nothing was accumulated and the run appears to have
   * failed silently. Returns [] only when a terminal event was already emitted
   * inline (e.g. an error event from an `error`-typed JSONL line).
   */
  finalize(): ProviderEvent[];
}

/**
 * Create a stateful parser for `opencode run --format json` stdout.
 *
 * Returns an {@link OpencodeParser} whose `parseLine` method accepts one JSONL
 * line at a time and returns 0 or more {@link ProviderEvent}s. The closure
 * accumulates `text` content, token counts, and cost so that `finalize()` can
 * return a complete `done` event after the stdout stream closes.
 *
 * The returned parser never throws — malformed JSON or unknown event types
 * silently return [].
 */
export function createOpencodeParser(): OpencodeParser {
  let accumulatedText = '';
  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;
  let accumulatedCachedInputTokens: number | undefined = undefined;
  let accumulatedCostUsd = 0;
  let terminalEmitted = false;

  function parseLine(line: string): ProviderEvent[] {
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
    // step_start — informational marker; emit nothing
    // -------------------------------------------------------------------------
    if (eventType === 'step_start') {
      return [];
    }

    // -------------------------------------------------------------------------
    // text — accumulate assistant text and emit a streaming delta
    // -------------------------------------------------------------------------
    if (eventType === 'text') {
      const ev = parsed as WireTextEvent;
      const part = ev.part;
      if (typeof part !== 'object' || part === null) return [];
      if (part.type !== 'text') return [];
      const delta = typeof part.text === 'string' ? part.text : '';
      if (delta.length > 0) {
        accumulatedText += delta;
        return [{ type: 'text', delta }];
      }
      return [];
    }

    // -------------------------------------------------------------------------
    // tool_use — emit a tool event (phase:'end')
    // -------------------------------------------------------------------------
    if (eventType === 'tool_use') {
      const ev = parsed as WireToolEvent;
      const part = ev.part;
      if (typeof part !== 'object' || part === null) return [];

      const toolName = typeof part.tool === 'string' && part.tool.length > 0
        ? part.tool
        : 'unknown-tool';

      const title = part.state?.title;
      const toolEvent: ProviderEvent =
        typeof title === 'string' && title.length > 0
          ? { type: 'tool', name: toolName, phase: 'end', detail: title }
          : { type: 'tool', name: toolName, phase: 'end' };

      return [toolEvent];
    }

    // -------------------------------------------------------------------------
    // step_finish — accumulate tokens + cost; emit a usage event
    // -------------------------------------------------------------------------
    if (eventType === 'step_finish') {
      const ev = parsed as WireStepFinishEvent;
      const part = ev.part;
      if (typeof part !== 'object' || part === null) return [];

      const tokens = part.tokens ?? {};
      const stepUsage = mapUsage(tokens);

      accumulatedInputTokens += stepUsage.inputTokens;
      accumulatedOutputTokens += stepUsage.outputTokens;

      if (typeof stepUsage.cachedInputTokens === 'number') {
        accumulatedCachedInputTokens =
          (accumulatedCachedInputTokens ?? 0) + stepUsage.cachedInputTokens;
      }

      if (typeof part.cost === 'number') {
        accumulatedCostUsd += part.cost;
      }

      return [{ type: 'usage', usage: stepUsage }];
    }

    // -------------------------------------------------------------------------
    // error — emit an error event and mark terminal as emitted
    // -------------------------------------------------------------------------
    if (eventType === 'error') {
      const ev = parsed as WireErrorEvent;
      const message =
        ev.error?.data?.message ?? ev.error?.name ?? 'opencode error';
      terminalEmitted = true;
      return [{ type: 'error', error: classifyError(message, 1) }];
    }

    // Unknown event type — emit nothing
    return [];
  }

  function finalize(): ProviderEvent[] {
    // If a terminal event was already emitted (e.g. from an error line),
    // do not emit a duplicate.
    if (terminalEmitted) return [];

    // Build the accumulated usage object.
    const usage: Usage = (() => {
      const base: Usage = {
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
      };
      if (typeof accumulatedCachedInputTokens === 'number') {
        return { ...base, cachedInputTokens: accumulatedCachedInputTokens };
      }
      return base;
    })();

    // Build the done event. costUsd is only included when > 0 to avoid
    // emitting a spurious $0 when opencode reported no cost (exactOptionalPropertyTypes).
    const doneEvent: ProviderEvent =
      accumulatedCostUsd > 0
        ? {
            type: 'done',
            text: accumulatedText,
            usage,
            costUsd: accumulatedCostUsd,
            raw: { accumulatedText, usage, costUsd: accumulatedCostUsd },
          }
        : {
            type: 'done',
            text: accumulatedText,
            usage,
            raw: { accumulatedText, usage },
          };

    terminalEmitted = true;
    return [doneEvent];
  }

  return { parseLine, finalize };
}
