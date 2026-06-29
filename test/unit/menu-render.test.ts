/**
 * test/unit/menu-render.test.ts — unit tests for the main-screen render block
 * in src/interface/menu-render.ts.
 *
 * Focus: the "you must sign in" call-to-action. It must appear (prominent, single
 * line, naming the [j]/[k]/[o] keys) when NO provider is authenticated, and be
 * entirely absent once at least one provider is signed in. Pure render over
 * injected state — no I/O, driven by a capturing OutputSink.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated data, no mock
 * AI-response phrases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMainScreen } from '../../src/interface/menu-render.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import type { SpendSummary } from '../../src/infra/insights.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { ConversationMeta } from '../../src/infra/conversation-store.ts';
import type { Goal } from '../../src/core/goal-todo.ts';

// ---------------------------------------------------------------------------
// Minimal fakes — renderMainScreen reads only ctx.version, ctx.clock.now(),
// mutableCtx.config / .env, the SpendSummary, and writes through OutputSink.
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

async function render(env: EnvironmentStatus): Promise<string> {
  const { sink, text } = makeSink();
  await renderMainScreen(
    makeCtx(),
    { config: {} as AppConfig, env },
    [],
    EMPTY_SPEND,
    sink,
  );
  return text();
}

// ---------------------------------------------------------------------------

describe('renderMainScreen — sign-in call-to-action', () => {
  it('renders the prominent CTA when NO provider is authenticated', async () => {
    const out = await render(ENV_NONE_AUTHED);
    assert.ok(
      out.includes('Not signed in yet'),
      `expected the sign-in CTA when unauthenticated, got:\n${out}`,
    );
    assert.ok(out.includes('[a] Accounts'), 'CTA must name the [a] Accounts entry');
  });

  it('the CTA is a single line', async () => {
    const out = await render(ENV_NONE_AUTHED);
    const ctaLine = out
      .split('\n')
      .find((l) => l.includes('Not signed in yet'));
    assert.ok(ctaLine !== undefined, 'CTA line should exist');
    assert.ok(
      !ctaLine.includes('\n'),
      'CTA must be a single line',
    );
  });

  it('does NOT render the CTA when at least one provider is signed in', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(
      !out.includes('Not signed in yet'),
      `CTA must be absent once a provider is authed, got:\n${out}`,
    );
  });

  it('shows the sign-in empty-state line when unauthenticated', async () => {
    const out = await render(ENV_NONE_AUTHED);
    assert.ok(out.includes('Sign in to begin'), 'empty-state should read "Sign in to begin"');
    assert.ok(
      !out.includes('press n to start'),
      'unauthenticated menu must not push "press n to start"',
    );
  });

  it('shows "press n to start" empty-state when a provider is authed', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(out.includes('press n to start'), 'authed empty-state should read "press n to start"');
    assert.ok(!out.includes('Sign in to begin'), 'authed menu must not show "Sign in to begin"');
  });
});

// ---------------------------------------------------------------------------
// TIER-ADAPTIVE AUTO MODE — the honest posture label (master-plan PHASE 4 / A)
//
// The auto mode line names the adaptive POSTURE the detected tier sets — "→ full"
// (Max), "→ balanced" (Pro / undetected — the SAFE middle), "→ conservative"
// (Free). The word is a pure projection of the same mode the Governor derives its
// budget from, so the always-on LABEL can never overstate what the plan buys.
// Crucially: an undetected plan never reads as the Max "full".
// ---------------------------------------------------------------------------

function envWithClaudePlan(plan: string | null): EnvironmentStatus {
  return {
    claude: { ...makeProvider('claude', { installed: true, authenticated: true }), plan },
    codex: makeProvider('codex', { installed: true, authenticated: false }),
    opencode: makeProvider('opencode', { installed: false }),
    grok: makeProvider('grok', { installed: false }),
    hasAnyProvider: true,
    platform: 'linux',
  };
}

describe('renderMainScreen — tier-adaptive auto posture label', () => {
  it('Max plan → the auto line reads "→ full"', async () => {
    const out = await render(envWithClaudePlan('claude max 20x'));
    assert.ok(out.includes('Auto (smart)'), 'mode line shows Auto (smart) when unset');
    assert.ok(out.includes('→ full'), `Max plan must read "→ full"; got:\n${out}`);
  });

  it('Free plan → the auto line reads "→ conservative" (frugal, said plainly)', async () => {
    const out = await render(envWithClaudePlan('claude free'));
    assert.ok(out.includes('→ conservative'), `Free plan must read "→ conservative"; got:\n${out}`);
    assert.ok(!out.includes('→ full'), 'a Free plan never reads as the Max "full"');
  });

  it('undetected plan → "→ balanced" (the SAFE middle), NEVER "→ full"', async () => {
    // Claude authed but the CLI reported no plan (plan: null) → balanced posture.
    const out = await render(envWithClaudePlan(null));
    assert.ok(out.includes('→ balanced'), `undetected plan must read "→ balanced"; got:\n${out}`);
    assert.ok(!out.includes('→ full'), 'an undetected plan must never assume the Max "full"');
    // And it must not nag the compact line with "no plan reported".
    assert.ok(!out.includes('no plan reported'), 'compact line never nags about a missing plan');
  });
});

// ---------------------------------------------------------------------------
// Slice B — Home Screen & Control Panel Restructure
// ---------------------------------------------------------------------------

describe('renderMainScreen — Slice B home screen restructure', () => {
  it('does NOT render a parked-goals section', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(!out.includes('Goals · Parked'), 'home screen must not show parked-goals section');
  });

  it('does NOT render [g] Manage goals entry', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(!out.includes('[g]'), 'home screen must not show [g] Manage goals');
  });

  it('does NOT render [d] Diagnose entry', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(!out.includes('[d]'), 'home screen must not show [d] Diagnose');
  });

  it('does NOT render [$] Usage entry', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(!out.includes('[$]'), 'home screen must not show [$] Usage');
  });

  it('renders [a] Accounts entry collapsed (not individual provider entries)', async () => {
    const out = await render(ENV_CLAUDE_AUTHED);
    assert.ok(out.includes('[a]'), 'home screen must show [a] Accounts entry');
    assert.ok(!out.includes('[j]'), 'home screen must not show individual [j] Claude entry');
    assert.ok(!out.includes('[k]'), 'home screen must not show individual [k] Codex entry');
    assert.ok(!out.includes('[o]'), 'home screen must not show individual [o] opencode entry');
    assert.ok(!out.includes('[p]'), 'home screen must not show individual [p] grok entry');
  });

  it('renders conversation rows with mode and message count', async () => {
    const { sink, text } = makeSink();
    const meta: ConversationMeta = {
      id: 'conv-1',
      title: 'Test conversation',
      createdAt: '2023-11-14T20:13:20.000Z',
      updatedAt: '2023-11-14T21:13:20.000Z',
      messageCount: 42,
      pinned: false,
      category: null,
      mode: 'budget',
    };
    await renderMainScreen(
      makeCtx(),
      { config: {} as AppConfig, env: ENV_CLAUDE_AUTHED },
      [meta],
      EMPTY_SPEND,
      sink,
    );
    const out = text();
    assert.ok(out.includes('Test conversation'), 'row shows title');
    assert.ok(out.includes('| budget'), 'row shows mode label');
    assert.ok(out.includes('42 msgs'), 'row shows message count');
  });

  it('shows goal badge on conversation row when linked goals exist', async () => {
    const { sink, text } = makeSink();
    const meta: ConversationMeta = {
      id: 'conv-1',
      title: 'Goal conversation',
      createdAt: '2023-11-14T20:13:20.000Z',
      updatedAt: '2023-11-14T21:13:20.000Z',
      messageCount: 5,
      pinned: false,
      category: null,
    };
    const goal: Goal = {
      id: 'goal-1',
      title: 'Test goal',
      state: 'running',
      roadmap: [],
      createdAt: '2023-11-14T18:00:00.000Z',
      lastTouched: '2023-11-14T21:00:00.000Z',
      source: 'user-explicit' as const,
      scope: 'global' as const,
      projectKey: null,
      conversationId: 'conv-1',
      goalVerdict: null,
      children: [],
    };
    await renderMainScreen(
      makeCtx(),
      { config: {} as AppConfig, env: ENV_CLAUDE_AUTHED },
      [meta],
      EMPTY_SPEND,
      sink,
      undefined, undefined, false, [],
      [goal],
    );
    const out = text();
    assert.ok(out.includes('Goal conversation'), 'row shows title');
    assert.ok(out.includes('goals: active'), 'row shows goals: active badge');
  });

  it('does NOT show goal badge when no linked goals', async () => {
    const { sink, text } = makeSink();
    const meta: ConversationMeta = {
      id: 'conv-1',
      title: 'No-goal conversation',
      createdAt: '2023-11-14T20:13:20.000Z',
      updatedAt: '2023-11-14T21:13:20.000Z',
      messageCount: 3,
      pinned: false,
      category: null,
    };
    await renderMainScreen(
      makeCtx(),
      { config: {} as AppConfig, env: ENV_CLAUDE_AUTHED },
      [meta],
      EMPTY_SPEND,
      sink,
    );
    const out = text();
    assert.ok(out.includes('No-goal conversation'), 'row shows title');
    assert.ok(!out.includes('goals:'), 'row must not show goal badge when no linked goals');
  });
});
