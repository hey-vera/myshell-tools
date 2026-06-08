/**
 * test/unit/ui-reduce.test.ts — exhaustive characterization of the PURE MVU
 * reducer (src/interface/ui/reduce.ts) and the CoreEvent→Action mapper
 * (src/interface/ui/core-event.ts), STEP 3a of the Ink migration.
 *
 * This is the source-of-truth correctness story for the new UI: every CoreEvent
 * type / verbosity branch is asserted to produce the SAME visible committed-line
 * text and live-state changes as render.ts's `renderStream`. 3b proves parity
 * against the legacy renderer; this proves the reducer is faithful.
 *
 * PURE: no Ink, no JSX, no I/O — runs under the regular `npm test` strip-types.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Import through the pure barrel (src/interface/ui/index.ts) — the same stable
// entry point 3b's rendering wiring will consume — so this test also exercises
// that the barrel re-exports the full reducer surface.
import {
  reduce,
  coreEventToActions,
  isDebugEnv,
  initialState,
  initialStreamView,
  type Action,
  type AgentRunState,
  type AgentView,
  type GoalView,
  type StreamPhase,
  type StreamView,
  type TokenView,
  type TranscriptLine,
  type UiState,
  type Verbosity,
} from '../../src/interface/ui/index.ts';
import type { CoreEvent } from '../../src/core/types.ts';

// Touch every re-exported type so the barrel's full surface is type-checked here
// (the value re-exports are exercised by the suites below).
type _SurfaceCheck = [
  Action,
  AgentRunState,
  AgentView,
  GoalView,
  StreamPhase,
  StreamView,
  TokenView,
  TranscriptLine,
  UiState,
  Verbosity,
  typeof initialStreamView,
];

/** Fold a sequence of actions over the initial (or given) state. */
function run(actions: readonly Action[], from: UiState = initialState): UiState {
  return actions.reduce(reduce, from);
}

/** The committed transcript as an array of plain text lines. */
function lines(s: UiState): string[] {
  return s.committed.map((l) => l.text);
}

describe('ui reduce — prose accumulation + tier flush', () => {
  it('appends cleaned prose to the buffer (no commit until flush)', () => {
    const s = run([
      { type: 'stream/prose', text: 'Hello ' },
      { type: 'stream/prose', text: 'world.' },
    ]);
    assert.equal(s.stream.buffer, 'Hello world.');
    assert.equal(s.committed.length, 0);
    assert.equal(s.stream.phase, 'streaming');
    assert.equal(s.stream.proseStarted, true);
    assert.equal(s.stream.streamedChars, 'Hello world.'.length);
  });

  it('flush-tier commits the buffered prose and accounts tokens', () => {
    const s = run([
      { type: 'stream/prose', text: 'Answer.' },
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        panelCandidate: false,
        verbosity: 'normal',
      },
    ]);
    assert.deepEqual(lines(s), ['Answer.']);
    assert.equal(s.committed[0]?.kind, 'prose');
    assert.equal(s.stream.buffer, '');
    assert.deepEqual(s.tokens, { turn: 150, session: 150 });
  });

  it('flush-tier with no prose commits nothing but still accounts tokens', () => {
    const s = run([
      {
        type: 'stream/flush-tier',
        tier: 'worker',
        success: false,
        confidence: null,
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 50,
        panelCandidate: false,
        verbosity: 'normal',
      },
    ]);
    assert.equal(s.committed.length, 0);
    assert.equal(s.tokens.turn, 15);
  });

  it('a tier boundary mid-answer sets breakBeforeNextProse so next prose starts fresh', () => {
    const afterFirstTier = run([
      { type: 'stream/prose', text: 'first' },
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.4,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        panelCandidate: false,
        verbosity: 'normal',
      },
    ]);
    assert.equal(afterFirstTier.stream.breakBeforeNextProse, true);
    // Next tier's first prose delta is prefixed with a newline.
    const next = reduce(afterFirstTier, { type: 'stream/prose', text: 'second' });
    assert.equal(next.stream.buffer, '\nsecond');
  });

  it('NEVER inserts a newline before the very first prose delta', () => {
    // toolSinceProse/breakBeforeNextProse only fire when proseStarted is true.
    const s = run([
      { type: 'stream/tool', name: 'ls', phase: 'start', verbosity: 'normal' },
      { type: 'stream/prose', text: 'hi' },
    ]);
    assert.equal(s.stream.buffer, 'hi');
  });

  it('a tool between prose segments forces the next prose onto a fresh line', () => {
    const s = run([
      { type: 'stream/prose', text: 'before' },
      { type: 'stream/tool', name: 'read', phase: 'start', verbosity: 'normal' },
      { type: 'stream/prose', text: 'after' },
    ]);
    assert.equal(s.stream.buffer, 'before\nafter');
    assert.equal(s.stream.stepCount, 1);
  });
});

describe('ui reduce — phase / panel / synthesis', () => {
  it('phase panel seeds panelists as running and enters panel phase', () => {
    const s = reduce(initialState, {
      type: 'phase/panel',
      participants: ['claude', 'codex'],
    });
    assert.equal(s.stream.phase, 'panel');
    assert.equal(s.stream.panelists.length, 2);
    assert.deepEqual(
      s.stream.panelists.map((p) => [p.provider, p.state]),
      [
        ['claude', 'running'],
        ['codex', 'running'],
      ],
    );
    assert.equal(s.stream.synthesizing, null);
    assert.equal(s.turnActive, true);
  });

  it('a panel candidate tier-done flips the first running panelist and accounts tokens, no prose commit', () => {
    const s = run([
      { type: 'phase/panel', participants: ['claude', 'codex'] },
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.8,
        inputTokens: 40,
        outputTokens: 10,
        durationMs: 900,
        panelCandidate: true,
        verbosity: 'normal',
      },
    ]);
    assert.equal(s.committed.length, 0); // candidate prose is never streamed/committed
    assert.deepEqual(
      s.stream.panelists.map((p) => p.state),
      ['done', 'running'],
    );
    assert.equal(s.tokens.turn, 50);
  });

  it('phase synthesis sets synthesizing count', () => {
    const s = run([
      { type: 'phase/panel', participants: ['claude', 'codex'] },
      { type: 'phase/synthesis', count: 2 },
    ]);
    assert.deepEqual(s.stream.synthesizing, { count: 2 });
    assert.equal(s.stream.phase, 'synthesis');
  });

  it('tier-start during panel mode appends an unregistered candidate as running', () => {
    const s = run([
      { type: 'phase/panel', participants: ['claude'] },
      { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt', attempt: 1, verbosity: 'normal' },
    ]);
    assert.deepEqual(
      s.stream.panelists.map((p) => p.provider),
      ['claude', 'codex'],
    );
    // Still in panel phase (the collapsed status line), not 'thinking'.
    assert.equal(s.stream.phase, 'panel');
    // H2: in panel mode the candidate is represented ONLY as a panelist — NO
    // per-candidate goal card is created (else N-1 cards would sit stuck running).
    assert.equal(s.goals.length, 0);
  });
});

describe('ui reduce — H2: panel turns leave no goal stuck running', () => {
  /** A panel candidate tier-done (flips a panelist, accounts tokens, no goal). */
  function candidateDone(tokens: number): Action {
    return {
      type: 'stream/flush-tier',
      tier: 'ic',
      success: true,
      confidence: 0.8,
      inputTokens: tokens,
      outputTokens: 0,
      durationMs: 10,
      panelCandidate: true,
      verbosity: 'normal',
    };
  }

  it('a 3-candidate panel turn ends with ZERO goals/agents running and tokens attributed', () => {
    // Drive panel → 3×tier-start → 3×candidate-done → synthesis, then snapshot the
    // LIVE panel state BEFORE final (final clears the live stream by design).
    const beforeFinal = run([
      { type: 'phase/panel', participants: ['claude', 'codex', 'opencode'] },
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'a', attempt: 1, verbosity: 'normal' },
      { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'b', attempt: 1, verbosity: 'normal' },
      { type: 'tier-start', tier: 'ic', provider: 'opencode', model: 'c', attempt: 1, verbosity: 'normal' },
      candidateDone(10),
      candidateDone(20),
      candidateDone(30),
      { type: 'phase/synthesis', count: 3 },
      { type: 'stream/prose', text: 'Synthesized answer.' },
    ]);
    // NO goal cards were ever created for the panel candidates (the H2 fix).
    assert.equal(beforeFinal.goals.length, 0);
    // All three candidates settled as done panelists (no panelist left running).
    assert.deepEqual(beforeFinal.stream.panelists.map((p) => p.state), ['done', 'done', 'done']);
    // Tokens attributed across the candidate dones.
    assert.equal(beforeFinal.tokens.turn, 60);

    const s = reduce(beforeFinal, {
      type: 'turn/final',
      success: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'sess',
      verbosity: 'normal',
    });
    // FINAL STATE: zero goals/agents stuck running (the core H2 assertion).
    assert.equal(s.goals.length, 0);
    assert.equal(s.goals.filter((g) => g.state === 'running').length, 0);
    assert.equal(
      s.goals.flatMap((g) => g.agents).filter((a) => a.state === 'running').length,
      0,
    );
    assert.equal(s.tokens.turn, 60);
    assert.equal(s.tokens.session, 60);
    // The synthesized prose committed.
    assert.ok(lines(s).includes('Synthesized answer.'));
    assert.equal(s.turnActive, false);
  });

  it('a sequential 2-tier turn still settles BOTH goals (no stuck running)', () => {
    const flush = (success: boolean): Action => ({
      type: 'stream/flush-tier',
      tier: 'ic',
      success,
      confidence: 0.9,
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 10,
      panelCandidate: false,
      verbosity: 'normal',
    });
    const s = run([
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'a', attempt: 1, verbosity: 'normal' },
      { type: 'stream/prose', text: 'first' },
      flush(false), // first tier fails → escalation
      { type: 'tier-start', tier: 'manager', provider: 'claude', model: 'b', attempt: 2, verbosity: 'normal' },
      { type: 'stream/prose', text: 'second' },
      flush(true), // second tier succeeds
      {
        type: 'turn/final',
        success: true,
        tier: 'manager',
        attempts: 2,
        sessionId: 'sess',
        verbosity: 'normal',
      },
    ]);
    assert.equal(s.goals.length, 2);
    assert.deepEqual(s.goals.map((g) => g.state), ['failed', 'done']);
    assert.equal(s.goals.flatMap((g) => g.agents).filter((a) => a.state === 'running').length, 0);
    assert.equal(s.tokens.turn, 200);
  });
});

describe('ui reduce — turn/start + commit/raw (persistent state)', () => {
  it('turn/start resets the per-turn slice but PRESERVES committed[] and session tokens', () => {
    // Build a state with committed lines + session tokens + a stuck running goal.
    const afterTurn1 = run([
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'a', attempt: 1, verbosity: 'normal' },
      { type: 'stream/prose', text: 'answer one' },
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1,
        panelCandidate: false,
        verbosity: 'normal',
      },
      {
        type: 'turn/final',
        success: true,
        tier: 'ic',
        attempts: 1,
        sessionId: 's',
        verbosity: 'normal',
      },
    ]);
    assert.equal(afterTurn1.tokens.session, 150);
    const committedBefore = afterTurn1.committed.length;
    assert.ok(committedBefore > 0);

    const started = reduce(afterTurn1, { type: 'turn/start' });
    // committed[] preserved (NEVER shrinks — append-only <Static>).
    assert.deepEqual(started.committed, afterTurn1.committed);
    assert.equal(started.committed.length, committedBefore);
    // session tokens carried forward; per-turn counter reset.
    assert.equal(started.tokens.session, 150);
    assert.equal(started.tokens.turn, 0);
    // per-turn slice reset.
    assert.deepEqual(started.goals, []);
    assert.deepEqual(started.stream, initialStreamView);
    assert.equal(started.turnActive, false);
  });

  it('commit/raw appends a raw chrome line to the SAME committed transcript', () => {
    const s = run([
      { type: 'commit/raw', text: '> user prompt' },
      { type: 'stream/prose', text: 'reply' },
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        panelCandidate: false,
        verbosity: 'normal',
      },
    ]);
    assert.deepEqual(lines(s), ['> user prompt', 'reply']);
    assert.equal(s.committed[0]?.kind, 'raw');
    assert.equal(s.committed[1]?.kind, 'prose');
  });

  it('session tokens ACCUMULATE across turns separated by turn/start', () => {
    const tier = (): Action => ({
      type: 'stream/flush-tier',
      tier: 'ic',
      success: true,
      confidence: 0.9,
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 1,
      panelCandidate: false,
      verbosity: 'normal',
    });
    let s = run([tier()]);
    assert.equal(s.tokens.session, 100);
    s = reduce(s, { type: 'turn/start' });
    s = reduce(s, tier());
    assert.equal(s.tokens.session, 200);
    assert.equal(s.tokens.turn, 100);
  });
});

describe('ui reduce — tier-start', () => {
  it('normal mode: resets counters, adds a running goal, no committed line', () => {
    const dirty = run([
      { type: 'stream/tool', name: 'x', phase: 'start', verbosity: 'normal' },
      { type: 'stream/prose', text: 'p' },
    ]);
    const s = reduce(dirty, {
      type: 'tier-start',
      tier: 'ic',
      provider: 'claude',
      model: 'sonnet',
      attempt: 1,
      verbosity: 'normal',
    });
    assert.equal(s.stream.stepCount, 0);
    assert.equal(s.stream.streamedChars, 0);
    assert.equal(s.stream.attemptHadProse, false);
    assert.equal(s.stream.workLabel, 'Thinking');
    assert.equal(s.stream.phase, 'thinking');
    assert.equal(s.goals.length, 1);
    assert.equal(s.goals[0]?.state, 'running');
    assert.equal(s.goals[0]?.agents[0]?.provider, 'claude');
    assert.equal(s.committed.length, 0);
  });

  it('verbose mode: commits the ▶ tier line and uses the verbose workLabel', () => {
    const s = reduce(initialState, {
      type: 'tier-start',
      tier: 'manager',
      provider: 'codex',
      model: 'gpt-5',
      attempt: 2,
      verbosity: 'verbose',
    });
    assert.deepEqual(lines(s), ['▶ manager (codex/gpt-5)']);
    assert.equal(s.committed[0]?.kind, 'telemetry');
    assert.equal(s.stream.workLabel, 'manager (codex/gpt-5)');
  });
});

describe('ui reduce — tool / reasoning verbosity', () => {
  it('verbose tool commits a [tool] line; normal counts a step', () => {
    const v = reduce(initialState, { type: 'stream/tool', name: 'bash', phase: 'end', verbosity: 'verbose' });
    assert.deepEqual(lines(v), ['[tool] bash end']);
    const n = reduce(initialState, { type: 'stream/tool', name: 'bash', phase: 'start', verbosity: 'normal' });
    assert.equal(n.committed.length, 0);
    assert.equal(n.stream.stepCount, 1);
    assert.equal(n.stream.toolSinceProse, true);
  });

  it('verbose reasoning commits the raw delta; normal commits nothing', () => {
    const v = reduce(initialState, { type: 'stream/reasoning', text: 'thinking…', verbosity: 'verbose' });
    assert.deepEqual(lines(v), ['thinking…']);
    const n = reduce(initialState, { type: 'stream/reasoning', text: 'thinking…', verbosity: 'normal' });
    assert.equal(n.committed.length, 0);
    assert.equal(n.stream.phase, 'thinking'); // ensureAlive keeps the indicator
  });
});

describe('ui reduce — verbose tier-done telemetry', () => {
  it('commits a "tier done — confidence …, N tokens, duration …ms" line', () => {
    const s = run([
      { type: 'stream/prose', text: 'ans' },
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.85,
        inputTokens: 1200,
        outputTokens: 800,
        durationMs: 3400,
        panelCandidate: false,
        verbosity: 'verbose',
      },
    ]);
    // prose committed first, then telemetry.
    assert.deepEqual(lines(s), ['ans', '✓ tier done — confidence: 85%, 2k tokens, duration: 3400ms']);
  });

  it('renders null confidence as "unrated" and ✗ for failure', () => {
    const s = run([
      {
        type: 'stream/flush-tier',
        tier: 'worker',
        success: false,
        confidence: null,
        inputTokens: 5,
        outputTokens: 5,
        durationMs: 10,
        panelCandidate: false,
        verbosity: 'verbose',
      },
    ]);
    assert.deepEqual(lines(s), ['✗ tier done — confidence: unrated, 10 tokens, duration: 10ms']);
  });
});

describe('ui reduce — escalate', () => {
  it('normal mode commits the fixed dim refinement line', () => {
    const s = reduce(initialState, {
      type: 'escalate',
      from: 'ic',
      to: 'manager',
      reason: 'low confidence',
      verbosity: 'normal',
    });
    assert.deepEqual(lines(s), ['↑ low confidence — refining with a stronger model…']);
    assert.equal(s.committed[0]?.kind, 'escalate');
  });

  it('verbose mode commits the detailed escalation line', () => {
    const s = reduce(initialState, {
      type: 'escalate',
      from: 'ic',
      to: 'manager',
      reason: 'below bar',
      verbosity: 'verbose',
    });
    assert.deepEqual(lines(s), ['↑ Escalating ic → manager: below bar']);
  });
});

describe('ui reduce — failover (verbose-only)', () => {
  it('normal/quiet: no visible line', () => {
    for (const verbosity of ['normal', 'quiet'] as const) {
      const s = reduce(initialState, {
        type: 'failover',
        from: 'claude',
        to: 'codex',
        tier: 'ic',
        reason: 'rate limit',
        verbosity,
      });
      assert.equal(s.committed.length, 0);
    }
  });

  it('verbose: commits the ⇄ failover line', () => {
    const s = reduce(initialState, {
      type: 'failover',
      from: 'claude',
      to: 'codex',
      tier: 'ic',
      reason: 'rate limit',
      verbosity: 'verbose',
    });
    assert.deepEqual(lines(s), ['⇄ Failing over claude → codex (ic): rate limit']);
  });
});

describe('ui reduce — notice keying', () => {
  it('errors are ALWAYS committed in every verbosity', () => {
    for (const verbosity of ['quiet', 'normal', 'verbose'] as const) {
      const s = reduce(initialState, {
        type: 'notice',
        level: 'error',
        message: 'boom',
        verbosity,
      });
      assert.deepEqual(lines(s), ['[error] boom']);
      assert.equal(s.committed[0]?.kind, 'error');
    }
  });

  it('panel-header info surfaces dim in normal mode', () => {
    const s = reduce(initialState, {
      type: 'notice',
      level: 'info',
      message: 'Panel: claude, codex → synthesized by claude',
      verbosity: 'normal',
    });
    assert.deepEqual(lines(s), ['⋮ Panel: claude, codex → synthesized by claude']);
    assert.equal(s.committed[0]?.kind, 'notice');
  });

  it('hard-turn panel header also surfaces in normal mode', () => {
    const s = reduce(initialState, {
      type: 'notice',
      level: 'info',
      message: 'Panel (hard turn): claude, codex',
      verbosity: 'normal',
    });
    assert.deepEqual(lines(s), ['⋮ Panel (hard turn): claude, codex']);
  });

  it('hedge notice surfaces dim in normal mode', () => {
    const s = reduce(initialState, {
      type: 'notice',
      level: 'info',
      message: 'hedge: primary slow — speculatively starting flagship',
      verbosity: 'normal',
    });
    assert.deepEqual(lines(s), ['⋮ hedge: primary slow — speculatively starting flagship']);
  });

  it('spend-unknown warn surfaces as a [warn] line in normal mode', () => {
    const s = reduce(initialState, {
      type: 'notice',
      level: 'warn',
      message: 'Spend unknown — child killed before usage',
      verbosity: 'normal',
    });
    assert.deepEqual(lines(s), ['[warn] Spend unknown — child killed before usage']);
    assert.equal(s.committed[0]?.kind, 'warn');
  });

  it('a generic info/warn notice is suppressed in normal mode', () => {
    const info = reduce(initialState, {
      type: 'notice',
      level: 'info',
      message: 'some internal note',
      verbosity: 'normal',
    });
    assert.equal(info.committed.length, 0);
    const warn = reduce(initialState, {
      type: 'notice',
      level: 'warn',
      message: 'some warning',
      verbosity: 'normal',
    });
    assert.equal(warn.committed.length, 0);
  });

  it('verbose surfaces every info/warn notice with its prefix', () => {
    const info = reduce(initialState, {
      type: 'notice',
      level: 'info',
      message: 'detail',
      verbosity: 'verbose',
    });
    assert.deepEqual(lines(info), ['[info] detail']);
    const warn = reduce(initialState, {
      type: 'notice',
      level: 'warn',
      message: 'caution',
      verbosity: 'verbose',
    });
    assert.deepEqual(lines(warn), ['[warn] caution']);
  });
});

describe('ui reduce — final', () => {
  function finalAction(extra: Partial<Extract<Action, { type: 'turn/final' }>>): Action {
    return {
      type: 'turn/final',
      success: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'sess-1',
      verbosity: 'normal',
      ...extra,
    };
  }

  it('flushes buffered prose, clears turnActive, and resets the stream', () => {
    const withProse = run([
      { type: 'phase/panel', participants: ['claude'] },
      { type: 'stream/prose', text: 'final answer' },
    ]);
    const s = reduce(withProse, finalAction({}));
    assert.equal(s.turnActive, false);
    assert.equal(s.stream.buffer, '');
    assert.equal(s.stream.phase, 'idle');
    assert.equal(s.stream.panelists.length, 0);
    // 'final answer' prose then the success completion line.
    assert.deepEqual(lines(s), ['final answer', '✓ done · 0 tokens']);
  });

  it('normal success commits "✓ done · N tokens" with elapsed suffix when provided', () => {
    const s = run([
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        inputTokens: 900,
        outputTokens: 100,
        durationMs: 100,
        panelCandidate: false,
        verbosity: 'normal',
      },
      finalAction({ elapsedSecs: 7 }),
    ]);
    assert.deepEqual(lines(s), ['✓ done · 1k tokens · 7s']);
  });

  it('verbose success commits the "Success — tier:…" line', () => {
    const s = reduce(initialState, finalAction({ verbosity: 'verbose' }));
    assert.deepEqual(lines(s), ['Success — tier: ic, 0 tokens, attempts: 1, session: sess-1']);
  });

  it('quiet success commits NO completion line', () => {
    const s = reduce(initialState, finalAction({ verbosity: 'quiet' }));
    assert.equal(s.committed.length, 0);
    assert.equal(s.turnActive, false);
  });

  it('a question final suppresses the completion line entirely', () => {
    const s = run([
      { type: 'stream/prose', text: 'lead-in' },
      finalAction({ hasQuestions: true }),
    ]);
    assert.deepEqual(lines(s), ['lead-in']); // prose only, no ✓ done
  });

  it('best-effort success commits the caveat THEN the success line', () => {
    const s = reduce(initialState, finalAction({ bestEffort: true }));
    assert.deepEqual(lines(s), [
      'Best-effort answer — reached the attempt limit without a fully-confident result; treat the above as unverified.',
      '✓ done · 0 tokens',
    ]);
  });

  it('best-effort is suppressed in quiet mode (and so is the success line)', () => {
    const s = reduce(initialState, finalAction({ bestEffort: true, verbosity: 'quiet' }));
    assert.equal(s.committed.length, 0);
  });

  it('canceled final commits "■ Cancelled" (non-quiet) and nothing in quiet', () => {
    const s = reduce(initialState, finalAction({ success: false, canceled: true }));
    assert.deepEqual(lines(s), ['■ Cancelled']);
    assert.equal(s.committed[0]?.kind, 'completion');
    const q = reduce(initialState, finalAction({ success: false, canceled: true, verbosity: 'quiet' }));
    assert.equal(q.committed.length, 0);
  });

  it('timeout failure commits the friendly two-line message', () => {
    const s = run([
      {
        type: 'stream/flush-tier',
        tier: 'manager',
        success: false,
        confidence: null,
        inputTokens: 5000,
        outputTokens: 0,
        durationMs: 60000,
        panelCandidate: false,
        verbosity: 'normal',
      },
      finalAction({ success: false, tier: 'manager', attempts: 2, errorCategory: 'timeout' }),
    ]);
    assert.deepEqual(lines(s), [
      "That ran past the single-turn time limit — it's a big task, not a crash.",
      'Timed out after one turn · tier: manager · 5k tokens · attempts: 2 · session: sess-1',
    ]);
  });

  it('non-timeout failure commits the actionable error then the "Failed — …" line', () => {
    const s = reduce(
      initialState,
      finalAction({
        success: false,
        attempts: 3,
        errorCategory: 'auth',
        actionableError: 'Authentication failed — run `claude auth login`.',
      }),
    );
    assert.deepEqual(lines(s), [
      'Authentication failed — run `claude auth login`.',
      'Failed — tier: ic, 0 tokens, attempts: 3, session: sess-1',
    ]);
    assert.equal(s.committed[0]?.kind, 'error');
    assert.equal(s.committed[1]?.kind, 'completion');
  });

  it('a failure with no actionable error still commits the Failed line (non-quiet)', () => {
    const s = reduce(initialState, finalAction({ success: false, errorCategory: 'unknown' }));
    assert.deepEqual(lines(s), ['Failed — tier: ic, 0 tokens, attempts: 1, session: sess-1']);
  });

  it('quiet failure commits the actionable error (always) but NOT the Failed line', () => {
    const s = reduce(
      initialState,
      finalAction({
        success: false,
        verbosity: 'quiet',
        errorCategory: 'auth',
        actionableError: 'auth err',
      }),
    );
    assert.deepEqual(lines(s), ['auth err']);
  });
});

describe('ui reduce — classified / intent / engagement no-ops in normal mode', () => {
  it('classified is a no-op (no line) when debug is off', () => {
    const s = reduce(initialState, {
      type: 'classified',
      tier: 'ic',
      risk: 'low',
      rationale: 'short chat',
      verbosity: 'normal',
      debug: false,
    });
    assert.equal(s.committed.length, 0);
    assert.equal(s.turnActive, true);
  });

  it('classified commits a metadata line when debug is on', () => {
    const s = reduce(initialState, {
      type: 'classified',
      tier: 'manager',
      risk: 'high',
      rationale: 'refactor request',
      verbosity: 'normal',
      debug: true,
    });
    assert.deepEqual(lines(s), ['Classified: manager tier, high risk — refactor request']);
  });

  it('intent and engagement are no-ops but mark the turn active', () => {
    const i = reduce(initialState, { type: 'intent' });
    assert.equal(i.committed.length, 0);
    assert.equal(i.turnActive, true);
    const e = reduce(initialState, { type: 'engagement' });
    assert.equal(e.committed.length, 0);
    assert.equal(e.turnActive, true);
  });
});

describe('coreEventToActions — mapping fidelity', () => {
  it('maps classified, threading debug', () => {
    const ev: CoreEvent = {
      type: 'classified',
      classification: { tier: 'ic', risk: 'low', rationale: 'r' },
    };
    const [a] = coreEventToActions(ev, 'normal', true);
    assert.deepEqual(a, {
      type: 'classified',
      tier: 'ic',
      risk: 'low',
      rationale: 'r',
      verbosity: 'normal',
      debug: true,
    });
  });

  it('maps phase panel + synthesis', () => {
    const panel = coreEventToActions(
      { type: 'phase', phase: 'panel', participants: ['claude', 'codex'] },
      'normal',
    );
    assert.deepEqual(panel, [{ type: 'phase/panel', participants: ['claude', 'codex'] }]);
    const synth = coreEventToActions({ type: 'phase', phase: 'synthesis', count: 3 }, 'normal');
    assert.deepEqual(synth, [{ type: 'phase/synthesis', count: 3 }]);
  });

  it('maps tool + reasoning provider-events; text/usage/done/error map to nothing', () => {
    const tool = coreEventToActions(
      { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'ls', phase: 'start' } },
      'normal',
    );
    assert.deepEqual(tool, [{ type: 'stream/tool', name: 'ls', phase: 'start', verbosity: 'normal' }]);
    const reasoning = coreEventToActions(
      { type: 'provider-event', tier: 'ic', event: { type: 'reasoning', delta: 'hmm' } },
      'verbose',
    );
    assert.deepEqual(reasoning, [{ type: 'stream/reasoning', text: 'hmm', verbosity: 'verbose' }]);
    // text → no structural action (cleaned prose comes from the impure filter in 3b).
    const text = coreEventToActions(
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'hi' } },
      'normal',
    );
    assert.deepEqual(text, []);
    const usage = coreEventToActions(
      { type: 'provider-event', tier: 'ic', event: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
      'normal',
    );
    assert.deepEqual(usage, []);
  });

  it('maps tier-done → flush-tier (panelCandidate defaults false)', () => {
    const [a] = coreEventToActions(
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.7,
        costUsd: 0.01,
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 500,
      },
      'normal',
    );
    assert.deepEqual(a, {
      type: 'stream/flush-tier',
      tier: 'ic',
      success: true,
      confidence: 0.7,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 500,
      panelCandidate: false,
      verbosity: 'normal',
    });
  });

  it('maps escalate / failover / notice / tier-start faithfully', () => {
    assert.deepEqual(
      coreEventToActions({ type: 'escalate', from: 'ic', to: 'manager', reason: 'x' }, 'normal'),
      [{ type: 'escalate', from: 'ic', to: 'manager', reason: 'x', verbosity: 'normal' }],
    );
    assert.deepEqual(
      coreEventToActions(
        { type: 'failover', from: 'claude', to: 'codex', tier: 'ic', reason: 'rl' },
        'verbose',
      ),
      [{ type: 'failover', from: 'claude', to: 'codex', tier: 'ic', reason: 'rl', verbosity: 'verbose' }],
    );
    assert.deepEqual(
      coreEventToActions({ type: 'notice', level: 'warn', message: 'm' }, 'normal'),
      [{ type: 'notice', level: 'warn', message: 'm', verbosity: 'normal' }],
    );
    assert.deepEqual(
      coreEventToActions(
        { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 1 },
        'normal',
      ),
      [{ type: 'tier-start', tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 1, verbosity: 'normal' }],
    );
  });

  it('maps a success final, carrying only the present optional fields', () => {
    const [a] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: 'done',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
        bestEffort: true,
      },
      'normal',
    );
    assert.deepEqual(a, {
      type: 'turn/final',
      success: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'S',
      verbosity: 'normal',
      bestEffort: true,
    });
  });

  it('maps a failing final, carrying errorCategory/provider and dropping absent fields', () => {
    const [a] = coreEventToActions(
      {
        type: 'final',
        success: false,
        output: '',
        tier: 'manager',
        totalCostUsd: 0,
        sessionId: 'S2',
        attempts: 2,
        errorCategory: 'timeout',
        provider: 'claude',
      },
      'normal',
    );
    assert.deepEqual(a, {
      type: 'turn/final',
      success: false,
      tier: 'manager',
      attempts: 2,
      sessionId: 'S2',
      verbosity: 'normal',
      errorCategory: 'timeout',
      provider: 'claude',
    });
  });

  it('maps a question final to hasQuestions:true', () => {
    const [a] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: '',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
        questions: { questions: [{ id: 'q', prompt: 'p', options: [], multiSelect: false, allowFreeText: false }] },
      },
      'normal',
    );
    assert.equal((a as Extract<Action, { type: 'turn/final' }>).hasQuestions, true);
  });

  it('isDebugEnv reads MYSHELL_DEBUG truthiness', () => {
    assert.equal(isDebugEnv({ MYSHELL_DEBUG: '1' }), true);
    assert.equal(isDebugEnv({ MYSHELL_DEBUG: '' }), false);
    assert.equal(isDebugEnv({}), false);
    assert.equal(isDebugEnv(undefined), false);
  });
});

describe('ui reduce — immutability', () => {
  it('never mutates the input state', () => {
    const before = initialState;
    const after = reduce(before, { type: 'stream/prose', text: 'x' });
    assert.notEqual(after, before);
    assert.equal(before.stream.buffer, '');
    assert.equal(before.committed.length, 0);
  });

  it('an end-to-end normal turn produces the expected committed transcript', () => {
    const events: CoreEvent[] = [
      { type: 'classified', classification: { tier: 'ic', risk: 'low', rationale: 'chat' } },
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 1 },
      { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'read', phase: 'start' } },
      { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'The answer is 42.' } },
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.9,
        costUsd: 0,
        inputTokens: 500,
        outputTokens: 500,
        durationMs: 1000,
      },
      {
        type: 'final',
        success: true,
        output: 'The answer is 42.',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
      },
    ];
    // Drive structural actions through the reducer; for the text delta, simulate
    // 3b's impure filter by dispatching the cleaned prose directly.
    let s: UiState = initialState;
    for (const ev of events) {
      for (const a of coreEventToActions(ev, 'normal')) s = reduce(s, a);
      if (ev.type === 'provider-event' && ev.event.type === 'text') {
        s = reduce(s, { type: 'stream/prose', text: ev.event.delta });
      }
    }
    assert.deepEqual(lines(s), ['The answer is 42.', '✓ done · 1k tokens']);
    assert.equal(s.turnActive, false);
    assert.equal(s.tokens.turn, 1000);
  });
});
