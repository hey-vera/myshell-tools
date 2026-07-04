/**
 * src/infra/health.ts — Self-health evaluation for myshell-tools.
 *
 * The product goal is "it just works": the user should never run a diagnostic
 * command. Instead the control panel evaluates its own environment health at
 * startup and surfaces a short, actionable warning ONLY when something is
 * actually wrong. No problems → nothing shown (silence == healthy).
 *
 * This module covers the diagnostics that are NOT already visible elsewhere in
 * the UI: Node version, state-directory writability, and pricing-table
 * staleness. Provider install/auth status and Claude-token expiry are already
 * rendered in the header, so they are intentionally not duplicated here.
 *
 * `evaluateHealth` is PURE (no I/O) so it is trivially testable. The one piece
 * that needs I/O — probing whether the state directory is writable — is a
 * separate function the caller runs once at startup and feeds in.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getStateDir } from './paths.js';
import { defaultStateHome } from './state-dir.js';
import type { MigrationReport } from './state-migration.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HealthSeverity = 'warn' | 'error';

export interface HealthIssue {
  /** Stable identifier for the issue (useful for tests and de-duplication). */
  readonly id: string;
  readonly severity: HealthSeverity;
  /** One-line, human-readable message that already includes the fix. */
  readonly message: string;
}

export interface HealthInputs {
  /** process.version, e.g. "v20.20.0". */
  readonly nodeVersion: string;
  /** Whether the .myshell-tools state directory could be written to. */
  readonly stateWritable: boolean;
  /** Actual resolved state directory, when the caller wants it named in messages. */
  readonly stateDir?: string;
  /** Whether the cwd-scoped ledger directory could be written to. */
  readonly ledgerWritable?: boolean;
  /** Actual cwd-scoped ledger directory, when the caller wants it named in messages. */
  readonly ledgerDir?: string;
  /** Whether the bundled pricing seed is past its staleness window. */
  readonly pricingStale: boolean;
  /** Minimum supported Node major version (defaults to 20). */
  readonly minNodeMajor?: number;
  /** Optional migration report from a startup auto-migration run. */
  readonly migrationReport?: MigrationReport;
  /** Optional result from the .gitignore guard run at startup. */
  readonly gitignoreStatus?: { readonly ok: boolean; readonly reason?: string };
}

export interface ProbeStateWritableOpts {
  readonly stateHome?: string;
  readonly probeFileName?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse the major version from a Node version string ("v20.20.0" → 20).
 * Returns null when the string can't be parsed (so callers can skip the check
 * rather than emit a bogus warning). Pure; never throws.
 */
export function nodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  if (m === null) return null;
  const n = parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Evaluate environment health and return the issues worth surfacing.
 *
 * Pure — takes a snapshot of inputs and returns zero or more issues, most
 * severe first (errors before warnings). An empty array means "all healthy,
 * show nothing".
 */
export function evaluateHealth(inputs: HealthInputs): HealthIssue[] {
  const minMajor = inputs.minNodeMajor ?? 20;
  const issues: HealthIssue[] = [];

  // State directory not writable — the most serious: nothing persists.
  if (!inputs.stateWritable) {
    const pathText = inputs.stateDir !== undefined ? ` (${inputs.stateDir})` : '';
    issues.push({
      id: 'state-not-writable',
      severity: 'error',
      message:
        `Can't write to the .myshell-tools state directory${pathText} — ` +
        'config, credentials, and conversations will not be saved. Check the directory permissions.',
    });
  }

  if (inputs.ledgerWritable === false) {
    const pathText = inputs.ledgerDir !== undefined ? ` (${inputs.ledgerDir})` : '';
    issues.push({
      id: 'ledger-not-writable',
      severity: 'error',
      message:
        `Can't write to the .myshell-tools ledger directory${pathText} — ` +
        'cost tracking will not be saved. Check the directory permissions.',
    });
  }

  // Node below the supported floor — the compiled CLI targets Node >= minMajor.
  const major = nodeMajor(inputs.nodeVersion);
  if (major !== null && major < minMajor) {
    issues.push({
      id: 'node-too-old',
      severity: 'warn',
      message: `Node ${inputs.nodeVersion} is below the supported v${minMajor} — upgrade Node if you hit errors.`,
    });
  }

  // Stale pricing seed — cost estimates may drift; updating refreshes them.
  if (inputs.pricingStale) {
    issues.push({
      id: 'pricing-stale',
      severity: 'warn',
      message:
        'Cost estimates may be out of date — update to refresh them: npm install -g myshell-tools@latest',
    });
  }

  // Migration status — surface ONLY the unavoidable user decisions. Archive-
  // only conflicts are self-healed (the source is preserved in the migration
  // `conflicts/` dir and the live dest is untouched), so `complete-with-archive`
  // is silent (silence == healthy). Live-state conflicts and real errors still
  // surface because the user must act on them.
  if (inputs.migrationReport !== undefined) {
    const { status, manifestPath, conflicts, errors } = inputs.migrationReport;
    if (status === 'conflicts') {
      issues.push({
        id: 'migration-conflicts',
        severity: 'warn',
        message:
          `State migration had ${conflicts.length} conflict(s). ` +
          `Old files were preserved — see ${manifestPath || 'the migration manifest'} for details.`,
      });
    } else if (status === 'partial') {
      issues.push({
        id: 'migration-partial',
        severity: 'warn',
        message:
          `State migration completed with ${errors.length} error(s). ` +
          `Some files may not have been migrated — see ${manifestPath || 'the migration manifest'} for details.`,
      });
    }
    // 'complete' and 'complete-with-archive' → silent.
  }

  // Gitignore guard — surface when secrets could leak into git.
  if (inputs.gitignoreStatus !== undefined && !inputs.gitignoreStatus.ok) {
    const reasonText = inputs.gitignoreStatus.reason
      ? ` (${inputs.gitignoreStatus.reason})`
      : '';
    issues.push({
      id: 'gitignore-not-protected',
      severity: 'error',
      message:
        'The .myshell-tools state directory is inside a git worktree but could not be added ' +
        `to .gitignore — credentials may be at risk of accidental commit${reasonText}. ` +
        'Add ".myshell-tools/" to your .gitignore manually.',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// I/O probe (run once at startup; result fed into evaluateHealth)
// ---------------------------------------------------------------------------

/**
 * Probe whether the resolved .myshell-tools state directory is writable.
 *
 * Creates the directory if needed, exclusively creates a unique temp file, and
 * removes exactly that file. Returns true on success, false on any I/O error.
 * Never throws.
 */
export async function probeStateWritable(_cwd: string, opts?: ProbeStateWritableOpts): Promise<boolean> {
  const stateHome = opts?.stateHome ?? defaultStateHome();
  return probeWritableDir(defaultStateDir(stateHome), opts);
}

/** Return the actual .myshell-tools directory used for app-global state. */
export function defaultStateDir(stateHome: string = defaultStateHome()): string {
  return join(stateHome, '.myshell-tools');
}

/** Probe the cwd-scoped .myshell-tools directory used by the cost ledger. */
export async function probeLedgerWritable(cwd: string, opts?: ProbeStateWritableOpts): Promise<boolean> {
  return probeWritableDir(getStateDir(cwd), opts);
}

async function probeWritableDir(stateDir: string, opts?: ProbeStateWritableOpts): Promise<boolean> {
  const probeFileName = opts?.probeFileName ?? `.health-probe-${process.pid}-${randomUUID()}`;
  const probe = join(stateDir, probeFileName);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let createdProbe = false;
  try {
    await mkdir(stateDir, { recursive: true });
    handle = await open(probe, 'wx');
    createdProbe = true;
    await handle.writeFile('');
    await handle.close();
    handle = null;
    await access(stateDir);
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    if (createdProbe) {
      await unlink(probe).catch(() => undefined);
    }
  }
}
