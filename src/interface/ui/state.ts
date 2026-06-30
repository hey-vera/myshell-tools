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
import type { RoadmapItemApproach } from '../../core/work-contract.js';
import type { RoadmapStatus } from '../../core/work-contract.js';
import type { ProviderId } from '../../providers/port.js';
import type { ErrorCategory } from '../../providers/errors.js';
import type { BlockedRecord } from '../../core/blocked.js';

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
  /** Live tool-call count attributed to this goal for the current turn. */
  readonly toolCount: number;
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
  /** Optional deps for full DAG viz (from scheduler GoalSpec). */
  readonly dependsOn?: readonly string[];
}

export interface GoalBoardTodoRow {
  readonly id: string;
  readonly text: string;
  readonly status: RoadmapStatus;
}

/**
 * One row of the REAL PERSISTENT GOAL BOARD (Elite-partner Phase 1) — a flat,
 * pure projection of a persisted `Goal` (src/core/goal-todo.ts) plus the LIVE
 * agent count for a goal that is currently running this turn. The board is
 * populated by a `board/sync` action the menu dispatches from `goalStore.list()`;
 * the reducer never reads the store. Every field is REAL (never fabricated):
 *  - `id`/`title`/`scope` copied from the Goal;
 *  - `state` the Goal's lifecycle state (`parked|queued|running|done|failed`);
 *  - `done`/`total` the to-do counts (`roadmapProgress`), so the row can show
 *    `N/M to-dos`;
 *  - `glyph` the pre-shaped lifecycle glyph (`goalGlyph`), so the view reuses the
 *    same vocabulary as the menu rows without re-deriving it;
 *  - `agents` the live count of running agents attached to this goal THIS turn
 *    (reusing the reducer's goalId attach branch), 0 when the goal isn't running
 *    on the current turn — a REAL count, never inflated.
 * Plain data + serializable; carries no Date/Math.
 */
export interface GoalBoardRow {
  readonly id: string;
  readonly title: string;
  readonly state: 'parked' | 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'superseded';
  readonly done: number;
  readonly total: number;
  readonly glyph: string;
  readonly scope: 'global' | 'project';
  /** Live count of running agents attached to this goal on the current turn. */
  readonly agents: number;
  /**
   * GOAL-LEVEL nesting depth (Phase 4 tree-view): 0 for a root, 1 for a direct
   * child, etc. Derived from Goal.parentGoalId by goalDepth(). Absent/0 keeps
   * the flat board byte-identical; when present, StatusBlock indents the row.
   */
  readonly depth?: number;
  /** Bounded running-goal checklist rows for the expanded persistent board view. */
  readonly todos?: readonly GoalBoardTodoRow[];
  /**
   * The goal's honest evidence-backed verdict tag (Elite-partner Part 3) — e.g.
   * `✓verified` / `~reviewed` / `✗failing` / `⚠unverified`, pre-shaped by the pure
   * goal-todo.ts `goalVerdictTag` at sync time. Present only when the goal has a
   * real recorded verdict (never fabricated); absent when none has been computed.
   */
  readonly verdict?: string;
  /** Approach (chosen + rationale) when present on the goal. Surfaced as a
   * persistent compact viz line in the board (for both parked + running goals).
   * Carried through from Goal so the StatusBlock can render "always-visible"
   * approach/rationale without re-fetch. */
  readonly approach?: RoadmapItemApproach;
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
  /**
   * The DISPLAY tail of the cleaned prose streamed in the current tier, CAPPED to
   * the last {@link PROSE_BUFFER_CAP} chars so a very long single turn cannot grow
   * it unboundedly (App re-walks it with streamWrappedRows/tailStreamToRows on every
   * ~40ms flush — O(buffer) per tick). Only the TAIL is ever displayed (the layout
   * caps it to streamCap rows), so capping the live buffer is invisible. The FULL,
   * uncapped prose lives in {@link proseFull} and is what gets COMMITTED at the tier
   * boundary / final — so the committed transcript stays the COMPLETE answer.
   */
  readonly buffer: string;
  /**
   * The COMPLETE, uncapped prose accumulated this tier — the source of the committed
   * transcript line at a tier boundary / final (NOT {@link buffer}, which is the
   * capped display tail). Reset to '' together with `buffer` at every tier boundary /
   * final. Keeping the full prose here (rather than committing the capped `buffer`)
   * is what lets us cap the transient live buffer WITHOUT ever dropping committed
   * content (screen ≠ store regression guard).
   */
  readonly proseFull: string;
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
  /**
   * The LIVE action the agent is currently performing, derived SOLELY from the
   * most recent real `tool` provider-event (never fabricated): a friendly `verb`
   * mapped from the tool name (Edit/Write→"editing", Read→"reading",
   * Bash→"running", Grep/Glob→"searching", …) — or the raw tool name when no
   * honest mapping exists — and an OPTIONAL `target` (file path / command) carried
   * ONLY when the provider event actually supplied one (`detail`). The Claude
   * subscription provider supplies no `detail`, so its tool events surface the verb
   * alone (no fabricated target). This is LIVE-STATUS state only — it is NEVER
   * committed to the transcript and never emits a transcript line. Absent until the
   * first tool event of a tier; cleared at each tier boundary. The status line
   * leads with it when present, else falls back to {@link workLabel}.
   */
  readonly currentTool?: { readonly verb: string; readonly target?: string };
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
 * The fullscreen goals-panel UI state. Every field is default-off so the panel
 * is invisible/disabled until the user explicitly turns it on via a
 * `goals-panel/configure` action. Neutrality is mandatory: no feature is
 * auto-enabled, and the panel never renders unless enabled===true.
 */
export interface GoalsPanelUiState {
  readonly enabled: boolean;
  readonly open: boolean;
  readonly highlightedGoalId?: string;
}

export type ControlPanelSection = 'status' | 'goals' | 'settings';

export interface ControlPanelUiState {
  readonly enabled: boolean;
  readonly open: boolean;
  readonly activeSection: ControlPanelSection;
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
  /**
   * The REAL PERSISTENT GOAL BOARD (Elite-partner Phase 1): a flat projection of
   * the persisted GoalStore, populated by `board/sync` and rendered ACROSS turns
   * (independent of `turnActive`). Empty `[]` until the menu syncs a snapshot in.
   * Default `[]` keeps every existing reducer transition byte-identical (the board
   * is purely additive chrome).
   */
  readonly board: readonly GoalBoardRow[];
  /**
   * Whether the persistent board feature is ON (the menu flipped it via a
   * `board/sync` with `enabled: true`). DEFAULT false → byte-for-byte today's UI:
   * the reducer keeps the `title ?? tier` per-turn label (the fake card) and the
   * layout/StatusBlock never plan or paint the board. When true, the per-turn
   * card's raw-message title is suppressed (the live region heads "WORKING") and
   * the board is painted. Lives on UiState (not env) so the pure reducer/layout
   * stay env-free and table-testable.
   */
  readonly boardEnabled: boolean;
  /** Optional pressure signal (0-3) for UI tuning. */
  readonly pressure?: number;
  /** Optional live dynamic world items for @-mention completion. */
  readonly dynamicWorldItems?: ReadonlyArray<{ prefix: string; items: readonly string[] }>;
  /** The fullscreen goals-panel UI state (default-off; see GoalsPanelUiState). */
  readonly goalsPanel: GoalsPanelUiState;
  /** The sectioned Control Panel UI state (default-off; see ControlPanelUiState). */
  readonly controlPanel: ControlPanelUiState;
}

// ---------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------

/**
 * Cap on the LIVE display {@link StreamView.buffer} length (chars). Sized to cover
 * a wide viewport many times over (~viewport*4 wrapped rows ≈ a few hundred rows ×
 * ~80 cols), so the displayed tail is never starved while the buffer can't grow
 * unboundedly within a single long turn. ONLY the live buffer is capped — the full
 * prose committed at a tier boundary lives in {@link StreamView.proseFull}.
 */
export const PROSE_BUFFER_CAP = 16384;

export const initialStreamView: StreamView = {
  buffer: '',
  proseFull: '',
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
  board: [],
  boardEnabled: false,
  pressure: 0,
  dynamicWorldItems: [],
  goalsPanel: { enabled: false, open: false },
  controlPanel: { enabled: false, open: false, activeSection: 'goals' },
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
  // --- turn/reset: clear an OPTIMISTIC preflight turn that never reached the
  //     model/event stream (e.g. dependency-building failed before runTask). Like
  //     turn/start it resets only the per-turn slice and preserves committed[] +
  //     tokens.session, but it settles back to the idle prompt without emitting a
  //     completion line.
  | { readonly type: 'turn/reset' }
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
  // --- finalized verbose narration lines from the shared formatter ---
  | { readonly type: 'stream/narration'; readonly lines: readonly string[] }
  // --- a tool call ran (verbose prints a line; normal counts a step) ---
  | {
      readonly type: 'stream/tool';
      readonly name: string;
      readonly phase: 'start' | 'end';
      readonly verbosity: Verbosity;
      /** Owning goal when the scheduler/provider surfaced one. */
      readonly goalId?: string;
      /**
       * OPTIONAL real target the tool acted on (a file path / command / title),
       * copied verbatim from the provider event's `detail` when present (codex /
       * opencode supply it; the Claude subscription provider does NOT). Absent →
       * the live action surfaces the verb alone, never a fabricated target.
       */
      readonly detail?: string;
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
      readonly dependsOn?: readonly string[];
    }
  // --- goal/phase: set a goal's phase {current,total} for the "phase X/Y" badge
  //     (multi-goal seam). Additive — no emitter today. ---
  | {
      readonly type: 'goal/phase';
      readonly goalId: string;
      readonly current: number;
      readonly total: number;
    }
  // --- board/sync: REPLACE the persistent goal board with a fresh snapshot of the
  //     GoalStore (Elite-partner Phase 1). The menu dispatches this — built from
  //     `goalStore.list()` via pure goal-todo.ts shapers — at chat-loop start and
  //     after any /todo,/goals mutation. `enabled` flips `UiState.boardEnabled`
  //     (the menu only ever sends this action when the board flag is on), which is
  //     what suppresses the fake per-turn card and turns on board rendering. The
  //     reducer re-derives each row's LIVE agent count from `state.goals` (the
  //     reducer-owned, real attach-by-goalId truth) — the snapshot's own `agents`
  //     is ignored for running goals so the count is never stale/fabricated. Pure
  //     replace (like chrome/replace); never appends. ---
  | {
      readonly type: 'board/sync';
      readonly rows: readonly GoalBoardRow[];
      readonly enabled: boolean;
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
      /** How the conversation layer will resume a timed-out turn. */
      readonly timeoutContinuation?: 'automatic' | 'prompt';
      /** True iff the final carried a structured-question set (suppresses the
       *  completion line — the caller drives a selector). */
      readonly hasQuestions?: boolean;
      readonly bestEffort?: boolean;
      /** Blocked terminal record (MYSHELL_BLOCKED_STATE_V1). When present, the
       *  reducer renders Blocked instead of Failed. Mirrors the legacy renderer's
       *  distinct blocked branch. */
      readonly blocked?: BlockedRecord;
      /** The real elapsed seconds the spinner was visible, for the success line's
       *  `· Ns` suffix. Injected (never fabricated) — 0/absent omits the suffix. */
      readonly elapsedSecs?: number;
      /** The actionable CLI error text (provider-prefixed), pre-rendered by the
       *  impure caller via cliErrorForCategory/formatErrorMessage. When present on
       *  a failing final, committed as an `error` line before the Failed line. */
      readonly actionableError?: string;
    }
  // --- goals-panel/configure: enable/disable the fullscreen panel feature.
  //     When disabled, the panel is closed and the highlighted goal is cleared.
  | { readonly type: 'goals-panel/configure'; readonly enabled: boolean }
  // --- goals-panel/open: open the panel (no-op when disabled).
  //     Optionally set the highlighted goal on open.
  | { readonly type: 'goals-panel/open'; readonly highlightedGoalId?: string }
  // --- goals-panel/close: close the panel (keeps enabled state, keeps highlight).
  | { readonly type: 'goals-panel/close' }
  // --- goals-panel/toggle: flip open/closed (no-op when disabled).
  | { readonly type: 'goals-panel/toggle' }
  // --- goals-panel/highlight: set the highlighted goal (no-op when disabled or closed).
  | { readonly type: 'goals-panel/highlight'; readonly goalId: string }
  // --- control-panel/configure: enable/disable the sectioned Control Panel.
  | { readonly type: 'control-panel/configure'; readonly enabled: boolean }
  // --- control-panel/open: open the panel, optionally to a specific section.
  | { readonly type: 'control-panel/open'; readonly section?: ControlPanelSection }
  // --- control-panel/close: close the panel (keeps enabled + activeSection + shared highlight).
  | { readonly type: 'control-panel/close' }
  // --- control-panel/toggle: flip open/closed (no-op when disabled).
  | { readonly type: 'control-panel/toggle' }
  // --- control-panel/set-section: switch the active tab (no-op unless enabled+open).
  | { readonly type: 'control-panel/set-section'; readonly section: ControlPanelSection }
  // --- control-panel/highlight-goal: update shared goals highlight (no-op unless enabled+open+goals).
  | { readonly type: 'control-panel/highlight-goal'; readonly goalId: string }
  ;
