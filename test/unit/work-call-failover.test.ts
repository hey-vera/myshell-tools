import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const LOW_CONFIDENCE =
  'Initial IC result.\n{"confidence":0.2,"escalate":false,"reason":"needs stronger model","needs_review":false}';
const SUCCESS =
  'Recovered through OpenCode.\n{"confidence":0.95,"escalate":false,"reason":"done","needs_review":false}';

function clock(): Clock {
  let now = 1_000;
  let id = 0;
  return {
    now: () => ++now,
    isoNow: () => new Date(0).toISOString(),
    uuid: () => `id-${++id}`,
    random: () => 0.5,
  };
}

function session(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id: 'failover-session',
    async append(entry) {
      entries.push(entry);
    },
    entries,
  };
}

function ledger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(entry) {
      entries.push(entry);
    },
    entries,
  };
}

function provider(
  id: Provider['id'],
  run: (request: ProviderRequest) => ProviderEvent[],
): Provider {
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: 'test',
        authenticated: true,
        binaryPath: `/fake/${id}`,
        availableModels: [],
      };
    },
    async *run(request) {
      for (const event of run(request)) yield event;
    },
  };
}

async function collect(stream: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('work-call provider failover budget', () => {
  it('runs OpenCode after an IC attempt and manager sandbox failure exhaust maxAttempts', async () => {
    const executions: string[] = [];
    let claudeRuns = 0;
    const deps: OrchestrateDeps = {
      providers: {
        claude: provider('claude', (request) => {
          executions.push(`claude:${request.model}`);
          claudeRuns++;
          if (claudeRuns === 1) {
            return [{ type: 'done', text: LOW_CONFIDENCE, raw: {} }];
          }
          return [{
            type: 'error',
            error: {
              category: 'network',
              recoverable: true,
              message: 'manager Claude failed',
              suggestion: 'fail over',
            },
          }];
        }),
        codex: provider('codex', (request) => {
          executions.push(`codex:${request.model}`);
          return [{
            type: 'error',
            error: {
              category: 'sandbox-environment',
              recoverable: true,
              message: 'bwrap sandbox startup failed',
              suggestion: 'use another provider',
            },
          }];
        }),
        opencode: provider('opencode', (request) => {
          executions.push(`opencode:${request.model}`);
          return [{ type: 'done', text: SUCCESS, raw: {} }];
        }),
      },
      clock: clock(),
      session: session(),
      ledger: ledger(),
      policy: {
        ...DEFAULT_POLICY,
        maxAttempts: 3,
        panelPolicy: 'off',
        hedgePolicy: 'off',
        reviewPolicy: 'off',
      },
      authenticatedProviders: ['claude', 'codex', 'opencode'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collect(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const final = events.find((event) => event.type === 'final');

    assert.deepEqual(executions.map((entry) => entry.split(':')[0]), [
      'claude',
      'claude',
      'codex',
      'opencode',
    ]);
    assert.ok(
      events.some(
        (event) => event.type === 'failover' && event.from === 'codex' && event.to === 'opencode',
      ),
      'sandbox failure must fail over from Codex to OpenCode',
    );
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    assert.equal(final.attempts, 4, 'provider failover may exceed the ordinary attempt ceiling');
    assert.match(final.output, /Recovered through OpenCode/);
  });
});
