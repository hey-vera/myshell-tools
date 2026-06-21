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

import { chmod, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWrite } from '../infra/atomic.js';
import { isReplit } from '../infra/state-dir.js';
import type { OutputSink } from '../interface/render.js';

// ---------------------------------------------------------------------------
// Shell kind
// ---------------------------------------------------------------------------

export type ShellKind = 'bash' | 'zsh' | 'powershell';
type DetectShellKind = ShellKind | 'fish';

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
): { kind: DetectShellKind; path: string } {
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

  if (shell.includes('fish')) {
    return { kind: 'fish', path: `${home}/.config/fish/config.fish` };
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
 * Also defines convenience aliases (`cm` and `mst`) for myshell-tools so the
 * control panel is reachable from any shell prompt after first launch.  The
 * aliases are guarded by a command-exists check so they are harmless on shells
 * where myshell-tools is not installed.
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
      `# Convenience aliases: cm / mst → myshell-tools (control menu)\n` +
      `if command -v myshell-tools >/dev/null 2>&1; then\n` +
      `  alias cm='myshell-tools'\n` +
      `  alias mst='myshell-tools'\n` +
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
    `# Convenience functions: cm / mst → myshell-tools (control menu)\n` +
    `if (Get-Command myshell-tools -ErrorAction SilentlyContinue) {\n` +
    `  function cm { myshell-tools @args }\n` +
    `  function mst { myshell-tools @args }\n` +
    `}\n` +
    `${HOOK_END}`
  );
}

function buildFishManualHookBlock(): string {
  return (
    `${HOOK_BEGIN}\n` +
    `# Launch myshell-tools on new interactive shells. Opt out: set -gx MYSHELL_SKIP 1\n` +
    `if status is-interactive; and test -z "$MYSHELL_LOADED"; and test -z "$MYSHELL_SKIP"\n` +
    `  set -gx MYSHELL_LOADED 1\n` +
    `  command -q myshell-tools; and myshell-tools\n` +
    `end\n` +
    `# Convenience aliases: cm / mst -> myshell-tools (control menu)\n` +
    `if command -q myshell-tools\n` +
    `  alias cm='myshell-tools'\n` +
    `  alias mst='myshell-tools'\n` +
    `end\n` +
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
  const block = buildHookBlock(kind);
  const blockLines = splitLines(block + '\n');
  const existingLines = splitLines(existing);
  const found = findManagedHookBlock(existingLines, blockLines);

  if (!enable) {
    if (found === undefined) return existing;
    return removeManagedHookBlock(existingLines, found);
  }

  if (found !== undefined) {
    return [
      ...existingLines.slice(0, found.start),
      ...blockLines,
      ...existingLines.slice(found.end),
    ].join('');
  }

  const separator = existing.length > 0 ? '\n' : '';
  return existing + separator + block + '\n';
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

class MalformedHookError extends Error {
  constructor() {
    super(
      `myshell-tools hook markers look malformed. Remove the block manually by deleting only the lines from "${HOOK_BEGIN}" through "${HOOK_END}", then rerun this command.`,
    );
    this.name = 'MalformedHookError';
  }
}

class RcSymlinkResolveError extends Error {
  readonly rcPath: string;

  constructor(rcPath: string, cause: unknown) {
    super(
      `${rcPath} is a symlink, but its target could not be resolved: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.rcPath = rcPath;
    this.name = 'RcSymlinkResolveError';
  }
}

interface ManagedHookBlock {
  readonly start: number;
  readonly end: number;
}

interface RcWriteTarget {
  readonly writePath: string;
  readonly existed: boolean;
  readonly mode: number;
  readonly resolvedFromSymlink: boolean;
}

const NEW_RC_MODE = 0o600;

function splitLines(content: string): string[] {
  const lines: string[] = [];
  let start = 0;

  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) {
      lines.push(content.slice(start));
      break;
    }
    lines.push(content.slice(start, newline + 1));
    start = newline + 1;
  }

  return lines;
}

function lineWithoutEnding(line: string): string {
  const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;
  return withoutNewline.endsWith('\r') ? withoutNewline.slice(0, -1) : withoutNewline;
}

function isHookBeginLine(line: string): boolean {
  return lineWithoutEnding(line) === HOOK_BEGIN;
}

function isHookEndLine(line: string): boolean {
  return lineWithoutEnding(line) === HOOK_END;
}

function isBlankLine(line: string): boolean {
  return line === '\n';
}

function findManagedHookBlock(lines: readonly string[], blockLines: readonly string[]): ManagedHookBlock | undefined {
  let found: ManagedHookBlock | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;

    if (isHookEndLine(line)) {
      throw new MalformedHookError();
    }

    if (!isHookBeginLine(line)) continue;

    const end = index + blockLines.length;
    const candidate = lines.slice(index, end);
    if (candidate.length !== blockLines.length || !linesMatch(candidate, blockLines)) {
      throw new MalformedHookError();
    }

    if (found !== undefined) {
      throw new MalformedHookError();
    }

    found = { start: index, end };
    index = end - 1;
  }

  return found;
}

function linesMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function removeManagedHookBlock(lines: readonly string[], block: ManagedHookBlock): string {
  if (block.start > 0 && isBlankLine(lines[block.start - 1] ?? '')) {
    return [...lines.slice(0, block.start - 1), ...lines.slice(block.end)].join('');
  }

  if (block.start > 0) {
    const previous = lines[block.start - 1];
    if (previous?.endsWith('\n') === true) {
      return [
        ...lines.slice(0, block.start - 1),
        previous.slice(0, -1),
        ...lines.slice(block.end),
      ].join('');
    }
  }

  return [...lines.slice(0, block.start), ...lines.slice(block.end)].join('');
}

async function resolveRcWriteTarget(rcPath: string): Promise<RcWriteTarget> {
  let initialStat;
  try {
    initialStat = await lstat(rcPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
    // New rc files are private by default because shell rc files can hold secrets.
    return { writePath: rcPath, existed: false, mode: NEW_RC_MODE, resolvedFromSymlink: false };
  }

  if (!initialStat.isSymbolicLink()) {
    const targetStat = await stat(rcPath);
    return {
      writePath: rcPath,
      existed: true,
      mode: targetStat.mode & 0o7777,
      resolvedFromSymlink: false,
    };
  }

  let resolved;
  let targetStat;
  try {
    resolved = await realpath(rcPath);
    targetStat = await stat(resolved);
  } catch (err) {
    throw new RcSymlinkResolveError(rcPath, err);
  }

  return {
    writePath: resolved,
    existed: true,
    mode: targetStat.mode & 0o7777,
    resolvedFromSymlink: true,
  };
}

// ---------------------------------------------------------------------------
// isHookInstalled — never-throwing detector
// ---------------------------------------------------------------------------

/**
 * True when the myshell-tools shell hook is already present in the user's rc file.
 *
 * Never throws: a missing file, unreadable path, or any other I/O error simply
 * returns false.
 */
export async function isHookInstalled(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const { path } = detectShellTarget(env, platform);
    const content = await readFile(path, 'utf8');
    return content.includes(HOOK_BEGIN);
  } catch {
    return false;
  }
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

  if (kind === 'fish') {
    out.write(`[error] fish is not supported by myshell-tools install yet.\n`);
    out.write(`[info] Refusing to write a bash hook for a fish shell.\n`);
    out.write(`[info] Closest manual fish guidance for ${rcPath}:\n`);
    out.write(buildFishManualHookBlock() + '\n');
    return 1;
  }

  let target: RcWriteTarget;
  try {
    target = await resolveRcWriteTarget(rcPath);
  } catch (err) {
    if (err instanceof RcSymlinkResolveError) {
      out.write(`[error] ${err.message}\n`);
      out.write(`[error] Refusing to replace the symlink.\n`);
      out.write(`[info] Add this hook manually to the real rc file:\n`);
      out.write(buildHookBlock(kind) + '\n');
      return 1;
    }

    const nodeErr = err as NodeJS.ErrnoException;
    out.write(`[error] Could not inspect ${rcPath}: ${nodeErr.message}\n`);
    return 1;
  }

  // Read existing content (treat missing file as empty).
  let existing = '';
  if (target.existed) {
    try {
      existing = await readFile(target.writePath, 'utf8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      out.write(`[error] Could not read ${target.writePath}: ${nodeErr.message}\n`);
      return 1;
    }
  }

  let updated;
  try {
    updated = upsertHook(existing, kind, enable);
  } catch (err) {
    if (err instanceof MalformedHookError) {
      out.write(`[error] ${err.message}\n`);
      out.write(`[info] Markers to look for: ${HOOK_BEGIN} / ${HOOK_END}\n`);
      return 1;
    }
    throw err;
  }

  // If uninstalling and the block wasn't present, report and return cleanly.
  if (!enable && updated === existing) {
    out.write(`[info] No myshell-tools hook found in ${rcPath} — nothing to remove.\n`);
    return 0;
  }

  // Write atomically — create parent dir if needed.
  try {
    await mkdir(dirname(target.writePath), { recursive: true });
    await atomicWrite(target.writePath, updated, target.mode);
    await chmod(target.writePath, target.mode);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    out.write(`[error] Could not write ${target.writePath}: ${nodeErr.message}\n`);
    return 1;
  }

  if (enable) {
    out.write(`[info] Shell hook installed in: ${rcPath}\n`);
    if (target.resolvedFromSymlink) {
      out.write(`[info] Preserved symlink and wrote resolved target: ${target.writePath}\n`);
    }
    out.write(`[info] New interactive shells will launch myshell-tools automatically.\n`);
    out.write(`[info] Shortcuts available in new shells: cm / mst (both run myshell-tools).\n`);
    out.write(`[info] Opt out any time: export MYSHELL_SKIP=1 (bash/zsh) or $env:MYSHELL_SKIP='1' (PowerShell)\n`);
    out.write(`[info] To reverse: myshell-tools uninstall\n`);
    if (isReplit(process.env)) {
      out.write(`[info] Replit: the hook targets the rc for *this* container. On restart the persisted "set as default" flag will cause myshell-tools to automatically re-install the hook into the fresh rc on next launch.\n`);
    }
  } else {
    out.write(`[info] Shell hook removed from: ${rcPath}\n`);
    if (target.resolvedFromSymlink) {
      out.write(`[info] Preserved symlink and wrote resolved target: ${target.writePath}\n`);
    }
    out.write(`[info] myshell-tools will no longer auto-launch in new shells.\n`);
  }

  return 0;
}
