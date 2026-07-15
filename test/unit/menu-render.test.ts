/**
 * test/unit/menu-render.test.ts — Slice 1 locked home skeleton render tests.
 *
 * Golden-ish substring assertions per docs/menu-build-spec-final.md (Slice 1):
 *   MUST contain:  `Mode:`, `Session Manager`, `Choice:`, `ESC to exit`
 *   MUST NOT contain: `No runs yet`, `Health:`, `doctor`
 *
 * Drives renderMainScreen over injected state via a capturing OutputSink.
 * Honesty Contract: no hardcoded percentages, no fabricated figures, no mock
 * AI-response phrases.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildEffortModeSections,
  formatControlLine,
  formatHomeSectionHeader,
  formatRecentRow,
  renderMainScreen,
} from '../../src/interface/menu-render.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import type { SpendSummary } from '../../src/infra/insights.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { ConversationMeta } from '../../src/infra/conversation-store.ts';
import { stripAnsi } from '../../src/ui/tui.ts';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeProvider(
  id: 'claude' | 'codex' | 'opencode' | 'grok',
  opts: { installed?: boolean; authenticated?: boolean } = {},
): ProviderStatus {
  return {
    id,
    installed: opts.installed ?? false,
    version: null,
    authenticated: opts.authenticated ?? false,
    plan: null,
    binaryPath: null,
    availableModels: [],
  };
}

const ENV_NONE_AUTHED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, authenticated: false }),
  codex: makeProvider('codex', { installed: true, authenticated: false }),
  opencode: makeProvider('opencode', { installed: false }),
  grok: makeProvider('grok', { installed: false }),
  hasAnyProvider: true,
  platform: 'linux',
};

const ENV_CLAUDE_AUTHED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, authenticated: true }),
  codex: makeProvider('codex', { installed: true, authenticated: false }),
  opencode: makeProvider('opencode', { installed: false }),
  grok: makeProvider('grok', { installed: false }),
  hasAnyProvider: true,
  platform: 'linux',
};

const EMPTY_SPEND: SpendSummary = {
  todayUsd: 0,
  totalUsd: 0,
  calls: 0,
  todayCalls: 0,
  todayTokens: 0,
  totalTokens: 0,
  byProvider: {},
};

function makeCtx(): MenuContext {
  return {
    version: '9.9.9',
    cwd: 'C:\\Users\\Josh\\dev\\myshell-tools',
    clock: {
      now: () => 1_700_000_000_000,
      isoNow: () => '2023-11-14T22:13:20.000Z',
      uuid: () => 'test-uuid',
      random: () => 0,
    },
  } as unknown as MenuContext;
}

/** Capturing sink (color off → ANSI-free, easy substring asserts). */
function makeSink(): { sink: OutputSink; text: () => string } {
  let buf = '';
  const sink = {
    write(s: string) {
      buf += s;
    },
    color: false,
  } as unknown as OutputSink;
  return { sink, text: () => buf };
}

async function render(
  env: EnvironmentStatus,
  metas: ConversationMeta[] = [],
  currentWorkspaceRoot?: string,
  config: AppConfig = {} as AppConfig,
): Promise<string> {
  const { sink, text } = makeSink();
  await renderMainScreen(
    makeCtx(),
    { config, env },
    metas,
    EMPTY_SPEND,
    sink,
    undefined,
    undefined,
    false,
    [],
    [],
    undefined,
    false,
    false,
    currentWorkspaceRoot,
  );
  return text();
}

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'conv-1',
    title: 'Test conversation',
    createdAt: '2023-11-14T20:13:20.000Z',
    updatedAt: '2023-11-14T21:13:20.000Z',
    messageCount: 42,
    pinned: false,
    category: null,
    mode: 'budget',
    ...overrides,
  };
}

/** Live Auto (smart) Effort box — default when config.mode is unset. */
const EFFORT_BOX_AUTO = [
  '╭──────────────────────────────────────────────────╮',
  '│  Mode:  Auto (smart)                             │',
  '│  smart default — picks the effective level per   │',
  '│  task from how the turn is going                 │',
  '├──────────────────────────────────────────────────┤',
  '│  m = switch modes                    Auto (smart)│',
  '╰──────────────────────────────────────────────────╯',
].join('\n');

const EXPECTED_HOME_POPULATED = [
  '',
  EFFORT_BOX_AUTO,
  '',
  'Recent (myshell-tools):',
  '  [1] 1h  Test conversation  · budget',
  '',
  '╭───────────────────────────╮',
  '│      Session Manager      │',
  '╰───────────────────────────╯',
  '',
  '[c] Continue last',
  '    └─ Test conversation · 1h',
  '[1-9] Open numbered above',
  '[n] New conversation',
  '[e] Library / all conversations',
  '[a] Accounts',
  '[q] Quit',
  '',
  'Choice: ▌',
  'ESC to exit',
  '',
].join('\n');

const EXPECTED_HOME_EMPTY_SIGNED_IN = [
  '',
  EFFORT_BOX_AUTO,
  '',
  'Recent (myshell-tools):',
  'No conversations yet.',
  '',
  '╭───────────────────────────╮',
  '│      Session Manager      │',
  '╰───────────────────────────╯',
  '',
  '[n] New conversation',
  '[e] Library / all conversations',
  '[a] Accounts',
  '[q] Quit',
  '',
  'Choice: ▌',
  'ESC to exit',
  '',
].join('\n');

const EXPECTED_HOME_EMPTY_NOT_SIGNED_IN = [
  '',
  EFFORT_BOX_AUTO,
  '',
  'Recent (myshell-tools):',
  'Sign in to start conversations.',
  '',
  '╭───────────────────────────╮',
  '│      Session Manager      │',
  '╰───────────────────────────╯',
  '',
  '[a] Accounts / Sign in',
  '[q] Quit',
  '',
  'Choice: ▌',
  'ESC to exit',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Slice 1 — locked skeleton landmarks (populated)
// ---------------------------------------------------------------------------

describe('renderMainScreen — Slice 1 locked home skeleton (populated)', () => {
  it('matches the locked populated home render exactly', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.equal(out, EXPECTED_HOME_POPULATED);
  });

  it('contains the Mode box landmark', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('Mode:'), `expected "Mode:" in:\n${out}`);
  });

  it('contains the live Auto Mode copy when mode is unset', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('Auto (smart)'), 'mode header shows Auto (smart)');
    assert.ok(
      out.includes('smart default — picks the effective level per'),
      'mode box shows LEVEL_DESC for auto',
    );
    assert.ok(out.includes('m = switch modes'), 'mode box advertises m = switch modes');
  });

  it('reflects Budget when config.mode is cost-saver', async () => {
    const out = await render(
      ENV_CLAUDE_AUTHED,
      [makeMeta()],
      undefined,
      { mode: 'cost-saver' } as AppConfig,
    );
    assert.ok(out.includes('Mode:  Budget'), 'header shows Budget');
    assert.ok(
      out.includes('cheapest models, light verification,'),
      'shows Budget LEVEL_DESC',
    );
    assert.ok(
      /m = switch modes\s+Budget/.test(out),
      'footer right-aligns Budget short label',
    );
  });

  it('reflects Balanced when config.mode is balanced', async () => {
    const out = await render(
      ENV_CLAUDE_AUTHED,
      [],
      undefined,
      { mode: 'balanced' } as AppConfig,
    );
    assert.ok(out.includes('Mode:  Balanced'), 'header shows Balanced');
    assert.ok(
      /m = switch modes\s+Balanced/.test(out),
      'footer right-aligns Balanced short label',
    );
  });

  it('reflects Max when config.mode is quality-first (migrateMode)', async () => {
    const out = await render(
      ENV_CLAUDE_AUTHED,
      [],
      undefined,
      { mode: 'quality-first' } as AppConfig,
    );
    assert.ok(out.includes('Mode:  Max'), 'header shows Max');
    assert.ok(
      /m = switch modes\s+Max/.test(out),
      'footer right-aligns Max short label',
    );
  });

  it('contains the Session Manager centered box', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('Session Manager'), `expected "Session Manager" in:\n${out}`);
  });

  it('contains the Choice prompt and ESC footer', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('Choice:'), `expected "Choice:" in:\n${out}`);
    assert.ok(out.includes('ESC to exit'), `expected "ESC to exit" in:\n${out}`);
  });

  it('renders the Recent (<workspace label>): header', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('Recent ('), `expected "Recent (" header in:\n${out}`);
    assert.ok(out.includes('):'), 'recent header ends with "):"');
  });

  it('renders populated flat controls exactly as locked', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('[c] Continue last'), 'populated shows [c] Continue last');
    assert.ok(out.includes('[1-9] Open numbered above'), 'populated shows [1-9]');
    assert.ok(out.includes('[n] New conversation'), 'populated shows [n]');
    assert.ok(out.includes('[e] Library / all conversations'), 'populated shows [e]');
    assert.ok(out.includes('[a] Accounts'), 'authed shows [a] Accounts');
    assert.ok(out.includes('[q] Quit'), 'shows [q] Quit');
  });

  it('renders the continue-last sub-line with the latest title + age', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('└─'), 'continue-last sub-line uses the └─ marker');
    assert.ok(out.includes('Test conversation'), 'sub-line references the latest title');
  });

  it('renders the conversation row with title and effort (no message count)', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta()]);
    assert.ok(out.includes('Test conversation'), 'row shows title');
    assert.ok(out.includes('· budget'), 'row shows the effort label');
    assert.ok(!out.includes('42 msgs'), 'locked row omits the message-count suffix');
  });

  it('renders the provider label alongside effort when lastProvider is present', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, [makeMeta({ lastProvider: 'codex' })]);
    assert.ok(out.includes('codex · budget'), 'row shows provider and effort');
    assert.ok(out.includes('└─ codex · Test conversation ·'), 'continue-last sub-line shows provider');
  });
});

// ---------------------------------------------------------------------------
// Slice 1 — empty, signed in
// ---------------------------------------------------------------------------

describe('renderMainScreen — Slice 1 empty, signed in', () => {
  it('matches the locked empty signed-in home render exactly', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, []);
    assert.equal(out, EXPECTED_HOME_EMPTY_SIGNED_IN);
  });

  it('renders the locked empty copy "No conversations yet."', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, []);
    assert.ok(out.includes('No conversations yet.'), `expected empty copy in:\n${out}`);
  });

  it('omits continue-last and numbered controls when empty', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, []);
    assert.ok(!out.includes('[c] Continue last'), 'empty omits [c]');
    assert.ok(!out.includes('[1-9]'), 'empty omits [1-9]');
    assert.ok(!out.includes('└─'), 'empty omits the continue-last sub-line');
  });

  it('still shows new / library / accounts / quit', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, []);
    assert.ok(out.includes('[n] New conversation'), 'empty signed-in shows [n]');
    assert.ok(out.includes('[e] Library / all conversations'), 'empty signed-in shows [e]');
    assert.ok(out.includes('[a] Accounts'), 'empty signed-in shows [a] Accounts');
    assert.ok(out.includes('[q] Quit'), 'empty signed-in shows [q]');
    assert.ok(out.includes('Choice:'), 'empty signed-in shows Choice:');
    assert.ok(out.includes('ESC to exit'), 'empty signed-in shows ESC footer');
  });
});

// ---------------------------------------------------------------------------
// Slice 1 — empty, not signed in
// ---------------------------------------------------------------------------

describe('renderMainScreen — Slice 1 empty, not signed in', () => {
  it('matches the locked empty not-signed-in home render exactly', async () => {
    const out = await render(ENV_NONE_AUTHED, []);
    assert.equal(out, EXPECTED_HOME_EMPTY_NOT_SIGNED_IN);
  });

  it('renders the locked empty copy "Sign in to start conversations."', async () => {
    const out = await render(ENV_NONE_AUTHED, []);
    assert.ok(out.includes('Sign in to start conversations.'), `expected empty-not-signed-in copy in:\n${out}`);
  });

  it('shows only Accounts / Sign in and Quit controls', async () => {
    const out = await render(ENV_NONE_AUTHED, []);
    assert.ok(out.includes('[a] Accounts / Sign in'), 'empty not-signed-in shows [a] Accounts / Sign in');
    assert.ok(out.includes('[q] Quit'), 'empty not-signed-in shows [q]');
    assert.ok(!out.includes('[n] New conversation'), 'empty not-signed-in omits [n]');
    assert.ok(!out.includes('[e] Library'), 'empty not-signed-in omits [e]');
    assert.ok(!out.includes('[c] Continue last'), 'empty not-signed-in omits [c]');
  });

  it('still renders the Mode / Session Manager / Choice / ESC landmarks', async () => {
    const out = await render(ENV_NONE_AUTHED, []);
    assert.ok(out.includes('Mode:'), 'empty not-signed-in still shows mode box');
    assert.ok(out.includes('Session Manager'), 'empty not-signed-in still shows Session Manager');
    assert.ok(out.includes('Choice:'), 'empty not-signed-in still shows Choice:');
    assert.ok(out.includes('ESC to exit'), 'empty not-signed-in still shows ESC footer');
  });
});

// ---------------------------------------------------------------------------
// Slice 1 — forbidden substrings (every state)
// ---------------------------------------------------------------------------

describe('renderMainScreen — Slice 1 forbidden substrings', () => {
  const FORBIDDEN = ['No runs yet', 'Health:', 'doctor', 'New conversation default'];

  for (const env of [ENV_CLAUDE_AUTHED, ENV_NONE_AUTHED]) {
    for (const metas of [[], [makeMeta()]] as ConversationMeta[][]) {
      const label = `${metas.length > 0 ? 'populated' : 'empty'} / ${env.claude.authenticated ? 'authed' : 'not-authed'}`;
      it(`never renders forbidden substrings (${label})`, async () => {
        const out = await render(env, metas);
        for (const sub of FORBIDDEN) {
          assert.ok(!out.includes(sub), `home must not contain "${sub}" (${label}):\n${out}`);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Slice 10 — workspace-aware Recent list (current-workspace-first, location
// column on non-current rows, render order == numeric dispatch order).
// ---------------------------------------------------------------------------

describe('renderMainScreen — Slice 10 workspace-aware Recent list', () => {
  const CURRENT_ROOT = '/home/josh/dev/myshell-tools';
  const OTHER_ROOT = '/home/josh/dev/replit-tools';

  // Two conversations, passed to render in STORE order (newest first — mirroring
  // what `ConversationStore.list()` returns): a NEWER non-current row followed
  // by an OLDER current-workspace row. The store order and the render order
  // therefore DIFFER — exactly the case the Slice 10 invariant must handle.
  const olderCurrent: ConversationMeta = makeMeta({
    id: 'older-current',
    title: 'Older current',
    workspaceRoot: CURRENT_ROOT,
    updatedAt: '2023-11-14T20:13:20.000Z', // 2h before NOW
    mode: 'auto',
  });
  const newerOther: ConversationMeta = makeMeta({
    id: 'newer-other',
    title: 'Newer other',
    workspaceRoot: OTHER_ROOT,
    updatedAt: '2023-11-14T21:13:20.000Z', // 1h before NOW (newer)
    mode: 'max',
  });
  // Store order: newer first → [newerOther, olderCurrent].
  const storeOrderedMetas: ConversationMeta[] = [newerOther, olderCurrent];

  function row(out: string, idx: number): string {
    // Match the `  [n] ...` indented rendered row.
    const re = new RegExp(`^\\s*\\[${idx}\\] (.*)$`, 'm');
    const m = re.exec(out);
    assert.ok(m !== null, `expected a [${idx}] row in:\n${out}`);
    return m[1] ?? '';
  }

  it('renders the Recent title with the current workspace label', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, storeOrderedMetas, CURRENT_ROOT);
    assert.ok(
      out.includes('Recent (myshell-tools):'),
      `expected "Recent (myshell-tools):" header in:\n${out}`,
    );
  });

  it('sorts current-workspace rows ahead of newer non-current rows', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, storeOrderedMetas, CURRENT_ROOT);
    // [1] must be the OLDER CURRENT row, not the newer non-current one — store
    // order and render order diverge here, which is the whole point.
    const r1 = row(out, 1);
    assert.ok(r1.includes('Older current'), `[1] should be the current row:\n${out}`);
    assert.ok(!r1.includes('replit-tools'), `[1] must not carry a location prefix:\n${out}`);
    // [2] is the newer NON-current row.
    const r2 = row(out, 2);
    assert.ok(r2.includes('Newer other'), `[2] should be the non-current row:\n${out}`);
  });

  it('prefixes non-current rows with "<location> · <title>" inline', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, storeOrderedMetas, CURRENT_ROOT);
    const r2 = row(out, 2);
    assert.ok(
      r2.includes('replit-tools · Newer other'),
      `expected "replit-tools · Newer other" in [2] row, got:\n${r2}`,
    );
    // The location is the OTHER workspace's label, never the current one.
    assert.ok(
      !r2.includes('myshell-tools · '),
      `[2] must NOT show the current workspace as a location prefix:\n${r2}`,
    );
  });

  it('omits the location prefix on current-workspace rows (redundant with the header)', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, storeOrderedMetas, CURRENT_ROOT);
    const r1 = row(out, 1);
    // The current row shows just the title, no "myshell-tools · " prefix.
    assert.ok(
      !r1.includes('myshell-tools · '),
      `current row must not carry a redundant location prefix:\n${r1}`,
    );
  });

  it('renders a global/unknown (no workspaceRoot) row title-only in the non-current tier', async () => {
    // A legacy/global conversation (workspaceRoot absent) sorts in the
    // non-current tier but renders with NO fabricated location prefix.
    const global: ConversationMeta = makeMeta({
      id: 'global',
      title: 'Global chat',
      updatedAt: '2023-11-14T19:13:20.000Z', // older than both → last
    });
    const metas: ConversationMeta[] = [newerOther, olderCurrent, global];
    const out = await render(ENV_CLAUDE_AUTHED, metas, CURRENT_ROOT);
    // Store order (recency): newerOther, olderCurrent, global.
    // Render order (current-first): olderCurrent, newerOther, global.
    const r3 = row(out, 3);
    assert.ok(r3.includes('Global chat'), `[3] should be the global row:\n${out}`);
    // No location prefix before the title: the row is `3h  Global chat  · <effort>`,
    // NOT `3h  <something> · Global chat  · <effort>`.
    assert.ok(!r3.includes('· Global chat  ·'), `[3] must not fabricate a location prefix:\n${r3}`);
  });

  it('[c] Continue-last sub-line names the FIRST RENDERED row (matches [1])', async () => {
    const out = await render(ENV_CLAUDE_AUTHED, storeOrderedMetas, CURRENT_ROOT);
    // The [c] sub-line (`    └─ <title> · <age>`) must reference the OLDER
    // current row (the rendered [1]), NOT the store's first (newerOther).
    assert.ok(
      out.includes('└─ Older current ·'),
      `expected [c] sub-line to name the first rendered row "Older current":\n${out}`,
    );
    assert.ok(
      !out.includes('└─ Newer other ·'),
      `[c] sub-line must NOT name the raw store-first row "Newer other":\n${out}`,
    );
  });
});

// ---------------------------------------------------------------------------
// S.1 — visual polish pure helpers (color-gated; color:false is identity)
// ---------------------------------------------------------------------------

describe('S.1 visual polish format helpers', () => {
  it('formatHomeSectionHeader is identity when color is off', () => {
    assert.equal(formatHomeSectionHeader('Recent (myshell-tools):', false), 'Recent (myshell-tools):');
  });

  it('formatHomeSectionHeader embeds cyan/bold ANSI when color is on', () => {
    const out = formatHomeSectionHeader('Recent (myshell-tools):', true);
    assert.notEqual(out, 'Recent (myshell-tools):');
    assert.equal(stripAnsi(out), 'Recent (myshell-tools):');
    assert.ok(out.includes('\x1b['), 'expected ANSI when color is on');
  });

  it('formatRecentRow dims age + meta only when color is on', () => {
    const plain = formatRecentRow(1, '12m', 'Menu design', 'codex · auto', false);
    assert.equal(plain, '[1] 12m  Menu design  codex · auto');

    const colored = formatRecentRow(1, '12m', 'Menu design', 'codex · auto', true);
    assert.equal(stripAnsi(colored), plain);
    // Age and provider/effort are dimmed; title stays plain (no ANSI around title alone).
    assert.ok(colored.includes('Menu design'), 'title present');
    assert.ok(colored.includes('\x1b[2m'), 'expected dim SGR for secondary fields');
  });

  it('formatControlLine bolds [key] and dims secondary sub-lines when color is on', () => {
    assert.equal(formatControlLine('[n] New conversation', false), '[n] New conversation');
    assert.equal(formatControlLine('    └─ title · 1h', false), '    └─ title · 1h');

    const key = formatControlLine('[n] New conversation', true);
    assert.equal(stripAnsi(key), '[n] New conversation');
    assert.ok(key.startsWith('\x1b[1m[n]\x1b[0m'), 'leading [n] is bold');

    const sub = formatControlLine('    └─ title · 1h', true);
    assert.equal(stripAnsi(sub), '    └─ title · 1h');
    assert.ok(sub.includes('\x1b[2m'), 'sub-line is dim');
  });

  it('buildEffortModeSections color:false matches locked plain skeleton text', () => {
    const { header, footer } = buildEffortModeSections(undefined, false);
    assert.equal(header[0], 'Mode:  Auto (smart)');
    assert.ok(header.some((l) => l.includes('smart default')));
    assert.ok(footer[0]?.includes('m = switch modes'));
    assert.ok(footer[0]?.includes('Auto (smart)'));
    for (const line of [...header, ...footer]) {
      assert.equal(line, stripAnsi(line), 'no ANSI when color is false');
    }
  });

  it('buildEffortModeSections color:true keeps visible text, adds hierarchy ANSI', () => {
    const { header, footer } = buildEffortModeSections('balanced', true);
    assert.equal(stripAnsi(header[0] ?? ''), 'Mode:  Balanced');
    assert.ok((header[0] ?? '').includes('\x1b['), 'header has ANSI');
    assert.ok((footer[0] ?? '').includes('\x1b['), 'footer has ANSI');
    assert.equal(stripAnsi(footer[0] ?? '').includes('m = switch modes'), true);
    assert.equal(stripAnsi(footer[0] ?? '').includes('Balanced'), true);
  });
});
