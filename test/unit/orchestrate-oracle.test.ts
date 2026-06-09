/**
 * test/unit/orchestrate-oracle.test.ts — the ORACLE move: route a SUBSTANTIAL /
 * explanatory / plan / insight turn's MAIN REASONING to the user's strongest
 * admissible model, while leaving trivial / everyday turns on the normal, cheap
 * tier (the cost / fast-path proof).
 *
 * The Oracle is a PURE ROUTING decision in orchestrate() — no new model call, no
 * new prompt. It lifts THIS turn's tier request to manager BEFORE route() resolves,
 * gated by `directive.substantial` (the same isTrivial-exempt predicate the
 * explanatory-depth directive + grounded-recommendation validator use) AND by the
 * existing `admitManager`/`authorizeTier` machinery (mode + per-turn flagship budget
 * + free-plan veto). The observable proof is the emitted `tier-start` event (which
 * the UI renders), so the user can SEE the strong model was used.
 *
 * Verifies:
 *  - Max + substantial DECISION turn → escalates to the flagship (manager/opus);
 *  - Max + TRIVIAL turn → stays on the normal tier (cost / fast-path: NOT escalated);
 *  - Max + plain IMPLEMENT turn (not substantial) → stays on the normal tier;
 *  - Efficient + substantial DECISION turn → never escalates (never-auto);
 *  - Balanced + low-risk substantial DECISION turn → stays normal (conservative);
 *  - Max + substantial turn but flagship UNAVAILABLE (no flagship provider) → falls
 *    back gracefully to the best available model (never strands, never throws).
 *
 * All dependencies are faked in-memory — no network, no fs, no child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { POLICY_PRESETS } from '../../src/core/policy.ts';
import type { Mode } from '../../src/core/policy.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
  Tier,
} from '../../src/core/types.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';

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
    id: 'sess-oracle',
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

/** A provider (claude by default) that records every request it runs. */
function makeRecording(id: Provider['id']): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    id,
    requests,
    async detect() {
      return {
        id,
        installed: true,
        version: '1.0.0',
        authenticated: true,
        binaryPath: `/usr/bin/${id}`,
        availableModels: [],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: 'done', text: `ok\n${ENVELOPE}`, usage: USAGE, raw: {} };
    },
  } as Provider & { requests: ProviderRequest[] };
}

async function firstTierStart(gen: AsyncGenerator<CoreEvent>): Promise<{
  tier: Tier;
  provider: string;
  model: string;
} | undefined> {
  for await (const ev of gen) {
    if (ev.type === 'tier-start') {
      return { tier: ev.tier, provider: ev.provider, model: ev.model };
    }
  }
  return undefined;
}

function makeDeps(mode: Mode, provider: Provider): OrchestrateDeps {
  return {
    providers: { [provider.id]: provider },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: POLICY_PRESETS[mode],
    cwd: '/fake',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    authenticatedProviders: [provider.id],
  } as OrchestrateDeps;
}

// A genuinely SUBSTANTIAL decision/insight turn (decision-shaped lexicon: "Should
// we X or Y") — the kind that warrants the strongest brain.
const DECISION_TASK = 'Should we use Redux or React Context for the app state?';
// A TRIVIAL / everyday lookup turn — must stay on the cheap fast path.
const TRIVIAL_TASK = 'what time is it';
// A plain implementation chore — NOT decision-shaped → not substantial → no escalation.
const IMPL_TASK = 'add a logout button to the navbar';

describe('orchestrate ORACLE — substantial turns reach the flagship, trivial turns do not', () => {
  it('Max + substantial DECISION turn → escalates to the flagship (manager)', async () => {
    const claude = makeRecording('claude');
    const start = await firstTierStart(
      orchestrate(DECISION_TASK, makeDeps('quality-first', claude), new AbortController().signal),
    );
    assert.ok(start, 'a tier-start was emitted');
    assert.strictEqual(start?.tier, 'manager', 'Oracle routed the substantial turn to the flagship tier');
    assert.match(start?.model ?? '', /opus/i, 'the strong (opus) model was selected and is visible');
  });

  it('Max + TRIVIAL turn → stays on the normal tier (cost / fast-path proof)', async () => {
    const claude = makeRecording('claude');
    const start = await firstTierStart(
      orchestrate(TRIVIAL_TASK, makeDeps('quality-first', claude), new AbortController().signal),
    );
    assert.ok(start, 'a tier-start was emitted');
    assert.notStrictEqual(start?.tier, 'manager', 'a trivial turn is NEVER escalated to the flagship');
    assert.doesNotMatch(start?.model ?? '', /opus/i, 'a trivial turn does not burn the strong model');
  });

  it('Max + plain IMPLEMENT turn (not substantial) → stays on the normal tier', async () => {
    const claude = makeRecording('claude');
    const start = await firstTierStart(
      orchestrate(IMPL_TASK, makeDeps('quality-first', claude), new AbortController().signal),
    );
    assert.ok(start, 'a tier-start was emitted');
    assert.notStrictEqual(start?.tier, 'manager', 'a plain implement turn is not a substantial/insight turn');
  });

  it('Efficient + substantial DECISION turn → never escalates (never-auto)', async () => {
    const claude = makeRecording('claude');
    const start = await firstTierStart(
      orchestrate(DECISION_TASK, makeDeps('cost-saver', claude), new AbortController().signal),
    );
    assert.ok(start, 'a tier-start was emitted');
    assert.notStrictEqual(start?.tier, 'manager', 'Efficient never auto-opens the flagship for the Oracle');
  });

  it('Balanced + low-risk substantial DECISION turn → stays normal (conservative, quota-aware)', async () => {
    const claude = makeRecording('claude');
    const start = await firstTierStart(
      orchestrate(DECISION_TASK, makeDeps('balanced', claude), new AbortController().signal),
    );
    assert.ok(start, 'a tier-start was emitted');
    assert.notStrictEqual(
      start?.tier,
      'manager',
      'Balanced only escalates the Oracle on an ALSO high-risk / low-confidence turn',
    );
  });

  it('Max + substantial turn but flagship UNAVAILABLE → falls back gracefully (no strand, no throw)', async () => {
    // opencode has no Claude/Codex flagship; route() must still resolve a usable
    // model at the requested manager tier rather than strand the turn.
    const opencode = makeRecording('opencode');
    const start = await firstTierStart(
      orchestrate(DECISION_TASK, makeDeps('quality-first', opencode), new AbortController().signal),
    );
    assert.ok(start, 'a tier-start was emitted — the turn was never stranded');
    assert.strictEqual(start?.provider, 'opencode', 'fell back to the only available provider');
    assert.ok((start?.model ?? '').length > 0, 'a concrete model was resolved');
  });
});
