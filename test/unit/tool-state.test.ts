/**
 * test/unit/tool-state.test.ts — TOOL SELF-AWARENESS renderer (tool-state §).
 *
 * `buildToolStateContext` is the pure renderer that turns the live, already-
 * detected EnvironmentStatus + Config + version into the authoritative "ABOUT
 * THIS TOOL" block. These table tests pin its honesty contract: counts/plans/mode
 * are DERIVED (never hardcoded, never fabricated); a plan-null authed provider is
 * "authed (plan unknown)"; installed-but-unauthed is noted, not counted as authed;
 * none-authed is stated plainly; auto vs explicit mode and smartRoute on/off both
 * render. Pure — no I/O, no model call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolStateContext,
  buildCapabilitySummary,
  TOOL_STATE_BLOCK_CHAR_CAP,
  type ToolStateProvider,
  type CapabilitySelfAwarenessSummary,
} from '../../src/core/tool-state.ts';
import type { CapabilityRegistry } from '../../src/core/model-capabilities.ts';

function prov(
  label: string,
  over: Partial<ToolStateProvider> = {},
): ToolStateProvider {
  return {
    label,
    installed: true,
    authenticated: true,
    plan: null,
    ...over,
  };
}

const V = '3.19.0';

describe('buildToolStateContext', () => {
  it('renders 3 authed providers with their plans and the correct count', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [
        prov('Claude', { plan: 'max' }),
        prov('Codex', { plan: 'max' }),
        prov('OpenCode', { plan: 'go' }),
      ],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(out, /3 authed/);
    assert.match(out, /Claude — max/);
    assert.match(out, /Codex — max/);
    assert.match(out, /OpenCode — go/);
    // version is derived, not hardcoded
    assert.match(out, /myshell-tools v3\.19\.0/);
  });

  it('renders an authed provider whose plan is null as "authed (plan unknown)" — never fabricated', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [
        prov('Claude', { plan: 'max' }),
        prov('Codex', { plan: null }), // codex never exposes a plan
      ],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(out, /2 authed/);
    assert.match(out, /Codex — authed \(plan unknown\)/);
    // No guessed tier for codex.
    assert.doesNotMatch(out, /Codex — (max|pro|free)/i);
  });

  it('notes a provider installed-but-not-signed-in without counting it as authed', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [
        prov('Claude', { plan: 'max' }),
        prov('Codex', { installed: true, authenticated: false }),
        prov('OpenCode', { installed: false, authenticated: false }),
      ],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(out, /1 authed/);
    assert.match(out, /also installed but not signed in: Codex/);
    // OpenCode is not installed → not mentioned in the installed-not-authed list.
    assert.doesNotMatch(out, /not signed in:[^.\n]*OpenCode/);
  });

  it('states plainly when NO provider is authed (and lists installed-but-unauthed)', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [
        prov('Claude', { installed: true, authenticated: false }),
        prov('Codex', { installed: true, authenticated: false }),
        prov('OpenCode', { installed: false, authenticated: false }),
      ],
      mode: 'balanced',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(out, /none authed/);
    assert.match(out, /not signed in to any provider yet/);
    assert.match(out, /Claude, Codex are installed but not signed in/);
  });

  it('distinguishes auto-derived mode from an explicitly set one', () => {
    const auto = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'max' })],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(auto, /Mode: Max \(auto-selected from your plans/);

    const explicit = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'max' })],
      mode: 'cost-saver',
      modeIsAuto: false,
      smartRoute: true,
    });
    assert.match(explicit, /Mode: Efficient \(explicitly set by you/);
  });

  it('uses the canonical MODE_LABELS (Efficient / Balanced / Max) in the modes gloss', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'pro' })],
      mode: 'balanced',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(out, /Mode: Balanced/);
    assert.match(out, /Efficient:/);
    assert.match(out, /Balanced:/);
    assert.match(out, /Max:/);
  });

  it('renders smart routing on/off from the input', () => {
    const on = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'max' })],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(on, /Smart routing: on\./);

    const off = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'max' })],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: false,
    });
    assert.match(off, /Smart routing: off\./);
  });

  it('lists what the tool can do (the key /help commands)', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'max' })],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    for (const cmd of ['/mode', '/memory', '/recap', '/goal', '/copy', '/export', '/retry', '/edit', '/style']) {
      assert.ok(out.includes(cmd), `expected ${cmd} in capabilities line`);
    }
  });

  it('opens with the authoritative ABOUT THIS TOOL header and the subscription framing', () => {
    const out = buildToolStateContext({
      version: V,
      providers: [prov('Claude', { plan: 'max' })],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.match(out, /^ABOUT THIS TOOL \(authoritative/);
    assert.match(out, /subscription-based, not API keys/);
  });

  it('self-caps to the block budget', () => {
    const out = buildToolStateContext({
      version: 'x'.repeat(5000),
      providers: [prov('Claude', { plan: 'y'.repeat(5000) })],
      mode: 'quality-first',
      modeIsAuto: true,
      smartRoute: true,
    });
    assert.ok(out.length <= TOOL_STATE_BLOCK_CHAR_CAP);
  });

  it('is pure — same input → same output', () => {
    const input = {
      version: V,
      providers: [prov('Claude', { plan: 'max' }), prov('Codex', { plan: null })],
      mode: 'quality-first' as const,
      modeIsAuto: true,
      smartRoute: true,
    };
    assert.equal(buildToolStateContext(input), buildToolStateContext(input));
  });
});

// ---------------------------------------------------------------------------
// Capability summary (Stage 1, §4) — buildCapabilitySummary + rendering
// ---------------------------------------------------------------------------

const V2 = '3.20.0';

/** A merged-registry fixture: Codex with cache facts, Claude declarative-only. */
const REG: CapabilityRegistry = {
  claude: [
    {
      provider: 'claude',
      id: 'opus',
      aliases: [],
      tierHint: 'manager',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
  ],
  codex: [
    {
      provider: 'codex',
      id: 'gpt-5.5',
      aliases: [],
      tierHint: 'manager',
      displayName: 'GPT-5.5',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
      contextWindow: 272000,
      supportsVision: true,
      supportsNativeSession: true,
      source: ['declarative', 'detect', 'codex-cache'],
      lastRefreshedAt: '2026-06-06T00:00:00Z',
    },
  ],
  opencode: [],
};

function baseInput(over: Partial<Parameters<typeof buildToolStateContext>[0]> = {}) {
  return {
    version: V2,
    providers: [prov('Claude'), prov('Codex')],
    mode: 'quality-first' as const,
    modeIsAuto: false,
    smartRoute: true,
    ...over,
  };
}

describe('buildCapabilitySummary', () => {
  it('keeps only known objective fields, omits empty-effort providers cleanly', () => {
    const summary = buildCapabilitySummary(
      REG,
      { claude: true, codex: true, opencode: false },
      (p) => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' })[p] ?? p,
    );
    assert.ok(summary);
    const codex = summary.providers.find((p) => p.provider === 'codex');
    assert.equal(codex?.authed, true);
    const m = codex?.models[0];
    assert.deepEqual(m?.reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(m?.contextWindow, 272000);
    assert.equal(m?.supportsVision, true);
    // Claude opus has NO efforts → reasoningEfforts omitted entirely
    const claude = summary.providers.find((p) => p.provider === 'claude');
    assert.equal(claude?.models[0]?.reasoningEfforts, undefined);
    // opencode is empty → not present in the summary
    assert.equal(summary.providers.find((p) => p.provider === 'opencode'), undefined);
  });

  it('returns undefined when no provider has any model', () => {
    const empty: CapabilityRegistry = { claude: [], codex: [], opencode: [] };
    assert.equal(
      buildCapabilitySummary(empty, { claude: false, codex: false, opencode: false }, (p) => p),
      undefined,
    );
  });
});

describe('buildToolStateContext — capability summary rendering', () => {
  it('renders the Codex reasoning-effort summary when present', () => {
    const summary = buildCapabilitySummary(
      REG,
      { claude: true, codex: true, opencode: false },
      (p) => ({ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' })[p] ?? p,
    );
    assert.ok(summary);
    const out = buildToolStateContext(baseInput({ capabilitySummary: summary }));
    assert.match(out, /Known model capabilities/);
    assert.match(out, /reasoning low\/medium\/high\/xhigh/);
    assert.match(out, /272k context/);
    assert.match(out, /Routing explanation/);
    // Must NOT claim a Claude reasoning effort knob.
    assert.match(out, /do NOT claim a model is "better" or has a knob/);
    assert.ok(!/opus \(reasoning/.test(out), 'Claude opus must show no reasoning efforts');
  });

  it('omits the capability portion cleanly when summary is absent (block unchanged)', () => {
    const out = buildToolStateContext(baseInput());
    assert.ok(!/Known model capabilities/.test(out));
    assert.ok(!/Routing explanation/.test(out));
  });

  it('respects the whole-block char cap with the summary appended', () => {
    // A large registry that would overflow if uncapped.
    const big: CapabilityRegistry = {
      claude: [],
      codex: Array.from({ length: 20 }, (_v, i) => ({
        provider: 'codex' as const,
        id: `gpt-x-${i}`,
        aliases: [],
        tierHint: 'manager' as const,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
        contextWindow: 272000,
        supportsVision: true,
        supportsNativeSession: true,
        source: ['codex-cache'] as const,
      })),
      opencode: [],
    };
    const summary = buildCapabilitySummary(big, { claude: false, codex: true, opencode: false }, (p) => p) as CapabilitySelfAwarenessSummary;
    const out = buildToolStateContext(baseInput({ capabilitySummary: summary }));
    assert.ok(out.length <= TOOL_STATE_BLOCK_CHAR_CAP, `block ${out.length} > cap ${TOOL_STATE_BLOCK_CHAR_CAP}`);
    // capped to top 3 models per provider
    assert.ok(!/gpt-x-3\b/.test(out), 'only top 3 models per provider are rendered');
  });
});
