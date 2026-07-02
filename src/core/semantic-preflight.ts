import type { Classification, Risk, RouteDecision, Tier } from './types.js';
import type { ReasoningEffort } from './model-capabilities.js';
import type { IntentFork, IntentFrame, IntentUsage } from './intent.js';
import type { GoalPlanTodo } from './goal-plan.js';
import { isTrivial } from './engagement.js';

type ProviderId = RouteDecision['provider'];

export type SemanticTaskKind =
  | 'conversation'
  | 'lookup'
  | 'analysis'
  | 'change'
  | 'decision';

export type SemanticTaskScope = 'single-step' | 'multi-step';

export interface SemanticTaskShape {
  readonly kind: SemanticTaskKind;
  readonly scope: SemanticTaskScope;
  readonly mutatesWorkspace: boolean;
}

export type EvidenceKind =
  | 'local-code'
  | 'external-source'
  | 'command-output'
  | 'test-result'
  | 'user-input';

export type EvidencePhase = 'before-answer' | 'before-execution' | 'before-completion';

export interface EvidenceNeed {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly phase: EvidencePhase;
  readonly query: string;
  readonly required: boolean;
}

export type SemanticDoneCondition =
  | { readonly status: 'specified'; readonly text: string }
  | {
      readonly status: 'unknown';
      readonly reason: 'not-inferable' | 'semantic-preflight-unavailable';
    };

export interface SemanticPreflightV1 {
  readonly version: 1;
  readonly objective: string;
  readonly taskShape: SemanticTaskShape;
  readonly route: {
    readonly tier: Tier;
    readonly plan: boolean;
    readonly rationale: string;
  };
  readonly risk: {
    readonly level: Risk;
    readonly reasons: readonly string[];
  };
  readonly uncertainty: {
    readonly level: 'low' | 'medium' | 'high';
    readonly reasons: readonly string[];
    readonly forks: readonly IntentFork[];
  };
  readonly evidenceNeeded: readonly EvidenceNeed[];
  readonly doneCondition: SemanticDoneCondition;
  readonly planSteps: readonly GoalPlanTodo[];
  readonly proposedExecution: {
    readonly provider: ProviderId | 'auto';
    readonly effort: ReasoningEffort;
    readonly rationale: string;
  };
  readonly source: 'model' | 'rules-fallback';
}

export interface ResolvedSemanticPreflight {
  readonly semantic: SemanticPreflightV1;
  readonly classification: Classification;
  readonly routePlan: boolean;
}

export type SemanticPreflightExtraction =
  | { readonly result: SemanticPreflightV1; readonly usage?: IntentUsage }
  | null;

export type SemanticPreflightExtractor = (
  task: string,
  signal: AbortSignal,
) => Promise<SemanticPreflightExtraction>;

export type SemanticPreflightDisposition =
  | 'bypass-trivial'
  | 'bypass-goal-contract'
  | 'run'
  | 'unavailable';

const OBJECTIVE_LIMIT = 80;
const RATIONALE_LIMIT = 120;
const REASON_LIMIT = 160;
const QUERY_LIMIT = 160;
const DONE_TEXT_LIMIT = 160;
const MAX_RISK_REASONS = 4;
const MAX_UNCERTAINTY_REASONS = 4;
const MAX_FORKS = 3;
const MAX_EVIDENCE = 6;
const MAX_PLAN_STEPS = 8;
const TODO_TEXT_LIMIT = 120;
const FORK_ID_LIMIT = 32;
const FORK_QUESTION_LIMIT = 160;
const FORK_OPTION_LIMIT = 120;
const FORK_ASSUME_LIMIT = 160;
const MAX_FORK_OPTIONS = 4;

const VALID_TASK_KINDS: ReadonlySet<string> = new Set<SemanticTaskKind>([
  'conversation',
  'lookup',
  'analysis',
  'change',
  'decision',
]);

const VALID_SCOPES: ReadonlySet<string> = new Set<SemanticTaskScope>([
  'single-step',
  'multi-step',
]);

const VALID_EVIDENCE_KINDS: ReadonlySet<string> = new Set<EvidenceKind>([
  'local-code',
  'external-source',
  'command-output',
  'test-result',
  'user-input',
]);

const VALID_EVIDENCE_PHASES: ReadonlySet<string> = new Set<EvidencePhase>([
  'before-answer',
  'before-execution',
  'before-completion',
]);

const VALID_UNCERTAINTY_LEVELS: ReadonlySet<string> = new Set<'low' | 'medium' | 'high'>([
  'low',
  'medium',
  'high',
]);

const VALID_EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const VALID_TIERS: ReadonlySet<string> = new Set<Tier>(['worker', 'ic', 'manager']);

const VALID_RISKS: ReadonlySet<string> = new Set<Risk>(['low', 'medium', 'high', 'critical']);

const EVIDENCE_ID_RE = /^[A-Z][A-Z0-9_-]{0,31}$/;
const PURE_SOCIAL_RE = /^\s*(?:hi|hello|hey|thanks|thank\s+you|ok|okay)[\s.!?,;:]*$/i;

function isSemanticPreflightTrivial(
  task: string,
  deterministic: Classification,
): boolean {
  if (PURE_SOCIAL_RE.test(task)) return true;
  const skippedFrame: IntentFrame = {
    version: 1,
    goal: '',
    confidence: 'high',
    source: 'skipped',
  };
  return isTrivial({
    frame: skippedFrame,
    classification: deterministic,
    routePlan: false,
    engagementBias: 0,
    task,
  });
}

export function decideSemanticPreflightDisposition(input: {
  readonly task: string;
  readonly deterministic: Classification;
  readonly goalTurn: boolean;
  readonly goalTurnHasObjectiveAndDone: boolean;
  readonly hasSemanticExtractor: boolean;
}): SemanticPreflightDisposition {
  if (input.task.trim().length === 0) return 'unavailable';
  if (input.goalTurn && input.goalTurnHasObjectiveAndDone) return 'bypass-goal-contract';
  if (!input.hasSemanticExtractor) return 'unavailable';
  return isSemanticPreflightTrivial(input.task, input.deterministic)
    ? 'bypass-trivial'
    : 'run';
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function capText(value: unknown, limit: number): string {
  return safeString(value).trim().slice(0, limit);
}

function capStringList(value: unknown, limit: number, maxItems: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const s = capText(raw, limit);
    if (s.length > 0) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function capFork(value: unknown): IntentFork | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = capText(raw['id'], FORK_ID_LIMIT);
  const question = capText(raw['question'], FORK_QUESTION_LIMIT);
  if (id.length === 0 || !EVIDENCE_ID_RE.test(id) || question.length === 0) return null;
  const options = capStringList(raw['options'], FORK_OPTION_LIMIT, MAX_FORK_OPTIONS);
  const assume = capText(raw['assumeIfUnasked'], FORK_ASSUME_LIMIT);
  const fork: { -readonly [K in keyof IntentFork]?: IntentFork[K] } = {
    id,
    question,
  };
  if (options.length > 0) fork.options = options;
  if (assume.length > 0) fork.assumeIfUnasked = assume;
  return fork as IntentFork;
}

function capForks(value: unknown): readonly IntentFork[] {
  if (!Array.isArray(value)) return [];
  const out: IntentFork[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length && out.length < MAX_FORKS; i++) {
    const fork = capFork(value[i]);
    if (fork !== null && !seen.has(fork.id)) {
      seen.add(fork.id);
      out.push(fork);
    }
  }
  return out;
}

function capEvidenceNeed(value: unknown): EvidenceNeed | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = capText(raw['id'], FORK_ID_LIMIT);
  if (id.length === 0 || !EVIDENCE_ID_RE.test(id)) return null;
  const kindRaw = raw['kind'];
  if (typeof kindRaw !== 'string' || !VALID_EVIDENCE_KINDS.has(kindRaw)) return null;
  const phaseRaw = raw['phase'];
  if (typeof phaseRaw !== 'string' || !VALID_EVIDENCE_PHASES.has(phaseRaw)) return null;
  const query = capText(raw['query'], QUERY_LIMIT);
  if (query.length === 0) return null;
  const required = typeof raw['required'] === 'boolean' ? raw['required'] : true;
  return { id, kind: kindRaw as EvidenceKind, phase: phaseRaw as EvidencePhase, query, required };
}

function capEvidenceNeeds(value: unknown): readonly EvidenceNeed[] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceNeed[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length && out.length < MAX_EVIDENCE; i++) {
    const need = capEvidenceNeed(value[i]);
    if (need === null || seen.has(need.id)) return null;
    seen.add(need.id);
    out.push(need);
  }
  return out;
}

function capPlanTodo(value: unknown, position: number): GoalPlanTodo | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const text = capText(raw['text'], TODO_TEXT_LIMIT);
  if (text.length === 0) return null;
  const depsRaw = raw['dependsOn'];
  let dependsOn: readonly number[] | undefined;
  if (Array.isArray(depsRaw)) {
    const deps: number[] = [];
    const seen = new Set<number>();
    for (const d of depsRaw) {
      const n = typeof d === 'number' ? d : Number(safeString(d));
      if (Number.isInteger(n) && n > 0 && n < position && !seen.has(n)) {
        seen.add(n);
        deps.push(n);
      }
    }
    if (deps.length > 0) dependsOn = deps;
  }
  return { text, ...(dependsOn !== undefined ? { dependsOn } : {}) } as GoalPlanTodo;
}

function capPlanSteps(value: unknown): readonly GoalPlanTodo[] {
  if (!Array.isArray(value)) return [];
  const out: GoalPlanTodo[] = [];
  for (let i = 0; i < value.length && out.length < MAX_PLAN_STEPS; i++) {
    const todo = capPlanTodo(value[i], out.length + 1);
    if (todo !== null) out.push(todo);
  }
  return out;
}

function extractLastJsonObject(text: string): string | null {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '"' && text[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

/**
 * Parse a model JSON reply into a `SemanticPreflightV1`, or `null` if the shape
 * is invalid. Never throws on any input (proxies, arrays, primitives, oversized
 * text, invalid JSON). Extra JSON keys are ignored. Caps all strings, lists,
 * forks, evidence, and plan steps deterministically.
 */
export function parseSemanticPreflight(text: string | undefined): SemanticPreflightV1 | null {
  if (text === undefined || text === null) return null;
  if (typeof text !== 'string' || text.length === 0) return null;

  const json = extractLastJsonObject(text);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  const objective = capText(obj['objective'], OBJECTIVE_LIMIT);
  if (objective.length === 0) return null;

  const taskShapeRaw = obj['taskShape'];
  if (taskShapeRaw === null || typeof taskShapeRaw !== 'object') return null;
  const ts = taskShapeRaw as Record<string, unknown>;
  const kindRaw = ts['kind'];
  if (typeof kindRaw !== 'string' || !VALID_TASK_KINDS.has(kindRaw)) return null;
  const scopeRaw = ts['scope'];
  if (typeof scopeRaw !== 'string' || !VALID_SCOPES.has(scopeRaw)) return null;
  const mutatesRaw = ts['mutatesWorkspace'];
  if (typeof mutatesRaw !== 'boolean') return null;
  const taskShape: SemanticTaskShape = {
    kind: kindRaw as SemanticTaskKind,
    scope: scopeRaw as SemanticTaskScope,
    mutatesWorkspace: mutatesRaw,
  };

  const routeRaw = obj['route'];
  if (routeRaw === null || typeof routeRaw !== 'object') return null;
  const rt = routeRaw as Record<string, unknown>;
  const tierRaw = rt['tier'];
  if (typeof tierRaw !== 'string' || !VALID_TIERS.has(tierRaw)) return null;
  const planRaw = rt['plan'];
  if (typeof planRaw !== 'boolean') return null;
  const routeRationale = capText(rt['rationale'], RATIONALE_LIMIT);
  if (routeRationale.length === 0) return null;

  const riskRaw = obj['risk'];
  if (riskRaw === null || typeof riskRaw !== 'object') return null;
  const rk = riskRaw as Record<string, unknown>;
  const levelRaw = rk['level'];
  if (typeof levelRaw !== 'string' || !VALID_RISKS.has(levelRaw)) return null;
  if (!Array.isArray(rk['reasons'])) return null;
  const riskReasons = capStringList(rk['reasons'], REASON_LIMIT, MAX_RISK_REASONS);

  const uncertaintyRaw = obj['uncertainty'];
  if (uncertaintyRaw === null || typeof uncertaintyRaw !== 'object') return null;
  const uc = uncertaintyRaw as Record<string, unknown>;
  const uLevelRaw = uc['level'];
  if (typeof uLevelRaw !== 'string' || !VALID_UNCERTAINTY_LEVELS.has(uLevelRaw)) return null;
  if (!Array.isArray(uc['reasons']) || !Array.isArray(uc['forks'])) return null;
  const uReasons = capStringList(uc['reasons'], REASON_LIMIT, MAX_UNCERTAINTY_REASONS);
  const uForks = capForks(uc['forks']);

  const evidenceNeeded = capEvidenceNeeds(obj['evidenceNeeded']);
  if (evidenceNeeded === null) return null;

  const doneRaw = obj['doneCondition'];
  let doneCondition: SemanticDoneCondition;
  if (typeof doneRaw === 'object' && doneRaw !== null) {
    const dc = doneRaw as Record<string, unknown>;
    if (dc['status'] === 'specified') {
      const doneText = capText(dc['text'], DONE_TEXT_LIMIT);
      if (doneText.length > 0) {
        doneCondition = { status: 'specified', text: doneText };
      } else {
        return null;
      }
    } else if (dc['status'] === 'unknown' && (dc['reason'] === 'not-inferable' || dc['reason'] === 'semantic-preflight-unavailable')) {
      doneCondition = { status: 'unknown', reason: dc['reason'] as 'not-inferable' | 'semantic-preflight-unavailable' };
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (!Array.isArray(obj['planSteps'])) return null;
  const planSteps = capPlanSteps(obj['planSteps']);

  const execRaw = obj['proposedExecution'];
  if (execRaw === null || typeof execRaw !== 'object') return null;
  const exec = execRaw as Record<string, unknown>;
  const providerRaw = exec['provider'];
  const validProviderIds: ReadonlySet<string> = new Set<ProviderId | 'auto'>(['claude', 'codex', 'opencode', 'grok', 'auto']);
  if (typeof providerRaw !== 'string') return null;
  const proposedProvider = validProviderIds.has(providerRaw)
    ? (providerRaw as ProviderId | 'auto')
    : 'auto';
  const effortRaw = exec['effort'];
  if (typeof effortRaw !== 'string' || !VALID_EFFORTS.has(effortRaw)) return null;
  const execRationale = capText(exec['rationale'], RATIONALE_LIMIT);
  if (execRationale.length === 0) return null;

  return {
    version: 1,
    objective,
    taskShape,
    route: {
      tier: tierRaw as Tier,
      plan: planRaw,
      rationale: routeRationale,
    },
    risk: {
      level: levelRaw as Risk,
      reasons: riskReasons,
    },
    uncertainty: {
      level: uLevelRaw as 'low' | 'medium' | 'high',
      reasons: uReasons,
      forks: uForks,
    },
    evidenceNeeded,
    doneCondition,
    planSteps,
    proposedExecution: {
      provider: proposedProvider,
      effort: effortRaw as ReasoningEffort,
      rationale: execRationale,
    },
    source: 'model',
  };
}

const RISK_ORDER: Readonly<Record<Risk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Return the higher of two {@link Risk} levels. Risk can only be raised, never
 * lowered.
 */
export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * Build a deterministic rules-fallback semantic preflight from the raw task
 * text and deterministic classification. Never invents evidence, provider, or
 * plan steps. Uses the capped raw request as `objective`, the deterministic
 * classification for route/risk, and sets `doneCondition` to
 * `unknown/semantic-preflight-unavailable`. Provider is `auto`, effort is `none`.
 */
export function fallbackSemanticPreflight(
  task: string,
  classification: Classification,
): SemanticPreflightV1 {
  const objective = capText(task, OBJECTIVE_LIMIT);
  return {
    version: 1,
    objective: objective.length > 0 ? objective : task.trim().slice(0, OBJECTIVE_LIMIT),
    taskShape: {
      kind: 'conversation',
      scope: 'single-step',
      mutatesWorkspace: false,
    },
    route: {
      tier: classification.tier,
      plan: false,
      rationale: capText(
        `deterministic fallback: tier=${classification.tier}, risk=${classification.risk}`,
        RATIONALE_LIMIT,
      ),
    },
    risk: {
      level: classification.risk,
      reasons: [],
    },
    uncertainty: {
      level: 'high',
      reasons: [],
      forks: [],
    },
    evidenceNeeded: [],
    doneCondition: { status: 'unknown', reason: 'semantic-preflight-unavailable' },
    planSteps: [],
    proposedExecution: {
      provider: 'auto',
      effort: 'none',
      rationale: '',
    },
    source: 'rules-fallback',
  };
}

/**
 * Resolve a deterministic classification together with a semantic preflight
 * into a {@link ResolvedSemanticPreflight}. Pure and exact:
 *
 * - classification.tier = semantic.route.tier
 * - classification.risk = maxRisk(deterministic.risk, semantic.risk.level)
 * - routePlan = semantic.route.plan
 * - rationale names both deterministic and semantic sources and the selected max
 * - proposedExecution is copied as observation only
 */
export function resolveSemanticPreflight(
  deterministic: Classification,
  semantic: SemanticPreflightV1,
): ResolvedSemanticPreflight {
  const resolvedRisk = maxRisk(deterministic.risk, semantic.risk.level);
  const classification: Classification = {
    tier: semantic.route.tier,
    risk: resolvedRisk,
    rationale: capText(
      `deterministic: tier=${deterministic.tier}, risk=${deterministic.risk}; ` +
        `semantic: tier=${semantic.route.tier}, risk=${semantic.risk.level}; ` +
        `resolved: tier=${semantic.route.tier}, risk=${resolvedRisk} (max of deterministic & semantic)`,
      RATIONALE_LIMIT,
    ),
  };

  return {
    semantic,
    classification,
    routePlan: semantic.route.plan,
  };
}

/**
 * Lossless conversion from a {@link SemanticPreflightV1} to an {@link IntentFrame}.
 * Maps goal/kind/forks/done/routing/risk; task shape, evidence, plan steps, and
 * provider proposal remain on the semantic object (not squeezed into the frame).
 */
export function semanticToIntentFrame(semantic: SemanticPreflightV1): IntentFrame {
  const frame: { -readonly [K in keyof IntentFrame]?: IntentFrame[K] } = {
    version: 1,
    goal: semantic.objective,
    confidence: semantic.uncertainty.level === 'low'
      ? 'high'
      : semantic.uncertainty.level === 'medium'
        ? 'medium'
        : 'low',
    source: semantic.source,
  };

  const kind = (() => {
    switch (semantic.taskShape.kind) {
      case 'change':
        return 'coding';
      case 'lookup':
        return 'research';
      case 'analysis':
        return 'coding';
      case 'decision':
        return 'planning';
      case 'conversation':
        return 'other';
      default:
        return '';
    }
  })();
  if (kind.length > 0) frame.kind = kind;

  if (semantic.doneCondition.status === 'specified' && semantic.doneCondition.text.length > 0) {
    frame.doneWhen = semantic.doneCondition.text;
  }

  if (semantic.uncertainty.forks.length > 0) {
    frame.forks = semantic.uncertainty.forks;
  }

  if (semantic.risk.reasons.length > 0) {
    frame.constraints = semantic.risk.reasons.map(
      (r) => `risk: ${r.slice(0, 130)}`,
    );
  }

  frame.routeTier = semantic.route.tier;
  frame.routePlan = semantic.route.plan;
  frame.operationRisk = semantic.risk.level;

  return frame as IntentFrame;
}

// ---------------------------------------------------------------------------
// P1-08b — Trivial-bypass population
// ---------------------------------------------------------------------------

/**
 * Decide whether a turn should bypass the semantic preflight model call.
 * Pure — no I/O, no model, no side effects.
 *
 * Returns `bypass-trivial` for greetings/acknowledgements and turns that the
 * existing `isTrivial` predicate classifies as trivial.
 *
 * Returns `bypass-goal-contract` for goal turns that already have both an
 * objective and done condition.
 *
 * Returns `unavailable` when the task is empty or the semantic extractor is
 * missing.
 *
 * Otherwise returns `run`.
 */
