import type { OutputSink } from './render.js';
import type { Confirm } from './menu-key-confirm.js';
import { readMenuKey } from './menu-key-confirm.js';
import { bold, yellow, green } from '../ui/theme.js';
import type { Clock } from '../core/types.js';
import type { LoginMethod } from '../commands/login.js';
import type { CommandGatePort } from '../core/command-gate.js';
import {
  type CodexSubscriptionAccount,
  type SubscriptionAccount,
  type AccountPriority,
  readSubscriptions,
  updateSubscriptions,
  newCodexAccount,
  deleteAccountHome,
  priorityWeight,
  subscriptionAccountKind,
} from '../infra/subscriptions.js';
import { detectSubscriptionAccount } from '../infra/subscription-detect.js';
import { mkdir } from 'node:fs/promises';

type LoginFn = (
  out: OutputSink,
  providerArg?: string,
  opts?: {
    method?: LoginMethod;
    readLine?: () => Promise<string | null>;
    suspendStdin?: () => () => void;
    confirm?: (defaultYes: boolean, opts?: { requireExplicit?: boolean }) => Promise<boolean>;
    commandGate?: CommandGatePort;
    accountEnv?: Readonly<Partial<NodeJS.ProcessEnv>>;
  },
) => Promise<number>;

function isCodexAccount(a: SubscriptionAccount): a is CodexSubscriptionAccount {
  return a.provider === 'codex' && subscriptionAccountKind(a) === 'oauth-sub';
}

function formatAccountRow(acc: SubscriptionAccount, index: number): string {
  const num = index.toString().padStart(2);
  const label = acc.label.padEnd(21);
  const priority = acc.priority.padEnd(8);
  const expiry = acc.expiresAt ? acc.expiresAt.slice(0, 10).padEnd(12) : '-'.padEnd(12);
  const status = acc.enabled === false ? 'disabled'
    : acc.status === 'expired' ? 'expired'
    : acc.status === 'auth-failed' ? 'auth-failed'
    : acc.status === 'active' ? 'active'
    : 'unknown';
  return `  ${num}  ${label}  ${priority}  ${expiry}  ${status}`;
}

async function createCodexAccountFlow(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  clock: Clock,
  login: LoginFn,
  suspendStdin?: (() => () => void) | undefined,
  inkReadKey?: (() => Promise<string>) | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const file = await readSubscriptions();
  const existingCodexOauth = file.accounts.filter(isCodexAccount);

  // macOS guard: block a 2nd codex oauth account on darwin
  if (platform === 'darwin' && existingCodexOauth.length >= 1) {
    out.write(
      yellow(
        'Codex OAuth accounts cannot be isolated on macOS because Codex ' +
        'stores OAuth tokens in a shared Keychain service. Keep the existing ' +
        'Codex account or delete it before creating another.',
        out.color,
      ) + '\n',
    );
    return;
  }

  const rawId = clock.uuid();
  const safeId = 'acct_' + rawId.replace(/[^a-zA-Z0-9_-]/g, '');

  const defaultLabel = `Codex ${existingCodexOauth.length + 1}`;
  const account = newCodexAccount({
    id: safeId,
    label: defaultLabel,
    nowIso: clock.isoNow(),
  });

  try {
    await mkdir(account.homeDir, { recursive: true, mode: 0o700 });
  } catch {
    out.write(yellow('Failed to create account directory.', out.color) + '\n');
    return;
  }

  // Run Codex OAuth login with account-scoped env
  out.write(bold('\nStarting Codex sign-in for this account...\n', out.color));
  await login(out, 'codex', {
    readLine,
    confirm,
    ...(suspendStdin !== undefined ? { suspendStdin } : {}),
    accountEnv: { CODEX_HOME: account.homeDir },
  });

  // Verify success by detecting with the scoped home
  const detection = await detectSubscriptionAccount({
    account,
    cwd: process.cwd(),
    nowMs: clock.now(),
  });

  if (detection.status !== 'active') {
    out.write(
      yellow(
        'Codex sign-in did not authenticate with this account. ' +
        'Auth may have failed or been cancelled.',
        out.color,
      ) + '\n',
    );
    // Clean up the scoped home
    try {
      await deleteAccountHome(account);
    } catch {
      // best-effort
    }
    return;
  }

  // Prompt optional label
  out.write(`Label (Enter for default "${defaultLabel}"): `);
  out.flush?.();
  let label = (await readLine())?.trim() ?? '';
  if (label.length === 0) {
    label = defaultLabel;
  }

  // Prompt optional expiry
  out.write('\nExpiry date (YYYY-MM-DD, or Enter to skip): ');
  out.flush?.();
  const expiryRaw = await readLine();
  let expiresAt: string | undefined;
  if (expiryRaw !== null && expiryRaw.trim().length > 0) {
    const trimmed = expiryRaw.trim();
    const parsed = new Date(trimmed + 'T00:00:00.000Z');
    if (isNaN(parsed.getTime())) {
      out.write(yellow('Invalid date format. Skipping expiry.', out.color) + '\n');
    } else {
      expiresAt = parsed.toISOString();
    }
  }

  // Build final account record
  const finalAccount: CodexSubscriptionAccount = {
    ...account,
    label,
    status: 'active',
    plan: detection.plan,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(detection.expiresAt !== undefined ? { expiresAt: detection.expiresAt } : {}),
  };

  try {
    await updateSubscriptions((f) => ({
      ...f,
      accounts: [...f.accounts, finalAccount],
    }));
    out.write(green(`Account "${label}" created.\n`, out.color));
  } catch {
    try {
      await deleteAccountHome(account);
    } catch {
      // best-effort
    }
    out.write(yellow('Failed to save account record.', out.color) + '\n');
  }
}

async function editAccountFlow(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  accounts: readonly SubscriptionAccount[],
  login: LoginFn,
  suspendStdin?: (() => () => void) | undefined,
  inkReadKey?: (() => Promise<string>) | undefined,
): Promise<void> {
  let selected: SubscriptionAccount | undefined;
  if (accounts.length === 1) {
    const first = accounts[0];
    if (first === undefined) return;
    selected = first;
  } else {
    out.write('\nSelect account number: ');
    out.flush?.();
    const line = await readLine();
    const num = parseInt(line ?? '', 10);
    if (isNaN(num) || num < 1 || num > accounts.length) {
      out.write(yellow('Invalid selection.', out.color) + '\n');
      return;
    }
    const picked = accounts[num - 1];
    if (picked === undefined) return;
    selected = picked;
  }

  await editAccountScreen(out, readLine, confirm, selected, login, suspendStdin, inkReadKey);
}

async function editAccountScreen(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  account: SubscriptionAccount,
  login: LoginFn,
  suspendStdin?: (() => () => void) | undefined,
  inkReadKey?: (() => Promise<string>) | undefined,
): Promise<void> {
  for (;;) {
    const expiryDisplay = account.expiresAt ? account.expiresAt.slice(0, 10) : '-';
    const planDisplay = account.plan ?? '-';
    const statusDisplay = account.enabled === false ? 'disabled'
      : account.status ?? 'unknown';
    out.write(`\n${bold('Edit Codex Account: ' + account.label, out.color)}\n\n`);
    out.write(`  provider: codex\n`);
    out.write(`  id: ${account.id}\n`);
    out.write(`  status: ${statusDisplay}\n`);
    out.write(`  priority: ${account.priority}\n`);
    out.write(`  expiry: ${expiryDisplay}\n`);
    out.write(`  enabled: ${account.enabled ? 'yes' : 'no'}\n`);
    out.write(`  plan: ${planDisplay}\n\n`);
    out.write('  [p] priority\n');
    out.write('  [x] set/clear expiry\n');
    out.write('  [t] toggle enabled\n');
    out.write('  [r] re-auth\n');
    out.write('  [d] delete\n');
    out.write('  [b] back\n\n');
    out.write('> ');
    const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

    if (key === null || key === 'b') return;

    if (key === 'p') {
      const newPriority = await prioritySelectScreen(out, readLine, inkReadKey);
      if (newPriority !== null) {
        const updateObj: Record<string, unknown> = {
          priority: newPriority,
          priorityWeight: priorityWeight(newPriority),
        };
        if (newPriority === 'disabled') {
          updateObj.enabled = false;
        }
        await applyAccountUpdate(account.id, updateObj);
        const updated = await findAccount(account.id);
        if (updated) account = updated;
      }
    } else if (key === 'x') {
      const newExpiry = await expirySelectScreen(out, readLine, account.expiresAt, inkReadKey);
      if (newExpiry !== undefined) {
        await applyAccountUpdate(account.id, { expiresAt: newExpiry } as Record<string, unknown>);
        const updated = await findAccount(account.id);
        if (updated) account = updated;
      }
    } else if (key === 't') {
      const newEnabled = !account.enabled;
      const updateObj: Record<string, unknown> = {
        enabled: newEnabled,
      };
      if (newEnabled && account.priority === 'disabled') {
        updateObj.priority = 'medium';
        updateObj.priorityWeight = priorityWeight('medium');
      }
      await applyAccountUpdate(account.id, updateObj);
      const updated = await findAccount(account.id);
      if (updated) account = updated;
    } else if (key === 'r') {
      out.write(bold('\nRe-authenticating Codex account...\n', out.color));
      await login(out, 'codex', {
        readLine,
        confirm,
        ...(suspendStdin !== undefined ? { suspendStdin } : {}),
        accountEnv: { CODEX_HOME: account.homeDir },
      });

      const detection = await detectSubscriptionAccount({
        account,
        cwd: process.cwd(),
        nowMs: Date.now(),
      });

      const updateObj: Record<string, unknown> = {
        status: detection.status,
        plan: detection.plan,
        lastUsedAt: new Date().toISOString(),
      };
      if (detection.expiresAt !== undefined) {
        updateObj.expiresAt = detection.expiresAt;
      }
      await applyAccountUpdate(account.id, updateObj);
      const updated = await findAccount(account.id);
      if (updated) account = updated;
      out.write(
        detection.status === 'active'
          ? green('Re-auth successful.\n', out.color)
          : yellow('Re-auth did not authenticate.\n', out.color) + '\n',
      );
    } else if (key === 'd') {
      out.write(`\n${yellow('Delete account "' + account.label + '"?', out.color)} `);
      const yes = await confirm(false, { requireExplicit: true });
      if (yes) {
        try {
          await updateSubscriptions((subFile) => ({
            ...subFile,
            accounts: subFile.accounts.filter((a) => a.id !== account.id),
          }));
        } catch {
          out.write(yellow('Failed to remove account record.', out.color) + '\n');
          return;
        }
        try {
          await deleteAccountHome(account);
        } catch {
          // best-effort
        }
        out.write('Account deleted.\n');
        return;
      }
    }
  }
}

async function prioritySelectScreen(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey?: () => Promise<string>,
): Promise<AccountPriority | null> {
  out.write('\nPriority:\n\n');
  out.write('  [l] low\n');
  out.write('  [m] medium\n');
  out.write('  [h] high\n');
  out.write('  [d] disabled\n');
  out.write('  [b] back\n\n');
  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === 'l') return 'low';
  if (key === 'm') return 'medium';
  if (key === 'h') return 'high';
  if (key === 'd') return 'disabled';
  return null;
}

async function expirySelectScreen(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  currentExpiry: string | undefined,
  inkReadKey?: () => Promise<string>,
): Promise<string | undefined> {
  const currentDisplay = currentExpiry ? currentExpiry.slice(0, 10) : 'none';
  out.write(`\nExpiry: currently ${currentDisplay}\n\n`);
  out.write('  [s] set\n');
  out.write('  [c] clear\n');
  out.write('  [b] back\n\n');
  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  if (key === 'c') return undefined;
  if (key === 's') {
    out.write('\nExpiry date (YYYY-MM-DD): ');
    out.flush?.();
    const raw = await readLine();
    if (raw === null || raw.trim().length === 0) return currentExpiry;
    const trimmed = raw.trim();
    const parsed = new Date(trimmed + 'T00:00:00.000Z');
    if (isNaN(parsed.getTime())) {
      out.write(yellow('Invalid date format. Unchanged.', out.color) + '\n');
      return currentExpiry;
    }
    return parsed.toISOString();
  }
  return currentExpiry;
}

async function applyAccountUpdate(
  accountId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  try {
    await updateSubscriptions((file) => ({
      ...file,
      accounts: file.accounts.map((a) =>
        a.id === accountId ? { ...a, ...updates } : a,
      ),
    }));
  } catch {
    // fail-soft
  }
}

async function findAccount(
  accountId: string,
): Promise<SubscriptionAccount | undefined> {
  try {
    const file = await readSubscriptions();
    return file.accounts.find((a) => a.id === accountId);
  } catch {
    return undefined;
  }
}

export async function runCodexAccountsMenu(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  clock: Clock,
  deps: {
    login: LoginFn;
    suspendStdin?: (() => () => void) | undefined;
    inkReadKey?: (() => Promise<string>) | undefined;
    cwd?: string | undefined;
  },
): Promise<void> {
  const { login, suspendStdin, inkReadKey } = deps;
  for (;;) {
    let allAccounts: readonly SubscriptionAccount[];
    try {
      const file = await readSubscriptions();
      allAccounts = file.accounts;
    } catch {
      allAccounts = [];
    }
    const accounts = allAccounts.filter(isCodexAccount);

    out.write('\n' + bold('Codex Accounts', out.color) + '\n');

    if (accounts.length === 0) {
      out.write('\n  (no accounts)\n');
    } else {
      out.write('\n');
      out.write('  #  label                 priority  expiry       status\n');
      let index = 1;
      for (const acc of accounts) {
        out.write(formatAccountRow(acc, index) + '\n');
        index++;
      }
    }

    out.write('\n');
    out.write('  [c] create\n');
    if (accounts.length > 0) {
      out.write('  [e] edit\n');
    }
    out.write('  [b] back\n\n');
    out.write('> ');
    const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

    if (key === null || key === 'b') return;

    if (key === 'c') {
      await createCodexAccountFlow(
        out,
        readLine,
        confirm,
        clock,
        login,
        suspendStdin,
        inkReadKey,
      );
    } else if (key === 'e' && accounts.length > 0) {
      await editAccountFlow(
        out,
        readLine,
        confirm,
        accounts,
        login,
        suspendStdin,
        inkReadKey,
      );
    }
  }
}
