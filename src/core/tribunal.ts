/**
 * src/core/tribunal.ts — THE RIVAL TRIBUNAL (master-plan PHASE 9, the GATED
 * cross-vendor build-off; .tmp-master-vision.md / .tmp-master-judgment.md Part 2).
 *
 * THE ONE IDEA: on a genuine, load-bearing IMPLEMENTATION fork — two real, defensible
 * ways to BUILD the same thing — a single-vendor tool ships one mind's bet. myshell's
 * user owns ≥2 independent expert vendor minds, so it can have each vendor actually
 * BUILD its approach as a real diff in its OWN isolated git worktree, then let
 * REALITY adjudicate: the project's own tests cull a broken build, and each rival's
 * diff is cross-red-teamed by the OTHER vendor. The winner is earned by VERDICTS, not
 * by a model's say-so.
 *
 * THE HARD BOUNDARY (the honesty non-negotiables):
 *   - NEVER fabricate a second rival. The tribunal forms ONLY with ≥2 DISTINCT authed
 *     vendors (planTribunal returns null otherwise → single-vendor degradation, the
 *     normal work-call runs).
 *   - NEVER claim a winner without REAL test verdicts. `adjudicateTribunal` returns
 *     `chosen=null` when the evidence is ambiguous or no real verdict exists — a tie,
 *     two greens with no separating signal, or two unverified builds are all honest
 *     nulls, never a fabricated pick.
 *   - Tests CULL: a failing build loses to a passing one (reality dominates prose).
 *     Only after tests separate (or fail to) does the cross-critique factor in.
 *   - FAIL-SOFT: if either worktree can't be created, the tribunal tears down BOTH
 *     and returns `completed:false` — the caller falls through to the normal work-call.
 *     A tribunal error NEVER breaks the turn.
 *
 * REUSE, NOT REWRITE: the build runs reuse `runCandidate`/`mergeCandidates`/
 * `contextFromDeps` from ensemble.ts VERBATIM (per-rival deps shallow-cloned with the
 * worktree cwd so the existing executor reads `deps.cwd` unchanged); verification
 * reuses the injected `VerifyPort` (captureDiff/detectTestCommand/runTests); the
 * cross-red-team reuses `buildDiffReviewPrompt`/`parseReviewVerdict` from verify.ts/
 * review.ts. No new model-call machinery, no embeddings, no metered services.
 *
 * PURITY: `planTribunal`, `buildTribunalPrompt`, and `adjudicateTribunal` are PURE
 * (no fs/path/child_process, no Date.now/Math.random/new Date, no provider imports
 * beyond the type-only ProviderId) — enforced by test/arch/guards.test.ts. Only
 * `runTribunal` does I/O, and ONLY through the injected `OrchestrateDeps` ports/
 * providers + the {@link WorktreePort}, exactly like runPanel/runJudgmentPoll.
 *
 * @see .tmp-master-build.md PHASE 9 — the Rival Tribunal
 */

import type { CoreEvent, OrchestrateDeps, Tier, Classification } from './types.js';
import type { ProviderId } from '../providers/port.js';
import type { CommandGatePort } from './command-gate.js';
import { getModelPricing, calculateCost, calculateEffectiveCost } from '../infra/pricing.js';
import {
  runCandidate,
  mergeCandidates,
  contextFromDeps,
  type CandidateOutcome,
  type PanelCapabilityInput,
} from './ensemble.js';
import { assembleContextBlocks } from './prompt-context.js';
import {
  buildDiffReviewPrompt,
  stateFromTestRun,
  type CapturedDiff,
  type DetectedTestCommand,
  type TestRunResult,
  type VerifiedState,
} from './verify.js';
import { parseReviewVerdict } from './review.js';

// ---------------------------------------------------------------------------
// The isolated worktree port (impure git/fs/exec lives behind this — infra impl)
// ---------------------------------------------------------------------------

/** One isolated git worktree a rival builds in (cwd + the throwaway branch/ref). */
export interface Worktree {
  /** The absolute filesystem path of the worktree (becomes the rival's `deps.cwd`). */
  readonly cwd: string;
  /** The branch/ref name the worktree is checked out on (for teardown + the receipt). */
  readonly branch: string;
}

/**
 * The injected worktree port. The production impl (src/infra/worktree.ts) wraps
 * `git worktree`/`fs.symlink`/`execa` with the SAME best-effort, no-throw discipline
 * as verify-port.ts. Every method MUST be fail-soft: a missing `git`, a non-repo dir,
 * or any error degrades to a null/empty result rather than throwing.
 */
export interface WorktreePort {
  /**
   * Create an isolated worktree off `repoCwd`'s HEAD, labelled for the receipt.
   * Returns null on ANY failure (git absent, not a repo, add failed) — the tribunal
   * then cannot form and the caller degrades to the normal work-call. The impl
   * symlinks node_modules from the main tree (NEVER `npm install` — firewall gotcha).
   */
  createWorktree(repoCwd: string, label: string): Promise<Worktree | null>;
  /**
   * Run a bounded, non-destructive command inside a worktree. Captures output, never
   * throws; a non-zero exit is read (not thrown). Used for ad-hoc checks; the tests
   * themselves go through the {@link VerifyPort} (scoped to the worktree cwd).
   */
  execInWorktree(
    wt: Worktree,
    command: string,
    args: readonly string[],
    timeoutMs: number,
    commandGate?: CommandGatePort,
  ): Promise<{ exitCode: number | null; output: string }>;
  /** Remove a worktree (force) + prune, best-effort, NEVER throws. */
  removeWorktree(repoCwd: string, wt: Worktree): Promise<void>;
}

// ---------------------------------------------------------------------------
// The decision the tribunal builds — a load-bearing implementation fork
// ---------------------------------------------------------------------------

/** One named buildable approach on the fork the tribunal builds. */
interface TribunalOption {
  readonly id: string;
  readonly label: string;
}

/** The IMPLEMENTATION fork the tribunal builds — a real ≥2-option build decision. */
export interface TribunalDecision {
  /** The fork question, in plain language (the implementation/approach call). */
  readonly question: string;
  /** The competing buildable approaches (≥2 named options). */
  readonly options: readonly TribunalOption[];
}

// ---------------------------------------------------------------------------
// The plan — two distinct rivals, each assigned a buildable approach
// ---------------------------------------------------------------------------

/** A resolved plan for one tribunal: which DISTINCT vendor builds which approach. */
export interface TribunalPlan {
  /** The tier each rival builds at (cross-vendor diversity is the value). */
  readonly tier: Tier;
  /**
   * The two rivals — each a (vendor, option) pair. By construction the vendors are
   * DISTINCT and the options are buildable; exactly two (a head-to-head build-off).
   */
  readonly rivals: readonly { readonly vendor: ProviderId; readonly optionId: string }[];
  /** The implementation fork being built (≥2 named options). */
  readonly decision: TribunalDecision;
  /** The task classification (risk/tier) for this turn — threaded for parity. */
  readonly classification: Classification;
  /** The original user task (orientation for the build + the cross-critique). */
  readonly task: string;
}

/** A tribunal needs at least this many DISTINCT vendors to be a real build-off. */
const MIN_TRIBUNAL_VENDORS = 2;
/** A buildable fork needs at least this many named options to be a real decision. */
const MIN_OPTIONS = 2;
/** The tribunal is a strict HEAD-TO-HEAD: exactly two rivals (never N). */
const RIVAL_COUNT = 2;

/**
 * Decide whether (and how) a tribunal forms for this turn. PURE; never throws.
 *
 * Returns null (→ NO tribunal; the partner uses the normal single-vendor work-call)
 * when:
 *  - the fork has fewer than {@link MIN_OPTIONS} buildable named options; or
 *  - fewer than {@link MIN_TRIBUNAL_VENDORS} DISTINCT authenticated vendors exist —
 *    we NEVER fabricate a second rival, never build the same vendor twice and call
 *    it a tribunal.
 *
 * When a tribunal forms, the first two DISTINCT vendors (deduped, announce order
 * preserved) are each assigned the first two buildable options — a real head-to-head
 * build-off, cross-vendor BY CONSTRUCTION. Reuses the SAME distinct-vendor dedup logic
 * planJudgment uses.
 */
export function planTribunal(opts: {
  readonly decision: TribunalDecision;
  readonly tier: Tier;
  readonly classification: Classification;
  readonly authenticatedProviders: readonly ProviderId[];
  readonly task: string;
}): TribunalPlan | null {
  try {
    const { decision, tier, classification, authenticatedProviders, task } = opts;
    if (decision === null || typeof decision !== 'object') return null;
    const options = (decision.options ?? []).filter(
      (o): o is TribunalOption =>
        o !== null &&
        typeof o === 'object' &&
        typeof o.id === 'string' &&
        o.id.length > 0 &&
        typeof o.label === 'string' &&
        o.label.trim().length > 0,
    );
    // Not a real buildable fork → no tribunal.
    if (options.length < MIN_OPTIONS) return null;

    // DISTINCT vendors only — dedupe, preserve announce order (never faked plurality).
    const seen = new Set<ProviderId>();
    const distinct: ProviderId[] = [];
    for (const id of authenticatedProviders ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        distinct.push(id);
      }
    }
    // <2 DISTINCT vendors → no tribunal (degrade honestly to the single-vendor build).
    if (distinct.length < MIN_TRIBUNAL_VENDORS) return null;

    // A strict head-to-head: the first two distinct vendors take the first two options.
    const rivals = [
      { vendor: distinct[0] as ProviderId, optionId: (options[0] as TribunalOption).id },
      { vendor: distinct[1] as ProviderId, optionId: (options[1] as TribunalOption).id },
    ];
    if (rivals.length < RIVAL_COUNT) return null;

    return {
      tier,
      rivals,
      decision: { question: decision.question, options },
      classification,
      task,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The build prompt — "build THIS approach as a real diff" (PURE)
// ---------------------------------------------------------------------------

/** Cap on the raw task/question rendered into the build prompt. */
const TASK_CAP = 2000;
const QUESTION_CAP = 600;
const OPTION_CAP = 400;

/**
 * Build the prompt for ONE rival's BUILD run. PURE.
 *
 * Each rival is told to actually BUILD a specific approach to the fork as a REAL diff
 * in its isolated worktree — not to describe it, not to deliberate. It reasons WITH
 * the user's taste/intent/memory in scope (the SAME ordered context blocks every
 * executor gets via `contextFromDeps`). It is a head-to-head build-off: produce the
 * strongest possible implementation of THIS approach, because reality (the project's
 * own tests + a rival vendor's review) will judge it.
 *
 * @param decision        - The implementation fork + the named options.
 * @param optionId        - Which option THIS rival must build.
 * @param task            - The original user task (orientation).
 * @param historyContext  - Optional compacted prior-conversation summary.
 * @param context         - The rendered context blocks (assembleContextBlocks input).
 */
export function buildTribunalPrompt(
  decision: TribunalDecision,
  optionId: string,
  task: string,
  historyContext?: string,
  context?: Parameters<typeof assembleContextBlocks>[0],
): string {
  const question = (decision.question ?? '').trim().slice(0, QUESTION_CAP);
  const assigned = (decision.options ?? []).find((o) => o.id === optionId);
  const approach = (assigned?.label ?? optionId).trim().slice(0, OPTION_CAP);
  const taskText = (task ?? '').trim().slice(0, TASK_CAP);

  let prompt = `\
You are ONE of two independent senior engineers in a head-to-head build-off. You are
NOT deliberating and NOT describing a plan — you are BUILDING a real, working change
in your own isolated copy of the repository. Another engineer is independently
building a DIFFERENT approach to the same decision; the project's own tests and a
cross-review will then judge both builds on their merits. Build the STRONGEST possible
version of YOUR assigned approach.

THE IMPLEMENTATION DECISION:
${question}

YOUR ASSIGNED APPROACH (build THIS, in full):
${approach}

THE TASK THIS SERVES:
${taskText}

Make the actual code change — edit the real files, keep it correct, complete, and
self-consistent. Do not leave TODOs or half-finished work: this build will be run
against the project's own tests, so anything incomplete will simply fail.`;

  // The rival reasons WITH the user's taste/intent/memory in scope — the SAME ordered
  // context blocks every other executor gets. Absent → byte-for-byte the no-context
  // prompt.
  if (context !== undefined) {
    const contextBlocks = assembleContextBlocks(context);
    if (contextBlocks.length > 0) {
      prompt += `\n\n${contextBlocks}`;
    }
  }

  if (historyContext !== undefined && historyContext.trim().length > 0) {
    prompt += `\n\nCONVERSATION SO FAR (for context; do not repeat it back):\n${historyContext.trim()}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// The per-rival measured build (what one rival actually produced)
// ---------------------------------------------------------------------------

/** ONE rival's complete, REAL build evidence — the unit adjudication weighs. */
export interface RivalBuild {
  /** The vendor that built this rival. */
  readonly vendor: ProviderId;
  /** The approach (option id) this rival was assigned to build. */
  readonly optionId: string;
  /** The isolated worktree this rival built in (cwd + branch). */
  readonly worktree: Worktree;
  /** The captured diff this rival produced (empty ⇒ it built nothing). */
  readonly diff: CapturedDiff;
  /** Whether the rival's build run itself succeeded (no provider error). */
  readonly buildSucceeded: boolean;
  /** The test command detected in the worktree, when one was. */
  readonly testCommand?: DetectedTestCommand;
  /** The test run, when tests executed (any outcome). */
  readonly testRun?: TestRunResult;
  /** The honest four-state verification of THIS build (from the test run). */
  readonly verified: VerifiedState;
  /**
   * The OTHER vendor's cross-review verdict on this rival's diff, when one ran.
   * `approve`/`revise`/`escalate` (from parseReviewVerdict); absent → no review ran.
   */
  readonly crossReview?: {
    readonly reviewer: ProviderId;
    readonly verdict: 'approve' | 'revise' | 'escalate';
    readonly confidence: number | null;
  };
}

// ---------------------------------------------------------------------------
// THE ADJUDICATION — reality first (tests cull), then cross-critique (PURE)
// ---------------------------------------------------------------------------

/** The honest synthesis of a tribunal — the winner, or null when ambiguous. */
export interface TribunalSynthesis {
  /**
   * The winning rival's vendor — set ONLY when REAL verdicts genuinely separate the
   * two builds (a passing build over a failing one; or, among equally-verified
   * builds, a clear cross-review separation). NULL when ambiguous, tied, or no real
   * verdict exists — the synthesizer is FORBIDDEN from fabricating a winner.
   */
  readonly chosenVendor: ProviderId | null;
  /** The winning rival's option id, when a winner was chosen; null otherwise. */
  readonly chosenOptionId: string | null;
  /** A short, honest reason for the verdict (or why it's null). */
  readonly rationale: string;
  /** Every rival build the tally was built from (the real evidence). */
  readonly builds: readonly RivalBuild[];
}

/** Rank the four states so "more verified" comparisons are total + deterministic. */
function verifiedRank(state: VerifiedState): number {
  switch (state) {
    case 'passing':
      return 3;
    case 'reviewed':
      return 2;
    case 'failing':
      return 1;
    case 'unverified':
    default:
      return 0;
  }
}

/** Rank a cross-review verdict (approve beats revise beats escalate beats absent). */
function reviewRank(b: RivalBuild): number {
  const v = b.crossReview?.verdict;
  if (v === 'approve') return 3;
  if (v === 'revise') return 2;
  if (v === 'escalate') return 1;
  return 0; // no review ran
}

/**
 * Adjudicate the tribunal into an honest winner (or null). PURE; never throws.
 *
 * THE ORDER (reality first):
 *   1) TESTS CULL — a build whose tests went GREEN (`passing`) beats one that went
 *      RED (`failing`) or stayed `unverified`. A real test verdict that separates the
 *      two builds wins immediately; this is the only signal strong enough to pick on
 *      its own.
 *   2) CROSS-CRITIQUE — among builds at the SAME verified rank (both passing, both
 *      unverified, ...), the cross-review verdict breaks the tie (approve > revise >
 *      escalate). It only ever refines a tie tests couldn't break — it NEVER overrules
 *      a real test verdict.
 *   3) AMBIGUOUS → null — if neither tests nor the cross-review separate the builds
 *      (a true tie, or no real test verdict on either side and no review separation),
 *      `chosenVendor` is null. The call is genuinely the user's; we never fabricate a
 *      winner.
 *
 * HONESTY FLOOR: a winner is NEVER claimed on `passing` unless that rank came from a
 * real test run (verifiedRank reflects only the real `verified` state the caller set
 * from `stateFromTestRun`). Two builds that BOTH lack a real test verdict and tie on
 * review → null.
 */
export function adjudicateTribunal(builds: readonly RivalBuild[]): TribunalSynthesis {
  const real = (builds ?? []).filter(
    (b): b is RivalBuild => b !== null && typeof b === 'object' && typeof b.vendor === 'string',
  );

  if (real.length === 0) {
    return {
      chosenVendor: null,
      chosenOptionId: null,
      rationale: 'No rival builds were produced — nothing to adjudicate.',
      builds: real,
    };
  }
  if (real.length === 1) {
    // Only one rival actually built (the other errored / was torn down). We do NOT
    // crown the lone survivor a "winner" of a build-off that never happened — but if
    // it genuinely passed its tests, that is a real, honest signal worth naming.
    const lone = real[0] as RivalBuild;
    if (lone.verified === 'passing') {
      return {
        chosenVendor: lone.vendor,
        chosenOptionId: lone.optionId,
        rationale: `Only ${lone.vendor}'s build completed, and its tests passed — the lone verified build.`,
        builds: real,
      };
    }
    return {
      chosenVendor: null,
      chosenOptionId: null,
      rationale: `Only ${lone.vendor}'s build completed and it was not verified by passing tests — no honest winner.`,
      builds: real,
    };
  }

  const [a, b] = [real[0] as RivalBuild, real[1] as RivalBuild];

  // 1) TESTS CULL — a real test verdict that separates the builds wins outright.
  const ra = verifiedRank(a.verified);
  const rb = verifiedRank(b.verified);
  // A genuinely passing build over a non-passing one is the strongest, honest call.
  if (a.verified === 'passing' && b.verified !== 'passing') {
    return win(a, b, `${a.vendor}'s build passed the project's tests; ${b.vendor}'s did not (${b.verified}).`);
  }
  if (b.verified === 'passing' && a.verified !== 'passing') {
    return win(b, a, `${b.vendor}'s build passed the project's tests; ${a.vendor}'s did not (${a.verified}).`);
  }
  // A failing build loses to any more-verified build even when neither is passing
  // (e.g. reviewed-but-no-tests over a red build). Real RED is a real cull.
  if (ra !== rb && (a.verified === 'failing' || b.verified === 'failing')) {
    return ra > rb
      ? win(a, b, `${b.vendor}'s build failed its tests; ${a.vendor}'s did not.`)
      : win(b, a, `${a.vendor}'s build failed its tests; ${b.vendor}'s did not.`);
  }

  // 2) CROSS-CRITIQUE — same verified rank: let the rival reviews break the tie.
  const cra = reviewRank(a);
  const crb = reviewRank(b);
  if (cra !== crb && (cra > 0 || crb > 0)) {
    return cra > crb
      ? win(a, b, `Both builds verified equally (${a.verified}); ${b.vendor}'s drew the weaker cross-review.`)
      : win(b, a, `Both builds verified equally (${b.verified}); ${a.vendor}'s drew the weaker cross-review.`);
  }

  // 3) AMBIGUOUS → null (the synthesizer is FORBIDDEN from fabricating a winner).
  return {
    chosenVendor: null,
    chosenOptionId: null,
    rationale:
      'The two builds could not be separated by real verdicts (no decisive test result and no cross-review separation) — the call is genuinely the user\'s.',
    builds: real,
  };
}

/** Compose a winning synthesis (the winner first, then the loser) honestly. PURE. */
function win(winner: RivalBuild, loser: RivalBuild, rationale: string): TribunalSynthesis {
  return {
    chosenVendor: winner.vendor,
    chosenOptionId: winner.optionId,
    rationale,
    builds: [winner, loser],
  };
}

// ---------------------------------------------------------------------------
// runTribunal — the executor (worktrees → builds → tests-cull → cross-critique)
// ---------------------------------------------------------------------------

/** The terminal result of a tribunal: the synthesis + the real measured cost. */
export interface TribunalResult {
  readonly synthesis: TribunalSynthesis;
  readonly totalCostUsd: number;
  /**
   * Whether the tribunal completed (false → either worktree could not be created, or
   * it aborted before producing evidence). On `false` the caller falls through to the
   * normal work-call (honest degradation, never a fabricated rival).
   */
  readonly completed: boolean;
}

/** A tribunal build runs its tests with this default bound (overridable via deps). */
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

/**
 * Execute one Rival Tribunal: create an isolated worktree per rival, run each vendor's
 * BUILD concurrently (the SAME `runCandidate`+`mergeCandidates` the panel uses, with a
 * per-rival shallow-cloned deps so the executor reads the worktree cwd), then for each
 * build capture the diff + run the project's own tests (tests-cull) + cross-red-team
 * each rival's diff with the OTHER vendor, and adjudicate an HONEST winner (or null).
 *
 * FAIL-SOFT (the non-negotiable): if either worktree can't be created, BOTH are torn
 * down and the generator returns `{completed:false}` — the caller degrades to the
 * normal work-call. Worktrees are ALWAYS removed in a `finally` (best-effort, never
 * throws), including on abort. A tribunal error NEVER breaks the turn and NEVER leaves
 * a stray worktree.
 *
 * Liveness: yields an up-front honest cost notice (mirrors runJudgmentPoll), a
 * `phase:panel` for the renderer, and per-rival tier-start/tier-done with REAL metrics.
 *
 * @returns the events stream; the generator RETURNS the {@link TribunalResult}.
 */
export async function* runTribunal(
  deps: OrchestrateDeps,
  plan: TribunalPlan,
  signal: AbortSignal,
  historyContext?: string,
  capability: PanelCapabilityInput = {},
): AsyncGenerator<CoreEvent, TribunalResult> {
  let totalCostUsd = 0;
  const port = deps.worktreePort;

  // No worktree port (or already aborted) → cannot form; degrade cleanly.
  if (port === undefined || signal.aborted) {
    return { synthesis: adjudicateTribunal([]), totalCostUsd, completed: false };
  }

  const vendors = plan.rivals.map((r) => r.vendor);

  // Up-front honesty (like the poll/panel notice): a tribunal spends one quota-
  // consuming BUILD per vendor plus a cross-review each. State that cost here —
  // quota + latency on a flat-rate plan, never dollars.
  yield {
    type: 'notice',
    level: 'info',
    message:
      `Rival tribunal on a build decision: ${vendors.join(' vs ')}` +
      ` build it both ways in isolated worktrees, tests + cross-review pick the winner` +
      ` · ${plan.rivals.length * 2} quota-consuming runs, may take longer`,
  };
  // A typed PANEL phase so the renderer drives its multi-vendor state machine.
  yield { type: 'phase', phase: 'panel', participants: vendors };

  // --- Create the two isolated worktrees. If EITHER fails, tear down + degrade. ---
  const worktrees: Worktree[] = [];
  try {
    for (const rival of plan.rivals) {
      if (signal.aborted) break;
      const wt = await port.createWorktree(deps.cwd, `tribunal-${rival.vendor}`);
      if (wt === null) {
        // A worktree could not be created → no honest build-off. Tear down whatever
        // we made and degrade to the normal work-call (never a fabricated rival).
        yield {
          type: 'notice',
          level: 'warn',
          message: `Could not isolate a worktree for ${rival.vendor} — skipping the tribunal, building normally.`,
        };
        // The `finally` tears down whatever we already created — degrade cleanly.
        return { synthesis: adjudicateTribunal([]), totalCostUsd, completed: false };
      }
      worktrees.push(wt);
    }

    if (signal.aborted || worktrees.length < plan.rivals.length) {
      return { synthesis: adjudicateTribunal([]), totalCostUsd, completed: false };
    }

    // --- Run each rival's BUILD concurrently, each in its own worktree cwd. ---
    const context = contextFromDeps(deps);
    // A PanelPlan-shaped object lets `runCandidate` route each rival identically; it
    // reads only tier/classification off the plan (synthesizer is unused on the
    // candidate path).
    const candidatePlan = {
      tier: plan.tier,
      candidates: vendors,
      synthesizer: vendors[0] as ProviderId,
      classification: plan.classification,
    };

    let attempts = 0;
    for (const vendor of vendors) {
      attempts++;
      yield {
        type: 'tier-start',
        tier: plan.tier,
        provider: vendor,
        model: '', // resolved inside runCandidate; tier-done carries real metrics
        attempt: attempts,
      };
    }

    // Per-rival completion accounting (cost + ledger + tier-done), the instant each
    // returns — identical shape to runJudgmentPoll's recordCandidate.
    async function* recordCandidate(outcome: CandidateOutcome): AsyncGenerator<CoreEvent> {
      const success = outcome.errored == null;
      const pricing = getModelPricing(outcome.provider, outcome.model);
      const usd =
        outcome.providerCostUsd ??
        (outcome.usage !== undefined && pricing !== undefined
          ? (deps.cacheAccountingV2 === true
            ? calculateEffectiveCost(
                outcome.usage.inputTokens,
                outcome.usage.outputTokens,
                pricing,
                { cachedInputTokens: outcome.usage.cachedInputTokens, cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens },
              )
            : calculateCost(outcome.usage.inputTokens, outcome.usage.outputTokens, pricing))
          : 0);
      totalCostUsd += usd;

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
        ...(deps.cacheAccountingV2 === true && outcome.usage?.cacheWriteInputTokens !== undefined
          ? { cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens }
          : {}),
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
        confidence: null,
        costUsd: usd,
        inputTokens: outcome.usage?.inputTokens ?? 0,
        outputTokens: outcome.usage?.outputTokens ?? 0,
        durationMs: outcome.durationMs,
      };
    }

    const outcomes = yield* mergeCandidates(
      plan.rivals.map((rival, i) => {
        const wt = worktrees[i] as Worktree;
        // Per-rival deps: shallow-clone with the worktree cwd so the EXISTING
        // runCandidate (which reads deps.cwd) builds in isolation. No signature change.
        const rivalDeps: OrchestrateDeps = { ...deps, cwd: wt.cwd };
        const prompt = buildTribunalPrompt(
          plan.decision,
          rival.optionId,
          plan.task,
          historyContext,
          context,
        );
        return runCandidate(
          plan.task,
          rivalDeps,
          candidatePlan,
          rival.vendor,
          signal,
          historyContext,
          capability,
          { prompt, taskKind: 'implementation' },
        );
      }),
      recordCandidate,
    );

    if (signal.aborted) {
      return { synthesis: adjudicateTribunal([]), totalCostUsd, completed: false };
    }

    // --- Verify each build: capture diff + tests-cull (scoped to the worktree). ---
    const outcomeByVendor = new Map<ProviderId, CandidateOutcome>();
    for (const o of outcomes) outcomeByVendor.set(o.provider, o);

    const verifyPort = deps.verifyPort;
    const testTimeoutMs = deps.verifyTestTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

    const partial: Array<Omit<RivalBuild, 'crossReview'>> = [];
    for (let i = 0; i < plan.rivals.length; i++) {
      const rival = plan.rivals[i] as TribunalPlan['rivals'][number];
      const wt = worktrees[i] as Worktree;
      const outcome = outcomeByVendor.get(rival.vendor);
      const buildSucceeded = outcome !== undefined && outcome.errored == null;

      let diff: CapturedDiff = { files: [], patch: '' };
      let testCommand: DetectedTestCommand | undefined;
      let testRun: TestRunResult | undefined;
      let verified: VerifiedState = 'unverified';

      if (verifyPort !== undefined) {
        try {
          diff = await verifyPort.captureDiff(wt.cwd);
          // Only run tests when the build actually produced a diff (no diff ⇒ nothing
          // to verify ⇒ honest unverified; never a fabricated pass).
          if (diff.files.length > 0) {
            const cmd = await verifyPort.detectTestCommand(wt.cwd);
            if (cmd !== null) {
              testCommand = cmd;
              testRun = await verifyPort.runTests(wt.cwd, cmd, testTimeoutMs);
              verified = stateFromTestRun(testRun);
            }
          }
        } catch {
          // Fail-soft: a verify error leaves this build honestly unverified.
        }
      }

      partial.push({
        vendor: rival.vendor,
        optionId: rival.optionId,
        worktree: wt,
        diff,
        buildSucceeded,
        ...(testCommand !== undefined ? { testCommand } : {}),
        ...(testRun !== undefined ? { testRun } : {}),
        verified,
      });
    }

    if (signal.aborted) {
      return { synthesis: adjudicateTribunal([]), totalCostUsd, completed: false };
    }

    // --- Cross-red-team: each rival's diff reviewed by the OTHER vendor. ---
    const builds: RivalBuild[] = [];
    for (let i = 0; i < partial.length; i++) {
      const me = partial[i] as Omit<RivalBuild, 'crossReview'>;
      const otherIdx = i === 0 ? 1 : 0;
      const other = partial[otherIdx] as Omit<RivalBuild, 'crossReview'> | undefined;
      let crossReview: RivalBuild['crossReview'];

      // Only review a build that actually produced a diff, with a real OTHER vendor.
      if (
        other !== undefined &&
        other.vendor !== me.vendor &&
        me.diff.patch.length > 0 &&
        !signal.aborted
      ) {
        const reviewPrompt = buildDiffReviewPrompt({
          task: plan.task,
          diff: me.diff.patch,
          ...(me.testRun !== undefined ? { testOutput: me.testRun.output, testOutcome: me.testRun.outcome } : {}),
        });
        // Route the review to the OTHER vendor via runCandidate (taskKind 'review'),
        // in the SHARED repo cwd (read-only review — no build, so no worktree needed).
        const reviewOutcomes = yield* mergeCandidates(
          [
            runCandidate(
              plan.task,
              deps,
              { tier: plan.tier, candidates: [other.vendor], synthesizer: other.vendor, classification: plan.classification },
              other.vendor,
              signal,
              historyContext,
              capability,
              { prompt: reviewPrompt, taskKind: 'review' },
            ),
          ],
          recordCandidate,
        );
        const reviewOutcome = reviewOutcomes[0];
        if (reviewOutcome !== undefined && reviewOutcome.errored == null) {
          const verdict = parseReviewVerdict(reviewOutcome.finalText ?? '');
          if (verdict.parsed) {
            crossReview = {
              reviewer: other.vendor,
              verdict: verdict.verdict,
              confidence: verdict.confidence,
            };
          }
        }
      }

      builds.push({ ...me, ...(crossReview !== undefined ? { crossReview } : {}) });
    }

    if (signal.aborted) {
      return { synthesis: adjudicateTribunal(builds), totalCostUsd, completed: false };
    }

    const synthesis = adjudicateTribunal(builds);
    return { synthesis, totalCostUsd, completed: true };
  } finally {
    // ALWAYS tear down both worktrees, best-effort, never throws — including on abort
    // or an unexpected throw anywhere above.
    await teardown(port, deps.cwd, worktrees);
  }
}

/** Remove every worktree, best-effort — never throws (the finally-safe teardown). */
async function teardown(
  port: WorktreePort,
  repoCwd: string,
  worktrees: readonly Worktree[],
): Promise<void> {
  for (const wt of worktrees) {
    try {
      await port.removeWorktree(repoCwd, wt);
    } catch {
      // Best-effort: a failed teardown of one worktree never blocks the others.
    }
  }
}
