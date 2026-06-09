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

// ---------------------------------------------------------------------------
// Minimal fakes — renderMainScreen reads only ctx.version, ctx.clock.now(),
// mutableCtx.config / .env, the SpendSummary, and writes through OutputSink.
// ---------------------------------------------------------------------------

function makeProvider(
  id: 'claude' | 'codex' | 'opencode',
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
  hasAnyProvider: true,
  platform: 'linux',
};

const ENV_CLAUDE_AUTHED: EnvironmentStatus = {
  claude: makeProvider('claude', { installed: true, authenticated: true }),
  codex: makeProvider('codex', { installed: true, authenticated: false }),
  opencode: makeProvider('opencode', { installed: false }),
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
    // Names the exact keys so a brand-new user knows the next step.
    assert.ok(out.includes('[j] Claude'), 'CTA must name the [j] Claude key');
    assert.ok(out.includes('[k] Codex'), 'CTA must name the [k] Codex key');
    assert.ok(out.includes('[o] opencode'), 'CTA must name the [o] opencode key');
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
    hasAnyProvider: true,
    platform: 'linux',
  };
}

describe('renderMainScreen — tier-adaptive auto posture label', () => {
  it('Max plan → the auto line reads "→ full"', async () => {
    const out = await render(envWithClaudePlan('claude max 20x'));
    assert.ok(out.includes('(auto'), 'mode line shows the auto indicator');
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
