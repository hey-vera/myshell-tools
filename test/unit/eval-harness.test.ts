/**
 * test/unit/eval-harness.test.ts — the eval ruler's LOGIC, with FAKES only.
 *
 * Verifies the Phase-0 harness end to end WITHOUT any live model call: the suite
 * shape, the judge prompt/parser, score aggregation, the run driver (with injected
 * fake answer/judge ports), the scorecard + compare formatting, the cross-vendor
 * judge selection, and the headless answer reducer. The REAL provider calls happen
 * ONLY when the owner runs `myshell eval --yes`; they are never exercised here.
 *
 * Run: node --import ./test/register.mjs --experimental-strip-types --test test/unit/eval-harness.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVAL_SUITE,
  EVAL_DIMENSIONS,
  SUITE_SIZE,
  promptById,
  type EvalPrompt,
} from '../../src/core/eval/suite.ts';
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  JUDGE_ENVELOPE_KEY,
  type JudgeVerdict,
  type DimensionScore,
} from '../../src/core/eval/judge.ts';
import { aggregate, promptMean, type PromptResult } from '../../src/core/eval/score.ts';
import { runEval, type AnswerOutcome, type RunResult } from '../../src/core/eval/harness.ts';
import { captureAnswer } from '../../src/core/eval/answer-runner.ts';
import { pickJudgeProvider } from '../../src/core/eval/judge-runner.ts';
import {
  formatScorecard,
  compareRuns,
  formatComparison,
  type DimensionDelta,
} from '../../src/core/eval/scorecard.ts';
import type { EvalClass } from '../../src/core/eval/suite.ts';
import { parseEvalArgs } from '../../src/commands/eval.ts';
import type { CoreEvent } from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const SIGNAL = new AbortController().signal;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('eval suite — the frozen ruler', () => {
  it('has ~20 prompts and SUITE_SIZE matches', () => {
    assert.equal(EVAL_SUITE.length, SUITE_SIZE);
    assert.ok(SUITE_SIZE >= 18 && SUITE_SIZE <= 24, `expected ~20 prompts, got ${SUITE_SIZE}`);
  });

  it('every prompt has a unique id, a non-empty prompt, and ≥1 declared dimension', () => {
    const ids = new Set<string>();
    for (const p of EVAL_SUITE) {
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
      assert.ok(p.prompt.trim().length > 0, `${p.id} has empty prompt`);
      assert.ok(p.dimensions.length > 0, `${p.id} declares no dimensions`);
      for (const d of p.dimensions) assert.ok(EVAL_DIMENSIONS.includes(d), `${p.id} bad dim ${d}`);
    }
  });

  it('spans the partner range: trivial, ambiguous, build, explain, investigate, irreversible, multi-part, plan', () => {
    const classes = new Set(EVAL_SUITE.map((p) => p.class));
    for (const c of [
      'trivial',
      'ambiguous',
      'build',
      'explain',
      'investigate',
      'irreversible',
      'multi-part',
      'plan',
    ] as const) {
      assert.ok(classes.has(c), `suite is missing a ${c} prompt`);
    }
  });

  it('marks trivial prompts expectInstant, code prompts expectsCode, risky prompts expectsCaution', () => {
    assert.ok(EVAL_SUITE.some((p) => p.expectInstant === true));
    assert.ok(EVAL_SUITE.some((p) => p.expectsCode === true));
    assert.ok(EVAL_SUITE.some((p) => p.expectsCaution === true));
  });

  it('promptById resolves a known id and returns undefined for an unknown id', () => {
    assert.ok(promptById(EVAL_SUITE[0]!.id) !== undefined);
    assert.equal(promptById('no-such-id'), undefined);
  });

  it('every prompt class is one of the known EvalClass values', () => {
    const known: readonly EvalClass[] = [
      'trivial', 'factual', 'ambiguous', 'build', 'explain',
      'investigate', 'irreversible', 'multi-part', 'plan',
    ];
    for (const p of EVAL_SUITE) {
      const cls: EvalClass = p.class;
      assert.ok(known.includes(cls), `${p.id} has unknown class ${cls}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Judge prompt + parser
// ---------------------------------------------------------------------------

const samplePrompt: EvalPrompt = {
  id: 'sample',
  class: 'factual',
  prompt: 'q?',
  tests: 't',
  dimensions: ['correctness', 'honesty'],
};

function verdictJson(scores: Array<{ dimension: string; score: number }>): string {
  return JSON.stringify({
    [JUDGE_ENVELOPE_KEY]: {
      summary: 's',
      scores: scores.map((s) => ({ ...s, reason: 'r' })),
    },
  });
}

describe('eval judge — prompt + fail-soft parser', () => {
  it('builds a judge prompt that includes the answer, the rubric for each declared dim, and the envelope key', () => {
    const p = buildJudgePrompt(samplePrompt, 'THE ANSWER');
    assert.match(p, /THE ANSWER/);
    assert.match(p, /correctness/);
    assert.match(p, /honesty/);
    assert.match(p, new RegExp(JUDGE_ENVELOPE_KEY));
  });

  it('parses a well-formed verdict and clamps/rounds scores into 0..10 integers', () => {
    const text =
      'noise ' + verdictJson([
        { dimension: 'correctness', score: 11 }, // → clamped to 10
        { dimension: 'honesty', score: 7.6 }, // → rounded to 8
      ]);
    const v = parseJudgeVerdict(samplePrompt, text);
    assert.ok(v !== null);
    const correctness: DimensionScore = v!.scores.find((s) => s.dimension === 'correctness')!;
    assert.equal(correctness.score, 10);
    assert.equal(v!.scores.find((s) => s.dimension === 'honesty')!.score, 8);
  });

  it('returns null (never a fabricated score) when a declared dimension is missing', () => {
    const text = verdictJson([{ dimension: 'correctness', score: 9 }]); // honesty missing
    assert.equal(parseJudgeVerdict(samplePrompt, text), null);
  });

  it('returns null on no JSON, on non-numeric score, and on undefined text', () => {
    assert.equal(parseJudgeVerdict(samplePrompt, 'just prose, no json'), null);
    assert.equal(
      parseJudgeVerdict(
        samplePrompt,
        verdictJson([
          { dimension: 'correctness', score: NaN as unknown as number },
          { dimension: 'honesty', score: 5 },
        ]),
      ),
      null,
    );
    assert.equal(parseJudgeVerdict(samplePrompt, undefined), null);
  });
});

// ---------------------------------------------------------------------------
// Score aggregation
// ---------------------------------------------------------------------------

function judged(id: string, dims: Array<[string, number]>): PromptResult {
  const verdict: JudgeVerdict = {
    promptId: id,
    summary: '',
    scores: dims.map(([dimension, score]) => ({ dimension: dimension as never, score, reason: '' })),
  };
  return { promptId: id, class: 'factual', judged: true, verdict, mean: promptMean(verdict) };
}

describe('eval score — honest aggregation', () => {
  it('aggregate is the mean of each judged prompt mean; unjudged are excluded from math', () => {
    const results: PromptResult[] = [
      judged('a', [['correctness', 8], ['honesty', 10]]), // mean 9
      judged('b', [['correctness', 6], ['honesty', 4]]), // mean 5
      { promptId: 'c', class: 'factual', judged: false, mean: null, note: 'judge unavailable' },
    ];
    const sc = aggregate(results);
    assert.equal(sc.aggregate, 7); // (9 + 5) / 2 — 'c' excluded, NOT counted as 0
    assert.equal(sc.judgedCount, 2);
    assert.equal(sc.totalCount, 3);
  });

  it('per-dimension averages only over prompts that scored that dimension', () => {
    const results: PromptResult[] = [
      judged('a', [['correctness', 8]]),
      judged('b', [['correctness', 4], ['honesty', 10]]),
    ];
    const sc = aggregate(results);
    assert.equal(sc.byDimension.correctness, 6); // (8 + 4)/2
    assert.equal(sc.byDimension.honesty, 10); // only b
    assert.equal(sc.byDimension.judgment, null); // nobody scored it → null, not 0
  });

  it('all-unjudged input yields a null aggregate (no data ≠ scored zero)', () => {
    const sc = aggregate([
      { promptId: 'a', class: 'x', judged: false, mean: null },
      { promptId: 'b', class: 'x', judged: false, mean: null },
    ]);
    assert.equal(sc.aggregate, null);
    assert.equal(sc.judgedCount, 0);
  });

  it('empty input does not throw and yields a null aggregate', () => {
    const sc = aggregate([]);
    assert.equal(sc.aggregate, null);
    assert.equal(sc.totalCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Run driver (fakes)
// ---------------------------------------------------------------------------

const META = {
  timestamp: '2026-06-09T00:00:00.000Z',
  version: '9.9.9',
  provenance: { answerProvider: 'claude', judgeProvider: 'codex' },
};

const miniSuite: readonly EvalPrompt[] = [
  { id: 'p1', class: 'trivial', prompt: 'hi', tests: 't', dimensions: ['correctness'], expectInstant: true },
  { id: 'p2', class: 'factual', prompt: 'q?', tests: 't', dimensions: ['correctness', 'honesty'] },
];

function okAnswer(): AnswerOutcome {
  return { answer: 'an answer', success: true, instant: true };
}

describe('eval runEval — driver over injected ports (no live calls)', () => {
  it('runs the full suite, judging each answered prompt, and aggregates', async () => {
    const run = await runEval(
      async () => okAnswer(),
      async (p) => ({
        promptId: p.id,
        summary: '',
        scores: p.dimensions.map((d) => ({ dimension: d, score: 8, reason: '' })),
      }),
      SIGNAL,
      META,
      undefined,
      miniSuite,
    );
    assert.equal(run.scorecard.totalCount, 2);
    assert.equal(run.scorecard.judgedCount, 2);
    assert.equal(run.scorecard.aggregate, 8);
    assert.equal(run.provenance.judgeProvider, 'codex');
  });

  it('records a prompt UNJUDGED (never fabricated) when the judge returns null', async () => {
    const run = await runEval(
      async () => okAnswer(),
      async () => null, // judge unavailable
      SIGNAL,
      META,
      undefined,
      miniSuite,
    );
    assert.equal(run.scorecard.judgedCount, 0);
    assert.equal(run.scorecard.aggregate, null);
    assert.ok(run.scorecard.prompts.every((p) => !p.judged));
  });

  it('records a prompt unjudged with a note when the answer port produces no answer', async () => {
    const run = await runEval(
      async () => ({ answer: undefined, success: false, note: 'run failed (rate_limit)' }),
      async () => {
        throw new Error('should not be called when there is no answer');
      },
      SIGNAL,
      META,
      undefined,
      miniSuite,
    );
    assert.equal(run.scorecard.judgedCount, 0);
    assert.match(run.scorecard.prompts[0]!.note!, /rate_limit/);
  });

  it('a thrown answer port is caught and recorded honestly, not crashed', async () => {
    const run = await runEval(
      async () => {
        throw new Error('boom');
      },
      async () => null,
      SIGNAL,
      META,
      undefined,
      miniSuite,
    );
    assert.match(run.scorecard.prompts[0]!.note!, /run error/);
  });

  it('an already-aborted signal records all prompts as aborted, unjudged', async () => {
    const ac = new AbortController();
    ac.abort();
    const run = await runEval(async () => okAnswer(), async () => null, ac.signal, META, undefined, miniSuite);
    assert.equal(run.scorecard.judgedCount, 0);
    assert.ok(run.scorecard.prompts.every((p) => p.note === 'aborted before run'));
  });

  it('captures the instant objective check for an expectInstant prompt', async () => {
    const run = await runEval(
      async (p) => ({ answer: 'a', success: true, instant: p.id === 'p1' ? false : true }),
      async (p) => ({
        promptId: p.id,
        summary: '',
        scores: p.dimensions.map((d) => ({ dimension: d, score: 5, reason: '' })),
      }),
      SIGNAL,
      META,
      undefined,
      miniSuite,
    );
    const p1 = run.scorecard.prompts.find((p) => p.promptId === 'p1');
    assert.equal(p1!.objective?.instantExpected, true);
    assert.equal(p1!.objective?.instantActual, false); // observed not-instant, recorded honestly
  });
});

// ---------------------------------------------------------------------------
// Headless answer reducer
// ---------------------------------------------------------------------------

async function* evs(...e: CoreEvent[]): AsyncGenerator<CoreEvent> {
  for (const ev of e) yield ev;
}

const FINAL_BASE = {
  type: 'final' as const,
  tier: 'ic' as const,
  totalCostUsd: 0,
  sessionId: 's',
};

describe('eval captureAnswer — headless reducer over the real CoreEvent stream', () => {
  it('reads the final output and marks an instant (1 attempt, no escalation) turn', async () => {
    const out = await captureAnswer(
      evs({ ...FINAL_BASE, success: true, output: 'hello', attempts: 1 }),
    );
    assert.equal(out.answer, 'hello');
    assert.equal(out.success, true);
    assert.equal(out.instant, true);
  });

  it('marks NOT instant when the turn escalated', async () => {
    const out = await captureAnswer(
      evs(
        { type: 'escalate', from: 'ic', to: 'manager', reason: 'low conf' },
        { ...FINAL_BASE, success: true, output: 'x', attempts: 2 },
      ),
    );
    assert.equal(out.instant, false);
  });

  it('a failing final yields no answer and an honest note', async () => {
    const out = await captureAnswer(
      evs({ ...FINAL_BASE, success: false, output: '', attempts: 1, errorCategory: 'rate_limit' }),
    );
    assert.equal(out.answer, undefined);
    assert.equal(out.success, false);
    assert.match(out.note!, /rate_limit/);
  });
});

// ---------------------------------------------------------------------------
// Cross-vendor judge selection
// ---------------------------------------------------------------------------

function fakeProvider(id: 'claude' | 'codex' | 'opencode'): Provider {
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: '1',
        authenticated: true,
        plan: null,
        binaryPath: null,
        availableModels: [],
      };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      yield { type: 'done', text: '', raw: null };
    },
  };
}

describe('eval judge selection — cross-vendor for honesty', () => {
  const base = {
    policy: undefined as never,
    cwd: '/tmp',
    timeoutMs: 1000,
  };

  it('prefers a DIFFERENT signed-in vendor than the one that answered', () => {
    const got = pickJudgeProvider({
      ...base,
      providers: { claude: fakeProvider('claude'), codex: fakeProvider('codex') },
      answerProvider: 'claude',
      authenticatedProviders: ['claude', 'codex'],
    });
    assert.equal(got, 'codex');
  });

  it('falls back to the answer vendor when no other vendor is signed in (still a real call)', () => {
    const got = pickJudgeProvider({
      ...base,
      providers: { claude: fakeProvider('claude') },
      answerProvider: 'claude',
      authenticatedProviders: ['claude'],
    });
    assert.equal(got, 'claude');
  });

  it('returns null when there is no provider at all', () => {
    const got = pickJudgeProvider({
      ...base,
      providers: {},
      answerProvider: 'claude',
      authenticatedProviders: [],
    });
    assert.equal(got, null);
  });
});

// ---------------------------------------------------------------------------
// Scorecard + compare formatting
// ---------------------------------------------------------------------------

function runWith(aggregate: number, dim: number, ts: string): RunResult {
  const prompts: PromptResult[] = [judged('a', [['correctness', dim], ['honesty', dim]])];
  // Force the aggregate/byDimension we want for a deterministic format test.
  return {
    timestamp: ts,
    version: '1.0.0',
    provenance: { answerProvider: 'claude', judgeProvider: 'codex' },
    scorecard: {
      aggregate,
      byDimension: {
        understanding: null,
        judgment: null,
        clarity: null,
        proactivity: null,
        correctness: dim,
        honesty: dim,
        conciseness: null,
      },
      prompts,
      judgedCount: 1,
      totalCount: 1,
    },
  };
}

describe('eval scorecard — formatting + compare', () => {
  it('formats aggregate, provenance, and renders null dimensions as n/a (not 0.0)', () => {
    const lines = formatScorecard(runWith(7.5, 8, META.timestamp)).join('\n');
    assert.match(lines, /AGGREGATE: 7\.5 \/ 10/);
    assert.match(lines, /answered by: claude/);
    assert.match(lines, /judged by: codex/);
    assert.match(lines, /understanding\s+n\/a/); // null → n/a, distinct from 0.0
  });

  it('compareRuns + formatComparison show the before→after delta with a sign', () => {
    const before = runWith(4, 4, '2026-06-08T00:00:00.000Z');
    const after = runWith(8, 8, '2026-06-09T00:00:00.000Z');
    const cmp = compareRuns(before, after);
    assert.equal(cmp.aggregateDelta, 4);
    const correctnessDelta: DimensionDelta = cmp.byDimension.find((d) => d.dimension === 'correctness')!;
    assert.equal(correctnessDelta.delta, 4);
    const lines = formatComparison(cmp).join('\n');
    assert.match(lines, /AGGREGATE: 4\.0 → 8\.0 {2}\(\+4\.0\)/);
    assert.match(lines, /correctness\s+4\.0 → 8\.0 {2}\(\+4\.0\)/);
  });

  it('a null delta (no data on a side) renders n/a, never a fabricated movement', () => {
    const before = runWith(5, 5, 't1');
    const after: RunResult = {
      ...runWith(5, 5, 't2'),
      scorecard: { ...runWith(5, 5, 't2').scorecard, aggregate: null },
    };
    const cmp = compareRuns(before, after);
    assert.equal(cmp.aggregateDelta, null);
    assert.match(formatComparison(cmp).join('\n'), /\(n\/a\)/);
  });
});

// ---------------------------------------------------------------------------
// Command arg parsing
// ---------------------------------------------------------------------------

describe('eval command — arg parsing + opt-in gate', () => {
  it('parses --compare, --yes, and -y', () => {
    assert.deepEqual(parseEvalArgs(['--compare']), { compare: true, yes: false });
    assert.deepEqual(parseEvalArgs(['--yes']), { compare: false, yes: true });
    assert.deepEqual(parseEvalArgs(['-y']), { compare: false, yes: true });
    assert.deepEqual(parseEvalArgs([]), { compare: false, yes: false });
  });
});
