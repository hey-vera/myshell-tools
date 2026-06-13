import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderDecisionPrompt,
  type DecisionPrompt,
  type DecisionPromptOption,
} from '../../src/interface/decision-prompt.ts';

const ANSI_RE = /\x1b\[[\d;]*[A-Za-z]/;

describe('renderDecisionPrompt', () => {
  it('renders a timeout prompt with the default option and trailing newline', () => {
    const options: readonly DecisionPromptOption[] = [
      { id: 'yes', label: 'Yes', description: 'keep going', recommended: true },
      { id: 'no', label: 'No', description: 'stop here' },
    ];
    const out = renderDecisionPrompt(
      {
        kind: 'timeout',
        title: 'Continue working step by step until it\'s done?',
        message: 'This step ran long; I can continue from here in smaller steps.',
        options,
        defaultOptionId: 'yes',
      },
      false,
    );

    assert.match(out, /^\? Timeout: Continue working step by step until it's done\?\n/m);
    assert.match(out, /1\. Yes \(recommended, Enter\)/);
    assert.match(out, /2\. No/);
    assert.match(out, /Enter = 1 · y = yes · n = no · Ctrl\+C = cancel/);
    assert.ok(out.endsWith('\n'));
  });

  it('renders a keep-going prompt with a pronounced title', () => {
    const out = renderDecisionPrompt(
      {
        kind: 'keep-going',
        title: 'Keep going?',
        message: 'I can keep working on this autonomously until it\'s done.',
        options: [
          { id: 'yes', label: 'Yes', recommended: true },
          { id: 'no', label: 'No' },
        ],
        defaultOptionId: 'yes',
      },
      false,
    );

    assert.match(out, /^\? Keep Going: Keep going\?\n/m);
    assert.match(out, /I can keep working on this autonomously until it's done\./);
  });

  it('renders a checkpoint prompt', () => {
    const out = renderDecisionPrompt(
      {
        kind: 'checkpoint',
        title: 'Approve this change and continue?',
        options: [
          { id: 'approve', label: 'Approve & continue' },
          { id: 'stop', label: 'Stop here' },
        ],
      },
      false,
    );

    assert.match(out, /^! Checkpoint: Approve this change and continue\?\n/m);
  });

  it('renders multi-select prompts with the correct hint', () => {
    const out = renderDecisionPrompt(
      {
        kind: 'question',
        title: 'Which stacks should I test?',
        options: [
          { id: '1', label: 'Node' },
          { id: '2', label: 'Python' },
          { id: '3', label: 'Rust' },
        ],
        multiSelect: true,
      },
      false,
    );

    assert.match(out, /Type one or more numbers \(comma-separated\) · Enter = skip · Ctrl\+C = cancel/);
  });

  it('renders free-text prompts with the correct hint', () => {
    const out = renderDecisionPrompt(
      {
        kind: 'question',
        title: 'Which database?',
        options: [
          { id: '1', label: 'Postgres' },
          { id: '2', label: 'SQLite' },
          { id: '3', label: 'Type your own' },
        ],
        allowFreeText: true,
      },
      false,
    );

    assert.match(out, /Type a number or your own answer · Enter = skip · Ctrl\+C = cancel/);
  });

  it('renders generic default hints for numbered prompts', () => {
    const prompt: DecisionPrompt = {
      kind: 'question',
      title: 'Pick one',
      options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
      defaultOptionId: 'b',
    };
    const out = renderDecisionPrompt(prompt, false);

    assert.match(out, /2\. Beta \(Enter\)/);
    assert.match(out, /Type a number · Enter = 2 · Ctrl\+C = cancel/);
  });

  it('emits no ANSI escape codes when color is false', () => {
    const out = renderDecisionPrompt(
      {
        kind: 'question',
        title: 'Pick one',
        options: [
          { id: '1', label: 'One', recommended: true },
          { id: '2', label: 'Two' },
        ],
        defaultOptionId: '1',
      },
      false,
    );

    assert.doesNotMatch(out, ANSI_RE);
  });
});
