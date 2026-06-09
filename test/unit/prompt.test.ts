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
// INVESTIGATE BEFORE YOU INTERROGATE — investigate-first + cwd-mismatch guidance
// ---------------------------------------------------------------------------

describe('buildPrompt — investigate before you interrogate', () => {
  for (const tier of ['worker', 'ic', 'manager'] as const) {
    it(`${tier}: instructs the model to investigate the codebase before asking`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        result.includes('INVESTIGATE BEFORE YOU INTERROGATE'),
        `${tier} prompt should carry the investigate-before-interrogate header`,
      );
      assert.ok(
        /FIRST determine what you can yourself by investigating/i.test(result),
        `${tier} prompt should tell the model to investigate first`,
      );
      assert.ok(
        result.includes('discoverable in the code'),
        `${tier} prompt should forbid asking about things discoverable in the code`,
      );
      assert.ok(
        /After orienting, form a view/i.test(result),
        `${tier} prompt should require a concrete view after investigation`,
      );
      assert.ok(
        /recommend the concrete next step/i.test(result),
        `${tier} prompt should require a concrete next-step recommendation`,
      );
      assert.ok(
        /Do\s+not offer an open generic menu/i.test(result),
        `${tier} prompt should forbid open generic menus`,
      );
    });

    it(`${tier}: reserves questions for genuine non-investigable forks (vision/preference/external)`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        /vision, priorities, or preferences, or a real\s+decision external to the code/i.test(result),
        `${tier} prompt should reserve asks for vision/preference/external forks`,
      );
    });

    it(`${tier}: handles a referenced project NOT in the working directory (say so, ask where)`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        /NOT in the current\s+working directory/i.test(result),
        `${tier} prompt should address a project absent from the cwd`,
      );
      assert.ok(
        /SAY SO plainly and ask where\s+the\s+code is/i.test(result),
        `${tier} prompt should tell the model to say so and ask where the code is`,
      );
      assert.ok(
        /never ask abstract questions about a\s+codebase you cannot see/i.test(result),
        `${tier} prompt should forbid abstract questions about an unseen codebase`,
      );
    });

    it(`${tier}: requires ask_user options to be concrete and grounded`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        /Options must be concrete and\s+grounded in what you found/i.test(result),
        `${tier} prompt should require grounded ask_user options`,
      );
      assert.ok(
        /never broad task categories like fix\/add\/polish\/\s+integrate/i.test(result),
        `${tier} prompt should forbid broad task-category options`,
      );
    });
  }

  it('the investigate guidance sits ABOVE the ASKING THE USER block', () => {
    const result = buildPrompt('ic', 'task');
    const invIdx = result.indexOf('INVESTIGATE BEFORE YOU INTERROGATE');
    const askIdx = result.indexOf('ASKING THE USER');
    assert.ok(invIdx >= 0 && askIdx >= 0);
    assert.ok(invIdx < askIdx, 'investigate-first guidance precedes ASKING THE USER');
  });
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

    it(`${tier}: defaults to brutal-honesty candor without flattery`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('respectful brutal honesty'),
        `${tier} prompt should make candor part of the default persona`,
      );
      assert.ok(
        result.includes('no sycophancy or flattery'),
        `${tier} prompt should forbid sycophancy and flattery`,
      );
      assert.ok(
        result.includes("don't open\n  with praise"),
        `${tier} prompt should forbid opening with praise`,
      );
    });

    it(`${tier}: requires direct disagreement and plain risk naming`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('say so directly first'),
        `${tier} prompt should require direct disagreement before reasoning`,
      );
      assert.ok(
        result.includes('Name risks, tradeoffs, and downside cases plainly'),
        `${tier} prompt should require plain risk/tradeoff/downside naming`,
      );
      assert.ok(
        result.includes('do not soft-pedal hard\n  truths'),
        `${tier} prompt should forbid soft-pedaling hard truths`,
      );
    });

    it(`${tier}: requires honesty about uncertainty and grounded candor`, () => {
      const result = buildPrompt(tier, '');
      assert.ok(
        result.includes('Be explicit about uncertainty and limits'),
        `${tier} prompt should require explicit uncertainty/limits`,
      );
      assert.ok(result.includes('"I don\'t know"'), `${tier} prompt should include I don't know`);
      assert.ok(
        result.includes('"I can\'t verify\n  that here"'),
        `${tier} prompt should include I can't verify that here`,
      );
      assert.ok(result.includes('"this is a guess"'), `${tier} prompt should include this is a guess`);
      assert.ok(
        result.includes('ground candor in evidence rather than opinion-as-fact'),
        `${tier} prompt should ground candor in evidence`,
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

// ---------------------------------------------------------------------------
// Elite voice + adaptive-explanation ladder + think-past (review items 1-3)
// ---------------------------------------------------------------------------

describe('buildPrompt — elite VOICE preamble (review §5)', () => {
  for (const tier of TIERS) {
    it(`${tier}: carries the "partner a sharp builder wishes they had" voice`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        result.includes('partner a sharp builder wishes they had'),
        `${tier} prompt should carry the elite voice preamble`,
      );
      assert.ok(
        result.includes('makes the hard parts suddenly make sense'),
        `${tier} prompt should promise to make hard parts make sense`,
      );
      assert.ok(
        result.includes('NOW I get it'),
        `${tier} prompt should target the "oh — NOW I get it" feeling`,
      );
    });

    it(`${tier}: keeps brutal honesty as a facet, not flattery (elite ≠ sycophancy)`, () => {
      const result = buildPrompt(tier, 'task');
      // The preamble must explicitly disclaim flattery, AND the brutal-honesty
      // block must still be present (it is not replaced by the warmer voice).
      assert.ok(
        result.includes('never because you flatter'),
        `${tier} preamble should disclaim flattery`,
      );
      assert.ok(
        result.includes('no sycophancy or flattery'),
        `${tier} prompt must retain the brutal-honesty block alongside the elite voice`,
      );
    });

    it(`${tier}: the voice preamble sits ABOVE the brutal-honesty block`, () => {
      const result = buildPrompt(tier, 'task');
      const voiceIdx = result.indexOf('partner a sharp builder wishes they had');
      const honestyIdx = result.indexOf('respectful brutal honesty');
      assert.ok(voiceIdx >= 0 && honestyIdx >= 0);
      assert.ok(voiceIdx < honestyIdx, `${tier}: elite voice precedes brutal honesty`);
    });
  }
});

describe('buildPrompt — adaptive-explanation ladder (review §2, the #1 ask)', () => {
  for (const tier of TIERS) {
    it(`${tier}: carries the intuitive-first → technical ladder`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        result.includes('Explain on a ladder'),
        `${tier} prompt should carry the explanation ladder`,
      );
      assert.ok(
        /plain-language sentence a smart non-expert would get/i.test(result),
        `${tier} ladder should lead with an intuitive plain-language sentence`,
      );
      assert.ok(
        /THEN layer the precise technical detail/i.test(result),
        `${tier} ladder should layer technical detail for the engineer`,
      );
      assert.ok(
        /what depends on what and what breaks if it'?s skipped/i.test(result),
        `${tier} ladder should make the dependency/long-term picture land`,
      );
    });

    it(`${tier}: the ladder SELF-GATES (no padded ELI5 on trivial/quick-factual)`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        result.includes('SELF-GATE'),
        `${tier} ladder must be explicitly self-gating`,
      );
      assert.ok(
        /one-line question gets a one-line answer/i.test(result),
        `${tier} ladder must protect the fast path (one-line in → one-line out)`,
      );
      assert.ok(
        /never[\s\S]{0,40}padded ELI5 essay/i.test(result),
        `${tier} ladder must forbid a padded ELI5 essay`,
      );
    });

    it(`${tier}: plain-language is for the WHY, never condescension`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        /never talking\s*down/i.test(result),
        `${tier} ladder must forbid talking down`,
      );
      assert.ok(
        /match the user'?s own register, one notch up/i.test(result),
        `${tier} ladder must mirror the user's register one notch up`,
      );
    });
  }
});

describe('buildPrompt — think-past-the-question proactive directive (review §3)', () => {
  for (const tier of TIERS) {
    it(`${tier}: instructs anticipating the next problem from injected context`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        result.includes('Think past the question'),
        `${tier} prompt should carry the think-past-the-question directive`,
      );
      assert.ok(
        /memory, work-state, repo-map and\s+recap blocks/i.test(result),
        `${tier} directive should activate the already-injected context blocks`,
      );
      assert.ok(
        /second-order risk|cheap win|sinks the rest/i.test(result),
        `${tier} directive should surface the non-obvious`,
      );
    });

    it(`${tier}: the proactive directive self-gates (no brain dump, not on trivial)`, () => {
      const result = buildPrompt(tier, 'task');
      assert.ok(
        /never a brain dump, and never on a trivial\s+turn/i.test(result),
        `${tier} directive must cap anticipations and skip trivial turns`,
      );
    });
  }
});

describe('buildPrompt — explanatory depth is gated on substantial turns (fast-path proof)', () => {
  const DEPTH_MARKER = 'THIS TURN HAS REAL DEPTH';

  for (const tier of TIERS) {
    it(`${tier}: composes the expanded depth directive ONLY when explanatory:true`, () => {
      const deep = buildPrompt(tier, 'task', undefined, undefined, { explanatory: true });
      assert.ok(deep.includes(DEPTH_MARKER), `${tier}: substantial turn gets the depth directive`);
      assert.ok(
        /bolded\s+one-line takeaway/i.test(deep),
        `${tier}: depth directive demands a bolded plain-language takeaway`,
      );
      assert.ok(
        /never fabricate a fact, file, or\s+number/i.test(deep),
        `${tier}: depth directive forbids fabrication (honesty preserved)`,
      );
    });

    it(`${tier}: OMITS the expanded depth directive on a trivial turn (no explanatory flag)`, () => {
      const trivial = buildPrompt(tier, 'what time is it');
      assert.ok(
        !trivial.includes(DEPTH_MARKER),
        `${tier}: a trivial turn must NOT carry the expanded depth directive`,
      );
    });

    it(`${tier}: explanatory:false is byte-identical to omitting the flag`, () => {
      const off = buildPrompt(tier, 'task', undefined, undefined, { explanatory: false });
      const none = buildPrompt(tier, 'task');
      assert.equal(off, none, `${tier}: explanatory:false must not change the prompt`);
    });
  }

  it('the depth directive places the takeaway demand after the persona, before Task', () => {
    const result = buildPrompt('ic', 'plan the migration', undefined, undefined, {
      explanatory: true,
    });
    const personaIdx = result.indexOf('individual-contributor');
    const depthIdx = result.indexOf(DEPTH_MARKER);
    const taskIdx = result.indexOf('Task:');
    assert.ok(personaIdx < depthIdx, 'depth directive after persona');
    assert.ok(depthIdx < taskIdx, 'depth directive before Task');
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — the memory capture instruction (remember_user)
// ---------------------------------------------------------------------------

describe('buildPrompt — memory capture instruction (Phase 5)', () => {
  for (const tier of ['worker', 'ic', 'manager'] as const) {
    it(`${tier}: includes the remember_user capture instruction`, () => {
      const result = buildPrompt(tier, 'do the task');
      assert.ok(result.includes('remember_user'), `${tier} prompt should mention remember_user`);
      assert.ok(
        /durable[\s\S]*non-secret|non-secret[\s\S]*durable/i.test(result),
        `${tier} prompt should scope memory to durable non-secret facts`,
      );
      assert.ok(
        /never[\s\S]*alongside ask_user/i.test(result),
        `${tier} prompt should forbid proposing memory alongside ask_user`,
      );
      assert.ok(
        /routine turns/i.test(result),
        `${tier} prompt should forbid proposing memory on routine turns`,
      );
    });
  }

  it('goal turns DROP the capture instruction (no proposals during autonomous runs)', () => {
    const result = buildPrompt('ic', 'keep building', undefined, undefined, { goalTurn: true });
    assert.ok(!result.includes('remember_user'), 'goal turns must not carry the capture instruction');
    assert.ok(!result.includes('"confidence"'), 'goal turns suppress the confidence tail too');
  });
});
