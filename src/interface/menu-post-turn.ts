/**
 * src/interface/menu-post-turn.ts — Post-turn ordering (MASTER-PLAN MF3).
 *
 * Extracted from menu.ts — behavior-preserving, pure helpers.
 */

/**
 * One action in the canonical post-turn sequence. See {@link decidePostTurn}.
 *
 *   - `discard-typeahead` — drop lines typed during the turn (they never saw the
 *     selector that may follow), always emitted before any selector.
 *   - `question-flow` — run the `ask_user` structured-question selector.
 *   - `memory-approval` — run the `remember_user` Save/Skip/Edit selector
 *     (Phase 5; a no-op stub until then).
 *   - `drain-queue` — run queued chat lines as the next turns, FIFO.
 */
export type PostTurnAction =
  | 'discard-typeahead'
  | 'question-flow'
  | 'memory-approval'
  | 'drain-queue';

/** Inputs to {@link decidePostTurn} — see MASTER-PLAN MF3. */
export interface PostTurnInputs {
  /** `final.questions` present (the model asked a structured question). */
  readonly hasQuestions: boolean;
  /** `final.memoryProposal` present AND passed the worth gate (Phase 5). */
  readonly hasMemoryProposal: boolean;
  /** Chat-turn queue length (lines typed-ahead during the turn). */
  readonly queuedCount: number;
  /** Whether ESC or Ctrl+C cancelled this turn. */
  readonly interrupted: boolean;
}

/**
 * The single canonical post-turn sequence (red-team Axis-9 / MASTER-PLAN MF3).
 * Returns the ordered actions to perform after a turn settles. PURE +
 * table-tested. chat-ux owns the implementation; memory and question flow both
 * route through it so a queued line can NEVER answer an unseen selector.
 *
 *   settle
 *     → discard queued typeahead            (always, before any selector)
 *     → IF hasQuestions: question-flow      (mutually exclusive with memory-approval per turn)
 *     → ELSE IF hasMemoryProposal: memory-approval
 *     → drain-queue                         (only if NOT interrupted; interrupt discards)
 *
 * Rules: a selector is never fed a queued line (`discard-typeahead` always
 * precedes it). On interrupt, the queue is discarded and not drained.
 * `question-flow` and `memory-approval` never both run in one turn (the model
 * never emits `ask_user` alongside `remember_user` — memory doc §8).
 *
 * Pure — never throws, no I/O, no side effects.
 */
export function decidePostTurn(inputs: PostTurnInputs): readonly PostTurnAction[] {
  const actions: PostTurnAction[] = [];
  // Always discard typed-ahead lines first: they were entered before any
  // selector below was rendered, so they must never be misread as answers.
  actions.push('discard-typeahead');

  if (inputs.hasQuestions) {
    actions.push('question-flow');
  } else if (inputs.hasMemoryProposal) {
    actions.push('memory-approval');
  }

  // Drain the queue only on a clean settle AND when the turn did NOT end in a
  // structured question. When questions are present the answer turn re-enters
  // the loop and the queued lines were discarded above (they never saw the
  // selector) — so there is nothing to drain (MASTER-PLAN MF3 table row 2). An
  // interrupt (ESC / Ctrl+C) likewise means "stop": the queue is discarded, not
  // drained.
  if (!inputs.interrupted && !inputs.hasQuestions) {
    actions.push('drain-queue');
  }

  return actions;
}

/**
 * Preemptive control commands captured mid-turn (control-plane PR3).
 * Only `/back` and `/exit` (trim + case-insensitive) preempt the foreground
 * turn — prose and other slash commands still FIFO-queue.
 */
export type PreemptiveControlCommand = 'back' | 'exit';

export function parsePreemptiveControlCommand(line: string): PreemptiveControlCommand | null {
  const t = line.trim().toLowerCase();
  if (t === '/back') return 'back';
  if (t === '/exit') return 'exit';
  return null;
}

/**
 * Store goals marked `running` that have no live AbortController are zombies
 * (process restart, silent spawn death). Pure filter for reconcile-on-enter.
 */
export function zombieRunningGoalIds(
  runningGoalIds: readonly string[],
  liveControllerIds: ReadonlySet<string>,
): string[] {
  return runningGoalIds.filter((id) => !liveControllerIds.has(id));
}
