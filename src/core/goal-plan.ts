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
import type { RoadmapItem } from './work-contract.js';
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
/** Hard caps on the best-approach lines (a concise strategy, not an essay). The
 *  store's capGoal re-caps at 400/160, so these are the prompt-side display bound. */
const GOAL_PLAN_APPROACH_MAX_CHARS = 200;
const GOAL_PLAN_APPROACH_ALT_MAX_CHARS = 80;
/** Bounded list of named alternatives per goal (a handful, not a survey). */
const GOAL_PLAN_APPROACH_MAX_ALTS = 4;
/** Bounded counts (mirror the roadmap cap-8 discipline): ≤4 goals, ≤8 todos each.
 *  Exported so the prompt's documented caps and the parser's enforcement share ONE
 *  source of truth (consumed by goal-plan tests + buildGoalPlanPrompt). */
export const GOAL_PLAN_MAX_GOALS = 4;
export const GOAL_PLAN_MAX_TODOS = 8;

/**
 * One concrete to-do step of a planned goal. `text` is the step; `dependsOn` is an
 * OPTIONAL list of 1-based indices of EARLIER todos in the SAME goal that this step
 * truly blocks on (e.g. "build the UI that calls the API" depends on "wire the API").
 * Indices are always strictly LESS than this todo's own 1-based position — the
 * parser drops self / forward / out-of-range refs — so the dependency graph a plan
 * expresses is naturally acyclic. Most todos have NO `dependsOn` (omitted entirely),
 * so a flat plan is byte-identical to the pre-dependency shape.
 */
export interface GoalPlanTodo {
  readonly text: string;
  readonly dependsOn?: readonly number[];
}

/**
 * The judged plan for one owner turn. `judgment` is the senior verdict:
 *   - `none`    → goals is empty, no question (do nothing — frictionless).
 *   - `stage`   → ≥1 goal, each with its todos (+ an optional vision framing).
 *   - `clarify` → a single `clarifyingQuestion` (no goals auto-created).
 * Each goal carries a professional title + its concrete to-do steps (the parked
 * goal's roadmap-to-be), each step optionally carrying its true blockers
 * (see {@link GoalPlanTodo}).
 */
/**
 * The best-approach a planned goal carries: the CHOSEN strategy + WHY it beats
 * the alternatives, grounded in the real system when the SystemModel is warm.
 * OPTIONAL per goal (trivial goals omit it). Maps 1:1 onto the stored
 * {@link RoadmapItemApproach} (chosen/rationale/alternatives) at create time.
 */
interface GoalPlanApproach {
  readonly chosen: string;
  readonly rationale: string;
  readonly alternatives?: readonly string[];
}

export interface GoalPlan {
  readonly judgment: 'none' | 'stage' | 'clarify';
  readonly vision?: string;
  readonly goals: readonly {
    readonly title: string;
    readonly todos: readonly GoalPlanTodo[];
    /** The goal's best-approach (chosen + why), when the planner stated one. */
    readonly approach?: GoalPlanApproach;
  }[];
  readonly clarifyingQuestion?: string;
  /**
   * What the caps TRUNCATED from the model's reply (the owner's "never hide a cap"
   * rule). Present ONLY when something was dropped (a model that stayed within
   * GOAL_PLAN_MAX_GOALS / _MAX_TODOS yields no `dropped` field → byte-identical).
   * `goals` = extra goals beyond the cap; `perGoalTodos` maps a goal's index to how
   * many of its to-dos were trimmed. The proposal renderer surfaces these honestly.
   */
  readonly dropped?: {
    readonly goals: number;
    readonly perGoalTodos: ReadonlyMap<number, number>;
  };
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
    '      APPROACH: <the chosen strategy — the smartest, most-efficient way to do it>',
    '      WHY: <why it beats the alternatives, grounded in the real system>',
    '      ALT: <a rejected option, another rejected option>',
    '      TODO: <a concrete first step of that goal>',
    '      TODO: <the next concrete step>',
    '      TODO: <a step that truly needs earlier ones first>  [after: 1, 2]',
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
    '  - OPTIONALLY mark a TODO\'s TRUE blockers with a trailing [after: <n>, <n>]',
    '    where each <n> is the 1-based number of an EARLIER todo IN THE SAME GOAL that',
    '    must finish first (todos count from 1 within their goal). Use it ONLY for a',
    '    real ordering blocker — e.g. "build the UI that calls the API" comes [after:]',
    '    "wire the API endpoint". MOST todos have NO blocker; omit the marker then. A',
    '    todo may only reference EARLIER numbers (never itself or a later one).',
    `  - At most ${String(GOAL_PLAN_MAX_GOALS)} goals; at most ${String(GOAL_PLAN_MAX_TODOS)} todos per goal. Prefer fewer,`,
    '    sharper goals over a sprawl.',
    '  - For a goal with real engineering depth, state the smartest APPROACH: a',
    '    concise APPROACH line (the chosen strategy) immediately under its GOAL, a',
    '    WHY line (why it beats the alternatives — grounded in the real system when',
    '    you know it), and OPTIONALLY one ALT line (the rejected options, comma-',
    "    separated). Both APPROACH and WHY are required together or omit BOTH — never",
    '    state a strategy with no reasoning. SKIP all three for a trivial goal; keep',
    '    them SHORT (one line each). They attach to the GOAL directly above them.',
    "  - You are an advisor, NOT a yes-man. If the owner named a way to do it but a",
    '    materially BETTER path exists for their real goal, make APPROACH the better',
    "    path — not theirs — say in WHY why it wins, and put their stated way in ALT.",
    '    Recommend the genuinely smarter route (the obvious/familiar pick is not always',
    '    best); do not default to what they asked when the evidence says otherwise.',
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
 * Split a TODO value into its display text + the OPTIONAL trailing
 * `[after: <n>, <n>]` dependency marker. The marker (case-insensitive, last one on
 * the line) is parsed into a raw list of 1-based indices and STRIPPED from the text;
 * a value with no marker returns `{ text }` (byte-identical to the no-dependency
 * shape). PURE, defensive: any unparseable number is skipped; a marker with no usable
 * number is treated as absent (and still stripped from the text). Range/forward/self
 * validation happens at the call site, where the todo's own position is known.
 */
function splitAfterMarker(value: string): { text: string; afterRaw: number[] } {
  const m = /^(.*?)\s*\[\s*after\s*:\s*([0-9 ,]*?)\s*\]\s*$/i.exec(value);
  if (m === null) return { text: value, afterRaw: [] };
  const text = (m[1] ?? '').trim();
  const afterRaw: number[] = [];
  for (const tok of (m[2] ?? '').split(',')) {
    const t = tok.trim();
    if (t.length === 0) continue;
    const n = Number.parseInt(t, 10);
    if (Number.isInteger(n)) afterRaw.push(n);
  }
  // If the marker had no usable number, the text is still stripped of it; the empty
  // afterRaw means "no dependency" (byte-identical downstream to a plain todo).
  return { text: text.length > 0 ? text : value.trim(), afterRaw };
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
  // Each goal accumulates an OPTIONAL approach as APPROACH/WHY/ALT lines arrive
  // (they attach to the most-recent GOAL). `chosen`/`rationale` start undefined;
  // the approach is only emitted at finalize when BOTH are present (never a half-
  // record). A goal with no APPROACH/WHY keeps these undefined → no approach field.
  const goals: {
    title: string;
    todos: GoalPlanTodo[];
    chosen?: string;
    rationale?: string;
    alternatives?: string[];
  }[] = [];
  // Honest-truncation tracking (the owner's "never hide a cap" rule): count what the
  // caps drop so the proposal can disclose it. Stays at 0 / empty when the model
  // respected the caps → no `dropped` field → byte-identical.
  let droppedGoals = 0;
  const droppedTodosByGoal = new Map<number, number>();
  // True once we're inside a GOAL that the cap DROPPED. Its following APPROACH/WHY/
  // ALT/TODO lines must NOT fall through onto the last KEPT goal — that would absorb a
  // dropped goal's to-dos into a surviving one, over-counting the headline to-do total
  // and misattributing steps (a radical-honesty violation). The whole dropped goal is
  // disclosed wholesale via `droppedGoals`, so its lines are simply suppressed here.
  let inDroppedGoal = false;

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
      if (goals.length >= GOAL_PLAN_MAX_GOALS) {
        droppedGoals += 1; // over the goal cap — record it, never silently drop
        inDroppedGoal = true; // suppress this dropped goal's following APPROACH/WHY/ALT/TODO
        continue;
      }
      goals.push({ title: capLen(value, GOAL_PLAN_TITLE_MAX_CHARS), todos: [] });
      inDroppedGoal = false; // a KEPT goal — its following lines attach here
      continue;
    }
    if (tag === 'approach') {
      if (value.length === 0) continue;
      if (inDroppedGoal) continue; // belongs to a dropped goal — never attach to the last kept one
      const current = goals[goals.length - 1];
      if (current === undefined) continue; // an APPROACH before any GOAL is dropped
      if (current.chosen === undefined) current.chosen = capLen(value, GOAL_PLAN_APPROACH_MAX_CHARS);
      continue;
    }
    if (tag === 'why') {
      if (value.length === 0) continue;
      if (inDroppedGoal) continue; // belongs to a dropped goal — never attach to the last kept one
      const current = goals[goals.length - 1];
      if (current === undefined) continue; // a WHY before any GOAL is dropped
      if (current.rationale === undefined) current.rationale = capLen(value, GOAL_PLAN_APPROACH_MAX_CHARS);
      continue;
    }
    if (tag === 'alt') {
      if (value.length === 0) continue;
      if (inDroppedGoal) continue; // belongs to a dropped goal — never attach to the last kept one
      const current = goals[goals.length - 1];
      if (current === undefined) continue; // an ALT before any GOAL is dropped
      if (current.alternatives === undefined) {
        const alts: string[] = [];
        const seen = new Set<string>();
        for (const tok of value.split(',')) {
          const a = capLen(cleanValue(tok), GOAL_PLAN_APPROACH_ALT_MAX_CHARS);
          if (a.length === 0 || seen.has(a)) continue;
          seen.add(a);
          alts.push(a);
          if (alts.length >= GOAL_PLAN_APPROACH_MAX_ALTS) break;
        }
        if (alts.length > 0) current.alternatives = alts;
      }
      continue;
    }
    if (tag === 'todo') {
      if (value.length === 0) continue;
      if (inDroppedGoal) continue; // a dropped goal's to-do — suppress (the whole goal is disclosed)
      const current = goals[goals.length - 1];
      if (current === undefined) continue; // a TODO before any GOAL is dropped
      if (current.todos.length >= GOAL_PLAN_MAX_TODOS) {
        const gi = goals.length - 1; // over the per-goal to-do cap — record it
        droppedTodosByGoal.set(gi, (droppedTodosByGoal.get(gi) ?? 0) + 1);
        continue;
      }
      const { text, afterRaw } = splitAfterMarker(value);
      if (text.length === 0) continue;
      // This todo's own 1-based position within its goal (it is about to be pushed).
      const position = current.todos.length + 1;
      // Keep only EARLIER, in-range, deduped refs — naturally acyclic. Drop self
      // (>= position), forward (> position), and out-of-range (< 1) indices.
      const seen = new Set<number>();
      const dependsOn: number[] = [];
      for (const n of afterRaw) {
        if (n >= 1 && n < position && !seen.has(n)) {
          seen.add(n);
          dependsOn.push(n);
        }
      }
      current.todos.push({
        text: capLen(text, GOAL_PLAN_TODO_MAX_CHARS),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      });
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
      goals: usableGoals.map((g) => {
        // Emit the approach ONLY when BOTH chosen + rationale are present (never a
        // half-record); a goal that stated neither is byte-identical to before.
        const approach: GoalPlanApproach | undefined =
          g.chosen !== undefined && g.chosen.length > 0 && g.rationale !== undefined && g.rationale.length > 0
            ? {
                chosen: g.chosen,
                rationale: g.rationale,
                ...(g.alternatives !== undefined && g.alternatives.length > 0
                  ? { alternatives: g.alternatives }
                  : {}),
              }
            : undefined;
        return {
          title: g.title,
          todos: g.todos.slice(0, GOAL_PLAN_MAX_TODOS),
          ...(approach !== undefined ? { approach } : {}),
        };
      }),
      // Honest cap disclosure — present ONLY when the caps actually trimmed something
      // (within-cap plans omit it → byte-identical). The proposal renderer surfaces it.
      ...(droppedGoals > 0 || droppedTodosByGoal.size > 0
        ? { dropped: { goals: droppedGoals, perGoalTodos: droppedTodosByGoal } }
        : {}),
    };
  }
  if (judgment === 'clarify') {
    if (clarifyingQuestion === undefined) return null; // "clarify" with no question → do nothing
    return { judgment: 'clarify', goals: [], clarifyingQuestion };
  }
  // none
  return { judgment: 'none', goals: [] };
}

// ---------------------------------------------------------------------------
// Cap-transparency helpers — PURE counters for how much was dropped by a cap
// ---------------------------------------------------------------------------

/**
 * How many todos were dropped when a raw model list was capped to `limit`.
 * Returns a non-negative integer: 0 when nothing was dropped (i.e. the raw
 * count was within the limit), positive when some items were silently cut.
 * PURE, total, never throws. Used by the proposal renderer to surface an
 * honest "kept N highest-leverage steps; M more not shown" note only when M>0.
 */
export function countDroppedTodos(rawTodos: readonly unknown[], limit: number): number {
  const raw = Array.isArray(rawTodos) ? rawTodos.length : 0;
  const cap = Math.max(0, limit);
  return Math.max(0, raw - cap);
}

/**
 * How many goals were dropped when a raw model list was capped to `limit`.
 * Returns a non-negative integer: 0 when nothing was dropped. Symmetric
 * with {@link countDroppedTodos} — same honesty-surface contract. PURE, total.
 */
export function countDroppedGoals(rawGoals: readonly unknown[], limit: number): number {
  const raw = Array.isArray(rawGoals) ? rawGoals.length : 0;
  const cap = Math.max(0, limit);
  return Math.max(0, raw - cap);
}

// ---------------------------------------------------------------------------
// planTodosToRoadmap — the PURE index→id translation (table-testable)
// ---------------------------------------------------------------------------

/**
 * Translate a planned goal's to-dos into a fresh roadmap (the parked goal's
 * roadmap-to-be), minting sequential ids `r1, r2, …` in order and converting each
 * todo's 1-based `dependsOn` INDICES into the corresponding sibling roadmap-item
 * ids. PURE, total, never throws. A todo with no deps yields an item with NO
 * `dependsOn` field — byte-identical to the pre-dependency `{id, text, status}`
 * shape. Out-of-range indices (defensive: the parser already drops self/forward/
 * out-of-range, this is a second guard) are skipped; an empty edge set leaves the
 * field off entirely.
 *
 * This is the RAW translation only: sibling-existence, dedupe, fan-in cap, and
 * cycle-stripping are NOT re-done here — they are the single responsibility of
 * {@link normalizeRoadmapRelations}, which the caller's store-write / capRoadmap
 * path already runs. By construction `dependsOn` indices are strictly earlier, so
 * the produced graph is already acyclic.
 */
export function planTodosToRoadmap(todos: readonly GoalPlanTodo[]): RoadmapItem[] {
  const ids = todos.map((_t, i) => `r${String(i + 1)}`);
  return todos.map((todo, i) => {
    const deps: string[] = [];
    const seen = new Set<string>();
    for (const n of todo.dependsOn ?? []) {
      // n is 1-based; a valid ref is an EARLIER item (index < i) within range.
      const idx = n - 1;
      if (idx >= 0 && idx < i) {
        const id = ids[idx];
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          deps.push(id);
        }
      }
    }
    return {
      id: ids[i] ?? `r${String(i + 1)}`,
      text: todo.text,
      status: 'pending' as const,
      ...(deps.length > 0 ? { dependsOn: deps } : {}),
    };
  });
}
