import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { createIntentStore, readIntentVersions } from '../../src/infra/intent-store.ts';
import { getIntentVersionsFile } from '../../src/infra/paths.ts';
import type { IntentStoreWriter, IntentVersion } from '../../src/core/intent-version.ts';
import type { SemanticPreflightV1 } from '../../src/core/semantic-preflight.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest, Usage } from '../../src/providers/port.ts';

const ENVELOPE = '{"confidence":0.93,"escalate":false,"reason":"done","needs_review":false}';
const USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

function fakeClock(): Clock {
  let uuid = 0;
  return {
    now: () => 1_000,
    isoNow: () => '2026-07-02T00:00:00.000Z',
    uuid: () => {
      uuid++;
      return `uuid-${uuid}`;
    },
    random: () => 0.5,
  };
}

function semantic(overrides: Partial<SemanticPreflightV1> = {}): SemanticPreflightV1 {
  return {
    version: 1,
    objective: 'fix dashboard totals',
    taskShape: { kind: 'change', scope: 'single-step', mutatesWorkspace: true },
    route: { tier: 'ic', plan: false, rationale: 'contained implementation' },
    risk: { level: 'medium', reasons: ['touches calculation output'] },
    uncertainty: { level: 'low', reasons: [], forks: [] },
    evidenceNeeded: [
      {
        id: 'E1',
        kind: 'local-code',
        phase: 'before-execution',
        query: 'inspect dashboard total calculation',
        required: true,
      },
    ],
    doneCondition: { status: 'specified', text: 'dashboard totals are correct' },
    planSteps: [{ text: 'Inspect total calculation' }],
    proposedExecution: { provider: 'auto', effort: 'medium', rationale: 'advisory only' },
    source: 'model',
    ...overrides,
  };
}

function fakeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'sess-1', async append(entry) { entries.push(entry); }, entries };
}

function fakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { async record(entry) { entries.push(entry); }, entries };
}

function workProvider(): Provider & { workRuns: number } {
  const provider = {
    id: 'claude' as const,
    workRuns: 0,
    async detect() {
      return { id: 'claude' as const, installed: true, version: '1', authenticated: true, availableModels: [] };
    },
    async *run(_request: ProviderRequest): AsyncIterable<ProviderEvent> {
      provider.workRuns++;
      yield { type: 'done', text: `Done.\n${ENVELOPE}`, usage: USAGE, raw: {} };
    },
  };
  return provider;
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function depsFor(cwd: string, intentStore: IntentStoreWriter, provider = workProvider()): OrchestrateDeps {
  return {
    providers: { claude: provider },
    clock: fakeClock(),
    session: fakeSession(),
    ledger: fakeLedger(),
    policy: { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } },
    cwd,
    sandbox: 'workspace-write',
    timeoutMs: 20_000,
    intentStore,
    semanticPreflightV1: true,
  };
}

async function readRawIntentLines(cwd: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(getIntentVersionsFile(cwd), 'utf8');
    return raw.split('\n').filter((line) => line.length > 0);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return [];
    throw err;
  }
}

describe('semantic preflight intent persistence', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'myshell-semantic-persist-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('semantic turn appends one row with objective evidence done risk task shape and proposal', async () => {
    const store = createIntentStore({ cwd });
    const deps = depsFor(cwd, store);
    deps.semanticPreflightExtractor = async () => ({ result: semantic() });

    await collect(orchestrate('fix the dashboard totals carefully', deps, new AbortController().signal));

    const rows = await readIntentVersions(cwd);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].intent.objective, 'fix dashboard totals');
    assert.equal(rows[0].intent.doneCriteria, 'dashboard totals are correct');
    assert.equal(rows[0].intent.risk, 'medium');
    assert.equal(rows[0].semanticPreflight?.objective, 'fix dashboard totals');
    assert.equal(rows[0].semanticPreflight?.taskShape.kind, 'change');
    assert.equal(rows[0].semanticPreflight?.evidenceNeeded[0]?.query, 'inspect dashboard total calculation');
    assert.equal(rows[0].semanticPreflight?.doneCondition.status, 'specified');
    assert.equal(rows[0].semanticPreflight?.risk.level, 'medium');
    assert.equal(rows[0].semanticPreflight?.proposedExecution.effort, 'medium');

    const lines = await readRawIntentLines(cwd);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.length < 8 * 1024);
    assert.doesNotThrow(() => JSON.parse(lines[0]!));
  });

  it('parse failure persists honest fallback with unknown done condition', async () => {
    const store = createIntentStore({ cwd });
    const deps = depsFor(cwd, store);
    let semanticCalls = 0;
    deps.semanticPreflightExtractor = async () => {
      semanticCalls++;
      return null;
    };

    await collect(orchestrate('fix the dashboard totals carefully', deps, new AbortController().signal));

    const rows = await readIntentVersions(cwd);
    assert.equal(semanticCalls, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].semanticPreflight?.source, 'rules-fallback');
    assert.deepEqual(
      rows[0].semanticPreflight?.doneCondition,
      { status: 'unknown', reason: 'semantic-preflight-unavailable' },
    );
  });

  it('append rejection does not block work or duplicate preflight', async () => {
    const provider = workProvider();
    let appendCalls = 0;
    let semanticCalls = 0;
    const rejectingStore: IntentStoreWriter = {
      append: async (_version: IntentVersion) => {
        appendCalls++;
        throw new Error('injected append rejection');
      },
    };
    const deps = depsFor(cwd, rejectingStore, provider);
    deps.semanticPreflightExtractor = async () => {
      semanticCalls++;
      return { result: semantic() };
    };

    await collect(orchestrate('fix the dashboard totals carefully', deps, new AbortController().signal));

    assert.equal(semanticCalls, 1);
    assert.equal(appendCalls, 1);
    assert.equal(provider.workRuns, 1);
  });

  it('abort before persistence appends nothing', async () => {
    const ac = new AbortController();
    let appendCalls = 0;
    let semanticCalls = 0;
    const store: IntentStoreWriter = {
      append: async () => {
        appendCalls++;
      },
    };
    const deps = depsFor(cwd, store);
    deps.semanticPreflightExtractor = async () => {
      semanticCalls++;
      ac.abort();
      return { result: semantic() };
    };

    const events = await collect(orchestrate('fix the dashboard totals carefully', deps, ac.signal));

    assert.equal(semanticCalls, 1);
    assert.equal(appendCalls, 0);
    assert.equal(events.some((event) => event.type === 'final' && event.canceled === true), true);
  });

  it('injected throw between build and append leaves no partial JSONL line', async () => {
    let appendCalls = 0;
    const throwingStore: IntentStoreWriter = {
      append: async () => {
        appendCalls++;
        throw new Error('injected atomic append boundary');
      },
    };
    const deps = depsFor(cwd, throwingStore);
    deps.semanticPreflightExtractor = async () => ({ result: semantic() });

    await collect(orchestrate('fix the dashboard totals carefully', deps, new AbortController().signal));

    assert.equal(appendCalls, 1);
    const lines = await readRawIntentLines(cwd);
    assert.equal(lines.length, 0);
  });
});
