import type { OutputSink } from './render.js';
import type { Confirm } from './menu-key-confirm.js';
import {
  readMenuKey,
  NAV_ESC,
  NAV_LEFT,
  getMenuStack,
  interpretListKey,
  moveListHighlight,
} from './menu-key-confirm.js';
import { readSecretLine } from './menu-secret-input.js';
import { dim, bold, yellow } from '../ui/theme.js';
import { navFooterText } from './ui/nav-footer.js';
import {
  ACCOUNTS_LIST_FIRST_DATA_ROW,
  isMouseInput,
  listIndexFromMouseKey,
} from './ui/mouse.js';
import type { ReadlineEchoController } from './menu-readline.js';
import type { Clock } from '../core/types.js';
import {
  type OpencodeSubscriptionAccount,
  type AccountPriority,
  type OpencodePool,
  readSubscriptions,
  updateSubscriptions,
  newOpencodeAccount,
  writeOpencodeAuthJson,
  deleteOpencodeAccountHome,
  priorityWeight,
  type SubscriptionAccount,
} from '../infra/subscriptions.js';
import {
  PRIORITY_WEIGHT_DETAIL_NOTE,
  PRIORITY_WEIGHT_EDIT_HELP,
  PRIORITY_WEIGHT_LIST_HINT,
} from './accounts-priority-help.js';

function isOpencodeAccount(a: SubscriptionAccount): a is OpencodeSubscriptionAccount {
  return a.provider === 'opencode';
}

function formatAccountRow(
  acc: OpencodeSubscriptionAccount,
  index: number,
  selected: boolean,
  color: boolean,
): string {
  const marker = selected ? '\u25B8' : ' ';
  const num = index.toString().padStart(2);
  const label = acc.label.padEnd(21);
  const pool = acc.pool.padEnd(4);
  const weight = `(${acc.priorityWeight})`;
  const priority = `${acc.priority} ${weight}`.padEnd(17);
  const expiry = acc.expiresAt ? acc.expiresAt.slice(0, 10).padEnd(12) : '-'.padEnd(12);
  const status = acc.enabled ? 'active' : 'disabled';
  const row = ` ${marker}${num}  ${label}  ${pool}  ${priority}  ${expiry}  ${status}`;
  return selected ? bold(row, color) : row;
}

function formatPoolLabel(pool: OpencodePool): string {
  return pool === 'go' ? 'Go' : 'Zen';
}

async function selectPoolScreen(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey?: () => Promise<string>,
): Promise<OpencodePool | null> {
  out.beginFrame?.();
  out.write('\nChoose pool:\n\n');
  out.write('  [z] Zen\n');
  out.write('  [g] Go\n');
  out.write('  [b] back\n\n');
  out.write('> ');
  out.endFrame?.();
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); return null; }
  if (key === 'z') return 'zen';
  if (key === 'g') return 'go';
  return null;
}

async function createAccountFlow(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  readlineEcho: ReadlineEchoController,
  clock: Clock,
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  // Step 1: Read API key (hidden)
  const setEchoMuted = (muted: boolean): void => { readlineEcho.muted = muted; };
  const apiKey = await readSecretLine({
    out,
    readLine,
    setEchoMuted,
    prompt: 'Paste OpenCode API key: ',
  });

  if (apiKey === null || apiKey.length === 0) {
    out.write(dim('Cancelled.', out.color) + '\n');
    return;
  }

  // Step 2: Choose pool
  const pool = await selectPoolScreen(out, readLine, inkReadKey);
  if (pool === null) return;

  // Step 3: Optional expiry
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

  // Step 4: Optional label
  const poolLabel = formatPoolLabel(pool);
  out.write(`Label (Enter for default "OpenCode ${poolLabel}"): `);
  out.flush?.();
  let label = (await readLine())?.trim() ?? '';
  if (label.length === 0) {
    let subsFile: { version: 1; accounts: readonly SubscriptionAccount[] };
    try {
      subsFile = await readSubscriptions();
    } catch {
      subsFile = { version: 1, accounts: [] };
    }
    const samePool = subsFile.accounts.filter((a) => isOpencodeAccount(a) && a.pool === pool).length;
    label = `OpenCode ${poolLabel} ${samePool + 1}`;
  }

  // Step 5: Create account ID
  const rawId = clock.uuid();
  const safeId = 'acct_' + rawId.replace(/[^a-zA-Z0-9_-]/g, '');

  // Step 6: Build + write auth + append record
  const account = newOpencodeAccount({
    id: safeId,
    label,
    pool,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    nowIso: clock.isoNow(),
  });

  try {
    await writeOpencodeAuthJson({ account, apiKey });
  } catch {
    out.write(yellow('Failed to write auth.json.', out.color) + '\n');
    return;
  }

  try {
    await updateSubscriptions((file) => ({
      ...file,
      accounts: [...file.accounts, account],
    }));
    out.write(`Account "${label}" created.\n`);
  } catch {
    // Best-effort cleanup of the auth we already wrote
    try {
      await deleteOpencodeAccountHome(account);
    } catch {
      // ignore cleanup failures
    }
    out.write(yellow('Failed to save account record.', out.color) + '\n');
  }
}

async function editAccountFlow(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  readlineEcho: ReadlineEchoController,
  confirm: Confirm,
  accounts: readonly OpencodeSubscriptionAccount[],
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  let selected: OpencodeSubscriptionAccount | undefined;
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

  await editAccountScreen(
    out,
    readLine,
    readlineEcho,
    confirm,
    selected,
    inkReadKey,
  );
}

async function editAccountScreen(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  readlineEcho: ReadlineEchoController,
  confirm: Confirm,
  account: OpencodeSubscriptionAccount,
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  getMenuStack().push();
  for (;;) {
    const expiryDisplay = account.expiresAt ? account.expiresAt.slice(0, 10) : '-';
    out.beginFrame?.();
    out.write(`\n${bold('Edit OpenCode Account: ' + account.label, out.color)}\n\n`);
    out.write(`  pool: ${account.pool}\n`);
    out.write(`  priority: ${account.priority} (weight=${account.priorityWeight})\n`);
    out.write(`  ${dim(PRIORITY_WEIGHT_DETAIL_NOTE, out.color)}\n`);
    out.write(`  expiry: ${expiryDisplay}\n`);
    out.write(`  enabled: ${account.enabled ? 'yes' : 'no'}\n\n`);
    out.write('  [l] label\n');
    out.write('  [p] priority\n');
    out.write('  [x] set/clear expiry\n');
    out.write('  [t] toggle enabled\n');
    out.write('  [d] delete\n');
    out.write(`  [b] back  (${navFooterText('back-and-exit', out.color)})\n\n`);
    out.write('> ');
    out.endFrame?.();
    const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

    if (key === null || key === 'b') { getMenuStack().pop(); return; }
    if (key === NAV_ESC) { getMenuStack().requestExit(); return; }
    if (key === NAV_LEFT) { getMenuStack().pop(); return; }

    if (key === 'l') {
      const newLabel = await labelPrompt(out, readLine, account.label);
      if (newLabel !== null) {
        await applyAccountUpdate(account.id, { label: newLabel });
        const updated = await findAccount(account.id);
        if (updated) account = updated;
      }
    } else if (key === 'p') {
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
          await deleteOpencodeAccountHome(account);
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

/** Prompt for a new account label. Empty/cancel keeps current (returns null). */
async function labelPrompt(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  currentLabel: string,
): Promise<string | null> {
  out.beginFrame?.();
  out.write(`\nLabel (Enter keep "${currentLabel}"): `);
  out.endFrame?.();
  out.flush?.();
  const raw = await readLine();
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Cap length so list columns stay scannable.
  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
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
): Promise<OpencodeSubscriptionAccount | undefined> {
  try {
    const file = await readSubscriptions();
    const found = file.accounts.find((a) => a.id === accountId);
    return found !== undefined && isOpencodeAccount(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

export async function runOpencodeAccountsMenu(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  readlineEcho: ReadlineEchoController,
  confirm: Confirm,
  clock: Clock,
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  getMenuStack().push();
  let selectedIndex = 0;
  for (;;) {
    let allAccounts: readonly SubscriptionAccount[];
    try {
      const file = await readSubscriptions();
      allAccounts = file.accounts;
    } catch {
      allAccounts = [];
    }
    const accounts = allAccounts.filter(isOpencodeAccount);
    selectedIndex = moveListHighlight(selectedIndex, 0, accounts.length);

    out.beginFrame?.();
    out.write('\n' + bold('OpenCode Accounts', out.color) + '\n');

    if (accounts.length === 0) {
      out.write('\n  (no accounts)\n');
      out.write(`  ${dim('Enter create  ·  ↑↓ when listed', out.color)}\n`);
    } else {
      out.write('\n');
      out.write('     #  label                 pool  priority          expiry       status\n');
      let index = 1;
      for (const acc of accounts) {
        out.write(formatAccountRow(acc, index, index - 1 === selectedIndex, out.color) + '\n');
        index++;
      }
      out.write(`\n  ${dim(PRIORITY_WEIGHT_LIST_HINT, out.color)}\n`);
      out.write(`  ${dim('↑↓ select  ·  Enter open  ·  1-9 jump', out.color)}\n`);
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

    // Optional mouse (Ink SGR): click a data row → same as Enter on that row.
    // Fail-soft on miss / wrong geometry; keyboard remains primary.
    const clickIdx = listIndexFromMouseKey(key, ACCOUNTS_LIST_FIRST_DATA_ROW, accounts.length);
    if (clickIdx !== null) {
      selectedIndex = clickIdx;
      const picked = accounts[clickIdx];
      if (picked !== undefined) {
        await editAccountScreen(out, readLine, readlineEcho, confirm, picked, inkReadKey);
      }
      continue;
    }
    if (key !== null && isMouseInput(key)) continue;

    const list = interpretListKey(key, selectedIndex, accounts.length);
    if (list.kind === 'highlight') {
      selectedIndex = list.index;
      continue;
    }
    if (list.kind === 'create-empty' || (list.kind === 'other' && list.key === 'c')) {
      await createAccountFlow(out, readLine, readlineEcho, clock, inkReadKey);
      continue;
    }
    if (list.kind === 'activate') {
      selectedIndex = list.index;
      const picked = accounts[list.index];
      if (picked !== undefined) {
        await editAccountScreen(out, readLine, readlineEcho, confirm, picked, inkReadKey);
      }
      continue;
    }
    if (list.kind === 'other' && list.key === 'e' && accounts.length > 0) {
      await editAccountFlow(out, readLine, readlineEcho, confirm, accounts, inkReadKey);
    }
  }
}
