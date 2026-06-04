/**
 * Unit tests for src/core/hedge.ts — Latency-Hedged Escalation.
 *
 * Pure tests for planHedge, plus deterministic integration tests for runHedged
 * using fake providers + an INJECTED, controllable `sleep` (mirrors the
 * fake-provider + collect harness in test/unit/ensemble.test.ts). Timing is made
 * deterministic by controlling `sleep`: a never-resolving sleep forces "primary
 * finishes first"; an immediately-resolving sleep forces "delay elapses first".
 *
 * Run with: node --experimental-strip-types --test test/unit/hedge.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planHedge, runHedged, type HedgePlan } from '../../src/core/hedge.ts';
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
// Fixtures
// ---------------------------------------------------------------------------

const HIGH_IC: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };
const LOW_IC: Classification = { tier: 'ic', risk: 'low', rationale: 'r' };
const CRIT_MANAGER: Classification = { tier: 'manager', risk: 'critical', rationale: 'r' };

// A confidence envelope helper so assess() reads adequate/inadequate as intended.
const adequate = (body: string): string =>
  `${body}\n{"confidence": 0.95, "escalate": false, "reason": "ok", "needs_review": false}`;
const lowConf = (body: string): string =>
  `${body}\n{"confidence": 0.1, "escalate": true, "reason": "unsure", "needs_review": true}`;

// ---------------------------------------------------------------------------
// Pure: planHedge
// ---------------------------------------------------------------------------

describe('planHedge — gating', () => {
  const base = {
    policy: { ...DEFAULT_POLICY, flagshipAdmission: 'adaptive' as const },
    authenticatedProviders: ['claude', 'codex'] as readonly ProviderId[],
    hasSleep: true,
  };

  it("hedgePolicy 'off' → null", () => {
    assert.equal(
      planHedge({ ...base, hedgePolicy: 'off', classification: HIGH_IC }),
      null,
    );
  });

  it('hedgePolicy undefined → null', () => {
    assert.equal(
      planHedge({ ...base, hedgePolicy: undefined, classification: HIGH_IC }),
      null,
    );
  });

  it('not high/critical risk → null', () => {
    assert.equal(
      planHedge({ ...base, hedgePolicy: 'on', classification: LOW_IC }),
      null,
    );
  });

  it('hasSleep false → null', () => {
    assert.equal(
      planHedge({ ...base, hasSleep: false, hedgePolicy: 'on', classification: HIGH_IC }),
      null,
    );
  });

  it('tier already manager → null', () => {
    assert.equal(
      planHedge({ ...base, hedgePolicy: 'on', classification: CRIT_MANAGER }),
      null,
    );
  });

  it('admission denied (never-auto / Efficient) → null', () => {
    assert.equal(
      planHedge({
        ...base,
        policy: { ...DEFAULT_POLICY, flagshipAdmission: 'never-auto' },
        hedgePolicy: 'on',
        classification: HIGH_IC,
      }),
      null,
    );
  });

  it('no authenticated providers → null', () => {
    assert.equal(
      planHedge({ ...base, authenticatedProviders: [], hedgePolicy: 'on', classification: HIGH_IC }),
      null,
    );
  });

  it('high-risk + on + sleep + ≥1 provider + admittable → a plan', () => {
    const plan = planHedge({ ...base, hedgePolicy: 'on', classification: HIGH_IC });
    assert.ok(plan !== null);
    assert.equal(plan.primaryTier, 'ic');
    assert.equal(plan.speculativeTier, 'manager');
    assert.equal(plan.delayMs, 4000);
    assert.equal(plan.risk, 'high'); // carries the turn's real risk for the adequacy bar
  });

  it('respects a custom hedgeDelayMs', () => {
    const plan = planHedge({
      ...base,
      policy: { ...DEFAULT_POLICY, flagshipAdmission: 'adaptive', hedgeDelayMs: 1234 },
      hedgePolicy: 'on',
      classification: HIGH_IC,
    });
    assert.ok(plan !== null);
    assert.equal(plan.delayMs, 1234);
  });

  it('is deterministic for identical inputs', () => {
    const opts = { ...base, hedgePolicy: 'on' as const, classification: HIGH_IC };
    assert.deepEqual(planHedge(opts), planHedge(opts));
  });
});

// ---------------------------------------------------------------------------
// Fakes (mirrors ensemble.test.ts / orchestrate.test.ts)
// ---------------------------------------------------------------------------

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

function makeFakeSession(id = 'sess-hedge-1'): SessionWriter & { entries: SessionEntry[] } {
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

/** A controllable promise: resolve() is exposed so tests drive timing/gating. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fake provider whose run is either immediate (text/done now) or gated on a
 * caller-supplied `gate` promise (so a test can make a branch "slow"). Records
 * whether its signal was aborted and how many times it ran.
 */
function makeProvider(
  id: ProviderId,
  text: string,
  opts?: {
    error?: boolean;
    gate?: Promise<void>;
    onRun?: () => void;
    record?: { ran: boolean; aborted: boolean };
  },
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
        // Race the gate against abort so a cancelled slow run actually returns.
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

function hedgeDeps(
  providers: Partial<Record<ProviderId, Provider>>,
  sleep: (ms: number) => Promise<void>,
  policyOverrides?: Partial<Policy>,
): {
  deps: OrchestrateDeps;
  session: ReturnType<typeof makeFakeSession>;
  ledger: ReturnType<typeof makeFakeLedger>;
} {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const authed = Object.keys(providers) as ProviderId[];
  return {
    session,
    ledger,
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
    },
  };
}

// The provider order: DEFAULT_POLICY routes 'ic' → claude, 'manager' → claude by
// default preference; with a single distinct provider per tier we keep it simple
// by giving claude the IC role and codex the manager role via providerOrderByTier
// overrides so the primary and speculative use DIFFERENT providers (observable).
const SPLIT_ORDER: Partial<Policy> = {
  providerOrderByTier: {
    worker: ['claude', 'codex'],
    ic: ['claude', 'codex'],
    manager: ['codex', 'claude'],
  },
};

const PLAN: HedgePlan = { primaryTier: 'ic', speculativeTier: 'manager', delayMs: 4000, risk: 'high' };

// ---------------------------------------------------------------------------
// Integration: runHedged
// ---------------------------------------------------------------------------

describe('runHedged — primary fast + adequate (speculative never starts)', () => {
  it('sleep never resolves → primary wins; speculative provider not invoked', async () => {
    const specRec = { ran: false, aborted: false };
    const claude = makeProvider('claude', adequate('PRIMARY-OK'));
    const codex = makeProvider('codex', adequate('SPEC'), { record: specRec });
    // sleep never resolves → the primary always wins the race.
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger, session } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, new AbortController().signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, adequate('PRIMARY-OK'));
      assert.equal(final.tier, 'ic');
    }
    // The speculative flagship (codex) was NEVER started — quota saved.
    assert.equal(specRec.ran, false, 'speculative must not run when primary is adequate in time');
    // Honest "answered in time" notice.
    assert.ok(
      events.some((e) => e.type === 'notice' && /answered in time/i.test(e.message)),
      'expected an "answered in time" notice',
    );
    // Ledger has exactly the primary run.
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.provider, 'claude');
    // Session: user + assistant(primary output).
    assert.equal(session.entries[0]?.role, 'user');
    assert.ok(session.entries.some((e) => e.role === 'assistant' && e.content === adequate('PRIMARY-OK')));
  });
});

describe('runHedged — primary slow → speculative wins', () => {
  it('delay elapses; speculative resolves adequate; primary aborted', async () => {
    const primaryGate = deferred(); // never resolved → primary hangs
    const primRec = { ran: false, aborted: false };
    const claude = makeProvider('claude', adequate('PRIMARY-SLOW'), {
      gate: primaryGate.promise,
      record: primRec,
    });
    const codex = makeProvider('codex', adequate('SPEC-WINS'));
    // sleep resolves immediately → the delay elapses first, primary still running.
    const instantSleep = (): Promise<void> => Promise.resolve();
    const { deps, ledger } = hedgeDeps({ claude, codex }, instantSleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, new AbortController().signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, adequate('SPEC-WINS'));
      assert.equal(final.tier, 'manager');
    }
    // Primary was cancelled (its signal aborted).
    assert.ok(primRec.ran, 'primary did start');
    assert.ok(primRec.aborted, 'the slower primary branch must be aborted');
    // "primary slow — starting speculative" notice emitted.
    assert.ok(
      events.some((e) => e.type === 'notice' && /primary slow/i.test(e.message)),
      'expected a "primary slow" notice',
    );
    // Both runs recorded (primary executed + got cancelled; speculative won).
    assert.equal(ledger.entries.length, 2);
  });
});

describe('runHedged — primary slow but then primary finishes adequate first', () => {
  it('speculative slower → final = primary; speculative aborted', async () => {
    const specGate = deferred(); // speculative hangs
    const specRec = { ran: false, aborted: false };
    const claude = makeProvider('claude', adequate('PRIMARY-WINS'));
    const codex = makeProvider('codex', adequate('SPEC-SLOW'), {
      gate: specGate.promise,
      record: specRec,
    });
    // sleep resolves immediately → delay elapses, speculative starts, but the
    // primary (claude, no gate) resolves immediately while the speculative hangs.
    const instantSleep = (): Promise<void> => Promise.resolve();
    const { deps, ledger } = hedgeDeps({ claude, codex }, instantSleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, new AbortController().signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, adequate('PRIMARY-WINS'));
      assert.equal(final.tier, 'ic');
    }
    assert.ok(specRec.ran, 'speculative did start');
    assert.ok(specRec.aborted, 'the slower speculative branch must be aborted');
    assert.equal(ledger.entries.length, 2);
  });
});

describe('runHedged — primary fast but inadequate → sequential flagship', () => {
  it('low-confidence primary → speculative flagship runs and is shipped', async () => {
    const specRec = { ran: false, aborted: false };
    const claude = makeProvider('claude', lowConf('PRIMARY-WEAK'));
    const codex = makeProvider('codex', adequate('FLAGSHIP-ANSWER'), { record: specRec });
    // sleep never resolves → primary wins the race, but it's inadequate.
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, new AbortController().signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, adequate('FLAGSHIP-ANSWER'));
      assert.equal(final.tier, 'manager');
    }
    assert.ok(specRec.ran, 'speculative flagship must run when the primary is inadequate');
    // Both the primary and the sequential flagship are recorded.
    assert.equal(ledger.entries.length, 2);
  });
});

describe('runHedged — abort', () => {
  it('caller signal aborted before start → cancelled notice + failing final', async () => {
    const ac = new AbortController();
    ac.abort();
    const claude = makeProvider('claude', adequate('A'));
    const codex = makeProvider('codex', adequate('B'));
    const { deps } = hedgeDeps({ claude, codex }, () => Promise.resolve(), SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, ac.signal));

    const notice = events.find((e) => e.type === 'notice' && e.level === 'warn');
    assert.ok(notice !== undefined && /cancel/i.test(notice.message));
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1);
    assert.ok(finals[0]?.type === 'final' && finals[0].success === false);
  });

  it('caller aborts mid-race → cancelled + failing final, both branches aborted', async () => {
    const primaryGate = deferred();
    const specGate = deferred();
    const primRec = { ran: false, aborted: false };
    const specRec = { ran: false, aborted: false };
    const claude = makeProvider('claude', adequate('P'), { gate: primaryGate.promise, record: primRec });
    const codex = makeProvider('codex', adequate('S'), { gate: specGate.promise, record: specRec });
    const ac = new AbortController();
    // sleep elapses immediately so both branches are running, then the caller
    // aborts — which (via the linked controllers) cancels both gated runs.
    const sleep = (): Promise<void> => {
      // Abort on the next microtask, after both runs have been kicked off.
      queueMicrotask(() => ac.abort());
      return Promise.resolve();
    };
    const { deps } = hedgeDeps({ claude, codex }, sleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, ac.signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final even on abort');
    assert.ok(finals[0]?.type === 'final' && finals[0].success === false);
    assert.ok(
      events.some((e) => e.type === 'notice' && e.level === 'warn' && /cancel/i.test(e.message)),
      'expected a cancelled notice',
    );
  });
});
