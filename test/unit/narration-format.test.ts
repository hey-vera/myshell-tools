import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { VerboseNarrationFormatter } from '../../src/interface/narration-format.ts';

describe('VerboseNarrationFormatter', () => {
  it('groups fragmented reasoning under one label and flushes the tail', () => {
    const f = new VerboseNarrationFormatter();
    assert.deepEqual(
      f.beginTier({ tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 2 }),
      ['Activity: ic (claude/sonnet) attempt 2'],
    );
    assert.deepEqual(f.pushReasoning('First half'), []);
    assert.deepEqual(
      f.pushReasoning(' and done\nSecond line'),
      ['Reasoning:', '  - First half and done'],
    );
    assert.deepEqual(f.flush(), ['  - Second line']);
  });

  it('dedupes only adjacent normalized reasoning lines', () => {
    const f = new VerboseNarrationFormatter();
    assert.deepEqual(
      f.pushReasoning(' same thought \n'),
      ['Reasoning:', '  - same thought'],
    );
    assert.deepEqual(f.pushReasoning('same   thought\n'), []);
    assert.deepEqual(f.pushReasoning('different\nsame thought\n'), ['  - different', '  - same thought']);
  });

  it('collapses matching tool start/end noise and preserves detail', () => {
    const f = new VerboseNarrationFormatter();
    assert.deepEqual(
      f.pushTool({ name: 'read_file', phase: 'start', detail: 'src/x.ts' }),
      ['Tools:', '  - read_file src/x.ts'],
    );
    assert.deepEqual(f.pushTool({ name: 'read_file', phase: 'end', detail: 'src/x.ts' }), []);
    assert.deepEqual(f.pushTool({ name: 'bash', phase: 'end', detail: 'npm test' }), ['  - bash npm test (end)']);
  });

  it('resets dedupe and grouping state at endTier', () => {
    const f = new VerboseNarrationFormatter();
    assert.deepEqual(f.pushReasoning('repeat\n'), ['Reasoning:', '  - repeat']);
    assert.deepEqual(
      f.endTier({ success: true, confidence: 0.9, inputTokens: 10, outputTokens: 5, durationMs: 20 }),
      ['✓ tier done — confidence: 90%, 15 tokens, duration: 20ms'],
    );
    assert.deepEqual(
      f.pushReasoning('repeat\n'),
      ['Reasoning:', '  - repeat'],
    );
  });
});
