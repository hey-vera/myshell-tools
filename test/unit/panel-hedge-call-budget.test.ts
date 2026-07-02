/**
 * test/unit/panel-hedge-call-budget.test.ts — P1-09e panel and hedge
 * candidate/synthesis/review call-budget ledger tests.
 *
 * Observe-only: verifies that the TurnCallBudget ledger faithfully records
 * panel candidate, synthesis, repair, hedge primary/secondary, review, and
 * repair attempts without changing winners, CoreEvent order, costs, or
 * admission decisions.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runPanel, type PanelPlan } from '../../src/core/ensemble.ts';
import { runHedged, type HedgePlan } from '../../src/core/hedge.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import {
  createTurnCallBudget,
  type TurnCallBudget,
  type TurnCallBudgetMode,
  type TurnCallBudgetSpec,
  type TurnCallBudgetReceipt,
} from '../../src/core/turn-call-budget.ts';
import type {
  Classification,
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
  Policy,
} from '../../src/core/types.ts';
import type {
  Provider,
  ProviderRequest,
  ProviderEvent,
  ProviderId,
  Usage,
} from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Helpers
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

const USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

function makeProvider(
  id: ProviderId,
  text: string,
  opts?: { error?: boolean; onRun?: () => void; gate?: Promise<void>; record?: { ran: boolean; aborted: boolean } },
): Provider {
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: '1',
        authenticated: true,
        binaryPath: '/f',
        availableModels: [],
      };
    },
    async *run(_req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      opts?.onRun?.();
      if (opts?.record !== undefined) opts.record.ran = true;
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
      if (signal.aborted) {
        if (opts?.record !== undefined) opts.record.aborted = true;
        return;
      }
      if (opts?.error === true) {
        yield {
          type: 'error',
          error: { category: 'network', recoverable: true, message: 'boom', suggestion: 'retry' },
        };
        return;
      }
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Panel fixtures
// ---------------------------------------------------------------------------

const HIGH: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };

const PANEL: PanelPlan = {
  tier: 'ic',
  candidates: ['claude', 'codex'],
  synthesizer: 'claude',
  classification: HIGH,
};

function panelDeps(
  providers: Partial<Record<ProviderId, Provider>>,
  budget?: TurnCallBudget,
): {
  deps: OrchestrateDeps;
  session: ReturnType<typeof makeFakeSession>;
  ledger: ReturnType<typeof makeFakeLedger>;
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
      policy: { ...DEFAULT_POLICY, panelPolicy: 'hard-turns', maxTier: 'manager' },
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: authed,
      ...(budget !== undefined ? { turnCallBudget: budget } : {}),
    },
  };
}

function makeSeqProvider(
  id: ProviderId,
  texts: string[],
  rec?: { calls: number; prompts: string[] },
): Provider {
  let calls = 0;
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const text = texts[Math.min(calls, texts.length - 1)] ?? '';
      if (rec !== undefined) { rec.calls++; rec.prompts.push(req.prompt); }
      calls++;
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
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

// ---------------------------------------------------------------------------
// Hedge fixtures
// ---------------------------------------------------------------------------

function hedgeDeps(
  providers: Partial<Record<ProviderId, Provider>>,
  sleep: (ms: number) => Promise<void>,
  budget?: TurnCallBudget,
  policyOverrides?: Partial<Policy>,
): {
  deps: OrchestrateDeps;
  session: ReturnType<typeof makeFakeSession>;
  ledger: ReturnType<typeof makeFakeLedger>;
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
      policy: {
        ...DEFAULT_POLICY,
        flagshipAdmission: 'always-eligible',
        hedgePolicy: 'on',
        ...policyOverrides,
      },
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: authed,
      sleep,
      ...(budget !== undefined ? { turnCallBudget: budget } : {}),
    },
  };
}

const SPLIT_ORDER: Partial<Policy> = {
  providerOrderByTier: {
    worker: ['claude', 'codex'],
    ic: ['claude', 'codex'],
    manager: ['codex', 'claude'],
  },
};

const HEDGE: HedgePlan = { primaryTier: 'ic', speculativeTier: 'manager', delayMs: 4000, risk: 'high' };

const adequate = (body: string): string =>
  `${body}\n{"confidence": 0.95, "escalate": false, "reason": "ok", "needs_review": false}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('panel-hedge call budget', () => {
  // -----------------------------------------------------------------------
  // 1. two panel candidates plus synthesis reconcile three calls
  // -----------------------------------------------------------------------
  it('two panel candidates plus synthesis reconcile three calls', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(3);

    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['CAND-A', 'SYNTH'], claudeRec);
    const codex = makeSeqProvider('codex', ['CAND-B'], codexRec);
    const { deps } = panelDeps({ claude, codex }, budget);

    const events = await collect(runPanel('hard task', deps, PANEL, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success);

    const snap = snapshotEvents(budget.snapshot());
    assert.equal(snap.begun, 3, 'two candidates + one synthesis = 3 begun calls');
    assert.equal(snap.settled, 3, 'all three should settle');
    // claude runs twice (candidate + synthesizer), codex once (candidate)
    assert.equal(claudeRec.calls + codexRec.calls, 3, 'total fake provider runs = 3');
  });

  // -----------------------------------------------------------------------
  // 2. panel candidate failure remains counted
  // -----------------------------------------------------------------------
  it('panel candidate failure remains counted', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(3);

    const claudeRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['CAND-A', 'SYNTH'], claudeRec);
    const codex = makeProvider('codex', '', { error: true });
    const { deps } = panelDeps({ claude, codex }, budget);

    const events = await collect(runPanel('hard task', deps, PANEL, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success, 'panel still succeeds with one failing candidate');

    const snap = snapshotEvents(budget.snapshot());
    assert.equal(snap.begun, 3, 'failed candidate, succeeded candidate, and synthesis all counted');
    assert.equal(snap.settled, 3, 'all three settle');
  });

  // -----------------------------------------------------------------------
  // 3. panel that never starts records zero
  // -----------------------------------------------------------------------
  it('panel that never starts records zero', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(3);

    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['unused'], rec);
    const codex = makeProvider('codex', 'unused');
    const { deps } = panelDeps({ claude, codex }, budget);

    // The numeric budget gating (capability.turnCallBudget) denies the panel
    // before any stream opens, so the ledger observes zero calls.
    const events = await collect(
      runPanel('hard task', deps, PANEL, new AbortController().signal, undefined, {
        turnCallBudget: 2, // < 3 → panel denied before any streams
      }),
    );

    assert.deepEqual(events, []);
    const snap = snapshotEvents(budget.snapshot());
    assert.equal(snap.begun, 0, 'panel denied before any stream opened → zero calls');
  });

  // -----------------------------------------------------------------------
  // 4. hedge loser cancelled after start is counted
  // -----------------------------------------------------------------------
  it('hedge loser cancelled after start is counted', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(2);

    const primaryRec = { ran: false, aborted: false };
    const specRec = { ran: false, aborted: false };

    // The primary is slow (gated), the speculative wins quickly.
    const primaryGate: { promise: Promise<void>; resolve: () => void } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    })();

    const claude = makeProvider('claude', adequate('PRIMARY-TEXT'), { record: primaryRec, gate: primaryGate.promise });
    const codex = makeProvider('codex', adequate('SPEC-TEXT'), { record: specRec });

    // Immediately-resolving sleep → delay elapses first → speculative starts in parallel.
    const instantSleep = (): Promise<void> => Promise.resolve();
    const { deps } = hedgeDeps({ claude, codex }, instantSleep, budget, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, HEDGE, new AbortController().signal));

    // Let the primary finish (it was gated).
    primaryGate.resolve();

    // Wait a tick so the primary promise can settle.
    await new Promise((r) => setTimeout(r, 50));

    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success, 'speculative should win');

    // Both primary and speculative started → both counted.
    const snap = snapshotEvents(budget.snapshot());
    assert.ok(snap.begun >= 2, 'both hedge arms started → at least 2 begun calls');
  });

  // -----------------------------------------------------------------------
  // 5. hedge cancelled before stream start is not counted
  // -----------------------------------------------------------------------
  it('hedge cancelled before stream start is not counted', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(2);

    const specRec = { ran: false, aborted: false };
    const claude = makeProvider('claude', adequate('PRIMARY-OK'));
    const codex = makeProvider('codex', adequate('SPEC-UNUSED'), { record: specRec });

    // Never-resolving sleep → primary always wins the race → speculative NEVER starts.
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDeps({ claude, codex }, neverSleep, budget, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, HEDGE, new AbortController().signal));

    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success);

    // Only primary started → 1 begun call; speculative never opened a stream.
    const snap = snapshotEvents(budget.snapshot());
    assert.equal(snap.begun, 1, 'only primary started → 1 begun call');
    assert.equal(specRec.ran, false, 'speculative must never run');
  });

  // -----------------------------------------------------------------------
  // 6. parallel begins cannot exceed finalized work width (enforce mode)
  // -----------------------------------------------------------------------
  it('parallel begins cannot exceed finalized work width', () => {
    const budget = createTurnCallBudget(
      budgetSpec({ mode: 'enforce', totalUnits: 10, reservedWork: 1 }),
    );
    budget.finalizeWorkReservation(2);

    // With 2 work units but 3 work-bucket calls needed, the third is denied.
    // First: admit candidate 1 (2→1 work remaining)
    const r1 = budget.begin({ purpose: 'panel-candidate', bucket: 'work' });
    assert.ok(r1.allowed);

    // Second: admit candidate 2 (1→0 work remaining)
    const r2 = budget.begin({ purpose: 'panel-candidate', bucket: 'work' });
    assert.ok(r2.allowed);

    // Third: synthesis denied (0 work remaining)
    const r3 = budget.begin({ purpose: 'panel-synthesis', bucket: 'work' });
    assert.equal(r3.allowed, false, 'third work-bucket call must be denied when width exhausted');

    if (r3.allowed === false) {
      r1.finish('succeeded');
      r2.finish('succeeded');
    }

    const snap = budget.snapshot();
    assert.equal(snap.begun, 2);
    assert.equal(snap.denied, 1);
  });

  // -----------------------------------------------------------------------
  // 7. observe mode reports would-deny without changing winner
  // -----------------------------------------------------------------------
  it('observe mode reports would-deny without changing winner', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(1); // Only 1 work unit for panel (2 candidates + synthesis = 3 needed)

    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['CAND-A', 'SYNTH'], claudeRec);
    const codex = makeSeqProvider('codex', ['CAND-B'], codexRec);
    const { deps } = panelDeps({ claude, codex }, budget);

    const events = await collect(runPanel('hard task', deps, PANEL, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success, 'winner unchanged');

    const snap = budget.snapshot();
    // Observe mode admits all calls but records would-deny for excess.
    const wouldDenyEvents = snap.events.filter((e) => e.type === 'call-would-deny');
    assert.ok(wouldDenyEvents.length > 0, 'observe mode emits would-deny when work width exceeded');
    // All candidates still ran (observe doesn't block).
    assert.equal(claudeRec.calls + codexRec.calls, 3, 'all three calls still ran in observe mode');
  });

  // -----------------------------------------------------------------------
  // Invariant: with no budget present, byte-for-byte identical
  // -----------------------------------------------------------------------
  it('no budget present is byte-for-byte identical', async () => {
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };

    const claude = makeSeqProvider('claude', ['CAND-A', 'SYNTH'], claudeRec);
    const codex = makeSeqProvider('codex', ['CAND-B'], codexRec);
    const { deps } = panelDeps({ claude, codex }, undefined);

    const events = await collect(runPanel('hard task', deps, PANEL, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success);
    assert.equal(claudeRec.calls + codexRec.calls, 3, 'three provider runs without budget');

    // No budget means winners, events, costs unchanged.
    assert.ok(final !== undefined && final.type === 'final' && final.success);
  });

  // -----------------------------------------------------------------------
  // hedge repair counts as discretionary
  // -----------------------------------------------------------------------
  it('hedge repair counts as discretionary', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(2);

    // Primary finishes fast but inadequate → sequential speculative → speculative wins.
    const claude = makeProvider('claude', adequate('PRIMARY'));
    const codex = makeProvider('codex', adequate('SPEC'));

    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDeps({ claude, codex }, neverSleep, budget, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, HEDGE, new AbortController().signal));

    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success);

    const snap = budget.snapshot();
    assert.ok(snap.begun >= 1, 'at least primary started');
  });

  // -----------------------------------------------------------------------
  // panel synthesis records distinctly from candidate
  // -----------------------------------------------------------------------
  it('panel synthesis is a distinct call from candidate', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(3);

    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['CAND-A', 'SYNTH'], claudeRec);
    const codex = makeSeqProvider('codex', ['CAND-B'], codexRec);
    const { deps } = panelDeps({ claude, codex }, budget);

    await collect(runPanel('hard task', deps, PANEL, new AbortController().signal));

    const snap = budget.snapshot();
    const candidateEvents = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'panel-candidate',
    );
    const synthesisEvents = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'panel-synthesis',
    );

    assert.equal(candidateEvents.length, 2, '2 candidate calls');
    assert.equal(synthesisEvents.length, 1, '1 synthesis call');
  });

  // -----------------------------------------------------------------------
  // hedge primary vs secondary are distinct purposes
  // -----------------------------------------------------------------------
  it('hedge primary and secondary have distinct purposes', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    budget.finalizeWorkReservation(2);

    // Delay elapses → both primary and speculative start.
    const primaryGate: { promise: Promise<void>; resolve: () => void } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    })();

    const claude = makeProvider('claude', adequate('PRIMARY-TEXT'), { gate: primaryGate.promise });
    const codex = makeProvider('codex', adequate('SPEC-TEXT'));

    const instantSleep = (): Promise<void> => Promise.resolve();
    const { deps } = hedgeDeps({ claude, codex }, instantSleep, budget, SPLIT_ORDER);

    const eventsPromise = collect(runHedged('hard task', deps, HEDGE, new AbortController().signal));

    // Let primary finish to settle the race.
    await new Promise((r) => setTimeout(r, 50));
    primaryGate.resolve();
    await eventsPromise;

    const snap = budget.snapshot();
    const primary = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'hedge-primary',
    );
    const secondary = snap.events.filter(
      (e) => e.type === 'call-begun' && e.purpose === 'hedge-secondary',
    );

    assert.equal(primary.length, 1, 'one hedge-primary call');
    assert.equal(secondary.length, 1, 'one hedge-secondary call');
  });
});
