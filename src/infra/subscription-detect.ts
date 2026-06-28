/**
 * src/infra/subscription-detect.ts — per-account detection for subscription
 * accounts. Uses provider-scoped env (e.g. CLAUDE_CONFIG_DIR) so detection
 * probes the correct credential home.
 */

import type {
  SubscriptionAccount,
  AccountStatus,
} from './subscriptions.js';
import { accountEnvFor } from './subscriptions.js';
import { refreshClaudeOauthIfNeeded } from './claude-oauth-refresh.js';
import { detectProvider } from '../providers/detect.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function detectSubscriptionAccount(input: {
  account: SubscriptionAccount;
  cwd: string;
  nowMs: number;
}): Promise<{ status: AccountStatus; plan: string | null; expiresAt?: string }> {
  const { account, cwd, nowMs } = input;
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

    const status = await detectProvider('claude', {
      env,
      cwd,
      credentialFileFallback: true,
      storedCredentialInjection: false,
    }).catch(() => null);

    if (status === null) {
      return { status: 'auth-failed', plan: null };
    }

    const active =
      status.authenticated &&
      !isCredsFileExpired(account.homeDir, nowMs);

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
    };
  }

  // Other providers not yet supported for per-account detection
  return { status: 'unknown', plan: null };
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
