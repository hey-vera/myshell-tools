/**
 * src/core/decompose.ts — turn a CONFIRMED substantial plan into a DAG of goals.
 *
 * This is the PRODUCER the bounded multi-goal scheduler (scheduler.ts) consumes:
 * given a plan/goal the user has just confirmed, it makes ONE model call (through
 * the EXISTING provider machinery — a near-twin of intent-extractor.ts) at the
 * STRONGEST admissible tier (decomposition is a planning task, worth the best
 * model the policy allows) and parses the output FAIL-SOFT into N {@link GoalSpec}s
 * each carrying `{id, title, dependsOn}`. The scheduler then runs the DAG
 * (independent goals concurrently, dependents queued until their deps finish).
 *
 * COST HONESTY (the load-bearing rule): we do NOT force fan-out. Concurrent
 * execution of fake-independent goals would waste the user's subscription quota,
 * so the prompt + the parser BOTH default to ONE goal. We split into >1 goal ONLY
 * when the model explicitly returns >1 genuinely-independent part. A genuinely
 * sequential or single-piece plan returns exactly ONE goal (the whole plan), which
 * the scheduler runs exactly like today's single-goal path. The model is told
 * plainly: "if the work is sequential or a single piece, return ONE goal."
 *
 * SUBSCRIPTION-CLEAN: the only I/O is the injected provider CLI run (OAuth
 * subscription, no API key, no embeddings, no new metered service) — same purity
 * contract as intent-extractor.ts (a thin composer; the real I/O is in the
 * injected provider). PURE module otherwise: no fs/path/child_process, no clock,
 * no randomness (`test/arch/guards.ts`).
 *
 * FAIL-SOFT everywhere: no provider, a route throw, a run error/timeout, an
 * unparseable or empty response → we return the SINGLE-goal fallback (the whole
 * plan as one goal). We never throw and never fabricate goals/deps. The DAG is
 * VALIDATED before returning: the goal count is capped, unknown dep ids are
 * dropped, self-edges are dropped, and any goal participating in a CYCLE has its
 * deps stripped (so a malformed model DAG degrades to independent goals rather
 * than a deadlock).
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import type { TurnCallBudget } from './turn-call-budget.js';
import type { GoalSpec } from './scheduler.js';
import { route } from './route.js';
import { runBudgetedProvider } from './budgeted-provider.js';
import { lastJsonObjectWithKey } from './json-envelope.js';

// ---------------------------------------------------------------------------
// Caps + constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of goals a decomposition may yield — prevents a runaway
 * model from fanning out to dozens of quota-consuming goals. Aligned with the
 * scheduler's honest ceiling (a handful active, the rest queued); 8 is generous.
 * When the model returns more, we keep the first 8 in order and drop the rest.
 */
export const MAX_GOALS = 8;
/** Per-field caps so a verbose model can't bloat a card title / id. */
const TITLE_LIMIT = 160;
const ID_LIMIT = 64;

/** Decomposition is a PLANNING task — route to the strongest tier the policy allows. */
const DECOMPOSE_TIER: Tier = 'manager';
/** It reads a plan and emits JSON — it never touches files. */
const DECOMPOSE_SANDBOX: SandboxLevel = 'read-only';

// ---------------------------------------------------------------------------
// Deps + types
// ---------------------------------------------------------------------------

/** Everything the decomposer needs to pick + run the strongest admissible model. */
export interface DecomposeDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the decomposition run. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly turnCallBudget?: TurnCallBudget;
}

/** Optional grounding context woven into the decomposition prompt (all best-effort). */
export interface DecomposeContext {
  /**
   * The repo-map / environment block already in scope this turn, so the model
   * grounds goal boundaries in REAL areas of the codebase rather than guessing.
   * Truncated defensively. Absent → the model decomposes from the plan text alone.
   */
  readonly repoMap?: string;
  /** Hard constraints from the work-contract / intent frame (e.g. "Node 22"). */
  readonly constraints?: readonly string[];
  /**
   * The id of the originating goal this plan is decomposed FROM. When present,
   * every returned {@link GoalSpec} gets this as `parentGoalId` so the board /
   * cancellation tree can track the parent/child relationship. Absent → no
   * parentGoalId is set (byte-identical to before).
   */
  readonly parentGoalId?: string;
}

// ---------------------------------------------------------------------------
// The prompt (mirrors intent.ts buildIntentPrompt — explicit, JSON-only, capped)
// ---------------------------------------------------------------------------

const REPO_MAP_PROMPT_LIMIT = 4_000;
const PLAN_PROMPT_LIMIT = 4_000;

/**
 * Build the decomposition prompt. The model is asked for a STRICT JSON object
 * `{"goals":[{"id","title","dependsOn"}]}` and is told the cost-honesty rule in
 * plain words: return ONE goal unless there are GENUINELY INDEPENDENT parts.
 * Exposed for unit coverage.
 */
export function buildDecomposePrompt(plan: string, context: DecomposeContext = {}): string {
  const lines: string[] = [];
  lines.push(
    'You are a senior engineer breaking a CONFIRMED plan into concurrently-runnable goals.',
    'Output STRICT JSON ONLY — no prose, no markdown fences — of the shape:',
    '{"goals":[{"id":"g1","title":"<one line>","dependsOn":["<id>",...]}]}',
    '',
    'RULES (read carefully — quota is real):',
    '  - Return MULTIPLE goals ONLY when the plan has GENUINELY INDEPENDENT parts',
    '    that could be worked at the same time without one waiting on another.',
    '  - If the work is SEQUENTIAL (each step needs the previous) OR is a SINGLE',
    '    coherent piece, return EXACTLY ONE goal whose title is the whole plan.',
    '    Do NOT invent parallelism — splitting sequential work wastes the user’s',
    '    subscription quota and gains nothing.',
    `  - At most ${MAX_GOALS} goals. Each "title" is one actionable line.`,
    '  - "dependsOn" lists the ids of goals that MUST finish before this one starts',
    '    (e.g. a goal that wires up a module depends on the goal that creates it).',
    '    Use it for true ordering; leave it [] for an independent goal.',
    '  - The dependency graph MUST be acyclic. Every id in "dependsOn" must be a',
    '    goal id you also returned.',
    '',
  );
  const constraints = (context.constraints ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (constraints.length > 0) {
    lines.push('HARD CONSTRAINTS the goals must respect:');
    for (const c of constraints.slice(0, 6)) lines.push(`  - ${c}`);
    lines.push('');
  }
  const repoMap = context.repoMap?.trim();
  if (repoMap !== undefined && repoMap.length > 0) {
    lines.push('PROJECT LAYOUT (ground goal boundaries in real areas):');
    lines.push(repoMap.slice(0, REPO_MAP_PROMPT_LIMIT));
    lines.push('');
  }
  lines.push('THE CONFIRMED PLAN:');
  lines.push(plan.trim().slice(0, PLAN_PROMPT_LIMIT));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parsing + DAG validation (PURE, fail-soft, total)
// ---------------------------------------------------------------------------

function capText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

/**
 * Parse the model's JSON into a VALIDATED goal DAG, fail-soft. Returns `null` when
 * there is no usable goals array (the caller then falls back to the single-goal
 * whole-plan spec). On a usable array it:
 *   - keeps the first {@link MAX_GOALS} goals with a non-empty title + id;
 *   - de-dupes ids (a later goal reusing an id is dropped — ids must be unique for
 *     the scheduler to tag events without clobbering);
 *   - drops self-edges and unknown dep ids (an edge to a goal we didn't keep);
 *   - strips ALL deps from any goal that participates in a CYCLE (so a malformed
 *     model DAG degrades to independent goals, never a deadlock).
 * PURE; never throws. Exposed for unit coverage.
 */
export function parseDecomposition(text: string | undefined, parentGoalId?: string): GoalSpec[] | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const obj = lastJsonObjectWithKey(text, 'goals');
  if (obj === null) return null;
  const rawGoals = obj['goals'];
  if (!Array.isArray(rawGoals)) return null;

  // First pass: collect well-formed goals (title+id), de-duping ids, capped.
  const seen = new Set<string>();
  const collected: Array<{ id: string; title: string; dependsOn: string[] }> = [];
  for (const raw of rawGoals) {
    if (collected.length >= MAX_GOALS) break;
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const title = capText(r['title'], TITLE_LIMIT);
    if (title.length === 0) continue;
    let id = capText(r['id'], ID_LIMIT);
    if (id.length === 0) id = `g${collected.length + 1}`;
    if (seen.has(id)) continue; // ids must be unique (scheduler tags events by id)
    seen.add(id);
    const deps = Array.isArray(r['dependsOn'])
      ? r['dependsOn'].map((d) => capText(d, ID_LIMIT)).filter((d) => d.length > 0)
      : [];
    collected.push({ id, title, dependsOn: deps });
  }
  if (collected.length === 0) return null;

  const known = new Set<string>(collected.map((g) => g.id));
  // Second pass: drop self-edges + unknown dep ids (fail-soft, never deadlock).
  for (const g of collected) {
    g.dependsOn = Array.from(
      new Set(g.dependsOn.filter((d) => d !== g.id && known.has(d))),
    );
  }
  // Break cycles: any goal on a cycle has its deps stripped → degrades to
  // independent goals rather than a graph the scheduler could never drain.
  breakCycles(collected);

  return collected.map((g) => ({
    id: g.id,
    title: g.title,
    ...(parentGoalId !== undefined && parentGoalId.length > 0 ? { parentGoalId } : {}),
    ...(g.dependsOn.length > 0 ? { dependsOn: g.dependsOn } : {}),
  }));
}

/**
 * Detect goals participating in a dependency CYCLE and strip their deps. Uses an
 * iterative Kahn-style topological peel: nodes that can be ordered (all deps
 * already ordered) are removed; whatever cannot be ordered is on a cycle, and we
 * clear its deps so the graph becomes acyclic. PURE; mutates `goals` in place.
 */
function breakCycles(goals: Array<{ id: string; dependsOn: string[] }>): void {
  const ordered = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const g of goals) {
      if (ordered.has(g.id)) continue;
      if (g.dependsOn.every((d) => ordered.has(d))) {
        ordered.add(g.id);
        progressed = true;
      }
    }
  }
  // Anything not ordered is on (or downstream of) a cycle — strip its deps so the
  // remaining graph is drainable. We only clear deps that point at un-ordered
  // nodes, preserving honest edges to nodes that DID order cleanly.
  for (const g of goals) {
    if (!ordered.has(g.id)) {
      g.dependsOn = g.dependsOn.filter((d) => ordered.has(d));
      ordered.add(g.id);
    }
  }
}

// ---------------------------------------------------------------------------
// The decomposer (the model call) — a thin composer over an injected provider
// ---------------------------------------------------------------------------

/**
 * Decompose a CONFIRMED plan into a validated goal DAG via ONE model call at the
 * strongest admissible tier. ALWAYS returns at least one {@link GoalSpec}:
 *   - On any failure (no provider / route throw / run error / timeout / empty /
 *     unparseable) → the SINGLE-goal fallback: the whole plan as one goal.
 *   - When the model returns ONE goal (sequential / single-piece) → that one goal
 *     (NO forced fan-out — the cost-honesty guarantee).
 *   - When the model returns >1 genuinely-independent goal → the validated DAG.
 *
 * It never throws and never writes. Mirrors makeIntentExtractor's run/parse shape.
 *
 * @param plan    - the confirmed plan / goal text the user just approved.
 * @param context - optional grounding (repo-map, constraints). Best-effort.
 * @param deps    - injected provider machinery (same shape as intent-extractor).
 * @param signal  - caller AbortSignal (the decomposition run is cancelable too).
 */
export async function decompose(
  plan: string,
  context: DecomposeContext,
  deps: DecomposeDeps,
  signal: AbortSignal,
): Promise<GoalSpec[]> {
  const fallback: GoalSpec[] = [
    {
      id: 'g0',
      title: capText(plan, TITLE_LIMIT) || 'goal',
      ...(context.parentGoalId !== undefined && context.parentGoalId.length > 0
        ? { parentGoalId: context.parentGoalId }
        : {}),
    },
  ];

  const planText = typeof plan === 'string' ? plan.trim() : '';
  if (planText.length === 0) return fallback;

  const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
    (id) => deps.providers[id] !== undefined,
  );
  if (pool.length === 0) return fallback;

  let provider: Provider | undefined;
  let model: string;
  try {
    // Strongest admissible model: request the manager tier; route() clamps it DOWN
    // to policy.maxTier, so this is "the best the policy allows", never above it.
    const decision = route(
      DECOMPOSE_TIER,
      pool,
      deps.policy,
      deps.availableModels,
      deps.authenticatedProviders,
    );
    provider = deps.providers[decision.provider];
    model = decision.model;
  } catch {
    return fallback;
  }
  if (provider === undefined) return fallback;

  const req: ProviderRequest = {
    model,
    prompt: buildDecomposePrompt(planText, context),
    cwd: deps.cwd,
    sandbox: deps.sandbox ?? DECOMPOSE_SANDBOX,
    timeoutMs: deps.timeoutMs,
  };

  let finalText: string | undefined;
  try {
    for await (const ev of runBudgetedProvider(provider, req, signal, {
      ...(deps.turnCallBudget ? { budget: deps.turnCallBudget } : {}),
      purpose: 'goal-decompose',
      bucket: 'discretionary',
      provider: provider.id,
    })) {
      if (ev.type === 'done') finalText = ev.text;
      else if (ev.type === 'error') return fallback;
    }
  } catch {
    return fallback;
  }

  const parsed = parseDecomposition(finalText, context.parentGoalId);
  if (parsed === null || parsed.length === 0) return fallback;
  return parsed;
}
