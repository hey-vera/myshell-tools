/**
 * src/interface/ui/index.ts — the pure MVU surface of the Ink chat UI (STEP 3a).
 *
 * Re-exports the immutable `UiState` model, the `Action` union, the pure
 * `reduce` reducer, and the pure CoreEvent→Action mapper so the 3b rendering
 * wiring (and tests) import them from one stable entry point. This barrel
 * contains NO Ink/React/JSX and NO I/O — it is exercised by the regular
 * `npm test` suite. The Ink components (App/InputBox/mount) live in the sibling
 * `.tsx` files and are NOT re-exported here, keeping this entry point pure.
 */

export {
  reduce,
} from './reduce.js';
export {
  coreEventToActions,
  isDebugEnv,
} from './core-event.js';
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
