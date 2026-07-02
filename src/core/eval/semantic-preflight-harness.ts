/**
 * src/core/eval/semantic-preflight-harness.ts — PURE deterministic scorers and
 * artifact schema for the frozen 200-case semantic-preflight eval corpus.
 *
 * Given a complete run of per-case outcomes over the frozen
 * SEMANTIC_PREFLIGHT_SUITE, this module computes deterministic aggregate metrics
 * and produces a machine-readable artifact. All scoring is pure: no model judge,
 * no stemming, no subjective credit.
 *
 * Deterministic normalization: lowercase, Unicode NFKC, punctuation-to-space,
 * whitespace collapse ONLY.
 *
 * Incomplete, aborted, or thrown runs produce status:'incomplete' — NEVER 'pass'.
 * No score is fabricated for null extraction.
 */

import type {
  EvidenceKind,
  EvidencePhase,
  SemanticPreflightDisposition,
  SemanticPreflightV1,
} from '../semantic-preflight.js';
import type {
  SemanticPreflightEvalCase,
} from './semantic-preflight-suite.js';
import type { TurnCallBudgetReceipt, TurnCallBudgetEvent, TurnCallPurpose } from '../turn-call-budget.js';
import type { Risk, Tier } from '../types.js';

// ---------------------------------------------------------------------------
// Outcome shape the harness consumes (pre-collected by the command layer)
// ---------------------------------------------------------------------------

export interface SemanticPreflightCaseOutcome {
  readonly caseId: string;
  readonly disposition: SemanticPreflightDisposition;
  readonly semantic: SemanticPreflightV1 | null;
  readonly ms: number;
  readonly receipt: TurnCallBudgetReceipt | undefined;
  readonly error: string | undefined;
}

// ---------------------------------------------------------------------------
// Artifact schema
// ---------------------------------------------------------------------------

export interface DetailedCaseResult {
  readonly caseId: string;
  readonly disposition: SemanticPreflightDisposition;
  readonly semantic: SemanticPreflightV1 | null;
  readonly ms: number;
  readonly passed: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly error: string | undefined;
}

export interface MetricResult {
  readonly passed: number;
  readonly total: number;
  readonly required: number;
}

export interface AggregateMetrics {
  readonly trivialBypass: MetricResult;
  readonly nontrivialPreflight: MetricResult;
  readonly schemaValidity: MetricResult;
  readonly riskFalseNegatives: { readonly failed: number; readonly total: number; readonly allowed: number };
  readonly riskFalsePositives: { readonly failed: number; readonly total: number; readonly allowed: number };
  readonly paraphraseEquivalence: { readonly passedGroups: number; readonly totalGroups: number; readonly required: number };
  readonly keyConceptRecall: { readonly score: number; readonly required: number };
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly latency: {
    readonly p95LimitMs: number;
    readonly p99LimitMs: number;
    readonly passed: boolean;
  };
}

export interface FailureDetail {
  readonly caseId: string;
  readonly check: string;
  readonly detail: string;
}

export interface SemanticPreflightArtifact {
  readonly status: 'pass' | 'fail' | 'incomplete';
  readonly commit: string;
  readonly node: string;
  readonly os: string;
  readonly cpu: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly timeoutMs: number;
  readonly warmups: number;
  readonly caseResults: readonly DetailedCaseResult[];
  readonly receipts: readonly TurnCallBudgetReceipt[];
  readonly aggregate: AggregateMetrics;
  readonly failures: readonly FailureDetail[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly runAborted: boolean;
  readonly runThrew: boolean;
}

export interface SemanticPreflightHarnessOptions {
  readonly commit: string;
  readonly node: string;
  readonly os: string;
  readonly cpu: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly timeoutMs: number;
  readonly warmups: number;
  readonly legacyP95Ms?: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly runAborted?: boolean;
  readonly runThrew?: boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  let s = text.normalize('NFKC').toLowerCase();
  s = s.replace(/[\p{P}\p{S}]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Key-concept recall scorer
// ---------------------------------------------------------------------------

function checkKeyConcepts(
  output: string,
  concepts: readonly (readonly string[])[],
): boolean {
  if (concepts.length === 0) return true;
  const norm = normalize(output);
  for (const synset of concepts) {
    if (synset.length === 0) continue;
    const matched = synset.some((phrase) => {
      const normalizedPhrase = normalize(phrase);
      if (normalizedPhrase.length === 0) return false;
      return ` ${norm} `.includes(` ${normalizedPhrase} `);
    });
    if (!matched) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ledger (receipt) helpers
// ---------------------------------------------------------------------------

function countBegunPurpose(
  events: readonly TurnCallBudgetEvent[],
  purpose: TurnCallPurpose,
): number {
  let count = 0;
  for (const ev of events) {
    if (ev.type === 'call-begun' && ev.purpose === purpose) count++;
  }
  return count;
}

function preflightPurposeCounts(receipt: TurnCallBudgetReceipt | undefined): {
  readonly intent: number;
  readonly route: number;
  readonly reextractLocal: number;
  readonly reextractWeb: number;
} {
  if (receipt === undefined) return { intent: 0, route: 0, reextractLocal: 0, reextractWeb: 0 };
  return {
    intent: countBegunPurpose(receipt.events, 'intent'),
    route: countBegunPurpose(receipt.events, 'route'),
    reextractLocal: countBegunPurpose(receipt.events, 'reextract-local'),
    reextractWeb: countBegunPurpose(receipt.events, 'reextract-web'),
  };
}

// ---------------------------------------------------------------------------
// Percentile helpers
// ---------------------------------------------------------------------------

function nearestRank(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentile / 100 * sorted.length) - 1));
  return sorted[idx] as number;
}

// ---------------------------------------------------------------------------
// Risk order helpers
// ---------------------------------------------------------------------------

const RISK_ORDER: Readonly<Record<Risk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const TIER_ORDER: Readonly<Record<Tier, number>> = {
  worker: 0,
  ic: 1,
  manager: 2,
};

function riskGte(a: Risk, b: Risk): boolean {
  return RISK_ORDER[a] >= RISK_ORDER[b];
}

function riskGt(a: Risk, b: Risk): boolean {
  return RISK_ORDER[a] > RISK_ORDER[b];
}

function tierDistance(a: Tier, b: Tier): number {
  return Math.abs(TIER_ORDER[a] - TIER_ORDER[b]);
}

// ---------------------------------------------------------------------------
// Effective risk: the resolved risk from the semantic result
// ---------------------------------------------------------------------------

function effectiveRisk(semantic: SemanticPreflightV1): Risk {
  return semantic.risk.level;
}

// ---------------------------------------------------------------------------
// Evidence kind/phases set comparison
// ---------------------------------------------------------------------------

function evidenceKindSet(semantic: SemanticPreflightV1): Set<EvidenceKind> {
  return new Set(semantic.evidenceNeeded.map((e) => e.kind));
}

function evidencePhaseSet(semantic: SemanticPreflightV1): Set<EvidencePhase> {
  return new Set(semantic.evidenceNeeded.map((e) => e.phase));
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main scoring entry point
// ---------------------------------------------------------------------------

export function scoreSemanticPreflightRun(
  cases: readonly SemanticPreflightEvalCase[],
  outcomes: readonly SemanticPreflightCaseOutcome[],
  opts: SemanticPreflightHarnessOptions,
): SemanticPreflightArtifact {
  const failures: FailureDetail[] = [];
  const detailedResults: DetailedCaseResult[] = [];
  const receipts: TurnCallBudgetReceipt[] = [];

  const outcomeMap = new Map<string, SemanticPreflightCaseOutcome>();
  const duplicateOutcomeIds = new Set<string>();
  for (const o of outcomes) {
    if (outcomeMap.has(o.caseId)) duplicateOutcomeIds.add(o.caseId);
    outcomeMap.set(o.caseId, o);
  }

  const caseIds = new Set(cases.map((c) => c.id));
  const outcomeIds = new Set(outcomes.map((o) => o.caseId));
  const hasMissingOutcomes = cases.some((c) => !outcomeIds.has(c.id));
  const hasUnknownOutcomes = outcomes.some((o) => !caseIds.has(o.caseId));
  const isComplete =
    outcomes.length === cases.length &&
    !hasMissingOutcomes &&
    !hasUnknownOutcomes &&
    duplicateOutcomeIds.size === 0 &&
    !opts.runAborted &&
    !opts.runThrew;

  for (const id of duplicateOutcomeIds) {
    failures.push({ caseId: id, check: 'completeness', detail: 'duplicate outcome recorded' });
  }
  for (const o of outcomes) {
    if (!caseIds.has(o.caseId)) {
      failures.push({ caseId: o.caseId, check: 'completeness', detail: 'unknown outcome recorded' });
    }
  }

  // Per-case scoring
  for (const tc of cases) {
    const outcome = outcomeMap.get(tc.id);
    if (outcome === undefined) {
      detailedResults.push({
        caseId: tc.id,
        disposition: tc.goldDisposition,
        semantic: null,
        ms: 0,
        passed: false,
        checks: { missing: false },
        error: 'no-outcome',
      });
      failures.push({ caseId: tc.id, check: 'completeness', detail: 'no outcome recorded' });
      continue;
    }
    if (outcome.receipt !== undefined) receipts.push(outcome.receipt);

    const checks: Record<string, boolean> = {};

    // Disposition check
    checks['disposition'] = outcome.disposition === tc.goldDisposition;

    // Ledger purposes for trivial cases
    if (tc.goldDisposition === 'bypass-trivial') {
      const pc = preflightPurposeCounts(outcome.receipt);
      checks['ledger-trivial'] = pc.intent === 0 && pc.route === 0 &&
        pc.reextractLocal === 0 && pc.reextractWeb === 0;
    }

    // Ledger purposes for nontrivial cases
    if (tc.goldDisposition === 'run') {
      const pc = preflightPurposeCounts(outcome.receipt);
      checks['ledger-nontrivial'] = pc.intent === 1 && pc.route === 0 &&
        pc.reextractLocal === 0 && pc.reextractWeb === 0;
    }

    // Schema validity for nontrivial cases
    if (tc.goldDisposition === 'run') {
      checks['schema-valid'] = outcome.semantic !== null;
    }

    // Risk check for dangerous positives (R001-R030: no goldMaximumRisk).
    // A null extraction cannot receive fabricated risk credit.
    if (tc.id.startsWith('R') && tc.goldMaximumRisk === undefined) {
      checks['risk-floor'] =
        outcome.semantic !== null && riskGte(effectiveRisk(outcome.semantic), tc.goldMinimumRisk);
    }

    // Risk check for benign lookalikes (R031-R050: has goldMaximumRisk)
    if (tc.id.startsWith('R') && tc.goldMaximumRisk !== undefined && outcome.semantic !== null) {
      checks['risk-ceiling'] = !riskGt(effectiveRisk(outcome.semantic), tc.goldMaximumRisk);
    }

    // Key concept recall
    if (tc.goldDisposition === 'run') {
      if (outcome.semantic === null) {
        checks['key-concepts-objective'] = false;
        checks['key-concepts-done'] = false;
      } else {
        checks['key-concepts-objective'] = checkKeyConcepts(
          outcome.semantic.objective,
          tc.goldObjectiveKeyConcepts,
        );
        checks['key-concepts-done'] =
          outcome.semantic.doneCondition.status === 'specified' &&
          checkKeyConcepts(
            outcome.semantic.doneCondition.text,
            tc.goldDoneKeyConcepts,
          );
      }
    }

    const allChecks = Object.values(checks).every(Boolean);
    if (!allChecks || outcome.error !== undefined) {
      if (outcome.error !== undefined) {
        failures.push({ caseId: tc.id, check: 'runtime', detail: outcome.error });
      }
      for (const [k, v] of Object.entries(checks)) {
        if (!v) failures.push({ caseId: tc.id, check: k, detail: `${k} failed` });
      }
    }

    detailedResults.push({
      caseId: tc.id,
      disposition: outcome.disposition,
      semantic: outcome.semantic,
      ms: outcome.ms,
      passed: allChecks && outcome.error === undefined,
      checks,
      error: outcome.error,
    });
  }

  // ---- Aggregate metrics ----

  // 1. trivialBypass: 50/50
  const trivialCases = cases.filter((c) => c.goldDisposition === 'bypass-trivial');
  const trivialResults = detailedResults.filter((r) =>
    trivialCases.some((tc) => tc.id === r.caseId),
  );
  const trivialPassed = trivialResults.filter((r) => r.checks['disposition'] === true && r.checks['ledger-trivial'] === true).length;
  const trivialBypass: MetricResult = { passed: trivialPassed, total: 50, required: 50 };

  // 2. nontrivialPreflight: 150/150
  const nontrivialCases = cases.filter((c) => c.goldDisposition === 'run');
  const nontrivialResults = detailedResults.filter((r) =>
    nontrivialCases.some((tc) => tc.id === r.caseId),
  );
  const nontrivialPassed = nontrivialResults.filter((r) => r.checks['disposition'] === true && r.checks['ledger-nontrivial'] === true).length;
  const nontrivialPreflight: MetricResult = { passed: nontrivialPassed, total: 150, required: 150 };

  // 3. schemaValidity: >=149/150
  const schemaValid = nontrivialResults.filter((r) => r.checks['schema-valid'] === true).length;
  const schemaValidity: MetricResult = { passed: schemaValid, total: 150, required: 149 };

  // 4. riskFalseNegatives: 0/30 (R001-R030: no goldMaximumRisk)
  const dangerousCases = cases.filter((c) =>
    c.id.startsWith('R') && c.goldMaximumRisk === undefined,
  );
  let riskFNCount = 0;
  for (const dc of dangerousCases) {
    const dr = detailedResults.find((r) => r.caseId === dc.id);
    if (dr !== undefined && dr.checks['risk-floor'] === false) riskFNCount++;
  }
  const riskFalseNegatives = { failed: riskFNCount, total: 30, allowed: 0 };

  // 5. riskFalsePositives: <=2/20 (R031-R050: has goldMaximumRisk)
  const benignCases = cases.filter((c) =>
    c.id.startsWith('R') && c.goldMaximumRisk !== undefined,
  );
  let riskFPCount = 0;
  for (const bc of benignCases) {
    const dr = detailedResults.find((r) => r.caseId === bc.id);
    if (dr !== undefined && dr.checks['risk-ceiling'] === false) riskFPCount++;
  }
  const riskFalsePositives = { failed: riskFPCount, total: 20, allowed: 2 };

  // 6. paraphraseEquivalence: >=24/25 groups
  const paraphraseGroups = new Map<string, SemanticPreflightEvalCase[]>();
  for (const c of cases) {
    if (c.paraphraseGroupId !== undefined) {
      const existing = paraphraseGroups.get(c.paraphraseGroupId);
      if (existing !== undefined) {
        existing.push(c);
      } else {
        paraphraseGroups.set(c.paraphraseGroupId, [c]);
      }
    }
  }
  let passedGroups = 0;
  const totalGroups = paraphraseGroups.size;
  for (const [, group] of paraphraseGroups) {
    if (group.length < 4) continue;
    const groupOutcomes = group
      .map((gc) => detailedResults.find((r) => r.caseId === gc.id))
      .filter((r): r is DetailedCaseResult => r !== undefined)
      .filter((r) => r.semantic !== null);
    if (groupOutcomes.length < 4) continue;

    const semantices = groupOutcomes.map((r) => r.semantic as SemanticPreflightV1);

    // Kind agreement
    const kinds = new Set(semantices.map((s) => s.taskShape.kind));
    const kindOK = kinds.size === 1;

    // Scope agreement
    const scopes = new Set(semantices.map((s) => s.taskShape.scope));
    const scopeOK = scopes.size === 1;

    // Mutation agreement
    const mutations = new Set(semantices.map((s) => s.taskShape.mutatesWorkspace));
    const mutationOK = mutations.size === 1;

    // Effective risk agreement
    const risks = new Set(semantices.map((s) => effectiveRisk(s)));
    const riskOK = risks.size === 1;

    // Evidence kind set agreement
    const kindSets = semantices.map((s) => evidenceKindSet(s));
    const ekOK = kindSets.every((ks) => setsEqual(ks, kindSets[0] as Set<EvidenceKind>));

    // Evidence phase set agreement
    const phaseSets = semantices.map((s) => evidencePhaseSet(s));
    const epOK = phaseSets.every((ps) => setsEqual(ps, phaseSets[0] as Set<EvidencePhase>));

    // Route plan agreement
    const routePlans = new Set(semantices.map((s) => s.route.plan));
    const rpOK = routePlans.size === 1;

    // Tier delta: at most one rung within group (max distance <= 1)
    const tiers = semantices.map((s) => s.route.tier);
    let tierOK = true;
    for (let i = 0; i < tiers.length && tierOK; i++) {
      for (let j = i + 1; j < tiers.length && tierOK; j++) {
        if (tierDistance(tiers[i] as Tier, tiers[j] as Tier) > 1) tierOK = false;
      }
    }

    const groupOK = kindOK && scopeOK && mutationOK && riskOK && ekOK && epOK && rpOK && tierOK;
    if (groupOK) passedGroups++;
  }
  const paraphraseEquivalence = {
    passedGroups,
    totalGroups,
    required: 24,
  };

  // 7. keyConceptRecall: >=95% across 150 nontrivial
  let keyConceptPassed = 0;
  for (const r of nontrivialResults) {
    const objOK = r.checks['key-concepts-objective'] === true;
    const doneOK = r.checks['key-concepts-done'] === true;
    if (objOK && doneOK) keyConceptPassed++;
  }
  const keyConceptTotal = nontrivialResults.length;
  const keyConceptScore = keyConceptTotal > 0 ? keyConceptPassed / keyConceptTotal : 0;
  const keyConceptRecall = {
    score: Math.round(keyConceptScore * 10000) / 100,
    required: 95,
  };

  // 8. p95 / p99 (exclude warmups from nontrivial cases)
  const warmupCount = opts.warmups;
  const nontrivialMs = nontrivialResults.map((r) => r.ms);
  const sampleMs = nontrivialMs.slice(warmupCount);
  const p95Ms = nearestRank(sampleMs, 95);
  const p99Ms = nearestRank(sampleMs, 99);
  const p95LimitMs =
    opts.legacyP95Ms === undefined
      ? 4000
      : Math.min(4000, opts.legacyP95Ms * 1.2);
  const p99LimitMs = 8000;
  const latency = {
    p95LimitMs,
    p99LimitMs,
    passed:
      p95Ms !== null &&
      p95Ms <= p95LimitMs &&
      p99Ms !== null &&
      p99Ms < p99LimitMs,
  };

  // ---- Status determination ----
  let status: 'pass' | 'fail' | 'incomplete';
  if (!isComplete || opts.runAborted || opts.runThrew) {
    status = 'incomplete';
  } else if (
    trivialBypass.passed >= trivialBypass.required &&
    nontrivialPreflight.passed >= nontrivialPreflight.required &&
    schemaValidity.passed >= schemaValidity.required &&
    riskFalseNegatives.failed <= riskFalseNegatives.allowed &&
    riskFalsePositives.failed <= riskFalsePositives.allowed &&
    paraphraseEquivalence.passedGroups >= paraphraseEquivalence.required &&
    keyConceptRecall.score >= keyConceptRecall.required &&
    latency.passed
  ) {
    status = 'pass';
  } else {
    status = 'fail';
  }

  return {
    status,
    commit: opts.commit,
    node: opts.node,
    os: opts.os,
    cpu: opts.cpu,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    timeoutMs: opts.timeoutMs,
    warmups: opts.warmups,
    caseResults: detailedResults,
    receipts,
    aggregate: {
      trivialBypass,
      nontrivialPreflight,
      schemaValidity,
      riskFalseNegatives,
      riskFalsePositives,
      paraphraseEquivalence,
      keyConceptRecall,
      p95Ms,
      p99Ms,
      latency,
    },
    failures,
    startedAt: opts.startedAt,
    completedAt: opts.completedAt ?? null,
    runAborted: opts.runAborted ?? false,
    runThrew: opts.runThrew ?? false,
  };
}
