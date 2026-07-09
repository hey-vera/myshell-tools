import type { OutputSink } from './render.js';
import type { Confirm } from './menu-key-confirm.js';
import { readMenuKey, NAV_ESC, NAV_LEFT, getMenuStack } from './menu-key-confirm.js';
import { bold, dim, yellow, green } from '../ui/theme.js';
import { navFooterText } from './ui/nav-footer.js';
import type { Clock } from '../core/types.js';
import type { LoginRunner } from '../commands/login.js';
import {
  type ClaudeSubscriptionAccount,
  type SubscriptionAccount,
  type AccountPriority,
  readSubscriptions,
  updateSubscriptions,
  newClaudeAccount,
  deleteAccountHome,
  priorityWeight,
  subscriptionAccountKind,
} from '../infra/subscriptions.js';
import { detectSubscriptionAccount } from '../infra/subscription-detect.js';
import {
  PRIORITY_WEIGHT_DETAIL_NOTE,
  PRIORITY_WEIGHT_EDIT_HELP,
  PRIORITY_WEIGHT_LIST_HINT,
} from './accounts-priority-help.js';
import { mkdir } from 'node:fs/promises';

function isClaudeAccount(a: SubscriptionAccount): a is ClaudeSubscriptionAccount {
  return a.provider === 'claude' && subscriptionAccountKind(a) === 'oauth-sub';
}

function formatAccountRow(acc: SubscriptionAccount, index: number): string {
  const num = index.toString().padStart(2);
  const label = acc.label.padEnd(21);
  const weight = `(${acc.priorityWeight})`;
  const priority = `${acc.priority} ${weight}`.padEnd(17);
  const expiry = acc.expiresAt ? acc.expiresAt.slice(0, 10).padEnd(12) : '-'.padEnd(12);
  const status = acc.enabled === false ? 'disabled'
    : acc.status === 'expired' ? 'expired'
    : acc.status === 'auth-failed' ? 'auth-failed'
    : acc.status === 'active' ? 'active'
    : 'unknown';
  return `  ${num}  ${label}  ${priority}  ${expiry}  ${status}`;
}

async function createClaudeAccountFlow(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  clock: Clock,
  login: LoginRunner,
  suspendStdin?: (() => () => void) | undefined,
  inkReadKey?: (() => Promise<string>) | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const file = await readSubscriptions();
  const existingClaudeOauth = file.accounts.filter(isClaudeAccount);

  // macOS guard: block a 2nd claude oauth account on darwin
  if (platform === 'darwin' && existingClaudeOauth.length >= 1) {
    out.write(
      yellow(
        'Claude Code OAuth accounts cannot be isolated on macOS because Claude ' +
        'stores OAuth tokens in a shared Keychain service. Keep the existing ' +
        'Claude account or delete it before creating another.',
        out.color,
      ) + '\n',
    );
    return;
  }

  const rawId = clock.uuid();
  const safeId = 'acct_' + rawId.replace(/[^a-zA-Z0-9_-]/g, '');

  const defaultLabel = `Claude ${existingClaudeOauth.length + 1}`;
  const account = newClaudeAccount({
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

  // Run Claude OAuth login with account-scoped env
  out.write(bold('\nStarting Claude sign-in for this account...\n', out.color));
  await login(out, 'claude', {
    readLine,
    confirm,
    ...(suspendStdin !== undefined ? { suspendStdin } : {}),
    accountEnv: { CLAUDE_CONFIG_DIR: account.homeDir },
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
        'Claude sign-in did not authenticate with this account. ' +
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
  const finalAccount: ClaudeSubscriptionAccount = {
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
  login: LoginRunner,
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
  login: LoginRunner,
  suspendStdin?: (() => () => void) | undefined,
  inkReadKey?: (() => Promise<string>) | undefined,
): Promise<void> {
  getMenuStack().push();
  for (;;) {
    const expiryDisplay = account.expiresAt ? account.expiresAt.slice(0, 10) : '-';
    const planDisplay = account.plan ?? '-';
    const statusDisplay = account.enabled === false ? 'disabled'
      : account.status ?? 'unknown';
    out.beginFrame?.();
    out.write(`\n${bold('Edit Claude Account: ' + account.label, out.color)}\n\n`);
    out.write(`  provider: claude\n`);
    out.write(`  id: ${account.id}\n`);
    out.write(`  status: ${statusDisplay}\n`);
    out.write(`  priority: ${account.priority} (weight=${account.priorityWeight})\n`);
    out.write(`  ${dim(PRIORITY_WEIGHT_DETAIL_NOTE, out.color)}\n`);
    out.write(`  expiry: ${expiryDisplay}\n`);
    out.write(`  enabled: ${account.enabled ? 'yes' : 'no'}\n`);
    out.write(`  plan: ${planDisplay}\n\n`);
    out.write('  [p] priority\n');
    out.write('  [x] set/clear expiry\n');
    out.write('  [t] toggle enabled\n');
    out.write('  [r] re-auth\n');
    out.write('  [d] delete\n');
    out.write(`  [b] back  (${navFooterText('back-and-exit', out.color)})\n\n`);
    out.write('> ');
    out.endFrame?.();
    const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

    if (key === null || key === 'b') { getMenuStack().pop(); return; }
    if (key === NAV_ESC) { getMenuStack().requestExit(); return; }
    if (key === NAV_LEFT) { getMenuStack().pop(); return; }

    if (key === 'p') {
      const sel = await prioritySelectScreen(out, readLine, inkReadKey);
      if (sel !== null) {
        if (sel === 'custom') {
          const weight = await customWeightPrompt(out, readLine);
          if (weight !== null) {
            const updateObj: Record<string, unknown> = {
              customWeight: weight,
              priorityWeight: weight,
            };
            if (weight === 0) {
              updateObj.enabled = false;
              updateObj.priority = 'disabled';
            } else if (account.priority === 'disabled') {
              updateObj.priority = 'medium';
              updateObj.enabled = true;
            }
            await applyAccountUpdate(account.id, updateObj);
            const updated = await findAccount(account.id);
            if (updated) account = updated;
          }
        } else {
          const newPriority = sel;
          const updateObj: Record<string, unknown> = {
            priority: newPriority,
            priorityWeight: priorityWeight(newPriority),
            customWeight: undefined,
          };
          if (newPriority === 'disabled') {
            updateObj.enabled = false;
          }
          await applyAccountUpdate(account.id, updateObj);
          const updated = await findAccount(account.id);
          if (updated) account = updated;
        }
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
        updateObj.customWeight = undefined;
      }
      await applyAccountUpdate(account.id, updateObj);
      const updated = await findAccount(account.id);
      if (updated) account = updated;
    } else if (key === 'r') {
      out.write(bold('\nRe-authenticating Claude account...\n', out.color));
      await login(out, 'claude', {
        readLine,
        confirm,
        ...(suspendStdin !== undefined ? { suspendStdin } : {}),
        accountEnv: { CLAUDE_CONFIG_DIR: account.homeDir },
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
          await updateSubscriptions((file) => ({
            ...file,
            accounts: file.accounts.filter((a) => a.id !== account.id),
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
): Promise<AccountPriority | 'custom' | null> {
  out.beginFrame?.();
  out.write('\nPriority:\n\n');
  for (const line of PRIORITY_WEIGHT_EDIT_HELP.split('\n')) {
    out.write(`  ${dim(line, out.color)}\n`);
  }
  out.write('\n');
  out.write('  [l] low (25)\n');
  out.write('  [m] medium (100)\n');
  out.write('  [h] high (200)\n');
  out.write('  [c] custom number\n');
  out.write('  [d] disabled\n');
  out.write('  [b] back\n\n');
  out.write('> ');
  out.endFrame?.();
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); return null; }
  if (key === 'l') return 'low';
  if (key === 'm') return 'medium';
  if (key === 'h') return 'high';
  if (key === 'c') return 'custom';
  if (key === 'd') return 'disabled';
  return null;
}

async function customWeightPrompt(
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<number | null> {
  out.beginFrame?.();
  out.write('\nCustom weight (0..1000, 0=disabled): ');
  out.endFrame?.();
  out.flush?.();
  const raw = await readLine();
  if (raw === null || raw.trim().length === 0) return null;
  const num = parseInt(raw.trim(), 10);
  if (isNaN(num) || num < 0 || num > 1000) {
    out.write(yellow('Invalid weight (0..1000). Unchanged.', out.color) + '\n');
    return null;
  }
  return num;
}

async function expirySelectScreen(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  currentExpiry: string | undefined,
  inkReadKey?: () => Promise<string>,
): Promise<string | undefined> {
  const currentDisplay = currentExpiry ? currentExpiry.slice(0, 10) : 'none';
  out.beginFrame?.();
  out.write(`\nExpiry: currently ${currentDisplay}\n\n`);
  out.write('  [s] set\n');
  out.write('  [c] clear\n');
  out.write('  [b] back\n\n');
  out.write('> ');
  out.endFrame?.();
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  if (key === NAV_ESC) { getMenuStack().requestExit(); return currentExpiry; }
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

export async function runClaudeAccountsMenu(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  clock: Clock,
  deps: {
    login: LoginRunner;
    suspendStdin?: (() => () => void) | undefined;
    inkReadKey?: (() => Promise<string>) | undefined;
    cwd?: string | undefined;
  },
): Promise<void> {
  const { login, suspendStdin, inkReadKey } = deps;
  getMenuStack().push();
  for (;;) {
    let allAccounts: readonly SubscriptionAccount[];
    try {
      const file = await readSubscriptions();
      allAccounts = file.accounts;
    } catch {
      allAccounts = [];
    }
    const accounts = allAccounts.filter(isClaudeAccount);

    out.beginFrame?.();
    out.write('\n' + bold('Claude Accounts', out.color) + '\n');

    if (accounts.length === 0) {
      out.write('\n  (no accounts)\n');
    } else {
      out.write('\n');
      out.write('  #  label                 priority          expiry       status\n');
      let index = 1;
      for (const acc of accounts) {
        out.write(formatAccountRow(acc, index) + '\n');
        index++;
      }
      out.write(`\n  ${dim(PRIORITY_WEIGHT_LIST_HINT, out.color)}\n`);
    }

    out.write('\n');
    out.write('  [c] create\n');
    if (accounts.length > 0) {
      out.write('  [e] edit\n');
    }
    out.write(`  [b] back  (${navFooterText('back-and-exit', out.color)})\n\n`);
    out.write('> ');
    out.endFrame?.();
    const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

    if (key === null || key === 'b') { getMenuStack().pop(); return; }
    if (key === NAV_ESC) { getMenuStack().requestExit(); return; }
    if (key === NAV_LEFT) { getMenuStack().pop(); return; }

    if (key === 'c') {
      await createClaudeAccountFlow(
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
