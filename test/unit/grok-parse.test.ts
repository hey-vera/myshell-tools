/**
 * test/unit/grok-parse.test.ts — unit tests for the grok streaming-json parser.
 * Fixtures are REAL grok output (reconciled against a live transcript, G2):
 *   {"type":"thought","data":"…"}  {"type":"text","data":"…"}
 *   {"type":"end","stopReason":"EndTurn","sessionId":"…","requestId":"…"}
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGrokParser } from '../../src/providers/grok-parse.ts';

describe('createGrokParser', () => {
  it('skips empty and malformed lines', () => {
    const parse = createGrokParser();
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse('   '), []);
    assert.deepEqual(parse('not json'), []);
    assert.deepEqual(parse('123'), []); // valid JSON, not an object
  });

  it('emits a text delta per text fragment', () => {
    const parse = createGrokParser();
    assert.deepEqual(parse(JSON.stringify({ type: 'text', data: 'GRO' })), [
      { type: 'text', delta: 'GRO' },
    ]);
    assert.deepEqual(parse(JSON.stringify({ type: 'text', data: 'K_OK' })), [
      { type: 'text', delta: 'K_OK' },
    ]);
  });

  it('emits reasoning deltas for thought fragments', () => {
    const parse = createGrokParser();
    assert.deepEqual(parse(JSON.stringify({ type: 'thought', data: 'thinking…' })), [
      { type: 'reasoning', delta: 'thinking…' },
    ]);
  });

  it('ignores empty-string text/thought data', () => {
    const parse = createGrokParser();
    assert.deepEqual(parse(JSON.stringify({ type: 'text', data: '' })), []);
    assert.deepEqual(parse(JSON.stringify({ type: 'thought', data: '' })), []);
  });

  it('accumulates text across fragments and emits done with the full text + sessionId on end', () => {
    const parse = createGrokParser();
    parse(JSON.stringify({ type: 'thought', data: 'The user says hi' }));
    parse(JSON.stringify({ type: 'text', data: 'GRO' }));
    parse(JSON.stringify({ type: 'text', data: 'K_OK' }));
    const events = parse(
      JSON.stringify({
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: '019ed1c3-1ea3-7ce1-92fb-fee940f953e9',
        requestId: '977bc6ff-950b-4192-ab03-231c4f61ed2f',
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'done');
    if (events[0]?.type === 'done') {
      assert.equal(events[0].text, 'GROK_OK');
      assert.equal(events[0].sessionId, '019ed1c3-1ea3-7ce1-92fb-fee940f953e9');
    }
  });

  it('emits done with empty text and no sessionId when none streamed', () => {
    const parse = createGrokParser();
    const events = parse(JSON.stringify({ type: 'end', stopReason: 'EndTurn' }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'done');
    if (events[0]?.type === 'done') {
      assert.equal(events[0].text, '');
      assert.equal(events[0].sessionId, undefined);
    }
  });

  it('state is per-parser-instance (no cross-run text bleed)', () => {
    const a = createGrokParser();
    a(JSON.stringify({ type: 'text', data: 'aaa' }));
    const b = createGrokParser();
    const events = b(JSON.stringify({ type: 'end', stopReason: 'EndTurn' }));
    if (events[0]?.type === 'done') assert.equal(events[0].text, '');
  });

  it('surfaces an explicit error line', () => {
    const parse = createGrokParser();
    const events = parse(JSON.stringify({ type: 'error', message: 'boom' }));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'error');
  });

  it('ignores unknown event types', () => {
    const parse = createGrokParser();
    assert.deepEqual(parse(JSON.stringify({ type: 'tool_call', name: 'x' })), []);
    assert.deepEqual(parse(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  });
});
