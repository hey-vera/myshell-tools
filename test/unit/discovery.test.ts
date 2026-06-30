/**
 * test/unit/discovery.test.ts — Adaptive Partner Engine v2, STAGE 4
 * (discovery-driven escalation, adaptive-partner-v2-5.6.md §2.5 D).
 *
 * Two layers:
 *  1. PURE signal extraction (`extractDiscoverySignals`) — each kind from
 *     representative output text + envelope, and NO false positives on a clean
 *     confident answer. Plus the gate predicates.
 *  2. WIRING inside orchestrate — admission bounds hold:
 *     - a discovery → manager escalation respects `authorizeTier`: a free-plan
 *       veto and Efficient (never-auto) BLOCK it; Max admits it.
 *     - a discovery → cross-vendor review needs ≥2 distinct providers (cross-vendor
 *       requirement) and a reviewPolicy that isn't 'off'.
 *     - attempts stay bounded by `policy.maxAttempts`.
 *     - a true product fork → ask path (pre-provider ask_user, zero attempts);
 *       a merely-larger-but-local fix → just-do (no ask, no menu, no escalate).
 *
 * All deps faked in-memory — no live model.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  extractDiscoverySignals,
  discoveryWarrantsManager,
  discoveryWarrantsReview,
  discoveryIsLocalLargerFix,
} from '../../src/core/discovery.ts';
import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../../src/core/policy.ts';
import type { Assessment } from '../../src/core/types.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';

// ===========================================================================
// PART 1 — PURE signal extraction
// ===========================================================================

function assessment(over: Partial<Assessment> = {}): Assessment {
  return { confidence: 0.9, escalate: false, reason: 'done', needsReview: false, ...over };
}

const CLEAN = assessment();

describe('extractDiscoverySignals — larger_bug', () => {
  it('detects a wider root cause (medium confidence by default)', () => {
    const text =
      'The broken button is only a symptom of a deeper bug — the root cause is ' +
      'actually in the shared state reducer.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    const lb = sigs.find((s) => s.kind === 'larger_bug');
    assert.ok(lb, 'expected a larger_bug signal');
    assert.equal(lb.kind === 'larger_bug' && lb.confidence, 'medium');
    assert.ok(lb.kind === 'larger_bug' && lb.evidence.length > 0);
  });

  it('upgrades to high confidence when the model says it verified/traced it', () => {
    const text =
      'After investigating, I traced the root cause: the real bug is in the ' +
      'auth refresh path. I confirmed the root cause is elsewhere.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    const lb = sigs.find((s) => s.kind === 'larger_bug');
    assert.ok(lb && lb.kind === 'larger_bug');
    assert.equal(lb.confidence, 'high');
  });
});

describe('extractDiscoverySignals — cross_cutting_change', () => {
  it('detects a migration requirement', () => {
    const sigs = extractDiscoverySignals('This fix requires a database migration.', CLEAN);
    assert.ok(sigs.some((s) => s.kind === 'cross_cutting_change'));
  });

  it('detects ≥2 named file paths as spread', () => {
    const text = 'The fix touches src/auth/session.ts and src/api/handler.ts.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    const cc = sigs.find((s) => s.kind === 'cross_cutting_change');
    assert.ok(cc && cc.kind === 'cross_cutting_change');
    assert.ok(cc.filesOrAreas.length >= 2);
  });
});

describe('extractDiscoverySignals — wrong_repo_or_missing_context', () => {
  it('detects "I do not see that project here"', () => {
    const text = 'I do not see the heyvera project in the current working directory.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    assert.ok(sigs.some((s) => s.kind === 'wrong_repo_or_missing_context'));
  });

  it('captures an expected repo name when the model names it', () => {
    const text =
      'The requested project is missing. I was looking for `dashboard-app` but it ' +
      'is not present in the current working directory.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    const wr = sigs.find((s) => s.kind === 'wrong_repo_or_missing_context');
    assert.ok(wr && wr.kind === 'wrong_repo_or_missing_context');
    assert.equal(wr.expected, 'dashboard-app');
  });
});

describe('extractDiscoverySignals — high_stakes_surface', () => {
  it('flags a security issue', () => {
    const sigs = extractDiscoverySignals('This is a security vulnerability in the parser.', CLEAN);
    const hs = sigs.find((s) => s.kind === 'high_stakes_surface');
    assert.ok(hs && hs.kind === 'high_stakes_surface');
    assert.equal(hs.area, 'security');
  });

  it('flags auth and de-dupes by area', () => {
    const text = 'The root cause is in the authentication and login session token handling.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    const auths = sigs.filter((s) => s.kind === 'high_stakes_surface' && s.area === 'auth');
    assert.equal(auths.length, 1);
  });

  it('flags a destructive data migration as data area', () => {
    const sigs = extractDiscoverySignals('This needs a destructive migration with data loss risk.', CLEAN);
    assert.ok(sigs.some((s) => s.kind === 'high_stakes_surface' && s.area === 'data'));
  });
});

describe('extractDiscoverySignals — provider_low_confidence (envelope)', () => {
  it('fires on escalate:true', () => {
    const sigs = extractDiscoverySignals('ok', assessment({ escalate: true, reason: 'unsure' }));
    const lc = sigs.find((s) => s.kind === 'provider_low_confidence');
    assert.ok(lc && lc.kind === 'provider_low_confidence');
    assert.equal(lc.reason, 'unsure');
  });

  it('fires on needs_review:true', () => {
    const sigs = extractDiscoverySignals('ok', assessment({ needsReview: true }));
    assert.ok(sigs.some((s) => s.kind === 'provider_low_confidence'));
  });

  it('fires when confidence is below the supplied threshold', () => {
    const sigs = extractDiscoverySignals('ok', assessment({ confidence: 0.3 }), 0.6);
    assert.ok(sigs.some((s) => s.kind === 'provider_low_confidence'));
  });

  it('does NOT fire when confidence is at/above threshold', () => {
    const sigs = extractDiscoverySignals('ok', assessment({ confidence: 0.8 }), 0.6);
    assert.ok(!sigs.some((s) => s.kind === 'provider_low_confidence'));
  });

  it('does NOT second-guess a null (absent) confidence', () => {
    const sigs = extractDiscoverySignals('ok', assessment({ confidence: null }));
    assert.ok(!sigs.some((s) => s.kind === 'provider_low_confidence'));
  });
});

describe('extractDiscoverySignals — NO false positives', () => {
  it('returns [] for a clean, confident, local answer', () => {
    const text =
      'I fixed the broken page by adding the missing null check in the render ' +
      'function. Verified it renders. This was a small, local change.';
    const sigs = extractDiscoverySignals(text, CLEAN);
    assert.deepEqual([...sigs], []);
  });

  it('does not fire larger_bug on a casual mention of "bug"', () => {
    const sigs = extractDiscoverySignals('I fixed the bug in the button handler.', CLEAN);
    assert.ok(!sigs.some((s) => s.kind === 'larger_bug'));
  });

  it('does not fire cross_cutting on a single named file', () => {
    const sigs = extractDiscoverySignals('I edited src/page.tsx and it works.', CLEAN);
    assert.ok(!sigs.some((s) => s.kind === 'cross_cutting_change'));
  });

  it('never throws on malformed input', () => {
    assert.doesNotThrow(() => extractDiscoverySignals('', CLEAN));
    // @ts-expect-error — exercising the fail-soft guard
    assert.doesNotThrow(() => extractDiscoverySignals(null, CLEAN));
  });
});

describe('discovery gate predicates', () => {
  it('discoveryWarrantsManager: cross-cutting / high-stakes / high larger_bug → true', () => {
    assert.equal(discoveryWarrantsManager([{ kind: 'cross_cutting_change', filesOrAreas: ['a'] }]), true);
    assert.equal(discoveryWarrantsManager([{ kind: 'high_stakes_surface', area: 'auth' }]), true);
    assert.equal(
      discoveryWarrantsManager([{ kind: 'larger_bug', evidence: ['x'], confidence: 'high' }]),
      true,
    );
  });

  it('discoveryWarrantsManager: a medium larger_bug alone → false (local)', () => {
    assert.equal(
      discoveryWarrantsManager([{ kind: 'larger_bug', evidence: ['x'], confidence: 'medium' }]),
      false,
    );
  });

  it('discoveryIsLocalLargerFix: medium larger_bug, no cross/high/wrong-repo → true', () => {
    assert.equal(
      discoveryIsLocalLargerFix([{ kind: 'larger_bug', evidence: ['x'], confidence: 'medium' }]),
      true,
    );
  });

  it('discoveryWarrantsReview: high-stakes → true; low-confidence alone → false', () => {
    assert.equal(discoveryWarrantsReview([{ kind: 'high_stakes_surface', area: 'data' }]), true);
    assert.equal(discoveryWarrantsReview([{ kind: 'provider_low_confidence', reason: 'x' }]), false);
  });
});

// ===========================================================================
// PART 2 — WIRING inside orchestrate (admission bounds)
// ===========================================================================

function makeFakeClock(): Clock {
  const now = 1_000_000;
  let n = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `uuid-${++n}`,
    random: () => 0.42,
  } as Clock;
}
function makeFakeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'sess-1', async append(e) { entries.push(e); }, entries };
}
function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { async record(e) { entries.push(e); }, entries };
}

const FAKE_USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

/** A confident envelope — assess() parses it, so no low-confidence signal fires. */
const CONF = '{"confidence": 0.92, "escalate": false, "reason": "done", "needs_review": false}';

/**
 * A high/critical-discovery answer: a VERIFIED wider root cause in shared AUTH
 * code (so discoveryWarrantsManager + discoveryWarrantsReview are both true), with
 * a confident envelope (so the ONLY escalation driver is the discovery, not low
 * confidence — this isolates the discovery wiring).
 */
const DISCOVERY_ANSWER =
  'I investigated the broken page. After tracing it, I confirmed the root cause ' +
  'is elsewhere: the real bug is in the shared authentication session handling, ' +
  'and the fix touches src/auth/session.ts and src/api/handler.ts.\n' + CONF;

/** A clean, local, confident answer — no discovery signals at all. */
const CLEAN_ANSWER = `I fixed the broken page with a small local null check. Done.\n${CONF}`;

/** A merely-larger-BUT-LOCAL discovery: medium larger_bug, no cross/high/wrong-repo. */
const LOCAL_LARGER_ANSWER =
  'The broken page is only a symptom of a deeper bug in this same component; I ' +
  `fixed the underlying problem locally in the render path. Done.\n${CONF}`;

function scriptedProvider(
  id: 'claude' | 'codex',
  texts: readonly string[],
): Provider & { calls: number } {
  const obj = {
    id,
    calls: 0,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const text = texts[Math.min(obj.calls, texts.length - 1)] ?? '';
      obj.calls++;
      yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
    },
  };
  return obj as unknown as Provider & { calls: number };
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: scriptedProvider('claude', [DISCOVERY_ANSWER]) },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    ...over,
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('orchestrate — discovery → manager escalation respects authorizeTier', () => {
  it('Efficient (never-auto) does NOT escalate to manager on a discovery', async () => {
    const provider = scriptedProvider('claude', [DISCOVERY_ANSWER]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude: provider },
          policy: POLICY_PRESETS['cost-saver'],
          authenticatedProviders: ['claude'],
        }),
        new AbortController().signal,
      ),
    );
    const escalatedToManager = events.some(
      (e) => e.type === 'escalate' && e.to === 'manager',
    );
    assert.equal(escalatedToManager, false, 'Efficient must never auto-open the flagship');
  });

  it('free-plan veto blocks the discovery escalation under Balanced', async () => {
    const provider = scriptedProvider('claude', [DISCOVERY_ANSWER]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude: provider },
          policy: POLICY_PRESETS['balanced'],
          authenticatedProviders: ['claude'],
          planInfos: { claude: { raw: 'free', tier: 'free', confidence: 'observed' } },
        }),
        new AbortController().signal,
      ),
    );
    const escalatedToManager = events.some(
      (e) => e.type === 'escalate' && e.to === 'manager',
    );
    assert.equal(escalatedToManager, false, 'an observed free plan must veto the flagship');
  });

  it('Max admits the discovery-driven escalation to manager', async () => {
    // Two providers so escalation to manager runs a real second attempt; the
    // second attempt returns a clean answer so the loop terminates.
    const claude = scriptedProvider('claude', [DISCOVERY_ANSWER, CLEAN_ANSWER]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude },
          policy: POLICY_PRESETS['quality-first'],
          authenticatedProviders: ['claude'],
        }),
        new AbortController().signal,
      ),
    );
    const esc = events.find((e) => e.type === 'escalate' && e.to === 'manager');
    assert.ok(esc, 'Max should admit the discovery escalation to manager');
    assert.ok(
      esc && esc.type === 'escalate' && /discovery/.test(esc.reason),
      'the escalate reason should name the discovery',
    );
  });
});

describe('orchestrate — discovery → cross-vendor review needs 2 providers + policy', () => {
  it('runs a cross-vendor review when a second distinct provider is authenticated', async () => {
    const claude = scriptedProvider('claude', [DISCOVERY_ANSWER]);
    const codex = scriptedProvider('codex', [
      // reviewer verdict — approve so the turn accepts
      '{"verdict": "approve", "notes": "looks correct"}',
    ]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude, codex },
          policy: POLICY_PRESETS['quality-first'],
          authenticatedProviders: ['claude', 'codex'],
        }),
        new AbortController().signal,
      ),
    );
    const reviewed = events.some(
      (e) => e.type === 'notice' && /Review by codex \(cross-vendor\)/.test(e.message),
    );
    assert.equal(reviewed, true, 'a discovery + 2 providers should trigger cross-vendor review');
    assert.equal(codex.calls, 1, 'the reviewer (codex) must actually run');
  });

  it('does NOT review with only one provider (cross-vendor requirement)', async () => {
    const claude = scriptedProvider('claude', [DISCOVERY_ANSWER, CLEAN_ANSWER]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude },
          policy: POLICY_PRESETS['quality-first'],
          authenticatedProviders: ['claude'],
        }),
        new AbortController().signal,
      ),
    );
    const reviewed = events.some(
      (e) => e.type === 'notice' && /cross-vendor/.test(e.message),
    );
    assert.equal(reviewed, false, 'no second vendor → no cross-vendor review');
  });

  it('does NOT review when reviewPolicy is off, even on a discovery', async () => {
    const claude = scriptedProvider('claude', [DISCOVERY_ANSWER, CLEAN_ANSWER]);
    const codex = scriptedProvider('codex', ['{"verdict":"approve","notes":"x"}']);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude, codex },
          policy: { ...POLICY_PRESETS['quality-first'], reviewPolicy: 'off' },
          authenticatedProviders: ['claude', 'codex'],
        }),
        new AbortController().signal,
      ),
    );
    const reviewed = events.some(
      (e) => e.type === 'notice' && /cross-vendor/.test(e.message),
    );
    assert.equal(reviewed, false, 'reviewPolicy off must suppress discovery-driven review');
  });
});

describe('orchestrate — attempts bounded by maxAttempts', () => {
  it('never exceeds policy.maxAttempts even when every attempt yields a discovery', async () => {
    const maxAttempts = 2;
    // Always returns the escalating discovery answer — discovery wants to escalate
    // every attempt; the loop must still stop at maxAttempts.
    const claude = scriptedProvider('claude', [DISCOVERY_ANSWER]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude },
          policy: { ...POLICY_PRESETS['quality-first'], maxAttempts },
          authenticatedProviders: ['claude'],
        }),
        new AbortController().signal,
      ),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final && final.type === 'final');
    assert.ok(final.attempts <= maxAttempts, `attempts ${final.attempts} must be ≤ ${maxAttempts}`);
    assert.ok(claude.calls <= maxAttempts, `provider runs ${claude.calls} must be ≤ ${maxAttempts}`);
  });
});

describe('orchestrate — product fork → ask vs larger-but-local → just-do', () => {
  it('a true product fork is asked BEFORE any provider run (zero attempts)', async () => {
    const provider = scriptedProvider('claude', [DISCOVERY_ANSWER]);
    // A genuine, NON-investigable product/preference fork (tone of the launch
    // copy) — the kind §2.5 D says to ASK, not the kind a codebase could resolve.
    const frame: IntentFrame = {
      version: 1,
      goal: 'write the launch announcement copy',
      kind: 'product',
      confidence: 'low',
      forks: [
        {
          id: 'F1',
          question: 'Which tone do you prefer for the launch announcement?',
          options: ['Playful', 'Formal'],
          assumeIfUnasked: 'Playful',
        },
      ],
      source: 'model',
    };
    const events = await collect(
      orchestrate(
        'write the launch announcement copy for the whole product team and the press',
        baseDeps({
          providers: { claude: provider },
          intentExtractor: async () => frame,
          partnerStyle: 'collaborative',
        }),
        new AbortController().signal,
      ),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final && final.type === 'final');
    assert.ok(final.questions !== undefined, 'a product fork must surface questions');
    assert.equal(final.attempts, 0, 'a pre-provider ask runs zero provider attempts');
    assert.equal(provider.calls, 0, 'the provider must never run for a pre-provider ask');
  });

  it('a merely-larger-but-LOCAL fix is just done — no escalate, no ask, no menu', async () => {
    const provider = scriptedProvider('claude', [LOCAL_LARGER_ANSWER]);
    const events = await collect(
      orchestrate(
        'fix the broken page',
        baseDeps({
          providers: { claude: provider },
          // Balanced: a discovery COULD escalate if warranted — proving a local
          // larger fix does NOT escalate is the point.
          policy: POLICY_PRESETS['balanced'],
          authenticatedProviders: ['claude'],
        }),
        new AbortController().signal,
      ),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final && final.type === 'final');
    assert.equal(final.success, true, 'the local larger fix is accepted as-is');
    assert.ok(final.questions === undefined, 'a local larger fix must not ask the user');
    assert.equal(
      events.some((e) => e.type === 'escalate'),
      false,
      'a local larger fix must not escalate',
    );
    assert.equal(provider.calls, 1, 'the local larger fix is one clean run');
  });
});
