/**
 * test/unit/ap2-hardening.test.ts — AP2-F / Stage 6 (adaptive-partner-v2-5.6.md §3,
 * §4 Stage 6): native-session + stale-history hardening.
 *
 * Covers exactly the §4 Stage-6 unit gate:
 *   - planNativeSession respects quarantine (poisoned/legacy history → no resume
 *     plan for the poisoned provider; clean history → unchanged native behavior).
 *   - decideHistoryPolicy quarantines on BOTH axes: an obvious generic menu (text),
 *     AND a pre-fix engine entry (version absent/below current) even when its text
 *     is not a menu — while leaving clean current-engine history `normal`.
 *   - the engine-behavior version marker round-trips through the conversation-store
 *     guards, and an absent marker is treated as legacy (still loads, quarantine
 *     candidate).
 *
 * Run: node --import ./test/register.mjs --test "test/unit/ap2-hardening.test.ts"
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planNativeSession } from '../../src/core/native-session.ts';
import { decideHistoryPolicy } from '../../src/core/turn-directive.ts';
import {
  ENGINE_BEHAVIOR_VERSION,
  isLegacyEngineEntry,
} from '../../src/core/engine-version.ts';
import { isSessionEntry } from '../../src/infra/jsonl-guards.ts';
import { createFileConversationStore } from '../../src/infra/conversations.ts';
import type { Clock, SessionEntry } from '../../src/core/types.ts';
import type { HistoryPolicy } from '../../src/core/turn-directive.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GENERIC_MENU =
  'What are you trying to do — fix something, add a feature, or polish the layout?';
const CLEAN_PROSE = 'I added the route in src/app.ts; tests pass.';

const userTurn: SessionEntry = { timestamp: 't0', role: 'user', content: 'hi' };
const claudeTurn: SessionEntry = {
  timestamp: 't1',
  role: 'assistant',
  content: 'hello',
  provider: 'claude',
};

const quarantine: HistoryPolicy = {
  replayMode: 'quarantine_assistant_prose',
  reasons: ['test'],
};
const normal: HistoryPolicy = { replayMode: 'normal', reasons: [] };

function makeFakeClock(fixedIso = '2024-01-01T00:00:00.000Z'): Clock {
  let counter = 0;
  return {
    now: () => new Date(fixedIso).getTime(),
    isoNow: () => fixedIso,
    uuid: () => `00000000-0000-0000-0000-${String((counter += 1)).padStart(12, '0')}`,
    random: () => 0.5,
  };
}

// ---------------------------------------------------------------------------
// planNativeSession respects quarantine (§4 Stage-6)
// ---------------------------------------------------------------------------

describe('planNativeSession — quarantine hardening (AP2-F §3)', () => {
  it('clean history → UNCHANGED native behavior (Claude plan present, resume after prior turn)', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn],
      historyPolicy: normal,
    });
    const claude = plans.find((p) => p.provider === 'claude');
    assert.ok(claude !== undefined, 'a clean turn still plans a native Claude session');
    assert.equal(claude.resume, true, 'resumes the established session as before');
  });

  it('absent policy → UNCHANGED native behavior (backward-compatible)', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn],
    });
    assert.ok(plans.find((p) => p.provider === 'claude') !== undefined);
  });

  it('quarantined turn → does NOT return a resume plan for the poisoned provider', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn],
      historyPolicy: quarantine,
    });
    assert.deepEqual(plans, [], 'no native plan → orchestrate replays the cleaned history');
  });

  it('quarantine never re-enables a disabled feature (still [] when disabled)', () => {
    assert.deepEqual(
      planNativeSession({
        enabled: false,
        conversationId: 'conv-1',
        history: [claudeTurn],
        historyPolicy: quarantine,
      }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// decideHistoryPolicy — both axes; clean current-engine stays normal
// ---------------------------------------------------------------------------

describe('decideHistoryPolicy — version axis (AP2-F §3)', () => {
  it('current-engine clean prose (marker = current version) stays normal', () => {
    const p = decideHistoryPolicy([
      { content: CLEAN_PROSE, engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION },
    ]);
    assert.equal(p.replayMode, 'normal');
  });

  it('purely-clean LEGACY prose (no marker, no menu) stays normal — continuity preserved', () => {
    // A missing marker ALONE never quarantines a clean transcript (backward-compat:
    // existing resumed chats keep continuity). The version axis only WIDENS an
    // already-triggered (text-axis) quarantine.
    const p = decideHistoryPolicy([
      { content: 'Sure, here is a paragraph of ordinary prose with no question.' },
    ]);
    assert.equal(p.replayMode, 'normal');
  });

  it('VERSION axis WIDENS the quarantine: a menu + a legacy clean turn → both flagged', () => {
    const p = decideHistoryPolicy([
      { content: 'older engine prose, not itself a menu' }, // legacy, no marker
      { content: GENERIC_MENU, engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION - 1 }, // the menu
    ]);
    assert.equal(p.replayMode, 'quarantine_assistant_prose');
    assert.ok(p.reasons.some((r) => r.includes('generic open menu')));
    assert.ok(
      p.reasons.some((r) => r.includes('pre-fix')),
      'the legacy clean prose is widened into the quarantine',
    );
  });

  it('a menu among CURRENT-engine turns quarantines (text axis) but does NOT widen to clean current prose', () => {
    const p = decideHistoryPolicy([
      { content: CLEAN_PROSE, engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION },
      { content: GENERIC_MENU, engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION },
    ]);
    assert.equal(p.replayMode, 'quarantine_assistant_prose');
    assert.ok(!p.reasons.some((r) => r.includes('pre-fix')), 'no legacy prose → no widening');
  });

  it('still quarantines an obvious generic menu even when stamped current (text axis)', () => {
    const p = decideHistoryPolicy([
      { content: GENERIC_MENU, engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION },
    ]);
    assert.equal(p.replayMode, 'quarantine_assistant_prose');
    assert.ok(p.reasons.some((r) => r.includes('generic open menu')));
  });

  it('bare-string form (Stage 1) is unchanged: text axis only', () => {
    assert.equal(decideHistoryPolicy([CLEAN_PROSE]).replayMode, 'normal');
    assert.equal(decideHistoryPolicy([GENERIC_MENU]).replayMode, 'quarantine_assistant_prose');
  });
});

describe('isLegacyEngineEntry', () => {
  it('absent marker → legacy', () => assert.equal(isLegacyEngineEntry(undefined), true));
  it('below current → legacy', () =>
    assert.equal(isLegacyEngineEntry(ENGINE_BEHAVIOR_VERSION - 1), true));
  it('current → not legacy', () =>
    assert.equal(isLegacyEngineEntry(ENGINE_BEHAVIOR_VERSION), false));
  it('NaN/non-finite → legacy (fail-safe)', () =>
    assert.equal(isLegacyEngineEntry(Number.NaN), true));
});

// ---------------------------------------------------------------------------
// Engine-version marker round-trips through the store guard; absent = legacy
// ---------------------------------------------------------------------------

describe('engineBehaviorVersion — guard + store round-trip (AP2-F §3)', () => {
  it('isSessionEntry accepts a present finite marker AND an absent one', () => {
    assert.equal(
      isSessionEntry({
        timestamp: 't',
        role: 'assistant',
        content: 'x',
        engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION,
      }),
      true,
      'present marker loads',
    );
    assert.equal(
      isSessionEntry({ timestamp: 't', role: 'assistant', content: 'x' }),
      true,
      'absent marker = legacy, still loads',
    );
  });

  it('isSessionEntry rejects a non-finite marker (dropped, not coerced)', () => {
    assert.equal(
      isSessionEntry({
        timestamp: 't',
        role: 'assistant',
        content: 'x',
        engineBehaviorVersion: 'nope',
      }),
      false,
    );
  });

  it('a marker written to the JSONL log round-trips through store.load(); legacy lines still load', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ap2f-store-'));
    after(async () => {
      await rm(home, { recursive: true, force: true });
    });
    const store = createFileConversationStore({ homeDir: home, clock: makeFakeClock() });
    const meta = await store.create('round-trip');

    // A legacy assistant line (no marker) written directly, then a current-engine
    // line via the writer (stamped by hand to mirror orchestrate's persist).
    const dir = join(home, '.myshell-tools', 'conversations');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${meta.id}.jsonl`);
    // A legacy menu line (no marker, the poisoning signal) + a legacy clean line
    // (no marker, not a menu), then a current-engine line (stamped).
    const legacyMenu: SessionEntry = { timestamp: 't0', role: 'assistant', content: GENERIC_MENU };
    await writeFile(file, JSON.stringify(legacyMenu) + '\n', 'utf8');
    const legacyClean: SessionEntry = {
      timestamp: 't1',
      role: 'assistant',
      content: 'legacy clean answer with no question',
    };
    await appendFile(file, JSON.stringify(legacyClean) + '\n', 'utf8');
    const current: SessionEntry = {
      timestamp: 't2',
      role: 'assistant',
      content: 'current answer',
      engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION,
    };
    await appendFile(file, JSON.stringify(current) + '\n', 'utf8');

    const loaded = await store.load(meta.id);
    assert.equal(loaded.length, 3, 'legacy + clean + current lines all load');
    assert.equal(loaded[0]?.engineBehaviorVersion, undefined, 'legacy line: marker absent');
    assert.equal(loaded[1]?.engineBehaviorVersion, undefined, 'legacy clean line: marker absent');
    assert.equal(
      loaded[2]?.engineBehaviorVersion,
      ENGINE_BEHAVIOR_VERSION,
      'current line: marker preserved',
    );

    // The loaded history drives quarantine correctly: the legacy menu triggers it
    // (text axis) and the legacy clean line is widened in (version axis).
    const policy = decideHistoryPolicy(
      loaded
        .filter((e) => e.role === 'assistant')
        .map((e) => ({
          content: e.content,
          ...(e.engineBehaviorVersion !== undefined
            ? { engineBehaviorVersion: e.engineBehaviorVersion }
            : {}),
        })),
    );
    assert.equal(
      policy.replayMode,
      'quarantine_assistant_prose',
      'a loaded legacy menu quarantines and widens the pre-fix period',
    );
    assert.ok(policy.reasons.some((r) => r.includes('pre-fix')));
  });
});
