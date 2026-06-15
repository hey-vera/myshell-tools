/**
 * src/core/ensemble.ts — the Parallel Subscription Panel (EXPERIMENTAL, opt-in).
 *
 * The sequential engine (orchestrate.ts) runs one model per step and escalates.
 * The Panel takes a different shape: it runs a turn as a CONCURRENT panel of the
 * user's signed-in providers — each answers the task INDEPENDENTLY — then a
 * cross-vendor synthesizer reads all candidate answers and adjudicates them into
 * a single final answer for the user.
 *
 * Why this is uniquely a subscription-first move: on a flat-rate plan, extra
 * model runs cost $0 in dollars. The only budget is rate-limit/quota headroom +
 * latency. Spending several CONCURRENT runs on a hard turn buys genuinely
 * independent judgment (different vendors, different training, different failure
 * modes) that an API-key-billed tool would never afford. The synthesizer then
 * cross-checks claims across vendors, which catches single-model confident-but-
 * wrong answers the sequential path would ship.
 *
 * Scope / safety:
 *  - Default OFF (panelPolicy absent → 'off'); zero behaviour change unless the
 *    user opts in. A panel only forms with ≥2 authenticated providers; otherwise
 *    the normal single-model path runs.
 *  - planPanel / buildPanelCandidatePrompt / buildPanelSynthesisPrompt are PURE.
 *  - runPanel does I/O ONLY through the injected OrchestrateDeps ports/providers,
 *    exactly like orchestrate() — that is not a purity violation.
 *
 * Purity rules (enforced by test/arch/guards.test.ts), same as the sibling core
 * modules: no fs/path/child_process/os/crypto, no Date.now()/Math.random()/new
 * Date(), and no imports from src/providers/* except the type-only ProviderId.
 * All time/ids come from deps.clock.
 */

import type {
  CoreEvent,
  OrchestrateDeps,
  Tier,
  Classification,
  Policy,
  Assessment,
} from './types.js';
import type { ProviderId } from '../providers/port.js';
import { route, type CapabilityRouteContext, type CapabilityTaskSignals } from './route.js';
import { effortForDecision } from './orchestrate-signals.js';
import type { Attachment } from './attachments.js';
import { getModelPricing, calculateCost } from '../infra/pricing.js';
import { assess } from './assess.js';
import { authorizeTier } from './flagship.js';
import { type ReasoningEffort, type TaskKind } from './model-capabilities.js';
import { modeFromPolicy } from './policy.js';
import type { WorkContract } from './work-contract.js';
import { capContract, renderContractForPrompt, shouldMaterializeContract, isCleanObjectiveTask } from './work-contract.js';
import { assembleContextBlocks, type ContextBlockOptions } from './prompt-context.js';
import { buildSharedContextBlockOptions } from './context-block-options.js';
import {
  runCandidateQualityGate,
  buildVerifyReceiptEvents,
  type AcceptedRunSessionData,
  type CandidateResult,
} from './accept-stage.js';
import { verifyStage, type CriticRunInput, type CriticRunOutput } from './work-call.js';
import { parseReviewVerdict } from './review.js';
import { buildPrompt } from './prompt.js';
import type { IntentFrame } from './intent.js';
import type { AllocationPlan } from './governor.js';
import { parseFinalLineChoiceEnvelope, tallyChoiceEnvelopes } from './judgment-shared.js';
import {
  buildGoalPlanPrompt,
  parseGoalPlan,
  type GoalPlan,
} from './goal-plan.js';
import type { SystemModel } from './understanding.js';

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * A resolved plan for one panel turn: which providers answer independently
 * (`candidates`) and which provider adjudicates their answers (`synthesizer`).
 */
export interface PanelPlan {
  /** The tier every panel run executes at (candidates + synthesizer). */
  readonly tier: Tier;
  /** The providers that answer the task independently (≥2, distinct). */
  readonly candidates: readonly ProviderId[];
  /** The provider that reconciles the candidate answers into the final one. */
  readonly synthesizer: ProviderId;
  /**
   * The task classification (risk/tier) for this turn. Threaded in so runPanel
   * can gate the SYNTHESIZER through adaptive flagship admission — the
   * synthesizer is the final decision-maker on the user's hardest turns, so it
   * earns the manager tier exactly like orchestrate's cross-vendor reviewer.
   * Candidates stay at `tier` (diversity is their job).
   */
  readonly classification: Classification;
}

/**
 * Decide whether (and how) a panel should form for this turn. PURE.
 *
 * Returns null (→ the normal sequential path runs) when:
 *  - panelPolicy is 'off' or undefined; or
 *  - panelPolicy is 'hard-turns' and the turn is NOT high/critical risk; or
 *  - fewer than 2 authenticated providers are available (a panel needs ≥2
 *    distinct providers to be a real panel — a single-provider "panel" is just
 *    the normal path, so we defer to it).
 *
 * When a panel forms, candidates are the first `cap` authenticated providers
 * (cap = max(2, maxPanelProviders)) and the synthesizer is candidates[0]
 * (deterministic — it adjudicates ALL candidate outputs, including its own).
 *
 * @param opts.panelPolicy            - Policy posture ('off' | 'hard-turns' | 'always').
 * @param opts.classification         - Task classification (risk gates 'hard-turns').
 * @param opts.tier                   - The resolved tier every panel run uses.
 * @param opts.authenticatedProviders - Signed-in provider ids (panel candidates pool).
 * @param opts.maxPanelProviders      - Max concurrent candidates (quota guard; floor 2).
 * @param opts.qualificationOverride  - Bypass only the hard-turn risk qualification.
 */
export function planPanel(opts: {
  readonly panelPolicy: Policy['panelPolicy'];
  readonly classification: Classification;
  readonly tier: Tier;
  readonly authenticatedProviders: readonly ProviderId[];
  readonly maxPanelProviders: number;
  readonly qualificationOverride?: boolean;
}): PanelPlan | null {
  const {
    panelPolicy,
    classification,
    tier,
    authenticatedProviders,
    maxPanelProviders,
    qualificationOverride = false,
  } = opts;

  // 'off' / undefined → never form a panel (the sequential engine runs).
  if (panelPolicy === undefined || panelPolicy === 'off') return null;

  // 'always' qualifies every turn; 'hard-turns' only on high/critical risk.
  const qualifies =
    panelPolicy === 'always' ||
    qualificationOverride ||
    (panelPolicy === 'hard-turns' &&
      (classification.risk === 'high' || classification.risk === 'critical'));
  if (!qualifies) return null;

  // Cap concurrent candidates — never below 2 (a panel needs ≥2 to be a panel).
  const cap = Math.max(2, maxPanelProviders);
  const candidates = authenticatedProviders.slice(0, cap);

  // <2 distinct providers → no real panel; defer to the single-model path.
  if (candidates.length < 2) return null;

  // Deterministic synthesizer: the first candidate adjudicates all outputs.
  const synthesizer = candidates[0] as ProviderId;

  return { tier, candidates, synthesizer, classification };
}

// ---------------------------------------------------------------------------
// Prompt builders (PURE)
// ---------------------------------------------------------------------------

/**
 * Build the prompt for ONE independent panel candidate.
 *
 * Each candidate is told it is one member of a panel solving the task in
 * parallel — it must answer on its own (no coordination), then end with a short
 * JSON self-report envelope on its own final line so the synthesizer can weigh
 * the answers. We deliberately reuse the same history-injection shape as
 * buildPrompt (prompt.ts) so stateless one-shot providers still get multi-turn
 * context.
 *
 * The envelope keys are intentionally panel-specific (`confidence`,
 * `assumptions`, `what_would_make_this_wrong`) — NOT the orchestrate confidence
 * envelope — because here they feed the synthesizer's cross-check, not assess().
 *
 * @param tier           - The tier this candidate runs at (sets the voice/depth).
 * @param task           - The raw user task.
 * @param historyContext - Optional compacted prior-conversation summary.
 */
/**
 * Derive the per-turn `ContextBlockOptions` from the shared `OrchestrateDeps`,
 * exactly as the sequential/hedge executors do — so the panel candidate and
 * synthesizer prompts carry the SAME memory/intent/engagement/partner context.
 * Returns `undefined` when no context applies (the prompt is then byte-for-byte
 * identical to the pre-seam panel prompt). PURE.
 */
export function contextFromDeps(deps: OrchestrateDeps): ContextBlockOptions | undefined {
  return buildSharedContextBlockOptions(deps, { includeUnderstanding: false });
}

/**
 * Select the reasoning effort for a panel run against the chosen model's registry
 * facts (capability registry §3/§5). Returns undefined when the registry is
 * absent, the model has no record, or it declares no efforts (→ no flag,
 * byte-for-byte unchanged). The resolved tier is the tier route() granted (the
 * synthesizer's manager admission already passed upstream), so this never opens
 * manager or exceeds policy. PURE.
 *
 * @param taskKind - the role's task kind: a candidate uses the REAL turn taskKind
 *                   (P0.3 — threaded via `capabilityContext.taskSignals`, no longer
 *                   hard-coded), 'review' for the cross-vendor synthesizer, and
 *                   'judgment' for the judgment poll (the caller passes the role).
 * @param capabilityContext - the SAME opt-in capability-fit context the route()
 *                   calls use; its `taskSignals.difficulty` (engagement depth,
 *                   intent confidence, plan-first, fork count) sizes effort per task
 *                   exactly like the sequential path. Absent → no difficulty bump.
 */
function panelEffort(
  deps: OrchestrateDeps,
  plan: PanelPlan,
  provider: ProviderId,
  model: string,
  tier: Tier,
  taskKind: TaskKind,
  capabilityContext: CapabilityRouteContext | undefined,
): ReasoningEffort | undefined {
  // The role's taskKind wins (a synthesizer is 'review' even on an implementation
  // turn), but the difficulty signals come from the turn's real taskSignals.
  const signals: CapabilityTaskSignals = {
    risk: plan.classification.risk,
    routePlan: false,
    taskKind,
    ...(capabilityContext?.taskSignals?.difficulty !== undefined
      ? { difficulty: capabilityContext.taskSignals.difficulty }
      : {}),
  };
  return effortForDecision(
    deps.capabilityRegistry,
    provider,
    model,
    tier,
    modeFromPolicy(deps.policy),
    signals,
  );
}

/**
 * True ONLY when the turn genuinely carries image input — the SAME predicate the
 * sequential path uses (orchestrate's `hasImageAttachment`) to decide whether to
 * attach the request's image paths. No image attachment → false → the field is
 * omitted entirely (byte-for-byte unchanged). PURE.
 */
function panelHasImageAttachment(
  attachments: readonly Attachment[] | undefined,
): attachments is readonly Attachment[] {
  return attachments !== undefined && attachments.some((a) => a.kind === 'image');
}

export function buildPanelCandidatePrompt(
  tier: Tier,
  task: string,
  historyContext?: string,
  context?: ContextBlockOptions,
): string {
  let prompt = `\
You are ONE independent member of an expert panel answering the following task in
parallel with other engineers. You are at the ${tier} tier. Do NOT coordinate with
or defer to anyone — produce YOUR best independent answer to the task on its own
merits. Another senior engineer will later read every panelist's answer and
synthesize them, so your job is to be a strong, honest, independent data point.

Solve the task fully and concretely. Then, on the FINAL line of your response,
emit EXACTLY this JSON object on its own line and nothing after it (raw JSON, no
code fences):
{"confidence": <0.0-1.0>, "assumptions": "<key assumptions you made>", "what_would_make_this_wrong": "<the most likely way your answer is wrong>"}

Be honest in the envelope: confidence is your real self-assessed probability of
correctness, and "what_would_make_this_wrong" should name a genuine failure mode,
not a throwaway.`;

  // MF1: the panel candidate is no longer context-blind — compose the same
  // ordered context blocks every other executor gets, after the panel-member
  // preamble and before CONVERSATION SO FAR.
  if (context !== undefined) {
    const contextBlocks = assembleContextBlocks(context);
    if (contextBlocks.length > 0) {
      prompt += `\n\n${contextBlocks}`;
    }
  }

  if (historyContext !== undefined && historyContext.trim().length > 0) {
    prompt += `\n\nCONVERSATION SO FAR (for context; do not repeat it back):\n${historyContext.trim()}`;
  }

  prompt += `\n\n---\n\nTask:\n${task}`;
  return prompt;
}

function buildGovernedPanelCandidatePrompt(
  tier: Tier,
  task: string,
  conclusionOptionIds: readonly string[],
  historyContext?: string,
  context?: ContextBlockOptions,
): string {
  const base = buildPanelCandidatePrompt(tier, task, historyContext, context);
  const choiceHint =
    conclusionOptionIds.length === 1 && conclusionOptionIds[0] === 'OPEN'
      ? 'OPEN'
      : conclusionOptionIds.join(' | ');
  return `${base}

Also append ONE additional structured conclusion envelope on the FINAL line of
your response, replacing the usual panel envelope. It MUST be raw JSON on its
own line:
{"choice":"${choiceHint}","confidence":0.0,"assumptions":"...","what_would_make_this_wrong":"..."}`;
}

/**
 * Build the prompt for the cross-vendor synthesizer. PURE.
 *
 * The synthesizer reads the N independent candidate answers, reconciles and
 * cross-checks them, prefers the best-supported claims, flags any material
 * disagreement, and produces ONE final answer for the user. There is NO JSON
 * verdict to parse — the synthesizer's prose IS the answer the user sees.
 *
 * @param task       - The raw user task.
 * @param candidates - The successful candidate outputs, labelled by provider.
 */
export function buildPanelSynthesisPrompt(
  task: string,
  candidates: ReadonlyArray<{ provider: ProviderId; output: string }>,
  contract?: WorkContract,
  context?: ContextBlockOptions,
  opts?: { compactCandidates?: boolean },
): string {
  const blocks =
    opts?.compactCandidates === true
      ? candidates
          .map((c, i) => formatCompactSynthesisCandidate(c, i))
          .join('\n\n')
      : candidates
          .map(
            (c, i) =>
              `--- PANELIST ${i + 1} (${c.provider}) ---\n${c.output.trim()}`,
          )
          .join('\n\n');
  const contractSection =
    contract !== undefined
      ? `\n\nCONTRACT TO ADJUDICATE AGAINST:\n${renderContractForPrompt(contract)}\n\nUse this contract as the criteria when reconciling the panel answers. Prefer candidates that serve the objective and vision directly, and call out material drift from that objective.`
      : '';

  // MF1: the synthesizer is no longer context-blind either — the same ordered
  // context blocks ride here too, after the synthesizer preamble and before the
  // panelist answers.
  const contextBlocks =
    context !== undefined ? assembleContextBlocks(context) : '';
  const contextSection =
    contextBlocks.length > 0 ? `\n\n${contextBlocks}` : '';

  return `\
You are a senior synthesizer adjudicating an expert panel. ${candidates.length}
engineers each answered the SAME task independently (their answers are below).
Your job is to produce the single best final answer for the user.

How to synthesize:
- Read every panelist's answer carefully and cross-check their claims against one
  another. Where they agree on something substantive, that agreement is evidence
  it is right.
- Where they DISAGREE on something material, do not paper over it: decide which
  position is better supported (and briefly say why), or surface the disagreement
  honestly if it genuinely cannot be resolved from what's here.
- Prefer the best-supported, most concrete claims; discard anything a panelist
  asserted without support that another panelist contradicts.
- Do NOT just stitch the answers together or pick one wholesale — integrate them
  into one coherent, correct answer in your own voice.
- Write the final answer directly to the user. Do not mention "panelists" or this
  instruction unless a real disagreement is worth flagging.
${contextSection}${contractSection}
Original task:
${task}

Independent panel answers:
${blocks}

Now write the single final answer for the user.`;
}

function splitFinalLineJson(text: string): { body: string; finalLine: string | undefined } {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) continue;
    if (line.startsWith('{') && line.endsWith('}')) {
      return {
        body: lines.slice(0, i).join('\n').trim(),
        finalLine: line,
      };
    }
    break;
  }
  return { body: text.trim(), finalLine: undefined };
}

function compactCandidateBodyExcerpt(body: string): string {
  if (body.length <= 2000) return body;
  return `${body.slice(0, 1600)}\n…[candidate body compacted]…\n${body.slice(-400)}`;
}

function formatCompactSynthesisCandidate(
  candidate: { provider: ProviderId; output: string },
  index: number,
): string {
  const parts = splitFinalLineJson(candidate.output.trim());
  return `--- PANELIST ${index + 1} (${candidate.provider}) ---
CONCLUSION: ${parts.finalLine ?? '(no parseable conclusion envelope)'}
ANSWER EXCERPT:
${compactCandidateBodyExcerpt(parts.body)}`;
}

export function buildPanelCritiqueSynthesisPrompt(
  task: string,
  candidates: ReadonlyArray<{ provider: ProviderId; output: string }>,
  contract?: WorkContract,
  context?: ContextBlockOptions,
): string {
  const contractSection =
    contract !== undefined
      ? `\n\nCONTRACT TO ADJUDICATE AGAINST:\n${renderContractForPrompt(contract)}\n\nUse this contract as the criteria when reconciling the panel answers. Prefer candidates that serve the objective and vision directly, and call out material drift from that objective.`
      : '';
  const contextBlocks =
    context !== undefined ? assembleContextBlocks(context) : '';
  const contextSection =
    contextBlocks.length > 0 ? `\n\n${contextBlocks}` : '';
  const blocks = candidates
    .map((c, i) => {
      const parts = splitFinalLineJson(c.output.trim());
      return `--- CANDIDATE ${i + 1} (${c.provider}) ---
Conclusion:
${parts.finalLine ?? '(no parseable conclusion envelope)'}

Answer:
${parts.body.length > 0 ? parts.body : c.output.trim()}`;
    })
    .join('\n\n');
  return `\
You are the final adjudicator for an expert panel. Two candidates answered the
same task independently and reached materially different structured conclusions.
Your job is to critique the disagreement, reconsider the evidence, and produce
one final answer for the user.
${contextSection}${contractSection}
Original task:
${task}

Candidate records:
${blocks}

Instructions:
- Read both candidates carefully.
- Explicitly critique each candidate's conclusion against the other's evidence.
- Reconsider each candidate's original conclusion and state any revision that
  critique causes.
- Then write ONE final synthesized answer for the user in your own voice.
- End with the normal confidence envelope on its own final line and nothing
  after it:
{"confidence": 0.0, "escalate": false, "reason": "...", "needs_review": false}`;
}

export type PanelAgreement = 'consensus' | 'material-disagreement' | 'unknown';

export interface PanelDebateReceipt {
  readonly status: 'ran' | 'not-run';
  readonly reason:
    | 'material-disagreement'
    | 'consensus'
    | 'unknown'
    | 'low-synthesis-confidence-budget-exhausted'
    | 'budget';
  readonly participants: readonly ProviderId[];
  readonly calls: 0 | 1;
}

interface GovernedPanelDebateConfig {
  readonly conclusionOptionIds: readonly string[];
  readonly countingOptionIds: readonly string[];
}

function panelDebateConfig(
  governorPlan: Pick<AllocationPlan, 'panelAllowed' | 'shape' | 'turnCallBudget'> | undefined,
  intentFrame: IntentFrame | undefined,
  plan: PanelPlan,
): GovernedPanelDebateConfig | undefined {
  if (
    governorPlan?.panelAllowed !== true ||
    governorPlan.turnCallBudget !== 3 ||
    plan.candidates.length !== 2
  ) return undefined;
  const decideOptionIds = (() => {
    const forks = intentFrame?.forks ?? [];
    for (const fork of forks) {
      const forkId = fork.id.trim();
      const options = (fork.options ?? []).filter((option) => option.trim().length > 0);
      if (forkId.length > 0 && fork.question.trim().length > 0 && options.length >= 2) {
        return options.map((_, i) => `${forkId}:${i}`);
      }
    }
    return [];
  })();
  if (governorPlan.shape === 'decide' && decideOptionIds.length >= 2) {
    return { conclusionOptionIds: decideOptionIds, countingOptionIds: decideOptionIds };
  }
  if (governorPlan.shape === 'decide') {
    return { conclusionOptionIds: [], countingOptionIds: [] };
  }
  if (governorPlan.shape === 'risky' || governorPlan.shape === 'investigate') {
    return { conclusionOptionIds: ['OPEN'], countingOptionIds: [] };
  }
  return undefined;
}

export function classifyPanelAgreement(
  candidates: ReadonlyArray<{ provider: ProviderId; output: string | undefined }>,
  vocabulary: readonly string[],
  countingVocabulary: readonly string[] = vocabulary,
): PanelAgreement {
  if (vocabulary.length === 0 || countingVocabulary.length === 0) return 'unknown';
  const counting = new Set(countingVocabulary);
  const parsed = candidates
    .map((candidate) => parseFinalLineChoiceEnvelope(candidate.provider, candidate.output, vocabulary))
    .filter(
      (parsed): parsed is NonNullable<typeof parsed> =>
        parsed !== null && counting.has(parsed.choice),
    );
  const tally = tallyChoiceEnvelopes(parsed);
  if (tally.total < 2 || tally.top === undefined) return 'unknown';
  if (tally.distinctOptions === 1) return 'consensus';
  if (tally.total === 2 && tally.distinctOptions === 2) return 'material-disagreement';
  return 'unknown';
}

export function isLowSynthesisConfidence(
  assessment: Assessment,
  policy: Policy,
  classification: Classification,
): boolean {
  const threshold = policy.escalateBelowConfidence[classification.risk];
  return (
    assessment.escalate === true ||
    assessment.needsReview === true ||
    (assessment.confidence !== null && assessment.confidence < threshold)
  );
}

export function formatPanelDebateNotice(receipt: PanelDebateReceipt): string {
  if (receipt.status === 'ran' && receipt.reason === 'material-disagreement') {
    return 'Panel debate: ran (material disagreement)';
  }
  if (receipt.reason === 'consensus') {
    return 'Panel debate: not run (consensus)';
  }
  if (receipt.reason === 'unknown') {
    return 'Panel debate: not run (no parseable decision split)';
  }
  if (receipt.reason === 'low-synthesis-confidence-budget-exhausted') {
    return 'Panel debate: trigger observed (low synthesis confidence), not run (budget exhausted)';
  }
  return 'Panel debate: not run (budget exhausted)';
}

// ---------------------------------------------------------------------------
// Goal-plan selection adapter (Phase C3; additive and not wired by runPanel)
// ---------------------------------------------------------------------------

export interface GoalPlanSelectionCandidate {
  readonly plan: GoalPlan;
  readonly provider: ProviderId;
  readonly model?: string;
  readonly rawText: string;
}

interface GoalPlanSelectionParticipant {
  readonly choice: 'P1' | 'P2';
  readonly provider: ProviderId;
  readonly model?: string;
}

export interface GoalPlanSelectionReceipt {
  readonly status: 'ran' | 'not-run';
  readonly reason:
    | 'selected'
    | 'no-different-provider'
    | 'candidate-failed'
    | 'candidate-invalid'
    | 'adjudicator-failed'
    | 'invalid-adjudication';
  readonly candidates: readonly GoalPlanSelectionParticipant[];
  readonly adjudicator?: GoalPlanSelectionParticipant;
  readonly selectedProvider: ProviderId;
  readonly selectedChoice: 'P1' | 'P2';
  readonly totalCalls: 1 | 2 | 3;
  readonly selection: 'synthesis' | 'fallback';
  readonly failedCandidate?: ProviderId;
}

export interface GoalPlanSelectionResult {
  readonly plan: GoalPlan;
  readonly receipt: GoalPlanSelectionReceipt;
}

interface GoalPlanSelectionRunRequest {
  readonly role: 'candidate' | 'adjudicator';
  readonly provider: ProviderId;
  readonly prompt: string;
}

export type GoalPlanSelectionRunner = (
  request: GoalPlanSelectionRunRequest,
) => Promise<CandidateOutcome>;

export interface GoalPlanSelectionInput {
  readonly ownerTask: string;
  readonly candidateA: GoalPlanSelectionCandidate;
  readonly deps: OrchestrateDeps;
  readonly tier: Tier;
  readonly classification: Classification;
  readonly signal: AbortSignal;
  readonly systemModel?: SystemModel;
  readonly candidateProviders?: readonly ProviderId[];
  readonly runner?: GoalPlanSelectionRunner;
}

export function buildGoalPlanAdjudicationPrompt(input: {
  readonly ownerTask: string;
  readonly plannerPrompt: string;
  readonly candidateA: GoalPlanSelectionCandidate;
  readonly candidateB: GoalPlanSelectionCandidate;
}): string {
  const { ownerTask, plannerPrompt, candidateA, candidateB } = input;
  return `\
You are one adjudicator selecting the strongest plan for the same owner task.
Compare P1 and P2 against the original task and the exact grounded planning brief.

OWNER TASK:
${ownerTask.trim()}

GROUNDED PLANNING BRIEF USED FOR BOTH CANDIDATES:
${plannerPrompt.trim()}

P1 (${candidateA.provider}${candidateA.model === undefined ? '' : ` / ${candidateA.model}`}):
${candidateA.rawText.trim()}

P2 (${candidateB.provider}${candidateB.model === undefined ? '' : ` / ${candidateB.model}`}):
${candidateB.rawText.trim()}

Compare correctness, grounding, scope completeness, concrete TODOs, complete
APPROACH+WHY records, verifiable DONE criteria, and honest cap-drop disclosure.
Resolve material differences and emit one best plan using ONLY this grammar:
JUDGMENT: stage
VISION: <optional concise framing>
GOAL: <title>
APPROACH: <chosen strategy>
WHY: <why it is best>
ALT: <optional comma-separated alternatives>
TODO: <concrete step>
DONE: <verifiable completion criterion>

Use 1-4 goals and 1-8 TODO lines per goal. Do not emit JUDGMENT: clarify or
JUDGMENT: none. After the tagged plan, end with exactly one JSON choice envelope
on its own final line and nothing after it:
{"choice":"P1","confidence":0.0,"why":"...","key_risk":"..."}
The choice must be P1 or P2 and must name the candidate the synthesized plan is
based on, even when you improve it.`;
}

function droppedCount(plan: GoalPlan): number {
  if (plan.dropped === undefined) return 0;
  let total = plan.dropped.goals;
  for (const count of plan.dropped.perGoalTodos.values()) total += count;
  return total;
}

/** Accept only structurally usable synthesis that preserves chosen-plan evidence. */
export function isAcceptableGoalPlanSynthesis(
  synthesized: GoalPlan | null,
  chosen: GoalPlan,
): synthesized is GoalPlan {
  if (synthesized === null || synthesized.judgment !== 'stage') return false;
  if (synthesized.goals.length === 0) return false;
  if (synthesized.goals.some((goal) => goal.title.trim().length === 0 || goal.todos.length === 0)) {
    return false;
  }
  const missingDoneWhen = (plan: GoalPlan): number =>
    plan.goals.filter((goal) => goal.doneWhen === undefined || goal.doneWhen.trim().length === 0).length;
  const missingApproach = (plan: GoalPlan): number =>
    plan.goals.filter(
      (goal) =>
        goal.approach === undefined ||
        goal.approach.chosen.trim().length === 0 ||
        goal.approach.rationale.trim().length === 0,
    ).length;
  return (
    missingDoneWhen(synthesized) <= missingDoneWhen(chosen) &&
    missingApproach(synthesized) <= missingApproach(chosen) &&
    droppedCount(synthesized) <= droppedCount(chosen)
  );
}

export interface GoalPlanAdjudicationSelection {
  readonly plan: GoalPlan;
  readonly choice: 'P1' | 'P2';
  readonly selection: 'synthesis' | 'fallback';
  readonly validEnvelope: boolean;
}

export function selectGoalPlanFromAdjudication(input: {
  readonly candidateA: GoalPlanSelectionCandidate;
  readonly candidateB: GoalPlanSelectionCandidate;
  readonly adjudicatorProvider: ProviderId;
  readonly rawText: string | undefined;
}): GoalPlanAdjudicationSelection {
  const envelope = parseFinalLineChoiceEnvelope(
    input.adjudicatorProvider,
    input.rawText,
    ['P1', 'P2'],
  );
  const tally = tallyChoiceEnvelopes(envelope === null ? [] : [envelope]);
  const choice = tally.top?.optionId === 'P2' ? 'P2' : 'P1';
  if (envelope === null) {
    return { plan: input.candidateA.plan, choice: 'P1', selection: 'fallback', validEnvelope: false };
  }
  const chosen = choice === 'P2' ? input.candidateB : input.candidateA;
  const synthesized = parseGoalPlan(input.rawText);
  if (isAcceptableGoalPlanSynthesis(synthesized, chosen.plan)) {
    return { plan: synthesized, choice, selection: 'synthesis', validEnvelope: true };
  }
  return { plan: chosen.plan, choice, selection: 'fallback', validEnvelope: true };
}

export function formatGoalPlanSelectionNotice(input: {
  readonly candidateA: ProviderId;
  readonly candidateB: ProviderId;
  readonly reason: string;
}): string {
  return `Planning with 2 subscription brains: ${input.candidateA} + ${input.candidateB} - ${input.reason}; 3 total planning runs including selection, may take longer.`;
}

export function formatGoalPlanSelectionDisclosure(receipt: GoalPlanSelectionReceipt): string {
  if (receipt.status === 'ran') {
    const providers = receipt.candidates.map((candidate) => candidate.provider).join(' + ');
    const source = receipt.selection === 'synthesis' ? 'synthesized' : 'used the named original';
    return `Plan selection: ran - ${providers}; one adjudicator chose ${receipt.selectedChoice} and ${source}; ${receipt.totalCalls} bounded subscription calls.`;
  }
  if (receipt.reason === 'no-different-provider') {
    return 'Plan selection: no different authenticated provider; keeping the first plan (1 call used).';
  }
  return `Plan selection: ${receipt.reason.replaceAll('-', ' ')}; keeping the first plan (${receipt.totalCalls} calls used).`;
}

// ---------------------------------------------------------------------------
// Capability seam — the per-turn capability data the SEQUENTIAL path threads
// onto its route() calls and provider requests, carried into the panel so the
// ensemble path drops nothing the single-model path carries (audit parity):
//   - capabilityContext: the opt-in capability-fit re-rank context handed to
//     route() (capability registry §3/§5). Absent → route() behaves exactly as
//     before, byte-for-byte.
//   - attachments: the turn's image attachments, attached to EVERY panel
//     provider request when the turn genuinely carries image input (audit #4).
//   - webSearch: the native web-search request flag (audit #3), threaded onto
//     every panel provider request when the turn needs external/current facts.
// All three are computed ONCE per turn by orchestrate (from the structured
// EngagementPlan + the built CapabilityRouteContext, neither of which is
// reconstructable from OrchestrateDeps alone) and passed in so the panel
// mirrors the sequential path EXACTLY rather than re-deriving and diverging.
// All optional: absent → the panel runs byte-for-byte as before.
export interface PanelCapabilityInput {
  readonly capabilityContext?: CapabilityRouteContext;
  readonly attachments?: readonly Attachment[];
  readonly webSearch?: boolean;
  readonly turnCallBudget?: number;
  readonly verifyLevel?: import('./verify.js').VerifyLevel;
  readonly roundBudget?: number;
  readonly governorPlan?: Pick<AllocationPlan, 'panelAllowed' | 'shape' | 'turnCallBudget'>;
  readonly intentFrame?: IntentFrame;
}

// ---------------------------------------------------------------------------
// Executor — internal streaming + candidate helpers
// ---------------------------------------------------------------------------

/**
 * Stream a single provider run, yielding a `provider-event` for each event while
 * accumulating the terminal text/usage/cost. Mirrors orchestrate's streamProvider
 * so the synthesizer renders as one clean live stream. Returns the outcome.
 */
async function* streamProvider(
  deps: OrchestrateDeps,
  providerId: ProviderId,
  req: import('../providers/port.js').ProviderRequest,
  tier: Tier,
  signal: AbortSignal,
): AsyncGenerator<
  CoreEvent,
  {
    finalText: string | undefined;
    errored: import('../providers/port.js').CliError | undefined;
    usage: import('../providers/port.js').Usage | undefined;
    providerCostUsd: number | undefined;
    canceled: boolean;
  }
> {
  const provider = deps.providers[providerId];
  let finalText: string | undefined;
  let errored: import('../providers/port.js').CliError | undefined;
  let usage: import('../providers/port.js').Usage | undefined;
  let providerCostUsd: number | undefined;

  if (provider === undefined || signal.aborted) {
    return { finalText, errored, usage, providerCostUsd, canceled: signal.aborted };
  }

  for await (const ev of provider.run(req, signal)) {
    yield { type: 'provider-event', tier, event: ev };
    if (ev.type === 'done') {
      finalText = ev.text;
      // done.usage is the authoritative accumulated total.
      if (ev.usage !== undefined) usage = ev.usage;
      if (ev.costUsd !== undefined) providerCostUsd = ev.costUsd;
    } else if (ev.type === 'error') {
      errored = ev.error;
    } else if (ev.type === 'usage' && usage === undefined) {
      usage = ev.usage;
    }
    if (signal.aborted) {
      return { finalText, errored, usage, providerCostUsd, canceled: true };
    }
  }
  return { finalText, errored, usage, providerCostUsd, canceled: false };
}

/** The measured outcome of one panel candidate run. */
export interface CandidateOutcome {
  readonly provider: ProviderId;
  readonly model: string;
  readonly finalText: string | undefined;
  readonly usage: import('../providers/port.js').Usage | undefined;
  readonly providerCostUsd: number | undefined;
  readonly errored: import('../providers/port.js').CliError | undefined;
  readonly durationMs: number;
  /** The reasoning effort threaded to this candidate run, when one was selected. */
  readonly reasoningEffort: ReasoningEffort | undefined;
  /** The taskKind this candidate served (Stage 4 ledger signal) — always
   *  'implementation' for an independent panel candidate. */
  readonly taskKind: TaskKind;
}

/**
 * Run ONE candidate as an async GENERATOR: it streams the provider's events for
 * LIVENESS while accumulating the terminal data, then RETURNS its CandidateOutcome.
 *
 * Why a generator (was: a non-yielding Promise consumed by Promise.all): the old
 * shape meant no candidate progress reached the user until ALL candidates resolved,
 * so a slow panelist held back the live "tick-down" — the turn felt like a silent
 * hang for the whole candidate phase. Now each candidate's events interleave (via
 * `mergeCandidates`) so the renderer's panel line shows real, continuous activity
 * and each candidate flips to ✓ the INSTANT it finishes.
 *
 * What is yielded: ONLY non-`text` provider-events (reasoning / tool / usage /
 * error), which the renderer treats as "still working" liveness in panel mode and
 * NEVER as user-facing answer prose. Candidate prose `text` deltas are deliberately
 * NOT yielded — the attention budget is reserved for the synthesizer's single clean
 * stream, and dumping N candidates' raw prose (plus their JSON envelopes) would
 * corrupt the display. The terminal `text` is still captured for synthesis + ledger.
 */
/**
 * Per-candidate overrides that let a SIBLING one-shot poll (the judgment poll,
 * master-plan PHASE 7) reuse this executor verbatim while asking a DIFFERENT
 * question. Absent → byte-for-byte the panel candidate (the spec's audit parity):
 *   - `prompt`   : the exact provider prompt to send. When omitted, the panel
 *                  candidate prompt is built from `task` (unchanged). The judgment
 *                  poll passes the DECISION framed as a judgment question instead.
 *   - `taskKind` : the ledger Stage-4 outcome class. When omitted, `'implementation'`
 *                  (the panel candidate's kind, unchanged); the poll passes
 *                  `'judgment'` so its runs are a distinct outcome class.
 * The reasoning-effort selection, cost accounting, liveness streaming, abort
 * handling, and `CandidateOutcome` shape are IDENTICAL across both callers — only
 * the prompt + the recorded taskKind differ, exactly as judgment §1.2 demands.
 */
export interface CandidateOverrides {
  readonly prompt?: string;
  readonly taskKind?: TaskKind;
}

export async function* runCandidate(
  task: string,
  deps: OrchestrateDeps,
  plan: PanelPlan,
  candidate: ProviderId,
  signal: AbortSignal,
  historyContext: string | undefined,
  capability: PanelCapabilityInput,
  overrides: CandidateOverrides = {},
): AsyncGenerator<CoreEvent, CandidateOutcome> {
  const decision = route(
    plan.tier,
    [candidate],
    deps.policy,
    deps.availableModels,
    deps.authenticatedProviders,
    // Single-provider pool: the learned order can only confirm this candidate
    // (it cannot reorder a one-element pool, and each candidate is fixed by the
    // panel plan). Passed for consistency so every route() call threads it.
    deps.learnedProviderOrder?.[plan.tier],
    // Capability-fit context (capability registry §3/§5), mirroring the
    // sequential path — absent → route() behaves byte-for-byte as before.
    capability.capabilityContext,
  );
  const provider = deps.providers[candidate];
  const start = deps.clock.now();
  // Reasoning effort for this independent candidate (taskKind 'implementation';
  // diversity is its job, not adjudication). decision.tier is the tier route()
  // resolved (candidates stay at plan.tier — never the lifted manager ceiling), so
  // this never opens manager. undefined → no registry / no efforts → no flag.
  // An independent panel candidate now serves the turn's REAL taskKind (P0.3 —
  // threaded via capability.capabilityContext.taskSignals), falling back to the
  // prior 'implementation' default when no signals are present (registry absent),
  // so a no-registry turn is byte-for-byte unchanged. The judgment poll still
  // overrides this to 'judgment' (it weighs a decision, not an implementation).
  const taskKind: TaskKind =
    overrides.taskKind ?? capability.capabilityContext?.taskSignals?.taskKind ?? 'implementation';
  const reasoningEffort = panelEffort(
    deps,
    plan,
    candidate,
    decision.model,
    decision.tier,
    taskKind,
    capability.capabilityContext,
  );

  let finalText: string | undefined;
  let errored: import('../providers/port.js').CliError | undefined;
  let usage: import('../providers/port.js').Usage | undefined;
  let providerCostUsd: number | undefined;

  if (provider === undefined) {
    errored = {
      category: 'unknown',
      recoverable: false,
      message: `Provider "${candidate}" selected for the panel but absent from deps.providers.`,
      suggestion: 'Ensure the provider is installed and authenticated.',
    };
    return {
      provider: candidate,
      model: decision.model,
      finalText,
      usage,
      providerCostUsd,
      errored,
      durationMs: deps.clock.now() - start,
      reasoningEffort,
      taskKind,
    };
  }

  const req: import('../providers/port.js').ProviderRequest = {
    model: decision.model,
    // The injected poll prompt (the DECISION framed as a judgment question) when
    // supplied; otherwise the panel candidate prompt built from the task (byte-
    // for-byte the panel default — the audit-parity contract).
    prompt:
      overrides.prompt ??
      (capability.governorPlan !== undefined
        ? (() => {
            const debate = panelDebateConfig(capability.governorPlan, capability.intentFrame, plan);
            return debate !== undefined && debate.conclusionOptionIds.length > 0
              ? buildGovernedPanelCandidatePrompt(
                  decision.tier,
                  task,
                  debate.conclusionOptionIds,
                  historyContext,
                  contextFromDeps(deps),
                )
              : buildPanelCandidatePrompt(
                  decision.tier,
                  task,
                  historyContext,
                  contextFromDeps(deps),
                );
          })()
        : buildPanelCandidatePrompt(
            decision.tier,
            task,
            historyContext,
            contextFromDeps(deps),
          )),
    cwd: deps.cwd,
    sandbox: deps.sandbox,
    timeoutMs: deps.timeoutMs,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    // Native web-search request (audit #3) + image attachments (audit #4),
    // mirroring the sequential provider request exactly: only the Codex adapter
    // honours webSearch, and attachments ride only on a genuine image turn
    // (image-bearing attachments present). Absent → omitted, byte-for-byte
    // unchanged. Adapters that don't support images ignore the flag (fail-soft).
    ...(capability.webSearch === true ? { webSearch: true } : {}),
    ...(panelHasImageAttachment(capability.attachments)
      ? { attachments: capability.attachments }
      : {}),
  };

  try {
    for await (const ev of provider.run(req, signal)) {
      // Forward only NON-prose events as panel liveness — reasoning/tool/usage/
      // error keep the "Waiting on N models" line visibly working without ever
      // being mistaken for the user-facing answer. The candidate's prose `text`
      // deltas are intentionally swallowed (captured below for synthesis/ledger,
      // never streamed): N candidates' raw prose would corrupt the single clean
      // stream the synthesizer owns.
      if (ev.type !== 'text') {
        yield { type: 'provider-event', tier: plan.tier, event: ev };
      }
      if (ev.type === 'done') {
        finalText = ev.text;
        // done.usage is the authoritative accumulated total.
        if (ev.usage !== undefined) usage = ev.usage;
        if (ev.costUsd !== undefined) providerCostUsd = ev.costUsd;
      } else if (ev.type === 'error') {
        errored = ev.error;
      } else if (ev.type === 'usage' && usage === undefined) {
        usage = ev.usage;
      }
      // Honour cancellation promptly — stop draining a candidate the moment the
      // turn is aborted (mirrors streamProvider's mid-stream abort check).
      if (signal.aborted) break;
    }
  } catch (err) {
    errored = {
      category: 'unknown',
      recoverable: false,
      message: err instanceof Error ? err.message : String(err),
      suggestion: 'The panel candidate run threw unexpectedly.',
    };
  }

  return {
    provider: candidate,
    model: decision.model,
    finalText,
    usage,
    providerCostUsd,
    errored,
    durationMs: deps.clock.now() - start,
    reasoningEffort,
    taskKind,
  };
}

/**
 * Run every candidate generator CONCURRENTLY and interleave their yielded
 * liveness events as they arrive, calling `onOutcome(outcome)` the INSTANT each
 * candidate's generator returns — so the caller can record its ledger/cost and
 * emit its `tier-done` immediately, instead of waiting for the slowest panelist.
 *
 * This replaces the old `Promise.all(...)` aggregation, whose `await` blocked ALL
 * candidate feedback until every candidate had resolved (the "silent hang"). True
 * concurrency is preserved: every generator is started eagerly (all candidates run
 * in parallel), we merely surface their progress + completion as it happens.
 *
 * `onOutcome` is invoked exactly once per candidate, in COMPLETION order (fastest
 * first), which is also the order the renderer ticks panelists down. The returned
 * outcomes array is the FULL set (every candidate), preserved for synthesis.
 */
export async function* mergeCandidates(
  gens: ReadonlyArray<AsyncGenerator<CoreEvent, CandidateOutcome>>,
  onOutcome: (outcome: CandidateOutcome) => AsyncGenerator<CoreEvent>,
): AsyncGenerator<CoreEvent, CandidateOutcome[]> {
  const outcomes: CandidateOutcome[] = [];
  // Each pending entry races its generator's next step; we tag the winner by index
  // so a settled generator is dropped and the rest keep running concurrently.
  type Pending = Promise<{ index: number; result: IteratorResult<CoreEvent, CandidateOutcome> }>;
  const pending = new Map<number, Pending>();
  const step = (index: number, gen: AsyncGenerator<CoreEvent, CandidateOutcome>): Pending =>
    gen.next().then((result) => ({ index, result }));

  gens.forEach((gen, index) => {
    pending.set(index, step(index, gen));
  });

  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      outcomes.push(result.value);
      // Record + emit this candidate's completion right now (fastest first).
      yield* onOutcome(result.value);
    } else {
      // A liveness event — forward it and re-arm this generator's next step.
      yield result.value;
      pending.set(index, step(index, gens[index] as AsyncGenerator<CoreEvent, CandidateOutcome>));
    }
  }

  return outcomes;
}

function makeGoalPlanSelectionRunner(input: {
  readonly ownerTask: string;
  readonly deps: OrchestrateDeps;
  readonly tier: Tier;
  readonly classification: Classification;
  readonly signal: AbortSignal;
}): GoalPlanSelectionRunner {
  const boundedDeps: OrchestrateDeps = {
    ...input.deps,
    timeoutMs: Math.min(8_000, Math.max(1, input.deps.timeoutMs)),
  };
  return async (request): Promise<CandidateOutcome> => {
    const plan: PanelPlan = {
      tier: input.tier,
      candidates: [request.provider],
      synthesizer: request.provider,
      classification: input.classification,
    };
    const merged = mergeCandidates(
      [
        runCandidate(
          input.ownerTask,
          boundedDeps,
          plan,
          request.provider,
          input.signal,
          undefined,
          {},
          { prompt: request.prompt, taskKind: 'judgment' },
        ),
      ],
      async function* (): AsyncGenerator<CoreEvent> {},
    );
    while (true) {
      const next = await merged.next();
      if (next.done) {
        const outcome = next.value[0];
        if (outcome === undefined) throw new Error('Goal-plan selection produced no outcome.');
        return outcome;
      }
    }
  };
}

/**
 * Reuse candidate A, run one different-provider B, then one adjudicator. The
 * adapter is deliberately not called by runPanel or the menu until Phase C4.
 */
export async function selectGoalPlan(input: GoalPlanSelectionInput): Promise<GoalPlanSelectionResult> {
  const { candidateA } = input;
  const providerPool = input.candidateProviders ?? input.deps.authenticatedProviders ?? [];
  const providerB = providerPool.find(
    (provider) => provider !== candidateA.provider && input.deps.providers[provider] !== undefined,
  );
  const participantA: GoalPlanSelectionParticipant = {
    choice: 'P1',
    provider: candidateA.provider,
    ...(candidateA.model === undefined ? {} : { model: candidateA.model }),
  };
  if (providerB === undefined) {
    return {
      plan: candidateA.plan,
      receipt: {
        status: 'not-run',
        reason: 'no-different-provider',
        candidates: [participantA],
        selectedProvider: candidateA.provider,
        selectedChoice: 'P1',
        totalCalls: 1,
        selection: 'fallback',
      },
    };
  }

  const plannerPrompt = buildGoalPlanPrompt(
    input.ownerTask,
    undefined,
    undefined,
    input.systemModel,
  );
  const runner =
    input.runner ??
    makeGoalPlanSelectionRunner({
      ownerTask: input.ownerTask,
      deps: input.deps,
      tier: input.tier,
      classification: input.classification,
      signal: input.signal,
    });

  let candidateBOutcome: CandidateOutcome;
  try {
    candidateBOutcome = await runner({ role: 'candidate', provider: providerB, prompt: plannerPrompt });
  } catch {
    return failedGoalPlanSelection(candidateA, participantA, providerB, 'candidate-failed', 2);
  }
  if (
    candidateBOutcome.errored !== undefined ||
    candidateBOutcome.finalText === undefined ||
    candidateBOutcome.finalText.trim().length === 0
  ) {
    return failedGoalPlanSelection(candidateA, participantA, providerB, 'candidate-failed', 2);
  }
  const candidateBPlan = parseGoalPlan(candidateBOutcome.finalText);
  if (candidateBPlan === null) {
    return failedGoalPlanSelection(candidateA, participantA, providerB, 'candidate-invalid', 2);
  }
  const candidateB: GoalPlanSelectionCandidate = {
    plan: candidateBPlan,
    provider: providerB,
    model: candidateBOutcome.model,
    rawText: candidateBOutcome.finalText,
  };
  const participantB: GoalPlanSelectionParticipant = {
    choice: 'P2',
    provider: providerB,
    model: candidateBOutcome.model,
  };
  const adjudicatorProvider = candidateA.provider;
  const adjudicationPrompt = buildGoalPlanAdjudicationPrompt({
    ownerTask: input.ownerTask,
    plannerPrompt,
    candidateA,
    candidateB,
  });
  let adjudication: CandidateOutcome;
  try {
    adjudication = await runner({
      role: 'adjudicator',
      provider: adjudicatorProvider,
      prompt: adjudicationPrompt,
    });
  } catch {
    return failedGoalPlanAdjudication(candidateA, participantA, participantB, adjudicatorProvider);
  }
  if (
    adjudication.errored !== undefined ||
    adjudication.finalText === undefined ||
    adjudication.finalText.trim().length === 0
  ) {
    return failedGoalPlanAdjudication(candidateA, participantA, participantB, adjudicatorProvider);
  }
  const selected = selectGoalPlanFromAdjudication({
    candidateA,
    candidateB,
    adjudicatorProvider,
    rawText: adjudication.finalText,
  });
  if (!selected.validEnvelope) {
    return {
      plan: candidateA.plan,
      receipt: {
        status: 'not-run',
        reason: 'invalid-adjudication',
        candidates: [participantA, participantB],
        adjudicator: { choice: 'P1', provider: adjudicatorProvider, model: adjudication.model },
        selectedProvider: candidateA.provider,
        selectedChoice: 'P1',
        totalCalls: 3,
        selection: 'fallback',
      },
    };
  }
  const selectedCandidate = selected.choice === 'P2' ? candidateB : candidateA;
  return {
    plan: selected.plan,
    receipt: {
      status: 'ran',
      reason: 'selected',
      candidates: [participantA, participantB],
      adjudicator: {
        choice: selected.choice,
        provider: adjudicatorProvider,
        model: adjudication.model,
      },
      selectedProvider: selectedCandidate.provider,
      selectedChoice: selected.choice,
      totalCalls: 3,
      selection: selected.selection,
    },
  };
}

function failedGoalPlanSelection(
  candidateA: GoalPlanSelectionCandidate,
  participantA: GoalPlanSelectionParticipant,
  failedCandidate: ProviderId,
  reason: 'candidate-failed' | 'candidate-invalid',
  totalCalls: 2,
): GoalPlanSelectionResult {
  return {
    plan: candidateA.plan,
    receipt: {
      status: 'not-run',
      reason,
      candidates: [participantA],
      selectedProvider: candidateA.provider,
      selectedChoice: 'P1',
      totalCalls,
      selection: 'fallback',
      failedCandidate,
    },
  };
}

function failedGoalPlanAdjudication(
  candidateA: GoalPlanSelectionCandidate,
  participantA: GoalPlanSelectionParticipant,
  participantB: GoalPlanSelectionParticipant,
  adjudicatorProvider: ProviderId,
): GoalPlanSelectionResult {
  return {
    plan: candidateA.plan,
    receipt: {
      status: 'not-run',
      reason: 'adjudicator-failed',
      candidates: [participantA, participantB],
      adjudicator: { choice: 'P1', provider: adjudicatorProvider },
      selectedProvider: candidateA.provider,
      selectedChoice: 'P1',
      totalCalls: 3,
      selection: 'fallback',
    },
  };
}

// ---------------------------------------------------------------------------
// Executor — runPanel
// ---------------------------------------------------------------------------

/**
 * Execute one panel turn: run every candidate CONCURRENTLY, then stream the
 * cross-vendor synthesizer's adjudication as the user-facing answer.
 *
 * Event contract (so the render layer sees honest, real measurements):
 *  - notice(info) naming the panel composition.
 *  - tier-start for EVERY candidate BEFORE the concurrent await (so the UI knows
 *    all panelists are running), then tier-done for each with its REAL measured
 *    metrics after Promise.all resolves. Candidate prose deltas are NOT streamed.
 *  - If zero candidates succeed → a failing final (with the last error's
 *    category/provider when available) and return.
 *  - Otherwise: stream the synthesizer live (provider-event per event) wrapped in
 *    its own tier-start/tier-done, then a successful final whose output is the
 *    synthesizer's text.
 *
 * Costs, ledger entries, and session append all mirror orchestrate(): every run
 * (candidates + synthesizer) is recorded; usage that never arrived is recorded as
 * 0 (never fabricated); totalCostUsd is the real sum across all runs.
 *
 * @param task           - The raw user task.
 * @param deps           - Injected ports/providers (same shape orchestrate uses).
 * @param plan           - The resolved PanelPlan from planPanel().
 * @param signal         - AbortSignal; on abort yields notice(warn) + failing final.
 * @param historyContext - Optional compacted prior-conversation summary.
 * @param capability     - Per-turn capability seam (capabilityContext for route()
 *                         re-rank + attachments/webSearch for provider requests),
 *                         mirroring the sequential path so the panel drops nothing
 *                         it carries. Defaults to empty → byte-for-byte unchanged.
 */
export async function* runPanel(
  task: string,
  deps: OrchestrateDeps,
  plan: PanelPlan,
  signal: AbortSignal,
  historyContext?: string,
  capability: PanelCapabilityInput = {},
): AsyncGenerator<CoreEvent, false | undefined> {
  if (capability.turnCallBudget !== undefined) {
    const affordableCandidates = Math.min(
      plan.candidates.length,
      capability.turnCallBudget - 1,
    );
    if (affordableCandidates < 2) return false;
    if (affordableCandidates < plan.candidates.length) {
      plan = { ...plan, candidates: plan.candidates.slice(0, affordableCandidates) };
    }
  }
  const debateConfig = panelDebateConfig(capability.governorPlan, capability.intentFrame, plan);
  if (debateConfig !== undefined && plan.candidates.length > 2) {
    plan = { ...plan, candidates: plan.candidates.slice(0, 2) };
  }

  // Append the user message once (matches orchestrate's single user append).
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'user',
    content: task,
  });

  let totalCostUsd = 0;
  let attempts = 0;

  // Early abort: nothing ran yet.
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled before it started.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(signal.aborted ? { canceled: true } : {}),
    };
    return;
  }

  // Up-front honesty: a panel is auto-engaged on a hard turn and it ALWAYS spends
  // one provider run per candidate plus the synthesizer. State that cost here (the
  // budget is quota + latency on a flat-rate plan, never dollars — so we count
  // "quota-consuming runs", we do NOT call it free). The user sees this even when
  // they never flipped a switch, because the mode preset auto-engaged it.
  yield {
    type: 'notice',
    level: 'info',
    message:
      `Panel (hard turn): ${plan.candidates.join(', ')} → synthesized by ${plan.synthesizer}` +
      ` · ${plan.candidates.length + 1} quota-consuming runs, may take longer`,
  };

  // Phase 8 — a typed PANEL phase signal so the renderer drives the "Waiting on N
  // models" state machine from a real event (the candidate list, in run order)
  // rather than parsing the notice string above. Emitted ONCE, before the up-front
  // candidate tier-starts; the renderer flips each candidate to ✓ on its real
  // tier-done. Additive: non-panel renderers ignore it.
  yield {
    type: 'phase',
    phase: 'panel',
    participants: plan.candidates,
  };

  // --- Candidates: announce all, then run concurrently. ---
  // Resolve each candidate's model first so the tier-start carries the real model.
  const candidateModels = new Map<ProviderId, string>();
  for (const candidate of plan.candidates) {
    const d = route(
      plan.tier,
      [candidate],
      deps.policy,
      deps.availableModels,
      deps.authenticatedProviders,
      deps.learnedProviderOrder?.[plan.tier],
      // Same capability-fit context the candidate's own route() (in runCandidate)
      // uses, so the announced model matches the one that actually runs.
      capability.capabilityContext,
    );
    candidateModels.set(candidate, d.model);
    attempts++;
    yield {
      type: 'tier-start',
      tier: plan.tier,
      provider: candidate,
      model: d.model,
      attempt: attempts,
    };
  }

  // True concurrency with LIVE feedback: every candidate generator is started
  // eagerly (all run in parallel), and `mergeCandidates` interleaves their liveness
  // events as they arrive — then records cost/ledger and emits `tier-done` the
  // INSTANT each candidate finishes (fastest first), so the renderer ticks the
  // "Waiting on N models" line down in real time instead of all at once at the end.
  let lastErrored: import('../providers/port.js').CliError | undefined;
  let lastErroredProvider: ProviderId | undefined;

  // Per-candidate completion: record cost, ledger, and emit tier-done — identical
  // accounting to the old post-Promise.all loop, just driven the moment a
  // candidate returns. Closes over totalCostUsd / lastErrored* (mutated in order).
  async function* recordCandidate(outcome: CandidateOutcome): AsyncGenerator<CoreEvent> {
    const success = outcome.errored == null;
    const pricing = getModelPricing(outcome.provider, outcome.model);
    const usd =
      outcome.providerCostUsd ??
      (outcome.usage !== undefined && pricing !== undefined
        ? calculateCost(outcome.usage.inputTokens, outcome.usage.outputTokens, pricing)
        : 0);
    totalCostUsd += usd;

    if (!success && outcome.errored !== undefined) {
      lastErrored = outcome.errored;
      lastErroredProvider = outcome.provider;
    }

    const assessment = assess(outcome.finalText ?? '');

    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: outcome.provider,
      model: outcome.model,
      tier: plan.tier,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      cachedInputTokens: outcome.usage?.cachedInputTokens ?? 0,
      usd,
      durationMs: outcome.durationMs,
      success,
      ...(outcome.reasoningEffort !== undefined ? { reasoningEffort: outcome.reasoningEffort } : {}),
      taskKind: outcome.taskKind,
    });

    yield {
      type: 'tier-done',
      tier: plan.tier,
      success,
      confidence: assessment.confidence,
      costUsd: usd,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      durationMs: outcome.durationMs,
    };
  }

  const outcomes = yield* mergeCandidates(
    plan.candidates.map((candidate) =>
      runCandidate(task, deps, plan, candidate, signal, historyContext, capability),
    ),
    recordCandidate,
  );

  // Cancellation during candidate runs → stop honestly.
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(signal.aborted ? { canceled: true } : {}),
    };
    return;
  }

  // --- Gather successful candidate outputs for synthesis. ---
  // `mergeCandidates` returns outcomes in COMPLETION order (so tier-dones ticked
  // down fastest-first). Re-sort into the deterministic announce order so the
  // synthesis prompt's PANELIST labelling is independent of provider timing —
  // byte-for-byte identical to the pre-merge Promise.all ordering.
  const order = new Map(plan.candidates.map((p, i) => [p, i]));
  outcomes.sort(
    (a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0),
  );
  const succeeded = outcomes.filter(
    (o): o is CandidateOutcome & { finalText: string } =>
      o.errored == null && o.finalText !== undefined,
  );

  if (succeeded.length === 0) {
    // Every panelist failed — nothing to synthesize. Surface the last error.
    yield {
      type: 'final',
      success: false,
      output:
        lastErrored?.message ??
        'All panel candidates failed before producing an answer.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(lastErrored !== undefined ? { errorCategory: lastErrored.category } : {}),
      ...(lastErroredProvider !== undefined ? { provider: lastErroredProvider } : {}),
    };
    return;
  }

  // Phase 8 — a typed SYNTHESIS phase signal so the renderer switches the panel
  // line from "Waiting on N models" to "Synthesizing N answers…". `count` is the
  // number of SUCCESSFUL candidate answers actually being synthesized (real,
  // measured — never the candidate count, since some may have failed). Emitted
  // after every candidate tier-done and before the synthesizer tier-start.
  yield {
    type: 'phase',
    phase: 'synthesis',
    count: succeeded.length,
  };

  // --- Synthesizer: stream its adjudication live as the user-facing answer. ---
  // The synthesizer is the FINAL decision-maker on the user's hardest turns, so
  // it earns the flagship (manager) tier when warranted — exactly like the
  // cross-vendor reviewer in orchestrate.ts. Gate it through adaptive admission.
  //
  // Trigger note: orchestrate's reviewer uses trigger 'review' because review
  // there is ALREADY risk-gated upstream by shouldReview() — by the time
  // admitManager('review') runs, the turn has been judged hard, so 'review' (an
  // EARNED trigger) is unconditionally justified. The panel has NO such upstream
  // risk gate: the synthesizer ALWAYS runs, so an earned 'review' trigger would
  // open the flagship on EVERY panel turn (incl. a low-risk 'always' panel),
  // which is exactly the "never open manager-first off a soft classification"
  // behaviour the gate exists to prevent. We therefore use trigger 'initial' —
  // the one trigger that must justify itself via risk/confidence — so the
  // synthesizer earns the flagship only on a high/critical-risk turn (which is
  // when 'hard-turns' panels fire) and stays at plan.tier on a low-risk 'always'
  // panel. This matches the spec's stated semantics ("on a low-risk 'always'
  // panel, admission denies — low risk, not justified") and its required tests;
  // it deviates from the spec's literal `trigger: 'review'` precisely because the
  // panel lacks the upstream risk gate that makes 'review' safe in orchestrate.
  //
  // The panel doesn't track an escalation budget — the synthesizer is a single
  // adjudication — so flagshipAttemptsThisTurn is 0. Candidates stay at
  // plan.tier (diversity is their job; N concurrent flagship runs would be
  // needlessly quota-heavy).
  const synthAdmission = authorizeTier({
    requestedTier: 'manager',
    currentTier: plan.tier,
    classification: plan.classification,
    policy: deps.policy,
    ...(deps.planInfos !== undefined ? { planInfos: deps.planInfos } : {}),
    ...(deps.authenticatedProviders !== undefined
      ? { candidateProviders: deps.authenticatedProviders }
      : {}),
    flagshipAttemptsThisTurn: 0,
    trigger: 'initial',
  });
  // When admitted, lift the static maxTier ceiling to 'manager' so route() won't
  // clamp the synthesizer back down; otherwise route with the policy as-is
  // (clamped as usual). Use the RESOLVED synthDecision.tier everywhere
  // downstream so events/ledger never claim a tier the model didn't run.
  const synthPolicy: Policy = synthAdmission.allowed
    ? { ...deps.policy, maxTier: 'manager' }
    : deps.policy;
  const synthDecision = route(
    synthAdmission.allowed ? 'manager' : plan.tier,
    [plan.synthesizer],
    synthPolicy,
    deps.availableModels,
    deps.authenticatedProviders,
    // The synthesizer pool is a single fixed provider, so the learned order can
    // only confirm it (it cannot reorder a one-element pool). Key it on
    // plan.tier's learned snapshot — a reasonable, stable choice (the panel's
    // resolved-classification tier); passed for consistency with every other
    // route() call site.
    deps.learnedProviderOrder?.[plan.tier],
    // Capability-fit context (capability registry §3/§5), mirroring the
    // sequential review route — absent → route() unchanged, byte-for-byte.
    capability.capabilityContext,
  );
  // Reasoning effort for the synthesizer (taskKind 'review' — it adjudicates the
  // panel). synthDecision.tier is the tier admission already granted, so this
  // never opens manager. undefined → no registry / no efforts → no flag.
  const synthEffort = panelEffort(
    deps,
    plan,
    plan.synthesizer,
    synthDecision.model,
    synthDecision.tier,
    'review',
    capability.capabilityContext,
  );
  const synthContractDecision = shouldMaterializeContract({
    classification: plan.classification,
    routePlan: false,
    context: 'normal',
    reviewWillRun: true,
  });
  const incomingWorkContract =
    deps.workContract !== undefined ? capContract(deps.workContract) : undefined;
  const generatedWorkTrace =
    incomingWorkContract === undefined &&
    shouldMaterializeContract({
      classification: plan.classification,
      routePlan: false,
      context: 'normal',
      reviewWillRun: false,
    }).roadmap &&
    isCleanObjectiveTask(task)
      ? capContract({ version: 1, objective: task })
      : undefined;
  const workTrace =
    incomingWorkContract !== undefined ? incomingWorkContract : generatedWorkTrace;
  const synthContract =
    incomingWorkContract !== undefined
      ? incomingWorkContract
      : isCleanObjectiveTask(task)
        ? capContract({ version: 1, objective: task })
        : undefined;
  const synthCandidates = succeeded.map((o) => ({ provider: o.provider, output: o.finalText }));
  const compactSynthesisCandidates =
    capability.governorPlan !== undefined &&
    synthCandidates.reduce((sum, candidate) => sum + candidate.output.trim().length, 0) > 12_000;
  const synthContext = contextFromDeps(deps);
  const panelAgreement =
    debateConfig !== undefined
      ? classifyPanelAgreement(
          synthCandidates.map((candidate) => ({
            provider: candidate.provider,
            output: candidate.output,
          })),
          debateConfig.conclusionOptionIds,
          debateConfig.countingOptionIds,
        )
      : undefined;
  const runDebate =
    debateConfig !== undefined &&
    panelAgreement === 'material-disagreement' &&
    (capability.turnCallBudget === undefined || attempts < capability.turnCallBudget);
  if (debateConfig !== undefined && panelAgreement === 'consensus') {
    const receipt: PanelDebateReceipt = {
      status: 'not-run',
      reason: 'consensus',
      participants: plan.candidates.slice(0, 2),
      calls: 0,
    };
    yield { type: 'notice', level: 'info', message: formatPanelDebateNotice(receipt) };
  } else if (debateConfig !== undefined && panelAgreement === 'unknown') {
    const receipt: PanelDebateReceipt = {
      status: 'not-run',
      reason: 'unknown',
      participants: plan.candidates.slice(0, 2),
      calls: 0,
    };
    yield { type: 'notice', level: 'info', message: formatPanelDebateNotice(receipt) };
  } else if (
    debateConfig !== undefined &&
    panelAgreement === 'material-disagreement' &&
    !runDebate
  ) {
    const receipt: PanelDebateReceipt = {
      status: 'not-run',
      reason: 'budget',
      participants: plan.candidates.slice(0, 2),
      calls: 0,
    };
    yield { type: 'notice', level: 'info', message: formatPanelDebateNotice(receipt) };
  }
  const synthPrompt = runDebate
    ? (synthContractDecision.criteria && synthContract !== undefined
        ? buildPanelCritiqueSynthesisPrompt(task, synthCandidates, synthContract, synthContext)
        : buildPanelCritiqueSynthesisPrompt(task, synthCandidates, undefined, synthContext))
    : (synthContractDecision.criteria && synthContract !== undefined
        ? (compactSynthesisCandidates
            ? buildPanelSynthesisPrompt(task, synthCandidates, synthContract, synthContext, {
                compactCandidates: true,
              })
            : buildPanelSynthesisPrompt(task, synthCandidates, synthContract, synthContext))
        : (compactSynthesisCandidates
            ? buildPanelSynthesisPrompt(task, synthCandidates, undefined, synthContext, {
                compactCandidates: true,
              })
            : buildPanelSynthesisPrompt(task, synthCandidates, undefined, synthContext)));

  attempts++;
  yield {
    type: 'tier-start',
    tier: synthDecision.tier,
    provider: plan.synthesizer,
    model: synthDecision.model,
    attempt: attempts,
  };
  if (runDebate) {
    const receipt: PanelDebateReceipt = {
      status: 'ran',
      reason: 'material-disagreement',
      participants: plan.candidates.slice(0, 2),
      calls: 1,
    };
    yield { type: 'notice', level: 'info', message: formatPanelDebateNotice(receipt) };
  }

  const synthReq: import('../providers/port.js').ProviderRequest = {
    model: synthDecision.model,
    prompt: synthPrompt,
    cwd: deps.cwd,
    sandbox: deps.sandbox,
    timeoutMs: deps.timeoutMs,
    ...(synthEffort !== undefined ? { reasoningEffort: synthEffort } : {}),
    // Native web-search (audit #3) + image attachments (audit #4) ride the
    // synthesizer request too, mirroring the sequential provider request: the
    // synthesizer is the final decision-maker, so it must see the same image
    // input and may itself need external/current facts. Omitted when absent
    // (byte-for-byte unchanged); unsupported adapters ignore them (fail-soft).
    ...(capability.webSearch === true ? { webSearch: true } : {}),
    ...(panelHasImageAttachment(capability.attachments)
      ? { attachments: capability.attachments }
      : {}),
  };
  const synthStart = deps.clock.now();
  const synthOutcome = yield* streamProvider(
    deps,
    plan.synthesizer,
    synthReq,
    synthDecision.tier,
    signal,
  );
  const synthDurationMs = deps.clock.now() - synthStart;

  if (synthOutcome.canceled) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    yield {
      type: 'final',
      success: false,
      output: 'Task was cancelled.',
      tier: plan.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(synthOutcome.canceled ? { canceled: true } : {}),
    };
    return;
  }

  const synthSuccess = synthOutcome.errored == null;
  const synthPricing = getModelPricing(plan.synthesizer, synthDecision.model);
  const synthUsd =
    synthOutcome.providerCostUsd ??
    (synthOutcome.usage !== undefined && synthPricing !== undefined
      ? calculateCost(
          synthOutcome.usage.inputTokens,
          synthOutcome.usage.outputTokens,
          synthPricing,
        )
      : 0);
  totalCostUsd += synthUsd;

  const synthText = synthOutcome.finalText ?? (synthOutcome.errored?.message ?? '');
  const synthAssessment = assess(synthText);

  await deps.ledger.record({
    timestamp: deps.clock.isoNow(),
    sessionId: deps.session.id,
    taskId: deps.clock.uuid(),
    provider: plan.synthesizer,
    model: synthDecision.model,
    tier: synthDecision.tier,
    inputTokens: synthOutcome.usage?.inputTokens ?? 0,
    outputTokens: synthOutcome.usage?.outputTokens ?? 0,
    cachedInputTokens: synthOutcome.usage?.cachedInputTokens ?? 0,
    usd: synthUsd,
    durationMs: synthDurationMs,
    success: synthSuccess,
    ...(synthEffort !== undefined ? { reasoningEffort: synthEffort } : {}),
    // The synthesizer adjudicates the panel — always a 'review' taskKind (Stage 4).
    taskKind: 'review',
  });

  yield {
    type: 'tier-done',
    tier: synthDecision.tier,
    success: synthSuccess,
    confidence: synthAssessment.confidence,
    costUsd: synthUsd,
    inputTokens: synthOutcome.usage?.inputTokens ?? 0,
    outputTokens: synthOutcome.usage?.outputTokens ?? 0,
    durationMs: synthDurationMs,
  };
  if (
    !runDebate &&
    debateConfig !== undefined &&
    isLowSynthesisConfidence(synthAssessment, deps.policy, plan.classification) &&
    capability.turnCallBudget !== undefined &&
    attempts >= capability.turnCallBudget
  ) {
    const receipt: PanelDebateReceipt = {
      status: 'not-run',
      reason: 'low-synthesis-confidence-budget-exhausted',
      participants: plan.candidates.slice(0, 2),
      calls: 0,
    };
    yield { type: 'notice', level: 'info', message: formatPanelDebateNotice(receipt) };
  }

  if (!synthSuccess) {
    // The synthesizer itself failed; surface honestly rather than ship its error.
    yield {
      type: 'final',
      success: false,
      output: synthText,
      // The synthesizer produced (failed at) this answer — report its RESOLVED
      // tier so the final never claims a tier the model didn't run.
      tier: synthDecision.tier,
      totalCostUsd,
      sessionId: deps.session.id,
      attempts,
      ...(synthOutcome.errored !== undefined
        ? { errorCategory: synthOutcome.errored.category }
        : {}),
      provider: plan.synthesizer,
    };
    return;
  }

  // -----------------------------------------------------------------------
  // P0.1b — the synthesizer succeeded; route its answer through the SHARED
  // Candidate Quality Gate (verify → optional one-shot repair → accept/block),
  // exactly like the sequential and hedge paths. The gate owns the assistant
  // append and the terminal `final`. When verification is unarmed (no port / no
  // tests / passing tests) the gate accepts immediately and the emitted events
  // (one success final, assistant append, memory-proposal parity) are byte-for-
  // byte the pre-gate panel behaviour. Only a typed RED test or a parsed critic
  // `revise` changes behaviour: ONE same-author repair on plan.synthesizer at
  // synthDecision.tier, then accept-or-block.
  // -----------------------------------------------------------------------

  // The verify runner: armed ONLY when deps.verifyPort is present. Mirrors the
  // sequential work-call's runVerifyAtAccept — the critic (the one paid lever)
  // reuses the same cross-vendor reviewer routing + ledger/cost accounting, so
  // the diff critic is a real parseable verdict (never fabricated) and its cost
  // folds into totalCostUsd + the ledger exactly like a panel provider run.
  const runVerifyAtAccept = async (
    candidate: CandidateResult,
  ): Promise<import('./verify.js').VerifyOutcome | undefined> => {
    if (candidate.verifyPort === undefined) return undefined;
    const runCritic = async (input: CriticRunInput): Promise<CriticRunOutput | undefined> => {
      const reviewerProvider = deps.providers[input.reviewer];
      if (
        reviewerProvider === undefined ||
        (capability.turnCallBudget !== undefined && attempts >= capability.turnCallBudget)
      ) return { ran: false };
      try {
        const reviewDecision = route(
          'manager',
          [input.reviewer],
          deps.policy,
          deps.availableModels,
          deps.authenticatedProviders,
          deps.learnedProviderOrder?.['manager'],
          capability.capabilityContext,
        );
        const reviewEffort = panelEffort(
          deps,
          plan,
          input.reviewer,
          reviewDecision.model,
          reviewDecision.tier,
          'review',
          capability.capabilityContext,
        );
        const reviewReq: import('../providers/port.js').ProviderRequest = {
          model: reviewDecision.model,
          prompt: input.prompt,
          cwd: deps.cwd,
          sandbox: deps.sandbox,
          timeoutMs: deps.timeoutMs,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
        };
        const reviewStart = deps.clock.now();
        // Consume the critic run for TERMINAL data only — the cross-vendor critic
        // is an internal control-plane run and must NOT stream its prose to the
        // renderer (mirrors work-call's collectProviderRun).
        let reviewText: string | undefined;
        let reviewErrored: import('../providers/port.js').CliError | undefined;
        let reviewUsage: import('../providers/port.js').Usage | undefined;
        let reviewProviderCostUsd: number | undefined;
        let reviewCanceled = false;
        if (signal.aborted) return { ran: false };
        if (capability.turnCallBudget !== undefined) attempts++;
        for await (const ev of reviewerProvider.run(reviewReq, signal)) {
          if (ev.type === 'done') {
            reviewText = ev.text;
            if (ev.usage !== undefined) reviewUsage = ev.usage;
            if (ev.costUsd !== undefined) reviewProviderCostUsd = ev.costUsd;
          } else if (ev.type === 'error') {
            reviewErrored = ev.error;
          } else if (ev.type === 'usage' && reviewUsage === undefined) {
            reviewUsage = ev.usage;
          }
          if (signal.aborted) {
            reviewCanceled = true;
            break;
          }
        }
        const reviewDurationMs = deps.clock.now() - reviewStart;
        if (reviewCanceled || reviewErrored != null) return { ran: false };
        const reviewPricing = getModelPricing(input.reviewer, reviewDecision.model);
        const reviewUsd =
          reviewProviderCostUsd ??
          (reviewUsage !== undefined && reviewPricing !== undefined
            ? calculateCost(
                reviewUsage.inputTokens,
                reviewUsage.outputTokens,
                reviewPricing,
              )
            : 0);
        totalCostUsd += reviewUsd;
        await deps.ledger.record({
          timestamp: deps.clock.isoNow(),
          sessionId: deps.session.id,
          taskId: deps.clock.uuid(),
          provider: input.reviewer,
          model: reviewDecision.model,
          tier: reviewDecision.tier,
          inputTokens: reviewUsage?.inputTokens ?? 0,
          outputTokens: reviewUsage?.outputTokens ?? 0,
          cachedInputTokens: reviewUsage?.cachedInputTokens ?? 0,
          usd: reviewUsd,
          durationMs: reviewDurationMs,
          success: true,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
          taskKind: 'review',
        });
        const verdict = parseReviewVerdict(reviewText ?? '');
        return {
          ran: verdict.parsed === true,
          parsed: verdict.parsed,
          verdict: verdict.verdict,
          notes: verdict.notes,
        };
      } catch {
        return { ran: false };
      }
    };
    return verifyStage({
      output: candidate.content,
      provider: candidate.provider,
      tier: candidate.tier,
      port: candidate.verifyPort,
      level: candidate.verifyLevel,
      task: candidate.task,
      cwd: candidate.cwd,
      ...(candidate.verifyTestTimeoutMs !== undefined
        ? { testTimeoutMs: candidate.verifyTestTimeoutMs }
        : {}),
      available: candidate.availableProviders,
      runCritic,
    });
  };

  // ONE same-author repair: re-run plan.synthesizer at synthDecision.tier with the
  // original task + the verification evidence injected as manager-notes. This is
  // NOT a second panel and does NOT rerun candidates or synthesis — its events,
  // ledger entry, attempts, and cost are ordinary provider-attempt accounting.
  const runSynthRepair = async function* (
    candidate: CandidateResult,
    evidence: string,
  ): AsyncGenerator<CoreEvent, CandidateResult | undefined> {
    const provider = deps.providers[plan.synthesizer];
    if (
      provider === undefined ||
      signal.aborted ||
      (capability.turnCallBudget !== undefined && attempts >= capability.turnCallBudget)
    ) return undefined;

    attempts++;
    const repairPrompt = buildPrompt(
      synthDecision.tier,
      task,
      evidence,
      historyContext,
      contextFromDeps(deps),
    );
    yield {
      type: 'tier-start',
      tier: synthDecision.tier,
      provider: plan.synthesizer,
      model: synthDecision.model,
      attempt: attempts,
    };
    const repairReq: import('../providers/port.js').ProviderRequest = {
      model: synthDecision.model,
      prompt: repairPrompt,
      cwd: deps.cwd,
      sandbox: deps.sandbox,
      timeoutMs: deps.timeoutMs,
      ...(synthEffort !== undefined ? { reasoningEffort: synthEffort } : {}),
      ...(capability.webSearch === true ? { webSearch: true } : {}),
      ...(panelHasImageAttachment(capability.attachments)
        ? { attachments: capability.attachments }
        : {}),
    };
    const repairStart = deps.clock.now();
    const repairOutcome = yield* streamProvider(
      deps,
      plan.synthesizer,
      repairReq,
      synthDecision.tier,
      signal,
    );
    const repairDurationMs = deps.clock.now() - repairStart;
    const repairText = repairOutcome.finalText ?? '';
    const repairSuccess =
      !repairOutcome.canceled &&
      repairOutcome.errored == null &&
      repairText.trim().length > 0;
    const repairPricing = getModelPricing(plan.synthesizer, synthDecision.model);
    const repairUsd =
      repairOutcome.providerCostUsd ??
      (repairOutcome.usage !== undefined && repairPricing !== undefined
        ? calculateCost(
            repairOutcome.usage.inputTokens,
            repairOutcome.usage.outputTokens,
            repairPricing,
          )
        : 0);
    totalCostUsd += repairUsd;
    const repairAssessment = assess(repairText);
    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: plan.synthesizer,
      model: synthDecision.model,
      tier: synthDecision.tier,
      inputTokens: repairOutcome.usage?.inputTokens ?? 0,
      outputTokens: repairOutcome.usage?.outputTokens ?? 0,
      cachedInputTokens: repairOutcome.usage?.cachedInputTokens ?? 0,
      usd: repairUsd,
      durationMs: repairDurationMs,
      success: repairSuccess,
      ...(synthEffort !== undefined ? { reasoningEffort: synthEffort } : {}),
      taskKind: 'review',
    });
    yield {
      type: 'tier-done',
      tier: synthDecision.tier,
      success: repairSuccess,
      confidence: repairAssessment.confidence,
      costUsd: repairUsd,
      inputTokens: repairOutcome.usage?.inputTokens ?? 0,
      outputTokens: repairOutcome.usage?.outputTokens ?? 0,
      durationMs: repairDurationMs,
    };
    if (!repairSuccess) return undefined;
    const repairedRun: AcceptedRunSessionData = {
      content: repairText,
      tier: synthDecision.tier,
      provider: plan.synthesizer,
      model: synthDecision.model,
      confidence: repairAssessment.confidence,
      costUsd: repairUsd,
      durationMs: repairDurationMs,
      ...(workTrace !== undefined ? { workTrace } : {}),
    };
    return makeSynthCandidate(repairedRun);
  };

  function makeSynthCandidate(run: AcceptedRunSessionData): CandidateResult {
    const candidate: CandidateResult = {
      ...run,
      get totalCostUsd() { return totalCostUsd; },
      get attempts() { return attempts; },
      disposition: 'clean',
      task,
      cwd: deps.cwd,
      ...(deps.verifyPort !== undefined ? { verifyPort: deps.verifyPort } : {}),
      verifyLevel: capability.verifyLevel ?? deps.verifyLevel ?? 'tests',
      ...(deps.verifyTestTimeoutMs !== undefined
        ? { verifyTestTimeoutMs: deps.verifyTestTimeoutMs }
        : {}),
      availableProviders: deps.authenticatedProviders ?? [...plan.candidates],
      repair: (evidence) => runSynthRepair(candidate, evidence),
    };
    return candidate;
  }

  const synthRun: AcceptedRunSessionData = {
    content: synthText,
    tier: synthDecision.tier,
    provider: plan.synthesizer,
    model: synthDecision.model,
    confidence: synthAssessment.confidence,
    costUsd: synthUsd,
    durationMs: synthDurationMs,
    ...(workTrace !== undefined ? { workTrace } : {}),
  };

  yield* runCandidateQualityGate({
    deps,
    candidate: makeSynthCandidate(synthRun),
    goalTurn: deps.goalTurn === true,
    verify: runVerifyAtAccept,
    receiptEvents: (outcome, candidate) => buildVerifyReceiptEvents(deps, outcome, candidate),
  });
}
