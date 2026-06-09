/**
 * Unit tests for src/core/history.ts
 * Run with: node --experimental-strip-types --test test/unit/history.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, historyTruncationInfo } from '../../src/core/history.ts';
import type { SessionEntry } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  role: SessionEntry['role'],
  content: string,
  timestamp = '2024-01-01T00:00:00.000Z',
): SessionEntry {
  return { timestamp, role, content };
}

// ---------------------------------------------------------------------------
// Empty / no input
// ---------------------------------------------------------------------------

describe('compactHistory — empty / no input', () => {
  it('returns empty string for an empty array', () => {
    assert.equal(compactHistory([]), '');
  });

  it('returns empty string for a single-element array with empty content', () => {
    const result = compactHistory([makeEntry('user', '')]);
    // A single empty-content user turn formats as "User: " (label + empty content)
    assert.equal(result, 'User: ');
  });

  it('never throws on edge-case inputs', () => {
    assert.doesNotThrow(() => compactHistory([]));
    assert.doesNotThrow(() => compactHistory([makeEntry('user', '')]));
    assert.doesNotThrow(() => compactHistory([makeEntry('assistant', '')]));
  });
});

// ---------------------------------------------------------------------------
// Basic formatting
// ---------------------------------------------------------------------------

describe('compactHistory — basic formatting', () => {
  it('formats a single user turn as "User: <content>"', () => {
    const result = compactHistory([makeEntry('user', 'hello world')]);
    assert.equal(result, 'User: hello world');
  });

  it('formats a single assistant turn as "Assistant: <content>"', () => {
    const result = compactHistory([makeEntry('assistant', 'here is the answer')]);
    assert.equal(result, 'Assistant: here is the answer');
  });

  it('formats a system entry as "System: <content>"', () => {
    const result = compactHistory([makeEntry('system', 'you are a helper')]);
    assert.equal(result, 'System: you are a helper');
  });

  it('joins multiple turns with double newlines', () => {
    const entries: SessionEntry[] = [
      makeEntry('user', 'first message'),
      makeEntry('assistant', 'first reply'),
      makeEntry('user', 'second message'),
    ];
    const result = compactHistory(entries);
    assert.equal(result, 'User: first message\n\nAssistant: first reply\n\nUser: second message');
  });
});

// ---------------------------------------------------------------------------
// Confidence envelope stripping
// ---------------------------------------------------------------------------

describe('compactHistory — confidence envelope stripping', () => {
  it('strips trailing confidence envelope from assistant turns', () => {
    const content =
      'I have completed the task.\n' +
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const result = compactHistory([makeEntry('assistant', content)]);
    assert.ok(result.includes('I have completed the task.'), 'Should keep main content');
    assert.ok(!result.includes('"confidence"'), 'Should strip the confidence envelope');
  });

  it('does NOT strip envelope-like JSON from user turns', () => {
    const content = 'My config: {"confidence": 0.9, "setting": true}';
    const result = compactHistory([makeEntry('user', content)]);
    assert.ok(result.includes('"confidence"'), 'Should preserve user content as-is');
  });

  it('does NOT strip envelope-like JSON from system turns', () => {
    const content = 'System note: {"confidence": 0.9, "key": "val"}';
    const result = compactHistory([makeEntry('system', content)]);
    assert.ok(result.includes('"confidence"'), 'Should preserve system content as-is');
  });

  it('keeps remaining content after stripping envelope', () => {
    const content =
      'Line 1\nLine 2\n' +
      '{"confidence": 0.7, "escalate": true, "reason": "x", "needs_review": true}';
    const result = compactHistory([makeEntry('assistant', content)]);
    assert.ok(result.includes('Line 1'), 'Should keep line 1');
    assert.ok(result.includes('Line 2'), 'Should keep line 2');
    assert.ok(!result.includes('"confidence": 0.7'), 'Should strip envelope');
  });

  it('strips a trailing ask_user block from replayed history (Major 1 regression)', () => {
    // A question turn is persisted with its raw ask_user block; it must NOT be
    // replayed into the next prompt as if it were conversational prose.
    const content =
      'Which test framework do you prefer?\n' +
      '{"ask_user":{"questions":[{"id":"fw","prompt":"Which?","options":[{"label":"vitest"},{"label":"jest"}],"multiSelect":false,"allowFreeText":true}]}}';
    const result = compactHistory([makeEntry('assistant', content)]);
    assert.ok(result.includes('Which test framework'), 'Should keep the human-readable question text');
    assert.ok(!result.includes('ask_user'), 'Should strip the raw ask_user JSON block');
  });

  it('strips a trailing goal marker from replayed assistant history', () => {
    const content = 'Finished the implementation and tests.\nGOAL_COMPLETE';
    const result = compactHistory([makeEntry('assistant', content)]);
    assert.equal(result, 'Assistant: Finished the implementation and tests.');
    assert.ok(!result.includes('GOAL_COMPLETE'), 'Should strip the raw goal marker');
  });

  it('strips a goal marker exposed after removing a trailing envelope', () => {
    const content =
      'Finished the implementation and tests.\n' +
      'GOAL_CONTINUE: run the contract tests\n' +
      '{"confidence": 0.8, "escalate": false, "reason": "x", "needs_review": false}';
    const result = compactHistory([makeEntry('assistant', content)]);
    assert.equal(result, 'Assistant: Finished the implementation and tests.');
    assert.ok(!result.includes('GOAL_CONTINUE'), 'Should strip marker before replay');
    assert.ok(!result.includes('"confidence"'), 'Should still strip the confidence envelope');
  });

  it('handles assistant content with no envelope gracefully', () => {
    const content = 'Just a plain response with no JSON at all.';
    const result = compactHistory([makeEntry('assistant', content)]);
    assert.equal(result, 'Assistant: Just a plain response with no JSON at all.');
  });

  it('handles malformed JSON at end of assistant content without throwing', () => {
    const content = 'Work done.\n{"confidence": 0.8, "escalate": false broken json';
    assert.doesNotThrow(() => {
      const result = compactHistory([makeEntry('assistant', content)]);
      assert.equal(typeof result, 'string');
    });
  });

  it('handles JSON without confidence key (not stripped)', () => {
    const content = 'Response.\n{"escalate": false, "reason": "no confidence key"}';
    const result = compactHistory([makeEntry('assistant', content)]);
    // Should not strip since there's no "confidence" key
    assert.ok(result.includes('"escalate"'), 'Should keep JSON without confidence key');
  });

  it('strips the LAST envelope when multiple are present', () => {
    const content =
      '{"confidence": 0.3, "escalate": true, "reason": "first", "needs_review": false}\n' +
      'Revised analysis.\n' +
      '{"confidence": 0.9, "escalate": false, "reason": "second", "needs_review": false}';
    const result = compactHistory([makeEntry('assistant', content)]);
    // Should keep "first" envelope (not the last) but strip the last
    assert.ok(!result.includes('"reason": "second"'), 'Should strip the last envelope');
    assert.ok(result.includes('Revised analysis.'), 'Should keep main content');
  });
});

// ---------------------------------------------------------------------------
// maxTurns windowing
// ---------------------------------------------------------------------------

describe('compactHistory — maxTurns windowing', () => {
  it('includes all turns when count is under maxTurns', () => {
    const entries = [
      makeEntry('user', 'turn 1'),
      makeEntry('assistant', 'reply 1'),
      makeEntry('user', 'turn 2'),
    ];
    const result = compactHistory(entries, { maxTurns: 10 });
    assert.ok(result.includes('turn 1'), 'Should include turn 1');
    assert.ok(result.includes('turn 2'), 'Should include turn 2');
  });

  it('keeps only the MOST RECENT turns when count exceeds maxTurns', () => {
    const entries: SessionEntry[] = [];
    for (let i = 1; i <= 15; i++) {
      entries.push(makeEntry('user', `turn-${i}-end`));
    }
    const result = compactHistory(entries, { maxTurns: 5 });
    // Should include turns 11-15 (most recent 5)
    assert.ok(result.includes('turn-15-end'), 'Should include the most recent turn');
    assert.ok(result.includes('turn-11-end'), 'Should include turn 11 (within last 5)');
    assert.ok(!result.includes('turn-10-end'), 'Should NOT include turn 10 (outside window)');
    assert.ok(!result.includes('turn-1-end'), 'Should NOT include oldest turns');
  });

  it('preserves chronological order within the window', () => {
    const entries: SessionEntry[] = [
      makeEntry('user', 'alpha'),
      makeEntry('assistant', 'beta'),
      makeEntry('user', 'gamma'),
      makeEntry('assistant', 'delta'),
    ];
    const result = compactHistory(entries, { maxTurns: 3 });
    // Most recent 3: beta, gamma, delta — in order
    const betaIdx = result.indexOf('beta');
    const gammaIdx = result.indexOf('gamma');
    const deltaIdx = result.indexOf('delta');
    assert.ok(betaIdx < gammaIdx, 'beta should come before gamma');
    assert.ok(gammaIdx < deltaIdx, 'gamma should come before delta');
    assert.ok(!result.includes('alpha'), 'alpha (oldest) should be dropped');
  });

  it('respects maxTurns: 1 (only the last turn)', () => {
    const entries = [
      makeEntry('user', 'first'),
      makeEntry('user', 'second'),
      makeEntry('user', 'third'),
    ];
    const result = compactHistory(entries, { maxTurns: 1 });
    assert.ok(result.includes('third'), 'Should include only the last turn');
    assert.ok(!result.includes('first'), 'Should not include first turn');
    assert.ok(!result.includes('second'), 'Should not include second turn');
  });

  it('uses default maxTurns of 12 when not specified', () => {
    const entries: SessionEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      entries.push(makeEntry('user', `msg ${i}`));
    }
    const result = compactHistory(entries);
    assert.ok(result.includes('msg 20'), 'Should include most recent');
    assert.ok(result.includes('msg 9'), 'Should include msg 9 (within last 12)');
    assert.ok(!result.includes('msg 8'), 'Should NOT include msg 8 (outside last 12)');
  });
});

// ---------------------------------------------------------------------------
// maxChars budget — oldest turns dropped first
// ---------------------------------------------------------------------------

describe('compactHistory — maxChars budget', () => {
  it('returns full output when total chars are under maxChars', () => {
    const entries = [
      makeEntry('user', 'short message'),
      makeEntry('assistant', 'short reply'),
    ];
    const result = compactHistory(entries, { maxChars: 6000 });
    assert.ok(result.includes('short message'));
    assert.ok(result.includes('short reply'));
  });

  it('drops oldest turns to stay under maxChars', () => {
    // Create entries where the full set exceeds budget but the last one alone is under
    const entries: SessionEntry[] = [
      makeEntry('user', 'a'.repeat(100)),  // oldest — should be dropped
      makeEntry('user', 'b'.repeat(100)),
      makeEntry('user', 'c'.repeat(50)),   // newest — should survive
    ];
    // Budget: tight enough to force dropping 'a's
    const result = compactHistory(entries, { maxChars: 200 });
    assert.ok(result.includes('c'.repeat(50)), 'Newest content should survive');
    assert.ok(!result.includes('a'.repeat(100)), 'Oldest should be dropped if over budget');
  });

  it('returns at most one turn when only the last turn fits', () => {
    const entries: SessionEntry[] = [
      makeEntry('user', 'x'.repeat(300)),
      makeEntry('user', 'y'.repeat(300)),
      makeEntry('user', 'z short'),
    ];
    const result = compactHistory(entries, { maxChars: 100 });
    // Only "User: z short" (13 chars) fits
    assert.ok(result.includes('z short'), 'Last (shortest) turn should fit');
    assert.ok(!result.includes('x'.repeat(300)), 'Oldest should be dropped');
  });

  it('truncates a single turn that exceeds maxChars with a marker', () => {
    const entries = [makeEntry('user', 'x'.repeat(10000))];
    const result = compactHistory(entries, { maxChars: 100 });
    assert.ok(result.endsWith('…[truncated]'), 'Should end with truncation marker');
    assert.ok(result.length <= 100, `Result length ${result.length} should be <= 100`);
  });

  it('uses default maxChars of 6000 when not specified', () => {
    const entries = [makeEntry('user', 'a'.repeat(3000)), makeEntry('user', 'b'.repeat(3001))];
    const result = compactHistory(entries);
    // Total: "User: " (6) + 3000 + "\n\n" (2) + "User: " (6) + 3001 = 6015 > 6000
    // Should drop the first entry
    assert.ok(result.includes('b'.repeat(3001)), 'Newer content survives');
    assert.ok(!result.includes('a'.repeat(3000)), 'Older content dropped when over 6000');
  });
});

// ---------------------------------------------------------------------------
// Role mapping
// ---------------------------------------------------------------------------

describe('compactHistory — role mapping', () => {
  it('maps user → "User:"', () => {
    const result = compactHistory([makeEntry('user', 'hello')]);
    assert.ok(result.startsWith('User:'));
  });

  it('maps assistant → "Assistant:"', () => {
    const result = compactHistory([makeEntry('assistant', 'hello')]);
    assert.ok(result.startsWith('Assistant:'));
  });

  it('maps system → "System:"', () => {
    const result = compactHistory([makeEntry('system', 'hello')]);
    assert.ok(result.startsWith('System:'));
  });
});

// ---------------------------------------------------------------------------
// Never throws — malformed/garbage content
// ---------------------------------------------------------------------------

describe('compactHistory — never throws', () => {
  const MALFORMED_CONTENTS = [
    '',
    '   ',
    '\x00\x01\x02binary\xFF',
    '{',
    '}',
    '{"confidence":',
    '{"confidence": 0.5, "escalate":',
    String.fromCharCode(0),
    '{{{{{{',
    '}}}}}}',
    '{"confidence": 0.5',
    'a'.repeat(100_000),
  ];

  for (const content of MALFORMED_CONTENTS) {
    const label = content.length > 40 ? content.slice(0, 40) + '…' : JSON.stringify(content);
    it(`does not throw for malformed content: ${label}`, () => {
      assert.doesNotThrow(() => {
        const result = compactHistory([makeEntry('assistant', content)]);
        assert.equal(typeof result, 'string');
      });
    });
  }

  it('does not throw when entries array has mixed valid/invalid structures', () => {
    assert.doesNotThrow(() => {
      const entries: SessionEntry[] = [
        makeEntry('user', 'normal message'),
        makeEntry('assistant', '{"confidence": 0.9, "escalate": false, "reason": "ok", "needs_review": false}'),
        makeEntry('system', '\x00\xFF binary'),
        makeEntry('user', ''),
      ];
      const result = compactHistory(entries);
      assert.equal(typeof result, 'string');
    });
  });
});

// ---------------------------------------------------------------------------
// Combined options
// ---------------------------------------------------------------------------

describe('compactHistory — combined maxTurns + maxChars', () => {
  it('applies maxTurns windowing before maxChars budget check', () => {
    const entries: SessionEntry[] = [];
    for (let i = 1; i <= 20; i++) {
      entries.push(makeEntry('user', `msg-${i}-end ` + 'x'.repeat(50)));
    }
    // maxTurns: 3 → keeps msgs 18, 19, 20 → each ~60 chars
    // maxChars: 300 → all 3 should fit (3 * ~60 + separators ≈ 200)
    const result = compactHistory(entries, { maxTurns: 3, maxChars: 300 });
    assert.ok(result.includes('msg-20-end'), 'msg 20 should be included');
    assert.ok(result.includes('msg-18-end'), 'msg 18 should be included');
    assert.ok(!result.includes('msg-17-end'), 'msg 17 should be excluded by maxTurns');
    assert.ok(!result.includes('msg-1-end'), 'msg 1 should be excluded by maxTurns');
  });

  it('drops oldest within window if still over maxChars', () => {
    const entries: SessionEntry[] = [
      makeEntry('user', 'old: ' + 'a'.repeat(200)),
      makeEntry('user', 'new: ' + 'b'.repeat(50)),
    ];
    const result = compactHistory(entries, { maxTurns: 12, maxChars: 100 });
    // The first entry alone is ~211 chars, too big. Second is ~62, fits.
    assert.ok(result.includes('b'.repeat(50)), 'Newer entry should fit');
    assert.ok(!result.includes('a'.repeat(200)), 'Older entry should be dropped');
  });
});

// ---------------------------------------------------------------------------
// historyTruncationInfo — honesty seam (reports what compactHistory drops)
// ---------------------------------------------------------------------------

describe('historyTruncationInfo', () => {
  it('reports no truncation for empty input', () => {
    assert.deepEqual(historyTruncationInfo([]), { truncated: false, droppedTurns: 0 });
  });

  it('reports no truncation when within both bounds', () => {
    const entries = [makeEntry('user', 'hi'), makeEntry('assistant', 'hello')];
    assert.deepEqual(historyTruncationInfo(entries), { truncated: false, droppedTurns: 0 });
  });

  it('reports turns dropped by the maxTurns window', () => {
    const entries: SessionEntry[] = [];
    for (let i = 1; i <= 20; i++) entries.push(makeEntry('user', `msg-${i}`));
    const info = historyTruncationInfo(entries, { maxTurns: 12, maxChars: 6000 });
    assert.equal(info.truncated, true);
    assert.equal(info.droppedTurns, 8, '20 - 12 = 8 turns outside the window');
  });

  it('reports turns dropped by the maxChars budget', () => {
    const entries: SessionEntry[] = [
      makeEntry('user', 'old: ' + 'a'.repeat(200)),
      makeEntry('user', 'new: ' + 'b'.repeat(50)),
    ];
    const info = historyTruncationInfo(entries, { maxTurns: 12, maxChars: 100 });
    assert.equal(info.truncated, true);
    assert.equal(info.droppedTurns, 1, 'the over-budget older turn is dropped');
  });

  it('does NOT count a single over-long final turn as a dropped turn', () => {
    const entries = [makeEntry('user', 'x'.repeat(500))];
    const info = historyTruncationInfo(entries, { maxTurns: 12, maxChars: 100 });
    assert.deepEqual(info, { truncated: false, droppedTurns: 0 });
  });

  it('agrees with compactHistory: count matches turns actually omitted', () => {
    const entries: SessionEntry[] = [];
    for (let i = 1; i <= 20; i++) entries.push(makeEntry('user', `msg-${i}-end`));
    const info = historyTruncationInfo(entries, { maxTurns: 3, maxChars: 6000 });
    const out = compactHistory(entries, { maxTurns: 3, maxChars: 6000 });
    assert.equal(info.droppedTurns, 17);
    assert.ok(!out.includes('msg-17-end'), 'compactHistory omits the 17 older turns');
    assert.ok(out.includes('msg-18-end'), 'compactHistory keeps the recent window');
  });
});
