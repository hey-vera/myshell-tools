/**
 * src/interface/ui/reduce.ts — the PURE MVU reducer for the Ink chat UI
 * (STEP 3a). `reduce(state, action) => state` is a faithful, side-effect-free
 * re-expression of the VISIBLE-TEXT behaviour of `renderStream`
 * (src/interface/render.ts): how prose accumulates and is committed at tier
 * boundaries / final, the panel pre-announce + panelist tracking, synthesis, the
 * escalate / failover / notice lines (with their normal-vs-verbose wording), the
 * tier-done token accounting, and the final ✓ done / Failed / Cancelled /
 * timeout / best-effort line.
 *
 * PURITY (enforced informally; mirrors stream-filter.ts): NO Ink/React, NO JSX,
 * NO I/O, NO Date.now / Math.random / fs / execa. The only `Math` use is the
 * pure numeric formatting already shipped in `formatTokens`. Every transition
 * returns a NEW immutable `UiState`; inputs are never mutated.
 *
 * BOUNDARY: text actions (`stream/prose`) carry ALREADY-CLEANED prose — the
 * stateful EnvelopeFilter that strips the trailing confidence envelope stays in
 * the impure layer (3b). The reducer just appends. Envelope-stripping
 * correctness is covered by stream-filter.test.ts and is NOT re-done here.
 */

import { formatTokens } from '../../infra/insights.js';
import {
  type Action,
  type AgentView,
  type GoalView,
  type StreamView,
  type TranscriptLine,
  type UiState,
  initialStreamView,
} from './state.js';

// ---------------------------------------------------------------------------
// small immutable helpers
// ---------------------------------------------------------------------------

function commit(state: UiState, ...lines: readonly TranscriptLine[]): UiState {
  if (lines.length === 0) return state;
  return { ...state, committed: [...state.committed, ...lines] };
}

function withStream(state: UiState, patch: Partial<StreamView>): UiState {
  return { ...state, stream: { ...state.stream, ...patch } };
}

/** Reset the per-tier stream counters at a tier-start (mirrors render.ts:
 *  stepCount = 0; streamedChars = 0; attemptHadProse = false). */
function resetTierCounters(): Partial<StreamView> {
  return { stepCount: 0, streamedChars: 0, attemptHadProse: false };
}

/**
 * Settle the last still-`running` goal (and its agents) to a terminal state at a
 * non-panel tier boundary / final, attributing `tierTokens` to it. The status
 * panels read goal/agent `state` + `tokens` to show the ✓/✗ glyph and the
 * `↓ ~Nk tok` readout; without this the cards would sit "running" forever.
 * Sequential turns own exactly one running goal at a time, so flipping the LAST
 * running one (the active attempt) is the faithful mirror of render.ts settling
 * the current tier. Panel candidates are settled via `stream.panelists`, not
 * here, so panel goals are left untouched. Pure; returns a new array.
 */
function settleActiveGoal(
  goals: readonly GoalView[],
  finalState: 'done' | 'failed',
  tierTokens: number,
): readonly GoalView[] {
  let idx = -1;
  for (let i = goals.length - 1; i >= 0; i -= 1) {
    if (goals[i]?.state === 'running') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return goals;
  return goals.map((goal, i) => {
    if (i !== idx) return goal;
    return {
      ...goal,
      state: finalState,
      tokens: goal.tokens + tierTokens,
      agents: goal.agents.map((agent) =>
        agent.state === 'running'
          ? { ...agent, state: finalState, tokens: agent.tokens + tierTokens }
          : agent,
      ),
    };
  });
}

/**
 * Settle EVERY still-`running` goal (and its running agents) to a terminal state
 * at `turn/final` (H2 belt-and-suspenders). Sequential tiers settle one-by-one at
 * their boundaries so normally only the last is left running; but a turn that
 * ended with more than one running goal (a defensive case) must not leave any
 * stuck `◐ running` in the final snapshot. No token attribution here (tier tokens
 * were attributed at each tier-done). Pure; returns a new array.
 */
function settleAllRunningGoals(
  goals: readonly GoalView[],
  finalState: 'done' | 'failed',
): readonly GoalView[] {
  if (!goals.some((g) => g.state === 'running' || g.agents.some((a) => a.state === 'running'))) {
    return goals;
  }
  return goals.map((goal) => ({
    ...goal,
    state: goal.state === 'running' ? finalState : goal.state,
    agents: goal.agents.map((agent) =>
      agent.state === 'running' ? { ...agent, state: finalState } : agent,
    ),
  }));
}

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

export function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    // -- turn/start: reset ONLY the per-turn slice (live stream, goals,
    //    turnActive, the per-turn token counter) while PRESERVING the committed
    //    transcript AND the session-cumulative token total. This is the single
    //    persistent-state lever: across turns committed[] only ever grows (Ink's
    //    append-only <Static> contract) and session tokens accumulate. A fresh
    //    stream view is used (initialStreamView), exactly the slice a turn owns.
    case 'turn/start':
      return {
        ...state,
        goals: [],
        stream: initialStreamView,
        // Flip turnActive TRUE the instant a turn begins so the live status block
        // / spinner appears immediately on submit. Previously this stayed false
        // until the first real event (classified/intent/phase/tier-start), which
        // can be seconds away (classification + cold provider spawn), leaving the
        // UI looking frozen. With turnActive true and the fresh initialStreamView
        // (phase 'idle', workLabel 'Thinking', 0 steps), StatusBlock renders a
        // sensible "⠋ Thinking… 0 steps   esc to interrupt" line — no goals panel
        // yet (it stays hidden until goals arrive), never empty, never a crash.
        // turn/final still settles turnActive back to false.
        turnActive: true,
        tokens: { turn: 0, session: state.tokens.session },
      };

    // -- commit/raw: append ONE already-final chrome line (whatever the impure
    //    OutputSink wrote) into the SAME committed transcript the reducer prose
    //    commits feed. One growing source of truth → <Static> stays monotonic and
    //    no out.write chrome is lost between turns.
    case 'commit/raw':
      return commit(state, { kind: 'raw', text: action.text });

    // -- classifier metadata: only a visible line under verbose AND MYSHELL_DEBUG.
    //    render.ts gates the classified line purely on process.env.MYSHELL_DEBUG
    //    (independent of verbosity); we thread that as `debug`.
    case 'classified': {
      const next = { ...state, turnActive: true };
      if (!action.debug) return next;
      return commit(next, {
        kind: 'classified',
        text: `Classified: ${action.tier} tier, ${action.risk} risk — ${action.rationale}`,
      });
    }

    // -- intent / engagement: render-optional; no visible effect in the renderer.
    case 'intent':
    case 'engagement':
      return { ...state, turnActive: true };

    // -- phase 'panel': open panel mode, pre-register every candidate as running,
    //    clear any prior synthesizing state. (render.ts: panelMode = true;
    //    synthesizing = null; panelists = participants.)
    case 'phase/panel': {
      const panelists: AgentView[] = action.participants.map((provider) => ({
        provider,
        model: '',
        state: 'running',
        tokens: 0,
        attempt: 0,
      }));
      return {
        ...state,
        turnActive: true,
        stream: { ...state.stream, phase: 'panel', synthesizing: null, panelists },
      };
    }

    // -- phase 'synthesis': switch the live line to "Synthesizing N answers…".
    case 'phase/synthesis':
      return {
        ...state,
        turnActive: true,
        stream: { ...state.stream, phase: 'synthesis', synthesizing: { count: action.count } },
      };

    // -- tier-start: reset per-tier counters, add a running agent/goal. In verbose
    //    mode render.ts prints a `▶ tier (provider/model)` line. The workLabel is
    //    the verbose tier label or "Thinking". In panel mode (pre-synthesis) a
    //    not-yet-registered candidate is appended as running.
    case 'tier-start': {
      const isVerbose = action.verbosity === 'verbose';
      const inPanel = state.stream.phase === 'panel'; // panelMode && synthesizing===null
      let panelists = state.stream.panelists;
      if (inPanel && !panelists.some((p) => p.provider === action.provider)) {
        panelists = [
          ...panelists,
          { provider: action.provider, model: action.model, state: 'running', tokens: 0, attempt: action.attempt },
        ];
      }
      const workLabel = isVerbose ? `${action.tier} (${action.provider}/${action.model})` : 'Thinking';
      // H2 fix: in PANEL mode the running candidates are represented SOLELY by
      // stream.panelists (the StatusLine's panelLabel reads them). We do NOT push
      // a per-candidate GoalView here, because each candidate's tier-done is a
      // panelCandidate flush that flips a PANELIST, never a goal — so N goal cards
      // would be left stuck '◐ running' after the panel turn. Outside panel mode
      // (sequential tiers) each tier owns exactly one goal, settled at its
      // boundary / final. So we append a goal only when NOT in panel mode.
      const agent: AgentView = {
        provider: action.provider,
        model: action.model,
        state: 'running',
        tokens: 0,
        attempt: action.attempt,
      };
      const goal: GoalView = {
        id: `${action.tier}#${action.attempt}`,
        // Phase 2: lead with the human goal title when the engine supplied one;
        // fail soft to the bare tier id so the card is never blank and the count
        // is never fabricated. The tier/risk ride along for the dim badge.
        label: action.title !== undefined && action.title.length > 0 ? action.title : action.tier,
        state: 'running',
        tokens: 0,
        agents: [agent],
        tier: action.tier,
        ...(action.risk !== undefined ? { risk: action.risk } : {}),
      };
      let next: UiState = {
        ...state,
        turnActive: true,
        goals: inPanel ? state.goals : [...state.goals, goal],
        stream: {
          ...state.stream,
          ...resetTierCounters(),
          // Outside panel mode the phase becomes 'thinking'; in panel mode it
          // stays 'panel' (the one collapsed status line).
          phase: inPanel ? state.stream.phase : 'thinking',
          panelists,
          workLabel,
        },
      };
      if (isVerbose) {
        next = commit(next, {
          kind: 'telemetry',
          text: `▶ ${action.tier} (${action.provider}/${action.model})`,
        });
      }
      return next;
    }

    // -- prose: already-cleaned. Apply render.ts's fresh-line heuristics, then
    //    append. The streaming `●` marker is view chrome (3b), tracked here via
    //    markerEmitted. breakBeforeNextProse (tier boundary mid-answer) and
    //    toolSinceProse (a tool ran since last prose) each insert a single '\n'
    //    BEFORE the resumed text — but only when prose has already started (never
    //    before the very first delta).
    case 'stream/prose': {
      const s = state.stream;
      let buffer = s.buffer;
      if (s.breakBeforeNextProse && s.proseStarted) buffer += '\n';
      if (s.toolSinceProse && s.proseStarted) buffer += '\n';
      buffer += action.text;
      return withStream(state, {
        buffer,
        phase: 'streaming',
        proseStarted: true,
        attemptHadProse: true,
        markerEmitted: true,
        breakBeforeNextProse: false,
        toolSinceProse: false,
        streamedChars: s.streamedChars + action.text.length,
      });
    }

    // -- tool: verbose prints a `[tool] name phase` line; normal/quiet counts a
    //    step and marks toolSinceProse so the next prose starts on a fresh line.
    case 'stream/tool': {
      if (action.verbosity === 'verbose') {
        return commit(state, { kind: 'telemetry', text: `[tool] ${action.name} ${action.phase}` });
      }
      return withStream(state, {
        stepCount: state.stream.stepCount + 1,
        toolSinceProse: true,
      });
    }

    // -- reasoning: verbose prints the raw delta (internal thinking shown only in
    //    verbose); normal/quiet keeps the spinner alive (no committed text, no
    //    counter change beyond keeping phase non-idle).
    case 'stream/reasoning': {
      if (action.verbosity === 'verbose') {
        return commit(state, { kind: 'telemetry', text: action.text });
      }
      // ensureAlive(): keep the live indicator; nothing visible commits.
      const phase = state.stream.phase === 'idle' ? 'thinking' : state.stream.phase;
      return withStream(state, { phase });
    }

    // -- tier-done. Two paths, exactly mirroring render.ts:
    //   (a) panel candidate (panelMode && synthesizing===null): flip the first
    //       still-running panelist to done, accumulate tokens, do NOT commit/reset
    //       prose. Verbose also commits a per-tier telemetry line.
    //   (b) normal tier boundary: commit the buffered prose, account tokens, set
    //       breakBeforeNextProse if this tier had prose, reset attempt flags.
    //       Verbose commits the per-tier telemetry line.
    case 'stream/flush-tier': {
      const isVerbose = action.verbosity === 'verbose';
      // Clamp the per-tier token figure at the accumulation point: a malformed
      // provider usage event (NaN, Infinity, or negative input/output counts)
      // must never poison the running turn/session totals or the TokenMeter
      // (which would render `NaN` / a negative figure). Floor at 0 and treat any
      // non-finite sum as 0.
      const rawTierTokens = action.inputTokens + action.outputTokens;
      const tierTokens = Number.isFinite(rawTierTokens) ? Math.max(0, rawTierTokens) : 0;
      const telemetry: TranscriptLine = {
        kind: 'telemetry',
        text:
          `${action.success ? '✓' : '✗'} tier done — ` +
          `confidence: ${renderConfidencePlain(action.confidence)}, ` +
          `${formatTokens(tierTokens)} tokens, ` +
          `duration: ${action.durationMs}ms`,
      };

      if (action.panelCandidate) {
        // Flip the first still-running panelist (candidate dones arrive in
        // announce order).
        let flipped = false;
        const panelists = state.stream.panelists.map((p) => {
          if (!flipped && p.state === 'running') {
            flipped = true;
            return { ...p, state: 'done' as const, tokens: tierTokens };
          }
          return p;
        });
        let next: UiState = {
          ...state,
          tokens: { turn: state.tokens.turn + tierTokens, session: state.tokens.session + tierTokens },
          stream: { ...state.stream, panelists },
        };
        if (isVerbose) next = commit(next, telemetry);
        return next;
      }

      // Normal tier boundary: commit buffered prose, then reset the stream tail.
      let next: UiState = state;
      if (state.stream.buffer.length > 0) {
        next = commit(next, { kind: 'prose', text: state.stream.buffer });
      }
      const attemptHadProse = state.stream.attemptHadProse;
      next = {
        ...next,
        goals: settleActiveGoal(next.goals, action.success ? 'done' : 'failed', tierTokens),
        tokens: { turn: next.tokens.turn + tierTokens, session: next.tokens.session + tierTokens },
        stream: {
          ...next.stream,
          buffer: '',
          attemptHadProse: false,
          toolSinceProse: false,
          // A tier boundary crossed mid-answer → the NEXT tier's first prose starts
          // on a fresh line (render.ts: if (attemptHadProse) breakBeforeNextProse = true).
          breakBeforeNextProse: attemptHadProse ? true : next.stream.breakBeforeNextProse,
          markerEmitted: false,
        },
      };
      if (isVerbose) next = commit(next, telemetry);
      return next;
    }

    // -- escalate: normal → a fixed dim refinement line; verbose → the detailed
    //    "↑ Escalating from → to: reason" line.
    case 'escalate': {
      const text =
        action.verbosity === 'verbose'
          ? `↑ Escalating ${action.from} → ${action.to}: ${action.reason}`
          : '↑ low confidence — refining with a stronger model…';
      return commit(state, { kind: 'escalate', text });
    }

    // -- failover: verbose-only routing chrome. Normal/quiet → no visible line.
    case 'failover': {
      if (action.verbosity !== 'verbose') return state;
      return commit(state, {
        kind: 'failover',
        text: `⇄ Failing over ${action.from} → ${action.to} (${action.tier}): ${action.reason}`,
      });
    }

    // -- notice: keyed exactly like render.ts.
    //    * errors ALWAYS show ([error] message).
    //    * verbose shows every info/warn ([warn]/[info] message).
    //    * in normal/quiet, three info/warn shapes surface:
    //        - spend-unknown warn  → a yellow [warn] line
    //        - panel header / hedge → a dim `⋮ message` line
    //      everything else is verbose-only chrome (no line).
    case 'notice': {
      if (action.level === 'error') {
        return commit(state, { kind: 'error', text: `[error] ${action.message}` });
      }
      const isVerbose = action.verbosity === 'verbose';
      const isPanelHeader =
        action.level === 'info' &&
        (action.message.startsWith('Panel: ') || action.message.startsWith('Panel (hard turn): '));
      const isHedge = action.level === 'info' && action.message.startsWith('hedge: primary slow');
      const isSpendUnknown = action.level === 'warn' && action.message.startsWith('Spend unknown —');

      if (isVerbose) {
        const prefix = action.level === 'warn' ? '[warn]' : '[info]';
        return commit(state, {
          kind: action.level === 'warn' ? 'warn' : 'notice',
          text: `${prefix} ${action.message}`,
        });
      }
      if (isSpendUnknown) {
        return commit(state, { kind: 'warn', text: `[warn] ${action.message}` });
      }
      if (isPanelHeader || isHedge) {
        return commit(state, { kind: 'notice', text: `⋮ ${action.message}` });
      }
      return state; // verbose-only chrome suppressed in normal/quiet
    }

    // -- final: commit any remaining buffered prose, clear turnActive, then append
    //    the outcome line per render.ts's branch order:
    //      canceled → "■ Cancelled" (non-quiet)
    //      !success:
    //        timeout    → the friendly two-line timeout message (non-quiet)
    //        else       → optional actionable CLI error (always) + "Failed — …" (non-quiet)
    //      success:
    //        questions  → suppress the completion line entirely
    //        bestEffort → the best-effort caveat (non-quiet) THEN the success line
    //        verbose    → "Success — tier:…"
    //        normal     → "✓ done · N tokens[ · Ns]"
    //        quiet      → nothing
    case 'turn/final': {
      const isVerbose = action.verbosity === 'verbose';
      const isQuiet = action.verbosity === 'quiet';
      // Flush any held-back prose first (render.ts: prose.flush() before the line).
      let next: UiState = state;
      if (state.stream.buffer.length > 0) {
        next = commit(next, { kind: 'prose', text: state.stream.buffer });
      }
      // The turn is over: clear live status + mark inactive. Any goal still
      // `running` (e.g. a turn that ended without a non-panel tier boundary, or
      // a failure) settles to the turn's outcome so a late reader of the final
      // state sees a coherent goal glyph rather than a stuck `running` card.
      next = {
        ...next,
        goals: settleAllRunningGoals(next.goals, action.success ? 'done' : 'failed'),
        turnActive: false,
        stream: { ...initialStreamView, buffer: '' },
      };

      const tokenStr = formatTokens(next.tokens.turn);

      if (action.canceled === true) {
        if (!isQuiet) next = commit(next, { kind: 'completion', text: '■ Cancelled' });
        return next;
      }

      if (!action.success) {
        if (action.errorCategory === 'timeout') {
          if (!isQuiet) {
            next = commit(
              next,
              {
                kind: 'completion',
                text: "That ran past the single-turn time limit — it's a big task, not a crash.",
              },
              {
                kind: 'completion',
                text:
                  `Timed out after one turn · tier: ${action.tier} · ${tokenStr} tokens · ` +
                  `attempts: ${action.attempts} · session: ${action.sessionId}`,
              },
            );
          }
          return next;
        }
        // Actionable CLI error (pre-rendered by the impure caller) — always shown.
        if (action.actionableError !== undefined && action.actionableError.length > 0) {
          next = commit(next, { kind: 'error', text: action.actionableError });
        }
        if (!isQuiet) {
          next = commit(next, {
            kind: 'completion',
            text:
              `Failed — tier: ${action.tier}, ${tokenStr} tokens, ` +
              `attempts: ${action.attempts}, session: ${action.sessionId}`,
          });
        }
        return next;
      }

      // success
      if (action.hasQuestions === true) {
        // Suppress the completion line entirely — the caller drives a selector.
        return next;
      }
      if (action.bestEffort === true && !isQuiet) {
        next = commit(next, {
          kind: 'completion',
          text:
            'Best-effort answer — reached the attempt limit without a fully-confident result; ' +
            'treat the above as unverified.',
        });
      }
      if (isVerbose) {
        next = commit(next, {
          kind: 'completion',
          text:
            `Success — tier: ${action.tier}, ${tokenStr} tokens, ` +
            `attempts: ${action.attempts}, session: ${action.sessionId}`,
        });
      } else if (!isQuiet) {
        const secs = action.elapsedSecs ?? 0;
        const elapsedStr = secs > 0 ? ` · ${secs}s` : '';
        next = commit(next, {
          kind: 'completion',
          text: `✓ done · ${tokenStr} tokens${elapsedStr}`,
        });
      }
      return next;
    }
  }
}

// ---------------------------------------------------------------------------
// confidence — the plain-text mirror of render.ts renderConfidence (the view
// layer applies green/yellow/red by threshold in 3b; the text is identical).
// ---------------------------------------------------------------------------

function renderConfidencePlain(confidence: number | null): string {
  if (confidence === null) return 'unrated';
  return `${Math.round(confidence * 100)}%`;
}
