import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  CoreEvent,
  LedgerEntry,
  OrchestrateDeps,
  SessionEntry,
} from '../../src/core/types.ts';
import type {
  DetectedTestCommand,
  TestRunResult,
  VerifyPort,
} from '../../src/core/verify.ts';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../../src/providers/port.ts';

const envelope = (confidence = 0.9, needsReview = false): string =>
  JSON.stringify({
    confidence,
    escalate: false,
    reason: 'done',
    needs_review: needsReview,
  });

function provider(
  id: ProviderId,
  outputs: string[],
  prompts: string[] = [],
): Provider & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() { return calls; },
    async detect() {
      return {
        id,
        installed: true,
        authenticated: true,
        version: '1',
        binaryPath: '/fake',
        availableModels: [],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      prompts.push(req.prompt);
      const text = outputs[Math.min(calls, outputs.length - 1)] ?? '';
      calls++;
      yield { type: 'text', delta: text.slice(0, 5) };
      yield {
        type: 'done',
        text,
        usage: { inputTokens: 10, outputTokens: 5 },
        raw: {},
      };
    },
  };
}

function verifyPort(
  runs: TestRunResult[],
  log: string[] = [],
  detected: DetectedTestCommand | null = { label: 'npm test', command: 'npm', args: ['test'] },
): VerifyPort & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async captureDiff() {
      log.push('capture');
      return { files: ['src/a.ts'], patch: '+ fixed' };
    },
    async detectTestCommand() {
      return detected;
    },
    async runTests() {
      log.push('verify');
      const result = runs[Math.min(calls, runs.length - 1)];
      calls++;
      return result ?? { outcome: 'errored', output: '', durationMs: 0 };
    },
  };
}

function deps(
  providers: OrchestrateDeps['providers'],
  over: Partial<OrchestrateDeps> = {},
  log: string[] = [],
): OrchestrateDeps & { entries: SessionEntry[]; ledgerEntries: LedgerEntry[] } {
  const entries: SessionEntry[] = [];
  const ledgerEntries: LedgerEntry[] = [];
  return {
    providers,
    clock: {
      now: () => 10,
      isoNow: () => '1970-01-01T00:00:00.010Z',
      uuid: () => `uuid-${ledgerEntries.length + 1}`,
      random: () => 0.5,
    },
    session: {
      id: 'session',
      async append(entry) {
        if (entry.role === 'assistant') log.push('append');
        entries.push(entry);
      },
    },
    ledger: {
      async record(entry) { ledgerEntries.push(entry); },
    },
    policy: { ...DEFAULT_POLICY, reviewPolicy: 'off' },
    cwd: '/repo',
    sandbox: 'workspace-write',
    timeoutMs: 1_000,
    ...over,
    entries,
    ledgerEntries,
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function assistantEntries(all: readonly SessionEntry[]): SessionEntry[] {
  return all.filter((entry) => entry.role === 'assistant');
}

const red = (output = 'FAIL a.test.ts'): TestRunResult => ({
  outcome: 'red', output, durationMs: 5,
});
const green = (): TestRunResult => ({ outcome: 'green', output: 'ok', durationMs: 4 });

describe('sequential Candidate Quality Gate integration', () => {
  it('red -> one same-author repair -> green accepts repaired output', async () => {
    const prompts: string[] = [];
    const claude = provider('claude', [`original\n${envelope()}`, `repaired\n${envelope()}`], prompts);
    const port = verifyPort([red(), green()]);
    const localDeps = deps({ claude }, { verifyPort: port, verifyLevel: 'tests' });
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    const final = events.at(-1);
    assert.equal(claude.calls, 2);
    assert.equal(port.calls, 2);
    assert.match(prompts[1] ?? '', /Acceptance verification failed/);
    assert.match(prompts[1] ?? '', /FAIL a\.test\.ts/);
    assert.equal(assistantEntries(localDeps.entries)[0]?.content.startsWith('repaired'), true);
    assert.ok(final?.type === 'final');
    assert.equal(final.success, true);
    assert.equal(final.attempts, 2);
  });

  it('red -> red blocks without assistant append or memory proposal', async () => {
    const claude = provider('claude', [`original\n${envelope()}`, `still red\n${envelope()}`]);
    const port = verifyPort([red(), red('FAIL again')]);
    const localDeps = deps({ claude }, { verifyPort: port, verifyLevel: 'tests' });
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    const final = events.at(-1);
    assert.equal(assistantEntries(localDeps.entries).length, 0);
    assert.ok(final?.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.memoryProposal, undefined);
    assert.equal(events.filter((event) => event.type === 'final').length, 1);
  });

  it('red -> timeout accepts fail-soft after repair', async () => {
    const claude = provider('claude', [`original\n${envelope()}`, `repaired\n${envelope()}`]);
    const port = verifyPort([red(), { outcome: 'timeout', output: '', durationMs: 100 }]);
    const localDeps = deps({ claude }, { verifyPort: port, verifyLevel: 'tests' });
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    assert.equal(assistantEntries(localDeps.entries).length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });

  it('reviewer approval verifies before assistant append', async () => {
    const log: string[] = [];
    const claude = provider('claude', [`work\n${envelope(0.9, true)}`]);
    const codex = provider('codex', ['review\n{"verdict":"approve","notes":"","confidence":0.9}']);
    const port = verifyPort([green()], log);
    const localDeps = deps(
      { claude, codex },
      {
        verifyPort: port,
        verifyLevel: 'tests',
        policy: { ...DEFAULT_POLICY, reviewPolicy: 'all' },
      },
      log,
    );
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    assert.ok(log.indexOf('verify') >= 0);
    assert.ok(log.indexOf('verify') < log.indexOf('append'));
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });

  it('loop-exhausted best-effort output cannot bypass red verification', async () => {
    const claude = provider('claude', [`tentative\n${envelope(0.1)}`, `fixed\n${envelope()}`]);
    const port = verifyPort([red(), green()]);
    const localDeps = deps(
      { claude },
      {
        verifyPort: port,
        verifyLevel: 'tests',
        policy: { ...DEFAULT_POLICY, reviewPolicy: 'off', maxAttempts: 1 },
      },
    );
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    const final = events.at(-1);
    assert.equal(port.calls, 2);
    assert.equal(claude.calls, 2);
    assert.ok(final?.type === 'final');
    assert.equal(final.success, true);
    assert.equal(final.bestEffort, true);
  });

  it('parsed critic revise triggers repair and repeated revise blocks', async () => {
    const claude = provider('claude', [`work\n${envelope()}`, `repaired\n${envelope()}`]);
    const codex = provider('codex', [
      'review\n{"verdict":"revise","notes":"src/a.ts is wrong","confidence":0.9}',
    ]);
    const port = verifyPort([], [], null);
    const localDeps = deps(
      { claude, codex },
      {
        verifyPort: port,
        verifyLevel: 'reviewed',
        authenticatedProviders: ['claude', 'codex'],
      },
    );
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    assert.equal(claude.calls, 2);
    assert.equal(codex.calls, 2);
    assert.equal(assistantEntries(localDeps.entries).length, 0);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, false);
  });

  it('goalTurn bypasses the chat gate entirely', async () => {
    const claude = provider('claude', [`work\n${envelope()}`]);
    const port = verifyPort([red()]);
    const localDeps = deps(
      { claude },
      { verifyPort: port, verifyLevel: 'tests', goalTurn: true },
    );
    const events = await collect(orchestrate('fix a', localDeps, new AbortController().signal));
    assert.equal(port.calls, 0);
    assert.equal(claude.calls, 1);
    assert.equal(assistantEntries(localDeps.entries).length, 1);
    assert.equal(events.at(-1)?.type === 'final' && events.at(-1)?.success, true);
  });
});
