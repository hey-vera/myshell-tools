import { join, sep } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { atomicWrite } from './atomic.js';
import { defaultStateHome } from './state-dir.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriptionAccountId = string;
export type SubscriptionProvider = 'opencode';
export type OpencodePool = 'zen' | 'go';
export type AccountPriority = 'low' | 'medium' | 'high' | 'disabled';

export interface OpencodeSubscriptionAccount {
  readonly id: SubscriptionAccountId;
  readonly provider: 'opencode';
  readonly label: string;
  readonly pool: OpencodePool;
  readonly homeDir: string;
  readonly priority: AccountPriority;
  readonly priorityWeight: number;
  readonly expiresAt?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface SubscriptionsFileV1 {
  readonly version: 1;
  readonly accounts: readonly OpencodeSubscriptionAccount[];
}

export type SubscriptionAccount = OpencodeSubscriptionAccount;

// ---------------------------------------------------------------------------
// Priority mapping
// ---------------------------------------------------------------------------

export function priorityWeight(priority: AccountPriority): number {
  if (priority === 'low') return 25;
  if (priority === 'medium') return 100;
  if (priority === 'high') return 200;
  return 0;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getSubscriptionsDir(stateHome?: string): string {
  return join(stateHome ?? defaultStateHome(), '.myshell-tools');
}

export function getSubscriptionsPath(stateHome?: string): string {
  return join(getSubscriptionsDir(stateHome), 'subscriptions.json');
}

export function getOpencodeAccountHome(accountId: string, stateHome?: string): string {
  return join(getSubscriptionsDir(stateHome), 'opencode-accounts', accountId);
}

export function getOpencodeAccountAuthPath(account: OpencodeSubscriptionAccount): string {
  return join(account.homeDir, 'opencode', 'auth.json');
}

// ---------------------------------------------------------------------------
// Read / Write / Update
// ---------------------------------------------------------------------------

export async function readSubscriptions(stateHome?: string): Promise<SubscriptionsFileV1> {
  const empty: SubscriptionsFileV1 = { version: 1, accounts: [] };
  try {
    const raw = await readFile(getSubscriptionsPath(stateHome), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SubscriptionsFileV1>;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.accounts)) {
      return { version: 1, accounts: parsed.accounts };
    }
    return empty;
  } catch {
    return empty;
  }
}

export async function writeSubscriptions(
  file: SubscriptionsFileV1,
  stateHome?: string,
): Promise<void> {
  const dir = getSubscriptionsDir(stateHome);
  await mkdir(dir, { recursive: true });
  await atomicWrite(
    getSubscriptionsPath(stateHome),
    JSON.stringify(file, null, 2),
    0o600,
  );
}

export async function updateSubscriptions(
  updater: (file: SubscriptionsFileV1) => SubscriptionsFileV1,
  stateHome?: string,
): Promise<SubscriptionsFileV1> {
  const current = await readSubscriptions(stateHome);
  const next = updater(current);
  await writeSubscriptions(next, stateHome);
  return next;
}

// ---------------------------------------------------------------------------
// Account factory
// ---------------------------------------------------------------------------

export function newOpencodeAccount(input: {
  id: string;
  label: string;
  pool: OpencodePool;
  priority?: AccountPriority;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
}): OpencodeSubscriptionAccount {
  const resolvedPriority = input.priority ?? 'medium';
  const homeDir = getOpencodeAccountHome(input.id, input.stateHome);
  return {
    id: input.id,
    provider: 'opencode',
    label: input.label,
    pool: input.pool,
    homeDir,
    priority: resolvedPriority,
    priorityWeight: priorityWeight(resolvedPriority),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    enabled: resolvedPriority !== 'disabled',
    createdAt: input.nowIso,
  };
}

// ---------------------------------------------------------------------------
// Auth JSON writer
// ---------------------------------------------------------------------------

export async function writeOpencodeAuthJson(input: {
  account: OpencodeSubscriptionAccount;
  apiKey: string;
}): Promise<void> {
  const providerId = input.account.pool === 'go' ? 'opencode-go' : 'opencode';
  const body = {
    [providerId]: {
      type: 'api',
      key: input.apiKey,
    },
  };
  const authDir = join(input.account.homeDir, 'opencode');
  await mkdir(authDir, { recursive: true });
  const authPath = join(authDir, 'auth.json');
  await atomicWrite(authPath, JSON.stringify(body), 0o600);
}

// ---------------------------------------------------------------------------
// Delete account home
// ---------------------------------------------------------------------------

export async function deleteOpencodeAccountHome(
  account: OpencodeSubscriptionAccount,
  stateHome?: string,
): Promise<void> {
  const accountsRoot = join(
    getSubscriptionsDir(stateHome),
    'opencode-accounts',
  );
  const resolved = join(account.homeDir);
  const resolvedRoot = join(accountsRoot);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to delete path outside accounts root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
