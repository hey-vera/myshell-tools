/**
 * src/core/draft-goal.ts — PURE helpers for Phase 1 "chat → draft goal"
 * (docs/one-chat-redesign-plan.md Phase 1).
 *
 * BYPRODUCT INTELLIGENCE (principle #1): on a BUILD-INTENT turn the model
 * is already reading the message to reply.  We extend the IntentFrame
 * byproduct with an optional `draftGoalSkeleton` — a lightweight title +
 * high-level outline (a few sub-goals / to-dos) — so the SAME single model
 * call that produces the intent frame also produces the draft plan.  No
 * separate planning call, no extra tokens on non-build turns.
 *
 * DRAFT-THEN-ACTIVATE (principle #6): the skeleton is materialised as a
 * PARKED goal (`state: 'parked'`, `source: 'byproduct-draft'`) in the
 * GoalStore.  It is NEVER queued, run, or executed without explicit user
 * confirmation.  The confirmation gate, decomposition depth, and execution
 * are LATER slices (Phase 1 continuation).
 *
 * This module is PURE: no I/O, no time, no randomness — so it is exercised
 * by `npm test` under strip-types and satisfies the `test/arch/guards.ts`
 * purity guard.  The I/O that actually persists the draft lives in the
 * interface layer (menu.ts), which reads the `draftGoalSkeleton` off the
 * emitted IntentFrame after the turn settles and calls `goalStore.create`.
 */

import type { IntentFrame } from './intent.js';

// ---------------------------------------------------------------------------
// The draft skeleton shape
// ---------------------------------------------------------------------------

/**
 * A high-level outline item — one sub-goal or to-do in the skeleton.
 * Kept deliberately lightweight: just the text, no acceptance criteria, no
 * deep nesting.  Progressive decomposition fills in the detail just-in-time
 * as work approaches each sub-goal (principle #7).
 */
export interface DraftGoalOutlineItem {
  /** Short description of the sub-goal / step. Max 160 chars (defensively capped). */
  readonly text: string;
}

/**
 * The lightweight draft-goal skeleton emitted as a byproduct of a BUILD-
 * INTENT turn.  Carried on `IntentFrame.draftGoalSkeleton` (optional — absent
 * on every non-build turn so existing frames / mocks / goldens are structurally
 * unchanged).
 *
 * Deliberately small: title + a short outline (2–6 items).  Confirmation gate,
 * acceptance criteria, full decomposition, and execution are later slices.
 */
export interface DraftGoalSkeleton {
  /**
   * The goal's title — a concise action phrase (≤ 120 chars).
   * Derived from `IntentFrame.goal` when absent in the model's JSON.
   */
  readonly title: string;
  /**
   * High-level outline: the 2–6 sub-goals / steps that structure the work.
   * Enough shape to show the user what the system understood; NOT a complete
   * decomposition (that happens just-in-time).
   */
  readonly outline: readonly DraftGoalOutlineItem[];
}

// ---------------------------------------------------------------------------
// Cap constants
// ---------------------------------------------------------------------------

const TITLE_LIMIT = 120;
const OUTLINE_TEXT_LIMIT = 160;
const OUTLINE_MIN = 2;
const OUTLINE_MAX = 6;

// ---------------------------------------------------------------------------
// BUILD-INTENT detection (pure, no model call)
// ---------------------------------------------------------------------------

/**
 * The `kind` values from the intent extractor that signal a BUILD intent —
 * i.e. the user wants something BUILT, CHANGED, or IMPLEMENTED, not just
 * answered or discussed.
 *
 * These mirror the open-vocabulary `kind` field emitted by `buildIntentPrompt`
 * / the byproduct model ("coding | writing | research | ops | planning |
 * design | other").  We treat 'coding', 'ops', and 'design' as build-intent
 * because they imply creating or modifying artefacts.  'planning' is included
 * because planning requests produce a plan artefact.  'writing' is included
 * when there is a concrete deliverable (the `doneWhen` field is populated).
 * 'research' and 'other' alone do NOT trigger a draft goal — they are
 * discussion / investigation intents.
 */
const BUILD_KINDS: ReadonlySet<string> = new Set([
  'coding',
  'ops',
  'design',
  'planning',
]);

/**
 * Build-intent keyword patterns applied to the `IntentFrame.goal` field as
 * a secondary signal when `kind` is absent or ambiguous.  Pure regex scan;
 * never throws.
 */
const BUILD_GOAL_RE =
  /\b(build|make|create|implement|add|write|develop|set up|refactor|migrate|deploy|fix|update|convert|generate|scaffold|wire|integrate|ship|launch)\b/i;

/**
 * Decide whether an `IntentFrame` carries a BUILD intent — meaning the user
 * wants something built, implemented, or changed, and a draft goal skeleton
 * would be valuable.
 *
 * Returns true when ANY of the following hold:
 * 1. `frame.kind` is in the BUILD_KINDS set.
 * 2. `frame.kind` is 'writing' AND `frame.doneWhen` is populated (concrete
 *    deliverable, not just "explain writing").
 * 3. `frame.routeTier` is 'ic' or 'manager' (the extractor judged it needs
 *    implementation firepower) AND the goal text contains a build-verb.
 * 4. `frame.draftGoalSkeleton` is already populated (the model pre-emitted it).
 *
 * Returns false on questions, explanations, lookups, discussions, research,
 * and any frame where `source` is 'skipped' (trivial turns that bypass the
 * extractor entirely produce no skeleton).
 *
 * PURE — never throws.
 */
export function isBuildIntent(frame: IntentFrame): boolean {
  try {
    // If the model already emitted a skeleton, honour it.
    if (frame.draftGoalSkeleton !== undefined) return true;

    // Skipped / rules frames on trivial turns — no build skeleton.
    if (frame.source === 'skipped') return false;

    const kind = (frame.kind ?? '').toLowerCase().trim();

    // Primary: kind is a build kind.
    if (BUILD_KINDS.has(kind)) return true;

    // Writing with a concrete deliverable.
    if (kind === 'writing' && (frame.doneWhen ?? '').trim().length > 0) return true;

    // Secondary: tier signals implementation firepower + goal contains a build verb.
    if (
      (frame.routeTier === 'ic' || frame.routeTier === 'manager') &&
      BUILD_GOAL_RE.test(frame.goal)
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Skeleton derivation (pure, deterministic)
// ---------------------------------------------------------------------------

function capTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, TITLE_LIMIT);
}

function capOutlineItem(raw: unknown): DraftGoalOutlineItem | null {
  if (typeof raw === 'string') {
    const text = raw.trim().slice(0, OUTLINE_TEXT_LIMIT);
    return text.length > 0 ? { text } : null;
  }
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const text = typeof obj['text'] === 'string' ? obj['text'].trim().slice(0, OUTLINE_TEXT_LIMIT) : '';
    return text.length > 0 ? { text } : null;
  }
  return null;
}

function capOutline(raw: unknown): readonly DraftGoalOutlineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftGoalOutlineItem[] = [];
  for (const item of raw) {
    if (out.length >= OUTLINE_MAX) break;
    const capped = capOutlineItem(item);
    if (capped !== null) out.push(capped);
  }
  return out;
}

/**
 * Derive a sensible default outline from an `IntentFrame` when the model
 * did not emit one.  Uses the frame's `forks`, `constraints`, and `doneWhen`
 * to produce a plausible 2–3 step skeleton.  PURE — never throws, never
 * invents specifics it has no evidence for.
 */
function deriveDefaultOutline(frame: IntentFrame): readonly DraftGoalOutlineItem[] {
  const items: DraftGoalOutlineItem[] = [];

  // Sub-goals from forks (genuine decision points the model identified).
  if (frame.forks !== undefined && frame.forks.length > 0) {
    for (const fork of frame.forks) {
      if (items.length >= OUTLINE_MAX) break;
      const assumed = fork.assumeIfUnasked;
      const text = assumed !== undefined && assumed.length > 0
        ? `${fork.question} (approach: ${assumed})`.slice(0, OUTLINE_TEXT_LIMIT)
        : fork.question.slice(0, OUTLINE_TEXT_LIMIT);
      items.push({ text });
    }
  }

  // If we have fewer than OUTLINE_MIN items, synthesise generic skeleton steps
  // from the kind and doneWhen.
  if (items.length < OUTLINE_MIN) {
    const kind = (frame.kind ?? 'work').toLowerCase();
    items.push({ text: `Understand requirements and plan the ${kind}` });
    if (frame.doneWhen !== undefined && frame.doneWhen.trim().length > 0) {
      items.push({ text: `Implement: ${frame.doneWhen.trim()}`.slice(0, OUTLINE_TEXT_LIMIT) });
    } else {
      items.push({ text: `Implement the ${kind}` });
    }
    items.push({ text: 'Test and verify the result' });
  }

  return items.slice(0, OUTLINE_MAX);
}

/**
 * Derive a `DraftGoalSkeleton` from an `IntentFrame`.  Returns `null` when
 * `isBuildIntent(frame)` is false — nothing to draft.
 *
 * When the model pre-emitted a `draftGoalSkeleton` on the frame (the happy
 * path, byproduct principle), this function caps and returns it directly.
 * When the skeleton field is absent (older frames, rules fallback), it
 * derives a sensible skeleton from the frame's existing fields — no second
 * model call.
 *
 * PURE — no I/O, no clock, never throws.
 */
export function deriveDraftGoalSkeleton(frame: IntentFrame): DraftGoalSkeleton | null {
  try {
    if (!isBuildIntent(frame)) return null;

    // The model pre-emitted a skeleton — cap and return it.
    const pre = frame.draftGoalSkeleton;
    if (pre !== undefined) {
      const title = capTitle(pre.title) || capTitle(frame.goal);
      const outline = capOutline(pre.outline);
      if (title.length === 0) return null;
      if (outline.length < OUTLINE_MIN) {
        // Supplement with derived items if the emitted outline is too thin.
        const derived = deriveDefaultOutline(frame);
        const merged = [...outline, ...derived].slice(0, OUTLINE_MAX);
        return merged.length >= OUTLINE_MIN ? { title, outline: merged } : null;
      }
      return { title, outline };
    }

    // No pre-emitted skeleton — derive from the frame.
    const title = capTitle(frame.goal);
    if (title.length === 0) return null;
    const outline = deriveDefaultOutline(frame);
    if (outline.length < OUTLINE_MIN) return null;
    return { title, outline };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cap helper for round-tripping through the store
// ---------------------------------------------------------------------------

/**
 * Return a defensively capped copy of a `DraftGoalSkeleton`.  Idempotent.
 * Accepts `unknown` so it can be used to sanitise model-emitted JSON.
 * Returns `null` when the input is missing required fields.
 *
 * PURE — never throws.
 */
export function capDraftGoalSkeleton(raw: unknown): DraftGoalSkeleton | null {
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const title = capTitle(obj['title']);
    if (title.length === 0) return null;
    const outline = capOutline(obj['outline']);
    if (outline.length < OUTLINE_MIN) return null;
    return { title, outline };
  } catch {
    return null;
  }
}
