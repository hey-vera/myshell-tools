/**
 * src/interface/ui/index.ts — the MVU surface of the Ink chat UI (STEP 3a/3b).
 *
 * Re-exports the immutable `UiState` model, the `Action` union, the pure
 * `reduce` reducer, the pure CoreEvent→Action mapper, and (3b) the impure
 * `renderStreamInk` consumer so the rendering wiring (and tests) import them from
 * one stable entry point. This barrel contains NO Ink/React/JSX — it is exercised
 * by the regular `npm test` suite under strip-types. The Ink COMPONENTS
 * (App/InputBox/Stream/mount) live in the sibling `.tsx` files and are NOT
 * re-exported here, keeping this entry point JSX-free.
 *
 * NOTE (3b): `renderStreamInk` is the IMPURE consumer — it owns the per-tier
 * EnvelopeFilter, rate-limit bookkeeping, the panelCandidate/elapsedSecs/
 * actionableError boundaries, and the prose throttle. It performs no ambient I/O
 * itself: every side input (dispatch, clock, env, flush scheduler) is INJECTED,
 * so it is as hermetically testable as the pure pieces and safe to surface here.
 */

export {
  reduce,
} from './reduce.js';
export {
  coreEventToActions,
  isDebugEnv,
} from './core-event.js';
export {
  renderStreamInk,
} from './run-stream.js';
export {
  layoutForHeight,
  compactGoalsSummary,
  summarizeTurn,
  totalAgentCount,
  goalsAreSequentialPhases,
  goalCardRows,
  goalRowsHeight,
  planGoalsPanel,
  coalescedQueuedLine,
  streamWrappedRows,
  tailStreamToRows,
  INPUT_ROWS,
  STATUS_LINE_ROWS,
  SUMMARY_LINE_ROWS,
  PANEL_BORDER_ROWS,
  SAFETY_MARGIN_ROWS,
} from './layout.js';
export {
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
} from './state.js';
