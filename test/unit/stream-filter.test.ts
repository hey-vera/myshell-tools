/**
 * Characterization tests for the PURE stream/envelope-filtering logic lifted
 * out of render.ts into src/interface/stream-filter.ts (UI-migration STEP 0).
 *
 * These lock in the CURRENT behaviour of:
 *   - EnvelopeFilter — the stateful streaming writer that holds back any trailing
 *     fragment that could be a control envelope / goal marker, and strips a
 *     genuine trailing envelope at the terminal flush. Exercised across chunk
 *     splits, terminal flush, tier-boundary flush (finishAttempt), clean prose,
 *     benign braces, and fenced envelopes.
 *   - cleanAssistantText — the pure one-shot stripper used by /copy, /export and
 *     the resume transcript.
 *
 * Pure module: the only outward effect is via the injected OutputSink, so a
 * capturing sink makes every case hermetic.
 *
 * Run with: node --experimental-strip-types --test test/unit/stream-filter.test.ts
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { EnvelopeFilter, cleanAssistantText } from '../../src/interface/stream-filter.ts';
import type { OutputSink } from '../../src/interface/stream-filter.ts';

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

/** Feed deltas through a fresh filter, terminal-flush, return the emitted text. */
function streamThrough(deltas: readonly string[]): string {
  const sink = makeSink();
  const f = new EnvelopeFilter(sink);
  for (const d of deltas) f.push(d);
  f.flush();
  return sink.buf.join('');
}

const CONFIDENCE = '{"confidence":0.91}';

describe('EnvelopeFilter — control-envelope stripping', () => {
  it('strips a trailing confidence envelope appended after prose', () => {
    // The envelope itself is removed; the newline that separated prose from the
    // envelope was already flushed as safe prose, so it remains (current behaviour).
    const out = streamThrough([`Here is the real answer.\n${CONFIDENCE}`]);
    assert.equal(out, 'Here is the real answer.\n');
    assert.equal(out.includes('confidence'), false);
  });

  it('strips a confidence envelope split across multiple chunks', () => {
    // The envelope arrives a few characters at a time across the final deltas —
    // it must never leak partially while arriving, and is fully removed at flush.
    const out = streamThrough([
      'The answer is 42.',
      '\n{"confi',
      'dence":0',
      '.5}',
    ]);
    assert.equal(out, 'The answer is 42.\n');
    assert.equal(out.includes('confi'), false);
  });

  it('never leaks the envelope mid-stream (only safe prose flushes early)', () => {
    const sink = makeSink();
    const f = new EnvelopeFilter(sink);
    f.push('Hello world.');
    // Prose with no open trailing brace flushes immediately.
    assert.equal(sink.buf.join(''), 'Hello world.');
    f.push('\n{"confidence":');
    // The open-brace fragment that could be a control envelope is held back; the
    // preceding newline flushes as safe prose.
    assert.equal(sink.buf.join(''), 'Hello world.\n');
    f.push('0.8}');
    f.flush();
    assert.equal(sink.buf.join(''), 'Hello world.\n');
    assert.equal(sink.buf.join('').includes('confidence'), false);
  });

  it('strips an ask_user control block at end of stream', () => {
    const out = streamThrough([
      'I need a decision.\n',
      '{"ask_user":{"question":"Which one?"}}',
    ]);
    assert.equal(out, 'I need a decision.\n');
    assert.equal(out.includes('ask_user'), false);
  });

  it('strips a fenced ```json envelope (the envelope JSON never leaks)', () => {
    const out = streamThrough([
      'Done.\n```json\n',
      `${CONFIDENCE}\n`,
      '```',
    ]);
    assert.equal(out.includes('confidence'), false);
    assert.equal(out.startsWith('Done.'), true);
  });
});

describe('EnvelopeFilter — benign content passes through untouched', () => {
  it('streams clean prose verbatim', () => {
    const out = streamThrough(['This is a plain sentence with no JSON at all.']);
    assert.equal(out, 'This is a plain sentence with no JSON at all.');
  });

  it('does not hold back an inline balanced brace followed by prose', () => {
    // A balanced {…} with real text after it is inline content, not an envelope.
    const out = streamThrough(['the set {1, 2, 3} is finite, so we conclude X.']);
    assert.equal(out, 'the set {1, 2, 3} is finite, so we conclude X.');
  });

  it('releases a partial-marker brace that turns out benign', () => {
    // `{` followed by code (not a control key) is ordinary content and must be
    // shown, even when it ends the stream still "open".
    const out = streamThrough(['function f() {\n  return 1;\n']);
    assert.equal(out, 'function f() {\n  return 1;\n');
  });

  it('shows a genuine trailing open brace that is not a control key', () => {
    const out = streamThrough(['the set {1, 2']);
    assert.equal(out, 'the set {1, 2');
  });

  it('keeps a confidence-key brace that is NOT at the trailing position', () => {
    // An object mid-prose with more text after it is inline content, not the
    // trailing control envelope, so it is preserved.
    const out = streamThrough(['I scored {"confidence":0.9} earlier, then continued.']);
    assert.equal(out, 'I scored {"confidence":0.9} earlier, then continued.');
  });
});

describe('EnvelopeFilter — goal-control markers', () => {
  it('strips a trailing GOAL_COMPLETE marker line', () => {
    const out = streamThrough(['All set.\nGOAL_COMPLETE']);
    assert.equal(out, 'All set.');
  });

  it('holds back a partial GOAL_ prefix then strips on completion', () => {
    const sink = makeSink();
    const f = new EnvelopeFilter(sink);
    f.push('All set.\nGOAL_CON');
    // The whole trailing marker region — including its leading newline — is held
    // back so a half-typed marker never leaks.
    assert.equal(sink.buf.join(''), 'All set.');
    f.push('TINUE');
    f.flush();
    assert.equal(sink.buf.join(''), 'All set.');
  });
});

describe('EnvelopeFilter — flush semantics', () => {
  it('flush() is idempotent', () => {
    const sink = makeSink();
    const f = new EnvelopeFilter(sink);
    f.push(`Answer.\n${CONFIDENCE}`);
    f.flush();
    const after = sink.buf.join('');
    f.flush();
    assert.equal(sink.buf.join(''), after);
    assert.equal(after, 'Answer.\n');
    assert.equal(after.includes('confidence'), false);
  });

  it('finishAttempt() strips an open control fragment from the completed attempt', () => {
    // At a tier boundary a still-open `{"confidence` fragment belongs to the
    // finished attempt and is stripped rather than raw-dumped.
    const sink = makeSink();
    const f = new EnvelopeFilter(sink);
    f.push('Tier answer.\n{"confidence":0.4');
    f.finishAttempt();
    assert.equal(sink.buf.join(''), 'Tier answer.\n');
    assert.equal(sink.buf.join('').includes('confidence'), false);
  });

  it('emits nothing for an empty stream', () => {
    assert.equal(streamThrough([]), '');
    assert.equal(streamThrough(['']), '');
  });
});

describe('cleanAssistantText — pure one-shot stripper', () => {
  it('strips a trailing confidence envelope', () => {
    assert.equal(
      cleanAssistantText(`Here is the real answer.\n${CONFIDENCE}`).trim(),
      'Here is the real answer.',
    );
  });

  it('strips a trailing goal marker', () => {
    assert.equal(cleanAssistantText('Done here.\nGOAL_COMPLETE').trim(), 'Done here.');
  });

  it('passes plain prose through untouched', () => {
    assert.equal(cleanAssistantText('plain prose'), 'plain prose');
  });

  it('is fail-soft on empty / nullish input', () => {
    assert.equal(cleanAssistantText(''), '');
    // @ts-expect-error — exercising the `?? ''` fail-soft guard at runtime.
    assert.equal(cleanAssistantText(undefined), '');
  });
});
