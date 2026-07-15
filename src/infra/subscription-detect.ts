/**
 * src/infra/subscription-detect.ts — per-account detection for subscription
 * accounts. Uses provider-scoped env (e.g. CLAUDE_CONFIG_DIR) so detection
 * probes the correct credential home, including availableModels for true
 * per-account model inventory.
 */

import type {
  SubscriptionAccount,
  AccountStatus,
} from './subscriptions.js';
import { accountEnvFor } from './subscriptions.js';
import { refreshClaudeOauthIfNeeded } from './claude-oauth-refresh.js';
import {
  detectProvider,
  type ProviderStatus,
} from '../providers/detect.js';
import type { ProviderId } from '../providers/port.js';
import { buildAvailableModelsByAccount } from '../core/live-model-inventory.js';
import type { AvailableModelsByAccount } from '../core/execution-lane.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Injectable detect for unit tests (default: real detectProvider). */
export type DetectProviderFn = (
  id: ProviderStatus['id'],
  opts?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    credentialFileFallback?: boolean;
    storedCredentialInjection?: boolean;
  },
) => Promise<ProviderStatus>;

export interface DetectSubscriptionAccountResult {
  readonly status: AccountStatus;
  readonly plan: string | null;
  readonly expiresAt?: string;
  /**
   * Models advertised by env-scoped detect when auth is active and the list is
   * non-empty. Omitted on auth-fail / unknown / empty — callers must not invent
   * models; absent rows fall back to provider-global inventory.
   */
  readonly availableModels?: readonly string[];
}

export async function detectSubscriptionAccount(input: {
  account: SubscriptionAccount;
  cwd: string;
  nowMs: number;
  /** Override for hermetic tests. Production callers omit this. */
  detect?: DetectProviderFn;
}): Promise<DetectSubscriptionAccountResult> {
  const { account, cwd, nowMs } = input;
  const detect = input.detect ?? detectProvider;
  const accountEnv = accountEnvFor(account);

  if (account.provider === 'claude') {
    const env = { ...process.env, ...accountEnv };
    try {
      await refreshClaudeOauthIfNeeded({
        env,
        cwd,
        home: account.homeDir,
      });
    } catch {
      // refresh is best-effort; detection continues
    }

    const status = await detect('claude', {
      env,
      cwd,
      credentialFileFallback: true,
      storedCredentialInjection: false,
    }).catch(() => null);

    if (status === null) {
      return { status: 'auth-failed', plan: null };
    }

    const expired = await isCredsFileExpired(account.homeDir, nowMs);
    const active = status.authenticated && !expired;

    let expiresAt: string | undefined;
    try {
      const credsPath = join(account.homeDir, '.credentials.json');
      const raw = await readFile(credsPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const oauth = parsed['claudeAiOauth'] as Record<string, unknown> | undefined;
      if (oauth !== undefined && typeof oauth['expiresAt'] === 'number') {
        expiresAt = new Date(oauth['expiresAt']).toISOString();
      }
    } catch {
      // no creds file or unreadable — leave expiresAt unset
    }

    return {
      status: active ? 'active' : 'auth-failed',
      plan: status.plan,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...modelsIfActive(active, status.availableModels),
    };
  }

  if (account.provider === 'codex') {
    const env = { ...process.env, ...accountEnv };
    const status = await detect('codex', {
      env,
      cwd,
    }).catch(() => null);

    if (status === null) {
      return { status: 'auth-failed', plan: null };
    }

    const active = status.authenticated;
    return {
      status: active ? 'active' : 'auth-failed',
      plan: status.plan,
      ...modelsIfActive(active, status.availableModels),
    };
  }

  if (account.provider === 'grok') {
    const env = { ...process.env, ...accountEnv };
    const status = await detect('grok', {
      env,
      cwd,
    }).catch(() => null);

    if (status === null) {
      return { status: 'auth-failed', plan: null };
    }

    const active = status.authenticated;
    return {
      status: active ? 'active' : 'auth-failed',
      plan: status.plan,
      ...modelsIfActive(active, status.availableModels),
    };
  }

  if (account.provider === 'opencode') {
    // accountEnvFor sets XDG_DATA_HOME to the isolated account home so
    // detect reads that account's auth/models, not the ambient session.
    const env = { ...process.env, ...accountEnv };
    const status = await detect('opencode', {
      env,
      cwd,
    }).catch(() => null);

    if (status === null) {
      return { status: 'auth-failed', plan: null };
    }

    const active = status.authenticated;
    return {
      status: active ? 'active' : 'auth-failed',
      plan: status.plan,
      ...modelsIfActive(active, status.availableModels),
    };
  }

  // Exhaustive guard — all SubscriptionProvider variants handled above.
  return { status: 'unknown', plan: null };
}

/**
 * Fail-soft parallel per-account model probe.
 *
 * Runs env-scoped detect for each managed account (via
 * {@link detectSubscriptionAccount}). Only emits a row when detect is
 * authenticated/active and returns a non-empty model list — never invents
 * models. Auth-fail / throw / empty → omit that account (global fallback).
 *
 * Returns `undefined` when no real rows were produced (caller may fall back
 * to provisional provider-global copy). Prefer this map over provisional
 * when any real rows exist.
 */
export async function probeAvailableModelsByAccount(
  accounts: readonly SubscriptionAccount[],
  cwd: string,
  opts?: {
    readonly nowMs?: number;
    readonly detect?: DetectProviderFn;
  },
): Promise<AvailableModelsByAccount | undefined> {
  if (accounts.length === 0) return undefined;

  const nowMs = opts?.nowMs ?? Date.now();
  const detect = opts?.detect;

  const settled = await Promise.all(
    accounts.map(async (account) => {
      try {
        const result = await detectSubscriptionAccount({
          account,
          cwd,
          nowMs,
          ...(detect !== undefined ? { detect } : {}),
        });
        const models = result.availableModels;
        if (
          result.status !== 'active' ||
          models === undefined ||
          models.length === 0
        ) {
          return null;
        }
        return {
          provider: account.provider as ProviderId,
          accountId: account.id,
          models,
        };
      } catch {
        return null;
      }
    }),
  );

  const entries = settled.filter(
    (e): e is { provider: ProviderId; accountId: string; models: readonly string[] } =>
      e !== null,
  );
  if (entries.length === 0) return undefined;
  return buildAvailableModelsByAccount(entries);
}

function modelsIfActive(
  active: boolean,
  availableModels: readonly string[] | undefined,
): { availableModels?: readonly string[] } {
  if (!active) return {};
  if (availableModels === undefined || availableModels.length === 0) return {};
  return { availableModels };
}

async function isCredsFileExpired(homeDir: string, nowMs: number): Promise<boolean> {
  try {
    const credsPath = join(homeDir, '.credentials.json');
    const raw = await readFile(credsPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed['claudeAiOauth'] as Record<string, unknown> | undefined;
    if (oauth !== undefined && typeof oauth['expiresAt'] === 'number') {
      return oauth['expiresAt'] <= nowMs;
    }
    return false;
  } catch {
    return false;
  }
}
