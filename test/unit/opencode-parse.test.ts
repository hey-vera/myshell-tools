/**
 * test/unit/opencode-parse.test.ts
 *
 * Hermetic unit tests for createOpencodeParser() in src/providers/opencode-parse.ts.
 *
 * All test inputs are captured fixture JSONL lines (real shapes from opencode v1.15.12).
 * No real opencode process is spawned — every input is a string literal.
 *
 * Coverage:
 *  - step_start → []
 *  - text events → {type:'text', delta} + accumulation
 *  - tool_use events → {type:'tool', name, phase:'end', detail?}
 *  - step_finish → {type:'usage', usage} + accumulation of tokens/cost
 *  - error events → {type:'error', error}
 *  - finalize() → {type:'done', text, usage, costUsd?}
 *  - multi-step accumulation (tokens and cost summed across multiple step_finish lines)
 *  - malformed JSON → [] (never throws)
 *  - empty line → []
 *  - unknown event type → []
 *  - terminalEmitted guard: finalize() returns [] after an error event
 *
 * Honesty Contract: no Math.random, no fabricated AI responses, no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeParser } from '../../src/providers/opencode-parse.ts';
import type { ProviderEvent } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Captured fixture JSONL lines (real shapes from opencode run --format json)
// ---------------------------------------------------------------------------

// Real sample: step_start event
const STEP_START_LINE = JSON.stringify({
  type: 'step_start',
  sessionID: 'ses_abc123',
  part: { type: 'step-start' },
});

// Real sample: text event (part.type = 'text')
const TEXT_LINE_HI = JSON.stringify({
  type: 'text',
  sessionID: 'ses_abc123',
  part: { type: 'text', text: 'Hi', time: { start: 1000, end: 1100 } },
});

const TEXT_LINE_THERE = JSON.stringify({
  type: 'text',
  sessionID: 'ses_abc123',
  part: { type: 'text', text: ' there', time: { start: 1100, end: 1200 } },
});

// Real sample: tool_use event with state.title
const TOOL_LINE_WITH_TITLE = JSON.stringify({
  type: 'tool_use',
  sessionID: 'ses_abc123',
  part: {
    type: 'tool',
    tool: 'glob',
    callID: 'call_xyz',
    state: {
      status: 'completed',
      input: { pattern: '**/*.ts' },
      output: 'src/providers/opencode.ts\nsrc/cli.ts',
      title: '**/*.ts',
    },
  },
});

// tool_use event without state.title
const TOOL_LINE_NO_TITLE = JSON.stringify({
  type: 'tool_use',
  sessionID: 'ses_abc123',
  part: {
    type: 'tool',
    tool: 'bash',
    callID: 'call_abc',
    state: {
      status: 'completed',
      input: { command: 'ls' },
      output: 'file.ts',
    },
  },
});

// Real sample: step_finish event with tokens and cost
const STEP_FINISH_LINE = JSON.stringify({
  type: 'step_finish',
  sessionID: 'ses_abc123',
  part: {
    type: 'step-finish',
    reason: 'stop',
    tokens: {
      total: 350,
      input: 300,
      output: 50,
      reasoning: 0,
      cache: { write: 0, read: 100 },
    },
    cost: 0.00025,
  },
});

// Second step_finish for multi-step accumulation
const STEP_FINISH_LINE_2 = JSON.stringify({
  type: 'step_finish',
  sessionID: 'ses_abc123',
  part: {
    type: 'step-finish',
    reason: 'tool-calls',
    tokens: {
      total: 200,
      input: 150,
      output: 50,
      reasoning: 0,
      cache: { write: 0, read: 50 },
    },
    cost: 0.00015,
  },
});

// Real sample: error event (e.g. model not found)
const ERROR_LINE = JSON.stringify({
  type: 'error',
  sessionID: 'ses_abc123',
  error: {
    name: 'UnknownError',
    data: {
      message: 'Model not found: opencode/no-such-model',
      ref: 'https://opencode.ai/docs',
    },
  },
});

// Malformed lines
const MALFORMED_JSON_LINE = '{"type":"text", broken json}}}';
const EMPTY_LINE = '';
const BLANK_LINE = '   ';

// Unknown event type
const UNKNOWN_EVENT_LINE = JSON.stringify({
  type: 'some_future_event',
  sessionID: 'ses_abc123',
  data: { foo: 'bar' },
});

// text event with empty text (no delta emitted)
const TEXT_LINE_EMPTY = JSON.stringify({
  type: 'text',
  sessionID: 'ses_abc123',
  part: { type: 'text', text: '' },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventsOfType(events: ProviderEvent[], type: string): ProviderEvent[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// step_start events
// ---------------------------------------------------------------------------

describe('createOpencodeParser — step_start → []', () => {
  it('does not throw', () => {
    const p = createOpencodeParser();
    assert.doesNotThrow(() => p.parseLine(STEP_START_LINE));
  });

  it('returns [] for step_start', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(STEP_START_LINE);
    assert.deepEqual(events, []);
  });
});

// ---------------------------------------------------------------------------
// text events
// ---------------------------------------------------------------------------

describe('createOpencodeParser — text event → {type:"text", delta}', () => {
  it('does not throw', () => {
    const p = createOpencodeParser();
    assert.doesNotThrow(() => p.parseLine(TEXT_LINE_HI));
  });

  it('returns a text event with the correct delta', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(TEXT_LINE_HI);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'text');
    if (ev.type === 'text') {
      assert.equal(ev.delta, 'Hi');
    }
  });

  it('empty text part → no event emitted', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(TEXT_LINE_EMPTY);
    assert.deepEqual(events, []);
  });
});

// ---------------------------------------------------------------------------
// tool_use events
// ---------------------------------------------------------------------------

describe('createOpencodeParser — tool_use → {type:"tool", phase:"end"}', () => {
  it('returns a tool event with name and detail when title is present', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(TOOL_LINE_WITH_TITLE);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'tool');
    if (ev.type === 'tool') {
      assert.equal(ev.name, 'glob');
      assert.equal(ev.phase, 'end');
      assert.equal(ev.detail, '**/*.ts');
    }
  });

  it('returns a tool event without detail when title is absent', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(TOOL_LINE_NO_TITLE);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'tool');
    if (ev.type === 'tool') {
      assert.equal(ev.name, 'bash');
      assert.equal(ev.phase, 'end');
      assert.equal('detail' in ev, false, 'detail must be absent when no title');
    }
  });
});

// ---------------------------------------------------------------------------
// step_finish events
// ---------------------------------------------------------------------------

describe('createOpencodeParser — step_finish → {type:"usage", usage}', () => {
  it('returns a usage event with correct token counts', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(STEP_FINISH_LINE);
    const usageEvents = eventsOfType(events, 'usage');
    assert.equal(usageEvents.length, 1);
    const ev = usageEvents[0];
    assert.ok(ev !== undefined && ev.type === 'usage');
    if (ev.type === 'usage') {
      assert.equal(ev.usage.inputTokens, 300);
      assert.equal(ev.usage.outputTokens, 50);
      assert.equal(ev.usage.cachedInputTokens, 100);
    }
  });

  it('step_finish with no cache.read → no cachedInputTokens field', () => {
    const line = JSON.stringify({
      type: 'step_finish',
      part: {
        type: 'step-finish',
        reason: 'stop',
        tokens: { total: 100, input: 80, output: 20 },
        cost: 0,
      },
    });
    const p = createOpencodeParser();
    const events = p.parseLine(line);
    const usageEvents = eventsOfType(events, 'usage');
    assert.equal(usageEvents.length, 1);
    const ev = usageEvents[0];
    assert.ok(ev !== undefined && ev.type === 'usage');
    if (ev.type === 'usage') {
      assert.equal('cachedInputTokens' in ev.usage, false);
    }
  });
});

// ---------------------------------------------------------------------------
// error events
// ---------------------------------------------------------------------------

describe('createOpencodeParser — error → {type:"error"}', () => {
  it('does not throw', () => {
    const p = createOpencodeParser();
    assert.doesNotThrow(() => p.parseLine(ERROR_LINE));
  });

  it('returns an error event', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(ERROR_LINE);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'error');
  });

  it('error event has a category', () => {
    const p = createOpencodeParser();
    const events = p.parseLine(ERROR_LINE);
    const ev = events[0];
    assert.ok(ev !== undefined && ev.type === 'error');
    if (ev.type === 'error') {
      assert.ok(typeof ev.error.category === 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed / empty / unknown lines
// ---------------------------------------------------------------------------

describe('createOpencodeParser — resilience: malformed JSON → []', () => {
  it('does not throw on malformed JSON', () => {
    const p = createOpencodeParser();
    assert.doesNotThrow(() => p.parseLine(MALFORMED_JSON_LINE));
  });

  it('returns [] on malformed JSON', () => {
    const p = createOpencodeParser();
    assert.deepEqual(p.parseLine(MALFORMED_JSON_LINE), []);
  });

  it('does not throw on empty line', () => {
    const p = createOpencodeParser();
    assert.doesNotThrow(() => p.parseLine(EMPTY_LINE));
  });

  it('returns [] on empty line', () => {
    const p = createOpencodeParser();
    assert.deepEqual(p.parseLine(EMPTY_LINE), []);
  });

  it('does not throw on blank (whitespace-only) line', () => {
    const p = createOpencodeParser();
    assert.doesNotThrow(() => p.parseLine(BLANK_LINE));
  });

  it('returns [] on blank line', () => {
    const p = createOpencodeParser();
    assert.deepEqual(p.parseLine(BLANK_LINE), []);
  });

  it('returns [] for unknown event type', () => {
    const p = createOpencodeParser();
    assert.deepEqual(p.parseLine(UNKNOWN_EVENT_LINE), []);
  });
});

// ---------------------------------------------------------------------------
// finalize() — basic
// ---------------------------------------------------------------------------

describe('createOpencodeParser — finalize() produces done event', () => {
  it('finalize() returns an error when no text, usage, or cost was accumulated', () => {
    const p = createOpencodeParser();
    const finalEvents = p.finalize();
    assert.equal(finalEvents.length, 1);
    const ev = finalEvents[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'error');
    if (ev.type === 'error') {
      assert.equal(ev.error.category, 'unknown');
      assert.equal(ev.error.message, 'opencode produced no output');
    }
  });

  it('finalize() returns a done event after text accumulation', () => {
    const p = createOpencodeParser();
    p.parseLine(TEXT_LINE_HI);
    p.parseLine(TEXT_LINE_THERE);
    p.parseLine(STEP_FINISH_LINE);
    const finalEvents = p.finalize();
    assert.equal(finalEvents.length, 1);
    const ev = finalEvents[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'done');
  });

  it('finalize() done.text contains all accumulated text', () => {
    const p = createOpencodeParser();
    p.parseLine(TEXT_LINE_HI);
    p.parseLine(TEXT_LINE_THERE);
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.equal(ev.text, 'Hi there');
    }
  });

  it('finalize() done.text is empty string when no text events were parsed', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE);
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.equal(ev.text, '');
    }
  });

  it('finalize() done.usage reflects accumulated tokens', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE); // input:300, output:50, cacheRead:100
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.ok(ev.usage !== undefined);
      assert.equal(ev.usage.inputTokens, 300);
      assert.equal(ev.usage.outputTokens, 50);
      assert.equal(ev.usage.cachedInputTokens, 100);
    }
  });

  it('finalize() done.costUsd is present and correct when cost > 0', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE); // cost: 0.00025
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.ok(ev.costUsd !== undefined);
      assert.ok(Math.abs((ev.costUsd ?? 0) - 0.00025) < 1e-10);
    }
  });

  it('finalize() done.costUsd is absent when no step_finish lines were parsed', () => {
    const p = createOpencodeParser();
    p.parseLine(TEXT_LINE_HI);
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.equal('costUsd' in ev, false, 'costUsd must be absent when no cost accumulated');
    }
  });

  it('finalize() returns [] after an error event with NO prior text (terminal already emitted)', () => {
    const p = createOpencodeParser();
    p.parseLine(ERROR_LINE); // no prior text → terminalEmitted = true
    const finalEvents = p.finalize();
    assert.deepEqual(finalEvents, []);
  });

  it('finalize() returns done after an error event with prior substantive text (non-terminal diagnostic)', () => {
    const p = createOpencodeParser();
    p.parseLine(TEXT_LINE_HI);
    p.parseLine(ERROR_LINE); // text accumulated → NOT terminal
    const finalEvents = p.finalize();
    assert.equal(finalEvents.length, 1);
    const ev = finalEvents[0];
    assert.ok(ev !== undefined);
    assert.equal(ev.type, 'done');
  });

  it('hasSubstantiveText() returns false when no text accumulated', () => {
    const p = createOpencodeParser();
    assert.equal(p.hasSubstantiveText(), false);
  });

  it('hasSubstantiveText() returns true after text accumulated', () => {
    const p = createOpencodeParser();
    p.parseLine(TEXT_LINE_HI);
    assert.equal(p.hasSubstantiveText(), true);
  });

  it('hasSubstantiveText() returns false with only whitespace text', () => {
    const p = createOpencodeParser();
    p.parseLine(JSON.stringify({ type: 'text', part: { type: 'text', text: '   ' } }));
    assert.equal(p.hasSubstantiveText(), false);
  });

  it('calling finalize() twice returns [] on the second call', () => {
    const p = createOpencodeParser();
    p.parseLine(TEXT_LINE_HI);
    const first = p.finalize();
    assert.equal(first.length, 1);
    const second = p.finalize();
    assert.deepEqual(second, []);
  });
});

// ---------------------------------------------------------------------------
// Multi-step accumulation
// ---------------------------------------------------------------------------

describe('createOpencodeParser — multi-step: tokens and cost summed across step_finish events', () => {
  it('accumulates input tokens across two step_finish events', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE);  // input:300
    p.parseLine(STEP_FINISH_LINE_2); // input:150
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.ok(ev.usage !== undefined);
      assert.equal(ev.usage.inputTokens, 450); // 300 + 150
    }
  });

  it('accumulates output tokens across two step_finish events', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE);  // output:50
    p.parseLine(STEP_FINISH_LINE_2); // output:50
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.ok(ev.usage !== undefined);
      assert.equal(ev.usage.outputTokens, 100); // 50 + 50
    }
  });

  it('accumulates cachedInputTokens across two step_finish events', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE);  // cache.read:100
    p.parseLine(STEP_FINISH_LINE_2); // cache.read:50
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.ok(ev.usage !== undefined);
      assert.equal(ev.usage.cachedInputTokens, 150); // 100 + 50
    }
  });

  it('accumulates cost across two step_finish events', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_FINISH_LINE);   // cost:0.00025
    p.parseLine(STEP_FINISH_LINE_2); // cost:0.00015
    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.ok(ev.costUsd !== undefined);
      assert.ok(Math.abs((ev.costUsd ?? 0) - 0.0004) < 1e-10, // 0.00025 + 0.00015
        `expected costUsd ≈ 0.0004, got ${ev.costUsd}`);
    }
  });

  it('full multi-step flow: text + tool + two step_finish → correct done', () => {
    const p = createOpencodeParser();
    p.parseLine(STEP_START_LINE);
    p.parseLine(TEXT_LINE_HI);
    p.parseLine(TOOL_LINE_WITH_TITLE);
    p.parseLine(STEP_FINISH_LINE);
    p.parseLine(TEXT_LINE_THERE);
    p.parseLine(STEP_FINISH_LINE_2);

    const finalEvents = p.finalize();
    const ev = finalEvents[0];
    assert.ok(ev !== undefined && ev.type === 'done');
    if (ev.type === 'done') {
      assert.equal(ev.text, 'Hi there');
      assert.ok(ev.usage !== undefined);
      assert.equal(ev.usage.inputTokens, 450);
      assert.equal(ev.usage.outputTokens, 100);
      assert.ok(ev.costUsd !== undefined);
      assert.ok(Math.abs((ev.costUsd ?? 0) - 0.0004) < 1e-10);
    }
  });
});

// ---------------------------------------------------------------------------
// Parser independence
// ---------------------------------------------------------------------------

describe('createOpencodeParser — each parser instance is independent', () => {
  it('two parsers do not share accumulation state', () => {
    const p1 = createOpencodeParser();
    const p2 = createOpencodeParser();

    p1.parseLine(TEXT_LINE_HI);
    p1.parseLine(TEXT_LINE_THERE);

    // p2 has no real output and now reports an honest parser error, not a blank
    // done event.
    const finalP2 = p2.finalize();
    const evP2 = finalP2[0];
    assert.ok(evP2 !== undefined && evP2.type === 'error');
    if (evP2.type === 'error') {
      assert.equal(evP2.error.message, 'opencode produced no output');
    }

    const finalP1 = p1.finalize();
    const evP1 = finalP1[0];
    assert.ok(evP1 !== undefined && evP1.type === 'done');
    if (evP1.type === 'done') {
      assert.equal(evP1.text, 'Hi there', 'p1 must accumulate its own text');
    }
  });
});
