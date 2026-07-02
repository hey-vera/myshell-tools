/**
 * test/unit/judgment-tribunal-call-budget.test.ts — P1-09f judgment and tribunal
 * call-budget ledger tests.
 *
 * Observe-only: verifies that the TurnCallBudget ledger faithfully records
 * judgment candidate calls and tribunal build/cross-review calls without
 * changing adjudication, winner, cost, or admission decisions.
 *
 * Judgment: candidates pass purpose 'judgment' / bucket 'discretionary'.
 * Tribunal: builds pass 'tribunal-build' / 'work'; cross-reviews pass
 * 'tribunal-review' / 'verification'.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  createTurnCallBudget,
  type TurnCallBudget,
  type TurnCallBudgetMode,
  type TurnCallBudgetSpec,
  type TurnCallBudgetReceipt,
} from '../../src/core/turn-call-budget.ts';
import {
  runJudgmentPoll,
  type JudgmentDecision,
  type JudgmentPollPlan,
} from '../../src/core/judgment-poll.ts';
import {
  runTribunal,
  type TribunalDecision,
  type TribunalPlan,
  type Worktree,
  type WorktreePort,
} from '../../src/core/tribunal.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  VerifyPort,
  CapturedDiff,
  DetectedTestCommand,
  TestRunResult,
} from '../../src/core/verify.ts';
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function budgetSpec(
  overrides: Partial<{
    turnId: string;
    mode: TurnCallBudgetMode;
    totalUnits: number;
    reservedWork: number;
    reservedFailover: number;
    reservedVerification: number;
  }> = {},
): TurnCallBudgetSpec {
  return {
    turnId: overrides.turnId ?? 'turn-1',
    mode: overrides.mode ?? 'observe',
    totalUnits: overrides.totalUnits ?? 10,
    reserved: {
      work: overrides.reservedWork ?? 1,
      failover: (overrides.reservedFailover ?? 0) as 0 | 1,
      verification: (overrides.reservedVerification ?? 0) as 0 | 1,
    },
  };
}

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

function makeFakeSession(id = 'sess-budget-1'): SessionWriter & { entries: SessionEntry[] } {
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

function snapshotEvents(receipt: TurnCallBudgetReceipt) {
  return {
    begun: receipt.begun,
    settled: receipt.settled,
    denied: receipt.denied,
    events: receipt.events,
  };
}

const USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

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

// ---------------------------------------------------------------------------
// Judgment fixtures
// ---------------------------------------------------------------------------

const HIGH: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };

const DECISION: JudgmentDecision = {
  question: 'How should the feed load data?',
  options: [
    { id: 'F1:0', label: 'Server-Component streaming' },
    { id: 'F1:1', label: 'Client-side fetch' },
  ],
};

const JUDGMENT_PLAN: JudgmentPollPlan = {
  tier: 'ic',
  candidates: ['claude', 'codex'],
  decision: DECISION,
  classification: HIGH,
};

function judgProvider(id: ProviderId, choice: string, opts?: { error?: boolean; gate?: Promise<void> }): Provider {
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(_req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (opts?.gate !== undefined) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          void opts.gate!.then(done);
          if (signal.aborted) done();
          else signal.addEventListener('abort', done, { once: true });
        });
      }
      if (signal.aborted) return;
      if (opts?.error === true) {
        yield { type: 'error', error: { category: 'network', recoverable: true, message: 'boom', suggestion: 'retry' } };
        return;
      }
      const text = `My call.\n{"choice": "${choice}", "confidence": 0.7, "why": "w", "key_risk": "r"}`;
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

function judgDeps(
  providers: Partial<Record<ProviderId, Provider>>,
  budget?: TurnCallBudget,
): {
  deps: OrchestrateDeps;
  ledger: ReturnType<typeof makeFakeLedger>;
  session: ReturnType<typeof makeFakeSession>;
  budget: TurnCallBudget | undefined;
} {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const authed = Object.keys(providers) as ProviderId[];
  return {
    session,
    ledger,
    budget,
    deps: {
      providers,
      clock: makeFakeClock(),
      session,
      ledger,
      policy: { ...DEFAULT_POLICY, maxTier: 'manager' },
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: authed,
      ...(budget !== undefined ? { turnCallBudget: budget } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tribunal fixtures
// ---------------------------------------------------------------------------

const TRIBUNAL_DECISION: TribunalDecision = {
  question: 'How should the cache layer be built?',
  options: [
    { id: 'F1:0', label: 'In-process LRU' },
    { id: 'F1:1', label: 'Redis-backed' },
  ],
};

const TRIBUNAL_PLAN: TribunalPlan = {
  tier: 'ic',
  rivals: [
    { vendor: 'claude', optionId: 'F1:0' },
    { vendor: 'codex', optionId: 'F1:1' },
  ],
  decision: TRIBUNAL_DECISION,
  classification: HIGH,
  task: 'build the cache layer',
};

function buildProvider(id: ProviderId, opts?: { gate?: Promise<void> }): Provider {
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (opts?.gate !== undefined) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          void opts.gate!.then(done);
          if (signal.aborted) done();
          else signal.addEventListener('abort', done, { once: true });
        });
      }
      if (signal.aborted) return;
      const isReview = /verdict.*approve\|revise\|escalate/.test(req.prompt);
      const text = isReview
        ? 'Reviewed.\n{"verdict": "approve", "notes": "n", "confidence": 0.8}'
        : 'Built it.';
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

function makeFakeVerifyPort(): VerifyPort {
  return {
    async captureDiff(cwd: string): Promise<CapturedDiff> {
      return { files: [`${cwd}/changed.ts`], patch: `diff for ${cwd}` };
    },
    async detectTestCommand(): Promise<DetectedTestCommand | null> {
      return { label: 'npm test', command: 'npm', args: ['test'] };
    },
    async runTests(cwd: string): Promise<TestRunResult> {
      return { outcome: 'green', output: `tests for ${cwd}`, durationMs: 10 };
    },
  };
}

function makeFakeWorktreePort(): WorktreePort {
  return {
    async createWorktree(_repoCwd: string, label: string): Promise<Worktree | null> {
      const vendor = label.replace(/^tribunal-/, '') as ProviderId;
      return { cwd: `/tmp/fake-${vendor}`, branch: `t-${vendor}` };
    },
    async execInWorktree(): Promise<{ exitCode: number | null; output: string }> {
      return { exitCode: 0, output: '' };
    },
    async removeWorktree(): Promise<void> {
      // no-op
    },
  };
}

function tribDeps(
  providers: Partial<Record<ProviderId, Provider>>,
  budget?: TurnCallBudget,
): {
  deps: OrchestrateDeps;
  ledger: ReturnType<typeof makeFakeLedger>;
  budget: TurnCallBudget | undefined;
} {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const authed = Object.keys(providers) as ProviderId[];
  return {
    ledger,
    budget,
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
      verifyPort: makeFakeVerifyPort(),
      worktreePort: makeFakeWorktreePort(),
      ...(budget !== undefined ? { turnCallBudget: budget } : {}),
    },
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('judgment-tribunal call budget', () => {
  // -------------------------------------------------------------------------
  // 1. judgment counts candidates and no synthesizer
  // -------------------------------------------------------------------------
  it('judgment counts candidates and no synthesizer', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(2);

    const { deps } = judgDeps(
      {
        claude: judgProvider('claude', 'F1:0'),
        codex: judgProvider('codex', 'F1:0'),
      },
      budget,
    );

    const { ret } = await drain(runJudgmentPoll(deps, JUDGMENT_PLAN, new AbortController().signal));
    const r = ret as { synthesis: { agreement: string; chosen: string | null }; completed: boolean };
    assert.equal(r.completed, true);
    assert.equal(r.synthesis.agreement, 'consensus');

    const snap = snapshotEvents(budget.snapshot());
    assert.equal(snap.begun, 2, 'two judgment candidates counted');
    assert.equal(snap.settled, 2, 'both settled');

    // No synthesis purpose — judgment has no model-synthesis pass.
    const synthesisEvents = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'panel-synthesis',
    );
    assert.equal(synthesisEvents.length, 0, 'no synthesizer call for judgment poll');

    const judgEvents = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'judgment',
    );
    assert.equal(judgEvents.length, 2, 'two judgment-purpose calls');
    assert.ok(
      judgEvents.every((e) => e.type === 'call-begun' && e.bucket === 'discretionary'),
      'judgment candidates use discretionary bucket',
    );
  });

  // -------------------------------------------------------------------------
  // 2. judgment parse failure remains an attempted call
  // -------------------------------------------------------------------------
  it('judgment parse failure remains an attempted call', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(2);

    const { deps } = judgDeps(
      {
        claude: judgProvider('claude', 'F1:0'),
        codex: judgProvider('codex', 'F1:1', { error: true }),
      },
      budget,
    );

    const { ret } = await drain(runJudgmentPoll(deps, JUDGMENT_PLAN, new AbortController().signal));
    const r = ret as { synthesis: { verdicts: unknown[]; agreement: string }; completed: boolean };
    assert.equal(r.completed, true);
    // Only one parseable verdict.
    assert.equal(r.synthesis.verdicts.length, 1);
    assert.equal(r.synthesis.agreement, 'lean');

    const snap = snapshotEvents(budget.snapshot());
    // Both candidates attempted — the errored one is still one attempted call.
    assert.equal(snap.begun, 2, 'error candidate still counts as one attempted call');
    assert.equal(snap.settled, 2, 'both settled (error is provider-error outcome)');
  });

  // -------------------------------------------------------------------------
  // 3. tribunal counts builds and cross-reviews but not tests or worktrees
  // -------------------------------------------------------------------------
  it('tribunal counts builds and cross-reviews but not tests or worktrees', async () => {
    const budget = createTurnCallBudget(
      budgetSpec({ totalUnits: 10, reservedVerification: 1 }),
    );
    budget.finalizeWorkReservation(2);

    const { deps } = tribDeps(
      {
        claude: buildProvider('claude'),
        codex: buildProvider('codex'),
      },
      budget,
    );

    const { ret } = await drain(
      runTribunal(deps, TRIBUNAL_PLAN, new AbortController().signal),
    );
    const r = ret as { synthesis: { chosenVendor: string | null }; completed: boolean };
    assert.equal(r.completed, true);

    const snap = snapshotEvents(budget.snapshot());
    // 2 builds + 2 cross-reviews = 4 model calls. Tests + worktree ops = 0.
    assert.equal(snap.begun, 4, '2 builds + 2 cross-reviews = 4; tests/worktrees consume zero');

    const buildEvents = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'tribunal-build',
    );
    const reviewEvents = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'tribunal-review',
    );

    assert.equal(buildEvents.length, 2, 'two tribunal-build calls');
    assert.equal(reviewEvents.length, 2, 'two tribunal-review calls');

    assert.ok(
      buildEvents.every((e) => e.type === 'call-begun' && e.bucket === 'work'),
      'tribunal builds use work bucket',
    );
    assert.ok(
      reviewEvents.every((e) => e.type === 'call-begun' && e.bucket === 'verification'),
      'tribunal reviews use verification bucket',
    );

    // No unexpected call purposes in the ledger.
    const begunPurposes: string[] = [];
    for (const e of snap.events) {
      if (e.type === 'call-begun') begunPurposes.push(e.purpose);
    }
    const validPurposes: string[] = ['tribunal-build', 'tribunal-review'];
    assert.ok(
      begunPurposes.every((p) => validPurposes.includes(p)),
      `all call-begun purposes are tribunal-build or tribunal-review, got: ${begunPurposes.join(', ')}`,
    );
  });

  // -------------------------------------------------------------------------
  // 4. tribunal cleanup after abort preserves attempted calls
  // -------------------------------------------------------------------------
  it('tribunal cleanup after abort preserves attempted calls', async () => {
    const budget = createTurnCallBudget(
      budgetSpec({ totalUnits: 10, reservedVerification: 1 }),
    );
    budget.finalizeWorkReservation(2);

    // Gate both providers — they won't emit until resolved (which we never do).
    const gateClaude: {
      promise: Promise<void>;
      resolve: () => void;
    } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    const gateCodex: {
      promise: Promise<void>;
      resolve: () => void;
    } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();

    const { deps } = tribDeps(
      {
        claude: buildProvider('claude', { gate: gateClaude.promise }),
        codex: buildProvider('codex', { gate: gateCodex.promise }),
      },
      budget,
    );

    const ac = new AbortController();
    const runPromise = drain(runTribunal(deps, TRIBUNAL_PLAN, ac.signal));

    // Give the async work a chance to start the builds.
    await new Promise((r) => setTimeout(r, 50));

    // Abort mid-stream: the builds were already begun (budget.begin is sync).
    ac.abort();

    // Release the gates so the aborted providers settle.
    gateClaude.resolve();
    gateCodex.resolve();

    const { ret } = await runPromise;
    const r = ret as { completed: boolean };
    assert.equal(r.completed, false, 'aborted tribunal is not completed');

    const snap = snapshotEvents(budget.snapshot());
    // Both builds were begun before cross-reviews could start.
    assert.ok(snap.begun >= 2, 'both builds were attempted');
    assert.equal(
      snap.events.filter((e) => e.type === 'call-begun' && e.purpose === 'tribunal-build').length,
      2,
      'two tribunal-build calls visible after abort',
    );
    // Cross-reviews should not have run.
    assert.equal(
      snap.events.filter((e) => e.type === 'call-begun' && e.purpose === 'tribunal-review').length,
      0,
      'cross-reviews never started after abort',
    );
  });

  // -------------------------------------------------------------------------
  // 5. observe would-deny does not change adjudication
  // -------------------------------------------------------------------------
  it('observe would-deny does not change adjudication', async () => {
    // --- Run WITHOUT a budget ---
    const { deps: noBudgetDeps } = judgDeps({
      claude: judgProvider('claude', 'F1:0'),
      codex: judgProvider('codex', 'F1:1'),
    });

    const { ret: noBudgetRet } = await drain(
      runJudgmentPoll(noBudgetDeps, JUDGMENT_PLAN, new AbortController().signal),
    );
    const noBudgetR = noBudgetRet as {
      synthesis: { agreement: string; chosen: string | null };
      completed: boolean;
    };
    assert.equal(noBudgetR.completed, true);

    // --- Run WITH an insufficient observe budget ---
    // work reservation = 0, so candidate calls would be denied in enforce mode.
    const budget = createTurnCallBudget(
      budgetSpec({ totalUnits: 1 }),
    );
    // With work=1 and totalUnits=1, discretionary=0 — both judgment candidates
    // would be denied in enforce mode. Observe mode records would-deny but
    // admits them anyway. Adjudication must be unchanged.

    const { deps: budgetDeps } = judgDeps(
      {
        claude: judgProvider('claude', 'F1:0'),
        codex: judgProvider('codex', 'F1:1'),
      },
      budget,
    );

    const { ret: budgetRet } = await drain(
      runJudgmentPoll(budgetDeps, JUDGMENT_PLAN, new AbortController().signal),
    );
    const budgetR = budgetRet as {
      synthesis: { agreement: string; chosen: string | null };
      completed: boolean;
    };
    assert.equal(budgetR.completed, true);

    // Adjudication must be identical — observe mode does not change the outcome.
    assert.equal(
      budgetR.synthesis.agreement,
      noBudgetR.synthesis.agreement,
      'observe mode preserves agreement',
    );
    assert.equal(
      budgetR.synthesis.chosen,
      noBudgetR.synthesis.chosen,
      'observe mode preserves chosen',
    );

    // The budget records would-deny events since work reservation was 0.
    const snap = snapshotEvents(budget.snapshot());
    assert.ok(snap.begun >= 2, 'observe still admits calls');
    const wouldDenyEvents = snap.events.filter((e) => e.type === 'call-would-deny');
    assert.ok(wouldDenyEvents.length >= 2, 'would-deny events recorded');
  });
});
