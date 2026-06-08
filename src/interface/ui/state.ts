/**
 * src/interface/ui/state.ts — the immutable UI state + Action union for the
 * MVU (model-view-update) core of the Ink chat UI (STEP 3a).
 *
 * PURE: this module imports NO Ink/React, performs NO I/O, and calls NO
 * Date.now/Math.random/fs. It is a plain data model exercised by the regular
 * `npm test` suite under strip-types. It is the faithful, testable
 * re-expression of `renderStream` (src/interface/render.ts): the reducer in
 * `reduce.ts` turns the CoreEvent-derived `Action` stream into successive
 * `UiState` snapshots whose VISIBLE TEXT matches what `renderStream` writes to
 * its OutputSink.
 *
 * BOUNDARY (see render.ts / stream-filter.ts): the stateful EnvelopeFilter that
 * strips the trailing confidence envelope stays in the IMPURE layer (3b owns
 * per-tier instances). The reducer therefore receives ALREADY-CLEANED prose via
 * the `stream/prose` action and merely appends it — envelope-stripping
 * correctness is covered by stream-filter.test.ts, never re-done here.
 */

import type { Risk, Tier } from '../../core/types.js';
import type { ProviderId } from '../../providers/port.js';
import type { ErrorCategory } from '../../providers/errors.js';

// ---------------------------------------------------------------------------
// View sub-shapes
// ---------------------------------------------------------------------------

/**
 * One committed line of transcript. `kind` is purely advisory chrome metadata
 * for the renderer (e.g. style a notice dim, an error red); the reducer fills it
 * so the view layer doesn't re-derive intent from the text. `text` is the
 * already-final, user-visible string (no ANSI — colour is the view's job in 3b).
 */
export interface TranscriptLine {
  readonly kind:
    | 'raw' // a chrome line the impure OutputSink wrote (echoed prompt, ※ recap,
    //        resume transcript, inter-turn menu chrome, /mode output, etc.); the
    //        text already carries any ANSI styling — the view paints it verbatim.
    | 'prose' // committed model answer prose
    | 'notice' // a dim ⋮ panel-header / hedge notice
    | 'warn' // a yellow [warn] line (e.g. spend-unknown)
    | 'error' // an [error] line / actionable CLI error (always shown)
    | 'escalate' // the escalation refinement line
    | 'failover' // verbose-only failover line
    | 'telemetry' // verbose-only per-tier "tier done — …" line
    | 'classified' // verbose/debug classifier metadata
    | 'completion'; // the final ✓ done / Failed / Cancelled / timeout / best-effort line
  readonly text: string;
}

/** The run state of a goal (tier) or a panel agent. */
export type AgentRunState = 'queued' | 'running' | 'done' | 'failed';

/** One model attempt within a goal — the provider/model and its live counters. */
export interface AgentView {
  readonly provider: ProviderId;
  readonly model: string;
  readonly state: AgentRunState;
  readonly tokens: number;
  readonly attempt: number;
}

/** A unit of work (a tier attempt) shown in the live status region. */
export interface GoalView {
  readonly id: string;
  /**
   * The HEADLINE label shown bold on the goal card. The human goal title when the
   * engine supplied one (Phase 2 — work objective / intent goal / capped task),
   * else the bare tier id (`worker`/`ic`/`manager`) as a fail-soft fallback. Never
   * blank, never fabricated.
   */
  readonly label: string;
  readonly state: AgentRunState;
  readonly tokens: number;
  readonly agents: readonly AgentView[];
  /**
   * The routing TIER this goal ran at — kept distinct from `label` so the view can
   * render it as the dim "tier · risk" secondary badge even when `label` is a human
   * title. Always present (the tier is always known at tier-start).
   */
  readonly tier: Tier;
  /**
   * The classified RISK for the dim badge ("ic · medium"). A real classifier
   * measurement; absent → the badge shows the tier only (never a fabricated risk).
   */
  readonly risk?: Risk;
  /**
   * OPTIONAL per-goal PHASE progress (multi-goal seam). `current`/`total` come
   * from a future scheduler's `goal-phase` event — a TRUTHFUL denominator (the
   * planned phase count), so the card can show a "phase X/Y" badge. Absent →
   * no phase badge is rendered (never fabricated, matching the `risk?` pattern).
   * Never set on today's single-goal path (no `goal-phase` event is emitted).
   */
  readonly phase?: { readonly current: number; readonly total: number };
}

/** The execution phase that drives the live status line / spinner verb. */
export type StreamPhase = 'idle' | 'thinking' | 'panel' | 'synthesis' | 'streaming';

/**
 * The live (not-yet-committed) status region: the in-flight prose buffer, the
 * spinner phase + step/char counters, the panel strip, and the synthesis count.
 * This mirrors render.ts's mutable locals (prose buffer, stepCount,
 * streamedChars, panelMode/panelists/synthesizing, the tool/break flags).
 */
export interface StreamView {
  /** Cleaned prose streamed in the current tier, not yet committed. */
  readonly buffer: string;
  readonly phase: StreamPhase;
  /** render.ts `stepCount` — tool/reasoning steps in the current tier. */
  readonly stepCount: number;
  /** render.ts `streamedChars` — bytes of prose this tier (≈4 chars/token). */
  readonly streamedChars: number;
  /** The dim interrupt hint shown under the status line, when set. */
  readonly interruptHint?: string;
  /** The ordered panel candidate strip (render.ts `panelists`). */
  readonly panelists: readonly AgentView[];
  /** Non-null once the synthesizer starts (render.ts `synthesizing`). */
  readonly synthesizing: { readonly count: number } | null;
  /** render.ts `workLabel` — the spinner verb ("Thinking" / verbose tier label). */
  readonly workLabel: string;
  /** render.ts `toolSinceProse` — a tool ran since the last prose delta, so the
   *  next prose delta starts on a fresh line. */
  readonly toolSinceProse: boolean;
  /** render.ts `breakBeforeNextProse` — a tier boundary crossed mid-answer, so
   *  the next tier's first prose delta starts on a fresh line. */
  readonly breakBeforeNextProse: boolean;
  /** render.ts `proseStarted` — any prose has streamed this turn (gates the
   *  newline-before-resumed-prose heuristics). */
  readonly proseStarted: boolean;
  /** render.ts `attemptHadProse` — the current tier produced prose. */
  readonly attemptHadProse: boolean;
  /** Whether the streaming `●` turn marker has been emitted for the current
   *  answer block (render.ts emits it once before the first prose delta). */
  readonly markerEmitted: boolean;
}

/** Token accounting: the running turn total (render.ts `runningTokens`) and the
 *  session-cumulative total. */
export interface TokenView {
  readonly turn: number;
  readonly session: number;
}

/**
 * The whole immutable UI model. `committed` is the append-only transcript
 * (everything `renderStream` has written as a finished line); `stream` is the
 * live status region; `goals` is the structured work view; `turnActive` is true
 * between the first event of a turn and its `final`.
 */
export interface UiState {
  readonly committed: readonly TranscriptLine[];
  /**
   * The EPHEMERAL "live frame" region: transient chrome (e.g. the interactive
   * MENU) that is REDRAWN whole on every loop iteration and must NOT accumulate in
   * the append-only `committed[]` transcript. It is rendered in a normal (NON
   * `<Static>`) `<Box>` so each frame REPLACES the previous one in place, instead
   * of committing ~30 fresh `<Static>` items per keypress (the menu-lag root
   * cause). The impure OutputSink fills it between `beginFrame()`/`endFrame()`;
   * `endFrame()` REPLACES the whole array (never appends). Empty between frames.
   */
  readonly chrome: readonly TranscriptLine[];
  readonly goals: readonly GoalView[];
  readonly stream: StreamView;
  readonly turnActive: boolean;
  readonly tokens: TokenView;
}

// ---------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------

export const initialStreamView: StreamView = {
  buffer: '',
  phase: 'idle',
  stepCount: 0,
  streamedChars: 0,
  panelists: [],
  synthesizing: null,
  workLabel: 'Thinking',
  toolSinceProse: false,
  breakBeforeNextProse: false,
  proseStarted: false,
  attemptHadProse: false,
  markerEmitted: false,
};

export const initialState: UiState = {
  committed: [],
  chrome: [],
  goals: [],
  stream: initialStreamView,
  turnActive: false,
  tokens: { turn: 0, session: 0 },
};

// ---------------------------------------------------------------------------
// Verbosity (mirrors render.ts `Verbosity`)
// ---------------------------------------------------------------------------

export type Verbosity = 'quiet' | 'normal' | 'verbose';

// ---------------------------------------------------------------------------
// Action union — CoreEvent-derived structural actions + the explicit text /
// flush / final actions. Every action is plain-data and serializable.
// ---------------------------------------------------------------------------

export type Action =
  // --- turn/start: reset ONLY the per-turn slice (stream, goals, turn-active,
  //     per-turn token counter) at the START of a turn, PRESERVING committed[]
  //     and tokens.session. This is what makes ONE persistent UiState span every
  //     turn of a session: the transcript and the session token total carry
  //     forward (session tokens ACCUMULATE), so <Static>'s committed[] only ever
  //     GROWS across turns (never shrinks/regrows — Ink 6's append-only contract).
  | { readonly type: 'turn/start' }
  // --- commit/raw: append ONE already-final chrome line (text the impure
  //     OutputSink wrote — echoed prompt, the ※ recap, resume transcript,
  //     inter-turn menu chrome, /mode output, error notices) into the SAME
  //     committed transcript the reducer prose commits feed. One growing source
  //     of truth → no out.write chrome is lost and <Static> stays monotonic.
  | { readonly type: 'commit/raw'; readonly text: string }
  // --- chrome/replace: REPLACE the ephemeral live-frame region (state.chrome)
  //     with a whole fresh set of lines. Used by the menu loop (via the
  //     OutputSink's beginFrame/endFrame) so the interactive menu is repainted in
  //     a bounded NON-<Static> region instead of appending ~30 committed items per
  //     keypress. Replaces — never appends — so chrome[] does NOT grow with redraws.
  | { readonly type: 'chrome/replace'; readonly lines: readonly string[] }
  // --- chrome/clear: empty the ephemeral live-frame region (on exiting a frame
  //     into a non-frame surface, e.g. when the menu hands off to chat/a sub-flow).
  | { readonly type: 'chrome/clear' }
  // --- chrome/promote: move the CURRENT live-frame region into the permanent
  //     committed transcript and clear the live region. Used when the menu hands
  //     off to a sub-flow so the just-shown menu lingers in scrollback above the
  //     sub-flow output (legacy-TTY parity) WITHOUT re-buffering its text.
  | { readonly type: 'chrome/promote' }
  // --- classifier metadata (verbose/MYSHELL_DEBUG only) ---
  | {
      readonly type: 'classified';
      readonly tier: Tier;
      readonly risk: string;
      readonly rationale: string;
      readonly verbosity: Verbosity;
      /** True iff MYSHELL_DEBUG is set (computed impurely by the caller). */
      readonly debug: boolean;
    }
  // --- intent / engagement: no visible effect in normal mode (render-optional) ---
  | { readonly type: 'intent' }
  | { readonly type: 'engagement' }
  // --- phase: panel pre-announce + synthesis switch ---
  | {
      readonly type: 'phase/panel';
      readonly participants: readonly ProviderId[];
    }
  | { readonly type: 'phase/synthesis'; readonly count: number }
  // --- a tier (model attempt) starts ---
  | {
      readonly type: 'tier-start';
      readonly tier: Tier;
      readonly provider: ProviderId;
      readonly model: string;
      readonly attempt: number;
      readonly verbosity: Verbosity;
      /** Human goal label (Phase 2); absent → the reducer labels with the tier. */
      readonly title?: string;
      /** Classified risk for the dim "tier · risk" badge; absent → tier-only badge. */
      readonly risk?: Risk;
      /**
       * OPTIONAL multi-goal seam: the stable goal id this tier belongs to. When
       * present and it matches an already-enqueued/running goal, the reducer
       * attaches the tier to THAT goal (flipping a queued goal to running) instead
       * of appending a fresh per-tier goal; absent → today's per-tier keying,
       * byte-for-byte unchanged. Never set on the single-goal path.
       */
      readonly goalId?: string;
    }
  // --- already-cleaned prose chunk (envelope already stripped by 3b's filter) ---
  | { readonly type: 'stream/prose'; readonly text: string }
  // --- a tool call ran (verbose prints a line; normal counts a step) ---
  | {
      readonly type: 'stream/tool';
      readonly name: string;
      readonly phase: 'start' | 'end';
      readonly verbosity: Verbosity;
    }
  // --- a reasoning delta (verbose prints it; normal keeps the spinner alive) ---
  | { readonly type: 'stream/reasoning'; readonly text: string; readonly verbosity: Verbosity }
  // --- commit the buffered prose at a tier boundary + account tokens ---
  | {
      readonly type: 'stream/flush-tier';
      readonly tier: Tier;
      readonly success: boolean;
      readonly confidence: number | null;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly durationMs: number;
      /** True iff this tier-done is a panel CANDIDATE (panel mode, pre-synthesis):
       *  it flips a panelist and accounts tokens but does NOT commit/reset prose. */
      readonly panelCandidate: boolean;
      readonly verbosity: Verbosity;
      /**
       * OPTIONAL multi-goal seam: settle the goal matching this id when several
       * run concurrently. Absent → settle the lone running goal (today's exact
       * behaviour). Never set on the single-goal path.
       */
      readonly goalId?: string;
    }
  // --- goal/enqueue: append a QUEUED goal card (multi-goal seam). Additive — no
  //     emitter produces the source goal-enqueue event today, so this never fires
  //     on the single-goal path. ---
  | {
      readonly type: 'goal/enqueue';
      readonly goalId: string;
      readonly label: string;
    }
  // --- goal/phase: set a goal's phase {current,total} for the "phase X/Y" badge
  //     (multi-goal seam). Additive — no emitter today. ---
  | {
      readonly type: 'goal/phase';
      readonly goalId: string;
      readonly current: number;
      readonly total: number;
    }
  // --- escalation to a stronger tier ---
  | {
      readonly type: 'escalate';
      readonly from: Tier;
      readonly to: Tier;
      readonly reason: string;
      readonly verbosity: Verbosity;
    }
  // --- failover to another provider (verbose-only line) ---
  | {
      readonly type: 'failover';
      readonly from: ProviderId;
      readonly to: ProviderId;
      readonly tier: Tier;
      readonly reason: string;
      readonly verbosity: Verbosity;
    }
  // --- a notice (info/warn/error), keyed by message shape + verbosity ---
  | {
      readonly type: 'notice';
      readonly level: 'info' | 'warn' | 'error';
      readonly message: string;
      readonly verbosity: Verbosity;
    }
  // --- terminal: commit remaining prose + the completion/Failed/Cancelled line ---
  | {
      readonly type: 'turn/final';
      readonly success: boolean;
      readonly tier: Tier;
      readonly attempts: number;
      readonly sessionId: string;
      readonly verbosity: Verbosity;
      readonly canceled?: boolean;
      readonly errorCategory?: ErrorCategory;
      readonly provider?: ProviderId;
      /** True iff the final carried a structured-question set (suppresses the
       *  completion line — the caller drives a selector). */
      readonly hasQuestions?: boolean;
      readonly bestEffort?: boolean;
      /** The real elapsed seconds the spinner was visible, for the success line's
       *  `· Ns` suffix. Injected (never fabricated) — 0/absent omits the suffix. */
      readonly elapsedSecs?: number;
      /** The actionable CLI error text (provider-prefixed), pre-rendered by the
       *  impure caller via cliErrorForCategory/formatErrorMessage. When present on
       *  a failing final, committed as an `error` line before the Failed line. */
      readonly actionableError?: string;
    };
