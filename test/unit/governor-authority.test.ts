import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../../src/core/policy.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../../src/providers/port.ts';

const ENVELOPE =
  '{"confidence":0.95,"escalate":false,"reason":"done","needs_review":false}';

function clock(): Clock {
  let id = 0;
  return {
    now: () => 1_000,
    isoNow: () => new Date(1_000).toISOString(),
    uuid: () => `id-${++id}`,
    random: () => 0.5,
  };
}

function session(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'governor-authority', entries, async append(entry) { entries.push(entry); } };
}

function ledger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { entries, async record(entry) { entries.push(entry); } };
}

function provider(
  id: ProviderId,
  events: readonly ProviderEvent[],
): Provider & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() { return calls; },
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/fake', availableModels: [] };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      calls++;
      yield* events;
    },
  };
}

function deps(
  providers: OrchestrateDeps['providers'],
  overrides: Partial<OrchestrateDeps> = {},
): OrchestrateDeps {
  return {
    providers,
    clock: clock(),
    session: session(),
    ledger: ledger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    authenticatedProviders: Object.keys(providers) as ProviderId[],
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const done = (text = 'done'): ProviderEvent[] => [
  { type: 'done', text: `${text}\n${ENVELOPE}`, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} },
];
const errored: ProviderEvent[] = [{
  type: 'error',
  error: { category: 'network', recoverable: true, message: 'failed', suggestion: 'retry' },
}];

describe('governor execution authority', () => {
  it('allocates before a would-be panel and denies it when the hard budget cannot fit', async () => {
    const claude = provider('claude', done('claude'));
    const codex = provider('codex', done('codex'));
    const policy = { ...POLICY_PRESETS['quality-first'], panelPolicy: 'always' as const };

    const withoutGovernor = await collect(orchestrate(
      'what time is it',
      deps({ claude, codex }, { policy }),
      new AbortController().signal,
    ));
    assert.ok(withoutGovernor.some((e) => e.type === 'phase' && e.phase === 'panel'));

    const governedClaude = provider('claude', done('sequential'));
    const governedCodex = provider('codex', done('unused'));
    const governed = await collect(orchestrate(
      'what time is it',
      deps(
        { claude: governedClaude, codex: governedCodex },
        { policy, governorEnabled: true, governorPressure: 2 },
      ),
      new AbortController().signal,
    ));
    assert.ok(!governed.some((e) => e.type === 'phase' && e.phase === 'panel'));
    assert.equal(governedClaude.calls + governedCodex.calls, 1);
  });

  it('allocates before a would-be hedge and denies it after pressure shrinks budget below 2', async () => {
    const policy = {
      ...DEFAULT_POLICY,
      panelPolicy: 'off' as const,
      hedgePolicy: 'on' as const,
      reviewPolicy: 'off' as const,
      flagshipAdmission: 'always-eligible' as const,
    };
    const task = 'implement payment handler';
    const baseClaude = provider('claude', done('primary'));
    const baseCodex = provider('codex', done('speculative'));
    const ungoverned = await collect(orchestrate(
      task,
      deps({ claude: baseClaude, codex: baseCodex }, { policy, sleep: () => Promise.resolve() }),
      new AbortController().signal,
    ));
    assert.ok(ungoverned.some((e) => e.type === 'notice' && e.message.startsWith('hedge:')));

    const governedClaude = provider('claude', done('sequential'));
    const governedCodex = provider('codex', done('unused'));
    const governed = await collect(orchestrate(
      task,
      deps(
        { claude: governedClaude, codex: governedCodex },
        { policy, sleep: () => Promise.resolve(), governorEnabled: true, governorPressure: 2 },
      ),
      new AbortController().signal,
    ));
    assert.ok(!governed.some((e) => e.type === 'notice' && e.message.startsWith('hedge:')));
    assert.equal(governedClaude.calls + governedCodex.calls, 1);
  });

  it('turnCallBudget=1 counts an errored call once and prevents failover', async () => {
    const claude = provider('claude', errored);
    const codex = provider('codex', done('must not run'));
    const events = await collect(orchestrate(
      'what time is it',
      deps(
        { claude, codex },
        {
          governorEnabled: true,
          governorPressure: 2,
          policy: { ...POLICY_PRESETS['quality-first'], maxAttempts: 3, panelPolicy: 'off', hedgePolicy: 'off' },
        },
      ),
      new AbortController().signal,
    ));

    assert.equal(claude.calls, 1);
    assert.equal(codex.calls, 0);
    assert.ok(!events.some((e) => e.type === 'failover' || e.type === 'escalate'));
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.attempts, 1);
  });

  it('a cancelled provider invocation consumes exactly one budget unit', async () => {
    const ac = new AbortController();
    let calls = 0;
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/fake', availableModels: [] };
      },
      async *run(): AsyncIterable<ProviderEvent> {
        calls++;
        ac.abort();
        yield { type: 'text', delta: 'partial' };
      },
    };
    const codex = provider('codex', done('must not run'));
    const events = await collect(orchestrate(
      'what time is it',
      deps(
        { claude, codex },
        {
          governorEnabled: true,
          governorPressure: 2,
          policy: { ...POLICY_PRESETS['quality-first'], maxAttempts: 3, panelPolicy: 'off', hedgePolicy: 'off' },
        },
      ),
      ac.signal,
    ));

    assert.equal(calls, 1);
    assert.equal(codex.calls, 0);
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.canceled, true);
    assert.equal(final.attempts, 1);
  });

  it('a governor budget above the natural maximum is a no-op', async () => {
    const policy = {
      ...POLICY_PRESETS['quality-first'],
      maxAttempts: 1,
      panelPolicy: 'off' as const,
      hedgePolicy: 'off' as const,
      reviewPolicy: 'off' as const,
    };
    const task = 'add a logout button to the navbar';
    const baseline = await collect(orchestrate(
      task,
      deps({ claude: provider('claude', done()) }, { policy }),
      new AbortController().signal,
    ));
    const governed = await collect(orchestrate(
      task,
      deps({ claude: provider('claude', done()) }, { policy, governorEnabled: true }),
      new AbortController().signal,
    ));

    assert.deepEqual(governed, baseline);
  });
});
