/**
 * src/core/prompt-context.ts — the ONE prompt-assembly seam (MF1).
 *
 * Every prompt builder (sequential `buildPrompt`, panel candidate
 * `buildPanelCandidatePrompt`, and panel synthesizer `buildPanelSynthesisPrompt`)
 * composes its between-system-and-history context through this single shared
 * function. Editing the block set in one place updates all three executors, so
 * panel turns can never again be context-blind (the former #1 blocker — see
 * docs/MASTER-PLAN-5.5.md §MF1).
 *
 * Pure module: no I/O, no time, no randomness. Table-tested.
 *
 * The memoryContext / intentFrame / engagementPlan inputs are produced by later
 * phases (memory = Phase 4, intent = Phase 6, engagement = APE). Phase 2 lands
 * the seam + the rendering so those phases only have to populate the optional
 * fields with ZERO further plumbing. Until then they are simply absent and the
 * assembled string is byte-for-byte identical to the pre-seam prompts.
 */

import {
  renderUntrustedBlock,
  type UntrustedSource,
} from './untrusted-content.js';

/**
 * Partner posture as a SOFT BIAS (APE §2) — never a hard mode. It seeds a signed
 * `engagementBias ∈ {-1,0,+1}` that *shifts* the thresholds of the adaptive
 * engagement policy: it can never force an action the turn's signals contradict
 * and never crosses the safety floor.
 *
 *   direct        → -1   (lean toward EXECUTE_NOW, prefer stated assumptions)
 *   balanced      →  0   (neutral)
 *   collaborative → +1   (lower the bar for reflect / discuss / a fork question)
 */
export type PartnerStyle = 'direct' | 'balanced' | 'collaborative';

/**
 * Map a `partnerStyle` to its signed engagement bias. Pure, total.
 */
export function engagementBiasOf(style: PartnerStyle): -1 | 0 | 1 {
  switch (style) {
    case 'direct':
      return -1;
    case 'collaborative':
      return 1;
    case 'balanced':
    default:
      return 0;
  }
}

export interface ContextBlockOptions {
  /**
   * Pre-rendered, capped ENVIRONMENT / repo-map orientation block (codebase-
   * awareness §1.2, Phase E1). undefined → omit. Rendered FIRST — orientation
   * precedes everything so the later intent/engagement reasoning already sees
   * "where am I, what is this project". Produced by core/repo-map.ts.
   */
  readonly environmentContext?: string;
  /**
   * Pre-rendered, capped TOOL-STATE / "ABOUT THIS TOOL" block (tool self-awareness).
   * undefined → omit. Orientation about the tool ITSELF (authed subscriptions,
   * mode, what it can do) — rendered adjacent to ENVIRONMENT (right AFTER it) so the
   * model answers setup/mode questions from live truth. Produced by core/tool-state.ts.
   */
  readonly toolStateContext?: string;
  /**
   * Pre-rendered, capped MEMORY block (memory doc §7 `renderMemoryContext`).
   * undefined → omit. Produced by Phase 4; rendered here when present.
   */
  readonly memoryContext?: string;
  /**
   * Pre-rendered, capped LEARNED-TASTE playbook block (judgment doc Part 4, the
   * Phase-7 free layer; core/taste.ts `renderTastePlaybook`). undefined → omit.
   * The user's OBSERVED past decisions, rendered right AFTER MEMORY as a prior (a
   * lean, not a rule — its footer enforces explicit > learned). Produced only when
   * the taste flag is ON (core/taste-flag.ts); absent → byte-identical prompts.
   */
  readonly tasteContext?: string;
  /**
   * Pre-rendered, truthful WORK STATE block (adaptive-partner-v2-5.6.md §2.3 B):
   * objective / evidence-backed done / model-stated next / blocked, derived from
   * accepted prior turns' workTrace by `deriveWorkStateFromHistory`. undefined →
   * omit. This is task/session CONTINUITY, NOT memory (durable preference) — kept
   * distinct and rendered right AFTER MEMORY / BEFORE INTENT so the resumed turn
   * knows what was last done and the next honest step. Produced by core/work-state.ts.
   */
  readonly workStateContext?: string;
  /**
   * Pre-rendered, compact CURRENT GOALS / PLAN block (the partner's OWN plan):
   * the persisted goals (goalStore) with their state, to-dos + per-to-do status,
   * intra-goal dependsOn edges, any honest verdict tag, and the chosen approach.
   * undefined / empty → omit (byte-identical to today). Rendered right AFTER WORK
   * STATE so the resumed turn sees both "what was last done" and "what I'm aiming
   * at" before INTENT/ENGAGEMENT reasoning. This closes the bug where the chat
   * model never saw its goals, so "what's the plan?" answered cluelessly. Produced
   * by core/goal-todo.ts `formatGoalsForContext` from a fail-soft store snapshot.
   */
  readonly goalContext?: string;
  /**
   * Pre-rendered, compact STANDING RULES block (Phase 4): the user-authored rules
   * the partner must remember + enforce (kind NEVER/PAUSE/PREFER · what it applies
   * to · the user's words), rendered by core/rules.ts `formatRulesForContext` from a
   * fail-soft rulesStore snapshot scoped to the current project + globals. This is
   * half the "remember + enforce" mechanism — it makes the CONVERSATIONAL partner
   * aware of policy every turn (the launch GATE enforces it before a goal runs).
   * undefined / empty → omit (byte-identical to today). Rendered right AFTER CURRENT
   * GOALS so the partner sees its plan AND the policy that governs it before
   * INTENT/ENGAGEMENT reasoning.
   */
  readonly rulesContext?: string;
  /**
   * Pre-rendered, capped VISION TRIAGE block (adaptive-partner-v2-5.6.md §2.4 C):
   * the decomposed vision parts with their dispositions (SOLID / DISCUSS /
   * MIGRATE_REARCHITECT / INVESTIGATE_THEN_PROPOSE) and the instruction to address
   * each per its disposition and recommend a SEQUENCE — never a generic menu.
   * undefined → omit. Rendered right BEFORE INTENT so the model triages the request
   * before reflecting a single goal. Produced by core/vision-triage.ts.
   */
  readonly visionTriageContext?: string;
  /**
   * Pre-rendered, capped SYSTEM UNDERSTANDING block (vision-brain §2 / Phase 3a):
   * the deep whole-picture {@link import('./understanding.js').SystemModel} of the
   * real system this work touches (summary / modules / conventions / hard constraints
   * / things-to-confirm / real research citations), rendered by
   * `understanding.ts renderSystemModelContext`. This injects the deep understanding
   * pass output into the WORK prompt (it previously grounded ONLY the goal planner),
   * so a substantial turn builds against the real motherboard, not a parts-list.
   * undefined / empty → omit (byte-for-byte unchanged). Rendered right BEFORE INTENT
   * so the model orients on the real system before reflecting a single goal.
   */
  readonly understandingContext?: string;
  /**
   * Pre-rendered, capped LOCAL INVESTIGATION block (audit rank 9): the bounded
   * read-only retrieval findings produced by the enforced preflight. Rendered as a
   * grounding block right BEFORE INTENT so the model sees the evidence gathered
   * from the repo before it acts. Present only when the required-investigation flag
   * is ON and the retrieval returned non-empty findings; absent → byte-identical.
   */
  readonly investigationContext?: string;
  /**
   * The turn's INTENT block, pre-rendered (intent doc §5.4). undefined → omit.
   * Produced by Phase 6; rendered here when present.
   */
  readonly intentFrame?: string;
  /**
   * The turn's ENGAGEMENT block, pre-rendered (APE §6.4). undefined / fast-path
   * → omit. Produced by APE; rendered here when present.
   */
  readonly engagementPlan?: string;
  /**
   * Soft partner bias → a one-line posture nudge (APE §2; never a hard mode).
   * undefined → omit. The `balanced` (neutral) style emits no nudge.
   */
  readonly partnerStyle?: PartnerStyle;
  /**
   * Partial draft salvaged from a rate-limited interrupted attempt by a prior
   * provider (partial-output salvage, draft-handoff semantics). When present
   * and non-empty, rendered as a clearly-labelled PARTIAL DRAFT block so the
   * next provider can continue/complete it rather than starting from scratch.
   *
   * Absent / empty → block is omitted → byte-identical to the pre-salvage path.
   * The block is placed AFTER workStateContext so orientation context precedes
   * the draft, but BEFORE intentFrame so the model reads its own partial work
   * before reasoning about engagement. Injected by the work-call failover branch
   * (rate-limit only) and cleared immediately after prompt build (one-shot).
   */
  readonly salvagedDraft?: string;
}

/**
 * Hard cap on the total injected context (defends every caller regardless of
 * what it passes). Generous — the producers cap their own blocks first; this is
 * the backstop so a runaway block can never crowd out the task.
 */
const CONTEXT_BLOCK_CHAR_CAP = 6000;

type ContextBlockTier = 'non-sheddable' | 'shed-first' | 'degradable';

type ContextBlockKind =
  | 'environment'
  | 'tool-state'
  | 'memory'
  | 'learned-taste'
  | 'work-state'
  | 'salvaged-draft'
  | 'goals'
  | 'standing-rules'
  | 'vision-triage'
  | 'system-understanding'
  | 'local-investigation'
  | 'intent'
  | 'engagement'
  | 'partner-nudge';

interface ContextBlockRecord {
  readonly kind: ContextBlockKind;
  readonly text: string;
  readonly trust: 'system' | 'user-policy' | 'untrusted-data';
  readonly source?: UntrustedSource;
  readonly tier: ContextBlockTier;
  readonly shedRank?: number;
}

export interface ContextBlockAssemblyResult {
  readonly text: string;
  readonly rawLength: number;
  readonly overflowedNonSheddable: boolean;
}

/**
 * The one-line soft-bias posture nudge derived from `partnerStyle`. Returns ""
 * for the neutral `balanced` style (no nudge needed). The persona text itself
 * lives in the system prompt; this is ONLY the per-turn posture lean.
 */
export function partnerNudge(style: PartnerStyle): string {
  switch (style) {
    case 'direct':
      return 'PARTNER POSTURE: The user leans direct — prefer a reasonable default and proceed; keep any reflection to one short line and only ask at a genuine fork that would materially change the outcome or waste significant work.';
    case 'collaborative':
      return 'PARTNER POSTURE: The user leans collaborative — on substantial work, briefly align on the approach and surface genuine forks before heavy execution, while still avoiding open-ended interviewing.';
    case 'balanced':
    default:
      return '';
  }
}

/**
 * Compose the ordered context blocks that sit BETWEEN the system/persona prompt
 * and the CONVERSATION SO FAR / Task blocks. Returns "" when no blocks apply
 * (byte-for-byte identical to the pre-seam prompt). Caps the total injected
 * length regardless of caller. PURE + table-tested.
 *
 * Canonical block order (master plan §MF1; ENVIRONMENT prepended in E1;
 * TOOL-STATE adjacent to ENVIRONMENT; WORK STATE after MEMORY, AP2-B §2.3 B):
 *   ENVIRONMENT → TOOL-STATE → MEMORY → LEARNED TASTE → WORK STATE → SALVAGED DRAFT → GOALS → STANDING RULES → VISION TRIAGE → SYSTEM UNDERSTANDING → INTENT → ENGAGEMENT → (partner posture nudge)
 *
 * Each block is independently present/absent. The returned string is inserted by
 * every prompt builder at the same point: AFTER system, BEFORE "CONVERSATION SO
 * FAR".
 */
export function assembleContextBlocks(opts: ContextBlockOptions): string {
  return assembleContextBlocksDetailed(opts).text;
}

export function assembleContextBlocksDetailed(
  opts: ContextBlockOptions,
): ContextBlockAssemblyResult {
  const blocks: ContextBlockRecord[] = [];

  const pushBlock = (
    kind: ContextBlockKind,
    text: string,
    tier: ContextBlockTier,
    trust: ContextBlockRecord['trust'],
    source?: UntrustedSource,
    shedRank?: number,
  ): void => {
    const rendered =
      trust === 'untrusted-data'
        ? renderUntrustedBlock({
            source: source ?? 'model-output',
            label: kind,
            content: text,
          })
        : trust === 'user-policy'
          ? `${text}\n\nPOLICY LIMIT: User policy cannot override system safety, verification truth, or command-tier recomputation.`
          : text;
    blocks.push(
      shedRank === undefined
        ? { kind, text: rendered, trust, ...(source !== undefined ? { source } : {}), tier }
        : { kind, text: rendered, trust, ...(source !== undefined ? { source } : {}), tier, shedRank },
    );
  };

  // ENVIRONMENT goes FIRST — orientation precedes memory/intent/engagement so the
  // later reasoning already knows where it is and what the project is (E1 §1.2; now with seam+symbols in render).
  const environment = opts.environmentContext?.trim();
  if (environment !== undefined && environment.length > 0) {
    pushBlock('environment', environment, 'shed-first', 'untrusted-data', 'repo-file', 1);
  }

  // TOOL-STATE / ABOUT THIS TOOL — orientation about the tool ITSELF, adjacent to
  // ENVIRONMENT (right after it): the live, authoritative answer to "what's my
  // setup / mode / what can you do" so the model never has to guess or read files.
  const toolState = opts.toolStateContext?.trim();
  if (toolState !== undefined && toolState.length > 0) {
    pushBlock('tool-state', toolState, 'shed-first', 'system', undefined, 2);
  }

  const memory = opts.memoryContext?.trim();
  if (memory !== undefined && memory.length > 0) {
    pushBlock('memory', memory, 'degradable', 'untrusted-data', 'model-output', 5);
  }

  // LEARNED TASTE — the user's OBSERVED past decisions, rendered right AFTER
  // MEMORY as a prior (a lean, not a rule). Its own footer enforces explicit >
  // learned, so a fresh instruction this turn always overrides it. Present only
  // when the taste flag is ON (the producer returns '' otherwise).
  const taste = opts.tasteContext?.trim();
  if (taste !== undefined && taste.length > 0) {
    pushBlock('learned-taste', taste, 'shed-first', 'untrusted-data', 'model-output', 3);
  }

  // WORK STATE — task/session continuity (what's done / what's next), distinct from
  // MEMORY and rendered right after it so the resumed turn orients on prior progress
  // before intent/engagement reasoning (AP2-B §2.3 B). Truthful or absent.
  const workState = opts.workStateContext?.trim();
  if (workState !== undefined && workState.length > 0) {
    pushBlock('work-state', workState, 'non-sheddable', 'untrusted-data', 'model-output');
  }

  // SALVAGED DRAFT — partial prose from a rate-limited interrupted prior provider
  // (draft-handoff semantics). Rendered right AFTER WORK STATE so the model sees
  // "what was done so far this turn" before reasoning about the task. Absent →
  // omitted → byte-identical to the pre-salvage path. One-shot: the work-call
  // loop clears salvagedDraft immediately after building the prompt.
  const salvagedDraft = opts.salvagedDraft?.trim();
  if (salvagedDraft !== undefined && salvagedDraft.length > 0) {
    pushBlock(
      'salvaged-draft',
      `PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT (a different model began this answer before being interrupted). Continue and COMPLETE it in your own voice; do NOT repeat what is already written, and do not mention the interruption:\n${salvagedDraft}`,
      'non-sheddable',
      'untrusted-data',
      'salvaged-draft',
    );
  }

  // CURRENT GOALS / PLAN — the partner's OWN plan (persisted goalStore snapshot),
  // rendered right AFTER WORK STATE so the resumed turn knows what it is aiming at
  // (goals/to-dos/dependencies/verdicts/approach) and can answer "what's the plan?"
  // from real state rather than guessing. Absent/empty → nothing emitted.
  const goalCtx = opts.goalContext?.trim();
  if (goalCtx !== undefined && goalCtx.length > 0) {
    pushBlock('goals', goalCtx, 'non-sheddable', 'untrusted-data', 'model-output');
  }

  // STANDING RULES — the user-authored policy the partner must honour (NEVER /
  // PAUSE / PREFER), rendered right AFTER CURRENT GOALS so the partner sees both
  // its plan and the policy governing it before intent/engagement reasoning. The
  // launch GATE (oversight.ts) enforces these before a goal runs; this block makes
  // the conversational partner aware of them every turn. Absent/empty → byte-identical.
  const rulesCtx = opts.rulesContext?.trim();
  if (rulesCtx !== undefined && rulesCtx.length > 0) {
    pushBlock('standing-rules', rulesCtx, 'non-sheddable', 'user-policy');
  }

  // VISION TRIAGE — decompose a broad multi-part vision into per-disposition parts
  // (AP2-C §2.4 C), rendered right BEFORE INTENT so the model separates the work
  // (solid / discuss / migrate / investigate) and recommends a SEQUENCE before
  // reflecting a single goal line. Absent on a plain single-claim turn.
  const visionTriage = opts.visionTriageContext?.trim();
  if (visionTriage !== undefined && visionTriage.length > 0) {
    pushBlock('vision-triage', visionTriage, 'degradable', 'untrusted-data', 'model-output', 3);
  }

  // SYSTEM UNDERSTANDING — the deep whole-picture model of the real system (Phase
  // 3a), rendered right BEFORE INTENT so the model builds against the real
  // motherboard. Absent (understanding pass off / produced nothing) → byte-identical.
  const understanding = opts.understandingContext?.trim();
  if (understanding !== undefined && understanding.length > 0) {
    pushBlock('system-understanding', understanding, 'degradable', 'untrusted-data', 'model-output', 4);
  }

  // LOCAL INVESTIGATION — the bounded read-only retrieval findings from the rank-9
  // enforced preflight, rendered right BEFORE INTENT as a grounding block.
  // Absent (flag off / already-grounded / empty findings) → byte-identical.
  const investigation = opts.investigationContext?.trim();
  if (investigation !== undefined && investigation.length > 0) {
    pushBlock('local-investigation', investigation, 'degradable', 'untrusted-data', 'repo-file', 5);
  }

  const intent = opts.intentFrame?.trim();
  if (intent !== undefined && intent.length > 0) {
    pushBlock('intent', intent, 'non-sheddable', 'untrusted-data', 'model-output');
  }

  const engagement = opts.engagementPlan?.trim();
  if (engagement !== undefined && engagement.length > 0) {
    pushBlock('engagement', engagement, 'degradable', 'untrusted-data', 'model-output', 2);
  }

  if (opts.partnerStyle !== undefined) {
    const nudge = partnerNudge(opts.partnerStyle);
    if (nudge.length > 0) pushBlock('partner-nudge', nudge, 'degradable', 'system', undefined, 1);
  }

  if (blocks.length === 0) {
    return {
      text: '',
      rawLength: 0,
      overflowedNonSheddable: false,
    };
  }

  const assembled = blocks.map((block) => block.text).join('\n\n');
  if (assembled.length <= CONTEXT_BLOCK_CHAR_CAP) {
    return {
      text: assembled,
      rawLength: assembled.length,
      overflowedNonSheddable: false,
    };
  }

  const joinedNonSheddables = blocks
    .filter((block) => block.tier === 'non-sheddable')
    .map((block) => block.text)
    .join('\n\n');
  if (joinedNonSheddables.length > CONTEXT_BLOCK_CHAR_CAP) {
    return {
      text: joinedNonSheddables,
      rawLength: assembled.length,
      overflowedNonSheddable: true,
    };
  }

  const removableBlocks = blocks.filter((block) => block.shedRank !== undefined);
  const removedKinds = new Set<ContextBlockKind>();

  for (const tier of ['shed-first', 'degradable'] as const) {
    const tierBlocks = removableBlocks
      .filter((block) => block.tier === tier)
      .sort(
        (left, right) =>
          (left.shedRank ?? Number.POSITIVE_INFINITY) -
          (right.shedRank ?? Number.POSITIVE_INFINITY),
      );
    for (const block of tierBlocks) {
      removedKinds.add(block.kind);
      const compacted = blocks
        .filter((candidate) => !removedKinds.has(candidate.kind))
        .map((candidate) => candidate.text)
        .join('\n\n');
      if (compacted.length <= CONTEXT_BLOCK_CHAR_CAP) {
        return {
          text: compacted,
          rawLength: assembled.length,
          overflowedNonSheddable: false,
        };
      }
    }
  }

  return {
    text: joinedNonSheddables,
    rawLength: assembled.length,
    overflowedNonSheddable: false,
  };
}
