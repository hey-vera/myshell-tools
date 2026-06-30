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
  type GoalBoardRow,
  type GoalView,
  type StreamView,
  type TranscriptLine,
  type UiState,
  initialStreamView,
  PROSE_BUFFER_CAP,
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
  goalId?: string,
): readonly GoalView[] {
  let idx = -1;
  if (goalId !== undefined) {
    // Multi-goal seam: settle the goal that OWNS this tier (keyed by id) so the
    // right card flips when several run concurrently. Fail-soft: if no goal
    // carries the id, fall through to the lone-running search below.
    idx = goals.findIndex((g) => g.id === goalId && g.state === 'running');
    if (idx === -1) {
      // The keyed goal isn't running (already settled / never started) — nothing
      // to flip for this id; do NOT touch another goal.
      if (goals.some((g) => g.id === goalId)) return goals;
    }
  }
  if (idx === -1 && goalId === undefined) {
    // Single-goal path (today): settle the LAST still-running goal — the active
    // sequential attempt. Byte-for-byte the original behaviour.
    for (let i = goals.length - 1; i >= 0; i -= 1) {
      if (goals[i]?.state === 'running') {
        idx = i;
        break;
      }
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

/**
 * Map a REAL tool name to a friendly present-tense verb for the live action line.
 * Only HONEST, unambiguous mappings are made; anything unrecognised returns the
 * raw tool name verbatim (never an invented verb). The provider tool names seen in
 * practice: Claude exposes the literal tool names (Edit/Write/Read/Bash/Grep/Glob/
 * …); codex emits coarse activity kinds (command_execution / file_change /
 * mcp_tool_call); opencode emits its own tool names. PURE.
 */
function toolVerb(name: string): string {
  const n = name.toLowerCase();
  // file edits / writes
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'notebookedit' || n === 'file_change') {
    return 'editing';
  }
  // reads
  if (n === 'read' || n === 'notebookread') return 'reading';
  // shell / command execution
  if (n === 'bash' || n === 'command_execution' || n === 'shell') return 'running';
  // search
  if (n === 'grep' || n === 'glob' || n === 'search' || n === 'list' || n === 'ls') return 'searching';
  // web
  if (n === 'webfetch' || n === 'fetch') return 'fetching';
  if (n === 'websearch') return 'searching the web';
  // a tool-call to another tool/server — show the raw name (honest, not invented).
  // Default: the raw tool name (never fabricated).
  return name;
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
        // Clear any ephemeral menu/frame chrome — a turn means we left the menu,
        // so the live-frame region must not linger above the streaming answer.
        chrome: [],
        stream: initialStreamView,
        // Flip turnActive TRUE the instant a turn begins so the live status block
        // / spinner appears immediately on submit. Previously this stayed false
        // until the first real event (classified/intent/phase/tier-start), which
        // can be seconds away (classification + cold provider spawn), leaving the
        // UI looking frozen. With turnActive true and the fresh initialStreamView
        // (phase 'idle', workLabel 'Thinking', 0 steps), StatusBlock renders a
        // sensible immediate "⠋ Thinking… · 0s" line — no goals panel yet (it
        // stays hidden until goals arrive), never empty, never a crash.
        // turn/final still settles turnActive back to false.
        turnActive: true,
        tokens: { turn: 0, session: state.tokens.session },
      };

    case 'turn/reset':
      return {
        ...state,
        goals: [],
        stream: initialStreamView,
        turnActive: false,
        tokens: { turn: 0, session: state.tokens.session },
      };

    // -- commit/raw: append ONE already-final chrome line (whatever the impure
    //    OutputSink wrote) into the SAME committed transcript the reducer prose
    //    commits feed. One growing source of truth → <Static> stays monotonic and
    //    no out.write chrome is lost between turns.
    case 'commit/raw':
      return commit(state, { kind: 'raw', text: action.text });

    case 'stream/narration':
      return commit(
        state,
        ...action.lines.map((text) => ({ kind: 'telemetry' as const, text })),
      );

    // -- chrome/replace: swap the ephemeral live-frame region wholesale. The menu
    //    loop redraws its full chrome every keypress; routing it here (instead of
    //    commit/raw) means the frame REPLACES the prior one in a bounded NON-<Static>
    //    box rather than appending ~30 permanent items per redraw. committed[] is
    //    untouched, so the append-only transcript invariant holds and the menu lag
    //    (unbounded <Static> growth) is gone.
    case 'chrome/replace':
      return { ...state, chrome: action.lines.map((text) => ({ kind: 'raw' as const, text })) };

    // -- chrome/clear: empty the live-frame region (menu → chat / sub-flow handoff).
    case 'chrome/clear':
      return state.chrome.length === 0 ? state : { ...state, chrome: [] };

    // -- chrome/promote: fold the live-frame region into committed[] and clear it
    //    (menu → sub-flow handoff: the menu lingers in scrollback, legacy parity).
    case 'chrome/promote':
      return state.chrome.length === 0
        ? state
        : { ...state, committed: [...state.committed, ...state.chrome], chrome: [] };

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
      // Multi-goal seam: when the event carries a stable goalId that matches an
      // already-enqueued/running goal, ATTACH this tier to THAT goal (flip a
      // queued goal to running, push the agent) instead of appending a fresh
      // per-tier card — this is what lets several goals run concurrently. When
      // goalId is ABSENT and the persistent board is OFF, keep today's original
      // single-turn card. When the board is ON, an unkeyed tier-start is plain
      // chat execution, not a staged/running goal, so it must not create a goal row.
      // Never mutates input arrays.
      const existingIdx =
        action.goalId !== undefined
          ? state.goals.findIndex((g) => g.id === action.goalId)
          : -1;
      // The title is safe to show only on an actual GoalView. Board mode gets real
      // goals from board/sync + goalId attachment; unkeyed plain-chat starts skip the
      // GoalView branch below instead of falling back to the tier as a fake title.
      const honestTitle = action.title;
      const goal: GoalView = {
        // Key off the scheduler-assigned goalId when present (stable across the
        // goal's phases); else the original per-tier id, byte-for-byte unchanged.
        id: action.goalId !== undefined ? action.goalId : `${action.tier}#${action.attempt}`,
        // Phase 2: lead with the human goal title when the engine supplied one;
        // fail soft to the bare tier id so the card is never blank and the count
        // is never fabricated. The tier/risk ride along for the dim badge.
        label: honestTitle !== undefined && honestTitle.length > 0 ? honestTitle : action.tier,
        state: 'running',
        tokens: 0,
        toolCount: 0,
        agents: [agent],
        tier: action.tier,
        ...(action.risk !== undefined ? { risk: action.risk } : {}),
      };
      let nextGoals: readonly GoalView[];
      if (inPanel) {
        nextGoals = state.goals;
      } else if (existingIdx !== -1) {
        // Attach to the matched goal: flip it running, push the new agent, keep
        // its existing phase/label/risk unless this tier-start supplies a title.
        nextGoals = state.goals.map((g, i) => {
          if (i !== existingIdx) return g;
          const label =
            honestTitle !== undefined && honestTitle.length > 0 ? honestTitle : g.label;
          return {
            ...g,
            label,
            state: 'running' as const,
            tier: action.tier,
            ...(action.risk !== undefined ? { risk: action.risk } : {}),
            agents: [...g.agents, agent],
            // preserve dependsOn if present
          };
        });
      } else if (state.boardEnabled && action.goalId === undefined) {
        nextGoals = state.goals;
      } else {
        nextGoals = [...state.goals, goal];
      }
      return {
        ...state,
        turnActive: true,
        goals: nextGoals,
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
    }

    // -- goal/enqueue: append a QUEUED goal card (multi-goal seam). Marks the
    //    goal visible before any tier starts so the user sees "queued" up front.
    //    Keyed by the scheduler-assigned goalId (which a later tier-start re-uses
    //    to flip it running). Idempotent: a duplicate id is ignored rather than
    //    appended twice. No emitter produces the source event today, so this is
    //    never reached on the single-goal path.
    case 'goal/enqueue': {
      if (state.goals.some((g) => g.id === action.goalId)) return state;
      const goal: GoalView = {
        id: action.goalId,
        label: action.label.length > 0 ? action.label : action.goalId,
        state: 'queued',
        tokens: 0,
        toolCount: 0,
        agents: [],
        // A queued goal has no routed tier yet; default to the lightest tier for
        // the dim badge (the real tier lands when its tier-start attaches).
        tier: 'worker',
        ...(action.dependsOn && action.dependsOn.length ? { dependsOn: action.dependsOn } : {}),
      };
      return { ...state, turnActive: true, goals: [...state.goals, goal] };
    }

    // -- goal/phase: set a goal's phase {current,total} for the "phase X/Y" badge
    //    (multi-goal seam). Fail-soft: an unknown goalId is a no-op (never creates
    //    a phantom goal). No emitter today → never reached on the single-goal path.
    case 'goal/phase': {
      if (!state.goals.some((g) => g.id === action.goalId)) return state;
      return {
        ...state,
        goals: state.goals.map((g) =>
          g.id === action.goalId
            ? { ...g, phase: { current: action.current, total: action.total } }
            : g,
        ),
      };
    }

    // -- board/sync: REPLACE the persistent goal board with the menu's fresh
    //    GoalStore snapshot (Elite-partner Phase 1). Pure replace, mirroring the
    //    chrome/replace pattern. `enabled` flips boardEnabled (the menu only sends
    //    this action when the board flag is on). For each synced row we re-derive
    //    the LIVE agent count from `state.goals` — the reducer-owned, REAL
    //    attach-by-goalId truth (reduce.ts tier-start branch) — so a running goal's
    //    "N agents" is the actual number of attached agents this turn, never the
    //    snapshot's stale value. A goal not running on the current turn keeps 0.
    case 'board/sync': {
      const liveAgentsById = new Map<string, number>();
      for (const g of state.goals) {
        if (g.state === 'running') {
          liveAgentsById.set(g.id, (liveAgentsById.get(g.id) ?? 0) + g.agents.length);
        }
      }
      const board: GoalBoardRow[] = action.rows.map((row) => {
        const live = liveAgentsById.get(row.id);
        return live !== undefined ? { ...row, agents: live } : row;
      });
      return { ...state, board, boardEnabled: action.enabled };
    }

    // -- prose: already-cleaned. Apply render.ts's fresh-line heuristics, then
    //    append. The streaming `●` marker is view chrome (3b), tracked here via
    //    markerEmitted. breakBeforeNextProse (tier boundary mid-answer) and
    //    toolSinceProse (a tool ran since last prose) each insert a single '\n'
    //    BEFORE the resumed text — but only when prose has already started (never
    //    before the very first delta).
    case 'stream/prose': {
      const s = state.stream;
      // Build the fresh-line prefix (a tier boundary / a tool ran since last prose
      // inserts a single '\n' before resumed text — but never before the very first
      // delta). Apply it IDENTICALLY to the full accumulator and the display tail so
      // the committed prose and the displayed prose carry the same line breaks.
      let prefix = '';
      if (s.breakBeforeNextProse && s.proseStarted) prefix += '\n';
      if (s.toolSinceProse && s.proseStarted) prefix += '\n';
      const delta = prefix + action.text;
      // proseFull is the COMPLETE prose this tier — committed verbatim at the tier
      // boundary so the transcript stays the full answer. buffer is the capped
      // DISPLAY tail (only the tail is ever shown), so a very long turn can't grow
      // the per-tick layout work / memory unboundedly (BUG 2).
      const proseFull = s.proseFull + delta;
      const grown = s.buffer + delta;
      const buffer = grown.length > PROSE_BUFFER_CAP ? grown.slice(grown.length - PROSE_BUFFER_CAP) : grown;
      return withStream(state, {
        buffer,
        proseFull,
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
      if (action.verbosity === 'verbose') return state;
      // Capture the LIVE action from the real tool event (the single most useful
      // real-time signal): a friendly verb mapped from the tool NAME plus the real
      // TARGET only when the event actually carried one (`detail`). This is live-
      // status only — it commits NO transcript line and is confined to StreamView.
      const currentTool: { readonly verb: string; readonly target?: string } =
        action.detail !== undefined && action.detail.length > 0
          ? { verb: toolVerb(action.name), target: action.detail }
          : { verb: toolVerb(action.name) };
      const goals =
        action.goalId !== undefined
          ? state.goals.map((goal) =>
              goal.id === action.goalId ? { ...goal, toolCount: goal.toolCount + 1 } : goal,
            )
          : state.goals;
      return {
        ...withStream(state, {
          stepCount: state.stream.stepCount + 1,
          toolSinceProse: true,
          currentTool,
        }),
        goals,
      };
    }

    // -- reasoning: verbose prints the raw delta (internal thinking shown only in
    //    verbose); normal/quiet keeps the spinner alive (no committed text, no
    //    counter change beyond keeping phase non-idle).
    case 'stream/reasoning': {
      if (action.verbosity === 'verbose') return state;
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
      // Clamp the per-tier token figure at the accumulation point: a malformed
      // provider usage event (NaN, Infinity, or negative input/output counts)
      // must never poison the running turn/session totals or the TokenMeter
      // (which would render `NaN` / a negative figure). Floor at 0 and treat any
      // non-finite sum as 0.
      const rawTierTokens = action.inputTokens + action.outputTokens;
      const tierTokens = Number.isFinite(rawTierTokens) ? Math.max(0, rawTierTokens) : 0;

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
        return {
          ...state,
          tokens: { turn: state.tokens.turn + tierTokens, session: state.tokens.session + tierTokens },
          stream: { ...state.stream, panelists },
        };
      }

      // Normal tier boundary: commit the FULL buffered prose (proseFull — NOT the
      // capped display `buffer`, so the committed transcript stays the COMPLETE
      // answer even when the live buffer was capped), then reset the stream tail.
      let next: UiState = state;
      if (state.stream.proseFull.length > 0) {
        next = commit(next, { kind: 'prose', text: state.stream.proseFull });
      }
      const attemptHadProse = state.stream.attemptHadProse;
      // The tier's live action is over — DROP `currentTool` (destructure it out
      // rather than set it to undefined, which exactOptionalPropertyTypes forbids)
      // so the next tier's status line falls back to "Thinking" until its first
      // tool fires (never a stale verb).
      const { currentTool: _clearedTool, ...streamWithoutTool } = next.stream;
      void _clearedTool;
      next = {
        ...next,
        goals: settleActiveGoal(
          next.goals,
          action.success ? 'done' : 'failed',
          tierTokens,
          action.goalId,
        ),
        tokens: { turn: next.tokens.turn + tierTokens, session: next.tokens.session + tierTokens },
        stream: {
          ...streamWithoutTool,
          buffer: '',
          proseFull: '',
          attemptHadProse: false,
          toolSinceProse: false,
          // A tier boundary crossed mid-answer → the NEXT tier's first prose starts
          // on a fresh line (render.ts: if (attemptHadProse) breakBeforeNextProse = true).
          breakBeforeNextProse: attemptHadProse ? true : next.stream.breakBeforeNextProse,
          markerEmitted: false,
        },
      };
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
      // EXCEPT on cancel: a canceled answer is incomplete (the user hit ESC), and
      // orchestrate does NOT persist it (work-call.ts yields a canceled final with
      // no appendAcceptedAssistant). Committing the partial prose here would make
      // screen ≠ store ≠ replay and pollute the next turn's history with abandoned
      // work. So drop the buffer on cancel and go straight to "■ Cancelled" — this
      // mirrors the brain-loop cancel path, which already leaves the store clean.
      // The legacy renderStream cancel path (render.ts) is kept in lockstep so
      // run-stream-parity stays byte-identical.
      let next: UiState = state;
      if (!action.canceled && state.stream.proseFull.length > 0) {
        next = commit(next, { kind: 'prose', text: state.stream.proseFull });
      }
      // The turn is over: clear live status + mark inactive. A timeout is a
      // resumable step boundary, not evidence that the goal failed, so preserve
      // running goals for the continuation. Real failures still settle failed.
      next = {
        ...next,
        goals:
          !action.success && action.errorCategory === 'timeout'
            ? next.goals
            : settleAllRunningGoals(next.goals, action.success ? 'done' : 'failed'),
        turnActive: false,
        stream: { ...initialStreamView, buffer: '' },
      };

      const tokenStr = formatTokens(next.tokens.turn);

      if (action.canceled === true) {
        if (!isQuiet) next = commit(next, { kind: 'completion', text: '■ Cancelled' });
        return next;
      }

      if (!action.success) {
        if (action.blocked !== undefined) {
          if (!isQuiet) {
            next = commit(next, { kind: 'completion', text: '✗ Blocked' });
            next = commit(next, { kind: 'notice', text: `  Reason: ${action.blocked.reason}` });
            next = commit(next, { kind: 'notice', text: `  Next: ${action.blocked.nextAction}` });
            if (action.blocked.preservedWork.length > 0) {
              next = commit(next, {
                kind: 'notice',
                text: `  Preserved: ${action.blocked.preservedWork.slice(0, 200)}`,
              });
            }
          }
          return next;
        }
        if (action.errorCategory === 'timeout') {
          if (!isQuiet) {
            // Follow-up: classify genuine progress vs. a stuck provider and retain
            // partial streamed progress across a killed turn before auto-resuming.
            const status =
              action.timeoutContinuation === 'automatic'
                ? '⏳ That step ran long (hit the single-turn limit) — continuing…'
                : '⏳ That step ran long (hit the single-turn limit) — continue when prompted.';
            next = commit(
              next,
              {
                kind: 'completion',
                text: status,
              },
              {
                kind: 'completion',
                text:
                  `Single-turn limit reached · tier: ${action.tier} · ${tokenStr} tokens · ` +
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
      // Token segment honesty: providers map missing usage to 0, and formatTokens(0)
      // === '0', so an absent-usage turn would otherwise read "0 tokens". Omit the
      // `· N tokens` segment when the turn total is 0 — matching summarizeTurn /
      // StatusLine, which only show tokens once the figure is genuinely > 0.
      const hasTokens = next.tokens.turn > 0;
      if (isVerbose) {
        const tokenSeg = hasTokens ? `${tokenStr} tokens, ` : '';
        next = commit(next, {
          kind: 'completion',
          text:
            `Success — tier: ${action.tier}, ${tokenSeg}` +
            `attempts: ${action.attempts}, session: ${action.sessionId}`,
        });
      } else if (!isQuiet) {
        const secs = action.elapsedSecs ?? 0;
        const elapsedStr = secs > 0 ? ` · ${secs}s` : '';
        const tokenSeg = hasTokens ? ` · ${tokenStr} tokens` : '';
        next = commit(next, {
          kind: 'completion',
          text: `✓ done${tokenSeg}${elapsedStr}`,
        });
      }
      return next;
    }

    // -- goals-panel/configure: enable/disable the fullscreen panel feature.
    //    When disabled, force the panel closed and clear any highlighted goal
    //    so no stale highlight lingers when the feature is re-enabled later.
    case 'goals-panel/configure': {
      const keepHighlight =
        action.enabled && state.goalsPanel.highlightedGoalId !== undefined;
      return {
        ...state,
        goalsPanel: {
          enabled: action.enabled,
          open: action.enabled ? state.goalsPanel.open : false,
          ...(keepHighlight ? { highlightedGoalId: state.goalsPanel.highlightedGoalId } : {}),
        },
      };
    }

    // -- goals-panel/open: open the fullscreen panel. No-op when the feature is
    //    disabled (a defensive guard — the view should never call this when
    //    disabled, but the reducer is the choke point).
    case 'goals-panel/open': {
      if (!state.goalsPanel.enabled) return state;
      const h =
        action.highlightedGoalId ?? state.goalsPanel.highlightedGoalId;
      return {
        ...state,
        goalsPanel: {
          ...state.goalsPanel,
          open: true,
          ...(h !== undefined ? { highlightedGoalId: h } : {}),
        },
      };
    }

    // -- goals-panel/close: close the panel without changing enabled or highlight.
    case 'goals-panel/close': {
      return {
        ...state,
        goalsPanel: { ...state.goalsPanel, open: false },
      };
    }

    // -- goals-panel/toggle: flip open/closed. No-op when disabled.
    case 'goals-panel/toggle': {
      if (!state.goalsPanel.enabled) return state;
      return {
        ...state,
        goalsPanel: { ...state.goalsPanel, open: !state.goalsPanel.open },
      };
    }

    // -- goals-panel/highlight: set the highlighted goal id. No-op when the
    //    panel is disabled or not currently open (highlight is a visual-only
    //    affordance for an open panel).
    case 'goals-panel/highlight': {
      if (!state.goalsPanel.enabled || !state.goalsPanel.open) return state;
      return {
        ...state,
        goalsPanel: { ...state.goalsPanel, highlightedGoalId: action.goalId },
      };
    }
  }
}
