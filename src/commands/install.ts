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

import { chmod, lstat, mkdir, readFile, realpath, rename, stat, symlink } from 'node:fs/promises';
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
// Replit bashrc wrapper markers (separate from the standard hook markers)
// ---------------------------------------------------------------------------

const REPLIT_WRAPPER_BEGIN = '# >>> myshell-tools replit bashrc wrapper >>>';
const REPLIT_WRAPPER_END = '# <<< myshell-tools replit bashrc wrapper <<<';
const REPLIT_ORIGINAL_PREFIX = '# myshell-tools-replit-original-bashrc: ';

/**
 * The Nix store prefix that a Replit `~/.bashrc` symlink resolves into.
 *
 * On a real Replit container this is always the literal `/nix/store/`. It is
 * read from an env override only so that hermetic tests can point it at a temp
 * directory (a sandbox cannot create files under the real `/nix/store/`). In
 * production the env var is unset, so behavior is byte-for-byte identical to a
 * hard-coded `'/nix/store/'` check.
 */
function nixStoreRoot(): string {
  const override = process.env['MYSHELL_NIX_STORE_ROOT'];
  return override !== undefined && override.length > 0 ? override : '/nix/store/';
}

interface ReplitShellHookResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly installed: boolean;
  readonly restored?: boolean;
  readonly rcPath: string;
  readonly originalTarget?: string;
  readonly reason?: string;
}

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
      `case "$-" in\n` +
      `  *i*) ;;\n` +
      `  *) return 0 2>/dev/null || exit 0 ;;\n` +
      `esac\n` +
      `if [ -t 1 ] && [ -z "$MYSHELL_LOADED" ] && [ -z "$MYSHELL_SKIP" ]; then\n` +
      `  export MYSHELL_LOADED=1\n` +
      `  command -v myshell-tools >/dev/null 2>&1 && myshell-tools || true\n` +
      `fi\n` +
      `# Convenience aliases: cm / mst → myshell-tools (control menu)\n` +
      `if command -v myshell-tools >/dev/null 2>&1; then\n` +
      `  alias cm='myshell-tools'\n` +
      `  alias mst='myshell-tools'\n` +
      `fi\n` +
      `${HOOK_END}`
    );
  }

  // powershell — ConstrainedLanguage-safe: no [Console]::OutputEncoding,
  // no dot-sourcing, wrap launch+aliases in try/catch, prefer .cmd then .exe
  // then bare name, use Set-Alias not function defs.
  return (
    `${HOOK_BEGIN}\n` +
    `# Launch myshell-tools on new interactive shells. Opt out: $env:MYSHELL_SKIP = '1'\n` +
    `try {\n` +
    `  if ($null -eq $env:MYSHELL_LOADED -and $null -eq $env:MYSHELL_SKIP) {\n` +
    `    $env:MYSHELL_LOADED = '1'\n` +
    `    if (Get-Command myshell-tools.cmd -CommandType Application -ErrorAction SilentlyContinue) { myshell-tools.cmd }\n` +
    `    elseif (Get-Command myshell-tools.exe -CommandType Application -ErrorAction SilentlyContinue) { myshell-tools.exe }\n` +
    `    elseif (Get-Command myshell-tools -ErrorAction SilentlyContinue) { myshell-tools }\n` +
    `  }\n` +
    `} catch {\n` +
    `}\n` +
    `# Convenience aliases: cm / mst -> myshell-tools (control menu)\n` +
    `try {\n` +
    `  if (Get-Command myshell-tools.cmd -CommandType Application -ErrorAction SilentlyContinue) {\n` +
    `    Set-Alias -Name cm -Value myshell-tools.cmd -Scope Global -ErrorAction SilentlyContinue\n` +
    `    Set-Alias -Name mst -Value myshell-tools.cmd -Scope Global -ErrorAction SilentlyContinue\n` +
    `  } elseif (Get-Command myshell-tools.exe -CommandType Application -ErrorAction SilentlyContinue) {\n` +
    `    Set-Alias -Name cm -Value myshell-tools.exe -Scope Global -ErrorAction SilentlyContinue\n` +
    `    Set-Alias -Name mst -Value myshell-tools.exe -Scope Global -ErrorAction SilentlyContinue\n` +
    `  } elseif (Get-Command myshell-tools -ErrorAction SilentlyContinue) {\n` +
    `    Set-Alias -Name cm -Value myshell-tools -Scope Global -ErrorAction SilentlyContinue\n` +
    `    Set-Alias -Name mst -Value myshell-tools -Scope Global -ErrorAction SilentlyContinue\n` +
    `  }\n` +
    `} catch {\n` +
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
// Replit pure helpers (shell quoting, wrapper build/parse)
// ---------------------------------------------------------------------------

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildReplitWrappedBashrc(originalTarget: string): string {
  const quotedTarget = shellSingleQuote(originalTarget);
  return [
    REPLIT_WRAPPER_BEGIN,
    '# Managed by myshell-tools for Replit read-only bashrc symlinks.',
    `${REPLIT_ORIGINAL_PREFIX}${originalTarget}`,
    '',
    '# Source Replit original startup logic first: tracking, completion, aliases.',
    `if [ -r ${quotedTarget} ]; then`,
    `  . ${quotedTarget}`,
    'fi',
    '',
    buildHookBlock('bash'),
    REPLIT_WRAPPER_END,
    '',
  ].join('\n');
}

export function isReplitWrappedBashrc(content: string): boolean {
  return content.includes(REPLIT_WRAPPER_BEGIN);
}

export function parseReplitOriginalTarget(content: string): string | undefined {
  const prefix = REPLIT_ORIGINAL_PREFIX;
  const start = content.indexOf(prefix);
  if (start === -1) return undefined;
  const valueStart = start + prefix.length;
  const newline = content.indexOf('\n', valueStart);
  const end = newline === -1 ? content.length : newline;
  return content.slice(valueStart, end);
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
  const found = findManagedHookBlock(existingLines);

  if (!enable) {
    if (found === undefined) return existing;
    return removeManagedHookBlock(existingLines, found);
  }

  if (found !== undefined) {
    // Replace any existing managed block (old/broken or current) with the new block.
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

function findManagedHookBlock(lines: readonly string[]): ManagedHookBlock | undefined {
  let found: ManagedHookBlock | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;

    if (isHookEndLine(line)) {
      throw new MalformedHookError();
    }

    if (!isHookBeginLine(line)) continue;

    // Found a HOOK_BEGIN — find the matching HOOK_END regardless of content
    // so old/broken managed blocks are replaced instead of erroring.
    // Nested HOOK_BEGIN before HOOK_END is still treated as malformed.
    let endIndex = -1;
    for (let j = index + 1; j < lines.length; j++) {
      const lineJ = lines[j];
      if (lineJ === undefined) continue;
      if (isHookBeginLine(lineJ)) {
        throw new MalformedHookError();
      }
      if (isHookEndLine(lineJ)) {
        endIndex = j + 1; // inclusive end
        break;
      }
    }

    if (endIndex === -1) {
      throw new MalformedHookError();
    }

    if (found !== undefined) {
      throw new MalformedHookError();
    }

    found = { start: index, end: endIndex };
    index = endIndex - 1; // skip past this block
  }

  return found;
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
 * On win32, returns both WindowsPowerShell and PowerShell 7 profile paths.
 */
function getWinProfilePaths(env: NodeJS.ProcessEnv): string[] {
  const userProfile = env['USERPROFILE'] ?? 'C:\\Users\\Default';
  return [
    `${userProfile}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`,
    `${userProfile}\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1`,
  ];
}

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
    if (platform === 'win32') {
      const paths = getWinProfilePaths(env);
      for (const path of paths) {
        try {
          const content = await readFile(path, 'utf8');
          if (content.includes(HOOK_BEGIN)) return true;
        } catch { /* path missing — check next */ }
      }
      return false;
    }

    const { path } = detectShellTarget(env, platform);
    const content = await readFile(path, 'utf8');
    return content.includes(HOOK_BEGIN);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Replit bashrc wrapper — I/O helpers (fail-soft)
// ---------------------------------------------------------------------------

async function uninstallReplitBashrcWrapper(
  rcPath: string,
  _out: OutputSink,
): Promise<ReplitShellHookResult> {
  try {
    const st = await lstat(rcPath);
    if (st.isSymbolicLink()) {
      return { ok: true, changed: false, installed: false, rcPath };
    }

    if (!st.isFile()) {
      return {
        ok: true,
        changed: false,
        installed: false,
        rcPath,
        reason: 'bashrc is not a regular file or symlink during uninstall',
      };
    }

    const content = await readFile(rcPath, 'utf8');

    if (isReplitWrappedBashrc(content)) {
      const originalTarget = parseReplitOriginalTarget(content);
      if (originalTarget === undefined) {
        return {
          ok: false,
          changed: false,
          installed: false,
          rcPath,
          reason: 'wrapped bashrc is missing original target metadata',
        };
      }

      const tempSymlink = `${rcPath}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      await symlink(originalTarget, tempSymlink);
      await rename(tempSymlink, rcPath);

      return { ok: true, changed: true, installed: false, restored: true, rcPath, originalTarget };
    }

    if (content.includes(HOOK_BEGIN)) {
      return {
        ok: true,
        changed: false,
        installed: false,
        rcPath,
        reason: 'regular unwrapped bashrc with hook present — fall through to generic uninstall',
      };
    }

    return { ok: true, changed: false, installed: false, rcPath, reason: 'no managed hook present' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, changed: false, installed: false, rcPath, reason: message };
  }
}

export async function ensureReplitShellHook(
  out: OutputSink,
  opts?: { uninstall?: boolean },
): Promise<ReplitShellHookResult> {
  const doUninstall = opts?.uninstall === true;

  if (!isReplit(process.env) || process.platform === 'win32') {
    return { ok: true, changed: false, installed: false, rcPath: '' };
  }

  const home = process.env['HOME'] ?? '/home/runner';
  const rcPath = `${home}/.bashrc`;

  try {
    const st = await lstat(rcPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });

    if (doUninstall) {
      return await uninstallReplitBashrcWrapper(rcPath, out);
    }

    if (st?.isSymbolicLink() === true) {
      const originalTarget = await realpath(rcPath);
      if (!originalTarget.startsWith(nixStoreRoot())) {
        return {
          ok: true,
          changed: false,
          installed: false,
          rcPath,
          reason: 'bashrc symlink is not a Nix store target',
        };
      }

      const content = buildReplitWrappedBashrc(originalTarget);
      await atomicWrite(rcPath, content, 0o644);
      return { ok: true, changed: true, installed: true, rcPath, originalTarget };
    }

    if (st !== undefined && st.isFile()) {
      const existing = await readFile(rcPath, 'utf8');

      if (isReplitWrappedBashrc(existing)) {
        const originalTarget = parseReplitOriginalTarget(existing);
        if (originalTarget === undefined) {
          return {
            ok: false,
            changed: false,
            installed: false,
            rcPath,
            reason: 'wrapped bashrc is missing original target metadata',
          };
        }

        const updated = buildReplitWrappedBashrc(originalTarget);
        if (existing === updated) {
          return { ok: true, changed: false, installed: true, rcPath, originalTarget };
        }

        const savedMode = st.mode & 0o7777;
        await atomicWrite(rcPath, updated, savedMode);
        return { ok: true, changed: true, installed: true, rcPath, originalTarget };
      }

      return {
        ok: true,
        changed: false,
        installed: existing.includes(HOOK_BEGIN),
        rcPath,
        reason: 'regular unwrapped bashrc',
      };
    }

    return {
      ok: true,
      changed: false,
      installed: false,
      rcPath,
      reason: 'bashrc is not a symlink or regular file',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.write(`[warn] Replit shell hook heal failed: ${message}\n`);
    return { ok: false, changed: false, installed: false, rcPath, reason: message };
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

  if (isReplit(process.env) && process.platform !== 'win32' && kind === 'bash') {
    const result = await ensureReplitShellHook(out, { uninstall: !enable });
    if (result.ok && result.installed && enable) {
      out.write(`[info] Replit shell hook installed in: ${result.rcPath}\n`);
      if (result.originalTarget !== undefined) {
        out.write(`[info] Replit original bashrc preserved: ${result.originalTarget}\n`);
      }
      out.write(`[info] New Replit shell tabs will launch myshell-tools automatically.\n`);
      return 0;
    }
    if (result.ok && result.restored && !enable) {
      out.write(`[info] Replit shell hook removed from: ${result.rcPath}\n`);
      out.write(`[info] Original bashrc symlink restored.\n`);
      return 0;
    }
  }

  // On win32, write/remove the hook in both WindowsPowerShell and PowerShell 7
  // profile paths so the hook fires regardless of which PowerShell the user launches.
  const isWin = process.platform === 'win32';
  const targetPaths = isWin ? getWinProfilePaths(process.env) : [rcPath];

  let anyOk = false;
  for (const rcPathItem of targetPaths) {
    const result = await upsertOneFile(rcPathItem, kind, enable, out, rcPathItem === rcPath);
    if (result) anyOk = true;
  }

  if (anyOk) return 0;
  return 1;
}

/**
 * Upsert the hook into a single rc/profile file. Returns true on success.
 * `isPrimary` controls whether the path is reported in the output.
 */
async function upsertOneFile(
  rcPath: string,
  kind: ShellKind,
  enable: boolean,
  out: OutputSink,
  isPrimary: boolean,
): Promise<boolean> {
  let target: RcWriteTarget;
  try {
    target = await resolveRcWriteTarget(rcPath);
  } catch (err) {
    if (err instanceof RcSymlinkResolveError) {
      out.write(`[error] ${err.message}\n`);
      out.write(`[error] Refusing to replace the symlink.\n`);
      out.write(`[info] Add this hook manually to the real rc file:\n`);
      out.write(buildHookBlock(kind) + '\n');
      return false;
    }

    const nodeErr = err as NodeJS.ErrnoException;
    out.write(`[error] Could not inspect ${rcPath}: ${nodeErr.message}\n`);
    return false;
  }

  // Read existing content (treat missing file as empty).
  let existing = '';
  if (target.existed) {
    try {
      existing = await readFile(target.writePath, 'utf8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      out.write(`[error] Could not read ${target.writePath}: ${nodeErr.message}\n`);
      return false;
    }
  }

  let updated;
  try {
    updated = upsertHook(existing, kind, enable);
  } catch (err) {
    if (err instanceof MalformedHookError) {
      out.write(`[error] ${err.message}\n`);
      out.write(`[info] Markers to look for: ${HOOK_BEGIN} / ${HOOK_END}\n`);
      return false;
    }
    throw err;
  }

  // If uninstalling and the block wasn't present, report and return cleanly.
  if (!enable && updated === existing) {
    if (isPrimary) {
      out.write(`[info] No myshell-tools hook found in ${rcPath} — nothing to remove.\n`);
    }
    return true; // not an error — just nothing to do
  }

  // Write atomically — create parent dir if needed.
  try {
    await mkdir(dirname(target.writePath), { recursive: true });
    await atomicWrite(target.writePath, updated, target.mode);
    await chmod(target.writePath, target.mode);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    out.write(`[error] Could not write ${target.writePath}: ${nodeErr.message}\n`);
    return false;
  }

  if (enable) {
    if (isPrimary) {
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
    }
  } else {
    if (isPrimary) {
      out.write(`[info] Shell hook removed from: ${rcPath}\n`);
      if (target.resolvedFromSymlink) {
        out.write(`[info] Preserved symlink and wrote resolved target: ${target.writePath}\n`);
      }
      out.write(`[info] myshell-tools will no longer auto-launch in new shells.\n`);
    }
  }

  return true;
}
