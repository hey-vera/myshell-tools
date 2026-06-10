/**
 * src/core/goal-replan.ts — the PURE core for AUTOMATIC LIVING-PLAN MAINTENANCE
 * (elite-partner architecture Part 1 "re-validate + re-plan" + Part 4 "living
 * plan (dynamic to-do CRUD)").
 *
 * THE HEADLINE BEHAVIOUR: the to-do list is the partner's OWN, AUTOMATIC ability,
 * never a manual chore. Before the manager cycle picks the next to-do, the partner
 * — given the goal, its current roadmap (each item's verified status), the
 * vision/goalAcceptance, and the whole-picture understanding — RE-PLANS its own
 * to-do list the way a senior PM keeps a board honest: it can ADD missing steps,
 * EDIT unclear ones, REORDER for the right sequence, and PRUNE obsolete ones — but
 * it NEVER touches a verified-done item (its verdict is sacred evidence) and NEVER
 * fabricates a verdict.
 *
 * This module is the PURE half (no fs/path/child_process/Date/Math.random), exactly
 * like `goal-plan.ts`: it builds the one-shot prompt (read by a MANAGER-tier model,
 * given the product-vision / quality-bar persona first), parses the tagged reply
 * into a list of {@link RoadmapEdit}s, and exposes a pure {@link applyReplanEdits}
 * reducer so the add/edit/reorder/prune SEMANTICS are table-testable. The model
 * touch lives behind the injected generator in `goal-replan-generator.ts`. Fail-soft
 * contract: the parser returns `null` on ANY unusable reply so the caller proceeds
 * with the existing roadmap unchanged (today's P7 behaviour) — re-plan ADDS rigour
 * when it fires and is SILENT when it can't, never fabricated.
 *
 * HONESTY (hard, non-negotiable): no edit ever sets a verdict; a verified-done item
 * (verdict.state ∈ {passing, reviewed}) is NEVER edited, removed, or reordered out
 * of its done position; nothing is fabricated; counts + lengths are capped.
 */

import { ELITE_VOICE_PREAMBLE } from './prompt.js';
import type { Goal } from './goal-todo.js';
import type { RoadmapItem } from './work-contract.js';
import type { SystemModel } from './understanding.js';

/** Hard cap on a single to-do's text — a concrete step, not an essay. */
const REPLAN_TODO_MAX_CHARS = 120;
/** Hard cap on a single acceptance-criterion — a checkable line, not a paragraph. */
const REPLAN_CRITERION_MAX_CHARS = 200;
/**
 * Bounded counts: at most this many EDIT operations per re-plan pass (a senior PM
 * makes a handful of sharp moves, never a churn of dozens). Exported so the prompt's
 * documented cap and the parser's enforcement share ONE source of truth (consumed by
 * the goal-replan tests + buildReplanPrompt). */
export const REPLAN_MAX_EDITS = 12;

/**
 * One edit the re-plan pass wants applied to the goal's roadmap. Keyed by
 * RoadmapItem.id (never array index) so an edit can never orphan an item's identity.
 *  - `add`     → insert a NEW pending to-do (a fresh id the parser mints).
 *  - `edit`    → patch an existing pending to-do's text / acceptanceCriterion.
 *  - `reorder` → set the full desired id order (verified-done items stay anchored).
 *  - `prune`   → drop an existing pending to-do (verified-done is never pruned).
 */
export type RoadmapEdit =
  | { readonly kind: 'add'; readonly text: string; readonly acceptanceCriterion?: string }
  | {
      readonly kind: 'edit';
      readonly id: string;
      readonly text?: string;
      readonly acceptanceCriterion?: string;
    }
  | { readonly kind: 'reorder'; readonly order: readonly string[] }
  | { readonly kind: 'prune'; readonly id: string };

/**
 * Build the one-shot re-plan prompt. Read by a CAPABLE (manager-tier) model, so it
 * leads with the product-vision / quality-bar persona (the reused
 * {@link ELITE_VOICE_PREAMBLE}), then asks the model to MAINTAIN this goal's to-do
 * list like a senior PM and reply with ONLY tagged edit lines. PURE; never throws.
 *
 * The goal's current roadmap is rendered with each item's id + verified status so
 * the model edits by id and knows which items are immovable (verified done). The
 * vision/goalAcceptance frames "the smartest, most-efficient path to done"; the
 * optional SystemModel grounds the edits in the REAL system (absent → those lines
 * are not added, so the prompt is byte-for-byte the ungrounded form).
 */
export function buildReplanPrompt(goal: Goal, systemModel?: SystemModel): string {
  const title = (goal.title ?? '').trim();
  if (title.length === 0) return '';

  const lines: string[] = [
    ELITE_VOICE_PREAMBLE,
    '',
    'Using that bar, you MAINTAIN this goal\'s to-do list like a senior PM. Your job',
    'is to keep it the smartest, most-efficient path to the goal being truly done —',
    'before the next step runs. Read the goal, its current to-dos (each with its',
    'VERIFIED status), and the definition of done, then propose the edits a sharp PM',
    'would make right now. You MAY:',
    '  - ADD a missing step,',
    '  - EDIT an unclear / wrong pending step,',
    '  - REORDER the pending steps into the right sequence,',
    '  - PRUNE a pending step that is obsolete or redundant.',
    '',
    'Reply with ONLY tagged edit lines, one per line, and nothing else:',
    '  ADD: <a concrete new to-do step>',
    '  ADD: <another new step> || DONE-WHEN: <its checkable definition of done>',
    '  EDIT <id>: <the corrected text for that to-do>',
    '  EDIT <id>: <corrected text> || DONE-WHEN: <updated definition of done>',
    '  REORDER: <id>, <id>, <id>  (the full desired order of the PENDING to-dos)',
    '  PRUNE <id>: <one short reason it is obsolete>',
    '',
    'HARD rules (non-negotiable):',
    '  - NEVER touch a DONE / VERIFIED to-do: do not edit it, do not prune it, do',
    '    not move it out of its place. Its result is real, finished work.',
    '  - Reference existing to-dos by their exact <id> from the list below.',
    `  - At most ${String(REPLAN_MAX_EDITS)} edits — a handful of sharp moves, not a churn.`,
    '  - If the plan is already the right path, reply with NO edit lines at all',
    '    (the empty reply means "leave it exactly as-is"). Do NOT invent busywork.',
    '  - NEVER claim a step is done — a real verification decides that, never you.',
    '  - Reply with ONLY the tagged lines above. No prose, no preamble, no markdown.',
  ];

  const acceptance = (goal.goalAcceptance ?? '').trim();
  if (acceptance.length > 0) {
    lines.push('', 'THE GOAL IS DONE WHEN:', acceptance);
  }

  const grounding = systemModelGrounding(systemModel);
  if (grounding.length > 0) lines.push('', ...grounding);

  lines.push('', 'GOAL:', title, '', 'CURRENT TO-DOS:');
  if (goal.roadmap.length === 0) {
    lines.push('  (none yet)');
  } else {
    for (const item of goal.roadmap) {
      lines.push(`  [${item.id}] ${verifiedTag(item)} ${item.text}`);
    }
  }
  return lines.join('\n');
}

/** A short "(DONE/VERIFIED — do not touch)" / "(pending)" tag for the prompt list. */
function verifiedTag(item: RoadmapItem): string {
  return isVerifiedDone(item) ? '(DONE/VERIFIED — do not touch)' : '(pending)';
}

/**
 * Render the SystemModel into the re-plan grounding block, or `[]` when there is no
 * usable understanding (so the prompt stays the ungrounded form). PURE; bounds what
 * it injects (summary + the hard constraints — the load-bearing grounding for
 * editing the plan against the REAL system), never throws.
 */
function systemModelGrounding(systemModel: SystemModel | undefined): string[] {
  if (systemModel === undefined) return [];
  const summary = systemModel.summary.trim();
  const constraints = systemModel.constraints.filter((c) => c.trim().length > 0);
  if (summary.length === 0 && constraints.length === 0) return [];
  const out: string[] = [
    'WHOLE-PICTURE UNDERSTANDING OF THE REAL SYSTEM (keep the plan grounded in this',
    '— edit toward steps that fit these real modules + respect these hard',
    'constraints):',
  ];
  if (summary.length > 0) out.push(`  SYSTEM: ${summary}`);
  for (const c of constraints) out.push(`  CONSTRAINT: ${c.trim()}`);
  return out;
}

// ---------------------------------------------------------------------------
// Parsing (fail-soft, defensive, never throws; caps counts + lengths)
// ---------------------------------------------------------------------------

/** A verdict that marks an item as real, verified, completed work (sacred). Mirrors
 *  isTodoVerifiedDone / the store's isVerifiedDone — kept local so this module stays
 *  pure + self-contained. */
function isVerifiedDone(item: RoadmapItem): boolean {
  const state = item.verdict?.state;
  return state === 'passing' || state === 'reviewed';
}

/** Collapse whitespace, peel a leading marker glyph + wrapping quotes. */
function clean(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[※⏺*\-•]\s*/u, '');
  s = s.replace(/^["'“”]+/, '').replace(/["'”“]+$/, '').trim();
  return s;
}

/** Bound a value to a max length on a word boundary (a label, not a sentence). */
function capLen(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, '').trim();
  return cut.length > 0 ? cut : s.slice(0, max).trim();
}

/** Split a value into its main text + optional `|| DONE-WHEN: <criterion>` tail. */
function splitDoneWhen(value: string): { text: string; criterion?: string } {
  const m = /^(.*?)\s*\|\|\s*DONE-WHEN\s*:?\s*(.+)$/is.exec(value);
  if (m === null) return { text: value.trim() };
  const text = (m[1] ?? '').trim();
  const criterion = (m[2] ?? '').trim();
  return criterion.length > 0 ? { text, criterion } : { text };
}

/** Parse a comma/space-separated id list (for REORDER). Defensive, deduped. */
function parseIdList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of value.split(/[,\s]+/)) {
    const id = tok.trim();
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Parse the model's tagged reply into a list of {@link RoadmapEdit}s, or `null`
 * when the reply is unusable (so the caller leaves the roadmap unchanged). PURE;
 * never throws; caps the number of edits (≤ REPLAN_MAX_EDITS) and every text /
 * criterion length; refuses to fabricate (a tag with no usable payload is dropped).
 *
 * An EMPTY-but-parseable reply (no edit lines) returns `[]` — a legitimate "leave
 * the plan exactly as-is" verdict, distinct from `null` (an unusable / no-signal
 * reply). The caller treats both as "no change", but the distinction keeps the
 * semantics honest + testable.
 */
export function parseReplanEdits(raw: string | undefined | null): RoadmapEdit[] | null {
  if (typeof raw !== 'string') return null;
  const rawLines = raw.split(/\r?\n/);
  const edits: RoadmapEdit[] = [];
  let sawAnyTag = false;

  for (const line of rawLines) {
    if (edits.length >= REPLAN_MAX_EDITS) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // ADD: <text> [|| DONE-WHEN: <criterion>]
    const add = /^(?:[※⏺*\-•]\s*)?ADD\s*[:\-—]\s*(.+)$/iu.exec(trimmed);
    if (add !== null) {
      sawAnyTag = true;
      const { text, criterion } = splitDoneWhen(clean(add[1] ?? ''));
      if (text.length === 0) continue; // an ADD with nothing to add → dropped
      edits.push({
        kind: 'add',
        text: capLen(text, REPLAN_TODO_MAX_CHARS),
        ...(criterion !== undefined
          ? { acceptanceCriterion: capLen(criterion, REPLAN_CRITERION_MAX_CHARS) }
          : {}),
      });
      continue;
    }

    // EDIT <id>: <text> [|| DONE-WHEN: <criterion>]
    const edit = /^(?:[※⏺*\-•]\s*)?EDIT\s+(\S+?)\s*[:\-—]\s*(.+)$/iu.exec(trimmed);
    if (edit !== null) {
      sawAnyTag = true;
      const id = (edit[1] ?? '').trim();
      const { text, criterion } = splitDoneWhen(clean(edit[2] ?? ''));
      if (id.length === 0) continue;
      if (text.length === 0 && criterion === undefined) continue; // nothing to patch
      edits.push({
        kind: 'edit',
        id,
        ...(text.length > 0 ? { text: capLen(text, REPLAN_TODO_MAX_CHARS) } : {}),
        ...(criterion !== undefined
          ? { acceptanceCriterion: capLen(criterion, REPLAN_CRITERION_MAX_CHARS) }
          : {}),
      });
      continue;
    }

    // REORDER: <id>, <id>, ...
    const reorder = /^(?:[※⏺*\-•]\s*)?REORDER\s*[:\-—]\s*(.+)$/iu.exec(trimmed);
    if (reorder !== null) {
      sawAnyTag = true;
      const order = parseIdList(reorder[1] ?? '');
      if (order.length === 0) continue;
      edits.push({ kind: 'reorder', order });
      continue;
    }

    // PRUNE <id>[: reason]
    const prune = /^(?:[※⏺*\-•]\s*)?PRUNE\s+(\S+?)\s*(?:[:\-—].*)?$/iu.exec(trimmed);
    if (prune !== null) {
      sawAnyTag = true;
      const id = (prune[1] ?? '').trim();
      if (id.length === 0) continue;
      edits.push({ kind: 'prune', id });
      continue;
    }
    // Any other line is ignored (no prose leaks into the edit list).
  }

  // No tagged line at all → unusable reply → null (caller leaves the plan as-is).
  // An empty edit list AFTER seeing a tag would be impossible (a tag pushes an
  // edit), so `[]` here means we saw NO tags. We return null in that case so the
  // caller's null-path (proceed unchanged) fires — there is no observable
  // difference, and it keeps "no signal" honest.
  if (!sawAnyTag) return null;
  return edits;
}

// ---------------------------------------------------------------------------
// applyReplanEdits — the PURE add/edit/reorder/prune reducer (table-testable)
// ---------------------------------------------------------------------------

/** Mint a fresh, collision-free RoadmapItem id (e.g. `r3`) given the used ids. */
function nextId(used: ReadonlySet<string>): string {
  for (let i = 1; ; i += 1) {
    const candidate = `r${String(i)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Apply a list of {@link RoadmapEdit}s to a roadmap, returning the NEW roadmap.
 * PURE, total, never throws, never mutates the input. This is the SEMANTIC contract
 * the menu wiring applies one edit at a time via the store CRUD — proven here so the
 * add/edit/reorder/prune behaviour (and the verified-done invariants) are
 * table-testable in isolation.
 *
 * The HONESTY invariants, enforced HERE so they hold regardless of what the model
 * asked for:
 *  - a verified-done item (verdict.state ∈ {passing, reviewed}) is NEVER edited,
 *    NEVER pruned, and NEVER reordered out of its relative position — it is anchored
 *    in place; a reorder only permutes the PENDING items around the anchored ones;
 *  - no edit ever writes or clears a `verdict` (the field is preserved verbatim);
 *  - new ids never collide with existing ones;
 *  - the roadmap cap (`cap`, default 8) is honoured: an ADD past the cap is dropped.
 *
 * Edits are applied in order; an EDIT/PRUNE/REORDER referencing an unknown or
 * verified-done id is a safe no-op.
 */
export function applyReplanEdits(
  roadmap: readonly RoadmapItem[],
  edits: readonly RoadmapEdit[],
  cap = 8,
): RoadmapItem[] {
  let next: RoadmapItem[] = roadmap.map((it) => ({ ...it }));

  for (const edit of edits) {
    if (edit.kind === 'add') {
      if (next.length >= cap) continue; // cap honoured — drop the overflow add
      const used = new Set(next.map((it) => it.id));
      const item: RoadmapItem = {
        id: nextId(used),
        text: edit.text,
        status: 'pending',
        ...(edit.acceptanceCriterion !== undefined
          ? { acceptanceCriterion: edit.acceptanceCriterion }
          : {}),
      };
      next = [...next, item];
      continue;
    }

    if (edit.kind === 'edit') {
      next = next.map((it) => {
        if (it.id !== edit.id) return it;
        if (isVerifiedDone(it)) return it; // verified-done is immutable — never edited
        return {
          ...it,
          ...(edit.text !== undefined ? { text: edit.text } : {}),
          ...(edit.acceptanceCriterion !== undefined
            ? { acceptanceCriterion: edit.acceptanceCriterion }
            : {}),
        };
      });
      continue;
    }

    if (edit.kind === 'prune') {
      const target = next.find((it) => it.id === edit.id);
      if (target === undefined) continue; // unknown id — no-op
      if (isVerifiedDone(target)) continue; // verified-done is RETAINED — never pruned
      next = next.filter((it) => it.id !== edit.id);
      continue;
    }

    // reorder: permute the PENDING items into the requested order; verified-done
    // items stay anchored at their ORIGINAL absolute positions so a reorder can
    // never move real, finished work out of place.
    next = reorderPreservingVerified(next, edit.order);
  }

  return next;
}

/**
 * Reorder a roadmap by a desired id order while ANCHORING every verified-done item
 * at its original absolute index. The pending items are re-sequenced per `order`
 * (listed-first, then any omitted pending item in its original relative order);
 * verified-done items occupy exactly the slots they held before. PURE, total.
 */
function reorderPreservingVerified(
  roadmap: readonly RoadmapItem[],
  order: readonly string[],
): RoadmapItem[] {
  const pending = roadmap.filter((it) => !isVerifiedDone(it));
  const byId = new Map(pending.map((it) => [it.id, it]));
  const seen = new Set<string>();
  const sequencedPending: RoadmapItem[] = [];
  // Listed ids first (only PENDING ones; unknown / verified / duplicate ignored).
  for (const id of order) {
    const it = byId.get(id);
    if (it !== undefined && !seen.has(id)) {
      sequencedPending.push(it);
      seen.add(id);
    }
  }
  // Any omitted pending item kept in its original relative order — never dropped.
  for (const it of pending) {
    if (!seen.has(it.id)) sequencedPending.push(it);
  }
  // Re-weave: verified-done items stay in their original slots; pending slots get
  // the re-sequenced pending items in order.
  const out: RoadmapItem[] = [];
  let p = 0;
  for (const it of roadmap) {
    if (isVerifiedDone(it)) {
      out.push(it);
    } else {
      const replacement = sequencedPending[p];
      out.push(replacement ?? it);
      p += 1;
    }
  }
  return out;
}
