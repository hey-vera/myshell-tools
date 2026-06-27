/**
 * test/contract/claude-parse.test.ts
 *
 * Hermetic fixture-based contract tests for parseClaudeLine().
 * No real `claude` binary is spawned — all inputs are captured JSONL fixtures.
 *
 * Run with: npm run test:contract
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeLine } from '../../src/providers/claude-parse.ts';
import type { ProviderEvent } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

function loadFixtureLines(name: string): string[] {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Happy-path: real captured transcript (claude-pong.stream-json.jsonl)
// ---------------------------------------------------------------------------

describe('parseClaudeLine — pong fixture (real captured transcript)', () => {
  const lines = loadFixtureLines('claude-pong.stream-json.jsonl');
  const events: ProviderEvent[] = lines.flatMap((l) => parseClaudeLine(l));

  it('produces a text event with delta "pong"', () => {
    const textEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text',
    );
    assert.ok(textEvents.length > 0, 'expected at least one text event');
    const hasPong = textEvents.some((e) => e.delta === 'pong');
    assert.ok(hasPong, `expected a text event with delta "pong", got: ${JSON.stringify(textEvents)}`);
  });

  it('produces a usage event', () => {
    const usageEvents = events.filter((e) => e.type === 'usage');
    assert.ok(usageEvents.length > 0, 'expected at least one usage event');
  });

  it('produces a done event with text "pong"', () => {
    const doneEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.equal(doneEvents.length, 1, 'expected exactly one done event');
    const done = doneEvents[0]!;
    assert.equal(done.text, 'pong', 'done.text should be "pong"');
  });

  it('done event has usage.inputTokens === 1661', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.inputTokens, 1661);
  });

  it('done event has usage.outputTokens === 4', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.outputTokens, 4);
  });

  it('done event has usage.cachedInputTokens === 13247', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.cachedInputTokens, 13247);
  });

  it('done event has usage.cacheWriteInputTokens === 2201', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.cacheWriteInputTokens, 2201);
  });

  it('done event has costUsd ≈ 0.02927775 (within 1e-6)', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.ok(done.costUsd !== undefined, 'expected costUsd to be set');
    assert.ok(
      Math.abs(done.costUsd - 0.029297749999999997) < 1e-6,
      `expected costUsd ≈ 0.02927775, got ${done.costUsd}`,
    );
  });

  it('produces no error events', () => {
    const errorEvents = events.filter((e) => e.type === 'error');
    assert.equal(errorEvents.length, 0, `unexpected error events: ${JSON.stringify(errorEvents)}`);
  });
});

// ---------------------------------------------------------------------------
// Error path: synthetic error fixture (claude-error.stream-json.jsonl)
// ---------------------------------------------------------------------------

describe('parseClaudeLine — error fixture (synthetic is_error=true)', () => {
  const lines = loadFixtureLines('claude-error.stream-json.jsonl');
  const events: ProviderEvent[] = lines.flatMap((l) => parseClaudeLine(l));

  it('produces a usage event', () => {
    const usageEvents = events.filter((e) => e.type === 'usage');
    assert.ok(usageEvents.length > 0, 'expected at least one usage event');
  });

  it('produces an error event (not a done event)', () => {
    const errorEvents = events.filter((e) => e.type === 'error');
    assert.ok(errorEvents.length > 0, 'expected at least one error event');
  });

  it('produces no done event', () => {
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(doneEvents.length, 0, 'should not produce a done event for is_error=true');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: skip unparseable lines gracefully
// ---------------------------------------------------------------------------

describe('parseClaudeLine — edge cases', () => {
  it('returns [] for an empty line', () => {
    assert.deepEqual(parseClaudeLine(''), []);
  });

  it('returns [] for a whitespace-only line', () => {
    assert.deepEqual(parseClaudeLine('   '), []);
  });

  it('returns [] for a non-JSON line', () => {
    assert.deepEqual(parseClaudeLine('not json at all'), []);
  });

  it('returns [] for a rate_limit_event line', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} });
    assert.deepEqual(parseClaudeLine(line), []);
  });

  it('returns [] for a system/init line', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' });
    assert.deepEqual(parseClaudeLine(line), []);
  });

  it('returns [] for an unknown event type', () => {
    const line = JSON.stringify({ type: 'unknown_future_type', data: 42 });
    assert.deepEqual(parseClaudeLine(line), []);
  });

  it('emits a tool event for tool_use content items', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', id: 'tool-1' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const events = parseClaudeLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'tool');
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.name, 'Bash');
    assert.equal(toolEv.phase, 'start');
  });
});

// ---------------------------------------------------------------------------
// Partial-message streaming (stream_event deltas) — the live-token contract
// ---------------------------------------------------------------------------

describe('parseClaudeLine — stream_event partial messages', () => {
  it('(a) a content_block_delta text_delta line → one text event with the delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello ' } },
    });
    const events = parseClaudeLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'text');
    const te = events[0] as Extract<ProviderEvent, { type: 'text' }>;
    assert.equal(te.delta, 'hello ');
  });

  it('(b) thinking/signature/structural stream_event subtypes → [] (no prose leak)', () => {
    const cases: unknown[] = [
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'AAA=' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } } },
      { type: 'stream_event', event: { type: 'message_start', message: { content: [] } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 44 } } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ];
    for (const c of cases) {
      assert.deepEqual(parseClaudeLine(JSON.stringify(c)), [], `expected [] for ${JSON.stringify(c)}`);
    }
  });

  it('(b2) returns [] for malformed stream_event shapes (defensive, never throws)', () => {
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'stream_event' })), []);
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'stream_event', event: null })), []);
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta' } })), []);
    assert.deepEqual(
      parseClaudeLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta' } } })),
      [],
    );
  });

  it('(c) an assistant event with a text block → NO text event (dedup regression guard)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'pong' }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const events = parseClaudeLine(line);
    const textEvents = events.filter((e) => e.type === 'text');
    assert.equal(textEvents.length, 0, 'assistant text block must NOT emit a text event (deltas own prose)');
    assert.equal(events.length, 0, 'a text-only assistant event yields no events at all');
  });

  it('(d) assistant tool_use with input.file_path → one tool event with the derived detail', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth/mw.ts' } }] },
    });
    const events = parseClaudeLine(line);
    assert.equal(events.length, 1);
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.type, 'tool');
    assert.equal(toolEv.name, 'Edit');
    assert.equal(toolEv.phase, 'start');
    assert.equal(toolEv.detail, 'src/auth/mw.ts');
  });

  it('(d2) detail falls back path → command → pattern in order', () => {
    const pathEv = parseClaudeLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'X', input: { path: '/a/b' } }] },
    }))[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(pathEv.detail, '/a/b');

    const cmdEv = parseClaudeLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
    }))[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(cmdEv.detail, 'ls -la');

    const patEv = parseClaudeLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }] },
    }))[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(patEv.detail, 'TODO');
  });

  it('(e) tool_use with no recognizable input field → tool event with detail omitted', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { foo: 'bar' } }] },
    });
    const events = parseClaudeLine(line);
    assert.equal(events.length, 1);
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.type, 'tool');
    assert.equal(toolEv.name, 'Bash');
    assert.ok(!('detail' in toolEv), 'detail must be omitted when no recognizable input field');
  });

  it('(f) end-to-end capture-shaped lines → exactly one text "hello there friend", no thinking', () => {
    const lines = [
      { type: 'stream_event', event: { type: 'message_start', message: { content: [] } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user is asking me to reply.' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'AAA=' } } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'The user is asking me to reply.', signature: 'AAA=' }] } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there friend' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello there friend' }] } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 44 } } },
      { type: 'stream_event', event: { type: 'message_stop' } },
    ];
    const events = lines.flatMap((l) => parseClaudeLine(JSON.stringify(l)));
    const textEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text',
    );
    assert.equal(textEvents.length, 2, 'one text event per text_delta, none from the assistant block');
    const prose = textEvents.map((e) => e.delta).join('');
    assert.equal(prose, 'hello there friend');
    assert.ok(!prose.includes('asking me to reply'), 'thinking must not leak into prose');
  });
});
