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

import { describe, it } from 'vitest';
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
  derivePulseLabel,
  isTurnStalled,
  formatStallStatus,
  resolveStatusHeadline,
  toolPulseVerb,
  formatToolPulseLabel,
  looksLikeTestCommand,
  activeGoalTitle,
  STALL_THRESHOLD_MS,
  type Action,
  type AgentRunState,
  type AgentView,
  type GoalBoardRow,
  type GoalView,
  type StreamPhase,
  type StreamView,
  type TokenView,
  type TranscriptLine,
  type UiState,
  type Verbosity,
} from '../../src/interface/ui/index.ts';
import type { CoreEvent } from '../../src/core/types.ts';
import { PROSE_BUFFER_CAP } from '../../src/interface/ui/state.ts';

// Touch every re-exported type so the barrel's full surface is type-checked here
// (the value re-exports are exercised by the suites below).
type _SurfaceCheck = [
  Action,
  AgentRunState,
  AgentView,
  GoalBoardRow,
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
    // First text tokens promote the default Preparing verb to Responding.
    assert.equal(s.stream.workLabel, 'Responding');
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

describe('ui reduce — live stream.buffer is capped, committed prose stays COMPLETE (BUG 2)', () => {
  // A very long single turn must not grow stream.buffer unboundedly (App re-walks
  // it on every coalesced flush — O(buffer) per tick). Only the TAIL is displayed,
  // so the live buffer is capped to PROSE_BUFFER_CAP; the FULL prose lives in
  // proseFull and is what gets committed — so the transcript stays the whole answer.
  it('caps stream.buffer to PROSE_BUFFER_CAP within a tier', () => {
    // Stream far more than the cap, in chunks.
    const chunk = 'x'.repeat(4096);
    const actions: Action[] = [];
    for (let i = 0; i < 10; i += 1) actions.push({ type: 'stream/prose', text: chunk });
    const s = run(actions);
    // 40KB streamed, but the live display buffer is capped.
    assert.ok(s.stream.buffer.length <= PROSE_BUFFER_CAP, `buffer ${s.stream.buffer.length} > cap ${PROSE_BUFFER_CAP}`);
    // The full prose is retained out of band for the commit.
    assert.equal(s.stream.proseFull.length, chunk.length * 10);
    // The displayed buffer is the TAIL of the full prose (terminal-scroll feel).
    assert.equal(s.stream.buffer, s.stream.proseFull.slice(s.stream.proseFull.length - s.stream.buffer.length));
  });

  it('flush-tier commits the FULL prose even when the live buffer was capped', () => {
    const chunk = 'y'.repeat(5000);
    const actions: Action[] = [];
    for (let i = 0; i < 8; i += 1) actions.push({ type: 'stream/prose', text: chunk });
    actions.push({
      type: 'stream/flush-tier',
      tier: 'ic',
      success: true,
      confidence: 0.9,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      panelCandidate: false,
      verbosity: 'normal',
    });
    const s = run(actions);
    // The committed transcript line is the COMPLETE 40KB prose, not the capped tail.
    assert.equal(s.committed.length, 1);
    assert.equal(s.committed[0]?.kind, 'prose');
    assert.equal(s.committed[0]?.text.length, chunk.length * 8);
    assert.equal(s.committed[0]?.text, chunk.repeat(8));
    // Both the live buffer and the full accumulator reset at the boundary.
    assert.equal(s.stream.buffer, '');
    assert.equal(s.stream.proseFull, '');
  });

  it('turn/final commits the FULL prose even when the live buffer was capped', () => {
    const chunk = 'z'.repeat(6000);
    const actions: Action[] = [];
    for (let i = 0; i < 6; i += 1) actions.push({ type: 'stream/prose', text: chunk });
    actions.push({
      type: 'turn/final',
      success: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'sess-1',
      verbosity: 'normal',
    });
    const s = run(actions);
    // The committed prose line carries the COMPLETE 36KB answer.
    const prose = s.committed.find((l) => l.kind === 'prose');
    assert.ok(prose !== undefined, 'prose must be committed at final');
    assert.equal(prose?.text.length, chunk.length * 6);
    assert.equal(prose?.text, chunk.repeat(6));
  });

  it('a small turn under the cap is unchanged: buffer === proseFull', () => {
    const s = run([
      { type: 'stream/prose', text: 'Hello ' },
      { type: 'stream/prose', text: 'world.' },
    ]);
    assert.equal(s.stream.buffer, 'Hello world.');
    assert.equal(s.stream.proseFull, 'Hello world.');
  });
});

describe('ui reduce — turn/final cancel drops the uncommitted partial answer (BUG 2 cancel)', () => {
  // A mid-stream ESC: prose streamed into stream.buffer but NO tier-done
  // committed it. On a canceled final the reducer must DROP that partial buffer
  // (never commit it) and show only "■ Cancelled" — screen == store == replay,
  // matching work-call.ts (which does not persist a canceled answer).
  it('canceled final with a non-empty buffer commits only "■ Cancelled", not the partial prose', () => {
    const mid = run([{ type: 'stream/prose', text: 'Partial work that the user aborted.' }]);
    assert.equal(mid.stream.buffer, 'Partial work that the user aborted.');
    assert.equal(mid.committed.length, 0);

    const s = reduce(mid, {
      type: 'turn/final',
      success: false,
      canceled: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'cancel-sess',
      verbosity: 'normal',
    });

    // The partial prose was NOT committed…
    assert.ok(
      !lines(s).some((l) => l.includes('Partial work')),
      `canceled turn must not commit partial prose, got: ${JSON.stringify(lines(s))}`,
    );
    // …only the calm cancel line is, and the live buffer is cleared.
    assert.deepEqual(lines(s), ['■ Cancelled']);
    assert.equal(s.stream.buffer, '');
    assert.equal(s.turnActive, false);
  });

  it('quiet verbosity: canceled final commits nothing at all (no partial, no line)', () => {
    const mid = run([{ type: 'stream/prose', text: 'half an answer' }]);
    const s = reduce(mid, {
      type: 'turn/final',
      success: false,
      canceled: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'c',
      verbosity: 'quiet',
    });
    assert.equal(s.committed.length, 0);
    assert.equal(s.stream.buffer, '');
  });

  it('a NON-canceled final still flushes the buffered prose as today (regression guard)', () => {
    const mid = run([{ type: 'stream/prose', text: 'A complete answer.' }]);
    const s = reduce(mid, {
      type: 'turn/final',
      success: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 'ok',
      verbosity: 'normal',
    });
    assert.ok(
      lines(s).includes('A complete answer.'),
      `successful final must still commit the prose, got: ${JSON.stringify(lines(s))}`,
    );
    assert.equal(s.stream.buffer, '');
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
    // turnActive flips TRUE the instant the turn begins (UX fix: live status /
    // spinner appears immediately on submit, before the first real event) — it
    // no longer waits for classified/intent/phase/tier-start.
    assert.equal(started.turnActive, true);
  });

  it('honest workLabel phases: Preparing → Routing → Thinking → Responding', () => {
    const started = reduce(initialState, { type: 'turn/start' });
    assert.equal(started.stream.workLabel, 'Preparing');
    assert.equal(started.turnActive, true);

    const routing = reduce(started, {
      type: 'classified',
      tier: 'ic',
      risk: 'low',
      rationale: 'simple',
      verbosity: 'normal',
      debug: false,
    });
    assert.equal(routing.stream.workLabel, 'Routing');

    const composing = reduce(routing, {
      type: 'tier-start',
      tier: 'ic',
      provider: 'claude',
      model: 'sonnet',
      attempt: 1,
      verbosity: 'normal',
    });
    assert.equal(composing.stream.workLabel, 'Thinking');
    assert.equal(composing.stream.phase, 'thinking');

    const responding = reduce(composing, { type: 'stream/prose', text: 'Hi' });
    assert.equal(responding.stream.workLabel, 'Responding');
    assert.equal(responding.stream.phase, 'streaming');

    // Verbose tier labels are preserved across prose (not overwritten to Responding).
    const verbose = reduce(initialState, {
      type: 'tier-start',
      tier: 'manager',
      provider: 'codex',
      model: 'gpt-5',
      attempt: 1,
      verbosity: 'verbose',
    });
    const afterProse = reduce(verbose, { type: 'stream/prose', text: 'x' });
    assert.equal(afterProse.stream.workLabel, 'manager (codex/gpt-5)');
  });

  it('turn pulse stamps lastEventAt / lastPulseLabel from stream actions (injected nowMs)', () => {
    const t0 = 1_000_000;
    const started = reduce(initialState, { type: 'turn/start' }, t0);
    assert.equal(started.stream.lastEventAt, t0);
    assert.equal(started.stream.lastPulseLabel, 'Preparing');
    assert.equal(derivePulseLabel(started.stream), 'Preparing');

    const t1 = t0 + 500;
    const composing = reduce(
      started,
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'claude',
        model: 'sonnet',
        attempt: 1,
        verbosity: 'normal',
      },
      t1,
    );
    assert.equal(composing.stream.lastEventAt, t1);
    assert.equal(composing.stream.lastPulseLabel, 'Thinking');

    const t2 = t1 + 200;
    const tool = reduce(
      composing,
      {
        type: 'stream/tool',
        name: 'Edit',
        phase: 'start',
        verbosity: 'normal',
        detail: 'src/a.ts',
      },
      t2,
    );
    assert.equal(tool.stream.lastEventAt, t2);
    assert.equal(tool.stream.lastPulseLabel, 'Editing src/a.ts');
    assert.equal(derivePulseLabel(tool.stream), 'Editing src/a.ts');

    const t3 = t2 + 100;
    const prose = reduce(tool, { type: 'stream/prose', text: 'Hi' }, t3);
    assert.equal(prose.stream.lastEventAt, t3);
    // First prose clears tool? No — currentTool stays until flush-tier; pulse
    // still prefers the live tool verb (honest: a tool is still the last action
    // until tier boundary). After flush it falls back to Responding.
    assert.equal(prose.stream.workLabel, 'Responding');
    assert.equal(prose.stream.lastPulseLabel, 'Editing src/a.ts');

    const flushed = reduce(
      prose,
      {
        type: 'stream/flush-tier',
        tier: 'ic',
        success: true,
        confidence: null,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
        panelCandidate: false,
        verbosity: 'normal',
      },
      t3 + 50,
    );
    assert.equal(flushed.stream.currentTool, undefined);
    assert.equal(flushed.stream.lastPulseLabel, 'Responding');
  });

  it('pure stall helpers: threshold, format, and resolveStatusHeadline', () => {
    assert.equal(STALL_THRESHOLD_MS, 12_000);
    assert.equal(isTurnStalled(null, 50_000), false);
    assert.equal(isTurnStalled(1_000, 1_000 + 11_999), false);
    assert.equal(isTurnStalled(1_000, 1_000 + 12_000), true);
    assert.equal(formatStallStatus('Thinking', 47), 'stalled · last Thinking · 47s');
    assert.equal(formatStallStatus('', 12), 'stalled · last Thinking · 12s');

    const stream: StreamView = {
      ...initialStreamView,
      workLabel: 'Thinking',
      lastEventAt: 1_000,
      lastPulseLabel: 'Thinking',
    };
    // Under threshold → progressive headline (live action wins when present).
    assert.deepEqual(resolveStatusHeadline(stream, 1_000 + 5_000, 'Editing src/a.ts'), {
      stalled: false,
      headline: 'Editing src/a.ts',
    });
    assert.deepEqual(resolveStatusHeadline(stream, 1_000 + 5_000, ''), {
      stalled: false,
      headline: 'Thinking',
    });
    // At threshold → honest stall; silence seconds from lastEventAt, not invented work.
    assert.deepEqual(resolveStatusHeadline(stream, 1_000 + 47_000, 'Editing src/a.ts'), {
      stalled: true,
      headline: 'stalled · last Thinking · 47s',
    });
    // No nowMs → never stall (display stays progressive).
    assert.deepEqual(resolveStatusHeadline(stream, undefined, ''), {
      stalled: false,
      headline: 'Thinking',
    });
  });

  it('smart pulse pure helpers: tool verbs, goal title, Running tests', () => {
    assert.deepEqual(toolPulseVerb('Read'), { verb: 'Reading' });
    assert.deepEqual(toolPulseVerb('Read', 'src/a.ts'), { verb: 'Reading', target: 'src/a.ts' });
    assert.deepEqual(toolPulseVerb('Edit', 'src/a.ts'), { verb: 'Editing', target: 'src/a.ts' });
    assert.deepEqual(toolPulseVerb('Bash'), { verb: 'Running' });
    assert.deepEqual(toolPulseVerb('Bash', 'npm test'), { verb: 'Running tests' });
    assert.deepEqual(toolPulseVerb('Bash', 'npx vitest run'), { verb: 'Running tests' });
    assert.deepEqual(toolPulseVerb('Bash', 'ls -la'), { verb: 'Running', target: 'ls -la' });
    assert.deepEqual(toolPulseVerb('Grep', 'foo'), { verb: 'Searching', target: 'foo' });
    assert.deepEqual(toolPulseVerb('mystery_tool'), { verb: 'mystery_tool' });
    assert.equal(formatToolPulseLabel({ verb: 'Editing', target: 'src/a.ts' }), 'Editing src/a.ts');
    assert.equal(formatToolPulseLabel({ verb: 'Running tests' }), 'Running tests');
    assert.equal(looksLikeTestCommand('npm test'), true);
    assert.equal(looksLikeTestCommand('ls'), false);

    assert.equal(
      derivePulseLabel({ workLabel: 'Thinking', currentTool: undefined }, { goalTitle: 'Ship auth' }),
      'Working on "Ship auth"',
    );
    assert.equal(
      derivePulseLabel(
        { workLabel: 'Thinking', currentTool: { verb: 'Reading', target: 'a.ts' } },
        { goalTitle: 'Ship auth' },
      ),
      'Reading a.ts',
    );
    assert.equal(
      derivePulseLabel({ workLabel: 'Responding', currentTool: undefined }, { goalTitle: 'Ship auth' }),
      'Responding',
    );
    assert.equal(derivePulseLabel({ workLabel: '', currentTool: undefined }), 'Thinking');

    const goals: GoalView[] = [
      {
        id: 'g1',
        label: 'Ship auth',
        state: 'running',
        tokens: 0,
        toolCount: 0,
        agents: [],
        tier: 'ic',
      },
    ];
    assert.equal(activeGoalTitle(goals), 'Ship auth');
    assert.equal(
      activeGoalTitle([{ ...goals[0]!, label: 'ic', id: 'ic#1' }]),
      undefined,
      'bare tier label is not an honest goal title',
    );

    assert.deepEqual(
      resolveStatusHeadline(
        { ...initialStreamView, workLabel: 'Thinking', lastEventAt: 1, lastPulseLabel: 'Thinking' },
        2,
        '',
        { goalTitle: 'Ship auth' },
      ),
      { stalled: false, headline: 'Working on "Ship auth"' },
    );
  });

  it('intent/engagement promote Routing; goal title freezes into lastPulseLabel', () => {
    const t0 = 10_000;
    let s = reduce(initialState, { type: 'turn/start' }, t0);
    s = reduce(s, { type: 'intent' }, t0 + 10);
    assert.equal(s.stream.workLabel, 'Routing');
    assert.equal(s.stream.lastPulseLabel, 'Routing');

    s = reduce(
      s,
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'claude',
        model: 'sonnet',
        attempt: 1,
        verbosity: 'normal',
        title: 'Fix hang detector',
      },
      t0 + 20,
    );
    assert.equal(s.stream.workLabel, 'Thinking');
    assert.equal(s.stream.lastPulseLabel, 'Working on "Fix hang detector"');

    s = reduce(
      s,
      {
        type: 'stream/tool',
        name: 'Bash',
        phase: 'start',
        verbosity: 'normal',
        detail: 'npm test -- test/unit/hang.test.ts',
      },
      t0 + 30,
    );
    assert.equal(s.stream.currentTool?.verb, 'Running tests');
    assert.equal(s.stream.lastPulseLabel, 'Running tests');
  });

  it('board/sync and chrome do NOT stamp lastEventAt (not stream liveness)', () => {
    const t0 = 5_000;
    const started = reduce(initialState, { type: 'turn/start' }, t0);
    const afterChrome = reduce(started, { type: 'chrome/replace', lines: ['menu'] }, t0 + 20_000);
    assert.equal(afterChrome.stream.lastEventAt, t0, 'chrome must not count as a pulse event');
    const afterBoard = reduce(
      afterChrome,
      { type: 'board/sync', rows: [], enabled: true },
      t0 + 30_000,
    );
    assert.equal(afterBoard.stream.lastEventAt, t0, 'board/sync must not count as a pulse event');
  });

  it('turn/start sets turnActive true and turn/final settles it back to false', () => {
    // Fresh idle state → turn/start must make the turn active immediately so the
    // status block / spinner renders on submit (no frozen gap before tier-start).
    const started = reduce(initialState, { type: 'turn/start' });
    assert.equal(started.turnActive, true);
    // …and turn/final must settle it back to false (turn ends → idle UI).
    const final = reduce(started, {
      type: 'turn/final',
      success: true,
      tier: 'ic',
      attempts: 1,
      sessionId: 's',
      verbosity: 'normal',
    });
    assert.equal(final.turnActive, false);
  });

  it('turn/reset clears an optimistic preflight turn without touching committed lines or session tokens', () => {
    const started = reduce(
      {
        ...initialState,
        committed: [{ kind: 'raw', text: '> prior transcript' }],
        tokens: { turn: 0, session: 150 },
      },
      { type: 'turn/start' },
    );
    const reset = reduce(started, { type: 'turn/reset' });
    assert.equal(reset.turnActive, false);
    assert.deepEqual(reset.stream, initialStreamView);
    assert.deepEqual(reset.goals, []);
    assert.deepEqual(reset.committed, [{ kind: 'raw', text: '> prior transcript' }]);
    assert.deepEqual(reset.tokens, { turn: 0, session: 150 });
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

  it('chrome/replace swaps the ephemeral live region WHOLE without touching committed[]', () => {
    // The menu-lag fix: the menu redraws into the bounded `chrome` live region
    // (replaced each frame), NOT committed[]. So N replaces keep committed[] empty
    // and chrome[] holding only the latest frame.
    let s = initialState;
    for (let i = 0; i < 10; i++) {
      s = reduce(s, { type: 'chrome/replace', lines: ['menu', `frame ${i}`] });
    }
    assert.equal(s.committed.length, 0, 'committed[] must not grow across chrome/replace');
    assert.deepEqual(s.chrome.map((l) => l.text), ['menu', 'frame 9']);
    assert.equal(s.chrome[0]?.kind, 'raw');
  });

  it('chrome/promote folds the live region into committed[] and clears chrome', () => {
    let s = reduce(initialState, { type: 'chrome/replace', lines: ['menu a', 'menu b'] });
    s = reduce(s, { type: 'chrome/promote' });
    assert.deepEqual(s.chrome, []);
    assert.deepEqual(s.committed.map((l) => l.text), ['menu a', 'menu b']);
    // A subsequent commit/raw appends BELOW the promoted menu (append-only intact).
    s = reduce(s, { type: 'commit/raw', text: 'after' });
    assert.deepEqual(s.committed.map((l) => l.text), ['menu a', 'menu b', 'after']);
  });

  it('turn/start clears any lingering menu chrome (menu → chat handoff)', () => {
    let s = reduce(initialState, { type: 'chrome/replace', lines: ['stale menu'] });
    s = reduce(s, { type: 'turn/start' });
    assert.deepEqual(s.chrome, [], 'turn/start must clear the ephemeral menu chrome');
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
    // No title supplied → the label fails soft to the bare tier id, and the tier
    // is also carried for the dim badge.
    assert.equal(s.goals[0]?.label, 'ic');
    assert.equal(s.goals[0]?.tier, 'ic');
  });

  it('Phase 2: a supplied title becomes the goal LABEL; tier + risk ride along as the badge', () => {
    const s = reduce(initialState, {
      type: 'tier-start',
      tier: 'ic',
      provider: 'claude',
      model: 'sonnet',
      attempt: 1,
      verbosity: 'normal',
      title: 'Refactor the auth middleware',
      risk: 'medium',
    });
    assert.equal(s.goals[0]?.label, 'Refactor the auth middleware');
    assert.equal(s.goals[0]?.tier, 'ic');
    assert.equal(s.goals[0]?.risk, 'medium');
  });

  it('Phase 2: an empty title still fails soft to the tier id (never a blank label)', () => {
    const s = reduce(initialState, {
      type: 'tier-start',
      tier: 'manager',
      provider: 'codex',
      model: 'gpt-5',
      attempt: 1,
      verbosity: 'normal',
      title: '',
    });
    assert.equal(s.goals[0]?.label, 'manager');
    assert.equal(s.goals[0]?.tier, 'manager');
  });

  it('verbose mode: keeps the verbose workLabel but does not commit narration directly', () => {
    const s = reduce(initialState, {
      type: 'tier-start',
      tier: 'manager',
      provider: 'codex',
      model: 'gpt-5',
      attempt: 2,
      verbosity: 'verbose',
    });
    assert.deepEqual(lines(s), []);
    assert.equal(s.stream.workLabel, 'manager (codex/gpt-5)');
  });
});

describe('ui reduce — tool / reasoning verbosity', () => {
  it('verbose tool no longer commits directly; normal still counts a step', () => {
    const v = reduce(initialState, { type: 'stream/tool', name: 'bash', phase: 'end', verbosity: 'verbose' });
    assert.deepEqual(lines(v), []);
    const n = reduce(initialState, { type: 'stream/tool', name: 'bash', phase: 'start', verbosity: 'normal' });
    assert.equal(n.committed.length, 0);
    assert.equal(n.stream.stepCount, 1);
    assert.equal(n.stream.toolSinceProse, true);
  });

  it('attributes normal tool calls to the matching goalId without changing the global stepCount behavior', () => {
    const started = run([
      { type: 'goal/enqueue', goalId: 'g1', label: 'One' },
      { type: 'goal/enqueue', goalId: 'g2', label: 'Two' },
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'claude',
        model: 'opus',
        attempt: 1,
        verbosity: 'normal',
        goalId: 'g1',
      },
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'codex',
        model: 'gpt-5',
        attempt: 1,
        verbosity: 'normal',
        goalId: 'g2',
      },
    ]);
    const afterTool = reduce(started, {
      type: 'stream/tool',
      name: 'Edit',
      phase: 'start',
      verbosity: 'normal',
      goalId: 'g2',
    });
    assert.equal(afterTool.stream.stepCount, 1);
    assert.equal(afterTool.goals.find((g) => g.id === 'g1')?.toolCount, 0);
    assert.equal(afterTool.goals.find((g) => g.id === 'g2')?.toolCount, 1);
  });

  it('captures the LIVE action (currentTool) from a real tool event, mapping the name to a verb', () => {
    // A real tool name maps to a capitalized verb; with NO detail there is no target
    // (the Claude subscription provider supplies none — never fabricated).
    const edit = reduce(initialState, { type: 'stream/tool', name: 'Edit', phase: 'start', verbosity: 'normal' });
    assert.deepEqual(edit.stream.currentTool, { verb: 'Editing' });
    const read = reduce(initialState, { type: 'stream/tool', name: 'Read', phase: 'start', verbosity: 'normal' });
    assert.deepEqual(read.stream.currentTool, { verb: 'Reading' });
    const bash = reduce(initialState, { type: 'stream/tool', name: 'Bash', phase: 'start', verbosity: 'normal' });
    assert.deepEqual(bash.stream.currentTool, { verb: 'Running' });
    // An unmapped tool name surfaces verbatim (never invented).
    const custom = reduce(initialState, { type: 'stream/tool', name: 'CustomMcpTool', phase: 'start', verbosity: 'normal' });
    assert.deepEqual(custom.stream.currentTool, { verb: 'CustomMcpTool' });
  });

  it('includes the real TARGET only when the tool event supplied a detail', () => {
    const withTarget = reduce(initialState, {
      type: 'stream/tool',
      name: 'file_change',
      phase: 'end',
      verbosity: 'normal',
      detail: 'src/auth/mw.ts',
    });
    assert.deepEqual(withTarget.stream.currentTool, { verb: 'Editing', target: 'src/auth/mw.ts' });
  });

  it('clears currentTool at a (non-panel) tier boundary so no stale verb lingers', () => {
    const afterTool = reduce(initialState, { type: 'stream/tool', name: 'Edit', phase: 'start', verbosity: 'normal' });
    assert.notEqual(afterTool.stream.currentTool, undefined);
    const settled = reduce(afterTool, {
      type: 'stream/flush-tier',
      tier: 'ic',
      success: true,
      confidence: 0.9,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 5,
      panelCandidate: false,
      verbosity: 'normal',
    });
    assert.equal(settled.stream.currentTool, undefined);
  });

  it('verbose tool events do NOT set currentTool', () => {
    const v = reduce(initialState, { type: 'stream/tool', name: 'Edit', phase: 'start', verbosity: 'verbose' });
    assert.equal(v.stream.currentTool, undefined);
  });

  it('verbose reasoning no longer commits directly; normal commits nothing', () => {
    const v = reduce(initialState, { type: 'stream/reasoning', text: 'thinking…', verbosity: 'verbose' });
    assert.deepEqual(lines(v), []);
    const n = reduce(initialState, { type: 'stream/reasoning', text: 'thinking…', verbosity: 'normal' });
    assert.equal(n.committed.length, 0);
    assert.equal(n.stream.phase, 'thinking'); // ensureAlive keeps the indicator
  });
});

describe('ui reduce — stream/narration', () => {
  it('commits each finalized narration line as telemetry', () => {
    const s = run([
      {
        type: 'stream/narration',
        lines: ['Activity: ic (claude/sonnet) attempt 1', 'Tools:', '  - read_file'],
      },
    ]);
    assert.deepEqual(lines(s), ['Activity: ic (claude/sonnet) attempt 1', 'Tools:', '  - read_file']);
    assert.equal(s.committed.every((line) => line.kind === 'telemetry'), true);
  });

  it('verbose flush-tier still commits prose and accounting, but no telemetry line', () => {
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
    assert.deepEqual(lines(s), ['ans']);
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
    // 'final answer' prose then the success completion line. No usage was accounted
    // this turn (tokens.turn === 0), so the token segment is OMITTED (honesty parity
    // with summarizeTurn / StatusLine) — the line reads "✓ done", not "✓ done · 0 tokens".
    assert.deepEqual(lines(s), ['final answer', '✓ done']);
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

  it('normal success OMITS the token segment when no usage was reported (tokens.turn === 0)', () => {
    // Providers map missing usage to 0; formatTokens(0) === '0'. The completion line
    // must NOT read "✓ done · 0 tokens" — it reads "✓ done" (+ elapsed when present).
    const noTokens = reduce(initialState, finalAction({}));
    assert.deepEqual(lines(noTokens), ['✓ done']);
    const noTokensWithElapsed = reduce(initialState, finalAction({ elapsedSecs: 3 }));
    assert.deepEqual(lines(noTokensWithElapsed), ['✓ done · 3s']);
  });

  it('verbose success commits the "Success — tier:…" line (token segment omitted at 0)', () => {
    const s = reduce(initialState, finalAction({ verbosity: 'verbose' }));
    // No usage accounted (tokens.turn === 0) → the "N tokens" segment is omitted here too.
    assert.deepEqual(lines(s), ['Success — tier: ic, attempts: 1, session: sess-1']);
  });

  it('appends visible-dispatch routing receipt after success completion (normal)', () => {
    const receipt = 'claude \u00b7 opus \u00b7 high \u2014 multi-file refactor';
    const s = reduce(
      initialState,
      finalAction({ routingReceipt: receipt }),
    );
    assert.deepEqual(lines(s), ['✓ done', receipt]);
  });

  it('appends completion-truth chrome after routing receipt when present', () => {
    const receipt = 'claude \u00b7 opus';
    const truth = 'check: unverified · answered · not settled (answered)';
    const s = reduce(
      initialState,
      finalAction({ routingReceipt: receipt, completionTruth: truth }),
    );
    assert.deepEqual(lines(s), ['✓ done', receipt, truth]);
  });

  it('appends completion-truth alone when no routing receipt', () => {
    const truth = 'check: verified · done · settled (verified)';
    const s = reduce(initialState, finalAction({ completionTruth: truth }));
    assert.deepEqual(lines(s), ['✓ done', truth]);
  });

  it('suppresses routing receipt in quiet mode', () => {
    const s = reduce(
      initialState,
      finalAction({
        verbosity: 'quiet',
        routingReceipt: 'claude \u00b7 opus',
      }),
    );
    assert.deepEqual(lines(s), []);
  });

  it('suppresses completion-truth chrome in quiet mode', () => {
    const s = reduce(
      initialState,
      finalAction({
        verbosity: 'quiet',
        completionTruth: 'check: unverified · answered',
      }),
    );
    assert.deepEqual(lines(s), []);
  });

  it('verbose success INCLUDES the token segment when tokens.turn > 0', () => {
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
      finalAction({ verbosity: 'verbose' }),
    ]);
    assert.deepEqual(lines(s), ['Success — tier: ic, 1k tokens, attempts: 1, session: sess-1']);
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
      '✓ done',
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

  it('timeout renders a calm continuing status and does not settle the running goal as failed', () => {
    const s = run([
      {
        type: 'tier-start',
        tier: 'manager',
        provider: 'claude',
        model: 'model-a',
        attempt: 1,
        verbosity: 'normal',
      },
      finalAction({
        success: false,
        tier: 'manager',
        attempts: 2,
        errorCategory: 'timeout',
        timeoutContinuation: 'automatic',
      }),
    ]);
    assert.deepEqual(lines(s), [
      '⏳ That step ran long (hit the single-turn limit) — continuing…',
      'Single-turn limit reached · tier: manager · 0 tokens · attempts: 2 · session: sess-1',
    ]);
    assert.equal(s.goals[0]?.state, 'running');
    assert.equal(s.goals[0]?.agents[0]?.state, 'running');
  });

  it('non-timeout failure commits the actionable error then the "Failed — …" line', () => {
    const running = reduce(initialState, {
      type: 'tier-start',
      tier: 'ic',
      provider: 'claude',
      model: 'model-a',
      attempt: 1,
      verbosity: 'normal',
    });
    const s = reduce(
      running,
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
    assert.equal(s.goals[0]?.state, 'failed');
    assert.equal(s.goals[0]?.agents[0]?.state, 'failed');
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

  it('blocked final renders "✗ Blocked" with reason/next/preserved details (not "Failed")', () => {
    const s = reduce(
      initialState,
      finalAction({
        success: false,
        blocked: { reason: 'rate-limited', nextAction: 'retry later', preservedWork: 'partial answer' },
      }),
    );
    assert.deepEqual(lines(s), [
      '✗ Blocked',
      '  Reason: rate-limited',
      '  Next: retry later',
      '  Preserved: partial answer',
    ]);
    assert.equal(s.committed[0]?.kind, 'completion');
    assert.equal(s.committed[1]?.kind, 'notice');
  });

  it('blocked final is suppressed in quiet mode', () => {
    const s = reduce(
      initialState,
      finalAction({
        success: false,
        verbosity: 'quiet',
        blocked: { reason: 'x', nextAction: 'y', preservedWork: 'z' },
      }),
    );
    assert.equal(s.committed.length, 0);
  });

  it('blocked final with empty preservedWork omits the Preserved line', () => {
    const s = reduce(
      initialState,
      finalAction({
        success: false,
        blocked: { reason: 'r', nextAction: 'n', preservedWork: '' },
      }),
    );
    assert.deepEqual(lines(s), ['✗ Blocked', '  Reason: r', '  Next: n']);
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
    // A tool event carrying a real `detail` (codex/opencode) threads it through as
    // the action's optional target; an absent detail (Claude) omits it.
    const toolWithDetail = coreEventToActions(
      { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'file_change', phase: 'end', detail: 'src/x.ts' } },
      'normal',
    );
    assert.deepEqual(toolWithDetail, [
      { type: 'stream/tool', name: 'file_change', phase: 'end', verbosity: 'normal', detail: 'src/x.ts' },
    ]);
    const toolWithGoal = coreEventToActions(
      { type: 'provider-event', tier: 'ic', goalId: 'g7', event: { type: 'tool', name: 'Edit', phase: 'start' } },
      'normal',
    );
    assert.deepEqual(toolWithGoal, [
      { type: 'stream/tool', name: 'Edit', phase: 'start', verbosity: 'normal', goalId: 'g7' },
    ]);
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

  it('maps final.routingReceipt onto turn/final when present', () => {
    const receipt = 'claude \u00b7 opus \u00b7 high \u2014 multi-file refactor';
    const [a] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: 'ok',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
        routingReceipt: receipt,
      },
      'normal',
    );
    assert.equal(
      (a as Extract<Action, { type: 'turn/final' }>).routingReceipt,
      receipt,
    );
  });

  it('maps final.completionResult onto turn/final.completionTruth when present', () => {
    const [a] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: 'ok',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
        completionResult: {
          version: 1,
          id: 'cr-1',
          turnId: 't1',
          sessionId: 'S',
          createdAt: '2026-07-10T00:00:00.000Z',
          scope: 'conversation',
          terminal: 'answered',
          objective: 'task',
          doneCondition: null,
          output: 'ok',
          success: true,
          bestEffort: true,
          verification: {
            status: 'unverified',
            testEvidence: { status: 'not-needed' },
            repair: {
              attempted: false,
              attempts: 0,
              maxAttempts: 1,
              retestedAfterLastRepair: false,
              finalAttemptChangedPaths: [],
            },
            factualClaims: [],
            obligationsSatisfied: [],
            obligationsUnmet: [],
            ruleCodes: ['not-applicable'],
          },
          deliveryQuality: {
            status: 'passed',
            checked: true,
            issues: [],
            nextActionNamed: false,
            userVisibleSummary: 'ok',
          },
          worktree: {
            baseline: 'unknown',
            baselineEntries: [],
            changedByAssistant: [],
            excludedPreExisting: [],
            concurrentUserEdits: [],
            conflictPaths: [],
          },
          goalSettlement: {
            allowed: false,
            state: 'none',
            reason: 'answered',
          },
          replayPolicy: {
            replay: 'repair-only',
            reason: 'done-requires-check',
          },
          receipt: { lines: [] },
          upstream: {},
        },
      },
      'normal',
    );
    const truth = (a as Extract<Action, { type: 'turn/final' }>).completionTruth;
    assert.ok(typeof truth === 'string' && truth.length > 0);
    assert.match(truth, /check: unverified/);
    assert.match(truth, /answered/);
  });

  it('omits completionTruth on turn/final when completionResult absent', () => {
    const [a] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: 'ok',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
      },
      'normal',
    );
    assert.ok(!('completionTruth' in (a as object)));
  });

  it('omits routingReceipt on turn/final when absent or empty', () => {
    const [absent] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: 'ok',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
      },
      'normal',
    );
    assert.ok(!('routingReceipt' in (absent as object)));
    const [empty] = coreEventToActions(
      {
        type: 'final',
        success: true,
        output: 'ok',
        tier: 'ic',
        totalCostUsd: 0,
        sessionId: 'S',
        attempts: 1,
        routingReceipt: '',
      },
      'normal',
    );
    assert.ok(!('routingReceipt' in (empty as object)));
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

// ---------------------------------------------------------------------------
// MULTI-GOAL SEAM (additive) — goalId keying, concurrent goals, phase, enqueue.
// The ABSOLUTE requirement: with no goalId emitted (today) the reducer behaves
// byte-for-byte as before. These suites prove the parity AND the new behaviour.
// ---------------------------------------------------------------------------

describe('ui reduce — multi-goal: no-goalId PARITY guard', () => {
  /** A scripted single-goal turn with NO goalId anywhere (today's event shape). */
  const events: CoreEvent[] = [
    { type: 'classified', classification: { tier: 'ic', risk: 'low', rationale: 'chat' } },
    { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'sonnet', attempt: 1 },
    { type: 'provider-event', tier: 'ic', event: { type: 'tool', name: 'read', phase: 'start' } },
    { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'Answer.' } },
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
      output: 'Answer.',
      tier: 'ic',
      totalCostUsd: 0,
      sessionId: 'S',
      attempts: 1,
    },
  ];

  function drive(evs: readonly CoreEvent[]): UiState {
    let s: UiState = initialState;
    for (const ev of evs) {
      for (const a of coreEventToActions(ev, 'normal')) s = reduce(s, a);
      if (ev.type === 'provider-event' && ev.event.type === 'text') {
        s = reduce(s, { type: 'stream/prose', text: ev.event.delta });
      }
    }
    return s;
  }

  it('a no-goalId stream reduces to a state with ONE per-tier goal keyed tier#attempt', () => {
    const s = drive(events);
    assert.equal(s.goals.length, 1);
    assert.equal(s.goals[0]?.id, 'ic#1'); // the original per-tier key, unchanged
    assert.equal(s.goals[0]?.state, 'done');
    assert.equal(s.goals[0]?.phase, undefined); // never fabricated
    assert.deepEqual(lines(s), ['Answer.', '✓ done · 1k tokens']);
  });

  it('mapping a no-goalId event NEVER attaches a goalId to the actions', () => {
    const startActions = coreEventToActions(events[1]!, 'normal');
    assert.equal('goalId' in startActions[0]!, false);
    const doneActions = coreEventToActions(events[4]!, 'normal');
    assert.equal('goalId' in doneActions[0]!, false);
  });

  it('settle-by-goalId path is dormant: the lone running goal still settles at flush', () => {
    // Drive only through tier-done (no final) — the goal must be settled to done
    // exactly as the original last-running-goal logic did.
    const s = drive(events.slice(0, 5));
    assert.equal(s.goals[0]?.state, 'done');
  });
});

describe('ui reduce — multi-goal: goal/enqueue + goal/phase actions', () => {
  it('goal/enqueue appends a QUEUED goal card keyed by goalId', () => {
    const s = run([
      { type: 'turn/start' },
      { type: 'goal/enqueue', goalId: 'g1', label: 'Refactor auth' },
    ]);
    assert.equal(s.goals.length, 1);
    assert.equal(s.goals[0]?.id, 'g1');
    assert.equal(s.goals[0]?.label, 'Refactor auth');
    assert.equal(s.goals[0]?.state, 'queued');
    assert.equal(s.goals[0]?.toolCount, 0);
    assert.equal(s.goals[0]?.agents.length, 0);
  });

  it('goal/enqueue is idempotent on a duplicate id', () => {
    const s = run([
      { type: 'goal/enqueue', goalId: 'g1', label: 'A' },
      { type: 'goal/enqueue', goalId: 'g1', label: 'A again' },
    ]);
    assert.equal(s.goals.length, 1);
    assert.equal(s.goals[0]?.label, 'A'); // first wins, no duplicate
  });

  it('goal/phase sets a goal phase {current,total}', () => {
    const s = run([
      { type: 'goal/enqueue', goalId: 'g1', label: 'A' },
      { type: 'goal/phase', goalId: 'g1', current: 7, total: 12 },
    ]);
    assert.deepEqual(s.goals[0]?.phase, { current: 7, total: 12 });
  });

  it('goal/phase for an UNKNOWN goalId is a no-op (no phantom goal)', () => {
    const s = run([{ type: 'goal/phase', goalId: 'ghost', current: 1, total: 5 }]);
    assert.equal(s.goals.length, 0);
  });
});

describe('ui reduce — multi-goal: concurrent running goals keyed by goalId', () => {
  it('a tier-start with a goalId matching a queued goal flips THAT goal running', () => {
    const s = run([
      { type: 'turn/start' },
      { type: 'goal/enqueue', goalId: 'g1', label: 'Goal one' },
      { type: 'goal/enqueue', goalId: 'g2', label: 'Goal two' },
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'claude',
        model: 'opus',
        attempt: 1,
        verbosity: 'normal',
        goalId: 'g1',
      },
    ]);
    assert.equal(s.goals.length, 2); // no new card appended — attached to g1
    const g1 = s.goals.find((g) => g.id === 'g1');
    const g2 = s.goals.find((g) => g.id === 'g2');
    assert.equal(g1?.state, 'running');
    assert.equal(g1?.agents.length, 1);
    assert.equal(g2?.state, 'queued'); // untouched
  });

  it('TWO goals can be running concurrently', () => {
    const start = (goalId: string): Action => ({
      type: 'tier-start',
      tier: 'ic',
      provider: 'claude',
      model: 'opus',
      attempt: 1,
      verbosity: 'normal',
      goalId,
    });
    const s = run([
      { type: 'goal/enqueue', goalId: 'g1', label: 'One' },
      { type: 'goal/enqueue', goalId: 'g2', label: 'Two' },
      start('g1'),
      start('g2'),
    ]);
    const running = s.goals.filter((g) => g.state === 'running');
    assert.equal(running.length, 2);
  });

  it('flush-tier with a goalId settles ONLY the matching goal, leaving the other running', () => {
    const start = (goalId: string): Action => ({
      type: 'tier-start',
      tier: 'ic',
      provider: 'claude',
      model: 'opus',
      attempt: 1,
      verbosity: 'normal',
      goalId,
    });
    const done = (goalId: string): Action => ({
      type: 'stream/flush-tier',
      tier: 'ic',
      success: true,
      confidence: 0.9,
      inputTokens: 100,
      outputTokens: 100,
      durationMs: 10,
      panelCandidate: false,
      verbosity: 'normal',
      goalId,
    });
    const s = run([
      { type: 'goal/enqueue', goalId: 'g1', label: 'One' },
      { type: 'goal/enqueue', goalId: 'g2', label: 'Two' },
      start('g1'),
      start('g2'),
      done('g1'),
    ]);
    assert.equal(s.goals.find((g) => g.id === 'g1')?.state, 'done');
    assert.equal(s.goals.find((g) => g.id === 'g2')?.state, 'running'); // not touched
    assert.equal(s.goals.find((g) => g.id === 'g1')?.tokens, 200);
  });

  it('a tier-start with a NEW goalId (not enqueued) appends a fresh running goal keyed by it', () => {
    const s = run([
      {
        type: 'tier-start',
        tier: 'manager',
        provider: 'claude',
        model: 'opus',
        attempt: 1,
        verbosity: 'normal',
        title: 'Big goal',
        goalId: 'gX',
      },
    ]);
    assert.equal(s.goals.length, 1);
    assert.equal(s.goals[0]?.id, 'gX');
    assert.equal(s.goals[0]?.label, 'Big goal');
    assert.equal(s.goals[0]?.state, 'running');
  });

  it('the goal-enqueue / goal-phase CoreEvents map to the right actions', () => {
    const enq = coreEventToActions(
      { type: 'goal-enqueue', id: 'g1', title: 'Refactor' },
      'normal',
    );
    assert.deepEqual(enq, [{ type: 'goal/enqueue', goalId: 'g1', label: 'Refactor' }]);
    const ph = coreEventToActions(
      { type: 'goal-phase', goalId: 'g1', current: 3, total: 8 },
      'normal',
    );
    assert.deepEqual(ph, [{ type: 'goal/phase', goalId: 'g1', current: 3, total: 8 }]);
  });

  it('a tier-start CoreEvent WITH goalId threads it onto the action', () => {
    const acts = coreEventToActions(
      { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'opus', attempt: 1, goalId: 'g7' },
      'normal',
    );
    assert.equal(acts[0]?.type, 'tier-start');
    if (acts[0]?.type === 'tier-start') assert.equal(acts[0].goalId, 'g7');
  });
});

// ---------------------------------------------------------------------------
// Elite-partner Phase 1 — the REAL PERSISTENT BOARD (board/sync) + the fake-card
// suppression when the board is ON. The reducer is pure; the board is additive
// chrome that, when OFF (default), leaves every transition byte-identical.
// ---------------------------------------------------------------------------

const boardRow = (over: Partial<GoalBoardRow> = {}): GoalBoardRow => ({
  id: 'goal_a',
  title: 'Redesign feed',
  state: 'parked',
  done: 3,
  total: 8,
  glyph: '◷',
  scope: 'project',
  agents: 0,
  ...(over.todos !== undefined ? { todos: over.todos } : {}),
  ...over,
});

describe('ui reduce — board/sync (persistent board)', () => {
  it('default state carries an empty board + boardEnabled false (byte-identical baseline)', () => {
    assert.deepEqual(initialState.board, []);
    assert.equal(initialState.boardEnabled, false);
  });

  it('board/sync REPLACES the board and flips boardEnabled (pure replace)', () => {
    const rows = [boardRow(), boardRow({ id: 'goal_b', title: 'Add tests', state: 'queued' })];
    const s = reduce(initialState, { type: 'board/sync', rows, enabled: true });
    assert.equal(s.board.length, 2);
    assert.equal(s.board[0]?.title, 'Redesign feed');
    assert.equal(s.boardEnabled, true);
    // A second sync REPLACES (never appends).
    const s2 = reduce(s, { type: 'board/sync', rows: [boardRow({ id: 'goal_c', title: 'X' })], enabled: true });
    assert.equal(s2.board.length, 1);
    assert.equal(s2.board[0]?.id, 'goal_c');
  });

  it('a running goal in state.goals gives the matching board row its REAL live agent count', () => {
    // Spin up a running goal keyed by goalId with two agents on it.
    let s = reduce(initialState, {
      type: 'tier-start', tier: 'ic', provider: 'claude', model: 'opus', attempt: 1,
      verbosity: 'normal', goalId: 'goal_run',
    });
    s = reduce(s, {
      type: 'tier-start', tier: 'ic', provider: 'codex', model: 'gpt-5', attempt: 1,
      verbosity: 'normal', goalId: 'goal_run',
    });
    assert.equal(s.goals[0]?.agents.length, 2);
    // The synced snapshot carries agents:0 for that goal; the reducer re-derives 2.
    const synced = reduce(s, {
      type: 'board/sync',
      rows: [boardRow({ id: 'goal_run', state: 'running', agents: 0 }), boardRow({ id: 'goal_idle' })],
      enabled: true,
    });
    assert.equal(synced.board.find((r) => r.id === 'goal_run')?.agents, 2);
    // A goal not running this turn keeps 0 (never fabricated).
    assert.equal(synced.board.find((r) => r.id === 'goal_idle')?.agents, 0);
  });

  it('board/sync preserves the optional todos projection while re-deriving live agents', () => {
    let s = reduce(initialState, {
      type: 'tier-start', tier: 'ic', provider: 'claude', model: 'opus', attempt: 1,
      verbosity: 'normal', goalId: 'goal_run',
    });
    s = reduce(s, {
      type: 'board/sync',
      rows: [
        boardRow({
          id: 'goal_run',
          state: 'running',
          todos: [
            { id: 't1', text: 'Inspect logs', status: 'done' },
            { id: 't2', text: 'Patch renderer', status: 'active' },
          ],
        }),
      ],
      enabled: true,
    });
    assert.deepEqual(s.board[0]?.todos, [
      { id: 't1', text: 'Inspect logs', status: 'done' },
      { id: 't2', text: 'Patch renderer', status: 'active' },
    ]);
    assert.equal(s.board[0]?.agents, 1);
  });

  it('the board SURVIVES turn/start and turn/final without clearing (cross-turn)', () => {
    const synced = reduce(initialState, { type: 'board/sync', rows: [boardRow()], enabled: true });
    const afterStart = reduce(synced, { type: 'turn/start' });
    assert.equal(afterStart.board.length, 1, 'turn/start preserves the board');
    assert.equal(afterStart.boardEnabled, true);
    const afterFinal = reduce(afterStart, {
      type: 'turn/final', success: true, tier: 'ic', attempts: 1, sessionId: 's', verbosity: 'normal',
    });
    assert.equal(afterFinal.turnActive, false);
    assert.equal(afterFinal.board.length, 1, 'turn/final (turnActive→false) does NOT clear the board');
    assert.equal(afterFinal.boardEnabled, true);
  });

  it('board ON: a tier-start with a raw-message title does NOT surface it as the goal label (no fake card)', () => {
    const on = reduce(initialState, { type: 'board/sync', rows: [], enabled: true });
    const s = reduce(on, {
      type: 'tier-start', tier: 'ic', provider: 'claude', model: 'opus', attempt: 1,
      verbosity: 'normal', title: 'please refactor the auth middleware and also fix the tests',
    });
    // Board ON + an UNKEYED tier-start (no goalId) is plain chat execution, not a
    // staged/running goal — it must create NO goal row at all (the real goals come
    // from board/sync + goalId attachment). So there is no fake card, and the raw
    // message is never surfaced as a label.
    assert.equal(s.goals.length, 0);
    assert.equal(s.goals[0]?.label, undefined);
  });

  it('board OFF (default): a tier-start title still becomes the label — byte-identical to today', () => {
    const s = reduce(initialState, {
      type: 'tier-start', tier: 'ic', provider: 'claude', model: 'opus', attempt: 1,
      verbosity: 'normal', title: 'Refactor the auth middleware',
    });
    assert.equal(s.goals[0]?.label, 'Refactor the auth middleware');
    assert.equal(s.boardEnabled, false);
  });
});
