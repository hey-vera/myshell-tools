import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { legacyModeToIntensity } from '../../src/core/capacity-allocator.ts';
import {
  resolveIntensity,
  resolveAutoMode,
  resolveAutoModeFromAccounts,
  resolveAutoModeFromEnvironment,
  planBudgetCeiling,
  autoModeReason,
  usableAccountsForAuto,
  accountPlanStrings,
} from '../../src/interface/menu-auto-mode.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import type { SubscriptionAccount } from '../../src/infra/subscriptions.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// resolveIntensity (unchanged contract)
// ---------------------------------------------------------------------------

describe('resolveIntensity', () => {
  const baseConfig: AppConfig = { onboarded: true, setAsDefault: false };

  it('prefers a conversation numeric override over global and legacy config', () => {
    const resolved = resolveIntensity(
      { intensity: 2 },
      { ...baseConfig, intensity: 5, mode: 'quality-first', panel: true, hedge: true },
    );
    assert.deepEqual(resolved, { source: 'conversation', value: 2 });
  });

  it('falls back to the global numeric default when the conversation is absent or auto', () => {
    assert.deepEqual(
      resolveIntensity(undefined, { ...baseConfig, intensity: 4 }),
      { source: 'global', value: 4 },
    );
    assert.deepEqual(
      resolveIntensity({ intensity: 'auto' }, { ...baseConfig, intensity: 3 }),
      { source: 'global', value: 3 },
    );
  });

  it('falls through auto values to the legacy bridge when legacy keys are present', () => {
    const config = { ...baseConfig, intensity: 'auto', mode: 'cost-saver' as const, hedge: true };
    assert.deepEqual(
      resolveIntensity({ intensity: 'auto' }, config),
      { source: 'legacy', value: legacyModeToIntensity('cost-saver', { hedge: true }) },
    );
  });

  it('uses legacy mode/panel/hedge precedence when no new numeric override exists', () => {
    assert.deepEqual(
      resolveIntensity(undefined, { ...baseConfig, mode: 'balanced', panel: true }),
      { source: 'legacy', value: legacyModeToIntensity('balanced', { panel: true }) },
    );
    assert.deepEqual(
      resolveIntensity(undefined, { ...baseConfig, hedge: true }),
      { source: 'legacy', value: legacyModeToIntensity('balanced', { hedge: true }) },
    );
  });

  it('returns auto when neither new nor legacy settings are present', () => {
    assert.deepEqual(resolveIntensity(undefined, baseConfig), { source: 'auto', value: 'auto' });
  });
});

// ---------------------------------------------------------------------------
// P1.2 — Accounts inventory is Auto truth (not ambient CLI Pro theater)
// ---------------------------------------------------------------------------

function makeEnv(
  plans: Partial<Record<string, { plan: string | null; authenticated: boolean }>>,
): EnvironmentStatus {
  const empty = {
    id: 'claude' as const,
    installed: true,
    version: '1.0.0',
    authenticated: false,
    plan: null as string | null,
    binaryPath: 'x',
    availableModels: [] as string[],
  };
  const p = (
    id: 'claude' | 'codex' | 'opencode' | 'grok',
    over?: { plan: string | null; authenticated: boolean },
  ) => ({
    ...empty,
    id,
    authenticated: over?.authenticated ?? false,
    plan: over?.plan ?? null,
  });
  return {
    claude: p('claude', plans.claude),
    codex: p('codex', plans.codex),
    opencode: p('opencode', plans.opencode),
    grok: p('grok', plans.grok),
    hasAnyProvider: true,
    platform: 'linux',
  };
}

function makeAccount(
  over: Partial<SubscriptionAccount> & { plan?: string | null } = {},
): SubscriptionAccount {
  return {
    id: over.id ?? 'acc-1',
    provider: (over.provider ?? 'claude') as 'claude',
    kind: 'oauth-sub',
    label: over.label ?? 'Claude',
    homeDir: over.homeDir ?? '/tmp/claude/acc-1',
    priority: over.priority ?? 'medium',
    priorityWeight: over.priorityWeight ?? 100,
    enabled: over.enabled ?? true,
    createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
    status: over.status ?? 'active',
    ...(over.plan !== undefined ? { plan: over.plan } : {}),
  } as SubscriptionAccount;
}

describe('P1.2 Accounts-as-Auto-truth', () => {
  it('empty Accounts → balanced even when ambient CLI reports Pro/Max', () => {
    const envPro = makeEnv({
      claude: { plan: 'claude pro', authenticated: true },
    });
    // Ambient alone still classifies (doctor/internal)
    assert.equal(resolveAutoModeFromEnvironment(envPro), 'balanced'); // pro → balanced
    const envMax = makeEnv({
      claude: { plan: 'claude max 20x', authenticated: true },
    });
    assert.equal(resolveAutoModeFromEnvironment(envMax), 'quality-first');

    // Product Auto with empty Accounts never markets ambient Max/Pro
    assert.equal(resolveAutoMode(envMax, []), 'balanced');
    assert.equal(resolveAutoMode(envMax), 'balanced'); // omitted accounts → honest balanced
    assert.equal(planBudgetCeiling(envMax, []), 2);
  });

  it('Accounts Max plan → quality-first and ceiling 3', () => {
    const env = makeEnv({}); // ambient empty
    const accounts = [makeAccount({ plan: 'claude max 20x' })];
    assert.equal(resolveAutoMode(env, accounts), 'quality-first');
    assert.equal(resolveAutoModeFromAccounts(accounts), 'quality-first');
    assert.equal(planBudgetCeiling(env, accounts), 3);
  });

  it('Accounts free-only → cost-saver and ceiling 1', () => {
    const accounts = [makeAccount({ plan: 'claude free' })];
    assert.equal(resolveAutoModeFromAccounts(accounts), 'cost-saver');
    assert.equal(planBudgetCeiling(makeEnv({}), accounts), 1);
  });

  it('Accounts Pro → balanced', () => {
    const accounts = [makeAccount({ plan: 'pro' })];
    assert.equal(resolveAutoModeFromAccounts(accounts), 'balanced');
  });

  it('disabled/expired/auth-failed accounts do not raise Auto posture', () => {
    const accounts = [
      makeAccount({ id: 'max-disabled', plan: 'claude max', enabled: false }),
      makeAccount({ id: 'max-expired', plan: 'claude max', status: 'expired' }),
      makeAccount({ id: 'max-failed', plan: 'claude max', status: 'auth-failed' }),
      makeAccount({ id: 'max-prio-off', plan: 'claude max', priority: 'disabled', enabled: false }),
    ];
    assert.equal(usableAccountsForAuto(accounts).length, 0);
    assert.equal(resolveAutoModeFromAccounts(accounts), 'balanced');
    assert.deepEqual(accountPlanStrings(accounts), []);
  });

  it('strongest usable Accounts plan wins (Max over Free)', () => {
    const mixed: SubscriptionAccount[] = [
      makeAccount({ id: 'free', plan: 'free' }),
      makeAccount({ id: 'max', plan: 'max' }),
    ];
    assert.equal(resolveAutoModeFromAccounts(mixed), 'quality-first');
  });

  it('autoModeReason never markets ambient Pro when Accounts empty', () => {
    const env = makeEnv({
      claude: { plan: 'claude pro', authenticated: true },
    });
    // Match plan tier marketing ("Pro"/"1 Pro"), not the word "provider"
    const marketsPro = (s: string): boolean => /\bpro\b/i.test(s) || /1 Pro/.test(s);
    const reasonEmpty = autoModeReason(env, true, []);
    assert.ok(!marketsPro(reasonEmpty), `got: ${reasonEmpty}`);
    assert.ok(reasonEmpty.includes('auto'), `got: ${reasonEmpty}`);
    assert.ok(
      reasonEmpty.includes('per-turn effort'),
      `expected smart suffix: ${reasonEmpty}`,
    );

    const reasonOmitted = autoModeReason(env, false);
    assert.ok(!marketsPro(reasonOmitted), `got: ${reasonOmitted}`);
    assert.equal(reasonOmitted.startsWith('auto'), true);
  });

  it('autoModeReason with Accounts Max summarizes inventory (not ambient)', () => {
    const env = makeEnv({
      claude: { plan: 'free', authenticated: true }, // ambient free must not dominate
    });
    const accounts = [makeAccount({ plan: 'claude max 5x' })];
    const reason = autoModeReason(env, true, accounts);
    assert.ok(reason.includes('Max'), `expected Max from accounts: ${reason}`);
    assert.ok(!reason.includes('Free'), `ambient free must not appear: ${reason}`);
  });
});
