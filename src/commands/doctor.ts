/**
 * src/commands/doctor.ts — `myshell-tools doctor` health-check command.
 *
 * Probes the runtime environment (providers, filesystem, pricing) and prints
 * an honest, human-readable report to an OutputSink. All displayed data comes
 * from real detection results — no fabricated values.
 *
 * Honesty contract: authentication status for Claude is labelled OPTIMISTIC
 * because we cannot cheaply probe auth state without spending API quota.
 */

import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutputSink } from '../interface/render.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import { isPricingStale } from '../infra/pricing.js';
import { bold, green, red, yellow, dim, divider, label } from '../ui/theme.js';

// ---------------------------------------------------------------------------
// Pure builder — testable with a fake EnvironmentStatus
// ---------------------------------------------------------------------------

export interface DoctorExtras {
  readonly nodeVersion: string;
  readonly stateWritable: boolean;
  readonly pricingStale: boolean;
}

/**
 * Build the doctor report lines from pre-collected data.
 *
 * Pure function: no I/O, no process.exit, no side effects.
 * Used by runDoctor after it collects the real data, and by unit tests with
 * hand-built inputs.
 *
 * @param env    - Full environment status (from detectEnvironment or a fake).
 * @param extras - Supplemental runtime info (node version, write probe, etc.).
 * @param color  - Whether to emit ANSI colour codes.
 */
export function buildDoctorReport(
  env: EnvironmentStatus,
  extras: DoctorExtras,
  color: boolean,
): string[] {
  const lines: string[] = [];

  lines.push(bold('myshell-tools doctor', color));
  lines.push(divider(color));

  // ---- Platform & Node -------------------------------------------------------
  lines.push(`${label('Platform', color)}: ${env.platform}`);
  lines.push(`${label('Node', color)}:     ${extras.nodeVersion}`);

  // ---- .myshell-tools writability ---------------------------------------------------
  const writableText = extras.stateWritable
    ? green('writable', color)
    : red('not writable', color);
  lines.push(`${label('.myshell-tools dir', color)}: ${writableText}`);

  // ---- Pricing staleness -----------------------------------------------------
  const pricingText = extras.pricingStale
    ? yellow('stale — consider updating myshell-tools', color)
    : green('up to date', color);
  lines.push(`${label('Pricing table', color)}: ${pricingText}`);

  lines.push(divider(color));

  // ---- Providers -------------------------------------------------------------
  lines.push(bold('Providers', color));

  for (const ps of [env.claude, env.codex]) {
    if (ps.installed) {
      const versionStr = ps.version !== null ? ps.version : 'unknown';
      lines.push(
        `  ${green('✓', color)} ${bold(ps.id, color)} — installed, version: ${versionStr}`,
      );
      // Auth is optimistic for Claude; codex is always not-installed for now
      if (ps.id === 'claude') {
        lines.push(
          `    ${label('auth', color)}: ${dim('assumed; verified on first run', color)}`,
        );
      }
    } else {
      lines.push(
        `  ${red('✗', color)} ${bold(ps.id, color)} — ${red('not installed', color)}`,
      );
      lines.push(
        `    ${dim(`Install: ${getInstallCommand(ps.id)}`, color)}`,
      );
    }
  }

  lines.push(divider(color));

  // ---- Overall status --------------------------------------------------------
  if (env.hasAnyProvider) {
    lines.push(green('Ready — at least one provider is available.', color));
  } else {
    lines.push(
      red('No providers found.', color) +
        ' Install claude or codex to use myshell-tools.',
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// I/O runner — called by cli.ts
// ---------------------------------------------------------------------------

/**
 * Probe the .myshell-tools directory for writability.
 *
 * Creates .myshell-tools/ if needed, writes a temp file, then removes it.
 * Returns true when successful, false on any I/O error.
 */
async function probestateWritable(cwd: string): Promise<boolean> {
  const stateDir = join(cwd, '.myshell-tools');
  const probe = join(stateDir, '.doctor-probe');
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

/**
 * Detect the environment, probe I/O, build the report, and write it to `out`.
 *
 * Returns 0 when at least one provider is installed, 1 otherwise.
 * Never calls process.exit — that is handled exclusively by src/cli.ts.
 */
export async function runDoctor(out: OutputSink): Promise<number> {
  const env = await detectEnvironment();
  const stateWritable = await probestateWritable(process.cwd());

  const extras: DoctorExtras = {
    nodeVersion: process.version,
    stateWritable,
    pricingStale: isPricingStale(),
  };

  const lines = buildDoctorReport(env, extras, out.color);
  for (const line of lines) {
    out.write(line + '\n');
  }

  return env.hasAnyProvider ? 0 : 1;
}
