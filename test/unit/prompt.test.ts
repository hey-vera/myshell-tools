/**
 * Unit tests for src/core/prompt.ts
 * Run with: node --experimental-strip-types --test test/unit/prompt.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../../src/core/prompt.ts';

// ---------------------------------------------------------------------------
// Basic tier prompt building
// ---------------------------------------------------------------------------

describe('buildPrompt — basic tier prompts', () => {
  it('includes worker system prompt for worker tier', () => {
    const result = buildPrompt('worker', 'list files');
    assert.ok(result.includes('worker-tier'), 'Should include worker-tier in system prompt');
    assert.ok(result.includes('Task:'), 'Should include Task: section');
    assert.ok(result.includes('list files'), 'Should include the task');
  });

  it('includes ic system prompt for ic tier', () => {
    const result = buildPrompt('ic', 'refactor the auth module');
    assert.ok(result.includes('individual-contributor'), 'Should include IC role description');
    assert.ok(result.includes('refactor the auth module'), 'Should include the task');
  });

  it('includes manager system prompt for manager tier', () => {
    const result = buildPrompt('manager', 'review the design');
    assert.ok(result.includes('senior-manager'), 'Should include manager role description');
    assert.ok(result.includes('review the design'), 'Should include the task');
  });

  it('places system prompt before the task section', () => {
    const result = buildPrompt('ic', 'do something');
    const taskIdx = result.indexOf('Task:');
    const systemIdx = result.indexOf('individual-contributor');
    assert.ok(systemIdx < taskIdx, 'System prompt should appear before Task:');
  });

  it('includes --- separator between system and task', () => {
    const result = buildPrompt('ic', 'some task');
    assert.ok(result.includes('---'), 'Should include --- separator');
  });
});

// ---------------------------------------------------------------------------
// managerNotes parameter
// ---------------------------------------------------------------------------

describe('buildPrompt — managerNotes', () => {
  it('includes REVIEWER FEEDBACK section when managerNotes is provided', () => {
    const result = buildPrompt('ic', 'fix the bug', 'The validation is missing.');
    assert.ok(result.includes('REVIEWER FEEDBACK:'), 'Should include REVIEWER FEEDBACK header');
    assert.ok(result.includes('The validation is missing.'), 'Should include the notes');
  });

  it('does NOT include REVIEWER FEEDBACK when managerNotes is undefined', () => {
    const result = buildPrompt('ic', 'fix the bug');
    assert.ok(!result.includes('REVIEWER FEEDBACK:'), 'Should not include REVIEWER FEEDBACK');
  });

  it('does NOT include REVIEWER FEEDBACK when managerNotes is empty string', () => {
    const result = buildPrompt('ic', 'fix the bug', '');
    assert.ok(!result.includes('REVIEWER FEEDBACK:'), 'Should not include REVIEWER FEEDBACK for empty string');
  });

  it('does NOT include REVIEWER FEEDBACK when managerNotes is whitespace only', () => {
    const result = buildPrompt('ic', 'fix the bug', '   ');
    assert.ok(!result.includes('REVIEWER FEEDBACK:'), 'Should not include REVIEWER FEEDBACK for whitespace');
  });

  it('places REVIEWER FEEDBACK after the Task section', () => {
    const result = buildPrompt('ic', 'fix the bug', 'Add validation.');
    const taskIdx = result.indexOf('Task:');
    const feedbackIdx = result.indexOf('REVIEWER FEEDBACK:');
    assert.ok(feedbackIdx > taskIdx, 'REVIEWER FEEDBACK must appear after Task:');
  });
});

// ---------------------------------------------------------------------------
// historyContext parameter
// ---------------------------------------------------------------------------

describe('buildPrompt — historyContext', () => {
  it('includes CONVERSATION SO FAR section when historyContext is provided', () => {
    const history = 'User: what is X\n\nAssistant: X is a module.';
    const result = buildPrompt('ic', 'do something', undefined, history);
    assert.ok(
      result.includes('CONVERSATION SO FAR'),
      'Should include CONVERSATION SO FAR header',
    );
    assert.ok(result.includes('what is X'), 'Should include prior user message');
    assert.ok(result.includes('X is a module.'), 'Should include prior assistant message');
  });

  it('does NOT include CONVERSATION SO FAR when historyContext is undefined', () => {
    const result = buildPrompt('ic', 'do something');
    assert.ok(
      !result.includes('CONVERSATION SO FAR'),
      'Should not include CONVERSATION SO FAR when history absent',
    );
  });

  it('does NOT include CONVERSATION SO FAR when historyContext is empty string', () => {
    const result = buildPrompt('ic', 'do something', undefined, '');
    assert.ok(
      !result.includes('CONVERSATION SO FAR'),
      'Should not include CONVERSATION SO FAR for empty historyContext',
    );
  });

  it('does NOT include CONVERSATION SO FAR when historyContext is whitespace only', () => {
    const result = buildPrompt('ic', 'do something', undefined, '   ');
    assert.ok(
      !result.includes('CONVERSATION SO FAR'),
      'Should not include CONVERSATION SO FAR for whitespace historyContext',
    );
  });

  it('places CONVERSATION SO FAR before the Task section', () => {
    const history = 'User: prior question\n\nAssistant: prior answer';
    const result = buildPrompt('ic', 'new task', undefined, history);
    const historyIdx = result.indexOf('CONVERSATION SO FAR');
    const taskIdx = result.indexOf('Task:');
    assert.ok(historyIdx < taskIdx, 'CONVERSATION SO FAR must appear before Task:');
  });

  it('places CONVERSATION SO FAR after the system prompt', () => {
    const history = 'User: prior question';
    const result = buildPrompt('ic', 'new task', undefined, history);
    const systemIdx = result.indexOf('individual-contributor');
    const historyIdx = result.indexOf('CONVERSATION SO FAR');
    assert.ok(systemIdx < historyIdx, 'System prompt must appear before CONVERSATION SO FAR');
  });

  it('includes the context hint (do not repeat it back)', () => {
    const history = 'User: hello';
    const result = buildPrompt('ic', 'new task', undefined, history);
    assert.ok(
      result.includes('do not repeat it back'),
      'Should include the "do not repeat it back" hint',
    );
  });

  it('works with all three parameters simultaneously', () => {
    const history = 'User: prior question\n\nAssistant: prior answer';
    const notes = 'Fix the edge case at line 42.';
    const result = buildPrompt('ic', 'do the task', notes, history);

    assert.ok(result.includes('CONVERSATION SO FAR'), 'Should include history section');
    assert.ok(result.includes('REVIEWER FEEDBACK:'), 'Should include reviewer feedback');
    assert.ok(result.includes('do the task'), 'Should include the task');
    assert.ok(result.includes('prior question'), 'Should include prior history');
    assert.ok(result.includes('Fix the edge case'), 'Should include manager notes');

    // Order: system → history → task → reviewer feedback
    const systemIdx = result.indexOf('individual-contributor');
    const historyIdx = result.indexOf('CONVERSATION SO FAR');
    const taskIdx = result.indexOf('Task:');
    const feedbackIdx = result.indexOf('REVIEWER FEEDBACK:');

    assert.ok(systemIdx < historyIdx, 'system before history');
    assert.ok(historyIdx < taskIdx, 'history before task');
    assert.ok(taskIdx < feedbackIdx, 'task before reviewer feedback');
  });

  it('works for worker tier with historyContext', () => {
    const result = buildPrompt('worker', 'list files', undefined, 'User: what folder?');
    assert.ok(result.includes('CONVERSATION SO FAR'), 'Worker tier should include history');
    assert.ok(result.includes('what folder?'), 'Should include prior context');
  });

  it('works for manager tier with historyContext', () => {
    const result = buildPrompt('manager', 'review changes', undefined, 'User: check auth');
    assert.ok(result.includes('CONVERSATION SO FAR'), 'Manager tier should include history');
    assert.ok(result.includes('check auth'), 'Should include prior context');
  });
});
