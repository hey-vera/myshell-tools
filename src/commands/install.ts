/**
 * src/commands/install.ts — Shell startup hook installer / uninstaller.
 *
 * Appends (or removes) a guarded block to the user's shell rc file so that
 * opening a new interactive shell automatically launches myshell-tools.
 *
 * The block is idempotent (install twice → one block) and fully reversible
 * (`myshell-tools uninstall` removes it).
 *
 * Honesty contract:
 *   - Only writes when the caller explicitly consents.
 *   - Reports exactly what was written and where.
 *   - Never claims success when I/O failed.
 *   - No digit-% literals.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from '../infra/atomic.js';
import type { OutputSink } from '../interface/render.js';

// ---------------------------------------------------------------------------
// Shell kind
// ---------------------------------------------------------------------------

export type ShellKind = 'bash' | 'zsh' | 'powershell';

// ---------------------------------------------------------------------------
// Hook markers
// ---------------------------------------------------------------------------

export const HOOK_BEGIN = '# >>> myshell-tools >>>';
export const HOOK_END = '# <<< myshell-tools <<<';

// ---------------------------------------------------------------------------
// detectShellTarget — PURE
// ---------------------------------------------------------------------------

/**
 * Determine which shell rc file to write.
 *
 * Pure function: takes env + platform, returns kind + absolute path.
 *
 * @param env      - A `NodeJS.ProcessEnv`-shaped object (real or fake).
 * @param platform - A `NodeJS.Platform`-shaped string (real or fake).
 */
export function detectShellTarget(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { kind: ShellKind; path: string } {
  if (platform === 'win32') {
    const userProfile = env['USERPROFILE'] ?? 'C:\\Users\\Default';
    return {
      kind: 'powershell',
      path: `${userProfile}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`,
    };
  }

  const shell = env['SHELL'] ?? '';
  const home = env['HOME'] ?? '/root';

  if (shell.includes('zsh')) {
    return { kind: 'zsh', path: `${home}/.zshrc` };
  }

  return { kind: 'bash', path: `${home}/.bashrc` };
}

// ---------------------------------------------------------------------------
// buildHookBlock — PURE
// ---------------------------------------------------------------------------

/**
 * Build the guarded shell startup block for the given shell kind.
 *
 * For bash/zsh: uses POSIX `[ -t 1 ]` TTY guard and env-var opt-out.
 * For powershell: uses `$Host.UI.RawUI` TTY check and equivalent env guards.
 *
 * Pure function — returns a string, never does I/O.
 */
export function buildHookBlock(kind: ShellKind): string {
  if (kind === 'bash' || kind === 'zsh') {
    return (
      `${HOOK_BEGIN}\n` +
      `# Launch myshell-tools on new interactive shells. Opt out: export MYSHELL_SKIP=1\n` +
      `if [ -t 1 ] && [ -z "$MYSHELL_LOADED" ] && [ -z "$MYSHELL_SKIP" ]; then\n` +
      `  export MYSHELL_LOADED=1\n` +
      `  command -v myshell-tools >/dev/null 2>&1 && myshell-tools\n` +
      `fi\n` +
      `${HOOK_END}`
    );
  }

  // powershell
  return (
    `${HOOK_BEGIN}\n` +
    `# Launch myshell-tools on new interactive shells. Opt out: $env:MYSHELL_SKIP = '1'\n` +
    `if ($null -eq $env:MYSHELL_LOADED -and $null -eq $env:MYSHELL_SKIP) {\n` +
    `  $env:MYSHELL_LOADED = '1'\n` +
    `  if (Get-Command myshell-tools -ErrorAction SilentlyContinue) { myshell-tools }\n` +
    `}\n` +
    `${HOOK_END}`
  );
}

// ---------------------------------------------------------------------------
// upsertHook — PURE
// ---------------------------------------------------------------------------

/**
 * Insert or remove the hook block in `existing` rc file content.
 *
 * - If `enable` is true:  remove any existing block, then append a fresh one.
 * - If `enable` is false: remove any existing block (uninstall).
 *
 * Idempotent: calling with enable=true twice still yields exactly one block.
 * Reversible: calling with enable=false removes all traces.
 *
 * Pure function — takes and returns strings, never does I/O.
 */
export function upsertHook(existing: string, kind: ShellKind, enable: boolean): string {
  // Strip any existing block (including surrounding blank lines we added).
  // The pattern handles: optional leading \n, BEGIN marker, anything, END marker,
  // optional trailing \n — all removed in one pass.
  const stripped = existing
    .replace(
      new RegExp(
        `\n?${escapeRegExp(HOOK_BEGIN)}[\\s\\S]*?${escapeRegExp(HOOK_END)}\n?`,
        'g',
      ),
      '',
    )
    .trimEnd();

  if (!enable) {
    // Return stripped content. Preserve trailing newline when content exists.
    return stripped.length > 0 ? stripped + '\n' : '';
  }

  const block = buildHookBlock(kind);
  // Separate from existing content with a blank line if there is any.
  const separator = stripped.length > 0 ? '\n\n' : '';
  return stripped + separator + block + '\n';
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// runInstall — I/O runner
// ---------------------------------------------------------------------------

/**
 * Detect the shell target, read the rc file, upsert the hook, and write it back.
 *
 * Prints clearly:
 *   - On install:   the rc file path, that new shells will launch myshell-tools,
 *                   opt-out instructions, and how to reverse.
 *   - On uninstall: confirmation that the block was removed.
 *
 * Returns 0 on success, 1 on failure.
 * Never calls process.exit — that is handled exclusively by src/cli.ts.
 */
export async function runInstall(
  out: OutputSink,
  opts?: { uninstall?: boolean },
): Promise<number> {
  const enable = !(opts?.uninstall ?? false);
  const { kind, path: rcPath } = detectShellTarget(process.env, process.platform);

  // Read existing content (treat missing file as empty).
  let existing = '';
  try {
    existing = await readFile(rcPath, 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') {
      out.write(`[error] Could not read ${rcPath}: ${nodeErr.message}\n`);
      return 1;
    }
    // File doesn't exist yet — fine, we'll create it on write.
  }

  const updated = upsertHook(existing, kind, enable);

  // If uninstalling and the block wasn't present, report and return cleanly.
  if (!enable && updated === (existing.trimEnd().length > 0 ? existing.trimEnd() + '\n' : existing)) {
    out.write(`[info] No myshell-tools hook found in ${rcPath} — nothing to remove.\n`);
    return 0;
  }

  // Write atomically — create parent dir if needed.
  try {
    await mkdir(dirname(rcPath), { recursive: true });
    await atomicWrite(rcPath, updated);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    out.write(`[error] Could not write ${rcPath}: ${nodeErr.message}\n`);
    return 1;
  }

  if (enable) {
    out.write(`[info] Shell hook installed in: ${rcPath}\n`);
    out.write(`[info] New interactive shells will launch myshell-tools automatically.\n`);
    out.write(`[info] Opt out any time: export MYSHELL_SKIP=1 (bash/zsh) or $env:MYSHELL_SKIP='1' (PowerShell)\n`);
    out.write(`[info] To reverse: myshell-tools uninstall\n`);
  } else {
    out.write(`[info] Shell hook removed from: ${rcPath}\n`);
    out.write(`[info] myshell-tools will no longer auto-launch in new shells.\n`);
  }

  return 0;
}
