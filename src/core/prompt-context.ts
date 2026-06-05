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
   * Pre-rendered, capped MEMORY block (memory doc §7 `renderMemoryContext`).
   * undefined → omit. Produced by Phase 4; rendered here when present.
   */
  readonly memoryContext?: string;
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
}

/**
 * Hard cap on the total injected context (defends every caller regardless of
 * what it passes). Generous — the producers cap their own blocks first; this is
 * the backstop so a runaway block can never crowd out the task.
 */
const CONTEXT_BLOCK_CHAR_CAP = 6000;

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
 * Canonical block order (master plan §MF1):
 *   MEMORY → INTENT → ENGAGEMENT → (partner posture nudge)
 *
 * Each block is independently present/absent. The returned string is inserted by
 * every prompt builder at the same point: AFTER system, BEFORE "CONVERSATION SO
 * FAR".
 */
export function assembleContextBlocks(opts: ContextBlockOptions): string {
  const blocks: string[] = [];

  const memory = opts.memoryContext?.trim();
  if (memory !== undefined && memory.length > 0) {
    blocks.push(memory);
  }

  const intent = opts.intentFrame?.trim();
  if (intent !== undefined && intent.length > 0) {
    blocks.push(intent);
  }

  const engagement = opts.engagementPlan?.trim();
  if (engagement !== undefined && engagement.length > 0) {
    blocks.push(engagement);
  }

  if (opts.partnerStyle !== undefined) {
    const nudge = partnerNudge(opts.partnerStyle);
    if (nudge.length > 0) blocks.push(nudge);
  }

  if (blocks.length === 0) return '';

  const assembled = blocks.join('\n\n');
  return assembled.length > CONTEXT_BLOCK_CHAR_CAP
    ? assembled.slice(0, CONTEXT_BLOCK_CHAR_CAP)
    : assembled;
}
