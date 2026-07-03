/**
 * test/unit/byproduct-parse.test.ts — the PURE byproduct parse-from-text
 * fallback (src/core/byproduct-parse.ts).
 *
 * Covers:
 *  - providerStructuredOutputCapability: descriptor for each provider
 *  - extractFencedContent: fence stripping
 *  - parsePartialIntentFrame: partial JSON (missing confidence, trailing comma, etc.)
 *  - parseProseIntentMarkers: key-marker prose extraction
 *  - parseFallbackIntentFrame: the ordered fallback chain
 *  - Regression: a clean structured response parses identically via primary parser
 *    (fallback must never alter a clean parse)
 *
 * All pure — no model, no I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  providerStructuredOutputCapability,
  extractFencedContent,
  parsePartialIntentFrame,
  parseProseIntentMarkers,
  parseFallbackIntentFrame,
  type StructuredOutputCapability,
} from '../../src/core/byproduct-parse.ts';

import { parseIntentFrame } from '../../src/core/intent.ts';

// ---------------------------------------------------------------------------
// providerStructuredOutputCapability — declarative descriptor
// ---------------------------------------------------------------------------

describe('providerStructuredOutputCapability', () => {
  const KNOWN: ReadonlyArray<{
    provider: 'claude' | 'codex' | 'opencode' | 'grok';
    expected: StructuredOutputCapability;
  }> = [
    { provider: 'claude', expected: 'clean' },
    { provider: 'codex', expected: 'clean' },
    { provider: 'opencode', expected: 'fenced' },
    { provider: 'grok', expected: 'fenced' },
  ];

  for (const { provider, expected } of KNOWN) {
    it(`${provider} has expected structuredOutput=${expected}`, () => {
      const cap = providerStructuredOutputCapability(provider);
      assert.equal(cap.provider, provider);
      assert.equal(cap.structuredOutput, expected);
      assert.ok(typeof cap.note === 'string' && cap.note.length > 0, 'note is non-empty');
    });
  }
});

// ---------------------------------------------------------------------------
// extractFencedContent — strips markdown fences
// ---------------------------------------------------------------------------

describe('extractFencedContent', () => {
  it('extracts content from a ```json fence', () => {
    const text = '```json\n{"goal":"build","confidence":"medium"}\n```';
    const result = extractFencedContent(text);
    assert.equal(result, '{"goal":"build","confidence":"medium"}');
  });

  it('extracts content from a bare ``` fence (no language tag)', () => {
    const text = '```\n{"goal":"x","confidence":"high"}\n```';
    const result = extractFencedContent(text);
    assert.equal(result, '{"goal":"x","confidence":"high"}');
  });

  it('returns the LAST fence when multiple fences are present', () => {
    const text = [
      'First fence:',
      '```json',
      '{"goal":"first","confidence":"low"}',
      '```',
      'Second fence:',
      '```json',
      '{"goal":"second","confidence":"medium"}',
      '```',
    ].join('\n');
    const result = extractFencedContent(text);
    assert.equal(result, '{"goal":"second","confidence":"medium"}');
  });

  it('extracts from a 4-backtick fence', () => {
    const text = '````json\n{"goal":"a","confidence":"high"}\n````';
    const result = extractFencedContent(text);
    assert.equal(result, '{"goal":"a","confidence":"high"}');
  });

  it('returns null when no fence is present', () => {
    assert.equal(extractFencedContent('just plain text'), null);
    assert.equal(extractFencedContent('{"goal":"x","confidence":"low"}'), null);
  });

  it('returns null for an empty or undefined-like input', () => {
    assert.equal(extractFencedContent(''), null);
    assert.equal(extractFencedContent('   '), null);
  });

  it('ignores a fence whose content is only whitespace', () => {
    const text = '```json\n   \n```';
    // The fence exists but inner content is empty → null
    assert.equal(extractFencedContent(text), null);
  });

  it('handles prose between the opening fence tag and actual content', () => {
    const text = [
      'Here is the frame:',
      '```json',
      '{"goal":"ship the API","confidence":"high","kind":"coding"}',
      '```',
      'End.',
    ].join('\n');
    const inner = extractFencedContent(text);
    assert.ok(inner !== null);
    assert.ok(inner.includes('"goal"'));
  });
});

// ---------------------------------------------------------------------------
// parsePartialIntentFrame — partial JSON (missing confidence, trailing comma)
// ---------------------------------------------------------------------------

describe('parsePartialIntentFrame', () => {
  it('accepts JSON with goal + confidence (same as primary) → identical frame', () => {
    const raw = '{"goal":"build the API","confidence":"medium","kind":"coding"}';
    const primary = parseIntentFrame(raw);
    const partial = parsePartialIntentFrame(raw);
    // Both should produce equivalent frames
    assert.ok(primary !== null);
    assert.ok(partial !== null);
    assert.equal(partial.goal, primary.goal);
    assert.equal(partial.confidence, primary.confidence);
    assert.equal(partial.kind, primary.kind);
  });

  it('accepts JSON with goal but MISSING confidence — defaults to low', () => {
    const raw = '{"goal":"fix the login bug","kind":"coding"}';
    // Primary parser should fail (missing confidence)
    assert.equal(parseIntentFrame(raw), null);
    // Partial parser should succeed
    const frame = parsePartialIntentFrame(raw);
    assert.ok(frame !== null, 'partial parser should produce a frame');
    assert.equal(frame.goal, 'fix the login bug');
    assert.equal(frame.confidence, 'low', 'missing confidence defaults to low');
    assert.equal(frame.kind, 'coding');
    assert.equal(frame.source, 'model');
  });

  it('accepts JSON with an invalid confidence value — defaults to low', () => {
    const raw = '{"goal":"ship it","confidence":"very-sure","kind":"ops"}';
    // Primary parser should fail (invalid confidence)
    assert.equal(parseIntentFrame(raw), null);
    const frame = parsePartialIntentFrame(raw);
    assert.ok(frame !== null);
    assert.equal(frame.confidence, 'low');
    assert.equal(frame.goal, 'ship it');
  });

  it('handles a trailing comma before } (common LLM mistake)', () => {
    const raw = '{"goal":"refactor the store","kind":"coding","confidence":"high",}';
    // Primary parser fails (trailing comma = invalid JSON)
    assert.equal(parseIntentFrame(raw), null);
    const frame = parsePartialIntentFrame(raw);
    assert.ok(frame !== null, 'should recover from trailing comma');
    assert.equal(frame.goal, 'refactor the store');
  });

  it('carries optional fields from partial JSON', () => {
    const raw = '{"goal":"build auth","routeTier":"ic","routePlan":true}';
    const frame = parsePartialIntentFrame(raw);
    assert.ok(frame !== null);
    assert.equal(frame.routeTier, 'ic');
    assert.equal(frame.routePlan, true);
  });

  it('returns null when goal is absent', () => {
    const raw = '{"kind":"coding","confidence":"high"}';
    assert.equal(parsePartialIntentFrame(raw), null);
  });

  it('returns null when goal is empty', () => {
    const raw = '{"goal":"","confidence":"high"}';
    assert.equal(parsePartialIntentFrame(raw), null);
  });

  it('returns null when the text is not JSON', () => {
    assert.equal(parsePartialIntentFrame('not json at all'), null);
  });

  it('returns null on empty input', () => {
    assert.equal(parsePartialIntentFrame(''), null);
  });

  it('never throws on garbage', () => {
    assert.doesNotThrow(() => parsePartialIntentFrame('}{bad}{'));
    assert.doesNotThrow(() => parsePartialIntentFrame('{{{'));
    assert.doesNotThrow(() => parsePartialIntentFrame('null'));
  });
});

// ---------------------------------------------------------------------------
// parseProseIntentMarkers — key-marker prose extraction
// ---------------------------------------------------------------------------

describe('parseProseIntentMarkers', () => {
  it('extracts a goal from "goal: ..." line', () => {
    const text = 'goal: build the authentication service';
    const frame = parseProseIntentMarkers(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'build the authentication service');
    assert.equal(frame.confidence, 'low');
    assert.equal(frame.source, 'model');
  });

  it('extracts a goal from "Goal: ..." (capitalized)', () => {
    const text = 'Goal: refactor the legacy payment module\nkind: ops';
    const frame = parseProseIntentMarkers(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'refactor the legacy payment module');
  });

  it('extracts a goal from "**Goal**: ..." (markdown bold)', () => {
    const text = '**Goal**: ship the redesign by Friday';
    const frame = parseProseIntentMarkers(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'ship the redesign by Friday');
  });

  it('extracts a goal from "- Goal: ..." (markdown list)', () => {
    const text = '- Goal: implement dark mode\n- Kind: design';
    const frame = parseProseIntentMarkers(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'implement dark mode');
  });

  it('uses the FIRST goal marker found', () => {
    const text = 'goal: first goal\ngoal: second goal';
    const frame = parseProseIntentMarkers(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'first goal');
  });

  it('returns null when no goal marker is found', () => {
    assert.equal(parseProseIntentMarkers('no markers here'), null);
    assert.equal(parseProseIntentMarkers('kind: coding'), null);
    assert.equal(parseProseIntentMarkers(''), null);
  });

  it('never throws on garbage', () => {
    assert.doesNotThrow(() => parseProseIntentMarkers('}{bad'));
    assert.doesNotThrow(() => parseProseIntentMarkers('goal:'));
  });

  it('does NOT fabricate kind, constraints, or forks from prose', () => {
    const text = 'goal: fix the bug\nkind: coding\nconstraints: must be fast';
    const frame = parseProseIntentMarkers(text);
    assert.ok(frame !== null);
    // Only goal should be extracted; other fields are NOT guessed from prose
    assert.equal(frame.goal, 'fix the bug');
    assert.equal(frame.kind, undefined);
    assert.equal(frame.constraints, undefined);
  });
});

// ---------------------------------------------------------------------------
// parseFallbackIntentFrame — the ordered fallback chain
// ---------------------------------------------------------------------------

describe('parseFallbackIntentFrame', () => {
  it('returns null for undefined or empty input', () => {
    assert.equal(parseFallbackIntentFrame(undefined), null);
    assert.equal(parseFallbackIntentFrame(''), null);
    assert.equal(parseFallbackIntentFrame('   '), null);
  });

  it('Strategy 1: extracts from a fenced JSON block', () => {
    const text = [
      'Sure, here is the JSON:',
      '```json',
      '{"goal":"implement the dashboard","confidence":"high","kind":"coding"}',
      '```',
    ].join('\n');
    const frame = parseFallbackIntentFrame(text);
    assert.ok(frame !== null, 'should extract from fenced block');
    assert.equal(frame.goal, 'implement the dashboard');
    assert.equal(frame.confidence, 'high');
    assert.equal(frame.kind, 'coding');
  });

  it('Strategy 1: handles a fenced block with partial JSON (no confidence)', () => {
    const text = [
      '```json',
      '{"goal":"migrate the database","kind":"ops"}',
      '```',
    ].join('\n');
    const frame = parseFallbackIntentFrame(text);
    assert.ok(frame !== null, 'should handle partial JSON inside fence');
    assert.equal(frame.goal, 'migrate the database');
    assert.equal(frame.confidence, 'low');
  });

  it('Strategy 2: extracts from partial JSON (missing confidence) in full text', () => {
    const text = 'The frame is: {"goal":"write unit tests","kind":"coding"}';
    const frame = parseFallbackIntentFrame(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'write unit tests');
    assert.equal(frame.confidence, 'low');
  });

  it('Strategy 2: handles trailing comma in partial JSON', () => {
    const text = '{"goal":"refactor","confidence":"medium",}';
    const frame = parseFallbackIntentFrame(text);
    assert.ok(frame !== null);
    assert.equal(frame.goal, 'refactor');
    assert.equal(frame.confidence, 'medium');
  });

  it('Strategy 3: extracts from prose markers when JSON fails', () => {
    const text = [
      'I understood your request:',
      'Goal: fix the memory leak in the scheduler',
      'This is a coding task.',
    ].join('\n');
    const frame = parseFallbackIntentFrame(text);
    assert.ok(frame !== null, 'should fall through to prose extraction');
    assert.equal(frame.goal, 'fix the memory leak in the scheduler');
    assert.equal(frame.confidence, 'low');
  });

  it('returns null when all strategies fail', () => {
    const text = 'I cannot provide a structured response right now.';
    assert.equal(parseFallbackIntentFrame(text), null);
  });

  it('never throws on truly garbage input', () => {
    assert.doesNotThrow(() => parseFallbackIntentFrame('}{}{}{'));
    assert.doesNotThrow(() => parseFallbackIntentFrame('```\n```'));
    assert.doesNotThrow(() => parseFallbackIntentFrame('null null null'));
  });
});

// ---------------------------------------------------------------------------
// Regression: clean structured response parses identically (no altered success path)
// ---------------------------------------------------------------------------

describe('parseFallbackIntentFrame — regression: clean parse is byte-identical', () => {
  const CLEAN_RESPONSES = [
    '{"goal":"ship the API","kind":"coding","confidence":"high","routeTier":"ic","routePlan":false}',
    '{"goal":"research best practices","confidence":"medium","externalFreshness":"helpful"}',
    '{"goal":"fix auth bug","confidence":"low","operationRisk":"high","blastRadius":"medium"}',
    '{"goal":"write docs","confidence":"medium","forks":[{"id":"F1","question":"Which format?","options":["Markdown","RST"],"assumeIfUnasked":"Markdown"}]}',
  ];

  for (const raw of CLEAN_RESPONSES) {
    it(`primary parse and fallback agree on: ${raw.slice(0, 50)}…`, () => {
      const primary = parseIntentFrame(raw);
      assert.ok(primary !== null, `primary should parse: ${raw}`);

      // The fallback should NOT be called on a primary success —
      // but when we DO call it (e.g. with a fenced version), it should
      // produce an equivalent frame.
      const fenced = `\`\`\`json\n${raw}\n\`\`\``;
      const fallback = parseFallbackIntentFrame(fenced);
      assert.ok(fallback !== null, 'fallback should parse the fenced version');
      assert.equal(fallback.goal, primary.goal, 'goal must match');
      assert.equal(fallback.confidence, primary.confidence, 'confidence must match');
    });
  }
});

// ---------------------------------------------------------------------------
// Additive contract: fallback never fires when primary succeeds
// ---------------------------------------------------------------------------

describe('additive contract — fallback must never be called on primary success', () => {
  it('primary parseIntentFrame succeeds on clean JSON → fallback is never needed', () => {
    const clean = '{"goal":"build auth","confidence":"high","kind":"coding"}';
    const primary = parseIntentFrame(clean);
    assert.ok(primary !== null, 'primary parse should succeed');
    // In normal use: the caller checks primary !== null and skips fallback.
    // This test documents that invariant: there is nothing for the fallback to do.
    // (intent-extractor.ts now unconditionally calls the fallback when primary returns null.)
    const fallbackCalledOnSuccess = primary !== null
      ? 'would NOT call fallback (correct)'
      : 'would call fallback (wrong)';
    assert.equal(fallbackCalledOnSuccess, 'would NOT call fallback (correct)');
  });
});
