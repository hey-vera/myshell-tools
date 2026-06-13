/**
 * test/ui/menu-submenu-single-key.test.tsx — single-key SUB-menu navigation on
 * the Ink path (this task). The MAIN menu + y/n confirms already resolve on a
 * single key under Ink; these tests prove the SAME for the Settings and
 * Conversations sub-menus: a single keypress (NO Enter) navigates/selects through
 * Ink's own input pipeline, and the flag-off (no inkReadKey) path still uses the
 * line/readSingleKey reader.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library). `stdin.write(...)`
 * injects raw key bytes Ink decodes into `key.*`; the `inkReadKey` wired into the
 * sub-menus is `() => bridge.readKey()`, exactly as startMenu wires it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';

import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
import { runSettings } from '../../src/interface/menu-settings.js';
import { runManage } from '../../src/interface/menu-conversations.js';
import { loadConfig } from '../../src/infra/config.js';
import type { AppConfig } from '../../src/infra/config.js';
import type { OutputSink } from '../../src/interface/render.js';
import type { EnvironmentStatus } from '../../src/providers/detect.js';
import type { MenuContext } from '../../src/interface/menu.js';
import type { Clock } from '../../src/core/types.js';
import type { ConversationMeta, ConversationStore } from '../../src/infra/conversation-store.js';

const ENTER = '\r';
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeOut(): { sink: OutputSink; written: string[] } {
  const written: string[] = [];
  const sink: OutputSink = {
    write(s: string): void {
      written.push(s);
    },
    get color(): boolean {
      return false;
    },
    get isTty(): boolean {
      return true;
    },
  };
  return { sink, written };
}

function makeEnv(): EnvironmentStatus {
  const ps = (id: 'claude' | 'codex' | 'opencode'): EnvironmentStatus['claude'] => ({
    id,
    installed: true,
    authenticated: true,
    version: '1.0.0',
    plan: null,
    binaryPath: null,
    availableModels: ['model-a'],
  });
  return { claude: ps('claude'), codex: ps('codex'), opencode: ps('opencode') } as EnvironmentStatus;
}

/**
 * Point the config/state home at a throwaway tmp dir for the duration of a test so
 * runSettings' saveConfig never touches the developer's real config. Returns a
 * restore function. Clears the Replit markers so resolveStateHome falls back to
 * HOME (the tmp dir) rather than cwd.
 */
function withTmpHome(): { home: string; restore: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myshell-submenu-'));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    REPL_ID: process.env.REPL_ID,
    REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
  };
  const set = (k: 'HOME' | 'USERPROFILE' | 'REPL_ID' | 'REPLIT_DEV_DOMAIN', v: string | undefined): void => {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  set('REPL_ID', undefined);
  set('REPLIT_DEV_DOMAIN', undefined);
  return {
    home,
    restore(): void {
      set('HOME', prev.HOME);
      set('USERPROFILE', prev.USERPROFILE);
      set('REPL_ID', prev.REPL_ID);
      set('REPLIT_DEV_DOMAIN', prev.REPLIT_DEV_DOMAIN);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function makeClock(): Clock {
  const base = 1_700_000_000_000;
  let n = 0;
  return { now: () => base, isoNow: () => new Date(base).toISOString(), uuid: () => `fake-${++n}`, random: () => 0.5 };
}

// ---------------------------------------------------------------------------
// Settings sub-menu — a single digit (no Enter) selects a dialog under Ink.
// ---------------------------------------------------------------------------

test('runSettings: a single [5] keypress (no Enter) opens Output-detail under Ink', async () => {
  const env = withTmpHome();
  try {
    const bridge = createInkAppBridge();
    const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={80} />);
    await tick();

    const { sink } = makeOut();
    const config: AppConfig = { onboarded: true, setAsDefault: false };
    const mutableCtx = { config, env: makeEnv() };
    const ctx = { clock: makeClock() } as unknown as MenuContext;

    // readLine must NOT be consulted — single-key only on both reads.
    const readLineNever = (): Promise<string | null> => new Promise(() => {});

    const done = runSettings(ctx, mutableCtx, sink, readLineNever, () => bridge.readKey());
    await tick();
    stdin.write('5'); // open Output-detail (NO Enter)
    await tick();
    stdin.write('1'); // pick "quiet" in the verbosity sub-dialog (NO Enter)
    await tick();
    await done;

    // The single keys drove the whole flow: verbosity was set to quiet and saved.
    assert.equal(mutableCtx.config.verbosity, 'quiet', 'single-key [5] then [1] set verbosity');
    const saved = await loadConfig(env.home);
    assert.equal(saved.verbosity, 'quiet', 'the choice persisted via saveConfig');
  } finally {
    env.restore();
  }
});

test('runSettings: a bare Enter (single key) returns to the menu with no change', async () => {
  const env = withTmpHome();
  try {
    const bridge = createInkAppBridge();
    const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={80} />);
    await tick();

    const { sink } = makeOut();
    const config: AppConfig = { onboarded: true, setAsDefault: false };
    const mutableCtx = { config, env: makeEnv() };
    const ctx = { clock: makeClock() } as unknown as MenuContext;

    const done = runSettings(ctx, mutableCtx, sink, () => new Promise<string | null>(() => {}), () =>
      bridge.readKey(),
    );
    await tick();
    stdin.write(ENTER); // bare Enter → back, no dialog, no save
    await tick();
    await done;
    assert.deepEqual(mutableCtx.config, config, 'Enter is a no-op back');
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// Conversations sub-menu — a single key (no Enter) picks an action under Ink.
// ---------------------------------------------------------------------------

function makeStoreWithOne(): { store: ConversationStore; pinned: { value: boolean | null } } {
  const pinned = { value: null as boolean | null };
  const meta: ConversationMeta = {
    id: 'c1',
    title: 'Hello',
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    messageCount: 2,
    pinned: false,
    category: null,
  };
  const store = {
    async list() {
      return [meta];
    },
    async setPinned(_id: string, value: boolean) {
      pinned.value = value;
    },
    async setIntensity() {},
    async create() { return meta; },
    async load() { return []; },
    async rename() {},
    async remove() {},
    writer() { return { id: meta.id, async append() {} }; },
    async setCategory() {},
    async setRecap() {},
    async truncateAfter() { return 0; },
  } as unknown as ConversationStore;
  return { store, pinned };
}

test('runManage: a single [p] keypress (no Enter) enters the pin action under Ink', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={80} />);
  await tick();

  const { sink } = makeOut();
  const { store } = makeStoreWithOne();
  const ctx = { store, clock: makeClock() } as unknown as MenuContext;
  const confirm = async (): Promise<boolean> => false;

  // After the single-key [p] selects the pin action, the number prompt is a LINE
  // read — we feed an empty line so it cancels cleanly (no store mutation), which
  // still proves the [p] menu choice resolved on ONE key with no Enter.
  let lineCalls = 0;
  const readLine = (): Promise<string | null> => {
    lineCalls++;
    return Promise.resolve(''); // empty → cancel the number entry
  };

  const done = runManage(ctx, sink, readLine, confirm, () => bridge.readKey());
  await tick();
  stdin.write('p'); // single key, NO Enter → pin action
  await tick();
  await done;

  // The line reader was used ONLY for the number prompt that follows the menu pick
  // — the menu choice itself came from the single keypress.
  assert.equal(lineCalls, 1, 'exactly the number prompt used the line reader');
});

// ---------------------------------------------------------------------------
// Flag-OFF (no inkReadKey) keeps the legacy line/readSingleKey path.
// ---------------------------------------------------------------------------

test('runSettings flag-off (no inkReadKey) reads the choice from the line reader', async () => {
  const env = withTmpHome();
  try {
    // A NON-TTY sink: readMenuKey's rawKeyInputs returns [] → it falls back to the
    // line reader deterministically (the byte-identical legacy path when no
    // inkReadKey is wired).
    const written: string[] = [];
    const sink: OutputSink = {
      write(s: string): void {
        written.push(s);
      },
      get color(): boolean {
        return false;
      },
      get isTty(): boolean {
        return false;
      },
    };
    const config: AppConfig = { onboarded: true, setAsDefault: false };
    const mutableCtx = { config, env: makeEnv() };
    const ctx = { clock: makeClock() } as unknown as MenuContext;

    let lineCalls = 0;
    const lines = ['']; // bare line → back, no change
    const readLine = (): Promise<string | null> => {
      lineCalls++;
      return Promise.resolve(lines.shift() ?? null);
    };

    // Note: no 5th arg → inkReadKey undefined → byte-identical legacy path.
    await runSettings(ctx, mutableCtx, sink, readLine);
    assert.equal(lineCalls, 1, 'flag-off used the line reader for the menu choice');
    assert.deepEqual(mutableCtx.config, config, 'flag-off Enter is a no-op back via the line reader');
  } finally {
    env.restore();
  }
});
