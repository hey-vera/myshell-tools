/**
 * src/core/goal-plan.ts — the PURE core for the PLANNING BRAIN / auto-stage pass
 * (elite-partner architecture Phase 6, "auto-stage vision → parked goals
 * frictionlessly", with an embedded judge).
 *
 * THE HEADLINE BEHAVIOUR: when the owner talks, the partner JUDGES the
 * conversation the way a senior engineer / PM would and decides ONE of three
 * things — frictionlessly, with zero ceremony:
 *   (a) `none`    — trivial / conversational / just-chatting ("sounds good?",
 *                   "thanks", "what do you think") → do NOTHING. No goal, no noise.
 *   (b) `stage`   — clear, substantial work → name a crisp VISION and decompose it
 *                   into one or more professional GOALS, each carrying its own
 *                   to-do list. These are STAGED as PARKED goals (non-destructive)
 *                   so the owner can promote them when ready.
 *   (c) `clarify` — genuinely ambiguous / high-stakes where the partner needs to
 *                   know intent (scale? quality bar? which features?) → surface ONE
 *                   sharp clarifying question instead of guessing.
 *
 * This module is the PURE half (no fs/path/child_process/Date/Math.random),
 * exactly like `goal-objective.ts` / `recap.ts`: it builds the one-shot prompt
 * (read by a MANAGER-tier model, given the product-vision / quality-bar persona
 * first) and parses the tagged reply into a {@link GoalPlan}. The model touch
 * itself lives behind the injected generator in `goal-plan-generator.ts` (a near-
 * twin of `goal-objective-generator.ts`). Fail-soft contract: the parser returns
 * `null` on ANY unusable reply so the caller simply does nothing — auto-staging is
 * frictionless when it fires and SILENT when it can't, never fabricated.
 */

import { ELITE_VOICE_PREAMBLE } from './prompt.js';
import type { SystemModel } from './understanding.js';

/** Hard cap on the VISION line — a crisp framing, not a paragraph. (Module-local:
 *  an internal shaping bound, never imported elsewhere.) */
const GOAL_PLAN_VISION_MAX_CHARS = 120;
/** Hard cap on a single GOAL title — a professional objective, not a sentence. */
const GOAL_PLAN_TITLE_MAX_CHARS = 80;
/** Hard cap on a single TODO step — a concrete step, not an essay. */
const GOAL_PLAN_TODO_MAX_CHARS = 120;
/** Hard cap on the clarifying ASK — one sharp question. */
const GOAL_PLAN_ASK_MAX_CHARS = 200;
/** Bounded counts (mirror the roadmap cap-8 discipline): ≤4 goals, ≤8 todos each.
 *  Exported so the prompt's documented caps and the parser's enforcement share ONE
 *  source of truth (consumed by goal-plan tests + buildGoalPlanPrompt). */
export const GOAL_PLAN_MAX_GOALS = 4;
export const GOAL_PLAN_MAX_TODOS = 8;

/**
 * The judged plan for one owner turn. `judgment` is the senior verdict:
 *   - `none`    → goals is empty, no question (do nothing — frictionless).
 *   - `stage`   → ≥1 goal, each with its todos (+ an optional vision framing).
 *   - `clarify` → a single `clarifyingQuestion` (no goals auto-created).
 * Each goal carries a professional title + its concrete to-do steps (the parked
 * goal's roadmap-to-be).
 */
export interface GoalPlan {
  readonly judgment: 'none' | 'stage' | 'clarify';
  readonly vision?: string;
  readonly goals: readonly { readonly title: string; readonly todos: readonly string[] }[];
  readonly clarifyingQuestion?: string;
}

/**
 * Build the one-shot planning-brain prompt. Read by a CAPABLE (manager-tier)
 * model, so it leads with the product-vision / quality-bar persona (the reused
 * {@link ELITE_VOICE_PREAMBLE}), then asks the model to JUDGE the turn like a
 * senior engineer / PM and reply with ONLY tagged lines. PURE; never throws.
 *
 * @param userMessage   the owner's raw turn text (what to judge).
 * @param assistantReply optional — the partner's reply this turn, for context.
 * @param frameGoal     optional — an active goal/objective the turn sits inside.
 * @param systemModel   optional — the whole-picture understanding of the REAL
 *                      system (understanding.ts). When present its summary,
 *                      constraints and open questions are injected so the plan is
 *                      GROUNDED in the actual codebase (and the clarify questions
 *                      can draw on the understanding's genuinely-open questions).
 *                      ABSENT → the prompt is byte-for-byte today's (the planner
 *                      runs exactly as before the understanding pass existed).
 */
export function buildGoalPlanPrompt(
  userMessage: string,
  assistantReply?: string,
  frameGoal?: string,
  systemModel?: SystemModel,
): string {
  const text = (userMessage ?? '').trim();
  if (text.length === 0) return '';
  const lines: string[] = [
    ELITE_VOICE_PREAMBLE,
    '',
    'Using that bar, you are the PLANNING BRAIN of an autonomous engineering',
    "partner. Read the owner's latest turn and JUDGE it the way a senior engineer",
    'or PM would — then reply with EXACTLY ONE of three verdicts and nothing else.',
    '',
    'Decide the verdict:',
    '  - If the turn is trivial, conversational, or just chatting (a greeting, a',
    '    "thanks", "sounds good?", an opinion question, a quick lookup) — there is',
    '    NO real work to stage. Reply with ONLY:',
    '      JUDGMENT: none',
    '  - If the turn clearly describes SUBSTANTIAL work to do (build/ship/fix/',
    '    migrate/design something real), stage it. Reply with:',
    '      JUDGMENT: stage',
    '      VISION: <one crisp line naming what the owner is really trying to achieve>',
    '      GOAL: <a professional objective, the way a senior would name it>',
    '      TODO: <a concrete first step of that goal>',
    '      TODO: <the next concrete step>',
    '      GOAL: <a second objective, if the work genuinely splits>',
    '      TODO: <a concrete step of the second goal>',
    '  - If the turn is genuinely AMBIGUOUS or HIGH-STAKES and you honestly need to',
    '    know the intent before staging anything (the scale? the quality bar? which',
    '    features? a destructive choice?), do NOT guess. Reply with ONLY:',
    '      JUDGMENT: clarify',
    '      ASK: <one sharp question that unblocks the real decision>',
    '',
    'Hard rules:',
    `  - Decompose like a pro, NOT a naive parts-list: each GOAL is a real objective,`,
    '    each TODO a concrete, checkable step. Order the todos sensibly.',
    `  - At most ${String(GOAL_PLAN_MAX_GOALS)} goals; at most ${String(GOAL_PLAN_MAX_TODOS)} todos per goal. Prefer fewer,`,
    '    sharper goals over a sprawl.',
    "  - NEVER echo the owner's raw phrasing or parrot their words back. Name the",
    '    objective professionally (e.g. "Harden the auth token-refresh path"), not a',
    "    restatement of what they typed.",
    '  - When in doubt about whether there is real work, prefer JUDGMENT: none over',
    '    inventing goals. Staging nothing is better than staging noise.',
    '  - Reply with ONLY the tagged lines above. No prose, no preamble, no',
    '    explanation, no markdown, no code fences.',
  ];
  if (typeof frameGoal === 'string' && frameGoal.trim().length > 0) {
    lines.push('', 'ACTIVE GOAL (context — the turn may sit inside this):', frameGoal.trim());
  }
  if (typeof assistantReply === 'string' && assistantReply.trim().length > 0) {
    lines.push('', "YOUR REPLY THIS TURN (context):", assistantReply.trim());
  }
  // GROUNDING (optional): the whole-picture understanding of the REAL system. When
  // present, the plan must be grounded in it — name objectives that fit the actual
  // modules, respect the hard constraints, and (for clarify) draw on the genuinely-
  // open questions rather than inventing one. ABSENT → these lines are not added, so
  // the prompt is byte-for-byte identical to the pre-understanding planner.
  const grounding = systemModelGrounding(systemModel);
  if (grounding.length > 0) lines.push('', ...grounding);
  lines.push('', "OWNER'S LATEST TURN:", text);
  return lines.join('\n');
}

/**
 * Render the SystemModel into the planner's grounding block, or `[]` when there is
 * no usable understanding (so the prompt stays byte-for-byte today's). PURE; bounds
 * what it injects (summary + the constraints + the genuinely-open questions — the
 * load-bearing grounding for naming + clarifying), never throws.
 */
function systemModelGrounding(systemModel: SystemModel | undefined): string[] {
  if (systemModel === undefined) return [];
  const out: string[] = [];
  const summary = systemModel.summary.trim();
  const constraints = systemModel.constraints.filter((c) => c.trim().length > 0);
  const openQuestions = systemModel.openQuestions.filter((q) => q.trim().length > 0);
  if (summary.length === 0 && constraints.length === 0 && openQuestions.length === 0) {
    return [];
  }
  out.push(
    'WHOLE-PICTURE UNDERSTANDING OF THE REAL SYSTEM (ground the plan in this — name',
    'objectives that fit these real modules + respect these hard constraints; do NOT',
    'plan against a system that does not exist here):',
  );
  if (summary.length > 0) out.push(`  SYSTEM: ${summary}`);
  for (const c of constraints) out.push(`  CONSTRAINT: ${c.trim()}`);
  if (openQuestions.length > 0) {
    out.push(
      'GENUINELY-OPEN QUESTIONS the investigation could NOT resolve from the code —',
      'if the turn is ambiguous, a clarify verdict should draw on THESE real questions',
      '(never an invented one):',
    );
    for (const q of openQuestions) out.push(`  OPENQ: ${q.trim()}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing (fail-soft, defensive, never throws; caps counts + lengths)
// ---------------------------------------------------------------------------

/** Strip a leading marker glyph, collapse whitespace, peel wrapping quotes. */
function cleanValue(raw: string): string {
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

/**
 * Parse the model's tagged reply into a {@link GoalPlan}, or `null` when the
 * reply is unusable so the caller does nothing. Defensive: never throws, caps
 * counts (≤4 goals, ≤8 todos each) and lengths, and refuses to fabricate —
 * a `stage` verdict with no parseable goal degrades to `null`, a `clarify`
 * verdict with no question degrades to `null`. PURE.
 */
export function parseGoalPlan(raw: string | undefined | null): GoalPlan | null {
  if (typeof raw !== 'string') return null;
  const rawLines = raw.split(/\r?\n/);

  let judgment: GoalPlan['judgment'] | null = null;
  let vision: string | undefined;
  let clarifyingQuestion: string | undefined;
  const goals: { title: string; todos: string[] }[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const m = /^([※⏺*\-•]\s*)?([A-Za-z]+)\s*[:\-—]\s*(.*)$/u.exec(trimmed);
    if (m === null) continue;
    const tag = (m[2] ?? '').toLowerCase();
    const value = cleanValue(m[3] ?? '');

    if (tag === 'judgment') {
      const v = value.toLowerCase();
      if (v.startsWith('none')) judgment = judgment ?? 'none';
      else if (v.startsWith('stage')) judgment = judgment ?? 'stage';
      else if (v.startsWith('clarify')) judgment = judgment ?? 'clarify';
      continue;
    }
    if (tag === 'vision') {
      if (value.length > 0 && vision === undefined) vision = capLen(value, GOAL_PLAN_VISION_MAX_CHARS);
      continue;
    }
    if (tag === 'goal') {
      if (value.length === 0) continue;
      if (goals.length >= GOAL_PLAN_MAX_GOALS) continue;
      goals.push({ title: capLen(value, GOAL_PLAN_TITLE_MAX_CHARS), todos: [] });
      continue;
    }
    if (tag === 'todo') {
      if (value.length === 0) continue;
      const current = goals[goals.length - 1];
      if (current === undefined) continue; // a TODO before any GOAL is dropped
      if (current.todos.length >= GOAL_PLAN_MAX_TODOS) continue;
      current.todos.push(capLen(value, GOAL_PLAN_TODO_MAX_CHARS));
      continue;
    }
    if (tag === 'ask') {
      if (value.length > 0 && clarifyingQuestion === undefined) {
        clarifyingQuestion = capLen(value, GOAL_PLAN_ASK_MAX_CHARS);
      }
      continue;
    }
  }

  // Resolve the verdict honestly. The JUDGMENT tag leads, but a missing/garbled
  // tag is recovered from the strongest present signal so a slightly off reply
  // still lands — without ever fabricating a verdict from nothing.
  const usableGoals = goals.filter((g) => g.title.length > 0);
  if (judgment === null) {
    if (usableGoals.length > 0) judgment = 'stage';
    else if (clarifyingQuestion !== undefined) judgment = 'clarify';
    else return null; // no verdict and no signal → unusable
  }

  if (judgment === 'stage') {
    if (usableGoals.length === 0) return null; // "stage" with nothing to stage → do nothing
    return {
      judgment: 'stage',
      ...(vision !== undefined ? { vision } : {}),
      goals: usableGoals.map((g) => ({ title: g.title, todos: g.todos.slice(0, GOAL_PLAN_MAX_TODOS) })),
    };
  }
  if (judgment === 'clarify') {
    if (clarifyingQuestion === undefined) return null; // "clarify" with no question → do nothing
    return { judgment: 'clarify', goals: [], clarifyingQuestion };
  }
  // none
  return { judgment: 'none', goals: [] };
}
