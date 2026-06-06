/**
 * Unit tests for src/interface/render.ts
 *
 * Drives renderStream() with scripted CoreEvent sequences and asserts that
 * all displayed values come directly from event data (honesty contract) —
 * no fabricated metrics, no hardcoded mock substrings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderInputPrompt, renderQueuedIndicator, renderStream } from '../../src/interface/render.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { CoreEvent } from '../../src/core/types.ts';
import { panelLabel, styleInlineMarkdown } from '../../src/ui/theme.ts';

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

describe('input prompt renderer', () => {
  it('renders a bordered input box for a wide colour TTY', () => {
    const prompt = renderInputPrompt({
      color: true,
      isTty: true,
      columns: 80,
    });

    assert.ok(prompt.includes('╭'), 'top-left box corner is rendered');
    assert.ok(prompt.includes('╮'), 'top-right box corner is rendered');
    assert.ok(prompt.includes('│ ❯'), 'caret lives inside the box');
    assert.ok(prompt.includes('╰'), 'bottom-left box corner is rendered');
    assert.ok(prompt.includes('✦'), 'top-right glyph is rendered');
    assert.ok(prompt.endsWith('│ ❯ '), 'cursor is returned to the editable caret row');
  });

  it('degrades to the plain caret off-TTY, without colour, and when narrow', () => {
    assert.equal(renderInputPrompt({ color: true, isTty: false, columns: 80 }), '❯ ');
    assert.equal(renderInputPrompt({ color: false, isTty: true, columns: 80 }), '❯ ');
    assert.equal(renderInputPrompt({ color: true, isTty: true, columns: 24 }), '❯ ');
  });

  it('renders the queued indicator text with the queue count', () => {
    assert.equal(renderQueuedIndicator(2, false), '⏎ queued (2)');
  });
});

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

  it('renders canceled finals calmly without the failure summary', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'final',
        success: false,
        output: 'Task was cancelled.',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'cancel-session',
        attempts: 1,
        canceled: true,
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, false);
    assert.ok(result.final !== undefined && result.final.canceled === true);
    assert.ok(joined.includes('■ Cancelled'), `Should render a calm cancelled line, got:\n${joined}`);
    assert.ok(!joined.includes('Failed'), `Cancellation must not render the failure summary, got:\n${joined}`);
    assert.ok(!joined.includes('cancel-session'), 'Cancellation must skip failure telemetry');
  });

  it('frames timeout finals as big single-turn work, not a bare crash failure', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'final',
        success: false,
        output: 'The request timed out.',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'timeout-session',
        attempts: 1,
        errorCategory: 'timeout',
        provider: 'claude',
      },
    ];

    const result = await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.equal(result.success, false);
    assert.ok(joined.includes('single-turn time limit'), `Should explain the time limit, got:\n${joined}`);
    assert.ok(joined.includes('big task'), `Should frame this as big work, got:\n${joined}`);
    assert.ok(joined.includes('Timed out after one turn'), `Should still be truthful, got:\n${joined}`);
    assert.ok(joined.includes('0 tokens'), `Should show the real measured token total, got:\n${joined}`);
    assert.ok(!joined.includes('Failed'), `Timeout must not render the stark failure summary, got:\n${joined}`);
    assert.ok(!joined.includes('CLAUDE Error [timeout]'), `Timeout must not render the crash-like provider error line, got:\n${joined}`);
  });

  it('keeps non-timeout failures on the existing failure path', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      {
        type: 'final',
        success: false,
        output: 'Authentication failed.',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'auth-session',
        attempts: 1,
        errorCategory: 'auth',
        provider: 'claude',
      },
    ];

    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes('Failed'), `Non-timeout failure summary should remain, got:\n${joined}`);
    assert.ok(joined.includes('auth-session'), `Existing failure telemetry should remain, got:\n${joined}`);
    assert.ok(!joined.includes('single-turn time limit'), `Non-timeout failures should not use timeout framing, got:\n${joined}`);
  });
});

describe('renderStream — rate-limit collection (cooldown signal survives failover)', () => {
  it('captures a provider that hit a 429 even when failover rescues the turn into success', async () => {
    const sink = makeSink();

    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 1 },
      {
        type: 'provider-event',
        tier: 'ic',
        event: { type: 'error', error: { category: 'rate-limit', recoverable: true, message: '429 too many requests', suggestion: 'wait and retry' } },
      },
      { type: 'failover', from: 'claude', to: 'codex', tier: 'ic', reason: 'rate limit' },
      { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt-5.4', attempt: 2 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Done.' } },
      {
        type: 'final',
        success: true, // failover rescued the turn
        output: 'Done.',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'rl-session',
        attempts: 2,
      },
    ];

    const result = await renderStream(makeStream(events), sink);

    assert.equal(result.success, true, 'turn succeeded via failover');
    // …but claude's 429 must still be captured for cooldown, attributed to claude
    // (the provider that was running when the error fired), not codex.
    assert.deepEqual([...result.rateLimitedProviders], ['claude']);
  });

  it('returns an empty rate-limit set on a clean run', async () => {
    const sink = makeSink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Hi.' } },
      { type: 'final', success: true, output: 'Hi.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    const result = await renderStream(makeStream(events), sink);
    assert.equal(result.rateLimitedProviders.length, 0);
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
// 4b. live working indicator — token readout + post-prose revival (TTY)
// ---------------------------------------------------------------------------

describe('renderStream — live working indicator (TTY)', () => {
  /** A TTY sink so the live indicator (spinner) actually paints its label. */
  function makeTtySink(): OutputSink & { buf: string[] } {
    const buf: string[] = [];
    return { buf, write: (s: string) => { buf.push(s); }, color: false, isTty: true };
  }

  it('starts the default Thinking indicator before a delayed first event arrives', async () => {
    const sink = makeTtySink();
    let yieldedFirstEvent = false;
    async function* delayedStream(): AsyncIterable<CoreEvent> {
      await new Promise((resolve) => setTimeout(resolve, 25));
      yieldedFirstEvent = true;
      yield { type: 'final', success: true, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 0 };
    }

    const rendering = renderStream(delayedStream(), sink, 'normal');
    try {
      const immediate = sink.buf.join('');
      assert.equal(yieldedFirstEvent, false, 'the stream has not yielded its first event yet');
      assert.ok(immediate.includes('Thinking… 0 steps'), 'default Thinking label is visible immediately');
      assert.ok(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(immediate), 'spinner frame is painted immediately');
    } finally {
      await rendering;
    }
  });

  it('shows a "↓ ~N tokens" readout and revives after prose for a post-answer tool phase', async () => {
    const sink = makeTtySink();
    const longProse = 'x'.repeat(400); // ≈100 tokens at 4 chars/token

    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6' },
      // Answer prose streams (stops the spinner, accumulates streamed bytes).
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: longProse } },
      // A tool runs AFTER the answer — the indicator must revive (not a dead line)
      // and now carry the streamed-token readout.
      { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'read_file', phase: 'start' } },
      { type: 'final', success: true, output: longProse, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];

    const result = await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');

    assert.equal(result.success, true);
    assert.ok(joined.includes('↓ ~'), 'live indicator must show a streamed-token readout');
    assert.ok(joined.includes('tokens'), 'readout is labelled in tokens');
    assert.ok(/1 step/.test(joined), 'post-prose tool phase counts a step (indicator revived)');
  });

  it('does not fabricate a token readout before any prose has streamed', async () => {
    const sink = makeTtySink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6' },
      // A tool fires before any answer text → steps shown, but no token figure.
      { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'read_file', phase: 'start' } },
      { type: 'final', success: true, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];

    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(/1 step/.test(joined), 'still shows the step counter');
    assert.ok(!joined.includes('↓ ~'), 'no token readout until prose actually streams');
  });
});

// ---------------------------------------------------------------------------
// 4c. trailing /goal control markers are stripped (never leak into the chat)
// ---------------------------------------------------------------------------

describe('renderStream — strips trailing GOAL_ control markers', () => {
  const runProse = async (deltas: string[]): Promise<string> => {
    const sink = makeSink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6' },
      ...deltas.map((delta) => ({ type: 'provider-event' as const, tier: 'ic' as const, event: { type: 'text' as const, delta } })),
      { type: 'final', success: true, output: deltas.join(''), tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    return sink.buf.join('');
  };

  it('strips a trailing GOAL_CONTINUE marker but keeps the prose', async () => {
    const out = await runProse(['Did the thing.\n', 'GOAL_CONTINUE: do the next thing']);
    assert.ok(out.includes('Did the thing.'), 'real prose is shown');
    assert.ok(!out.includes('GOAL_CONTINUE'), 'the control marker must not leak');
    assert.ok(!out.includes('do the next thing'), 'the marker payload must not leak');
  });

  it('strips a trailing GOAL_COMPLETE marker', async () => {
    const out = await runProse(['All done and verified.\n', 'GOAL_COMPLETE']);
    assert.ok(out.includes('All done and verified.'));
    assert.ok(!out.includes('GOAL_COMPLETE'));
  });

  it('strips a marker split across deltas', async () => {
    const out = await runProse(['Progress made.\n', 'GOAL_CO', 'NTINUE: keep going']);
    assert.ok(out.includes('Progress made.'));
    assert.ok(!out.includes('GOAL_CONTINUE'));
    assert.ok(!out.includes('keep going'));
  });

  it('does NOT strip a non-marker line that merely starts with GOAL_', async () => {
    const out = await runProse(['The GOAL_CRITERIA were all met.']);
    assert.ok(out.includes('GOAL_CRITERIA were all met'), 'ordinary prose beginning with GOAL_ is kept');
  });

  it('does NOT strip a GOAL_ mention that is not the trailing line', async () => {
    const out = await runProse(['GOAL_CONTINUE appeared mid-text here.\nBut this is the real ending.']);
    assert.ok(out.includes('But this is the real ending.'));
    assert.ok(out.includes('GOAL_CONTINUE appeared mid-text'), 'only the trailing line is a control marker');
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

  it('strips a superseded attempt envelope at tier-done before the next attempt streams', async () => {
    const sink = makeSink();
    const events: CoreEvent[] = [
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
        event: { type: 'text', delta: 'Draft answer' },
      },
      {
        type: 'provider-event',
        tier: 'ic',
        event: { type: 'text', delta: '{"confidence": 0.4, "escalate": true' },
      },
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.4,
        costUsd: 0,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 10,
      },
      {
        type: 'tier-start',
        tier: 'manager',
        provider: 'codex',
        model: 'gpt-5.5',
        attempt: 2,
      },
      {
        type: 'provider-event',
        tier: 'manager',
        event: { type: 'text', delta: 'Final answer.\n{"verdict": "approve"}' },
      },
      {
        type: 'tier-done',
        tier: 'manager',
        success: true,
        confidence: 0.9,
        costUsd: 0,
        inputTokens: 120,
        outputTokens: 60,
        durationMs: 20,
      },
      {
        type: 'final',
        success: true,
        output: 'Final answer.',
        tier: 'manager',
        totalCostUsd: 0,
        sessionId: 'attempt-boundary-session',
        attempts: 2,
      },
    ];

    await renderStream(makeStream(events), sink);
    const joined = sink.buf.join('');

    assert.ok(joined.includes('Draft answer'), 'Superseded attempt prose may be shown');
    assert.ok(joined.includes('Final answer.'), 'Accepted attempt prose must be shown');
    assert.ok(!joined.includes('{"confidence"'), 'Attempt-1 control envelope fragment must not leak');
    assert.ok(!joined.includes('"verdict"'), 'Trailing verdict envelope must not leak');
    assert.ok(!joined.includes('answerFinal'), 'Attempts must not glue together mid-token');
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

// ---------------------------------------------------------------------------
// 12. ask_user envelope stripping + suppressed completion line on questions
// ---------------------------------------------------------------------------

describe('renderStream — ask_user block stripping', () => {
  const ASK_USER =
    '{"ask_user":{"questions":[{"id":"framework","prompt":"Which?","options":[{"label":"vitest"},{"label":"jest"}],"multiSelect":false,"allowFreeText":true}]}}';
  const QUESTIONS = {
    questions: [
      {
        id: 'framework',
        prompt: 'Which?',
        options: [{ label: 'vitest' }, { label: 'jest' }],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  } as const;

  /** A text→final stream whose final carries `questions` (an ask_user turn). */
  function askStream(deltas: string[]): CoreEvent[] {
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
      sessionId: 'ask-session',
      attempts: 1,
      questions: QUESTIONS,
    });
    return evs;
  }

  it('strips a trailing ask_user block from display (single delta)', async () => {
    const sink = makeSink();
    await renderStream(makeStream(askStream([`I need a decision.\n${ASK_USER}`])), sink);
    const joined = sink.buf.join('');
    assert.ok(joined.includes('I need a decision.'), 'lead-in prose must survive');
    assert.ok(!joined.includes('ask_user'), 'the ask_user block must NOT be shown');
    assert.ok(!joined.includes('"questions"'), 'no block fragment may leak');
  });

  it('strips an ask_user block SPLIT across deltas', async () => {
    const sink = makeSink();
    await renderStream(
      makeStream(
        askStream([
          'Pick a ',
          'framework.\n',
          '{"ask_user":{"questions":[',
          '{"id":"framework","prompt":"Which?",',
          '"options":[{"label":"vitest"},{"label":"jest"}],',
          '"multiSelect":false,"allowFreeText":true}]}}',
        ]),
      ),
      sink,
    );
    const joined = sink.buf.join('');
    assert.ok(joined.includes('Pick a framework.'), 'prose streams fully');
    assert.ok(!joined.includes('ask_user'), 'split block must NOT leak');
    assert.ok(!joined.includes('allowFreeText'), 'no fragment may leak');
  });

  it('does NOT print the normal completion line on a question turn', async () => {
    const sink = makeSink();
    const result = await renderStream(
      makeStream(askStream([`Need input.\n${ASK_USER}`])),
      sink,
      'verbose',
    );
    const joined = sink.buf.join('');
    assert.ok(!joined.includes('Success'), 'no Success line for a question turn');
    assert.ok(!joined.includes('✓ done'), 'no done line for a question turn');
    // The final is surfaced so the caller can drive the selector.
    assert.ok(result.final !== undefined && result.final.questions !== undefined);
  });

  it('still strips the confidence envelope on a normal turn (regression)', async () => {
    const sink = makeSink();
    const ENVELOPE = '{"confidence": 0.9, "escalate": false, "reason": "ok", "needs_review": false}';
    await renderStream(makeStream(textStream([`All set.\n${ENVELOPE}`])), sink);
    const joined = sink.buf.join('');
    assert.ok(joined.includes('All set.'), 'prose survives');
    assert.ok(!joined.includes('"confidence"'), 'confidence envelope still stripped');
  });
});

// ---------------------------------------------------------------------------
// 13. remember_user block stripping (Phase 5 — no raw memory JSON leak)
// ---------------------------------------------------------------------------

describe('renderStream — remember_user block stripping', () => {
  it('strips a remember_user block carried INSIDE the confidence envelope', async () => {
    const sink = makeSink();
    const ENVELOPE =
      '{"confidence":0.9,"escalate":false,"reason":"ok","needs_review":false,' +
      '"remember_user":{"facts":[{"scope":"global","kind":"preference",' +
      '"text":"Prefers concise answers","reason":"stable pref"}]}}';
    await renderStream(makeStream(textStream([`All set.\n${ENVELOPE}`])), sink);
    const joined = sink.buf.join('');
    assert.ok(joined.includes('All set.'), 'prose survives');
    assert.ok(!joined.includes('remember_user'), 'remember_user must not be shown');
    assert.ok(!joined.includes('"facts"'), 'no block fragment may leak');
    assert.ok(!joined.includes('"confidence"'), 'envelope still stripped');
  });

  it('strips a BARE trailing remember_user block (no confidence key)', async () => {
    const sink = makeSink();
    const BARE =
      '{"remember_user":{"facts":[{"scope":"project","kind":"project",' +
      '"text":"heyvera should feel retro","reason":"durable project feel"}]}}';
    await renderStream(makeStream(textStream([`Done.\n${BARE}`])), sink);
    const joined = sink.buf.join('');
    assert.ok(joined.includes('Done.'), 'prose survives');
    assert.ok(!joined.includes('remember_user'), 'bare remember_user must not leak');
    assert.ok(!joined.includes('heyvera should feel retro'), 'no proposed fact text may leak');
  });

  it('strips a remember_user block SPLIT across deltas', async () => {
    const sink = makeSink();
    await renderStream(
      makeStream(
        textStream([
          'Captured.\n',
          '{"remember_user":{"facts":[',
          '{"scope":"global","kind":"preference",',
          '"text":"Prefers concise answers","reason":"pref"}]}}',
        ]),
      ),
      sink,
    );
    const joined = sink.buf.join('');
    assert.ok(joined.includes('Captured.'), 'prose streams fully');
    assert.ok(!joined.includes('remember_user'), 'split block must NOT leak');
    assert.ok(!joined.includes('"facts"'), 'no fragment may leak');
  });
});

// ---------------------------------------------------------------------------
// 14. Phase-1 presentation chrome — assistant `●`, final-state completion dot,
//     elapsed suffix, interrupt hint, and clean degradation off-colour/TTY.
// ---------------------------------------------------------------------------

const DOT = '●';

/** A colour-enabled TTY sink so glyph colours + the hint actually render. */
function makeColorTtySink(): OutputSink & { buf: string[] } {
  const buf: string[] = [];
  return { buf, write: (s: string) => { buf.push(s); }, color: true, isTty: true };
}

describe('renderStream — assistant ● turn marker', () => {
  it('does not put the semantic ● in the live spinner label, but keeps answer and completion dots', async () => {
    const sink = makeColorTtySink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Hello there.' } },
      { type: 'final', success: true, output: 'Hello there.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];

    await renderStream(makeStream(events), sink, 'normal');
    const spinnerFrames = sink.buf.filter((s) => /^\r[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(s));
    const joined = sink.buf.join('');

    assert.ok(spinnerFrames.length > 0, 'TTY render should paint a live spinner frame');
    assert.ok(
      spinnerFrames.every((s) => !s.includes(DOT)),
      `spinner label must not contain the semantic ●, got:\n${JSON.stringify(spinnerFrames)}`,
    );
    assert.ok(
      spinnerFrames.some((s) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking… 0 steps/.test(s)),
      `spinner should be only frame + label, got:\n${JSON.stringify(spinnerFrames)}`,
    );
    assert.ok(joined.includes(`\x1b[36m${DOT}\x1b[0m Hello there.`), 'answer prose still starts under cyan ●');
    assert.ok(joined.includes(`\x1b[32m${DOT}\x1b[0m `), 'completion line still carries green ●');
  });

  it('heads an assistant turn with a cyan streaming ● before the first prose delta', async () => {
    const sink = makeColorTtySink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Hello there.' } },
      { type: 'final', success: true, output: 'Hello there.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');

    // The streaming dot is cyan (\x1b[36m) and precedes the prose.
    assert.ok(joined.includes(`\x1b[36m${DOT}\x1b[0m `), 'cyan ● heads the streaming turn');
    const dotIdx = joined.indexOf(DOT);
    const proseIdx = joined.indexOf('Hello there.');
    assert.ok(dotIdx >= 0 && dotIdx < proseIdx, '● appears before the prose');
  });

  it('writes the prose-heading ● exactly once even when prose arrives in several deltas', async () => {
    // Non-TTY/non-colour sink: no spinner status line is painted, so the only
    // dots are the prose-heading marker (once) + the completion marker (once).
    // This isolates the "exactly one streaming dot per turn" guarantee from the
    // status-line dot that a TTY sink would also paint.
    const sink = makeSink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'one ' } },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'two ' } },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'three' } },
      { type: 'final', success: true, output: 'one two three', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    // One streaming dot + one completion dot = two ●s total; never one-per-delta.
    const count = [...joined].filter((ch) => ch === DOT).length;
    assert.equal(count, 2, `exactly one prose-heading ● + one completion ●, got ${count}`);
    // The heading dot sits immediately before the first prose, once.
    assert.equal(joined.split(`${DOT} one `).length - 1, 1, 'heading ● precedes the first delta exactly once');
  });
});

describe('renderStream — completion line carries the final-state dot/colour', () => {
  function streamWith(finalEv: CoreEvent): CoreEvent[] {
    return [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Answer.' } },
      finalEv,
    ];
  }

  it('success → green ● and an elapsed suffix on the normal done line', async () => {
    const sink = makeColorTtySink();
    const events = streamWith({
      type: 'final', success: true, output: 'Answer.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1,
    });
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    // Completion line: green ● + dim "✓ done · …".
    assert.ok(joined.includes(`\x1b[32m${DOT}\x1b[0m `), 'green ● on the success completion line');
    assert.ok(joined.includes('✓ done · '), 'success line uses the new "✓ done · N tokens" form');
  });

  it('appends the spinner elapsed (· Ns) to the normal success line when time passed', async () => {
    // Drive real ticks so spinner.elapsed() > 0, then assert it reaches the line.
    const { mock } = await import('node:test');
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const sink = makeColorTtySink();
      // A generator that lets the spinner animate between tier-start and final.
      async function* timedStream(): AsyncIterable<CoreEvent> {
        yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 };
        mock.timers.tick(80 * 30); // ~2s of spinner ticks
        yield { type: 'final', success: true, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
      }
      await renderStream(timedStream(), sink, 'normal');
      const joined = sink.buf.join('');
      assert.ok(/✓ done · .* · 2s/.test(joined), `success line carries elapsed "· 2s", got:\n${JSON.stringify(joined)}`);
    } finally {
      mock.timers.reset();
    }
  });

  it('failure → red ● on the Failed line', async () => {
    const sink = makeColorTtySink();
    const events = streamWith({
      type: 'final', success: false, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 2,
    });
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(joined.includes(`\x1b[31m${DOT}\x1b[0m `), 'red ● on the failure completion line');
    assert.ok(joined.includes('Failed'), 'failure summary still present');
  });

  it('cancel → dim ● on the Cancelled line', async () => {
    const sink = makeColorTtySink();
    const events = streamWith({
      type: 'final', success: false, output: '', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, canceled: true,
    });
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(joined.includes(`\x1b[2m${DOT}\x1b[0m `), 'dim ● on the cancelled completion line');
    assert.ok(joined.includes('■ Cancelled'), 'cancelled glyph line preserved');
  });

  it('question turn → NO completion line (selector follows), prose still under a ●', async () => {
    const sink = makeColorTtySink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Which one?' } },
      {
        type: 'final', success: true, output: 'Which one?', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1,
        questions: { questions: [{ id: 'q', prompt: 'Which?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false, allowFreeText: true }] },
      },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(joined.includes('Which one?'), 'lead-in prose shown');
    assert.ok(!joined.includes('✓ done'), 'no done line on a question turn');
    assert.ok(!joined.includes('Failed'), 'no failure line on a question turn');
  });
});

describe('renderStream — interrupt hint (passed in, TTY-only)', () => {
  const HINT = 'esc to interrupt · ctrl-c twice for menu';
  const events: CoreEvent[] = [
    { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
    { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Working.' } },
    { type: 'final', success: true, output: 'Working.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
  ];

  it('renders the passed-in hint once, dim, on a TTY', async () => {
    const sink = makeColorTtySink();
    await renderStream(makeStream(events), sink, 'normal', HINT);
    const joined = sink.buf.join('');
    assert.ok(joined.includes(HINT), 'the exact passed-in hint string is shown');
    assert.ok(joined.includes(`\x1b[2m${HINT}\x1b[0m`), 'the hint is dim');
    const occurrences = joined.split(HINT).length - 1;
    assert.equal(occurrences, 1, 'hint shown exactly once');
  });

  it('never renders the hint off-TTY (piped)', async () => {
    const sink = makeSink(); // non-TTY, non-colour
    await renderStream(makeStream(events), sink, 'normal', HINT);
    const joined = sink.buf.join('');
    assert.ok(!joined.includes(HINT), 'no interrupt hint in piped output');
  });

  it('renders no hint when none is passed', async () => {
    const sink = makeColorTtySink();
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(!joined.includes('interrupt'), 'no hint text when the param is omitted');
  });
});

describe('renderStream — degradation off-colour / non-TTY / MYSHELL_PLAIN', () => {
  const events: CoreEvent[] = [
    { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
    { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Plain answer.' } },
    { type: 'final', success: true, output: 'Plain answer.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
  ];

  it('non-colour/non-TTY: emits NO ANSI, no spinner frames, but keeps the structural ●', async () => {
    const sink = makeSink(); // color:false, isTty:false
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(!joined.includes('\x1b['), `piped output must contain zero ANSI bytes, got:\n${JSON.stringify(joined)}`);
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(joined), 'no braille spinner frames off-TTY');
    assert.ok(joined.includes(DOT), 'the structural ● is kept as a plain marker in pipes');
    assert.ok(joined.includes('Plain answer.'), 'prose is shown verbatim');
    // No elapsed suffix off-TTY (no ticks fired).
    assert.ok(!/· \d+s/.test(joined), 'no fabricated elapsed off-TTY');
  });

  it('MYSHELL_PLAIN drops the ● entirely from piped output', async () => {
    const orig = process.env['MYSHELL_PLAIN'];
    process.env['MYSHELL_PLAIN'] = '1';
    try {
      const sink = makeSink();
      await renderStream(makeStream(events), sink, 'normal');
      const joined = sink.buf.join('');
      assert.ok(!joined.includes(DOT), 'plain mode drops the ● marker for clean machine output');
      assert.ok(joined.includes('Plain answer.'), 'prose is still shown under MYSHELL_PLAIN');
      assert.ok(joined.includes('✓ done'), 'completion line still present (just no dot)');
    } finally {
      if (orig === undefined) delete process.env['MYSHELL_PLAIN'];
      else process.env['MYSHELL_PLAIN'] = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Phase 8 — multi-agent panel "Waiting on N models" + typed `phase` event
//     + lightweight inline markdown.
// ---------------------------------------------------------------------------

describe('panelLabel (pure)', () => {
  it('renders "Waiting on N models" with N = running count and a per-model strip', () => {
    const label = panelLabel(
      [{ provider: 'claude', state: 'done' }, { provider: 'codex', state: 'running' }],
      null,
      false,
    );
    assert.ok(label.startsWith('Waiting on 1 model'), `got: ${label}`);
    assert.ok(label.includes('claude ✓'), 'done candidate shows ✓');
    assert.ok(label.includes('codex …'), 'running candidate shows …');
  });

  it('pluralises models and uses the strip in order', () => {
    const label = panelLabel(
      [{ provider: 'claude', state: 'running' }, { provider: 'codex', state: 'running' }],
      null,
      false,
    );
    assert.ok(label.startsWith('Waiting on 2 models'), `got: ${label}`);
    assert.ok(label.indexOf('claude') < label.indexOf('codex'), 'strip is in announce order');
  });

  it('switches to "Synthesizing N answers…" when synthesizing', () => {
    assert.equal(
      panelLabel([{ provider: 'claude', state: 'done' }], { count: 2 }, false),
      'Synthesizing 2 answers…',
    );
    assert.equal(
      panelLabel([], { count: 1 }, false),
      'Synthesizing 1 answer…',
    );
  });

  it('emits zero ANSI bytes when color is false', () => {
    const label = panelLabel(
      [{ provider: 'claude', state: 'done' }, { provider: 'codex', state: 'running' }],
      null,
      false,
    );
    assert.ok(!/\x1b\[/.test(label), 'no ANSI escapes off-color');
  });
});

/** A colour TTY sink that records every painted spinner frame (so panel-label
 *  transitions are observable without waiting on animation ticks). */
function makePanelSink(): OutputSink & { buf: string[] } {
  const buf: string[] = [];
  return { buf, write: (s: string) => { buf.push(s); }, color: false, isTty: true };
}

/** The scripted REAL panel event sequence runPanel emits: composition notice +
 *  phase:panel + 2 up-front candidate tier-starts + 2 candidate tier-dones (one
 *  first) + phase:synthesis + synthesizer tier-start/stream/tier-done + final. */
function panelEvents(): CoreEvent[] {
  return [
    { type: 'notice', level: 'info', message: 'Panel: claude, codex → synthesized by claude' },
    { type: 'phase', phase: 'panel', participants: ['claude', 'codex'] },
    { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
    { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt-5-codex', attempt: 2 },
    { type: 'tier-done', tier: 'ic', success: true, confidence: 0.8, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 100 },
    { type: 'tier-done', tier: 'ic', success: true, confidence: 0.7, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 200 },
    { type: 'phase', phase: 'synthesis', count: 2 },
    { type: 'tier-start', tier: 'manager', provider: 'claude', model: 'claude-opus-4-8', attempt: 3 },
    { type: 'provider-event', tier: 'manager', event: { type: 'text', delta: 'Synthesized answer.' } },
    { type: 'tier-done', tier: 'manager', success: true, confidence: 0.9, costUsd: 0, inputTokens: 50, outputTokens: 20, durationMs: 300 },
    { type: 'final', success: true, output: 'Synthesized answer.', tier: 'manager', totalCostUsd: 0, sessionId: 's', attempts: 3 },
  ];
}

describe('renderStream — panel "Waiting on N models" state machine', () => {
  it('transitions Waiting on 2 → Waiting on 1 → Synthesizing as real tier-dones arrive', async () => {
    const sink = makePanelSink();
    await renderStream(makeStream(panelEvents()), sink, 'normal');
    const joined = sink.buf.join('');

    assert.ok(joined.includes('Waiting on 2 models'), 'shows N=2 while both run');
    assert.ok(joined.includes('Waiting on 1 model'), 'ticks down to N=1 after first tier-done');
    assert.ok(joined.includes('Synthesizing 2 answers'), 'switches to synthesizing on phase:synthesis');
    // The compact strip flips claude → ✓ after its tier-done.
    assert.ok(joined.includes('claude ✓'), 'first candidate flips to ✓');
    // The composition header is shown dim in NORMAL mode (not just verbose).
    assert.ok(joined.includes('Panel: claude, codex'), 'composition header surfaces in normal mode');
    // Synthesizer prose still streams under the turn marker.
    assert.ok(joined.includes('Synthesized answer.'), 'synthesizer answer is shown');
  });

  it('a single-model / hedge turn never shows the panel race', async () => {
    const sink = makePanelSink();
    const events: CoreEvent[] = [
      // Hedge surfaces a human notice but NO phase event.
      { type: 'notice', level: 'info', message: 'hedge: primary slow — starting speculative flagship' },
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'claude-sonnet-4-6', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'One answer.' } },
      { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 10, outputTokens: 5, durationMs: 100 },
      { type: 'final', success: true, output: 'One answer.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(!joined.includes('Waiting on'), 'no "Waiting on N" for a single-model turn');
    assert.ok(!joined.includes('Synthesizing'), 'no synthesizing line for a single-model turn');
    // The hedge speculative notice IS surfaced dim in normal mode per the spec.
    assert.ok(joined.includes('primary slow'), 'hedge speculative notice is surfaced');
  });

  it('the phase event is ignored safely by ordinary non-panel rendering', async () => {
    // A lone phase event in an otherwise single-model stream must not crash, must
    // not print a panel line on its own (no participants reach a tier-start path),
    // and must leave the normal completion line intact.
    const sink = makeSink();
    const events: CoreEvent[] = [
      { type: 'phase', phase: 'panel', participants: [] },
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Plain.' } },
      { type: 'final', success: true, output: 'Plain.', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    const res = await renderStream(makeStream(events), sink, 'normal');
    assert.equal(res.success, true);
    assert.ok(sink.buf.join('').includes('Plain.'), 'prose still rendered');
  });

  it('panel output stays ANSI-free on a piped (no-color, non-TTY) sink', async () => {
    const sink = makeSink(); // color:false, isTty:false
    await renderStream(makeStream(panelEvents()), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(!/\x1b\[/.test(joined), 'no ANSI escapes in piped panel output');
    assert.ok(joined.includes('Synthesized answer.'), 'answer still shown in pipe');
  });
});

describe('styleInlineMarkdown (pure)', () => {
  it('styles bold, inline code, headings and bullets in colour mode', () => {
    assert.ok(styleInlineMarkdown('a **bold** word', true).includes('\x1b[1mbold\x1b[0m'));
    assert.ok(styleInlineMarkdown('an __also__ word', true).includes('\x1b[1malso\x1b[0m'));
    assert.ok(styleInlineMarkdown('use `code` here', true).includes('\x1b[7mcode\x1b[0m'));
    // ATX heading at a line start → bold (markers kept).
    assert.ok(styleInlineMarkdown('## Title', true).includes('\x1b[1m'));
    // Bullet marker normalised to •.
    assert.ok(styleInlineMarkdown('- item', true).startsWith('•'));
  });

  it('is the identity when color is false (raw markdown preserved for pipes)', () => {
    const md = '# Heading\n- item with **bold** and `code`';
    assert.equal(styleInlineMarkdown(md, false), md);
  });

  it('leaves an UNMATCHED marker verbatim so a split-across-deltas token never corrupts output', () => {
    // A lone opening `**` (closer not yet arrived) must pass through untouched.
    assert.equal(styleInlineMarkdown('the **bo', true), 'the **bo');
    // A lone backtick likewise.
    assert.equal(styleInlineMarkdown('a `partial', true), 'a `partial');
    // Mid-line `#`/`-` are not treated as structure.
    assert.equal(styleInlineMarkdown('C# and 5 - 3', true, false), 'C# and 5 - 3');
  });
});

describe('renderStream — inline markdown over a split-across-deltas stream', () => {
  it('renders bold split across two text deltas without corruption, on a colour TTY', async () => {
    const sink = makeColorTtySink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      // The bold span is split: "**bo" then "ld** done" — completed by a newline.
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'pre **bo' } },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'ld** done\n' } },
      { type: 'final', success: true, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    // The completed bold span is styled exactly once and the literal "**bold**"
    // markers around the styled word do not leak as a stray, unbalanced pair.
    assert.ok(joined.includes('\x1b[1mbold\x1b[0m'), 'bold span styled once the pair completes');
    assert.ok(joined.includes('pre '), 'leading prose preserved');
    assert.ok(joined.includes('done'), 'trailing prose preserved');
  });

  it('does NOT style markdown on a piped (no-color) sink — raw chars preserved', async () => {
    const sink = makeSink();
    const events: CoreEvent[] = [
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'a **bold** word\n' } },
      { type: 'final', success: true, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
    ];
    await renderStream(makeStream(events), sink, 'normal');
    const joined = sink.buf.join('');
    assert.ok(joined.includes('**bold**'), 'raw markdown preserved in pipe');
    assert.ok(!/\x1b\[/.test(joined), 'no ANSI escapes in pipe');
  });
});
