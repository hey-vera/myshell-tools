/**
 * Unit tests for the resume-transcript renderer + the functional guarantee that
 * a resumed conversation's prior turns reach the built model prompt.
 *
 * The renderer (`renderResumeTranscript`) is the pure, hermetic seam the menu
 * calls on resume so reopening a saved conversation reads like a real chat
 * ("here's where we were") instead of a blank prompt. The functional test
 * asserts the chain priorHistory → compactHistory → buildPrompt's CONVERSATION
 * SO FAR block, i.e. the model genuinely continues the conversation.
 *
 * Run with: node --experimental-strip-types --test test/unit/resume-transcript.test.ts
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderResumeTranscript } from '../../src/interface/render.ts';
import type { ResumeMessage } from '../../src/interface/render.ts';
import { compactHistory } from '../../src/core/history.ts';
import { buildPrompt } from '../../src/core/prompt.ts';
import type { SessionEntry } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(
  role: ResumeMessage['role'],
  content: string,
  timestamp?: string,
): ResumeMessage {
  return timestamp === undefined ? { role, content } : { role, content, timestamp };
}

function entry(
  role: SessionEntry['role'],
  content: string,
  timestamp = '2024-01-01T00:00:00.000Z',
): SessionEntry {
  return { timestamp, role, content };
}

// Strip ANSI so colour assertions test structure, not escape codes.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");
function strip(s: string): string {
  return s.replace(ANSI, '');
}

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe('renderResumeTranscript — empty / degenerate', () => {
  it('returns "" for an empty array', () => {
    assert.equal(renderResumeTranscript([]), '');
  });

  it('returns "" when every entry is a system control turn', () => {
    assert.equal(
      renderResumeTranscript([msg('system', 'internal'), msg('system', 'control')]),
      '',
    );
  });

  it('returns "" when every conversational entry is blank', () => {
    assert.equal(renderResumeTranscript([msg('user', '   '), msg('assistant', '')]), '');
  });

  it('handles a one-message conversation', () => {
    const out = strip(renderResumeTranscript([msg('user', 'hello there')]));
    assert.match(out, /› hello there/);
    assert.doesNotMatch(out, /earlier/);
  });
});

// ---------------------------------------------------------------------------
// Glyphs + roles
// ---------------------------------------------------------------------------

describe('renderResumeTranscript — glyphs', () => {
  it('uses › for the user and ● for the assistant', () => {
    const out = strip(
      renderResumeTranscript([
        msg('user', 'what is 2+2?'),
        msg('assistant', 'It is 4.'),
      ]),
    );
    assert.match(out, /› what is 2\+2\?/);
    assert.match(out, /● It is 4\./);
  });

  it('skips system turns but keeps surrounding user/assistant turns in order', () => {
    const out = strip(
      renderResumeTranscript([
        msg('user', 'first'),
        msg('system', 'noise'),
        msg('assistant', 'second'),
      ]),
    );
    assert.doesNotMatch(out, /noise/);
    assert.ok(out.indexOf('first') < out.indexOf('second'));
  });

  it('strips a trailing confidence envelope from assistant prose', () => {
    const out = strip(
      renderResumeTranscript([
        msg('assistant', 'The answer is 42.\n{"confidence":0.9,"reasoning":"x"}'),
      ]),
    );
    assert.match(out, /● The answer is 42\./);
    assert.doesNotMatch(out, /confidence/);
  });
});

// ---------------------------------------------------------------------------
// Bounding long conversations
// ---------------------------------------------------------------------------

describe('renderResumeTranscript — bounding', () => {
  it('shows a useful recent transcript by default instead of only a tiny recap', () => {
    const entries: ResumeMessage[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push(msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    }
    const out = strip(renderResumeTranscript(entries));
    assert.match(out, /m0/);
    assert.match(out, /m11/);
    assert.doesNotMatch(out, /earlier/);
  });
  it('shows only the last maxMessages and notes the dropped count', () => {
    const entries: ResumeMessage[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    }
    const out = strip(renderResumeTranscript(entries, { maxMessages: 4 }));
    // 10 messages, show last 4 → 6 dropped.
    assert.match(out, /…6 earlier messages · \/export for full transcript/);
    assert.match(out, /m9/);
    assert.match(out, /m6/);
    assert.doesNotMatch(out, /\bm5\b/);
  });

  it('singularises the dropped note for exactly one earlier message', () => {
    const entries: ResumeMessage[] = [
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
    ];
    const out = strip(renderResumeTranscript(entries, { maxMessages: 2 }));
    assert.match(out, /…1 earlier message · \/export for full transcript/);
  });

  it('does not show a dropped note when nothing was dropped', () => {
    const out = strip(
      renderResumeTranscript([msg('user', 'a'), msg('assistant', 'b')], { maxMessages: 6 }),
    );
    assert.doesNotMatch(out, /earlier/);
  });

  it('truncates an over-long single message with an ellipsis', () => {
    const long = 'word '.repeat(200).trim();
    const out = strip(
      renderResumeTranscript([msg('user', long)], { maxCharsPerMessage: 40 }),
    );
    const body = out.split('\n').find((l) => l.includes('›')) ?? '';
    assert.ok(body.length < long.length, 'body should be truncated');
    assert.match(out, /…/);
  });
});

// ---------------------------------------------------------------------------
// Timestamps (injected clock — never fabricated)
// ---------------------------------------------------------------------------

describe('renderResumeTranscript — timestamps', () => {
  const NOW = Date.parse('2024-01-01T12:00:00.000Z');

  it('omits timestamps entirely when no clock is injected', () => {
    const out = strip(
      renderResumeTranscript([msg('user', 'hi', '2024-01-01T10:00:00.000Z')]),
    );
    assert.doesNotMatch(out, /ago/);
  });

  it('renders a dim relative time when nowMs is provided', () => {
    const out = strip(
      renderResumeTranscript([msg('user', 'hi', '2024-01-01T10:00:00.000Z')], {
        nowMs: NOW,
      }),
    );
    assert.match(out, /2h ago/);
  });

  it('shows "just now" for a very recent turn', () => {
    const out = strip(
      renderResumeTranscript([msg('user', 'hi', '2024-01-01T11:59:30.000Z')], {
        nowMs: NOW,
      }),
    );
    assert.match(out, /just now/);
  });

  it('tolerates an unparseable timestamp by omitting it', () => {
    const out = strip(
      renderResumeTranscript([msg('user', 'hi', 'not-a-date')], { nowMs: NOW }),
    );
    assert.match(out, /› hi/);
    assert.doesNotMatch(out, /ago/);
  });
});

// ---------------------------------------------------------------------------
// NO_COLOR / non-TTY degradation
// ---------------------------------------------------------------------------

describe('renderResumeTranscript — degradation', () => {
  it('emits no ANSI escape codes when color is false', () => {
    const out = renderResumeTranscript(
      [msg('user', 'a'), msg('assistant', 'b')],
      { color: false },
    );
    assert.ok(!out.includes(ESC), 'no ANSI escape bytes when color is false');
    assert.ok(out.includes('›') && out.includes('●'));
  });

  it('emits ANSI when color is true (and the bare glyphs survive stripping)', () => {
    const out = renderResumeTranscript(
      [msg('user', 'a'), msg('assistant', 'b')],
      { color: true },
    );
    assert.ok(out.includes(ESC), 'ANSI escape bytes present when color is true');
    assert.ok(strip(out).includes('›') && strip(out).includes('●'));
  });
});

// ---------------------------------------------------------------------------
// FUNCTIONAL: a resumed conversation's prior turns reach the built prompt.
// ---------------------------------------------------------------------------

describe('resume — prior history reaches the model prompt', () => {
  it('compacts loaded history into the CONVERSATION SO FAR block', () => {
    // Simulates the menu path: priorHistory = store.load(convId), then
    // historyContext = compactHistory(priorHistory), then buildPrompt(... , historyContext).
    const priorHistory: SessionEntry[] = [
      entry('user', 'My project is called Zephyr.'),
      entry('assistant', 'Got it — Zephyr.'),
      entry('user', 'What did I name my project?'),
    ];
    const historyContext = compactHistory(priorHistory);
    const prompt = buildPrompt('ic', 'Answer the question.', undefined, historyContext);

    assert.match(prompt, /CONVERSATION SO FAR/);
    // Every prior turn the user typed/heard must be present so the model can
    // genuinely continue the thread.
    assert.match(prompt, /My project is called Zephyr\./);
    assert.match(prompt, /Got it — Zephyr\./);
    assert.match(prompt, /What did I name my project\?/);
  });

  it('does not inject a CONVERSATION SO FAR block for a fresh (empty) history', () => {
    const historyContext = compactHistory([]);
    const prompt = buildPrompt('ic', 'Hello.', undefined, historyContext);
    assert.doesNotMatch(prompt, /CONVERSATION SO FAR/);
  });
});
