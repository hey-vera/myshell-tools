/**
 * src/infra/clipboard.ts — a fail-soft system-clipboard shim for `/copy`
 * (real-chat gap #3).
 *
 * The ONE bit of OS I/O the copy command needs. It shells out to the platform's
 * clipboard tool (pbcopy on macOS, wl-copy/xclip/xsel on Linux/Wayland/X11,
 * clip.exe on Windows/WSL) by piping the text to the tool's stdin. There is no
 * network, no hosted share — clipboard is purely local.
 *
 * Honesty + headless contract: on a headless host (Replit, CI) there is usually
 * NO clipboard tool, so every candidate spawn fails. The shim is fail-soft —
 * it never throws — and reports `false` so the caller can print a clean
 * "clipboard unavailable — here's the text:" fallback that the user can select.
 *
 * The OS spawn lives behind the injected {@link ClipboardPort} so the command is
 * hermetically testable: tests inject a fake port (success / failure / observe
 * the text) with zero real process spawning.
 */

import { spawn } from 'node:child_process';

/**
 * The injected clipboard port. Given the text to copy, attempts to place it on
 * the system clipboard and resolves `true` on success, `false` on any failure
 * (no tool, spawn error, non-zero exit). MUST never throw — failure is a `false`,
 * not an exception, so the caller's fallback path is always reachable.
 */
export type ClipboardPort = (text: string) => Promise<boolean>;

/**
 * The platform clipboard-write candidates, tried in order. Each is a command +
 * args whose STDIN receives the text. The first that exists and exits 0 wins.
 * Wayland (wl-copy) is tried before X11 (xclip/xsel) so a Wayland session isn't
 * shadowed by a stale X11 tool; clip.exe covers Windows + WSL.
 */
function clipboardCandidates(platform: NodeJS.Platform): ReadonlyArray<{
  readonly cmd: string;
  readonly args: readonly string[];
}> {
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ cmd: 'clip.exe', args: [] }, { cmd: 'clip', args: [] }];
  // Linux / other unix: Wayland first, then X11, then WSL's clip.exe as a fallback.
  return [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
    { cmd: 'clip.exe', args: [] },
  ];
}

/**
 * Try to write `text` to one specific clipboard tool. Resolves `true` only when
 * the tool spawns AND exits 0; resolves `false` on a missing binary (ENOENT),
 * any spawn error, or a non-zero exit. Never throws/rejects.
 */
function trySpawnCopy(cmd: string, args: readonly string[], text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => done(false)); // ENOENT (no such tool) etc.
      child.on('close', (code) => done(code === 0));
      child.stdin.on('error', () => done(false)); // EPIPE if the tool dies early
      child.stdin.end(text);
    } catch {
      done(false);
    }
  });
}

/**
 * The default, real {@link ClipboardPort}: walks the platform candidates and
 * resolves `true` on the first that succeeds, `false` when none do. Fail-soft.
 */
export const systemClipboardPort: ClipboardPort = async (text: string): Promise<boolean> => {
  for (const c of clipboardCandidates(process.platform)) {
    try {
      if (await trySpawnCopy(c.cmd, c.args, text)) return true;
    } catch {
      // Defensive: trySpawnCopy already swallows; keep walking the candidates.
    }
  }
  return false;
};
