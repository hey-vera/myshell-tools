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
import type { SubscriptionAccount } from '../../src/infra/subscriptions.ts';
import {
  selectSiblingSubscriptionAccount,
} from '../../src/core/opencode-account-routing.ts';
import type { SubscriptionProvider } from '../../src/infra/subscriptions.ts';
import type {
  DetectedTestCommand,
  TestRunResult,
  VerifyPort,
} from '../../src/core/verify.ts';

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
// A body that SKIPS the required confidence envelope entirely → assess() reads
// confidence=null. The contract requires an envelope, so this must NOT score as an
// adequate hedge winner over a branch that DID report adequate confidence.
const noConf = (body: string): string => `${body}\n(no confidence envelope here)`;

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
    reqSink?: { last?: ProviderRequest };
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
      if (opts?.reqSink !== undefined) opts.reqSink.last = _req;
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

// Policy override that routes BOTH primary (ic) and speculative (manager) to the
// SAME provider (claude first), so same-provider account fanout can be tested.
const SAME_PROVIDER_ORDER: Partial<Policy> = {
  providerOrderByTier: {
    worker: ['claude', 'codex'],
    ic: ['claude', 'codex'],
    manager: ['claude', 'codex'],
  },
};

function makeClaudeAccount(overrides: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id: 'claude-1',
    provider: 'claude' as SubscriptionProvider,
    kind: 'oauth-sub',
    label: 'Claude Account 1',
    homeDir: '/fake/claude-1',
    priority: 'high',
    priorityWeight: 200,
    enabled: true,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  } as SubscriptionAccount;
}

function makeClaudeAccounts(): SubscriptionAccount[] {
  return [
    makeClaudeAccount({ id: 'claude-1', label: 'Claude Account 1', priorityWeight: 200 }),
    makeClaudeAccount({ id: 'claude-2', label: 'Claude Account 2', priorityWeight: 150, createdAt: '2024-01-02T00:00:00Z' }),
  ];
}

function hedgeDepsWithAccounts(
  providers: Partial<Record<ProviderId, Provider>>,
  sleep: (ms: number) => Promise<void>,
  opts: {
    policyOverrides?: Partial<Policy>;
    subscriptionAccounts?: SubscriptionAccount[];
    accountParallelism?: boolean;
    accountParallelismDisabledProviders?: ReadonlySet<SubscriptionProvider>;
    mode?: string;
    accountCooldownUntil?: Map<string, number>;
    sessionTokensByAccount?: Record<string, number>;
  } = {},
): {
  deps: OrchestrateDeps;
  session: ReturnType<typeof makeFakeSession>;
  ledger: ReturnType<typeof makeFakeLedger>;
} {
  const base = hedgeDeps(providers, sleep, opts.policyOverrides ?? SAME_PROVIDER_ORDER);
  const accounts = opts.subscriptionAccounts ?? makeClaudeAccounts();
  if (opts.mode === 'balanced') {
    base.deps.policy = { ...base.deps.policy, mode: 'balanced' };
  }
  if (opts.accountParallelism !== false && opts.mode !== 'balanced') {
    return {
      session: base.session,
      ledger: base.ledger,
      deps: {
        ...base.deps,
        subscriptionAccounts: accounts,
        accountParallelism: opts.accountParallelism ?? true,
        ...(opts.accountParallelismDisabledProviders !== undefined
          ? { accountParallelismDisabledProviders: opts.accountParallelismDisabledProviders }
          : {}),
        accountCooldownUntil: opts.accountCooldownUntil,
        sessionTokensByAccount: opts.sessionTokensByAccount,
        onAccountUsed: async () => {},
      },
    };
  }
  return {
    session: base.session,
    ledger: base.ledger,
    deps: {
      ...base.deps,
      subscriptionAccounts: accounts,
      ...(opts.accountParallelism === true
        ? { accountParallelism: true }
        : {}),
      ...(opts.accountParallelismDisabledProviders !== undefined
        ? { accountParallelismDisabledProviders: opts.accountParallelismDisabledProviders }
        : {}),
      accountCooldownUntil: opts.accountCooldownUntil,
      sessionTokensByAccount: opts.sessionTokensByAccount,
      onAccountUsed: async () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Integration: runHedged
// ---------------------------------------------------------------------------

describe('runHedged — primary fast + adequate (speculative never starts)', () => {
  it('governor budget below 2 denies the hedge before any call or session append', async () => {
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', [adequate('unused')], claudeRec);
    const codex = makeSeqProvider('codex', [adequate('unused')], codexRec);
    const { deps, session } = hedgeDeps({ claude, codex }, () => Promise.resolve(), SPLIT_ORDER);

    const events = await collect(
      runHedged(
        'hard task',
        deps,
        PLAN,
        new AbortController().signal,
        undefined,
        undefined,
        false,
        { turnCallBudget: 1 },
      ),
    );

    assert.deepEqual(events, []);
    assert.equal(claudeRec.calls + codexRec.calls, 0);
    assert.deepEqual(session.entries, []);
  });

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

  it('persists workTrace for an accepted hedged goal turn', async () => {
    const claude = makeProvider('claude', adequate('PRIMARY-OK'));
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, session } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);

    await collect(
      runHedged(
        'Goal: ship the widget',
        {
          ...deps,
          goalTurn: true,
          workContract: { version: 1, objective: 'ship the widget' },
        },
        PLAN,
        new AbortController().signal,
      ),
    );

    const assistant = session.entries.find((entry) => entry.role === 'assistant');
    assert.equal(assistant?.workTrace?.objective, 'ship the widget');
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

// ---------------------------------------------------------------------------
// Confidence-envelope contract (defect fix): a branch that SKIPPED the required
// confidence envelope (assess → confidence=null) must NOT score as an adequate
// hedge winner. A branch with present, adequate confidence outranks a missing one;
// but when EVERY branch lacks the envelope we still ship the strongest best-effort
// run rather than deadlocking with no answer.
// ---------------------------------------------------------------------------

describe('runHedged — confidence envelope is required to win', () => {
  it('present-confidence beats missing-confidence: a no-envelope primary does NOT short-circuit; the flagship runs and wins', async () => {
    const specRec = { ran: false, aborted: false };
    // Primary finishes fast but SKIPS the confidence envelope (null) → must be
    // treated as inadequate, NOT silently accepted. Pre-fix it would have shipped
    // here and the flagship would never have run.
    const claude = makeProvider('claude', noConf('PRIMARY-NO-ENVELOPE'));
    const codex = makeProvider('codex', adequate('FLAGSHIP-ANSWER'), { record: specRec });
    // sleep never resolves → primary wins the race, but it lacks the envelope.
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, new AbortController().signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      // The flagship's adequate, enveloped answer must win — not the no-envelope primary.
      assert.equal(final.output, adequate('FLAGSHIP-ANSWER'));
      assert.equal(final.tier, 'manager');
    }
    assert.ok(specRec.ran, 'missing-confidence primary must NOT short-circuit; the flagship must run');
    assert.equal(ledger.entries.length, 2, 'both the primary and the escalated flagship are recorded');
  });

  it('ALL branches lack the envelope → no deadlock: the speculative flagship is shipped best-effort', async () => {
    // Primary finishes fast but skips the envelope (inadequate); the speculative
    // flagship ALSO skips it. Neither branch is adequate, so the hedge must still
    // return SOMETHING (the strongest attempt = flagship) rather than deadlock.
    const claude = makeProvider('claude', noConf('PRIMARY-NO-ENVELOPE'));
    const codex = makeProvider('codex', noConf('SPEC-NO-ENVELOPE'));
    // sleep never resolves → primary wins the race but is inadequate → the flagship
    // runs sequentially and is shipped best-effort (no hanging branch to strand).
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);

    const events = await collect(runHedged('hard task', deps, PLAN, new AbortController().signal));

    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final — never strands the user with no answer');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true, 'still ships a best-effort answer when all branches lack the envelope');
      assert.equal(final.output, noConf('SPEC-NO-ENVELOPE'), 'the speculative flagship is the best-effort fallback');
      assert.equal(final.tier, 'manager');
    }
    assert.equal(ledger.entries.length, 2, 'both branches recorded');
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
    if (finals[0]?.type === 'final') {
      assert.equal(finals[0].canceled, true);
    }
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
    if (finals[0]?.type === 'final') {
      assert.equal(finals[0].canceled, true);
    }
    assert.ok(
      events.some((e) => e.type === 'notice' && e.level === 'warn' && /cancel/i.test(e.message)),
      'expected a cancelled notice',
    );
  });
});

// ---------------------------------------------------------------------------
// Capability parity with the sequential path: image attachments, native web
// search, and the capability-fit context must reach BOTH hedged branches'
// provider requests (audit: hedge previously dropped these).
// ---------------------------------------------------------------------------

describe('runHedged — capability parity (attachments + webSearch + capabilityContext)', () => {
  it('threads attachments + webSearch onto the PRIMARY request when it answers in time', async () => {
    const primSink: { last?: ProviderRequest } = {};
    const claude = makeProvider('claude', adequate('PRIMARY-OK'), { reqSink: primSink });
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    const depsWithCaps: OrchestrateDeps = {
      ...deps,
      attachments: [{ path: '/tmp/diagram.png', kind: 'image' }],
    };

    await collect(
      runHedged('describe this image', depsWithCaps, PLAN, new AbortController().signal, undefined, undefined, true),
    );

    assert.ok(primSink.last !== undefined, 'primary provider received a request');
    assert.equal(primSink.last?.webSearch, true, 'webSearch threaded onto the primary request');
    assert.deepEqual(
      primSink.last?.attachments,
      [{ path: '/tmp/diagram.png', kind: 'image' }],
      'image attachments threaded onto the primary request',
    );
  });

  it('threads attachments + webSearch onto the SPECULATIVE request when it wins the race', async () => {
    const primaryGate = deferred(); // primary hangs → speculative wins
    const claude = makeProvider('claude', adequate('PRIMARY-SLOW'), { gate: primaryGate.promise });
    const specSink: { last?: ProviderRequest } = {};
    const codex = makeProvider('codex', adequate('SPEC-WINS'), { reqSink: specSink });
    const instantSleep = (): Promise<void> => Promise.resolve();
    const { deps } = hedgeDeps({ claude, codex }, instantSleep, SPLIT_ORDER);
    const depsWithCaps: OrchestrateDeps = {
      ...deps,
      attachments: [{ path: '/tmp/shot.png', kind: 'image' }],
    };

    await collect(
      runHedged('look at this', depsWithCaps, PLAN, new AbortController().signal, undefined, undefined, true),
    );

    assert.ok(specSink.last !== undefined, 'speculative flagship received a request');
    assert.equal(specSink.last?.webSearch, true, 'webSearch threaded onto the speculative request');
    assert.deepEqual(
      specSink.last?.attachments,
      [{ path: '/tmp/shot.png', kind: 'image' }],
      'image attachments threaded onto the speculative request',
    );
  });

  it('omits attachments/webSearch when the turn carries neither (byte-for-byte unchanged)', async () => {
    const primSink: { last?: ProviderRequest } = {};
    const claude = makeProvider('claude', adequate('PRIMARY-OK'), { reqSink: primSink });
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);

    await collect(runHedged('plain text task', deps, PLAN, new AbortController().signal));

    assert.ok(primSink.last !== undefined);
    assert.equal(primSink.last?.webSearch, undefined, 'no webSearch field when not requested');
    assert.equal(primSink.last?.attachments, undefined, 'no attachments field when none present');
  });

  it('a non-image attachment never sets the attachments field (vision gate)', async () => {
    const primSink: { last?: ProviderRequest } = {};
    const claude = makeProvider('claude', adequate('PRIMARY-OK'), { reqSink: primSink });
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    // An attachments array with no image kind → hasImageAttachment is false.
    const depsNoImage: OrchestrateDeps = { ...deps, attachments: [] };

    await collect(runHedged('task', depsNoImage, PLAN, new AbortController().signal));

    assert.equal(primSink.last?.attachments, undefined, 'no image → attachments omitted');
  });
});

// ---------------------------------------------------------------------------
// P0.1b — the hedge WINNER routes through the SHARED Candidate Quality Gate.
//
// Only a typed RED test changes behaviour: ONE same-author repair on
// winner.chosen.provider at its resolved tier/model, then accept-or-block. The
// loser is never restarted and winner selection runs once. Non-verify
// transcripts above remain unchanged (no verifyPort there).
// ---------------------------------------------------------------------------

/** A provider that emits a DIFFERENT text on each successive run (for repair). */
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

function makeVerifyPort(
  runs: TestRunResult[],
  detected: DetectedTestCommand | null = { label: 'npm test', command: 'npm', args: ['test'] },
): VerifyPort & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async captureDiff() {
      return { files: ['src/a.ts'], patch: '+ fixed' };
    },
    async detectTestCommand() {
      return detected;
    },
    async runTests() {
      const result = runs[Math.min(calls, runs.length - 1)];
      calls++;
      return result ?? { outcome: 'errored', output: '', durationMs: 0 };
    },
  };
}

const redRun = (output = 'FAIL a.test.ts'): TestRunResult => ({ outcome: 'red', output, durationMs: 5 });
const greenRun = (): TestRunResult => ({ outcome: 'green', output: 'ok', durationMs: 4 });

describe('runHedged — Candidate Quality Gate', () => {
  it('two spent hedge calls leave no budget for winner repair', async () => {
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', [lowConf('PRIMARY-LOW')], claudeRec);
    const codex = makeSeqProvider('codex', [adequate('SPEC-RED')], codexRec);
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    const port = makeVerifyPort([redRun()]);

    const events = await collect(
      runHedged(
        'hard task',
        { ...deps, verifyPort: port, verifyLevel: 'tests' },
        PLAN,
        new AbortController().signal,
        undefined,
        undefined,
        false,
        { turnCallBudget: 2, verifyLevel: 'tests' },
      ),
    );

    assert.equal(claudeRec.calls + codexRec.calls, 2);
    assert.equal(events.at(-1)?.type, 'final');
    assert.equal(events.at(-1)?.type === 'final' ? events.at(-1)?.success : undefined, false);
  });

  it('winner red → one repair on the chosen provider only → green success', async () => {
    // Primary fast + adequate → winner = primary (claude). Then verify red → ONE
    // repair on claude only; codex (speculative) is never started at all.
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const specRec = { ran: false, aborted: false };
    const claude = makeSeqProvider('claude', [adequate('WINNER-RED'), adequate('WINNER-GREEN')], claudeRec);
    const codex = makeProvider('codex', adequate('SPEC'), { record: specRec });
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, session, ledger } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    const port = makeVerifyPort([redRun(), greenRun()]);
    const events = await collect(
      runHedged('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final' && final.success === true);
    assert.match(final.output, /WINNER-GREEN/);
    assert.equal(port.calls, 2, 'verify ran twice (winner red, repair green)');
    assert.equal(claudeRec.calls, 2, 'claude ran the winner + ONE repair');
    assert.equal(specRec.ran, false, 'the speculative loser was never started');
    assert.match(claudeRec.prompts[1] ?? '', /Acceptance verification failed/);
    assert.match(claudeRec.prompts[1] ?? '', /FAIL a\.test\.ts/);
    assert.ok(session.entries.some((e) => e.role === 'assistant' && /WINNER-GREEN/.test(e.content)));
    // ledger: primary winner + repair = 2 entries (speculative never ran).
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries.at(-1)?.provider, 'claude');
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('winner red → red blocks (final.success:false, no assistant append)', async () => {
    const claude = makeSeqProvider('claude', [adequate('WINNER-RED'), adequate('STILL-RED')]);
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, session } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    const port = makeVerifyPort([redRun(), redRun('FAIL again')]);
    const events = await collect(
      runHedged('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.memoryProposal, undefined);
    assert.equal(session.entries.filter((e) => e.role === 'assistant').length, 0);
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('loser is never restarted and winner selection runs once (CASE B, delay elapses)', async () => {
    // delay elapses immediately → both branches start. Primary (claude) finishes
    // adequate first and wins; speculative (codex) is gated then cancelled. The
    // repair re-runs ONLY claude — codex must NOT run a second time.
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', [adequate('PRIMARY-WIN'), adequate('PRIMARY-FIXED')], claudeRec);
    // codex (speculative) is gated forever so the primary always wins the race.
    const codex: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRec.calls++; codexRec.prompts.push(req.prompt);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        // cancelled → emits nothing (the yield is unreachable once aborted).
        if (!signal.aborted) yield { type: 'done', text: 'LATE', usage: USAGE, raw: {} };
      },
    };
    const nowSleep = (): Promise<void> => Promise.resolve();
    const { deps } = hedgeDeps({ claude, codex }, nowSleep, SPLIT_ORDER);
    const port = makeVerifyPort([redRun(), greenRun()]);
    const events = await collect(
      runHedged('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final' && final.success === true);
    assert.match(final.output, /PRIMARY-FIXED/);
    assert.equal(claudeRec.calls, 2, 'claude ran the winner + ONE repair');
    assert.equal(codexRec.calls, 1, 'the loser ran ONCE (its hedge attempt) and was never restarted');
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('passing tests accept with no repair (one final)', async () => {
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', [adequate('WINNER-OK')], claudeRec);
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, session } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    const port = makeVerifyPort([greenRun()]);
    const events = await collect(
      runHedged('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final' && final.success === true);
    assert.equal(claudeRec.calls, 1, 'no repair run on green');
    assert.equal(port.calls, 1);
    assert.equal(session.entries.filter((e) => e.role === 'assistant').length, 1);
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('cancellation during the winner run emits exactly one failing final and no append', async () => {
    // Abort before anything runs → the early-abort path emits one failing final.
    const claude = makeSeqProvider('claude', [adequate('X')]);
    const codex = makeProvider('codex', adequate('Y'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, session } = hedgeDeps({ claude, codex }, neverSleep, SPLIT_ORDER);
    const port = makeVerifyPort([redRun()]);
    const ac = new AbortController();
    ac.abort();
    const events = await collect(
      runHedged('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, ac.signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.canceled, true);
    assert.equal(session.entries.filter((e) => e.role === 'assistant').length, 0);
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Slice 5: Account-Aware Parallelism for Hedge
// ---------------------------------------------------------------------------

describe('account parallelism — flag off (byte-identical)', () => {
  it('accountParallelism absent → hedge unchanged, no accountId on result', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const claude = makeProvider('claude', adequate('PRIMARY-OK'), { reqSink: primaryReq });
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger } = hedgeDeps({ claude, codex }, neverSleep, SAME_PROVIDER_ORDER);
    // No accountParallelism field → old behavior
    const events = await collect(
      runHedged('hard task', deps, PLAN, new AbortController().signal),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    // No accountId on the provider request
    assert.equal(primaryReq.last?.accountId, undefined);
    assert.equal(primaryReq.last?.accountEnv, undefined);
    // No accountId on ledger entries
    for (const le of ledger.entries) {
      assert.equal(le.accountId, undefined);
    }
  });

  it('accountParallelism false when subscriptions on → hedge unchanged', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const claude = makeProvider('claude', adequate('PRIMARY-OK'), { reqSink: primaryReq });
    const codex = makeProvider('codex', adequate('SPEC'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger } = hedgeDepsWithAccounts(
      { claude, codex },
      neverSleep,
      { accountParallelism: false },
    );
    const events = await collect(
      runHedged('hard task', deps, PLAN, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    assert.equal(primaryReq.last?.accountId, undefined);
    for (const le of ledger.entries) {
      assert.equal(le.accountId, undefined);
    }
  });
});

describe('account parallelism — hedge eligibility', () => {
  it('primary gets account A, speculative same-provider arm gets distinct sibling account B (CASE B, parallel)', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const specReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const reqSinks = [primaryReq, specReq];
    // Wrap makeSeqProvider to record requests on each call
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        const sink = reqSinks[callN];
        if (sink !== undefined) sink.last = req;
        const texts = [
          lowConf('PRIMARY-LOW'),   // primary: slow/inadequate → triggers sequential or parallel spec
          adequate('SPEC-WINS'),     // speculative: adequate → wins
        ];
        const text = texts[Math.min(callN, texts.length - 1)] ?? '';
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const { deps, ledger } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(), // sleep resolves immediately → CASE B
      { policyOverrides: SAME_PROVIDER_ORDER },
    );
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));

    // Primary should have accountId = 'claude-1' (highest weight, first spread pick)
    assert.equal(primaryReq.last?.accountId, 'claude-1');
    assert.ok(primaryReq.last?.accountEnv !== undefined);

    // Speculative should have a DIFFERENT accountId (sibling: claude-2)
    assert.equal(specReq.last?.accountId, 'claude-2');
    assert.ok(specReq.last?.accountEnv !== undefined);

    // Ledger entries carry accountIds
    const primaryLe = ledger.entries.find((e) => e.accountId === 'claude-1');
    const specLe = ledger.entries.find((e) => e.accountId === 'claude-2');
    assert.ok(primaryLe !== undefined, 'primary ledger entry missing accountId');
    assert.ok(specLe !== undefined, 'speculative ledger entry missing accountId');
  });

  it('primary gets account A, speculative sequential arm (CASE A inadequate) gets distinct sibling account B', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const specReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const reqSinks = [primaryReq, specReq];
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        const sink = reqSinks[callN];
        if (sink !== undefined) sink.last = req;
        const texts = [
          lowConf('PRIMARY-LOW'),    // primary fast but inadequate
          adequate('SEQ-SPEC-WINS'), // speculative adequate → wins
        ];
        const text = texts[Math.min(callN, texts.length - 1)] ?? '';
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    // sleep never resolves → CASE A (primary finishes before delay)
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps } = hedgeDepsWithAccounts(
      { claude, codex },
      neverSleep,
      { policyOverrides: SAME_PROVIDER_ORDER },
    );
    const events = await collect(
      runHedged('hard task', deps, PLAN, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    assert.equal(primaryReq.last?.accountId, 'claude-1');
    assert.equal(specReq.last?.accountId, 'claude-2');
  });
});

describe('account parallelism — ineligible cases', () => {
  it('balanced/cost-saver mode → no sibling fanout', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        if (callN === 0) primaryReq.last = req;
        callN++;
        const text = adequate('OK');
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const { deps, ledger } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(),
      { mode: 'balanced' },
    );
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    // In balanced mode, accountParallelism is not set → no account selection
    assert.equal(primaryReq.last?.accountId, undefined);
    for (const le of ledger.entries) {
      assert.equal(le.accountId, undefined);
    }
  });

  it('<2 eligible accounts → no sibling fanout (only one claude account)', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const specReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const reqSinks = [primaryReq, specReq];
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        const sink = reqSinks[callN];
        if (sink !== undefined) sink.last = req;
        const texts = [lowConf('PRIMARY-LOW'), adequate('SPEC-WINS')];
        const text = texts[Math.min(callN, texts.length - 1)] ?? '';
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const accounts = [makeClaudeAccount({ id: 'claude-1' })];
    const { deps } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(),
      { subscriptionAccounts: accounts },
    );
    // Verify the deps are set up correctly
    assert.equal(deps.accountParallelism, true);
    assert.equal(deps.subscriptionAccounts, accounts);
    assert.equal(typeof deps.onAccountUsed, 'function');
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    // Primary gets claude-1; speculative gets no sibling (only one account available)
    assert.equal(primaryReq.last?.accountId, 'claude-1');
    assert.equal(specReq.last?.accountId, undefined);
  });

  it('tripped provider (in accountParallelismDisabledProviders) → no sibling fanout', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const specReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const reqSinks = [primaryReq, specReq];
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        const sink = reqSinks[callN];
        if (sink !== undefined) sink.last = req;
        const texts = [lowConf('PRIMARY-LOW'), adequate('SPEC-WINS')];
        const text = texts[Math.min(callN, texts.length - 1)] ?? '';
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const { deps } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(),
      {
        accountParallelismDisabledProviders: new Set<SubscriptionProvider>(['claude']),
      },
    );
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    // When provider is tripped, account selection is skipped entirely → no accountId
    assert.equal(primaryReq.last?.accountId, undefined);
    assert.equal(specReq.last?.accountId, undefined);
  });

  it('cooling sibling → no sibling fanout (primary only account available)', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const specReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const reqSinks = [primaryReq, specReq];
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        const sink = reqSinks[callN];
        if (sink !== undefined) sink.last = req;
        const texts = [lowConf('PRIMARY-LOW'), adequate('SPEC-WINS')];
        const text = texts[Math.min(callN, texts.length - 1)] ?? '';
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const cooldown = new Map<string, number>();
    cooldown.set('claude-2', Date.now() + 60_000);
    const { deps } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(),
      { accountCooldownUntil: cooldown },
    );
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    // Primary gets claude-1 (not cooling); speculative gets claude-2 (cooling,
    // but returned by never-strand since it's the only sibling candidate)
    assert.equal(primaryReq.last?.accountId, 'claude-1');
    assert.equal(specReq.last?.accountId, 'claude-2');
  });
});

describe('account parallelism — pure selectors unchanged', () => {
  it('planHedge is pure and unchanged (no account imports)', () => {
    // planHedge does NOT import or reference subscription accounts
    const plan = planHedge({
      hedgePolicy: 'on',
      classification: HIGH_IC,
      policy: { ...DEFAULT_POLICY, flagshipAdmission: 'always-eligible', hedgeDelayMs: 2000 },
      authenticatedProviders: ['claude'],
      hasSleep: true,
    });
    assert.ok(plan !== null);
    assert.equal(plan.delayMs, 2000);
  });

  it('selectSiblingSubscriptionAccount returns distinct non-low account', () => {
    const accounts: SubscriptionAccount[] = [
      makeClaudeAccount({ id: 'claude-1', priorityWeight: 200 }),
      makeClaudeAccount({ id: 'claude-2', priorityWeight: 150, createdAt: '2024-01-02T00:00:00Z' }),
      makeClaudeAccount({ id: 'claude-3', priority: 'low', priorityWeight: 25 }), // excluded
      makeClaudeAccount({ id: 'claude-disabled', priority: 'disabled', priorityWeight: 0 }), // excluded
    ];
    const sibling = selectSiblingSubscriptionAccount({
      accounts,
      provider: 'claude',
      primaryAccountId: 'claude-1',
      nowMs: Date.now(),
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.ok(sibling !== null);
    assert.notEqual(sibling.id, 'claude-1');
    assert.notEqual(sibling.id, 'claude-3'); // low priority excluded
    assert.strictEqual(sibling.id, 'claude-2'); // next best
  });

  it('selectSiblingSubscriptionAccount returns null when no eligible sibling', () => {
    const accounts: SubscriptionAccount[] = [
      makeClaudeAccount({ id: 'claude-1', priorityWeight: 200 }),
    ];
    const sibling = selectSiblingSubscriptionAccount({
      accounts,
      provider: 'claude',
      primaryAccountId: 'claude-1',
      nowMs: Date.now(),
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(sibling, null);
  });

  it('selectSiblingSubscriptionAccount excludes low-priority siblings', () => {
    const accounts: SubscriptionAccount[] = [
      makeClaudeAccount({ id: 'claude-1', priorityWeight: 200 }),
      makeClaudeAccount({ id: 'claude-low', priority: 'low', priorityWeight: 25 }),
    ];
    const sibling = selectSiblingSubscriptionAccount({
      accounts,
      provider: 'claude',
      primaryAccountId: 'claude-1',
      nowMs: Date.now(),
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(sibling, null);
  });
});

describe('account parallelism — ledger + reconciliation', () => {
  it('both ledger entries include accountId when accounts selected', async () => {
    let callN = 0;
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
        const texts = [lowConf('PRIMARY-LOW'), adequate('SPEC-WINS')];
        const text = texts[Math.min(callN, texts.length - 1)] ?? '';
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const { deps, ledger } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(),
    );
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    const primaryLe = ledger.entries.find((e) => e.accountId === 'claude-1');
    const specLe = ledger.entries.find((e) => e.accountId === 'claude-2');
    assert.ok(primaryLe !== undefined, 'primary ledger entry missing accountId');
    assert.ok(specLe !== undefined, 'speculative ledger entry missing accountId');
  });

  it('first success wins — primary fast + adequate, speculative never started', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    let callN = 0;
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        if (callN === 0) primaryReq.last = req;
        const text = adequate('PRIMARY-OK');
        callN++;
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex = makeProvider('codex', adequate('UNUSED'));
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const { deps, ledger } = hedgeDepsWithAccounts(
      { claude, codex },
      neverSleep,
    );
    const events = await collect(
      runHedged('hard task', deps, PLAN, new AbortController().signal),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    // Only 1 ledger entry (speculative never started)
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].accountId, 'claude-1');
  });
});

describe('account parallelism — cross-vendor hedge unchanged', () => {
  it('when primary + speculative use different providers (SPLIT_ORDER), no sibling fanout needed', async () => {
    const primaryReq = { last: undefined as ProviderRequest | undefined };
    const specReq = { last: undefined as ProviderRequest | undefined };
    // SPLIT_ORDER: ic=claude, manager=codex. Both use different providers.
    // We need a claude provider (for primary) and codex provider (for speculative).
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        // Primary uses this provider (claude, ic tier)
        if (primaryReq.last === undefined) primaryReq.last = req;
        const text = lowConf('CLAUDE-LOW');
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    const codex: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        specReq.last = req;
        const text = adequate('CODEX-WINS');
        yield { type: 'text', delta: text };
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
    // Add claude + codex accounts so both get account routing
    const allAccounts: SubscriptionAccount[] = [
      makeClaudeAccount({ id: 'claude-1' }),
      { ...makeClaudeAccount({ id: 'claude-1' }), provider: 'codex' as SubscriptionProvider, id: 'codex-1', label: 'Codex 1' },
    ];
    const { deps } = hedgeDepsWithAccounts(
      { claude, codex },
      (_ms: number): Promise<void> => Promise.resolve(),
      {
        policyOverrides: SPLIT_ORDER,
        subscriptionAccounts: allAccounts,
      },
    );
    const events = await collect(
      runHedged('hard task', deps, { ...PLAN, delayMs: 0 }, new AbortController().signal),
    );
    assert.ok(events.some((e) => e.type === 'final' && 'success' in e && e.success));
    // Primary is claude, gets claude account
    assert.equal(primaryReq.last?.accountId, 'claude-1');
    // Speculative routes to codex — normal account selection, not sibling (different provider)
    assert.equal(specReq.last?.accountId, 'codex-1');
  });
});
