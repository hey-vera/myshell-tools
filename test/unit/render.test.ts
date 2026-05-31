/**
 * Unit tests for src/interface/render.ts
 *
 * Drives renderStream() with scripted CoreEvent sequences and asserts that
 * all displayed values come directly from event data (honesty contract) —
 * no fabricated metrics, no hardcoded mock substrings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderStream } from '../../src/interface/render.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { CoreEvent } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a non-colour capturing OutputSink. */
function makeSink(): OutputSink & { buf: string[] } {
  const buf: string[] = [];
  return {
    buf,
    write: (s: string) => { buf.push(s); },
    color: false,
    isTty: false,
  };
}

/** Yield the given events from an async generator. */
async function* makeStream(events: CoreEvent[]): AsyncIterable<CoreEvent> {
  for (const ev of events) {
    yield ev;
  }
}

// ---------------------------------------------------------------------------
// 1. Happy-path: full event sequence with real confidence + cost
// ---------------------------------------------------------------------------

describe('renderStream — happy path with confidence 0.8', () => {
  it('renders all events truthfully and returns success:true', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'classified',
        classification: { tier: 'ic', risk: 'medium', rationale: 'requires IC judgment' },
      },
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        attempt: 1,
      },
      {
        type: 'provider-event',
        tier: 'ic',
        event: { type: 'text', delta: 'Refactored the module.' },
      },
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.8,
        costUsd: 0.0123,
        durationMs: 1500,
      },
      {
        type: 'final',
        success: true,
        output: 'Refactored the module.',
        tier: 'ic',
        totalCostUsd: 0.0123,
        sessionId: 'test-session-id-1',
        attempts: 1,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    // Return value
    assert.equal(result.success, true);
    assert.ok(result.final !== undefined);
    assert.equal(result.final.success, true);

    // Real model id appears in output
    assert.ok(joined.includes('claude-sonnet-4-6'), 'Should contain the real model id');

    // Real streamed text delta appears verbatim
    assert.ok(joined.includes('Refactored the module.'), 'Should contain the streamed text delta');

    // Confidence rendered as computed percentage from 0.8
    assert.ok(joined.includes('80'), 'Should contain confidence 80 (from 0.8 * 100)');

    // Cost rendered truthfully
    assert.ok(joined.includes('$0.0123'), 'Should contain the real cost');

    // Session id rendered truthfully
    assert.ok(joined.includes('test-session-id-1'), 'Should contain the real sessionId');

    // Classification details present
    assert.ok(joined.includes('ic'), 'Should contain tier name');
    assert.ok(joined.includes('medium'), 'Should contain risk level');
    assert.ok(joined.includes('requires IC judgment'), 'Should contain the rationale');

    // No forbidden mock substrings (honesty guard)
    const forbidden = ['JWT', 'Authentication bug', 'Found', 'relevant files', 'sess-abc', '8m 23s', '12 exchanges'];
    for (const f of forbidden) {
      assert.ok(!joined.includes(f), `Output must not contain forbidden mock string: "${f}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. confidence: null → renders "unrated", no bare percentage
// ---------------------------------------------------------------------------

describe('renderStream — confidence null', () => {
  it('renders "unrated" and does not contain any bare % digit', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'classified',
        classification: { tier: 'worker', risk: 'low', rationale: 'simple task' },
      },
      {
        type: 'tier-done',
        tier: 'worker',
        success: true,
        confidence: null,
        costUsd: 0.0010,
        durationMs: 800,
      },
      {
        type: 'final',
        success: true,
        output: 'Done.',
        tier: 'worker',
        totalCostUsd: 0.0010,
        sessionId: 'test-session-id-2',
        attempts: 1,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, true);

    // Must contain the word "unrated"
    assert.ok(joined.includes('unrated'), 'Should contain "unrated" when confidence is null');

    // Must NOT contain a bare digit followed by %
    // (The honesty guard checks \d+% in source; here we verify the rendered output
    //  also never fabricates a percentage for a null-confidence event.)
    const hasBarePercent = /\d+%/.test(joined);
    assert.ok(!hasBarePercent, 'Output must not contain a bare digit-% when confidence is null');
  });
});

// ---------------------------------------------------------------------------
// 3. final{success:false} → returns {success:false}
// ---------------------------------------------------------------------------

describe('renderStream — final success:false', () => {
  it('returns success:false and renders a failure line', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'notice',
        level: 'error',
        message: 'No providers are available.',
      },
      {
        type: 'final',
        success: false,
        output: 'No providers available.',
        tier: 'worker',
        totalCostUsd: 0,
        sessionId: 'test-session-id-3',
        attempts: 0,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, false);
    assert.ok(result.final !== undefined);
    assert.equal(result.final.success, false);

    // Should contain the error notice message
    assert.ok(joined.includes('No providers are available.'), 'Should render the error notice');

    // Should contain the failure summary
    assert.ok(joined.includes('Failed') || joined.includes('failed') || joined.includes('false'),
      'Should render a failure indicator');

    // Session id still rendered
    assert.ok(joined.includes('test-session-id-3'), 'Should contain the real sessionId even on failure');
  });
});

// ---------------------------------------------------------------------------
// 4. tool and reasoning provider-events render correctly
// ---------------------------------------------------------------------------

describe('renderStream — tool and reasoning events', () => {
  it('renders tool events as one-liners and reasoning events as dim text', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'provider-event',
        tier: 'ic',
        event: { type: 'tool', name: 'read_file', phase: 'start' },
      },
      {
        type: 'provider-event',
        tier: 'ic',
        event: { type: 'reasoning', delta: 'thinking...' },
      },
      {
        type: 'provider-event',
        tier: 'ic',
        event: { type: 'tool', name: 'read_file', phase: 'end' },
      },
      {
        type: 'final',
        success: true,
        output: '',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'tool-session',
        attempts: 1,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, true);
    assert.ok(joined.includes('[tool]'), 'Should render [tool] prefix');
    assert.ok(joined.includes('read_file'), 'Should render real tool name');
    assert.ok(joined.includes('thinking...'), 'Should render reasoning delta');
  });
});

// ---------------------------------------------------------------------------
// 5. escalate + notice events render their real messages
// ---------------------------------------------------------------------------

describe('renderStream — escalate and notice events', () => {
  it('renders escalate and notice with real data', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'escalate',
        from: 'worker',
        to: 'ic',
        reason: 'confidence below threshold',
      },
      {
        type: 'notice',
        level: 'warn',
        message: 'provider latency is high',
      },
      {
        type: 'final',
        success: false,
        output: '',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'escalate-session',
        attempts: 2,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, false);
    assert.ok(joined.includes('confidence below threshold'), 'Should render real escalation reason');
    assert.ok(joined.includes('provider latency is high'), 'Should render real notice message');
  });
});

// ---------------------------------------------------------------------------
// 7. failover event renders provider names and reason from real data
// ---------------------------------------------------------------------------

describe('renderStream — failover event', () => {
  it('renders failover with real from/to provider names, tier, and reason', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'failover',
        from: 'claude',
        to: 'codex',
        tier: 'ic',
        reason: 'connection reset',
      },
      {
        type: 'final',
        success: true,
        output: 'Done by codex.',
        tier: 'ic',
        totalCostUsd: 0.0050,
        sessionId: 'failover-session',
        attempts: 2,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, true);
    // Real provider names must appear in the output.
    assert.ok(joined.includes('claude'), 'Should contain the real from-provider name');
    assert.ok(joined.includes('codex'), 'Should contain the real to-provider name');
    // Real tier must appear.
    assert.ok(joined.includes('ic'), 'Should contain the real tier');
    // Real reason must appear verbatim.
    assert.ok(joined.includes('connection reset'), 'Should contain the real failure reason');
  });
});

// ---------------------------------------------------------------------------
// 6. No final event emitted → returns success:false
// ---------------------------------------------------------------------------

describe('renderStream — no final event', () => {
  it('returns success:false and no final property when stream ends without final', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'notice',
        level: 'info',
        message: 'stream ended early',
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    assert.equal(result.success, false);
    assert.equal(result.final, undefined);
  });
});

// ---------------------------------------------------------------------------
// 8. Running session cost accumulates across multiple tier-done events
// ---------------------------------------------------------------------------

describe('renderStream — running session cost meter', () => {
  it('shows accumulating session so far totals on each tier-done line', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'tier-done',
        tier: 'worker',
        success: true,
        confidence: 0.75,
        costUsd: 0.0050,
        durationMs: 400,
      },
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        costUsd: 0.0073,
        durationMs: 900,
      },
      {
        type: 'final',
        success: true,
        output: 'Done.',
        tier: 'ic',
        totalCostUsd: 0.0123,
        sessionId: 'session-meter-test',
        attempts: 2,
      },
    ];

    await renderStream(makeStream(events), sink);
    const lines = sink.buf.join('').split('\n');

    // Find the two tier-done lines
    const tierDoneLines = lines.filter(l => l.includes('tier done'));
    assert.equal(tierDoneLines.length, 2, 'Should have two tier-done lines');

    // First tier-done: session so far = $0.0050
    assert.ok(
      tierDoneLines[0].includes('session so far: $0.0050'),
      `First tier-done must show session so far: $0.0050, got: ${tierDoneLines[0]}`,
    );

    // Second tier-done: session so far = $0.0050 + $0.0073 = $0.0123
    assert.ok(
      tierDoneLines[1].includes('session so far: $0.0123'),
      `Second tier-done must show session so far: $0.0123 (accumulated sum), got: ${tierDoneLines[1]}`,
    );

    // Per-tier cost on each line is still the individual cost, not the running total
    assert.ok(
      tierDoneLines[0].includes('cost: $0.0050'),
      `First tier-done must still show per-tier cost: $0.0050, got: ${tierDoneLines[0]}`,
    );
    assert.ok(
      tierDoneLines[1].includes('cost: $0.0073'),
      `Second tier-done must still show per-tier cost: $0.0073, got: ${tierDoneLines[1]}`,
    );
  });
});
