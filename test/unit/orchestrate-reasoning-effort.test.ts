/**
 * test/unit/orchestrate-reasoning-effort.test.ts — Stage-3 wiring tests for the
 * capability registry's reasoning-effort selector inside orchestrate().
 *
 * Verifies:
 *  - registry ABSENT → the work ProviderRequest carries NO reasoningEffort and the
 *    ledger entry records none (the #1 non-regression bar);
 *  - registry PRESENT with a Codex model declaring efforts → the work request AND
 *    the ledger entry carry the selected effort (xhigh for a Max manager
 *    architecture turn);
 *  - a registry whose chosen model declares NO efforts → still no effort threaded.
 *
 * All dependencies are faked in-memory — no network, no fs, no child process.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { POLICY_PRESETS } from '../../src/core/policy.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';
import type { CapabilityRegistry } from '../../src/core/model-capabilities.ts';

function makeFakeClock(): Clock {
  const now = 1_000_000;
  let uuid = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `uuid-${++uuid}`,
    random: () => 0.42,
  };
}

function makeFakeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id: 'sess-1',
    async append(e) {
      entries.push(e);
    },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(e) {
      entries.push(e);
    },
    entries,
  };
}

const ENVELOPE =
  '{"confidence": 0.95, "escalate": false, "reason": "done", "needs_review": false}';
const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

/** A codex provider that records every request it is asked to run. */
function makeRecordingCodex(): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider: Provider & { requests: ProviderRequest[] } = {
    id: 'codex',
    requests,
    async detect() {
      return {
        id: 'codex',
        installed: true,
        version: '1.0.0',
        authenticated: true,
        binaryPath: '/usr/bin/codex',
        availableModels: [],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: 'done', text: `Designed the migration.\n${ENVELOPE}`, usage: USAGE, raw: {} };
    },
  };
  return provider;
}

/** Codex registry declaring gpt-5.5 supports the full effort ladder. */
const CODEX_XHIGH_REGISTRY: CapabilityRegistry = {
  claude: [],
  codex: [
    {
      provider: 'codex',
      id: 'gpt-5.5',
      aliases: [],
      tierHint: 'manager',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      source: ['codex-cache'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.4',
      aliases: [],
      tierHint: 'ic',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      source: ['codex-cache'],
    },
  ],
  opencode: [],
};

/** Codex registry where the models declare NO efforts (unknown effort metadata). */
const CODEX_NO_EFFORT_REGISTRY: CapabilityRegistry = {
  claude: [],
  codex: [
    { provider: 'codex', id: 'gpt-5.5', aliases: [], tierHint: 'manager', supportedReasoningEfforts: [], source: ['declarative'] },
    { provider: 'codex', id: 'gpt-5.4', aliases: [], tierHint: 'ic', supportedReasoningEfforts: [], source: ['declarative'] },
  ],
  opencode: [],
};

async function drain(gen: AsyncGenerator<CoreEvent>): Promise<void> {
  for await (const _ of gen) {
    void _;
  }
}

const ARCH_TASK =
  'Design the architecture and migration plan for splitting the monolith into services.';

describe('orchestrate Stage-3 wiring — reasoning effort threaded to provider + ledger', () => {
  let codex: ReturnType<typeof makeRecordingCodex>;
  let session: ReturnType<typeof makeFakeSession>;
  let ledger: ReturnType<typeof makeFakeLedger>;
  let baseDeps: OrchestrateDeps;

  beforeEach(() => {
    codex = makeRecordingCodex();
    session = makeFakeSession();
    ledger = makeFakeLedger();
    baseDeps = {
      providers: { codex },
      clock: makeFakeClock(),
      session,
      ledger,
      // Max: opens the manager tier so an architecture turn earns the flagship.
      policy: POLICY_PRESETS['quality-first'],
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['codex'],
    };
  });

  it('registry ABSENT → no reasoningEffort on the request or ledger (non-regression)', async () => {
    await drain(orchestrate(ARCH_TASK, baseDeps, new AbortController().signal));

    assert.ok(codex.requests.length >= 1, 'codex ran at least once');
    for (const req of codex.requests) {
      assert.strictEqual(req.reasoningEffort, undefined, 'no effort without a registry');
    }
    for (const e of ledger.entries) {
      assert.strictEqual(
        Object.hasOwn(e, 'reasoningEffort'),
        false,
        'ledger entry carries no effort field without a registry',
      );
    }
  });

  it('registry PRESENT (Max manager architecture, codex supports xhigh) → xhigh on request + ledger', async () => {
    const deps: OrchestrateDeps = { ...baseDeps, capabilityRegistry: CODEX_XHIGH_REGISTRY };
    await drain(orchestrate(ARCH_TASK, deps, new AbortController().signal));

    assert.ok(codex.requests.length >= 1, 'codex ran');
    const workReq = codex.requests[0];
    assert.strictEqual(workReq?.reasoningEffort, 'xhigh', 'work request used xhigh');

    const workEntry = ledger.entries[0];
    assert.strictEqual(workEntry?.reasoningEffort, 'xhigh', 'ledger recorded xhigh');
  });

  it('registry PRESENT but model declares NO efforts → still no effort threaded', async () => {
    const deps: OrchestrateDeps = { ...baseDeps, capabilityRegistry: CODEX_NO_EFFORT_REGISTRY };
    await drain(orchestrate(ARCH_TASK, deps, new AbortController().signal));

    for (const req of codex.requests) {
      assert.strictEqual(req.reasoningEffort, undefined, 'no effort when model has none');
    }
  });
});
