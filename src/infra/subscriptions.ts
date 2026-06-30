import { join, sep } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout, resolveStateLayout, type AppStateLayout } from './state-layout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubscriptionAccountId = string;
export type SubscriptionProvider = 'opencode' | 'claude' | 'codex' | 'grok';
export type SubscriptionAccountKind = 'api-key' | 'oauth-sub';
export type OpencodePool = 'zen' | 'go';
export type AccountPriority = 'low' | 'medium' | 'high' | 'disabled';
export type AccountStatus = 'active' | 'expired' | 'auth-failed' | 'disabled' | 'unknown';

export interface SubscriptionAccountBase {
  readonly id: SubscriptionAccountId;
  readonly provider: SubscriptionProvider;
  readonly kind: SubscriptionAccountKind;
  readonly label: string;
  readonly homeDir: string;
  readonly priority: AccountPriority;
  readonly priorityWeight: number;
  readonly customWeight?: number;
  readonly expiresAt?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly status?: AccountStatus;
  readonly plan?: string | null;
}

export interface OpencodeSubscriptionAccount {
  readonly id: SubscriptionAccountId;
  readonly provider: 'opencode';
  readonly kind?: 'api-key';
  readonly label: string;
  readonly pool: OpencodePool;
  readonly homeDir: string;
  readonly priority: AccountPriority;
  readonly priorityWeight: number;
  readonly customWeight?: number;
  readonly expiresAt?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly status?: AccountStatus;
  readonly plan?: string | null;
}

export interface ClaudeSubscriptionAccount extends SubscriptionAccountBase {
  readonly provider: 'claude';
  readonly kind: 'oauth-sub';
}

export interface CodexSubscriptionAccount extends SubscriptionAccountBase {
  readonly provider: 'codex';
  readonly kind: 'oauth-sub';
}

export interface GrokSubscriptionAccount extends SubscriptionAccountBase {
  readonly provider: 'grok';
  readonly kind: 'oauth-sub';
}

export type SubscriptionAccount =
  | OpencodeSubscriptionAccount
  | ClaudeSubscriptionAccount
  | CodexSubscriptionAccount
  | GrokSubscriptionAccount;

export interface SubscriptionsFileV1 {
  readonly version: 1;
  readonly accounts: readonly SubscriptionAccount[];
}

// ---------------------------------------------------------------------------
// Priority mapping
// ---------------------------------------------------------------------------

export function priorityWeight(
  priority: AccountPriority,
  customWeight?: number,
): number {
  if (customWeight !== undefined) return customWeight;
  if (priority === 'low') return 25;
  if (priority === 'medium') return 100;
  if (priority === 'high') return 200;
  return 0;
}

// ---------------------------------------------------------------------------
// Layout resolution (homeDir compat bridge)
// ---------------------------------------------------------------------------

function resolveLayout(stateHome?: string, layout?: AppStateLayout): AppStateLayout {
  if (layout) return layout;
  if (stateHome !== undefined) {
    return resolveStateLayout({
      env: {},
      platform: 'linux',
      cwd: stateHome,
      homeDir: stateHome,
    });
  }
  return defaultStateLayout();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getSubscriptionsDir(stateHome?: string, layout?: AppStateLayout): string {
  return resolveLayout(stateHome, layout).stateRoot;
}

export function getSubscriptionsPath(stateHome?: string, layout?: AppStateLayout): string {
  return resolveLayout(stateHome, layout).paths.subscriptionsFile;
}

export function getOpencodeAccountHome(accountId: string, stateHome?: string, layout?: AppStateLayout): string {
  const l = resolveLayout(stateHome, layout);
  return join(l.stateRoot, 'opencode-accounts', accountId);
}

export function getOpencodeAccountAuthPath(account: OpencodeSubscriptionAccount): string {
  return join(account.homeDir, 'opencode', 'auth.json');
}

export function subscriptionAccountKind(account: SubscriptionAccount): SubscriptionAccountKind {
  if (account.provider === 'opencode') return account.kind ?? 'api-key';
  return account.kind;
}

export function getProviderAccountHome(
  provider: SubscriptionProvider,
  accountId: string,
  stateHome?: string,
  layout?: AppStateLayout,
): string {
  const l = resolveLayout(stateHome, layout);
  return join(l.paths.providerHomesDir, provider, accountId);
}

export function getClaudeAccountHome(accountId: string, stateHome?: string, layout?: AppStateLayout): string {
  return getProviderAccountHome('claude', accountId, stateHome, layout);
}

export function getCodexAccountHome(accountId: string, stateHome?: string, layout?: AppStateLayout): string {
  return getProviderAccountHome('codex', accountId, stateHome, layout);
}

export function getGrokAccountHome(accountId: string, stateHome?: string, layout?: AppStateLayout): string {
  return getProviderAccountHome('grok', accountId, stateHome, layout);
}

export function accountEnvFor(account: SubscriptionAccount): Readonly<Partial<NodeJS.ProcessEnv>> {
  if (account.provider === 'claude') return { CLAUDE_CONFIG_DIR: account.homeDir };
  if (account.provider === 'codex') return { CODEX_HOME: account.homeDir };
  if (account.provider === 'grok') return { GROK_HOME: account.homeDir };
  return { XDG_DATA_HOME: account.homeDir };
}

// ---------------------------------------------------------------------------
// Read / Write / Update
// ---------------------------------------------------------------------------

export async function readSubscriptions(stateHome?: string, layout?: AppStateLayout): Promise<SubscriptionsFileV1> {
  const empty: SubscriptionsFileV1 = { version: 1, accounts: [] };
  try {
    const raw = await readFile(getSubscriptionsPath(stateHome, layout), 'utf8');
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
  layout?: AppStateLayout,
): Promise<void> {
  const dir = getSubscriptionsDir(stateHome, layout);
  await mkdir(dir, { recursive: true });
  await atomicWrite(
    getSubscriptionsPath(stateHome, layout),
    JSON.stringify(file, null, 2),
    0o600,
  );
}

export async function updateSubscriptions(
  updater: (file: SubscriptionsFileV1) => SubscriptionsFileV1,
  stateHome?: string,
  layout?: AppStateLayout,
): Promise<SubscriptionsFileV1> {
  const current = await readSubscriptions(stateHome, layout);
  const next = updater(current);
  await writeSubscriptions(next, stateHome, layout);
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
  customWeight?: number;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
  layout?: AppStateLayout;
}): OpencodeSubscriptionAccount {
  const resolvedPriority =
    input.customWeight === 0
      ? 'disabled'
      : input.priority ?? 'medium';
  const resolvedWeight = priorityWeight(resolvedPriority, input.customWeight);
  const homeDir = getOpencodeAccountHome(input.id, input.stateHome, input.layout);
  return {
    id: input.id,
    provider: 'opencode',
    label: input.label,
    pool: input.pool,
    homeDir,
    priority: resolvedPriority,
    priorityWeight: resolvedWeight,
    ...(input.customWeight !== undefined ? { customWeight: input.customWeight } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    enabled: resolvedWeight > 0 && resolvedPriority !== 'disabled',
    createdAt: input.nowIso,
  };
}

export function newClaudeAccount(input: {
  id: string;
  label: string;
  priority?: AccountPriority;
  customWeight?: number;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
  layout?: AppStateLayout;
}): ClaudeSubscriptionAccount {
  const resolvedPriority =
    input.customWeight === 0
      ? 'disabled'
      : input.priority ?? 'medium';
  const resolvedWeight = priorityWeight(resolvedPriority, input.customWeight);
  return {
    id: input.id,
    provider: 'claude',
    kind: 'oauth-sub',
    label: input.label,
    homeDir: getClaudeAccountHome(input.id, input.stateHome, input.layout),
    priority: resolvedPriority,
    priorityWeight: resolvedWeight,
    ...(input.customWeight !== undefined ? { customWeight: input.customWeight } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    enabled: resolvedWeight > 0 && resolvedPriority !== 'disabled',
    createdAt: input.nowIso,
    status: 'unknown',
  };
}

export function newCodexAccount(input: {
  id: string;
  label: string;
  priority?: AccountPriority;
  customWeight?: number;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
  layout?: AppStateLayout;
}): CodexSubscriptionAccount {
  const resolvedPriority =
    input.customWeight === 0
      ? 'disabled'
      : input.priority ?? 'medium';
  const resolvedWeight = priorityWeight(resolvedPriority, input.customWeight);
  return {
    id: input.id,
    provider: 'codex',
    kind: 'oauth-sub',
    label: input.label,
    homeDir: getCodexAccountHome(input.id, input.stateHome, input.layout),
    priority: resolvedPriority,
    priorityWeight: resolvedWeight,
    ...(input.customWeight !== undefined ? { customWeight: input.customWeight } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    enabled: resolvedWeight > 0 && resolvedPriority !== 'disabled',
    createdAt: input.nowIso,
    status: 'unknown',
  };
}

export function newGrokAccount(input: {
  id: string;
  label: string;
  priority?: AccountPriority;
  customWeight?: number;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
  layout?: AppStateLayout;
}): GrokSubscriptionAccount {
  const resolvedPriority =
    input.customWeight === 0
      ? 'disabled'
      : input.priority ?? 'medium';
  const resolvedWeight = priorityWeight(resolvedPriority, input.customWeight);
  return {
    id: input.id,
    provider: 'grok',
    kind: 'oauth-sub',
    label: input.label,
    homeDir: getGrokAccountHome(input.id, input.stateHome, input.layout),
    priority: resolvedPriority,
    priorityWeight: resolvedWeight,
    ...(input.customWeight !== undefined ? { customWeight: input.customWeight } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    enabled: resolvedWeight > 0 && resolvedPriority !== 'disabled',
    createdAt: input.nowIso,
    status: 'unknown',
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
  layout?: AppStateLayout,
): Promise<void> {
  const accountsRoot = join(
    getSubscriptionsDir(stateHome, layout),
    'opencode-accounts',
  );
  const resolved = join(account.homeDir);
  const resolvedRoot = join(accountsRoot);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to delete path outside accounts root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function deleteAccountHome(
  account: SubscriptionAccount,
  stateHome?: string,
  layout?: AppStateLayout,
): Promise<void> {
  const l = resolveLayout(stateHome, layout);
  const accountsRoot = join(
    l.paths.providerHomesDir,
    account.provider,
  );
  const resolved = join(account.homeDir);
  const resolvedRoot = join(accountsRoot);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing to delete path outside accounts root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}
