/**
 * test/unit/menu.test.ts — unit tests for pure helpers in src/interface/menu.ts
 *
 * Tests only pure, I/O-free helpers; the interactive loop is integration-level
 * and not exercised here.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated data, no mock
 * AI-response phrases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  relativeTime,
  renderHeaderLines,
  renderConversationList,
  renderBudgetLine,
  versionStatusLabel,
  isRunningUnderNpx,
} from '../../src/interface/menu.ts';
import type { UpdateCheckResult } from '../../src/infra/update-check.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';
import type { ConversationMeta } from '../../src/infra/conversation-store.ts';
import type { SpendSummary } from '../../src/infra/insights.ts';
import type { ClaudeTokenStatus } from '../../src/infra/credentials.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[\d;]*[A-Za-z]/;

/** Patterns that must never appear in any rendered output (Honesty Contract). */
const FORBIDDEN_SUBSTRINGS = [
  'JWT',
  'Authentication bug',
  'sess-abc',
  '8m 23s',
  '12 exchanges',
  '87%',
];

function assertNoForbidden(output: string, label: string): void {
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    assert.ok(
      !output.includes(sub),
      `${label}: must not contain forbidden substring "${sub}"`,
    );
  }
}

function assertNoDigitPercent(output: string, label: string): void {
  assert.ok(
    !/\d+%/.test(output),
    `${label}: must not contain a digit-followed-by-% literal`,
  );
}

// ---------------------------------------------------------------------------
// Fake EnvironmentStatus for testing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper to build a ProviderStatus object with optional plan field.
// `plan` is added by a parallel workstream; we cast to match the shared
// contract so tests exercise the real rendering path.
// ---------------------------------------------------------------------------

type ProviderStatusWithPlan = EnvironmentStatus['claude'] & { readonly plan?: string | null };

function makeProvider(
  id: 'claude' | 'codex' | 'opencode',
  opts: {
    installed: boolean;
    version?: string | null;
    authenticated?: boolean;
    plan?: string | null;
  },
): ProviderStatusWithPlan {
  return {
    id,
    installed: opts.installed,
    version: opts.version ?? null,
    authenticated: opts.authenticated ?? false,
    binaryPath: opts.installed ? id : null,
    availableModels: opts.installed ? ['model-a'] : [],
    plan: opts.plan ?? null,
  } as ProviderStatusWithPlan;
}

/** Canonical not-installed opencode status used as a default in fake envs. */
const OPENCODE_NOT_INSTALLED = makeProvider('opencode', { installed: false });

const FAKE_ENV_BOTH_INSTALLED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, version: '1.2.3', authenticated: true }),
  codex: makeProvider('codex', { installed: true, version: '4.5.6', authenticated: true }),
  opencode: OPENCODE_NOT_INSTALLED,
  hasAnyProvider: true,
  platform: 'linux',
};

const FAKE_ENV_NONE_INSTALLED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: false }),
  codex: makeProvider('codex', { installed: false }),
  opencode: OPENCODE_NOT_INSTALLED,
  hasAnyProvider: false,
  platform: 'linux',
};

const FAKE_ENV_MIXED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, version: '2.0.0', authenticated: true }),
  codex: makeProvider('codex', { installed: false }),
  opencode: OPENCODE_NOT_INSTALLED,
  hasAnyProvider: true,
  platform: 'win32',
};

/** Both installed, claude NOT signed in (installed && !authenticated). */
const FAKE_ENV_INSTALLED_NOT_AUTHED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, version: '1.0.0', authenticated: false }),
  codex: makeProvider('codex', { installed: true, version: '4.0.0', authenticated: true }),
  opencode: OPENCODE_NOT_INSTALLED,
  hasAnyProvider: true,
  platform: 'linux',
};

/** Both installed with plan labels. */
const FAKE_ENV_WITH_PLANS: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, version: '1.0.0', authenticated: true, plan: 'Max x5' }),
  codex: makeProvider('codex', { installed: true, version: '4.0.0', authenticated: true, plan: 'Plus' }),
  opencode: OPENCODE_NOT_INSTALLED,
  hasAnyProvider: true,
  platform: 'linux',
};

/** Both installed, no plan labels (plan: null). */
const FAKE_ENV_NO_PLAN: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, version: '1.0.0', authenticated: true, plan: null }),
  codex: makeProvider('codex', { installed: true, version: '4.0.0', authenticated: true, plan: null }),
  opencode: OPENCODE_NOT_INSTALLED,
  hasAnyProvider: true,
  platform: 'linux',
};

// ---------------------------------------------------------------------------
// Fake ConversationMeta
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // arbitrary fixed "now" for deterministic tests

function meta(
  i: number,
  updatedAtMs: number,
  opts?: { pinned?: boolean; category?: string | null },
): ConversationMeta {
  return {
    id: `id-${i}`,
    title: `Conversation ${i}`,
    createdAt: new Date(updatedAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    messageCount: i,
    pinned: opts?.pinned ?? false,
    category: opts?.category ?? null,
  };
}

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  it('returns "just now" for 0ms diff', () => {
    assert.strictEqual(relativeTime(NOW_MS, NOW_MS), 'just now');
  });

  it('returns "just now" for 30 seconds diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 30_000, NOW_MS), 'just now');
  });

  it('returns "just now" for 59 seconds diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 59_000, NOW_MS), 'just now');
  });

  it('returns minutes for exactly 60 seconds diff', () => {
    const result = relativeTime(NOW_MS - 60_000, NOW_MS);
    assert.strictEqual(result, '1m ago');
  });

  it('returns "2m ago" for 2 minutes diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 2 * 60_000, NOW_MS), '2m ago');
  });

  it('returns "59m ago" for 59 minutes diff', () => {
    const result = relativeTime(NOW_MS - 59 * 60_000, NOW_MS);
    assert.strictEqual(result, '59m ago');
  });

  it('returns "1h ago" for exactly 1 hour diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 60 * 60_000, NOW_MS), '1h ago');
  });

  it('returns "2h ago" for 2 hours diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 2 * 60 * 60_000, NOW_MS), '2h ago');
  });

  it('returns "23h ago" for 23 hours diff', () => {
    const result = relativeTime(NOW_MS - 23 * 60 * 60_000, NOW_MS);
    assert.strictEqual(result, '23h ago');
  });

  it('returns "1d ago" for exactly 24 hours diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 24 * 60 * 60_000, NOW_MS), '1d ago');
  });

  it('returns "3d ago" for 3 days diff', () => {
    assert.strictEqual(relativeTime(NOW_MS - 3 * 24 * 60 * 60_000, NOW_MS), '3d ago');
  });

  it('clamps negative diffs (future timestamps) to "just now"', () => {
    assert.strictEqual(relativeTime(NOW_MS + 1_000_000, NOW_MS), 'just now');
  });

  it('does not contain a digit-% literal', () => {
    const results = [
      relativeTime(NOW_MS, NOW_MS),
      relativeTime(NOW_MS - 2 * 60_000, NOW_MS),
      relativeTime(NOW_MS - 2 * 60 * 60_000, NOW_MS),
      relativeTime(NOW_MS - 2 * 24 * 60 * 60_000, NOW_MS),
    ];
    for (const r of results) {
      assertNoDigitPercent(r, 'relativeTime');
    }
  });
});

// ---------------------------------------------------------------------------
// renderHeaderLines
// ---------------------------------------------------------------------------

describe('renderHeaderLines', () => {
  it('returns two lines (one per provider)', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    assert.strictEqual(lines.length, 2);
  });

  it('shows ✅ for installed providers', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    assert.ok(lines.some((l) => l.includes('✅') && l.includes('claude')));
    assert.ok(lines.some((l) => l.includes('✅') && l.includes('codex')));
  });

  it('shows ❌ for not-installed providers', () => {
    const lines = renderHeaderLines(FAKE_ENV_NONE_INSTALLED, '2.0.0');
    assert.ok(lines.some((l) => l.includes('❌') && l.includes('claude')));
    assert.ok(lines.some((l) => l.includes('❌') && l.includes('codex')));
  });

  it('shows ✅ claude and ❌ codex for mixed env', () => {
    const lines = renderHeaderLines(FAKE_ENV_MIXED, '2.0.0');
    const claudeLine = lines.find((l) => l.includes('claude'));
    const codexLine = lines.find((l) => l.includes('codex'));
    assert.ok(claudeLine?.includes('✅'), 'claude installed + authed → ✅');
    assert.ok(codexLine?.includes('❌'), 'codex not installed → ❌');
  });

  it('shows ⚠️ for installed-but-not-authenticated provider', () => {
    const lines = renderHeaderLines(FAKE_ENV_INSTALLED_NOT_AUTHED, '2.0.0');
    const claudeLine = lines.find((l) => l.includes('claude'));
    assert.ok(claudeLine?.includes('⚠'), 'installed but not authed → ⚠️');
    assert.ok(claudeLine?.includes('not signed in'), 'includes "not signed in"');
  });

  it('appends plan label when ps.plan is non-null', () => {
    const lines = renderHeaderLines(FAKE_ENV_WITH_PLANS, '2.0.0');
    const claudeLine = lines.find((l) => l.includes('claude')) ?? '';
    const codexLine = lines.find((l) => l.includes('codex')) ?? '';
    assert.ok(claudeLine.includes('Max x5'), 'claude line shows plan "Max x5"');
    assert.ok(codexLine.includes('Plus'), 'codex line shows plan "Plus"');
  });

  it('omits plan label when ps.plan is null', () => {
    const lines = renderHeaderLines(FAKE_ENV_NO_PLAN, '2.0.0');
    for (const line of lines) {
      assert.ok(!line.includes('('), `plan label must be omitted when null: "${line}"`);
    }
  });

  it('shows install hint for missing providers', () => {
    const lines = renderHeaderLines(FAKE_ENV_NONE_INSTALLED, '2.0.0');
    const claudeLine = lines.find((l) => l.includes('claude')) ?? '';
    assert.ok(claudeLine.includes('npm install'), 'missing provider shows install command');
  });

  it('color=false → no ANSI codes (lines are plain strings)', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    for (const line of lines) {
      assert.ok(
        !ANSI_RE.test(line),
        `renderHeaderLines must not contain ANSI codes: "${line}"`,
      );
    }
  });

  it('does not contain forbidden substrings', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    for (const line of lines) {
      assertNoForbidden(line, 'renderHeaderLines');
    }
  });

  it('does not contain digit-% literals', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    for (const line of lines) {
      assertNoDigitPercent(line, 'renderHeaderLines');
    }
  });

  // ---- opencode conditional rendering ----------------------------------------

  it('shows opencode line (✅ ready (free models)) when opencode is installed', () => {
    const envWithOpencode: EnvironmentStatus = {
      ...FAKE_ENV_BOTH_INSTALLED,
      opencode: makeProvider('opencode', { installed: true, version: '0.1.0', authenticated: true }),
    };
    const lines = renderHeaderLines(envWithOpencode, '2.0.0');
    // Should now be 3 lines: claude, codex, opencode
    assert.strictEqual(lines.length, 3);
    const opencodeLine = lines.find((l) => l.includes('opencode'));
    assert.ok(opencodeLine !== undefined, 'opencode line must appear when installed');
    assert.ok(opencodeLine.includes('✅'), 'opencode installed+authed → ✅');
    assert.ok(opencodeLine.includes('ready'), 'opencode line shows "ready"');
    assert.ok(opencodeLine.includes('free models'), 'opencode line shows "free models" basis');
  });

  it('does NOT show opencode line when opencode is not installed', () => {
    // All existing fixtures have opencode not-installed — verify no nag line.
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    assert.strictEqual(lines.length, 2, 'only claude+codex lines when opencode not installed');
    const opencodeLine = lines.find((l) => l.includes('opencode'));
    assert.ok(opencodeLine === undefined, 'no opencode line when not installed');
  });

  it('existing header assertions unchanged when opencode is not installed', () => {
    // Regression: existing tests (2 lines, ✅ claude, ✅ codex) must still hold.
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.some((l) => l.includes('✅') && l.includes('claude')));
    assert.ok(lines.some((l) => l.includes('✅') && l.includes('codex')));
  });

  it('shows ⚠️ for opencode installed but not authenticated', () => {
    const envWithUnauthOpencode: EnvironmentStatus = {
      ...FAKE_ENV_BOTH_INSTALLED,
      opencode: makeProvider('opencode', { installed: true, version: '0.1.0', authenticated: false }),
    };
    const lines = renderHeaderLines(envWithUnauthOpencode, '2.0.0');
    const opencodeLine = lines.find((l) => l.includes('opencode'));
    assert.ok(opencodeLine !== undefined, 'opencode line must appear when installed');
    assert.ok(opencodeLine.includes('⚠'), 'opencode installed but not authed → ⚠️');
    assert.ok(opencodeLine.includes('not signed in'), 'includes "not signed in"');
  });
});

// ---------------------------------------------------------------------------
// renderConversationList
// ---------------------------------------------------------------------------

describe('renderConversationList', () => {
  it('returns an empty array when no metas given', () => {
    const lines = renderConversationList([], NOW_MS);
    assert.strictEqual(lines.length, 0);
  });

  it('returns at most 7 lines regardless of input length', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      meta(i + 1, NOW_MS - i * 60 * 60_000),
    );
    const lines = renderConversationList(many, NOW_MS);
    assert.strictEqual(lines.length, 7);
  });

  it('each line contains the conversation title', () => {
    const metas = [
      meta(1, NOW_MS - 2 * 60 * 60_000),
      meta(2, NOW_MS - 24 * 60 * 60_000),
    ];
    const lines = renderConversationList(metas, NOW_MS);
    assert.ok(lines[0]?.includes('Conversation 1'), 'first line includes title 1');
    assert.ok(lines[1]?.includes('Conversation 2'), 'second line includes title 2');
  });

  it('each line contains a relative time string', () => {
    const metas = [meta(1, NOW_MS - 2 * 60 * 60_000)];
    const lines = renderConversationList(metas, NOW_MS);
    assert.ok(lines[0]?.includes('2h ago'), 'first line includes "2h ago"');
  });

  it('each line contains a bracketed index number', () => {
    const metas = [meta(1, NOW_MS - 60_000), meta(2, NOW_MS - 60_000)];
    const lines = renderConversationList(metas, NOW_MS);
    assert.ok(lines[0]?.startsWith('[1]'), 'first entry starts with [1]');
    assert.ok(lines[1]?.startsWith('[2]'), 'second entry starts with [2]');
  });

  it('does not contain ANSI codes', () => {
    const metas = [meta(1, NOW_MS - 2 * 60 * 60_000)];
    const lines = renderConversationList(metas, NOW_MS);
    for (const line of lines) {
      assert.ok(!ANSI_RE.test(line), `must not contain ANSI codes: "${line}"`);
    }
  });

  it('does not contain forbidden substrings', () => {
    const metas = [
      meta(1, NOW_MS - 60_000),
      meta(2, NOW_MS - 2 * 60 * 60_000),
    ];
    const lines = renderConversationList(metas, NOW_MS);
    for (const line of lines) {
      assertNoForbidden(line, 'renderConversationList');
    }
  });

  it('does not contain digit-% literals', () => {
    const metas = [meta(1, NOW_MS - 60_000)];
    const lines = renderConversationList(metas, NOW_MS);
    for (const line of lines) {
      assertNoDigitPercent(line, 'renderConversationList');
    }
  });

  it('shows 📌 prefix for pinned conversation', () => {
    const metas = [meta(1, NOW_MS - 60_000, { pinned: true })];
    const lines = renderConversationList(metas, NOW_MS);
    assert.ok(lines[0]?.includes('📌'), 'pinned conversation shows 📌');
  });

  it('shows 3-space prefix for non-pinned conversation (alignment)', () => {
    const metas = [meta(1, NOW_MS - 60_000, { pinned: false })];
    const lines = renderConversationList(metas, NOW_MS);
    // Line should start with "[1]    " — [1] then space then 3 spaces
    assert.ok(lines[0]?.startsWith('[1]    '), `non-pinned has 3-space indent: "${lines[0]}"`);
  });

  it('shows [category] suffix when category is set', () => {
    const metas = [meta(1, NOW_MS - 60_000, { category: 'ui' })];
    const lines = renderConversationList(metas, NOW_MS);
    assert.ok(lines[0]?.includes('[ui]'), 'categorised conversation shows [ui]');
  });

  it('omits category suffix when category is null', () => {
    const metas = [meta(1, NOW_MS - 60_000, { category: null })];
    const lines = renderConversationList(metas, NOW_MS);
    // The line starts with [1] which contains [ — check no trailing [category] suffix
    const line = lines[0] ?? '';
    // After the index bracket [N] there should be no further [...] groups
    const afterIndex = line.replace(/^\[\d+\]\s+/, '');
    assert.ok(!afterIndex.includes('['), `no category suffix when null: "${line}"`);
  });

  it('pinned + category both appear together', () => {
    const metas = [meta(1, NOW_MS - 60_000, { pinned: true, category: 'refactor' })];
    const lines = renderConversationList(metas, NOW_MS);
    assert.ok(lines[0]?.includes('📌'), 'shows 📌 when pinned');
    assert.ok(lines[0]?.includes('[refactor]'), 'shows [refactor] category');
  });
});

// ---------------------------------------------------------------------------
// renderBudgetLine
// ---------------------------------------------------------------------------

describe('renderBudgetLine', () => {
  /** Helper: build a SpendSummary with the given values. */
  function makeSpend(overrides?: Partial<SpendSummary>): SpendSummary {
    return {
      todayUsd: 0,
      totalUsd: 0,
      calls: 0,
      todayTokens: 0,
      totalTokens: 0,
      byProvider: {},
      ...overrides,
    };
  }

  it('shows a "no runs yet" prompt when calls is 0', () => {
    const line = renderBudgetLine(makeSpend({ calls: 0 }), false);
    assert.ok(line.toLowerCase().includes('no runs yet'), `expected "no runs yet" in: "${line}"`);
  });

  it('shows NO dollar figure (subscription tool — tokens only)', () => {
    const cases = [
      makeSpend({ calls: 0 }),
      makeSpend({ calls: 3, todayTokens: 12400, totalTokens: 89000 }),
    ];
    for (const spend of cases) {
      const line = renderBudgetLine(spend, false);
      assert.ok(!line.includes('$'), `budget line must not contain a "$" figure: "${line}"`);
    }
  });

  it('shows real token totals when calls > 0', () => {
    const spend = makeSpend({ calls: 3, todayTokens: 12400, totalTokens: 89000 });
    const line = renderBudgetLine(spend, false);
    assert.ok(line.includes('12.4k'), `expected today tokens "12.4k" in: "${line}"`);
    assert.ok(line.includes('89k'), `expected all-time tokens "89k" in: "${line}"`);
  });

  it('shows the task count (singular/plural) when calls > 0', () => {
    assert.ok(renderBudgetLine(makeSpend({ calls: 3, todayTokens: 100 }), false).includes('3 tasks'));
    assert.ok(renderBudgetLine(makeSpend({ calls: 1, todayTokens: 100 }), false).includes('1 task'));
  });

  it('includes "Today:" prefix when calls > 0', () => {
    const line = renderBudgetLine(makeSpend({ calls: 1, todayTokens: 100, totalTokens: 100 }), false);
    assert.ok(line.startsWith('Today:'), `expected "Today:" prefix in: "${line}"`);
  });

  it('color=false → no ANSI codes', () => {
    const line = renderBudgetLine(makeSpend({ calls: 1, todayTokens: 100, totalTokens: 100 }), false);
    assert.ok(
      !ANSI_RE.test(line),
      `renderBudgetLine(color=false) must not contain ANSI codes: "${line}"`,
    );
  });

  it('does not contain a digit-% literal', () => {
    const cases = [
      makeSpend({ calls: 0 }),
      makeSpend({ calls: 1, todayTokens: 100, totalTokens: 100 }),
      makeSpend({ calls: 99, todayTokens: 999999, totalTokens: 1234567 }),
    ];
    for (const spend of cases) {
      const line = renderBudgetLine(spend, false);
      assertNoDigitPercent(line, 'renderBudgetLine');
    }
  });

  it('does not contain forbidden substrings', () => {
    const cases = [
      makeSpend({ calls: 0 }),
      makeSpend({ calls: 1, todayTokens: 100, totalTokens: 100 }),
    ];
    for (const spend of cases) {
      const line = renderBudgetLine(spend, false);
      assertNoForbidden(line, 'renderBudgetLine');
    }
  });
});

// ---------------------------------------------------------------------------
// renderHeaderLines — claudeToken param (token expiry warnings)
// ---------------------------------------------------------------------------

function makeClaudeTokenStatus(overrides: Partial<ClaudeTokenStatus>): ClaudeTokenStatus {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    daysLeft: 200,
    expired: false,
    nearExpiry: false,
    ...overrides,
  };
}

describe('renderHeaderLines — token warning line shown only near-expiry or expired', () => {
  it('adds NO extra line when claudeToken is omitted (undefined)', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0');
    assert.strictEqual(lines.length, 2, 'exactly 2 provider lines when no token info');
  });

  it('adds NO extra line when claudeToken is null', () => {
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', null);
    assert.strictEqual(lines.length, 2, 'exactly 2 provider lines when null');
  });

  it('adds NO extra line when token is healthy (not near expiry)', () => {
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: 200, expired: false, nearExpiry: false });
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', tokenInfo);
    assert.strictEqual(lines.length, 2, 'no warning line when healthy token');
  });

  it('adds a warning line when token is near-expiry', () => {
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: 10, expired: false, nearExpiry: true });
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', tokenInfo);
    assert.strictEqual(lines.length, 3, 'one extra warning line when near-expiry');
    const warnLine = lines.find((l) => l.includes('token'));
    assert.ok(warnLine !== undefined, 'warning line mentions "token"');
    assert.ok(warnLine.includes('10'), 'warning line shows days remaining');
  });

  it('adds a warning line when token is expired', () => {
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: -5, expired: true, nearExpiry: false });
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', tokenInfo);
    assert.strictEqual(lines.length, 3, 'one extra warning line when expired');
    const warnLine = lines.find((l) => l.includes('EXPIRED'));
    assert.ok(warnLine !== undefined, 'warning line contains "EXPIRED"');
  });

  it('expired warning includes the login command', () => {
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: -1, expired: true, nearExpiry: false });
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', tokenInfo);
    const warnLine = lines.find((l) => l.includes('EXPIRED')) ?? '';
    assert.ok(
      warnLine.includes('myshell-tools login claude --code'),
      `expected login command in expired warning: "${warnLine}"`,
    );
  });

  it('near-expiry warning includes the login command', () => {
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: 7, expired: false, nearExpiry: true });
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', tokenInfo);
    const warnLine = lines.find((l) => l.includes('token')) ?? '';
    assert.ok(
      warnLine.includes('myshell-tools login claude --code'),
      `expected login command in near-expiry warning: "${warnLine}"`,
    );
  });

  it('warning line does not contain ANSI codes (pure string)', () => {
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: 5, expired: false, nearExpiry: true });
    const lines = renderHeaderLines(FAKE_ENV_BOTH_INSTALLED, '2.0.0', tokenInfo);
    const warnLine = lines[lines.length - 1] ?? '';
    assert.ok(!ANSI_RE.test(warnLine), `warning line must not contain ANSI: "${warnLine}"`);
  });

  it('also adds warning line when opencode is installed (4th line total)', () => {
    const envWithOpencode: EnvironmentStatus = {
      ...FAKE_ENV_BOTH_INSTALLED,
      opencode: makeProvider('opencode', { installed: true, version: '0.1.0', authenticated: true }),
    };
    const tokenInfo = makeClaudeTokenStatus({ daysLeft: 3, expired: false, nearExpiry: true });
    const lines = renderHeaderLines(envWithOpencode, '2.0.0', tokenInfo);
    // 3 provider lines + 1 token warning = 4
    assert.strictEqual(lines.length, 4, 'claude + codex + opencode + token warning = 4 lines');
  });
});

// ---------------------------------------------------------------------------
// versionStatusLabel
// ---------------------------------------------------------------------------

describe('versionStatusLabel', () => {
  const mk = (over: Partial<UpdateCheckResult>): UpdateCheckResult => ({
    current: '3.0.0',
    latest: '3.0.0',
    updateAvailable: false,
    ...over,
  });

  it('returns "(latest)" when up to date (latest known, no update)', () => {
    assert.strictEqual(versionStatusLabel(mk({})), ' (latest)');
  });

  it('shows the newer version when an update is available', () => {
    const label = versionStatusLabel(mk({ latest: '3.1.0', updateAvailable: true }));
    assert.strictEqual(label, ' → 3.1.0 available');
  });

  it('claims nothing when the check did not run (undefined)', () => {
    assert.strictEqual(versionStatusLabel(undefined), '');
  });

  it('claims nothing when latest is unknown (offline/failed)', () => {
    assert.strictEqual(versionStatusLabel(mk({ latest: null })), '');
  });

  it('never fabricates a percentage and emits no ANSI', () => {
    for (const info of [mk({}), mk({ latest: '4.0.0', updateAvailable: true })]) {
      const label = versionStatusLabel(info);
      assert.ok(!ANSI_RE.test(label), 'no ANSI in version label');
      assert.ok(!/\d+%/.test(label), 'no digit-% literal in version label');
    }
  });
});

// ---------------------------------------------------------------------------
// isRunningUnderNpx
// ---------------------------------------------------------------------------

describe('isRunningUnderNpx', () => {
  it('detects a POSIX npx cache script path', () => {
    const p = '/home/u/.npm/_npx/abc123/node_modules/myshell-tools/dist/cli.js';
    assert.strictEqual(isRunningUnderNpx(p, {}), true);
  });

  it('detects a Windows npx cache script path', () => {
    const p = 'C:\\Users\\u\\AppData\\npm-cache\\_npx\\abc\\node_modules\\myshell-tools\\dist\\cli.js';
    assert.strictEqual(isRunningUnderNpx(p, {}), true);
  });

  it('detects npx via npm_execpath when the script path is clean', () => {
    const env = { npm_execpath: '/home/u/.npm/_npx/abc/node_modules/npm/bin/npx-cli.js' };
    assert.strictEqual(isRunningUnderNpx('/usr/lib/whatever.js', env), true);
  });

  it('returns false for a global install path', () => {
    const p = '/usr/local/lib/node_modules/myshell-tools/dist/cli.js';
    assert.strictEqual(isRunningUnderNpx(p, {}), false);
  });

  it('returns false when the script path is undefined and no env hint', () => {
    assert.strictEqual(isRunningUnderNpx(undefined, {}), false);
  });
});
