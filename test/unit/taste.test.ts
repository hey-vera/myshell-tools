/**
 * test/unit/taste.test.ts — the PURE core of the learned-taste ledger
 * (src/core/taste.ts) + the flag (src/core/taste-flag.ts).
 *
 * Covers: the observed-only normalize gate, the type guards, the distill
 * (memoryBias dial + playbook lines), project scoping in distill, the immediate-
 * rephrase detector, the playbook render (incl. explicit > learned footer), and
 * the default-OFF flag. ZERO I/O, ZERO model calls — all functions are pure.
 *
 * Run: node --experimental-strip-types --test test/unit/taste.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTasteEvent,
  isTasteEvent,
  isTasteSignal,
  distillTaste,
  leanOf,
  isImmediateRephrase,
  renderTastePlaybook,
  EMPTY_PLAYBOOK,
  TASTE_SUBJECT_MAX,
  type TasteEvent,
} from '../../src/core/taste.ts';
import { tasteEnabled } from '../../src/core/taste-flag.ts';

const NOW = '2026-06-09T00:00:00.000Z';

function ev(overrides: Partial<TasteEvent> = {}): TasteEvent {
  return {
    v: 1,
    ts: NOW,
    projectKey: null,
    signal: 'fork_choice',
    subject: 'server-vs-client data',
    choice: 'server-side',
    source: 'observed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeTasteEvent — the observed-only write gate
// ---------------------------------------------------------------------------

describe('normalizeTasteEvent (observed-only gate)', () => {
  it('accepts a well-formed observation and stamps source:observed', () => {
    const out = normalizeTasteEvent(
      { signal: 'fork_choice', subject: 'data fetching', choice: 'server components' },
      NOW,
    );
    assert.notEqual(out, null);
    assert.equal(out?.source, 'observed');
    assert.equal(out?.v, 1);
    assert.equal(out?.ts, NOW);
    assert.equal(out?.projectKey, null);
  });

  it('rejects an unknown signal (cannot fabricate a non-observed class)', () => {
    const out = normalizeTasteEvent(
      // @ts-expect-error — exercising the runtime guard with a bad signal
      { signal: 'sentiment_guess', subject: 's', choice: 'c' },
      NOW,
    );
    assert.equal(out, null);
  });

  it('rejects a blank subject or blank choice', () => {
    assert.equal(normalizeTasteEvent({ signal: 'fork_choice', subject: '  ', choice: 'x' }, NOW), null);
    assert.equal(normalizeTasteEvent({ signal: 'fork_choice', subject: 'x', choice: '' }, NOW), null);
  });

  it('caps an over-long subject at TASTE_SUBJECT_MAX', () => {
    const long = 'a'.repeat(TASTE_SUBJECT_MAX + 50);
    const out = normalizeTasteEvent({ signal: 'fork_choice', subject: long, choice: 'c' }, NOW);
    assert.equal(out?.subject.length, TASTE_SUBJECT_MAX);
  });

  it('keeps a string projectKey, nulls an empty one', () => {
    const a = normalizeTasteEvent(
      { signal: 'fork_choice', subject: 's', choice: 'c', projectKey: 'app#abc12345' },
      NOW,
    );
    assert.equal(a?.projectKey, 'app#abc12345');
    const b = normalizeTasteEvent({ signal: 'fork_choice', subject: 's', choice: 'c', projectKey: '' }, NOW);
    assert.equal(b?.projectKey, null);
  });

  it('never throws on garbage input', () => {
    // @ts-expect-error — deliberately malformed
    assert.equal(normalizeTasteEvent(null, NOW), null);
    // @ts-expect-error — deliberately malformed
    assert.equal(normalizeTasteEvent({ signal: 123 }, NOW), null);
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe('isTasteSignal / isTasteEvent', () => {
  it('isTasteSignal accepts the closed vocabulary, rejects others', () => {
    for (const s of [
      'fork_choice',
      'pushback_accept',
      'pushback_reject',
      'accept_unchanged',
      'immediate_edit',
      'immediate_rephrase',
    ]) {
      assert.equal(isTasteSignal(s), true);
    }
    assert.equal(isTasteSignal('inferred_opinion'), false);
    assert.equal(isTasteSignal(42), false);
    assert.equal(isTasteSignal(undefined), false);
  });

  it('isTasteEvent accepts a real event, rejects foreign/corrupt lines', () => {
    assert.equal(isTasteEvent(ev()), true);
    assert.equal(isTasteEvent({ ...ev(), source: 'inferred' }), false); // honesty floor
    assert.equal(isTasteEvent({ ...ev(), v: 2 }), false);
    assert.equal(isTasteEvent({ hello: 'world' }), false);
    assert.equal(isTasteEvent(null), false);
  });
});

// ---------------------------------------------------------------------------
// leanOf — the ask-vs-proceed direction per signal
// ---------------------------------------------------------------------------

describe('leanOf', () => {
  it('accept signals lean proceed; correct/reject signals lean ask; fork is neutral', () => {
    assert.equal(leanOf('accept_unchanged'), 'proceed');
    assert.equal(leanOf('pushback_accept'), 'proceed');
    assert.equal(leanOf('immediate_edit'), 'ask');
    assert.equal(leanOf('immediate_rephrase'), 'ask');
    assert.equal(leanOf('pushback_reject'), 'ask');
    assert.equal(leanOf('fork_choice'), 'neutral');
  });
});

// ---------------------------------------------------------------------------
// distillTaste — events → { memoryBias, lines }
// ---------------------------------------------------------------------------

describe('distillTaste', () => {
  it('empty / malformed input → EMPTY_PLAYBOOK (no bias, no lines)', () => {
    assert.deepEqual(distillTaste([], null), EMPTY_PLAYBOOK);
    // @ts-expect-error — malformed
    assert.deepEqual(distillTaste(null, null), EMPTY_PLAYBOOK);
  });

  it('consistent accepts → memoryBias +1 (lean proceed)', () => {
    const events = [
      ev({ signal: 'accept_unchanged', subject: 'plan', choice: 'go' }),
      ev({ signal: 'accept_unchanged', subject: 'plan2', choice: 'go' }),
      ev({ signal: 'pushback_accept', subject: 'di', choice: 'di' }),
    ];
    assert.equal(distillTaste(events, null).memoryBias, 1);
  });

  it('consistent corrections → memoryBias -1 (lean ask)', () => {
    const events = [
      ev({ signal: 'immediate_edit', subject: 'tone', choice: 'warmer' }),
      ev({ signal: 'immediate_rephrase', subject: 'goal', choice: 'redo' }),
    ];
    assert.equal(distillTaste(events, null).memoryBias, -1);
  });

  it('one-off / balanced signals → memoryBias 0 (no takeover; bounded ±1)', () => {
    assert.equal(distillTaste([ev({ signal: 'accept_unchanged' })], null).memoryBias, 0);
    const balanced = [
      ev({ signal: 'accept_unchanged', subject: 'a', choice: 'go' }),
      ev({ signal: 'immediate_edit', subject: 'b', choice: 'fix' }),
    ];
    assert.equal(distillTaste(balanced, null).memoryBias, 0);
  });

  it('renders ranked playbook lines for choice-bearing signals, newest call wins', () => {
    const events = [
      ev({ ts: '2026-06-01T00:00:00.000Z', signal: 'fork_choice', subject: 'data', choice: 'client' }),
      ev({ ts: '2026-06-05T00:00:00.000Z', signal: 'fork_choice', subject: 'data', choice: 'server' }),
      ev({ ts: '2026-06-02T00:00:00.000Z', signal: 'fork_choice', subject: 'state', choice: 'redux' }),
    ];
    const pb = distillTaste(events, null);
    // 'data' has support 2 → ranked first; latest choice (server) wins.
    assert.equal(pb.lines[0], 'data: server');
    assert.ok(pb.lines.includes('state: redux'));
  });

  it('omits dial-only signals (accept_unchanged / rephrase) from playbook lines', () => {
    const events = [
      ev({ signal: 'accept_unchanged', subject: 'plan', choice: 'go' }),
      ev({ signal: 'immediate_rephrase', subject: 'goal', choice: 'redo' }),
    ];
    assert.deepEqual(distillTaste(events, null).lines, []);
  });
});

// ---------------------------------------------------------------------------
// Project scoping in distill
// ---------------------------------------------------------------------------

describe('distillTaste project scoping', () => {
  it('a project-scoped event applies ONLY in its own project', () => {
    const events = [ev({ projectKey: 'alpha#1111', signal: 'fork_choice', subject: 'x', choice: 'a' })];
    assert.deepEqual(distillTaste(events, 'beta#2222').lines, []); // different project → not applied
    assert.deepEqual(distillTaste(events, 'alpha#1111').lines, ['x: a']); // same project → applied
  });

  it('a global (null) event applies in every project', () => {
    const events = [ev({ projectKey: null, signal: 'fork_choice', subject: 'g', choice: 'global' })];
    assert.deepEqual(distillTaste(events, 'anything#9999').lines, ['g: global']);
    assert.deepEqual(distillTaste(events, null).lines, ['g: global']);
  });
});

// ---------------------------------------------------------------------------
// isImmediateRephrase
// ---------------------------------------------------------------------------

describe('isImmediateRephrase', () => {
  it('detects a re-stated goal with high token overlap', () => {
    assert.equal(
      isImmediateRephrase('add a dark mode toggle to the settings page', 'put a dark mode toggle in settings'),
      true,
    );
  });

  it('does NOT flag an exact resend (a retry, not a rephrase)', () => {
    assert.equal(isImmediateRephrase('build the login form', 'build the login form'), false);
  });

  it('does NOT flag an unrelated new topic', () => {
    assert.equal(isImmediateRephrase('add a dark mode toggle', 'now fix the failing payment webhook'), false);
  });

  it('never throws / returns false on tiny or bad input', () => {
    assert.equal(isImmediateRephrase('hi', 'yo'), false);
    // @ts-expect-error — malformed
    assert.equal(isImmediateRephrase(null, undefined), false);
  });
});

// ---------------------------------------------------------------------------
// renderTastePlaybook
// ---------------------------------------------------------------------------

describe('renderTastePlaybook', () => {
  it('returns "" for an empty playbook (no block when nothing learned / flag off)', () => {
    assert.equal(renderTastePlaybook(EMPTY_PLAYBOOK), '');
    assert.equal(renderTastePlaybook({ memoryBias: 0, lines: [] }), '');
  });

  it('renders a tagged block enforcing explicit > learned', () => {
    const block = renderTastePlaybook({ memoryBias: 1, lines: ['data: server', 'di: yes'] });
    assert.match(block, /LEARNED TASTE/);
    assert.match(block, /- data: server/);
    assert.match(block, /- di: yes/);
    // The footer must make explicit instruction win over a learned lean.
    assert.match(block, /explicit instruction this turn wins/i);
    assert.match(block, /never inferred opinions/i);
  });

  it('never throws on malformed input', () => {
    // @ts-expect-error — malformed
    assert.equal(renderTastePlaybook(null), '');
  });
});

// ---------------------------------------------------------------------------
// tasteEnabled — DEFAULT ON (max intelligence, preference layer; opt-out only)
// ---------------------------------------------------------------------------

describe('tasteEnabled (flag, default ON)', () => {
  it('is ON with no env and no config', () => {
    assert.equal(tasteEnabled(undefined, undefined), true);
    assert.equal(tasteEnabled({}, {}), true);
  });

  it('is ON with explicit env opt-in or config (already default)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
      assert.equal(tasteEnabled({ MYSHELL_TASTE: v }, undefined), true);
    }
    assert.equal(tasteEnabled({ experimentalTaste: undefined } as never, { experimentalTaste: true }), true);
  });

  it('is OFF only for explicit opt-out (falsy env or config false)', () => {
    for (const v of ['0', 'false', '', 'off', 'no']) {
      assert.equal(tasteEnabled({ MYSHELL_TASTE: v }, undefined), false);
    }
    assert.equal(tasteEnabled(undefined, { experimentalTaste: false }), false);
  });

  it('never throws on hostile input (default-ON safe)', () => {
    assert.doesNotThrow(() => tasteEnabled({ MYSHELL_TASTE: 42 as unknown as string }, { experimentalTaste: 'weird' as unknown as boolean | undefined }));
  });
});
