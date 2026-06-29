/**
 * test/contract/codex-parse.test.ts
 *
 * Hermetic fixture-based contract tests for createCodexParser().
 * No real `codex` binary is spawned — all inputs are SYNTHETIC fixtures
 * based on the documented `codex exec --json` schema.
 *
 * NOTE: The fixture file (codex-sample.json.jsonl) is SYNTHETIC, schema-based.
 * Replace it with a real `codex exec --json` capture once codex is installed.
 *
 * Run with: npm run test:contract
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCodexParser } from '../../src/providers/codex-parse.ts';
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
// Happy-path: synthetic fixture (codex-sample.json.jsonl)
// ---------------------------------------------------------------------------

describe('createCodexParser — sample fixture (synthetic, schema-based)', () => {
  const lines = loadFixtureLines('codex-sample.json.jsonl');

  // Feed all lines through a fresh parser
  const parseCodexLine = createCodexParser();
  const events: ProviderEvent[] = lines.flatMap((l) => parseCodexLine(l));

  it('produces a text event with the agent message text', () => {
    const textEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text',
    );
    assert.ok(textEvents.length > 0, 'expected at least one text event');
    const hasExpected = textEvents.some((e) => e.delta === 'Hello from Codex');
    assert.ok(
      hasExpected,
      `expected a text event with delta "Hello from Codex", got: ${JSON.stringify(textEvents)}`,
    );
  });

  it('produces a reasoning event', () => {
    const reasoningEvents = events.filter((e) => e.type === 'reasoning');
    assert.ok(reasoningEvents.length > 0, 'expected at least one reasoning event');
  });

  it('produces a usage event', () => {
    const usageEvents = events.filter((e) => e.type === 'usage');
    assert.ok(usageEvents.length > 0, 'expected at least one usage event');
  });

  it('produces a done event with accumulated text equal to the agent message', () => {
    const doneEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.equal(doneEvents.length, 1, 'expected exactly one done event');
    const done = doneEvents[0]!;
    assert.equal(
      done.text,
      'Hello from Codex',
      `done.text should be the accumulated agent message, got: "${done.text}"`,
    );
  });

  it('done event has usage.inputTokens === 42', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.inputTokens, 42);
  });

  it('done event has usage.outputTokens === 7', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.outputTokens, 7);
  });

  it('done event carries the thread id captured from thread.started (native-session resume)', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    // The fixture's first line is {"type":"thread.started","thread_id":"thread-001"}.
    assert.equal(done.sessionId, 'thread-001', 'done.sessionId should be the captured thread_id');
  });

  it('done event has usage.cachedInputTokens === 10', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.cachedInputTokens, 10);
  });

  it('done event does NOT have costUsd (codex omits USD cost)', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.ok(
      !('costUsd' in done),
      'done event must not carry costUsd — the orchestrator estimates it from the pricing table',
    );
  });

  it('produces no error events', () => {
    const errorEvents = events.filter((e) => e.type === 'error');
    assert.equal(
      errorEvents.length,
      0,
      `unexpected error events: ${JSON.stringify(errorEvents)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Error path: turn.failed → emits an error event
// ---------------------------------------------------------------------------

describe('createCodexParser — turn.failed → error event', () => {
  const parseCodexLine = createCodexParser();

  it('emits an error event for turn.failed', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'model not found' },
    });
    const events = parseCodexLine(line);
    assert.ok(events.length > 0, 'expected at least one event');
    assert.equal(events[0]!.type, 'error', 'expected an error event');
    const errEv = events[0] as Extract<ProviderEvent, { type: 'error' }>;
    assert.equal(errEv.error.category, 'model', 'expected category "model" for "model not found"');
  });
});

// ---------------------------------------------------------------------------
// Error path: top-level error → emits an error event
// ---------------------------------------------------------------------------

describe('createCodexParser — top-level error → error event', () => {
  const parseCodexLine = createCodexParser();

  it('emits an error event for a top-level error object', () => {
    const line = JSON.stringify({
      type: 'error',
      message: 'authentication failed',
    });
    const events = parseCodexLine(line);
    assert.ok(events.length > 0, 'expected at least one event');
    assert.equal(events[0]!.type, 'error', 'expected an error event');
    const errEv = events[0] as Extract<ProviderEvent, { type: 'error' }>;
    assert.equal(errEv.error.category, 'auth', 'expected category "auth"');
  });
});

// ---------------------------------------------------------------------------
// Text accumulation: multiple agent_message items are concatenated
// ---------------------------------------------------------------------------

describe('createCodexParser — text accumulation across multiple agent_message items', () => {
  const parseCodexLine = createCodexParser();

  it('accumulates agent_message deltas and returns the full text in done.text', () => {
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ', world' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }),
    ];

    const events: ProviderEvent[] = lines.flatMap((l) => parseCodexLine(l));

    const textEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text',
    );
    assert.equal(textEvents.length, 2, 'expected 2 text delta events');
    assert.equal(textEvents[0]!.delta, 'Hello');
    assert.equal(textEvents[1]!.delta, ', world');

    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.text, 'Hello, world', 'done.text must be the full concatenated reply');
  });
});

// ---------------------------------------------------------------------------
// Tool events: command_execution, file_change, mcp_tool_call
// ---------------------------------------------------------------------------

describe('createCodexParser — tool item types', () => {
  it('emits a tool event for command_execution', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', detail: 'ls -la' },
    });
    const events = parseCodexLine(line);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'tool');
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.name, 'command_execution');
    assert.equal(toolEv.phase, 'end');
    assert.equal(toolEv.detail, 'ls -la');
  });

  it('emits a tool event for file_change without detail', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change' },
    });
    const events = parseCodexLine(line);
    assert.equal(events.length, 1);
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.name, 'file_change');
    assert.equal(toolEv.phase, 'end');
    assert.ok(!('detail' in toolEv), 'detail should be absent when not provided');
  });

  it('emits a tool event for mcp_tool_call', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', detail: 'search("foo")' },
    });
    const events = parseCodexLine(line);
    assert.equal(events.length, 1);
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.name, 'mcp_tool_call');
    assert.equal(toolEv.phase, 'end');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: graceful handling of bad input
// ---------------------------------------------------------------------------

describe('createCodexParser — edge cases', () => {
  it('returns [] for an empty line', () => {
    const parseCodexLine = createCodexParser();
    assert.deepEqual(parseCodexLine(''), []);
  });

  it('returns [] for a whitespace-only line', () => {
    const parseCodexLine = createCodexParser();
    assert.deepEqual(parseCodexLine('   '), []);
  });

  it('returns [] for a non-JSON line', () => {
    const parseCodexLine = createCodexParser();
    assert.deepEqual(parseCodexLine('not json at all'), []);
  });

  it('returns [] for thread.started', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({ type: 'thread.started', thread_id: 't1' });
    assert.deepEqual(parseCodexLine(line), []);
  });

  it('returns [] for turn.started', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({ type: 'turn.started', turn_id: 'turn-1' });
    assert.deepEqual(parseCodexLine(line), []);
  });

  it('returns [] for an unknown event type', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({ type: 'unknown_future_type', data: 42 });
    assert.deepEqual(parseCodexLine(line), []);
  });

  it('handles missing usage fields in turn.completed defensively', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({ type: 'turn.completed' });
    const events = parseCodexLine(line);
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event even without usage');
    assert.equal(done.usage?.inputTokens, 0);
    assert.equal(done.usage?.outputTokens, 0);
  });

  it('omits cachedInputTokens when cached_input_tokens is missing', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const events = parseCodexLine(line);
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.ok(
      !('cachedInputTokens' in (done.usage ?? {})),
      'cachedInputTokens must be absent when not provided',
    );
  });

  it('returns [] for reasoning item with no text', () => {
    const parseCodexLine = createCodexParser();
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } });
    assert.deepEqual(parseCodexLine(line), []);
  });
});
