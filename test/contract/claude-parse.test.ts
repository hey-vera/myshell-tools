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
