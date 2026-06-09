/**
 * test/unit/tribunal.test.ts — THE RIVAL TRIBUNAL (master-plan PHASE 9, the gated
 * cross-vendor build-off). ZERO live model calls — the candidate runner is faked
 * through OrchestrateDeps; the VerifyPort + WorktreePort are object-literal fakes
 * (NO real git, NO real test exec). Mirrors judgment-poll.test.ts / ensemble.test.ts.
 *
 * Pins the load-bearing properties:
 *   - the tribunal forms ONLY on a genuine ≥2-option buildable fork + ≥2 DISTINCT
 *     vendors (single-vendor → null, never a faked second rival);
 *   - tests CULL: a passing build beats a failing one (reality dominates);
 *   - adjudication NEVER claims a winner without real test verdicts (ambiguous → null);
 *   - DEGRADATION: createWorktree → null ⇒ completed:false + BOTH worktrees torn down
 *     + no fabricated rival;
 *   - worktrees are ALWAYS torn down (the finally-safe teardown).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTribunal,
  buildTribunalPrompt,
  adjudicateTribunal,
  runTribunal,
  type TribunalDecision,
  type TribunalPlan,
  type RivalBuild,
  type Worktree,
  type WorktreePort,
} from '../../src/core/tribunal.ts';
import type {
  VerifyPort,
  CapturedDiff,
  DetectedTestCommand,
  TestRunResult,
} from '../../src/core/verify.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Classification,
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type {
  Provider,
  ProviderRequest,
  ProviderEvent,
  ProviderId,
  Usage,
} from '../../src/providers/port.ts';

const LOW: Classification = { tier: 'ic', risk: 'low', rationale: 'r' };
const HIGH: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };

const DECISION: TribunalDecision = {
  question: 'How should the cache layer be built?',
  options: [
    { id: 'F1:0', label: 'In-process LRU — simplest, no extra service' },
    { id: 'F1:1', label: 'Redis-backed — shared, survives restarts' },
  ],
};

// ===========================================================================
// planTribunal — the structural gate (≥2 vendors + ≥2 buildable options)
// ===========================================================================

describe('planTribunal — cross-vendor-by-construction gate', () => {
  it('forms a head-to-head on a ≥2-option fork with ≥2 distinct vendors', () => {
    const plan = planTribunal({
      decision: DECISION,
      tier: 'ic',
      classification: LOW,
      authenticatedProviders: ['claude', 'codex'],
      task: 'build the cache',
    });
    assert.ok(plan !== null);
    assert.equal(plan.rivals.length, 2);
    assert.deepEqual(
      plan.rivals.map((r) => r.vendor),
      ['claude', 'codex'],
    );
    assert.deepEqual(
      plan.rivals.map((r) => r.optionId),
      ['F1:0', 'F1:1'],
    );
  });

  it('SINGLE-VENDOR → null (no build-off; degrade honestly, never fabricate a rival)', () => {
    assert.equal(
      planTribunal({
        decision: DECISION,
        tier: 'ic',
        classification: LOW,
        authenticatedProviders: ['claude'],
        task: 't',
      }),
      null,
    );
  });

  it('never builds the same vendor twice and calls it a tribunal (dedupes to <2 → null)', () => {
    assert.equal(
      planTribunal({
        decision: DECISION,
        tier: 'ic',
        classification: LOW,
        authenticatedProviders: ['claude', 'claude'],
        task: 't',
      }),
      null,
    );
  });

  it('a fork with <2 buildable options → null (not a real build decision)', () => {
    assert.equal(
      planTribunal({
        decision: { question: 'q', options: [{ id: 'a', label: 'only one' }] },
        tier: 'ic',
        classification: LOW,
        authenticatedProviders: ['claude', 'codex'],
        task: 't',
      }),
      null,
    );
  });

  it('is deterministic for identical inputs', () => {
    const opts = {
      decision: DECISION,
      tier: 'ic' as const,
      classification: LOW,
      authenticatedProviders: ['claude', 'codex'] as const,
      task: 't',
    };
    assert.deepEqual(planTribunal(opts), planTribunal(opts));
  });
});

// ===========================================================================
// buildTribunalPrompt — "build THIS approach as a real diff"
// ===========================================================================

describe('buildTribunalPrompt', () => {
  it('tells the rival to BUILD its assigned approach, names the fork + the task', () => {
    const p = buildTribunalPrompt(DECISION, 'F1:1', 'add caching to the feed');
    assert.match(p, /How should the cache layer be built\?/);
    assert.match(p, /Redis-backed/);
    assert.match(p, /add caching to the feed/);
    assert.match(p, /build/i);
    // It is a head-to-head build, NOT a deliberation.
    assert.match(p, /head-to-head/i);
    // It must NOT show the OTHER option as the assigned approach.
    assert.doesNotMatch(p, /YOUR ASSIGNED APPROACH \(build THIS, in full\):\nIn-process LRU/);
  });
});

// ===========================================================================
// adjudicateTribunal — reality first (tests cull), then cross-critique
// ===========================================================================

function build(
  vendor: ProviderId,
  optionId: string,
  verified: RivalBuild['verified'],
  extra?: Partial<RivalBuild>,
): RivalBuild {
  return {
    vendor,
    optionId,
    worktree: { cwd: `/tmp/${vendor}`, branch: `t-${vendor}` },
    diff: { files: ['a.ts'], patch: 'diff' },
    buildSucceeded: true,
    verified,
    ...extra,
  };
}

describe('adjudicateTribunal — tests cull, no winner without real verdicts', () => {
  it('TESTS CULL: a passing build BEATS a failing one', () => {
    const s = adjudicateTribunal([
      build('claude', 'F1:0', 'passing'),
      build('codex', 'F1:1', 'failing'),
    ]);
    assert.equal(s.chosenVendor, 'claude');
    assert.equal(s.chosenOptionId, 'F1:0');
  });

  it('TESTS CULL: a passing build beats an unverified one', () => {
    const s = adjudicateTribunal([
      build('claude', 'F1:0', 'unverified'),
      build('codex', 'F1:1', 'passing'),
    ]);
    assert.equal(s.chosenVendor, 'codex');
  });

  it('AMBIGUOUS: two greens with no cross-review separation → chosen null', () => {
    const s = adjudicateTribunal([
      build('claude', 'F1:0', 'passing'),
      build('codex', 'F1:1', 'passing'),
    ]);
    assert.equal(s.chosenVendor, null, 'a true tie is never resolved into a fabricated winner');
    assert.equal(s.chosenOptionId, null);
  });

  it('AMBIGUOUS: two UNVERIFIED builds (no real test verdict) → chosen null', () => {
    const s = adjudicateTribunal([
      build('claude', 'F1:0', 'unverified'),
      build('codex', 'F1:1', 'unverified'),
    ]);
    assert.equal(s.chosenVendor, null, 'never a winner without real test verdicts');
  });

  it('CROSS-CRITIQUE breaks a tie ONLY when tests could not (both equally verified)', () => {
    const s = adjudicateTribunal([
      build('claude', 'F1:0', 'passing', {
        crossReview: { reviewer: 'codex', verdict: 'approve', confidence: 0.9 },
      }),
      build('codex', 'F1:1', 'passing', {
        crossReview: { reviewer: 'claude', verdict: 'revise', confidence: 0.6 },
      }),
    ]);
    assert.equal(s.chosenVendor, 'claude', 'approve beats revise among equally-verified builds');
  });

  it('NO builds → chosen null (never a fabricated winner)', () => {
    const s = adjudicateTribunal([]);
    assert.equal(s.chosenVendor, null);
  });

  it('is deterministic for identical inputs', () => {
    const bs = [build('claude', 'F1:0', 'passing'), build('codex', 'F1:1', 'failing')];
    assert.deepEqual(adjudicateTribunal(bs), adjudicateTribunal(bs));
  });
});

// ===========================================================================
// Fakes (mirror judgment-poll.test.ts)
// ===========================================================================

function makeFakeClock(): Clock {
  let now = 1_000_000;
  let n = 0;
  return {
    now: () => (now += 10),
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `fake-uuid-${++n}`,
    random: () => 0.42,
  };
}

function makeFakeSession(id = 'sess-trib-1'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(e: SessionEntry): Promise<void> {
      entries.push(e);
    },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(e: LedgerEntry): Promise<void> {
      entries.push(e);
    },
    entries,
  };
}

const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

/** A provider that "builds" (emits a done) or reviews (emits a review verdict). */
function buildProvider(id: ProviderId, opts?: { reviewVerdict?: string }): Provider {
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // The cross-review prompt asks for a JSON verdict envelope; emit one when this
      // run is a review (heuristic: the prompt contains the review checklist marker).
      const isReview = /verdict.*approve\|revise\|escalate/.test(req.prompt);
      const text = isReview
        ? `Reviewed.\n{"verdict": "${opts?.reviewVerdict ?? 'approve'}", "notes": "n", "confidence": 0.8}`
        : `Built it.`;
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

/** A VerifyPort whose results are SCRIPTED per worktree cwd (no real git/exec). */
function makeFakeVerifyPort(script: Record<string, TestRunResult['outcome']>): VerifyPort {
  return {
    async captureDiff(cwd: string): Promise<CapturedDiff> {
      // Every scripted worktree "produced a diff" so tests run.
      return { files: [`${cwd}/changed.ts`], patch: `diff for ${cwd}` };
    },
    async detectTestCommand(_cwd: string): Promise<DetectedTestCommand | null> {
      return { label: 'npm test', command: 'npm', args: ['test'] };
    },
    async runTests(cwd: string): Promise<TestRunResult> {
      const outcome = script[cwd] ?? 'errored';
      return { outcome, output: `tests for ${cwd}`, durationMs: 10 };
    },
  };
}

/** A WorktreePort fake — NO real git. createWorktree maps a label → a fixed cwd. */
function makeFakeWorktreePort(opts?: {
  failOn?: ProviderId; // return null when creating this rival's worktree
  removed?: Worktree[]; // teardown spy sink
}): WorktreePort {
  const removed = opts?.removed ?? [];
  return {
    async createWorktree(_repoCwd: string, label: string): Promise<Worktree | null> {
      // label is `tribunal-<vendor>`.
      const vendor = label.replace(/^tribunal-/, '') as ProviderId;
      if (opts?.failOn !== undefined && vendor === opts.failOn) return null;
      return { cwd: `/tmp/fake-${vendor}`, branch: `t-${vendor}` };
    },
    async execInWorktree(): Promise<{ exitCode: number | null; output: string }> {
      return { exitCode: 0, output: '' };
    },
    async removeWorktree(_repoCwd: string, wt: Worktree): Promise<void> {
      removed.push(wt);
    },
  };
}

function tribDeps(
  providers: Partial<Record<ProviderId, Provider>>,
  verifyPort: VerifyPort,
  worktreePort: WorktreePort,
): { deps: OrchestrateDeps; ledger: ReturnType<typeof makeFakeLedger> } {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const authed = Object.keys(providers) as ProviderId[];
  return {
    ledger,
    deps: {
      providers,
      clock: makeFakeClock(),
      session,
      ledger,
      policy: { ...DEFAULT_POLICY, maxTier: 'manager' },
      cwd: '/fake-repo',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: authed,
      verifyPort,
      worktreePort,
    },
  };
}

async function drain(
  gen: AsyncGenerator<CoreEvent, unknown>,
): Promise<{ events: CoreEvent[]; ret: unknown }> {
  const events: CoreEvent[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, ret: res.value };
}

const PLAN: TribunalPlan = {
  tier: 'ic',
  rivals: [
    { vendor: 'claude', optionId: 'F1:0' },
    { vendor: 'codex', optionId: 'F1:1' },
  ],
  decision: DECISION,
  classification: HIGH,
  task: 'build the cache layer',
};

// ===========================================================================
// runTribunal — the executor (faked providers + ports, zero live calls)
// ===========================================================================

describe('runTribunal — integration (faked builds + ports, zero live calls)', () => {
  it('TESTS CULL: rival A green, rival B red → A wins; worktrees torn down', async () => {
    const removed: Worktree[] = [];
    const verify = makeFakeVerifyPort({ '/tmp/fake-claude': 'green', '/tmp/fake-codex': 'red' });
    const wtPort = makeFakeWorktreePort({ removed });
    const { deps, ledger } = tribDeps(
      { claude: buildProvider('claude'), codex: buildProvider('codex') },
      verify,
      wtPort,
    );
    const { events, ret } = await drain(runTribunal(deps, PLAN, new AbortController().signal));
    const r = ret as { synthesis: { chosenVendor: string | null }; completed: boolean };
    assert.equal(r.completed, true);
    assert.equal(r.synthesis.chosenVendor, 'claude', 'the green build culls the red one');
    // BOTH worktrees were torn down (the finally-safe teardown).
    assert.equal(removed.length, 2);
    // It never emits a user-facing `final` (the caller owns surfacing).
    assert.ok(!events.some((e) => e.type === 'final'));
    // Build runs are recorded on the ledger.
    assert.ok(ledger.entries.length >= 2);
  });

  it('DEGRADATION: createWorktree → null ⇒ completed:false + teardown + no fabricated rival', async () => {
    const removed: Worktree[] = [];
    const verify = makeFakeVerifyPort({});
    // The SECOND rival's worktree fails to create.
    const wtPort = makeFakeWorktreePort({ failOn: 'codex', removed });
    const { deps } = tribDeps(
      { claude: buildProvider('claude'), codex: buildProvider('codex') },
      verify,
      wtPort,
    );
    const { ret } = await drain(runTribunal(deps, PLAN, new AbortController().signal));
    const r = ret as { synthesis: { chosenVendor: string | null }; completed: boolean };
    assert.equal(r.completed, false, 'a missing worktree degrades, never fabricates a rival');
    assert.equal(r.synthesis.chosenVendor, null);
    // The FIRST worktree (claude's) that DID get created must be torn down.
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.cwd, '/tmp/fake-claude');
  });

  it('AMBIGUOUS: both builds green → completed:true but chosen null (honest)', async () => {
    const verify = makeFakeVerifyPort({ '/tmp/fake-claude': 'green', '/tmp/fake-codex': 'green' });
    const wtPort = makeFakeWorktreePort();
    const { deps } = tribDeps(
      // Both reviews approve → no cross-review separation either.
      { claude: buildProvider('claude', { reviewVerdict: 'approve' }), codex: buildProvider('codex', { reviewVerdict: 'approve' }) },
      verify,
      wtPort,
    );
    const { ret } = await drain(runTribunal(deps, PLAN, new AbortController().signal));
    const r = ret as { synthesis: { chosenVendor: string | null }; completed: boolean };
    assert.equal(r.completed, true);
    assert.equal(r.synthesis.chosenVendor, null, 'two greens with no separation is an honest null');
  });

  it('no worktreePort → completed:false (cannot form)', async () => {
    const verify = makeFakeVerifyPort({});
    const wtPort = makeFakeWorktreePort();
    const { deps } = tribDeps({ claude: buildProvider('claude'), codex: buildProvider('codex') }, verify, wtPort);
    const noPortDeps: OrchestrateDeps = { ...deps, worktreePort: undefined };
    const { ret } = await drain(runTribunal(noPortDeps, PLAN, new AbortController().signal));
    const r = ret as { completed: boolean };
    assert.equal(r.completed, false);
  });
});
