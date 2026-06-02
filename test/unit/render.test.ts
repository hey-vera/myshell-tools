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
        inputTokens: 1200,
        outputTokens: 300,
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

    const result = await renderStream(makeStream(events), sink, 'verbose');
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

    // Real, measured tokens rendered (subscription tool — no per-token $ on the hot path)
    assert.ok(joined.includes('1.5k tokens'), `Should show real token total, got:\n${joined}`);
    assert.ok(!joined.includes('$'), `Hot path must show NO dollar figure, got:\n${joined}`);

    // Session id rendered truthfully
    assert.ok(joined.includes('test-session-id-1'), 'Should contain the real sessionId');

    // Classification details NOT present by default (MYSHELL_DEBUG is not set)
    // Tier name still appears from tier-start/tier-done lines
    assert.ok(joined.includes('ic'), 'Should contain tier name (from tier-start/tier-done)');

    // The 'Classified:' line must NOT appear without MYSHELL_DEBUG
    assert.ok(
      !joined.includes('Classified:'),
      'Classified line must be suppressed by default (no MYSHELL_DEBUG)',
    );

    // No forbidden mock substrings (honesty guard)
    const forbidden = ['JWT', 'Authentication bug', 'Found', 'relevant files', 'sess-abc', '8m 23s', '12 exchanges'];
    for (const f of forbidden) {
      assert.ok(!joined.includes(f), `Output must not contain forbidden mock string: "${f}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. Classified line appears when MYSHELL_DEBUG is set
// ---------------------------------------------------------------------------

describe('renderStream — classified line with MYSHELL_DEBUG', () => {
  it('emits "Classified:" line when MYSHELL_DEBUG is set', async () => {
    const origDebug = process.env['MYSHELL_DEBUG'];
    process.env['MYSHELL_DEBUG'] = '1';
    try {
      const sink = makeSink();
      const events: CoreEvent[] = [
        {
          type: 'classified',
          classification: { tier: 'ic', risk: 'medium', rationale: 'requires IC judgment' },
        },
        {
          type: 'final',
          success: true,
          output: '',
          tier: 'ic',
          totalCostUsd: 0,
          sessionId: 'debug-session',
          attempts: 1,
        },
      ];

      await renderStream(makeStream(events), sink);
      const joined = sink.buf.join('');

      assert.ok(
        joined.includes('Classified:'),
        'Classified line must appear when MYSHELL_DEBUG is set',
      );
      assert.ok(joined.includes('requires IC judgment'), 'Rationale must appear when MYSHELL_DEBUG is set');
    } finally {
      if (origDebug !== undefined) {
        process.env['MYSHELL_DEBUG'] = origDebug;
      } else {
        delete process.env['MYSHELL_DEBUG'];
      }
    }
  });

  it('does NOT emit "Classified:" line when MYSHELL_DEBUG is unset', async () => {
    const origDebug = process.env['MYSHELL_DEBUG'];
    delete process.env['MYSHELL_DEBUG'];
    try {
      const sink = makeSink();
      const events: CoreEvent[] = [
        {
          type: 'classified',
          classification: { tier: 'worker', risk: 'low', rationale: 'simple task' },
        },
        {
          type: 'final',
          success: true,
          output: '',
          tier: 'worker',
          totalCostUsd: 0,
          sessionId: 'nodebug-session',
          attempts: 1,
        },
      ];

      await renderStream(makeStream(events), sink);
      const joined = sink.buf.join('');

      assert.ok(
        !joined.includes('Classified:'),
        'Classified line must be absent when MYSHELL_DEBUG is not set',
      );
    } finally {
      if (origDebug !== undefined) {
        process.env['MYSHELL_DEBUG'] = origDebug;
      }
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

    const result = await renderStream(makeStream(events), sink, 'verbose');
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

    const result = await renderStream(makeStream(events), sink, 'verbose');
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

    const result = await renderStream(makeStream(events), sink, 'verbose');
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

    const result = await renderStream(makeStream(events), sink, 'verbose');
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
// 8. Per-tier token display + accumulated token total on the final line
// ---------------------------------------------------------------------------

describe('renderStream — token display (no dollar meter)', () => {
  it('shows per-tier tokens and an accumulated token total on the final line', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'tier-done',
        tier: 'worker',
        success: true,
        confidence: 0.75,
        costUsd: 0.0050,
        inputTokens: 1000,
        outputTokens: 200, // 1.2k
        durationMs: 400,
      },
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        costUsd: 0.0073,
        inputTokens: 2000,
        outputTokens: 300, // 2.3k → total 3.5k
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

    await renderStream(makeStream(events), sink, 'verbose');
    const buf = sink.buf.join('');
    const lines = buf.split('\n');

    const tierDoneLines = lines.filter(l => l.includes('tier done'));
    assert.equal(tierDoneLines.length, 2, 'Should have two tier-done lines');

    // Each tier-done shows its own real token count.
    assert.ok(tierDoneLines[0].includes('1.2k tokens'), `First tier-done tokens, got: ${tierDoneLines[0]}`);
    assert.ok(tierDoneLines[1].includes('2.3k tokens'), `Second tier-done tokens, got: ${tierDoneLines[1]}`);

    // Final line shows the accumulated real total (1.2k + 2.3k = 3.5k), not dollars.
    const finalLine = lines.find(l => l.includes('Success')) ?? '';
    assert.ok(finalLine.includes('3.5k tokens'), `Final line must show accumulated tokens, got: ${finalLine}`);

    // Hard guarantee: no dollar figure anywhere on the hot path.
    assert.ok(!buf.includes('$'), `Render output must contain no "$" figure, got:\n${buf}`);
  });
});

// ---------------------------------------------------------------------------
// 9. Envelope stripping — the confidence envelope must NEVER reach the user
// ---------------------------------------------------------------------------

/** Build a minimal text→final stream with the given prose deltas. */
function textStream(deltas: string[]): CoreEvent[] {
  const evs: CoreEvent[] = deltas.map((delta) => ({
    type: 'provider-event' as const,
    tier: 'ic' as const,
    event: { type: 'text' as const, delta },
  }));
  evs.push({
    type: 'final',
    success: true,
    output: deltas.join(''),
    tier: 'ic',
    totalCostUsd: 0,
    sessionId: 'env-session',
    attempts: 1,
  });
  return evs;
}

describe('renderStream — confidence envelope stripping', () => {
  const ENVELOPE = '{"confidence": 0.9, "escalate": false, "reason": "ok", "needs_review": false}';

  it('strips a trailing envelope that arrives in a single delta', async () => {
    const sink = makeSink();
    const events = textStream([`Here is the answer.\n${ENVELOPE}`]);
    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes('Here is the answer.'), 'Prose must survive');
    assert.ok(!joined.includes('"confidence"'), 'Envelope JSON must NOT be shown');
    assert.ok(!joined.includes('needs_review'), 'No envelope key should leak');
  });

  it('strips a trailing envelope SPLIT across multiple deltas', async () => {
    const sink = makeSink();
    // Split the envelope across several deltas, with prose preceding it.
    const events = textStream([
      'Refactored the ',
      'module.\n',
      '{"confidence": 0.7,',
      ' "escalate": true,',
      ' "reason": "needs a look",',
      ' "needs_review": true}',
    ]);
    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes('Refactored the module.'), 'Prose must stream fully');
    assert.ok(!joined.includes('"confidence"'), 'Split envelope must NOT leak');
    assert.ok(!joined.includes('"reason"'), 'No envelope fragment may leak');
    assert.ok(!joined.includes('needs_review'), 'No envelope fragment may leak');
  });

  it('streams a response with NO envelope completely unchanged', async () => {
    const sink = makeSink();
    const prose = 'The build succeeded and all tests passed.';
    const events = textStream([prose]);
    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes(prose), 'Plain prose must be shown verbatim');
  });

  it('does NOT strip a non-trailing {…} that merely mentions confidence', async () => {
    const sink = makeSink();
    // A JSON object containing the word "confidence" in the MIDDLE of prose,
    // followed by more text — this is real content, not the trailing envelope.
    const inline = '{"confidence": 0.5}';
    const events = textStream([
      `Consider this config ${inline} which sets the confidence threshold.`,
    ]);
    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes(inline), 'Non-trailing JSON object must NOT be stripped');
    assert.ok(
      joined.includes('which sets the confidence threshold.'),
      'Trailing prose after the inline object must be shown',
    );
  });

  it('strips the envelope even when text deltas continue after it (last wins)', async () => {
    const sink = makeSink();
    // Defensive: a non-trailing object earlier, then a genuine trailing envelope.
    const events = textStream([
      'Use {"mode":"fast"} for speed.\n',
      '{"confidence": 0.95, "escalate": false, "reason": "done", "needs_review": false}',
    ]);
    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes('{"mode":"fast"}'), 'Earlier non-envelope object stays');
    assert.ok(!joined.includes('"confidence"'), 'Trailing envelope is stripped');
  });
});

// ---------------------------------------------------------------------------
// 10. Verbosity gating — tool/telemetry chrome hidden by default; errors always
// ---------------------------------------------------------------------------

describe('renderStream — verbosity gating', () => {
  const toolEvents: CoreEvent[] = [
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
      event: { type: 'tool', name: 'read_file', phase: 'start' },
    },
    {
      type: 'provider-event',
      tier: 'ic',
      event: { type: 'reasoning', delta: 'thinking hard' },
    },
    {
      type: 'provider-event',
      tier: 'ic',
      event: { type: 'text', delta: 'The answer.' },
    },
    {
      type: 'tier-done',
      tier: 'ic',
      success: true,
      confidence: 0.9,
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 100,
    },
    {
      type: 'final',
      success: true,
      output: 'The answer.',
      tier: 'ic',
      totalCostUsd: 0,
      sessionId: 'verb-session',
      attempts: 1,
    },
  ];

  it('verbose shows tool lines, reasoning, and tier telemetry', async () => {
    const sink = makeSink();
    await renderStream(makeStream(toolEvents), sink, 'verbose');
    const joined = sink.buf.join('');

    assert.ok(joined.includes('[tool]'), 'verbose shows [tool] lines');
    assert.ok(joined.includes('read_file'), 'verbose shows tool name');
    assert.ok(joined.includes('thinking hard'), 'verbose shows reasoning');
    assert.ok(joined.includes('tier done'), 'verbose shows tier telemetry');
    assert.ok(joined.includes('The answer.'), 'prose always shown');
  });

  it('normal (default) hides tool lines, reasoning, and tier telemetry but shows prose', async () => {
    const sink = makeSink();
    await renderStream(makeStream(toolEvents), sink); // default normal
    const joined = sink.buf.join('');

    assert.ok(!joined.includes('[tool]'), 'normal hides [tool] lines');
    assert.ok(!joined.includes('thinking hard'), 'normal hides reasoning');
    assert.ok(!joined.includes('tier done'), 'normal hides tier telemetry');
    assert.ok(joined.includes('The answer.'), 'normal shows prose');
  });

  it('quiet hides tool lines and the completion status line', async () => {
    const sink = makeSink();
    await renderStream(makeStream(toolEvents), sink, 'quiet');
    const joined = sink.buf.join('');

    assert.ok(!joined.includes('[tool]'), 'quiet hides [tool] lines');
    assert.ok(!joined.includes('thinking hard'), 'quiet hides reasoning');
    assert.ok(!joined.includes('tier done'), 'quiet hides tier telemetry');
    assert.ok(!joined.includes('done ('), 'quiet hides the completion status line');
    assert.ok(joined.includes('The answer.'), 'quiet still shows prose');
  });
});

// ---------------------------------------------------------------------------
// 11. Actionable errors — suggestion rendered on failure in EVERY verbosity
// ---------------------------------------------------------------------------

describe('renderStream — actionable error suggestion', () => {
  function failStream(): CoreEvent[] {
    return [
      {
        type: 'final',
        success: false,
        output: 'auth failed',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'fail-session',
        attempts: 1,
        errorCategory: 'auth',
        provider: 'claude',
      },
    ];
  }

  for (const verbosity of ['quiet', 'normal', 'verbose'] as const) {
    it(`shows the error suggestion in ${verbosity} mode`, async () => {
      const sink = makeSink();
      await renderStream(makeStream(failStream()), sink, verbosity);
      const joined = sink.buf.join('');

      // formatErrorMessage() output includes a "Suggestion:" line and the
      // category-specific actionable text (re-authenticate).
      assert.ok(joined.includes('Suggestion:'), `${verbosity}: suggestion line shown`);
      assert.ok(
        joined.toLowerCase().includes('re-authenticate'),
        `${verbosity}: actionable auth suggestion shown`,
      );
      // Provider name is woven into the formatted error label.
      assert.ok(joined.includes('CLAUDE'), `${verbosity}: provider name in error label`);
    });
  }
});
