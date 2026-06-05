/**
 * test/unit/intent.test.ts — the PURE intent core (core/intent.ts).
 *
 * Covers: rulesIntentFrame (deterministic fallback), capIntentFrame (defensive
 * caps), parseIntentFrame (tolerant-but-strict, never throws), shouldExtractIntent
 * (the cost-discipline gate), buildIntentPrompt, and renderIntentBlock. All pure —
 * no model, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  rulesIntentFrame,
  capIntentFrame,
  parseIntentFrame,
  shouldExtractIntent,
  buildIntentPrompt,
  renderIntentBlock,
  type IntentFrame,
} from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';

const CLS = (tier: Classification['tier'], risk: Classification['risk'] = 'low'): Classification => ({
  tier,
  risk,
  rationale: `tier: ${tier}; risk: ${risk}`,
});

// ---------------------------------------------------------------------------
// rulesIntentFrame — deterministic, pure, never throws
// ---------------------------------------------------------------------------

describe('rulesIntentFrame', () => {
  it('is deterministic: same input → identical frame', () => {
    const a = rulesIntentFrame('write a blog post about cats', CLS('worker'));
    const b = rulesIntentFrame('write a blog post about cats', CLS('worker'));
    assert.deepEqual(a, b);
  });

  it('derives the goal from the first sentence/line, capped', () => {
    const frame = rulesIntentFrame('Fix the login bug. Then also clean up the CSS.', CLS('ic'));
    assert.equal(frame.goal, 'Fix the login bug.');
    assert.equal(frame.version, 1);
  });

  it('infers a coarse kind from keywords', () => {
    assert.equal(rulesIntentFrame('write an essay on X', CLS('worker')).kind, 'writing');
    assert.equal(rulesIntentFrame('research the latest on Y', CLS('worker')).kind, 'research');
    assert.equal(rulesIntentFrame('deploy the service to prod', CLS('ic')).kind, 'ops');
    assert.equal(rulesIntentFrame('refactor the parser', CLS('ic')).kind, 'coding');
  });

  it('marks source as rules-fallback by default and skipped on request', () => {
    assert.equal(rulesIntentFrame('x', CLS('ic')).source, 'rules-fallback');
    assert.equal(rulesIntentFrame('x', CLS('ic'), 'skipped').source, 'skipped');
  });

  it('confidence reflects tier: worker medium, manager/ic low', () => {
    assert.equal(rulesIntentFrame('what is 2+2', CLS('worker')).confidence, 'medium');
    assert.equal(rulesIntentFrame('design the whole thing', CLS('manager')).confidence, 'low');
    assert.equal(rulesIntentFrame('fix it', CLS('ic')).confidence, 'low');
  });

  it('handles empty input without throwing', () => {
    const frame = rulesIntentFrame('', CLS('ic'));
    assert.equal(frame.goal, '');
    assert.equal(frame.version, 1);
  });
});

// ---------------------------------------------------------------------------
// capIntentFrame — defensive caps, never throws
// ---------------------------------------------------------------------------

describe('capIntentFrame', () => {
  it('caps the goal length and list sizes', () => {
    const big: IntentFrame = {
      version: 1,
      goal: 'g'.repeat(1000),
      constraints: ['a', 'b', 'c', 'd', 'e'],
      nonGoals: ['x', 'y', 'z', 'w'],
      forks: [
        { id: 'F1', question: 'q1' },
        { id: 'F2', question: 'q2' },
        { id: 'F3', question: 'q3' },
        { id: 'F4', question: 'q4' },
      ],
      confidence: 'high',
      source: 'model',
    };
    const capped = capIntentFrame(big);
    assert.ok(capped.goal.length <= 240);
    assert.equal(capped.constraints?.length, 3);
    assert.equal(capped.nonGoals?.length, 3);
    assert.equal(capped.forks?.length, 3);
  });

  it('coerces a bad confidence enum to low and a bad source to model', () => {
    const frame = capIntentFrame({
      version: 1,
      goal: 'do a thing',
      confidence: 'super-sure' as unknown as IntentFrame['confidence'],
      source: 'nonsense' as unknown as IntentFrame['source'],
    });
    assert.equal(frame.confidence, 'low');
    assert.equal(frame.source, 'model');
  });

  it('drops a fork with no question and assigns a fallback id', () => {
    const frame = capIntentFrame({
      version: 1,
      goal: 'g',
      forks: [
        { id: '', question: 'real fork' },
        { id: 'F2', question: '' },
      ] as unknown as IntentFrame['forks'],
      confidence: 'medium',
      source: 'model',
    });
    assert.equal(frame.forks?.length, 1);
    assert.equal(frame.forks?.[0]?.id, 'F1');
    assert.equal(frame.forks?.[0]?.question, 'real fork');
  });

  it('never throws on garbage input', () => {
    assert.doesNotThrow(() => capIntentFrame(null as unknown as IntentFrame));
    assert.doesNotThrow(() => capIntentFrame(42 as unknown as IntentFrame));
    assert.doesNotThrow(() =>
      capIntentFrame({ goal: { nested: true } } as unknown as IntentFrame),
    );
  });
});

// ---------------------------------------------------------------------------
// parseIntentFrame — tolerant-but-strict, never throws
// ---------------------------------------------------------------------------

describe('parseIntentFrame', () => {
  it('parses a valid frame', () => {
    const frame = parseIntentFrame(
      '{"goal":"ship the API","kind":"coding","confidence":"high","forks":[{"id":"F1","question":"REST or GraphQL?","options":["REST","GraphQL"],"assumeIfUnasked":"REST"}]}',
    );
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'ship the API');
    assert.equal(frame.kind, 'coding');
    assert.equal(frame.confidence, 'high');
    assert.equal(frame.source, 'model');
    assert.equal(frame.forks?.[0]?.assumeIfUnasked, 'REST');
  });

  it('tolerates prose around the JSON', () => {
    const frame = parseIntentFrame(
      'Here is the frame:\n{"goal":"do X","confidence":"low"}\nThanks!',
    );
    assert.equal(frame?.goal, 'do X');
  });

  it('returns null when goal is missing or empty', () => {
    assert.equal(parseIntentFrame('{"confidence":"high"}'), null);
    assert.equal(parseIntentFrame('{"goal":"","confidence":"high"}'), null);
  });

  it('returns null on a bad confidence enum', () => {
    assert.equal(parseIntentFrame('{"goal":"x","confidence":"certain"}'), null);
  });

  it('caps oversized lists rather than rejecting', () => {
    const frame = parseIntentFrame(
      `{"goal":"x","confidence":"medium","constraints":["a","b","c","d","e"]}`,
    );
    assert.equal(frame?.constraints?.length, 3);
  });

  it('ignores extra keys', () => {
    const frame = parseIntentFrame('{"goal":"x","confidence":"low","bogus":123}');
    assert.equal(frame?.goal, 'x');
  });

  it('never throws on garbage / undefined', () => {
    assert.equal(parseIntentFrame(undefined), null);
    assert.equal(parseIntentFrame('not json at all'), null);
    assert.equal(parseIntentFrame('{ broken'), null);
    assert.doesNotThrow(() => parseIntentFrame('}{}{'));
  });
});

// ---------------------------------------------------------------------------
// shouldExtractIntent — the cost-discipline gate (the headline)
// ---------------------------------------------------------------------------

describe('shouldExtractIntent — the gate', () => {
  const base = { hasExtractor: true } as const;

  it('skips when no extractor is wired (zero overhead)', () => {
    assert.equal(
      shouldExtractIntent({
        task: 'design the whole architecture',
        classification: CLS('manager'),
        routePlan: true,
        hasExtractor: false,
      }),
      false,
    );
  });

  it('skips a clear small worker task (the instant fast-path population)', () => {
    assert.equal(
      shouldExtractIntent({ ...base, task: 'what is 2+2', classification: CLS('worker'), routePlan: false }),
      false,
    );
  });

  it('runs on manager-tier work', () => {
    assert.equal(
      shouldExtractIntent({ ...base, task: 'do it', classification: CLS('manager'), routePlan: false }),
      true,
    );
  });

  it('runs when routePlan is true', () => {
    assert.equal(
      shouldExtractIntent({ ...base, task: 'do it', classification: CLS('ic'), routePlan: true }),
      true,
    );
  });

  it('runs on a long / multi-clause task', () => {
    assert.equal(
      shouldExtractIntent({
        ...base,
        task: 'first set up the database, then wire the API, and finally add tests',
        classification: CLS('ic'),
        routePlan: false,
      }),
      true,
    );
  });

  it('direct + non-substantial → skip (user opted out of overhead)', () => {
    assert.equal(
      shouldExtractIntent({
        ...base,
        task: 'fix this typo',
        classification: CLS('worker'),
        routePlan: false,
        partnerStyle: 'direct',
      }),
      false,
    );
  });

  it('collaborative runs more readily but still skips a truly trivial turn', () => {
    // A non-worker single-clause turn runs for collaborative...
    assert.equal(
      shouldExtractIntent({
        ...base,
        task: 'tweak the button',
        classification: CLS('ic'),
        routePlan: false,
        partnerStyle: 'collaborative',
      }),
      true,
    );
    // ...but "what time is it?" (worker, trivial) still skips.
    assert.equal(
      shouldExtractIntent({
        ...base,
        task: 'what time is it?',
        classification: CLS('worker'),
        routePlan: false,
        partnerStyle: 'collaborative',
      }),
      false,
    );
  });

  it('skips empty input', () => {
    assert.equal(
      shouldExtractIntent({ ...base, task: '   ', classification: CLS('manager'), routePlan: true }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// buildIntentPrompt + renderIntentBlock — pure string builders
// ---------------------------------------------------------------------------

describe('buildIntentPrompt', () => {
  it('embeds the task and instructs JSON-only, read-only extraction', () => {
    const p = buildIntentPrompt('build the dashboard');
    assert.ok(p.includes('build the dashboard'));
    assert.ok(/ONLY a JSON object/i.test(p));
    assert.ok(/Do NOT do the work/i.test(p));
  });
});

describe('renderIntentBlock', () => {
  it('returns "" for undefined or a goalless frame', () => {
    assert.equal(renderIntentBlock(undefined), '');
    assert.equal(
      renderIntentBlock({ version: 1, goal: '', confidence: 'low', source: 'skipped' }),
      '',
    );
  });

  it('renders goal + scope + forks as a reflectable INTENT block', () => {
    const block = renderIntentBlock({
      version: 1,
      goal: 'rebuild the homepage',
      kind: 'design',
      constraints: ['no new deps'],
      doneWhen: 'matches the mock',
      forks: [{ id: 'F1', question: 'dark mode?', assumeIfUnasked: 'light only' }],
      confidence: 'medium',
      source: 'model',
    });
    assert.ok(block.startsWith('INTENT'));
    assert.ok(block.includes('Goal: rebuild the homepage'));
    assert.ok(block.includes('Constraints: no new deps'));
    assert.ok(block.includes('Done when: matches the mock'));
    assert.ok(block.includes('dark mode?'));
    assert.ok(block.includes('assume: light only'));
  });
});
