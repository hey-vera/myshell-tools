/**
 * test/contract/opencode-parse.test.ts
 *
 * Hermetic fixture-based contract tests for createOpencodeParser().
 * No real `opencode` binary is spawned during the test — the fixture
 * (opencode-hello.jsonl) is a REAL transcript captured from:
 *   opencode run --format json "say hello in one word"
 * using the free model (no auth required) on 2026-05-31.
 *
 * The test verifies that the parser correctly accumulates text, emits
 * streaming deltas, records usage from step_finish, and produces a
 * final done event via finalize() — mirroring the pattern in
 * test/contract/codex-parse.test.ts.
 *
 * Run with: npm run test:contract
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOpencodeParser } from '../../src/providers/opencode-parse.ts';
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
// Happy-path: real captured transcript (opencode-hello.jsonl)
// Fixture was captured from: opencode run --format json "say hello in one word"
// Model: opencode free tier (deepseek-v4-flash-free, no auth required)
// ---------------------------------------------------------------------------

describe('createOpencodeParser — hello fixture (real captured transcript)', () => {
  const lines = loadFixtureLines('opencode-hello.jsonl');
  const parser = createOpencodeParser();

  // Feed all lines through the parser, then finalize to get the done event.
  const streamEvents: ProviderEvent[] = lines.flatMap((l) => parser.parseLine(l));
  const terminalEvents: ProviderEvent[] = parser.finalize();
  const events = [...streamEvents, ...terminalEvents];

  it('produces a text event with delta "Hello"', () => {
    const textEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text',
    );
    assert.ok(textEvents.length > 0, 'expected at least one text event');
    const hasHello = textEvents.some((e) => e.delta === 'Hello');
    assert.ok(
      hasHello,
      `expected a text event with delta "Hello", got: ${JSON.stringify(textEvents)}`,
    );
  });

  it('produces a usage event from step_finish', () => {
    const usageEvents = events.filter((e) => e.type === 'usage');
    assert.ok(usageEvents.length > 0, 'expected at least one usage event');
  });

  it('produces exactly one done event (from finalize)', () => {
    const doneEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.equal(doneEvents.length, 1, 'expected exactly one done event');
  });

  it('done event has accumulated text "Hello"', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.text, 'Hello', `done.text should be "Hello", got: "${done.text}"`);
  });

  it('done event has usage.inputTokens === 8021', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.inputTokens, 8021);
  });

  it('done event has usage.outputTokens === 2', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.outputTokens, 2);
  });

  it('done event has usage.cachedInputTokens === 0 (cache.read reported by fixture)', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.cachedInputTokens, 0);
  });

  it('done event has usage.cacheWriteInputTokens === 0', () => {
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done.usage?.cacheWriteInputTokens, 0);
  });

  it('done event does NOT have costUsd when provider reported cost=0', () => {
    // The fixture has cost:0 — the parser only includes costUsd when > 0
    // (exactOptionalPropertyTypes guard), so the field must be absent.
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.ok(
      !('costUsd' in done),
      'done event must not carry costUsd when provider reported cost=0',
    );
  });

  it('produces no error events', () => {
    const errorEvents = events.filter((e) => e.type === 'error');
    assert.equal(errorEvents.length, 0, `unexpected error events: ${JSON.stringify(errorEvents)}`);
  });

  it('step_start line emits no events', () => {
    // The first line is step_start — it must be silently ignored
    const stepStartLine = lines.find((l) => l.includes('"step_start"'));
    assert.ok(stepStartLine !== undefined, 'fixture should contain a step_start line');
    const freshParser = createOpencodeParser();
    const result = freshParser.parseLine(stepStartLine);
    assert.deepEqual(result, [], 'step_start must emit no events');
  });
});

// ---------------------------------------------------------------------------
// Error path: error event → emits an error event; finalize returns []
// ---------------------------------------------------------------------------

describe('createOpencodeParser — error event → error event emitted inline', () => {
  it('emits an error event for an error-typed line', () => {
    const parser = createOpencodeParser();
    const line = JSON.stringify({
      type: 'error',
      sessionID: 'ses_test',
      error: { name: 'AuthError', data: { message: 'authentication failed' } },
    });
    const events = parser.parseLine(line);
    assert.ok(events.length > 0, 'expected at least one event');
    assert.equal(events[0]!.type, 'error', 'expected an error event');
  });

  it('finalize returns [] after an inline error event', () => {
    const parser = createOpencodeParser();
    const line = JSON.stringify({
      type: 'error',
      error: { name: 'SomeError', data: { message: 'something went wrong' } },
    });
    parser.parseLine(line);
    const finalEvents = parser.finalize();
    assert.deepEqual(finalEvents, [], 'finalize must return [] after a terminal error event');
  });
});

// ---------------------------------------------------------------------------
// Text accumulation: multiple text events are concatenated
// ---------------------------------------------------------------------------

describe('createOpencodeParser — text accumulation across multiple text events', () => {
  it('accumulates text deltas and returns the full concatenated text in done.text', () => {
    const parser = createOpencodeParser();
    const lines = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hello' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: ', world' } }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { input: 10, output: 5 },
          cost: 0.001,
        },
      }),
    ];

    const streamEvents: ProviderEvent[] = lines.flatMap((l) => parser.parseLine(l));
    const terminalEvents = parser.finalize();
    const events = [...streamEvents, ...terminalEvents];

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
// costUsd: included in done when provider reports cost > 0
// ---------------------------------------------------------------------------

describe('createOpencodeParser — costUsd included when provider reports cost > 0', () => {
  it('done event includes costUsd when step_finish has cost > 0', () => {
    const parser = createOpencodeParser();
    const lines = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'Hi' } }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          type: 'step-finish',
          reason: 'stop',
          tokens: { input: 100, output: 10 },
          cost: 0.0025,
        },
      }),
    ];
    lines.forEach((l) => parser.parseLine(l));
    const terminalEvents = parser.finalize();
    const done = terminalEvents.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.ok('costUsd' in done, 'done event must include costUsd when cost > 0');
    assert.ok(
      Math.abs((done.costUsd ?? 0) - 0.0025) < 1e-9,
      `expected costUsd ≈ 0.0025, got ${done.costUsd}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tool events
// ---------------------------------------------------------------------------

describe('createOpencodeParser — tool_use event', () => {
  it('emits a tool event for a tool_use line', () => {
    const parser = createOpencodeParser();
    const line = JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'Bash',
        callID: 'call_abc',
        state: { status: 'completed', title: 'ls -la' },
      },
    });
    const events = parser.parseLine(line);
    assert.equal(events.length, 1, 'expected exactly one event');
    assert.equal(events[0]!.type, 'tool');
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.name, 'Bash');
    assert.equal(toolEv.phase, 'end');
    assert.equal(toolEv.detail, 'ls -la');
  });

  it('emits a tool event without detail when state.title is absent', () => {
    const parser = createOpencodeParser();
    const line = JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'Read', callID: 'call_xyz' },
    });
    const events = parser.parseLine(line);
    assert.equal(events.length, 1);
    const toolEv = events[0] as Extract<ProviderEvent, { type: 'tool' }>;
    assert.equal(toolEv.name, 'Read');
    assert.ok(!('detail' in toolEv), 'detail should be absent when state.title is missing');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('createOpencodeParser — edge cases', () => {
  it('returns [] for an empty line', () => {
    const parser = createOpencodeParser();
    assert.deepEqual(parser.parseLine(''), []);
  });

  it('returns [] for a whitespace-only line', () => {
    const parser = createOpencodeParser();
    assert.deepEqual(parser.parseLine('   '), []);
  });

  it('returns [] for a non-JSON line', () => {
    const parser = createOpencodeParser();
    assert.deepEqual(parser.parseLine('not json at all'), []);
  });

  it('returns [] for an unknown event type', () => {
    const parser = createOpencodeParser();
    const line = JSON.stringify({ type: 'unknown_future_type', data: 42 });
    assert.deepEqual(parser.parseLine(line), []);
  });

  it('finalize on a fresh parser returns an error instead of a blank success', () => {
    const parser = createOpencodeParser();
    const events = parser.finalize();
    const error = events.find(
      (e): e is Extract<ProviderEvent, { type: 'error' }> => e.type === 'error',
    );
    assert.ok(error !== undefined, 'expected an error from a fresh parser');
    assert.equal(error.error.category, 'unknown');
    assert.equal(error.error.message, 'opencode produced no output');
  });

  it('omits cachedInputTokens and cacheWriteInputTokens in done when cache fields are absent', () => {
    const parser = createOpencodeParser();
    const line = JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 10, output: 5 },
        cost: 0,
      },
    });
    parser.parseLine(line);
    const events = parser.finalize();
    const done = events.find(
      (e): e is Extract<ProviderEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done !== undefined, 'expected a done event');
    assert.ok(
      !('cachedInputTokens' in (done.usage ?? {})),
      'cachedInputTokens must be absent when cache.read is not reported',
    );
    assert.ok(
      !('cacheWriteInputTokens' in (done.usage ?? {})),
      'cacheWriteInputTokens must be absent when cache.write is not reported',
    );
  });
});

// ---------------------------------------------------------------------------
// Synthetic accumulation: two step_finish events with cache.read and cache.write
// ---------------------------------------------------------------------------

describe('createOpencodeParser — cache accumulation', () => {
  it('two step_finish lines with cache.write and cache.read accumulate into both usage events and final done usage', () => {
    const parser = createOpencodeParser();
    const line1 = JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 50, output: 10, cache: { read: 400, write: 200 } },
        cost: 0,
      },
    });
    const line2 = JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { input: 30, output: 5, cache: { read: 200, write: 100 } },
        cost: 0,
      },
    });
    const events1 = parser.parseLine(line1);
    const events2 = parser.parseLine(line2);
    const finalEvents = parser.finalize();

    // First usage event has per-step caches
    const usage1 = events1.find((e) => e.type === 'usage');
    assert.ok(usage1 !== undefined, 'expected first usage event');
    assert.equal(usage1?.usage?.cachedInputTokens, 400);
    assert.equal(usage1?.usage?.cacheWriteInputTokens, 200);

    // Second usage event has per-step caches
    const usage2 = events2.find((e) => e.type === 'usage');
    assert.ok(usage2 !== undefined, 'expected second usage event');
    assert.equal(usage2?.usage?.cachedInputTokens, 200);
    assert.equal(usage2?.usage?.cacheWriteInputTokens, 100);

    // Final done has accumulated totals: read=600, write=300, input=80, output=15
    const done = finalEvents.find((e) => e.type === 'done');
    assert.ok(done !== undefined, 'expected a done event');
    assert.equal(done?.usage?.inputTokens, 80);
    assert.equal(done?.usage?.outputTokens, 15);
    assert.equal(done?.usage?.cachedInputTokens, 600);
    assert.equal(done?.usage?.cacheWriteInputTokens, 300);
  });
});
