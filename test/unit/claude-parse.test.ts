/**
 * Unit tests for src/providers/claude-parse.ts parser robustness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeLine } from '../../src/providers/claude-parse.ts';

describe('parseClaudeLine — malformed assistant events', () => {
  const malformedAssistantLines = [
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ type: 'assistant', message: null }),
    JSON.stringify({ type: 'assistant', message: 'not an object' }),
    JSON.stringify({ type: 'assistant', message: { content: null } }),
    JSON.stringify({ type: 'assistant', message: { content: 'not an array' } }),
    JSON.stringify({ type: 'assistant', message: { content: [null, 'bad', 42] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }),
  ];

  for (const line of malformedAssistantLines) {
    it(`returns [] without throwing for ${line}`, () => {
      assert.doesNotThrow(() => parseClaudeLine(line));
      assert.deepEqual(parseClaudeLine(line), []);
    });
  }
});
