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
} from '../../src/interface/menu.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';
import type { ConversationMeta } from '../../src/infra/conversation-store.ts';

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

const FAKE_ENV_BOTH_INSTALLED: EnvironmentStatus = {
  claude: {
    id: 'claude',
    installed: true,
    version: '1.2.3',
    authenticated: true,
    binaryPath: 'claude',
    availableModels: ['opus', 'sonnet'],
  },
  codex: {
    id: 'codex',
    installed: true,
    version: '4.5.6',
    authenticated: true,
    binaryPath: 'codex',
    availableModels: ['gpt-5.5'],
  },
  hasAnyProvider: true,
  platform: 'linux',
};

const FAKE_ENV_NONE_INSTALLED: EnvironmentStatus = {
  claude: {
    id: 'claude',
    installed: false,
    version: null,
    authenticated: false,
    binaryPath: null,
    availableModels: [],
  },
  codex: {
    id: 'codex',
    installed: false,
    version: null,
    authenticated: false,
    binaryPath: null,
    availableModels: [],
  },
  hasAnyProvider: false,
  platform: 'linux',
};

const FAKE_ENV_MIXED: EnvironmentStatus = {
  claude: {
    id: 'claude',
    installed: true,
    version: '2.0.0',
    authenticated: true,
    binaryPath: 'claude',
    availableModels: ['opus'],
  },
  codex: {
    id: 'codex',
    installed: false,
    version: null,
    authenticated: false,
    binaryPath: null,
    availableModels: [],
  },
  hasAnyProvider: true,
  platform: 'win32',
};

// ---------------------------------------------------------------------------
// Fake ConversationMeta
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // arbitrary fixed "now" for deterministic tests

function meta(i: number, updatedAtMs: number): ConversationMeta {
  return {
    id: `id-${i}`,
    title: `Conversation ${i}`,
    createdAt: new Date(updatedAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    messageCount: i,
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

  it('shows ⚠️ for missing providers', () => {
    const lines = renderHeaderLines(FAKE_ENV_NONE_INSTALLED, '2.0.0');
    assert.ok(lines.some((l) => l.includes('⚠') && l.includes('claude')));
    assert.ok(lines.some((l) => l.includes('⚠') && l.includes('codex')));
  });

  it('shows ✅ claude and ⚠️ codex for mixed env', () => {
    const lines = renderHeaderLines(FAKE_ENV_MIXED, '2.0.0');
    const claudeLine = lines.find((l) => l.includes('claude'));
    const codexLine = lines.find((l) => l.includes('codex'));
    assert.ok(claudeLine?.includes('✅'), 'claude installed → ✅');
    assert.ok(codexLine?.includes('⚠'), 'codex not installed → ⚠️');
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
});
