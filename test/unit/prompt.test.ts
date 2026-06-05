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

// ---------------------------------------------------------------------------
// MF1 seam — buildPrompt composes context blocks after system, before history
// ---------------------------------------------------------------------------

describe('buildPrompt — context blocks (MF1 seam)', () => {
  it('injects a partner-posture nudge between system and Task when partnerStyle is set', () => {
    const result = buildPrompt('ic', 'do something', undefined, undefined, {
      partnerStyle: 'direct',
    });
    assert.ok(result.includes('PARTNER POSTURE'), 'should carry the partner nudge');
    const systemIdx = result.indexOf('individual-contributor');
    const nudgeIdx = result.indexOf('PARTNER POSTURE');
    const taskIdx = result.indexOf('Task:');
    assert.ok(systemIdx < nudgeIdx, 'nudge after system');
    assert.ok(nudgeIdx < taskIdx, 'nudge before task');
  });

  it('places context blocks AFTER system and BEFORE CONVERSATION SO FAR', () => {
    const result = buildPrompt('ic', 'do something', undefined, 'User: hi', {
      memoryContext: 'USER PREFERENCES AND MEMORY:\n- prefers concise answers',
    });
    const systemIdx = result.indexOf('individual-contributor');
    const memIdx = result.indexOf('USER PREFERENCES AND MEMORY');
    const historyIdx = result.indexOf('CONVERSATION SO FAR');
    assert.ok(systemIdx < memIdx, 'memory after system');
    assert.ok(memIdx < historyIdx, 'memory before history');
  });

  it('is byte-identical to the no-opts prompt when opts carry no context (balanced nudge is empty)', () => {
    const base = buildPrompt('ic', 'do something');
    const balanced = buildPrompt('ic', 'do something', undefined, undefined, {
      partnerStyle: 'balanced',
    });
    assert.equal(balanced, base);
    assert.ok(!balanced.includes('PARTNER POSTURE'));
  });

  it('renders all blocks in canonical order MEMORY → INTENT → ENGAGEMENT → nudge', () => {
    const result = buildPrompt('ic', 'do something', undefined, undefined, {
      memoryContext: 'MEMBLOCK',
      intentFrame: 'INTENTBLOCK',
      engagementPlan: 'ENGBLOCK',
      partnerStyle: 'collaborative',
    });
    assert.ok(result.indexOf('MEMBLOCK') < result.indexOf('INTENTBLOCK'));
    assert.ok(result.indexOf('INTENTBLOCK') < result.indexOf('ENGBLOCK'));
    assert.ok(result.indexOf('ENGBLOCK') < result.indexOf('PARTNER POSTURE'));
  });
});

// ---------------------------------------------------------------------------
// ASKING THE USER — genuine-fork rewrite
// ---------------------------------------------------------------------------

describe('buildPrompt — ask_user uses the genuine-fork framing', () => {
  for (const tier of ['worker', 'ic', 'manager'] as const) {
    it(`${tier}: instructs ask_user at genuine decision forks (not only when blocked)`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(result.includes('genuine decision forks'), 'should use genuine-fork phrasing');
      assert.ok(
        !result.includes('Only when you genuinely cannot proceed'),
        'should drop the timid "only when blocked" framing',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Envelope instruction integrity (must remain exact + last)
// ---------------------------------------------------------------------------

// The exact key list, in order, that the assess() parser depends on.
const ENVELOPE_LINE =
  '{"confidence": <0.0-1.0>, "escalate": <true|false>, "reason": "<one sentence>", "needs_review": <true|false>}';

const TIERS = ['worker', 'ic', 'manager'] as const;

describe('buildPrompt — confidence envelope instruction is preserved exactly', () => {
  for (const tier of TIERS) {
    it(`${tier}: contains the exact envelope JSON object with keys in order`, () => {
      // Build without a task suffix interfering: the envelope appears in the
      // system block, which is followed only by the Task section.
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes(ENVELOPE_LINE),
        `${tier} prompt must contain the exact envelope line with confidence/escalate/reason/needs_review in order`,
      );
    });

    it(`${tier}: retains the "append ... on its own line ... no trailing text" instruction`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('append EXACTLY the following JSON object on'),
        `${tier} prompt must keep the "append EXACTLY ... JSON object" instruction`,
      );
      assert.ok(
        result.includes('no trailing text after it'),
        `${tier} prompt must keep the "no trailing text after it" instruction`,
      );
    });

    it(`${tier}: persona/research text appears ABOVE the envelope instruction`, () => {
      const result = buildPrompt(tier, '');
      const personaIdx = result.indexOf('senior engineering partner');
      const researchIdx = result.indexOf('Research with good senior judgment');
      const appendIdx = result.indexOf('append EXACTLY the following JSON object');
      assert.ok(personaIdx >= 0 && personaIdx < appendIdx, `${tier}: persona must precede envelope`);
      assert.ok(researchIdx >= 0 && researchIdx < appendIdx, `${tier}: research must precede envelope`);
    });

    it(`${tier}: envelope line is the last meaningful line of the system block`, () => {
      // The system block ends right before the Task separator. Within that
      // block, the envelope line must be the final templated JSON line and
      // nothing must follow it on its own line except the trailing guidance
      // about how to set the fields (which is not "trailing text after" the
      // appended envelope at runtime — it is instruction to the model).
      // Concretely: nothing in the system block comes after the envelope JSON
      // except the field-setting guidance, and the envelope JSON must appear
      // before the "---" task separator.
      const result = buildPrompt(tier, 'SOME_TASK_SENTINEL');
      const envelopeIdx = result.indexOf(ENVELOPE_LINE);
      const separatorIdx = result.indexOf('\n\n---\n\nTask:');
      assert.ok(envelopeIdx >= 0, `${tier}: envelope present`);
      assert.ok(separatorIdx > envelopeIdx, `${tier}: envelope appears within the system block, before Task`);
    });
  }
});

describe('buildPrompt — goal turn prompt mode', () => {
  it('suppresses the confidence-envelope requirement for goal turns', () => {
    const result = buildPrompt('ic', 'Goal: ship it\nGOAL_CONTINUE: next', undefined, undefined, {
      goalTurn: true,
    });

    assert.ok(!result.includes(ENVELOPE_LINE));
    assert.ok(!result.includes('append EXACTLY the following JSON object'));
    assert.match(result, /Do not emit the confidence JSON\s+envelope on goal turns/);
    assert.ok(result.includes('GOAL_COMPLETE/GOAL_CONTINUE'));
  });
});

// ---------------------------------------------------------------------------
// Partner persona / tone
// ---------------------------------------------------------------------------

describe('buildPrompt — partner persona and warmth-not-length', () => {
  for (const tier of TIERS) {
    it(`${tier}: frames the model as a senior engineering partner`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('senior engineering partner'),
        `${tier} prompt should describe a senior engineering partner persona`,
      );
    });

    it(`${tier}: includes "partner, not a robot" tone guidance`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('partner, not a robot'),
        `${tier} prompt should include partner-not-a-robot tone language`,
      );
    });

    it(`${tier}: includes "Warmth is not length" guidance`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('Warmth is not length'),
        `${tier} prompt should state that warmth is not length`,
      );
      assert.ok(
        result.includes('never pad'),
        `${tier} prompt should still instruct never to pad`,
      );
    });

    it(`${tier}: includes brief-clarifying-question guidance`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('clarifying question'),
        `${tier} prompt should tell the model to ask a brief clarifying question when ambiguous`,
      );
    });
  }

  it('worker: the old robotic line is gone', () => {
    const result = buildPrompt('worker', '');
    assert.ok(
      !result.includes('Do not pad responses with unnecessary explanation'),
      'The old robotic worker line must be removed',
    );
    assert.ok(
      !result.includes('precise, efficient worker-tier assistant'),
      'The old robotic worker self-description must be removed',
    );
  });
});

// ---------------------------------------------------------------------------
// Proactive, judicious research judgment
// ---------------------------------------------------------------------------

describe('buildPrompt — proactive research judgment', () => {
  for (const tier of TIERS) {
    it(`${tier}: instructs proactive research grounded in good senior judgment`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('Research with good senior judgment'),
        `${tier} prompt should frame research as good senior judgment`,
      );
      assert.ok(
        result.includes('proactively use the available'),
        `${tier} prompt should tell the model to proactively use web research/tools`,
      );
      assert.ok(
        result.includes("current best practice"),
        `${tier} prompt should cite verifiable/time-sensitive triggers like current best practice`,
      );
      assert.ok(
        result.includes('briefly note what you checked'),
        `${tier} prompt should tell the model to say what it checked`,
      );
    });

    it(`${tier}: warns against over-researching the obvious / in-context facts`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('do NOT research the obvious or anything already in context'),
        `${tier} prompt should warn against over-researching`,
      );
      assert.ok(
        result.includes('over-researching wastes time and tokens'),
        `${tier} prompt should note over-researching wastes time and tokens`,
      );
      assert.ok(
        result.includes('Research only when it materially'),
        `${tier} prompt should scope research to when it materially improves correctness`,
      );
    });

    it(`${tier}: tells the model the user should never have to ask it to look things up`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('should never have to tell'),
        `${tier} prompt should state the user should never have to tell it to look something up`,
      );
    });
  }
});
