/**
 * src/core/vision-triage.ts — Adaptive Partner Engine v2, STAGE 3: vision triage
 * (adaptive-partner-v2-5.6.md §2.4 C and the §4 Stage-3 real-run test).
 *
 * A broad user vision is rarely one homogeneous request. "Part product judgment,
 * part code investigator, maybe a Rust rewrite — make a plan" mixes work that is
 * (a) clearly implementable, (b) a genuine fork only the user can settle, (c) a
 * tech-stack / rearchitecture concern that deserves an opinion before any code,
 * and (d) something the codebase itself would answer if you looked. Treating the
 * whole thing as one bucket is exactly what produces the order-taker menu this
 * engine is built to kill.
 *
 * This module DECOMPOSES the vision into {@link VisionTriageItem}s, each tagged
 * with a {@link VisionDisposition} and a default action, using DETERMINISTIC
 * heuristics over the already-computed `IntentFrame` + task text + a cheap repo
 * signal. STAGE 1 DISCIPLINE: NO new model call — it rides the one gated intent
 * pass (the frame already captures the model's judgment as forks/kind/confidence).
 * The optional IntentFrame-parser extension that would let the extractor emit a
 * richer `triage` is explicitly DEFERRED (doc §2.4 C "Later").
 *
 * GENERAL + DOMAIN-AGNOSTIC (doc §2.4 C / §2.7 F): the fields describe a
 * DISPOSITION and an ACTION, never a product. The same triage works for code,
 * writing, research, ops, design, and product planning. No product name, no
 * project hardcoding.
 *
 * PURE: no I/O, no time, no randomness (`test/arch/guards.ts`). Fail-soft: an
 * absent/garbage frame or empty task degrades to an empty triage (no items), never
 * throws.
 */

import type { IntentFork } from './intent.js';
import type { EngagementSignals } from './engagement.js';
import { hasGenuineFork, isInvestigable, isGenericOpenMenuForkText } from './engagement.js';

// ---------------------------------------------------------------------------
// Shapes (doc §2.4 C)
// ---------------------------------------------------------------------------

/**
 * How a single part of the vision should be handled this turn.
 *   - SOLID                   : clear, in-scope, implementable now → proceed.
 *   - DISCUSS                 : a genuine fork (vision / priority / preference /
 *                               external decision) only the user can settle.
 *   - MIGRATE_REARCHITECT     : a tech-stack / language / rearchitecture concern
 *                               that needs an opinionated note before code.
 *   - INVESTIGATE_THEN_PROPOSE: answerable by reading the code/context first.
 */
export type VisionDisposition =
  | 'SOLID'
  | 'DISCUSS'
  | 'MIGRATE_REARCHITECT'
  | 'INVESTIGATE_THEN_PROPOSE';

/** The default handling for an item — what the orchestrator/model should DO with it. */
export type VisionDefaultAction = 'proceed' | 'ask_user' | 'flag_architecture' | 'investigate';

/**
 * One decomposed part of the user's vision with its disposition + default action
 * (doc §2.4 C). General by construction: `claim` is free text, the rest describe
 * disposition/action, never a domain.
 */
export interface VisionTriageItem {
  /** Stable key within the turn (reused as a fork/question id when `question` is set). */
  readonly id: string;
  /** The part of the vision, in plain language. */
  readonly claim: string;
  readonly disposition: VisionDisposition;
  /** Why this disposition was chosen (short, for the rendered directive + tests). */
  readonly rationale: string;
  readonly defaultAction: VisionDefaultAction;
  /** Optional supporting signals (lexicon hits / repo facts) for transparency. */
  readonly evidence?: readonly string[];
  /** For a DISCUSS item that is a genuine fork: the fork to voice (reuses ASK machinery). */
  readonly question?: IntentFork;
}

/** Inputs to {@link triageVision}. PURE — no model call, no I/O. */
export interface TriageVisionInput {
  /** The engagement signals (carries the frame, classification, task). */
  readonly signals: EngagementSignals;
  /**
   * True when the deterministic ENVIRONMENT/repo-map block indicates a repo is
   * present in cwd. Lets INVESTIGATE_THEN_PROPOSE prefer code inspection over a
   * question when there is actually code to read. Absent → treated as no repo.
   */
  readonly repoPresent?: boolean;
}

// ---------------------------------------------------------------------------
// Caps — small, honest, never crowds the task
// ---------------------------------------------------------------------------

/** Max triage items per turn. A vision with more parts is still bounded. */
const MAX_TRIAGE_ITEMS = 6;
const CLAIM_LIMIT = 200;
const RATIONALE_LIMIT = 160;

// ---------------------------------------------------------------------------
// Disposition lexicons (deterministic, PURE)
// ---------------------------------------------------------------------------

/**
 * MIGRATE_REARCHITECT: a tech-stack / language / rearchitecture concern. This is
 * NARROWER than the engagement `IRREVERSIBLE_LEXICON` (which matches a bare
 * "migrate" / "deploy" as a reversibility signal): here we require a STRUCTURAL
 * change — rewrite/port to another language or runtime, replace the core, move
 * the architecture — the class of decision that warrants an opinionated note and
 * an IC+ tier before any code. Domain-agnostic: works for a code rewrite, a
 * platform move, a data-store swap, a framework replacement.
 */
const MIGRATE_LEXICON: readonly RegExp[] = [
  // "rewrite in Rust", "port to Go", "rewrite in another language"
  /\b(rewrite|re-?write|port|reimplement|re-?implement)\b[^.?!]{0,40}\b(in|to|into|as|using)\b/i,
  // "rewrite the core", "move the core", "replace the core/engine/runtime"
  /\b(rewrite|move|replace|swap|migrate|extract|rearchitect|re-?architect)\b[^.?!]{0,30}\b(core|engine|runtime|backend|stack|architecture|framework|platform|database|data ?store|infrastructure)\b/i,
  // explicit rearchitecture words
  /\b(rearchitect|re-?architect|rearchitecture|re-?architecture|re-?platform|replatform|ground-?up rewrite|from the ground up)\b/i,
  // language/runtime targets named as a migration ("to Rust", "in Go", "switch to ...")
  /\b(switch|move|migrat\w*)\b[^.?!]{0,30}\b(to|onto)\b[^.?!]{0,30}\b(rust|go|golang|c\+\+|java|kotlin|python|zig|wasm|webassembly|native|microservices?|serverless|monorepo)\b/i,
];

/**
 * INVESTIGATE_THEN_PROPOSE: the part is answerable by looking at the code/context
 * — an explicit inspect/understand/trace signal, OR a "why is X / what causes X /
 * how does X work / is X possible" question that the codebase can settle. The
 * answer is a finding + a proposed plan, never a question back to the user.
 */
const INVESTIGATE_LEXICON: readonly RegExp[] = [
  /\b(investigate|inspect|look at|trace|audit|diagnose|debug|figure out|find out|root cause|why (is|does|are|do)|what(?:'s| is| causes)|how (does|do|is)|where (is|does)|whether|is it possible)\b/i,
  /\b(understand|review|read|examine)\b[^.?!]{0,30}\b(the )?(existing|current|code|codebase|implementation|module|file|how)\b/i,
];

/**
 * Splitters that separate a multi-part vision into candidate parts when the
 * extractor did NOT already break it into forks. Conservative: commas, semicolons,
 * " and ", " then ", "part ... part ...", bullets, newlines.
 */
const PART_SPLIT_RE = /\s*(?:[;\n]|,(?!\s*\d)| and (?:maybe |some )?| then |\bpart\b)\s*/i;

function capLine(value: string, limit: number): string {
  const oneLine = (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) : oneLine;
}

/** Classify a single claim string into a disposition + evidence. PURE. */
function classifyClaim(
  claim: string,
  input: TriageVisionInput,
): { disposition: VisionDisposition; rationale: string; evidence: string[] } {
  const evidence: string[] = [];

  // 1) MIGRATE_REARCHITECT — a structural tech-stack / language / rearchitecture
  //    concern dominates: it must get an opinionated note + an IC+ tier first.
  const migrateHit = MIGRATE_LEXICON.find((re) => re.test(claim));
  if (migrateHit !== undefined) {
    evidence.push('migration/rearchitecture signal');
    return {
      disposition: 'MIGRATE_REARCHITECT',
      rationale:
        'A tech-stack / language / rearchitecture concern — give an opinionated architecture note (cost, risk, reversibility, recommendation) before any implementation.',
      evidence,
    };
  }

  // 2) INVESTIGATE_THEN_PROPOSE — the part is answerable by reading the code/
  //    context. Prefer this over a question whenever the codebase can settle it.
  if (INVESTIGATE_LEXICON.some((re) => re.test(claim))) {
    evidence.push('investigable signal (code/context can answer)');
    if (input.repoPresent === true) evidence.push('repo present in cwd');
    return {
      disposition: 'INVESTIGATE_THEN_PROPOSE',
      rationale:
        'Answerable by reading the code/context — investigate first, then return findings plus a proposed plan (do not ask the user a question the code answers).',
      evidence,
    };
  }

  // 3) Default — SOLID. Clear, in-scope, implementable now.
  return {
    disposition: 'SOLID',
    rationale: 'Clear, in-scope implementable work — state the interpretation briefly and proceed.',
    evidence,
  };
}

/** Map a disposition to its default action. PURE, total. */
function actionFor(disposition: VisionDisposition): VisionDefaultAction {
  switch (disposition) {
    case 'DISCUSS':
      return 'ask_user';
    case 'MIGRATE_REARCHITECT':
      return 'flag_architecture';
    case 'INVESTIGATE_THEN_PROPOSE':
      return 'investigate';
    case 'SOLID':
    default:
      return 'proceed';
  }
}

/**
 * Decompose the user's vision into triage items (doc §2.4 C). PURE; never throws;
 * NO model call. Returns `readonly VisionTriageItem[]` (possibly empty).
 *
 * Signature:
 *   triageVision(input: TriageVisionInput): readonly VisionTriageItem[]
 *
 * Sourcing strategy (deterministic, Stage-1 heuristics only):
 *   1. Each GENUINE non-investigable fork in the frame (vision / preference /
 *      external decision the code cannot answer) becomes a DISCUSS item carrying
 *      the fork, so the existing ASK machinery (`deriveAskFromForks` / ASK_CAP /
 *      `hasGenuineFork`) routes it. An INVESTIGABLE or generic-menu fork is NOT a
 *      DISCUSS item — it is reclassified by inspecting its question text (it
 *      becomes INVESTIGATE_THEN_PROPOSE, never an order-taker menu).
 *   2. The task text is split into candidate parts; each part is classified by
 *      {@link classifyClaim} into SOLID / MIGRATE_REARCHITECT /
 *      INVESTIGATE_THEN_PROPOSE. This catches migration / investigation concerns
 *      the extractor did not voice as a fork.
 *   3. Dedup near-identical claims; cap at {@link MAX_TRIAGE_ITEMS}.
 *
 * Fail-soft: empty task → []. A single clear claim with no fork → one SOLID item.
 */
export function triageVision(input: TriageVisionInput): readonly VisionTriageItem[] {
  if (input === null || typeof input !== 'object') return [];
  const signals = input.signals;
  if (signals === null || typeof signals !== 'object') return [];
  const task = typeof signals.task === 'string' ? signals.task : '';
  if (task.trim().length === 0) return [];

  const items: VisionTriageItem[] = [];
  const seen = new Set<string>();
  let n = 0;

  const pushItem = (
    claim: string,
    disposition: VisionDisposition,
    rationale: string,
    evidence: readonly string[],
    question?: IntentFork,
  ): void => {
    const cappedClaim = capLine(claim, CLAIM_LIMIT);
    if (cappedClaim.length === 0) return;
    const key = cappedClaim.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (items.length >= MAX_TRIAGE_ITEMS) return;
    n++;
    const item: VisionTriageItem = {
      id: `V${n}`,
      claim: cappedClaim,
      disposition,
      rationale: capLine(rationale, RATIONALE_LIMIT),
      defaultAction: actionFor(disposition),
      ...(evidence.length > 0 ? { evidence: evidence.slice(0, 4) } : {}),
      ...(question !== undefined ? { question } : {}),
    };
    items.push(item);
  };

  // 1) Forks → DISCUSS (genuine, non-investigable) or reclassify.
  const forks = signals.frame?.forks ?? [];
  const turnHasGenuineFork = hasGenuineFork(signals);
  const turnInvestigable = isInvestigable(signals);
  for (const fork of forks) {
    if (fork === null || typeof fork !== 'object') continue;
    const question = typeof fork.question === 'string' ? fork.question : '';
    if (question.trim().length === 0) continue;

    // A generic order-taker fork ("are you fixing/adding/polishing?") is never a
    // DISCUSS item — the code/context should resolve it. Reclassify to investigate.
    if (isGenericOpenMenuForkText(question, fork.options)) {
      pushItem(
        question,
        'INVESTIGATE_THEN_PROPOSE',
        'A generic task-category fork — resolve by inspecting the repo/context and recommending the concrete next step, not by asking.',
        ['generic-menu fork reclassified to investigate'],
      );
      continue;
    }

    // Only a GENUINE non-investigable fork (or any fork on a plainly non-
    // investigable turn) is worth discussing with the user.
    const forkIsGenuine = turnHasGenuineFork && (!turnInvestigable || NON_INVESTIGABLE_FORK_TEXT.some((re) => re.test(question)));
    if (forkIsGenuine) {
      pushItem(
        question,
        'DISCUSS',
        'A genuine fork (vision / preference / external decision) only the user can settle — if it materially changes the result, ask it once; otherwise recommend a default.',
        ['genuine non-investigable fork'],
        fork,
      );
    } else {
      // Investigable fork → look, do not interrogate.
      pushItem(
        question,
        'INVESTIGATE_THEN_PROPOSE',
        'An investigable fork — the code/context can answer it; investigate then propose, do not ask.',
        ['investigable fork'],
      );
    }
  }

  // 2) Task parts → SOLID / MIGRATE_REARCHITECT / INVESTIGATE_THEN_PROPOSE.
  const parts = task
    .split(PART_SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // A single-part task still yields its one classified item; a multi-part vision
  // yields one per meaningful part.
  for (const part of parts) {
    const { disposition, rationale, evidence } = classifyClaim(part, input);
    pushItem(part, disposition, rationale, evidence);
  }

  return items;
}

/**
 * Non-investigable fork lexicon (mirrors engagement.ts) — used to confirm a fork's
 * TEXT reads as a vision/preference/external decision. Kept local so vision-triage
 * does not depend on engagement internals beyond the exported predicates.
 */
const NON_INVESTIGABLE_FORK_TEXT: readonly RegExp[] = [
  /\b(prefer|preference|want|would you like|which (do|would) you)\b/i,
  /\b(vision|priorit(y|ies)|goal|audience|tone|style|brand|aesthetic|look and feel)\b/i,
  /\b(budget|deadline|timeline|scope|tradeoff|trade-off)\b/i,
  /\b(should we|do you want|are you ok|is it ok|go ahead|approve)\b/i,
];

// ---------------------------------------------------------------------------
// Derived routing facts (consumed by turn-directive's compiler)
// ---------------------------------------------------------------------------

/** True when ANY item is a MIGRATE_REARCHITECT concern. PURE. */
export function hasMigrationConcern(items: readonly VisionTriageItem[]): boolean {
  return Array.isArray(items) && items.some((i) => i.disposition === 'MIGRATE_REARCHITECT');
}

/** True when ANY item requires INVESTIGATE_THEN_PROPOSE. PURE. */
export function hasInvestigateConcern(items: readonly VisionTriageItem[]): boolean {
  return Array.isArray(items) && items.some((i) => i.disposition === 'INVESTIGATE_THEN_PROPOSE');
}

/** The first DISCUSS item carrying a genuine fork, or undefined. PURE. */
export function firstDiscussFork(items: readonly VisionTriageItem[]): IntentFork | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const i of items) {
    if (i.disposition === 'DISCUSS' && i.question !== undefined) return i.question;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Render (doc §2.4 C) — a concise triage directive for the prompt seam
// ---------------------------------------------------------------------------

const DISPOSITION_INSTRUCTION: Record<VisionDisposition, string> = {
  SOLID: 'state the interpretation in one line and proceed',
  DISCUSS: 'surface the genuine fork; if it materially changes the result ask it once, else recommend a default',
  MIGRATE_REARCHITECT:
    'give an opinionated architecture note (cost, risk, reversibility, your recommendation) BEFORE any implementation',
  INVESTIGATE_THEN_PROPOSE: 'investigate the code/context first, then return findings plus a proposed plan — do not ask',
};

/**
 * Render the concise VISION TRIAGE block for the prompt seam
 * (`assembleContextBlocks`). Returns "" when there are no items (the seam then
 * omits it). PURE.
 *
 * The block tells the model to ADDRESS EACH PART PER ITS DISPOSITION and to
 * RECOMMEND A SEQUENCE — explicitly NOT to offer generic options (doc §2.4 C /
 * Stage-3 real-run test). Capped by the seam's overall context cap.
 */
export function renderVisionTriageBlock(items: readonly VisionTriageItem[] | undefined): string {
  if (items === undefined || items.length === 0) return '';

  const lines: string[] = [
    'VISION TRIAGE (the request has distinct parts — address EACH per its disposition; then recommend a SEQUENCE, do NOT offer a generic menu of options):',
  ];
  for (const item of items) {
    const instr = DISPOSITION_INSTRUCTION[item.disposition];
    lines.push(`- [${item.disposition}] ${item.claim} → ${instr}.`);
  }
  lines.push(
    'Separate the solid work, the genuine forks to discuss, the migration/rearchitecture concerns (with your opinion), and the investigate-first items. End with a recommended ORDER of attack, not a list of generic options.',
  );
  return lines.join('\n');
}
