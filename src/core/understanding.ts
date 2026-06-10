/**
 * src/core/understanding.ts — the PURE core for the WHOLE-PICTURE UNDERSTANDING
 * PASS (elite-partner architecture Part 2, "whole-picture understanding —
 * motherboard depth").
 *
 * THE HEADLINE BEHAVIOUR: before the planning brain stages goals, the partner
 * gains DEEP, EXPERT, CURRENT understanding of the REAL system. Instead of
 * decomposing the owner's turn into a naive parts-list, a manager-tier model does
 * a READ-ONLY investigation of the actual codebase — mapping the relevant modules
 * and how they interconnect, the conventions, the hard constraints, and the
 * genuinely-open questions it CANNOT resolve from the code — plus, for high-stakes
 * or novel-domain work, where CURRENT best practice matters (with citations only
 * when actually researched). The result is a structured {@link SystemModel} that
 * GROUNDS the planner so the staged goals reflect whole-picture depth (the
 * "motherboard, not CPU+GPU" bar).
 *
 * This module is the PURE half (no fs/path/child_process/Date/Math.random),
 * exactly like `goal-plan.ts` / `goal-objective.ts`: it builds the one-shot prompt
 * (read by a MANAGER-tier model, given the product-vision / quality-bar persona
 * first) and parses the tagged reply into a {@link SystemModel}. The model touch
 * itself lives behind the injected pass in `understanding-generator.ts` (a near-
 * twin of `goal-objective-generator.ts`). Fail-soft contract: the parser returns
 * `null` on ANY unusable reply so the caller simply runs the planner UNGROUNDED
 * (exactly today's behaviour) — understanding ADDS depth when it fires and is
 * SILENT when it can't, never fabricated.
 *
 * HONESTY (hard): openQuestions and researchCitations are real-or-absent, never
 * fabricated. An open question becomes a sharp clarifying question for the planner;
 * it is NEVER an invented answer. A citation appears only when best practice was
 * genuinely researched.
 */

import { ELITE_VOICE_PREAMBLE } from './prompt.js';

/** Hard cap on the SUMMARY — a crisp paragraph, not an essay. */
const UNDERSTANDING_SUMMARY_MAX_CHARS = 600;
/** Hard cap on a single list item (a module / convention / constraint / question /
 *  citation) — a concrete line, not a paragraph. */
const UNDERSTANDING_ITEM_MAX_CHARS = 200;
/** Bounded list counts so a runaway reply can never bloat the planner prompt.
 *  Exported so the prompt's documented caps and the parser's enforcement share ONE
 *  source of truth (consumed by understanding tests + buildUnderstandingPrompt). */
export const UNDERSTANDING_MAX_MODULES = 12;
export const UNDERSTANDING_MAX_CONVENTIONS = 8;
export const UNDERSTANDING_MAX_CONSTRAINTS = 8;
export const UNDERSTANDING_MAX_OPEN_QUESTIONS = 6;
export const UNDERSTANDING_MAX_CITATIONS = 8;

/**
 * The structured whole-picture understanding of the relevant part of the REAL
 * system, produced by the manager-tier read-only investigation. Every field is
 * grounded: `summary` reframes the relevant slice of the motherboard; `modules`
 * are the real key modules + how they interconnect; `conventions`/`constraints`
 * are the actual house rules + hard limits (e.g. "subscription-OAuth only, no
 * embeddings"); `openQuestions` are the genuinely-unresolvable-from-code questions
 * (→ the planner's sharp clarifying asks, NEVER fabricated answers);
 * `researchCitations` are real sources, present ONLY when current best practice was
 * actually researched.
 */
export interface SystemModel {
  readonly summary: string;
  readonly modules: readonly string[];
  readonly conventions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
  readonly researchCitations: readonly string[];
}

/**
 * Build the one-shot whole-picture-understanding prompt. Read by a CAPABLE
 * (manager-tier) model in a READ-ONLY sandbox, so it leads with the product-vision
 * / quality-bar persona (the reused {@link ELITE_VOICE_PREAMBLE}), then asks the
 * model to INVESTIGATE the real system (it may READ files) and reply with ONLY
 * tagged lines. PURE; never throws. Returns '' for an empty task so the caller's
 * generator does nothing.
 *
 * @param task        the owner's turn / the work about to be planned (what to
 *                    investigate the system for).
 * @param repoContext optional — a deterministic repo-map / environment block, so
 *                    the model orients on the real tree before reading.
 */
export function buildUnderstandingPrompt(task: string, repoContext?: string): string {
  const text = (task ?? '').trim();
  if (text.length === 0) return '';
  const lines: string[] = [
    ELITE_VOICE_PREAMBLE,
    '',
    'Using that bar, you are the WHOLE-PICTURE UNDERSTANDING PASS of an autonomous',
    'engineering partner. BEFORE any goals are planned, your job is to map the RELEVANT',
    'slice of the REAL system the work touches — so the plan reflects the whole',
    'motherboard, not a naive parts-list.',
    '',
    'CRITICAL — YOU ARE UNDER A HARD TIME BUDGET (seconds, not minutes). Work PRIMARILY',
    'from the repository orientation below and your senior engineering judgment. This is',
    'a READ-ONLY pass (you MUST NOT modify anything); you MAY read AT MOST 2 files, and',
    'ONLY if truly essential to answer. Do NOT explore the tree or open many files — a',
    'confident map-level understanding delivered FAST is the goal, never an exhaustive',
    'investigation. Answer the moment you can fill the tags. Map:',
    '  - the key modules involved and HOW THEY INTERCONNECT (not just a file list);',
    '  - the conventions the code actually follows (patterns, idioms, house style);',
    '  - the HARD constraints you must respect (e.g. "subscription-OAuth only, no',
    '    embeddings / no metered services", flag-gated neutrality, purity rules);',
    '  - the genuinely-OPEN questions you CANNOT resolve — the things a senior would',
    '    ASK the owner before committing (scale? quality bar? which surface? a',
    '    destructive choice? a task mis-targeted at the wrong repo?). These become',
    '    clarifying questions.',
    '',
    'For HIGH-STAKES or NOVEL-DOMAIN work (security, auth, money, data-loss, modern',
    'workflows / methods that move fast), note WHERE current best practice matters,',
    'and — only if you genuinely researched it — cite the sources.',
    '',
    'Reply with ONLY tagged lines, nothing else:',
    '  SUMMARY: <one crisp paragraph reframing the relevant slice of the real system>',
    '  MODULE: <a key module + how it connects to the others> (repeatable)',
    '  CONVENTION: <a real convention the code follows> (repeatable)',
    '  CONSTRAINT: <a hard constraint that must be respected> (repeatable)',
    '  OPENQ: <a genuinely-open question you could NOT resolve from the code> (repeatable)',
    '  CITE: <a real source for current best practice — ONLY if actually researched> (repeatable)',
    '',
    'Hard rules:',
    `  - At most ${String(UNDERSTANDING_MAX_MODULES)} MODULE, ${String(UNDERSTANDING_MAX_CONVENTIONS)} CONVENTION, ${String(UNDERSTANDING_MAX_CONSTRAINTS)} CONSTRAINT, ${String(UNDERSTANDING_MAX_OPEN_QUESTIONS)} OPENQ, ${String(UNDERSTANDING_MAX_CITATIONS)} CITE lines.`,
    '  - HONESTY IS NON-NEGOTIABLE. OPENQ lines are REAL open questions, never invented',
    '    answers. CITE lines appear ONLY when you actually researched the source — if',
    '    you did not research, emit NO CITE lines. Never fabricate a citation.',
    '  - Ground everything in the orientation + what you actually verified. Do not guess',
    '    at modules or constraints you did not see.',
    '  - Reply with ONLY the tagged lines above. No prose, no preamble, no markdown,',
    '    no code fences.',
  ];
  if (typeof repoContext === 'string' && repoContext.trim().length > 0) {
    lines.push('', 'REPOSITORY ORIENTATION (the real tree — your PRIMARY source):', repoContext.trim());
  }
  lines.push('', 'THE WORK TO UNDERSTAND THE SYSTEM FOR:', text);
  return lines.join('\n');
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

/** Bound a value to a max length on a word boundary. */
function capLen(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, '').trim();
  return cut.length > 0 ? cut : s.slice(0, max).trim();
}

/**
 * Parse the model's tagged reply into a {@link SystemModel}, or `null` when the
 * reply is unusable so the caller runs the planner UNGROUNDED (today's behaviour).
 * Defensive: never throws, caps every list count + length, and refuses to
 * fabricate — a reply with no SUMMARY and no usable list content degrades to
 * `null`. PURE.
 */
export function parseSystemModel(raw: string | undefined | null): SystemModel | null {
  if (typeof raw !== 'string') return null;
  const rawLines = raw.split(/\r?\n/);

  let summary: string | undefined;
  const modules: string[] = [];
  const conventions: string[] = [];
  const constraints: string[] = [];
  const openQuestions: string[] = [];
  const citations: string[] = [];

  const pushCapped = (arr: string[], value: string, max: number): void => {
    if (value.length === 0) return;
    if (arr.length >= max) return;
    const v = capLen(value, UNDERSTANDING_ITEM_MAX_CHARS);
    if (v.length > 0) arr.push(v);
  };

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const m = /^([※⏺*\-•]\s*)?([A-Za-z]+)\s*[:\-—]\s*(.*)$/u.exec(trimmed);
    if (m === null) continue;
    const tag = (m[2] ?? '').toLowerCase();
    const value = cleanValue(m[3] ?? '');
    if (value.length === 0) continue;

    switch (tag) {
      case 'summary':
        if (summary === undefined) summary = capLen(value, UNDERSTANDING_SUMMARY_MAX_CHARS);
        break;
      case 'module':
        pushCapped(modules, value, UNDERSTANDING_MAX_MODULES);
        break;
      case 'convention':
        pushCapped(conventions, value, UNDERSTANDING_MAX_CONVENTIONS);
        break;
      case 'constraint':
        pushCapped(constraints, value, UNDERSTANDING_MAX_CONSTRAINTS);
        break;
      case 'openq':
        pushCapped(openQuestions, value, UNDERSTANDING_MAX_OPEN_QUESTIONS);
        break;
      case 'cite':
        pushCapped(citations, value, UNDERSTANDING_MAX_CITATIONS);
        break;
      default:
        break;
    }
  }

  // Honest usability gate: a model that read nothing of value gives us nothing to
  // ground the planner with. Require a SUMMARY, OR at least one module/constraint
  // (the load-bearing grounding) — otherwise degrade to null (planner runs
  // ungrounded, exactly as today). Open questions / citations alone are NOT enough
  // to claim we understood the system.
  const hasGrounding =
    (summary !== undefined && summary.length > 0) ||
    modules.length > 0 ||
    constraints.length > 0;
  if (!hasGrounding) return null;

  return {
    summary: summary ?? '',
    modules,
    conventions,
    constraints,
    openQuestions,
    researchCitations: citations,
  };
}
