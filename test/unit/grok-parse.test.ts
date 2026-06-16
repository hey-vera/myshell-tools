/**
 * test/unit/grok-parse.test.ts — unit tests for the provisional grok streaming-json
 * parser. Fixtures are Claude-shaped because grok is a Claude-Code clone and the
 * parser is modeled on claude-parse.ts pending live-transcript reconciliation (G2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseGrokLine } from '../../src/providers/grok-parse.ts';

describe('parseGrokLine', () => {
  it('skips empty lines', () => {
    assert.deepEqual(parseGrokLine(''), []);
    assert.deepEqual(parseGrokLine('   '), []);
  });

  it('skips malformed JSON', () => {
    assert.deepEqual(parseGrokLine('not json'), []);
  });

  it('skips rate_limit_event and system events', () => {
    assert.deepEqual(parseGrokLine(JSON.stringify({ type: 'rate_limit_event' })), []);
    assert.deepEqual(parseGrokLine(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  });

  it('emits text deltas from stream_event/content_block_delta/text_delta', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      }),
    );
    assert.deepEqual(events, [{ type: 'text', delta: 'hello' }]);
  });

  it('ignores non-text stream_event deltas', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } },
      }),
    );
    assert.deepEqual(events, []);
  });

  it('emits tool start events from assistant tool_use blocks', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/foo.txt' } },
          ],
        },
      }),
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: 'tool',
      name: 'Read',
      phase: 'start',
      detail: '/tmp/foo.txt',
    });
  });

  it('emits tool start events without detail when input has no recognizable field', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: {} }],
        },
      }),
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: 'tool', name: 'Bash', phase: 'start' });
  });

  it('ignores assistant text blocks (deltas own the prose)', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'should be ignored' }],
        },
      }),
    );
    assert.deepEqual(events, []);
  });

  it('emits usage + done on a successful result event', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } });
    assert.equal(events[1]?.type, 'done');
    if (events[1]?.type === 'done') {
      assert.equal(events[1].text, 'done');
      assert.equal(events[1].costUsd, 0);
      assert.deepEqual(events[1].usage, { inputTokens: 10, outputTokens: 5 });
    }
  });

  it('emits usage + error on a failed result event', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'something went wrong',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'usage');
    assert.equal(events[1]?.type, 'error');
  });

  it('handles cache read input tokens', () => {
    const events = parseGrokLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
      }),
    );
    const usageEvent = events.find((e) => e.type === 'usage');
    assert.ok(usageEvent?.type === 'usage');
    if (usageEvent.type === 'usage') {
      assert.deepEqual(usageEvent.usage, {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
      });
    }
  });
});
