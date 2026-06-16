/**
 * src/providers/grok-parse.ts — pure parser for `grok --output-format streaming-json`.
 *
 * Reconciled against a LIVE grok transcript (G2, 2026-06-16). grok's streaming
 * schema is line-delimited JSON, far simpler than Claude's:
 *   {"type":"thought","data":"<reasoning fragment>"}
 *   {"type":"text","data":"<answer fragment>"}
 *   {"type":"end","stopReason":"EndTurn","sessionId":"<id>","requestId":"<id>"}
 *
 * There are NO usage / cost / tool event types — grok surfaces no token or cost
 * accounting in streaming-json (cost is estimated from the pricing table, like
 * codex), and tool activity is not emitted as a distinct event.
 *
 * Because the terminal `end` event carries no text, the parser is STATEFUL: it
 * accumulates `text` fragments and emits the final `done` with the full text +
 * the grok `sessionId` (so a later turn can `--resume`). This mirrors the
 * codex / opencode parser-factory pattern. TOLERANT: never throws on a malformed
 * or unknown line — anything we do not recognize yields nothing.
 *
 * PURE MODULE: no I/O, no execa, no side effects. The hermetic, fixture-tested
 * heart of the grok adapter.
 */

import type { ProviderEvent } from './port.js';
import { classifyError } from './errors.js';

/**
 * Create a stateful line parser for ONE grok run. Call the returned function
 * with each stdout line; it returns 0+ {@link ProviderEvent}s. The closure
 * accumulates assistant `text` so the terminal `end` event can carry the full
 * response in its `done.text`.
 *
 * Returns an empty array for: blank lines, lines that fail `JSON.parse`, and any
 * event type we do not surface.
 */
export function createGrokParser(): (line: string) => ProviderEvent[] {
  let text = '';

  return (line: string): ProviderEvent[] => {
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
    switch (obj['type']) {
      // Assistant prose, streamed one fragment per line. Accumulate for the
      // final done, and surface each fragment live.
      case 'text': {
        const data = obj['data'];
        if (typeof data === 'string' && data.length > 0) {
          text += data;
          return [{ type: 'text', delta: data }];
        }
        return [];
      }

      // Reasoning fragments — surfaced as `reasoning` (not folded into prose).
      case 'thought': {
        const data = obj['data'];
        if (typeof data === 'string' && data.length > 0) {
          return [{ type: 'reasoning', delta: data }];
        }
        return [];
      }

      // Terminal event: no text/usage of its own — carries the session id.
      // Emit `done` with the accumulated text so the run completes cleanly.
      case 'end': {
        const sessionId = obj['sessionId'];
        const done: ProviderEvent = {
          type: 'done',
          text,
          ...(typeof sessionId === 'string' && sessionId.length > 0
            ? { sessionId }
            : {}),
          raw: parsed,
        };
        return [done];
      }

      // Defensive: if grok ever emits an explicit error line, surface it.
      case 'error': {
        const msg =
          typeof obj['message'] === 'string'
            ? obj['message']
            : typeof obj['data'] === 'string'
              ? obj['data']
              : 'grok reported an error';
        return [{ type: 'error', error: classifyError(msg, 1) }];
      }

      default:
        return [];
    }
  };
}
