/**
 * src/interface/menu-post-turn.ts — Post-turn ordering (MASTER-PLAN MF3).
 *
 * Extracted from menu.ts — behavior-preserving, pure helpers.
 *
 * Mid-turn prose is **live manager notes** (not a FIFO turn queue). Control
 * lines (`/back`, `/exit`) still preempt; prose is buffered and injected into
 * the next turn's orchestrate context. `drain-queue` remains in the pure
 * sequence for call-site compatibility — with no FIFO queue it is a no-op.
 */

/**
 * One action in the canonical post-turn sequence. See {@link decidePostTurn}.
 *
 *   - `discard-typeahead` — drop leftover FIFO typeahead (legacy; empty under
 *     live-notes). Always emitted before any selector so a mid-turn line can
 *     NEVER answer an unseen question/memory selector.
 *   - `question-flow` — run the `ask_user` structured-question selector.
 *   - `memory-approval` — run the `remember_user` Save/Skip/Edit selector
 *     (Phase 5; a no-op stub until then).
 *   - `drain-queue` — legacy FIFO drain of queued chat lines as next turns.
 *     Under live-notes there is no turn queue: call sites no-op when empty.
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
  /**
   * Legacy FIFO chat-turn queue length. Live-notes path always passes 0
   * (mid-turn prose is not queued as turns). Kept so the pure helper stays
   * table-compatible and empty-queue drain remains a no-op.
   */
  readonly queuedCount: number;
  /** Whether ESC or Ctrl+C cancelled this turn. */
  readonly interrupted: boolean;
}

/**
 * The single canonical post-turn sequence (red-team Axis-9 / MASTER-PLAN MF3).
 * Returns the ordered actions to perform after a turn settles. PURE +
 * table-tested. chat-ux owns the implementation; memory and question flow both
 * route through it so a mid-turn line can NEVER answer an unseen selector.
 *
 *   settle
 *     → discard leftover FIFO typeahead     (always, before any selector)
 *     → IF hasQuestions: question-flow      (mutually exclusive with memory-approval per turn)
 *     → ELSE IF hasMemoryProposal: memory-approval
 *     → drain-queue                         (only if NOT interrupted; empty = no-op)
 *
 * Rules: a selector is never fed a mid-turn line (`discard-typeahead` always
 * precedes it). On interrupt, any leftover FIFO is discarded and not drained.
 * Live manager notes are NOT this queue — they survive settle and inject into
 * the next orchestrate context. `question-flow` and `memory-approval` never
 * both run in one turn (the model never emits `ask_user` alongside
 * `remember_user` — memory doc §8).
 *
 * Pure — never throws, no I/O, no side effects.
 */
export function decidePostTurn(inputs: PostTurnInputs): readonly PostTurnAction[] {
  const actions: PostTurnAction[] = [];
  // Always discard leftover FIFO typeahead first: those lines were entered
  // before any selector below was rendered, so they must never be misread as
  // answers. Under live-notes `queuedCount` is 0 and this is a structural no-op.
  actions.push('discard-typeahead');

  if (inputs.hasQuestions) {
    actions.push('question-flow');
  } else if (inputs.hasMemoryProposal) {
    actions.push('memory-approval');
  }

  // Drain the legacy FIFO only on a clean settle AND when the turn did NOT end
  // in a structured question. Empty queue → call site no-ops. An interrupt
  // (ESC / Ctrl+C) means "stop": discard, do not drain.
  if (!inputs.interrupted && !inputs.hasQuestions) {
    actions.push('drain-queue');
  }

  return actions;
}

/**
 * Preemptive control commands captured mid-turn (control-plane).
 * Only `/back` and `/exit` (trim + case-insensitive) preempt the foreground
 * turn — prose becomes live notes (not FIFO-queued).
 */
export type PreemptiveControlCommand = 'back' | 'exit';

export function parsePreemptiveControlCommand(line: string): PreemptiveControlCommand | null {
  const t = line.trim().toLowerCase();
  if (t === '/back') return 'back';
  if (t === '/exit') return 'exit';
  return null;
}

/**
 * Format mid-turn manager notes for the next orchestrate / buildDeps context.
 * Returns '' when there are no notes (callers omit the block).
 *
 * Pure — no I/O.
 */
export function formatLiveNotesBlock(notes: readonly string[]): string {
  const cleaned = notes.map((n) => n.trim()).filter((n) => n.length > 0);
  if (cleaned.length === 0) return '';
  const body = cleaned.map((n) => `- ${n}`).join('\n');
  return `USER NOTES WHILE WORKING:\n${body}`;
}

/**
 * Merge a live-notes block into an existing environmentContext string.
 * Notes-only → notes; env-only → env; both → env then notes (blank line sep).
 * Pure.
 */
export function mergeLiveNotesIntoEnvironmentContext(
  environmentContext: string | undefined,
  notesBlock: string | undefined,
): string | undefined {
  const notes = notesBlock?.trim() ?? '';
  const env = environmentContext?.trim() ?? '';
  if (notes.length === 0) return environmentContext;
  if (env.length === 0) return notes;
  return `${env}\n\n${notes}`;
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
