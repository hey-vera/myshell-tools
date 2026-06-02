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

import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

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
  /** Whether the bundled pricing seed is past its staleness window. */
  readonly pricingStale: boolean;
  /** Minimum supported Node major version (defaults to 20). */
  readonly minNodeMajor?: number;
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
    issues.push({
      id: 'state-not-writable',
      severity: 'error',
      message:
        "Can't write to the .myshell-tools state directory — conversations and " +
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

  return issues;
}

// ---------------------------------------------------------------------------
// I/O probe (run once at startup; result fed into evaluateHealth)
// ---------------------------------------------------------------------------

/**
 * Probe whether the .myshell-tools state directory under `cwd` is writable.
 *
 * Creates the directory if needed, writes and removes a temp file. Returns true
 * on success, false on any I/O error. Never throws.
 */
export async function probeStateWritable(cwd: string): Promise<boolean> {
  const stateDir = join(cwd, '.myshell-tools');
  const probe = join(stateDir, '.health-probe');
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });
    await access(stateDir);
    return true;
  } catch {
    return false;
  }
}
