/**
 * src/infra/controlling-tty.ts — run an interactive child against the real terminal.
 *
 * When myshell-tools spawns an interactive vendor CLI (a `claude /login` paste
 * prompt, a full `claude`/`codex` passthrough session), the child must read the
 * user's keystrokes. Normally `process.stdin` IS the controlling terminal, so
 * inheriting it is correct and nothing changes.
 *
 * But in wrapper shells (e.g. Replit `data-tools`/`replit-tools`) the orchestrator's
 * `process.stdin` is a PIPE, not the terminal — the user's keystrokes only reach
 * `/dev/tty` (the controlling terminal). An inherited child would read the (empty)
 * pipe and the vendor's prompt would HANG with no input. This is the same reason
 * the Ink UI now mounts on the `/dev/tty` raw-key fallback in that shell — and the
 * inherited child needs the SAME correction: hand it `/dev/tty` as its fd 0.
 *
 * This is independent of the Ink/legacy choice: it corrects the child's input
 * source on BOTH paths in a pipe-stdin shell, and is a no-op on a normal terminal
 * or a genuine non-interactive/CI run (no controlling TTY).
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { execa } from 'execa';

/**
 * Resolve the stdin an interactive child should read from, plus a `cleanup` that
 * closes any fd we opened (call it after the child exits).
 *
 * - `process.stdin` is a TTY (normal terminal) → `'inherit'` (zero behaviour change).
 * - Windows → `'inherit'` (no `/dev/tty`).
 * - stdin is NOT a TTY but `/dev/tty` opens → the `/dev/tty` fd (the real terminal).
 *   Opened `'r+'` (O_RDWR) so the child can run its own termios/raw-mode ioctls.
 * - stdin is NOT a TTY and `/dev/tty` can't be opened (true non-interactive / CI) →
 *   `'inherit'` (an interactive login isn't happening there anyway).
 */
export function resolveInteractiveChildStdin(): {
  readonly stdin: number | 'inherit';
  readonly cleanup: () => void;
} {
  const noop = (): void => {};
  if (process.stdin.isTTY === true || process.platform === 'win32') {
    return { stdin: 'inherit', cleanup: noop };
  }
  try {
    const fd = fs.openSync('/dev/tty', 'r+');
    return {
      stdin: fd,
      cleanup: () => {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      },
    };
  } catch {
    return { stdin: 'inherit', cleanup: noop };
  }
}

/** A running interactive child, awaitable and killable. */
export interface InteractiveChildHandle {
  /** Resolves with the child's exit code (or `null` on spawn error / unknown). */
  readonly done: Promise<number | null>;
  /** Best-effort signal to the child. */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Run an interactive vendor child with its stdin pointed at the real terminal,
 * stdout/stderr inherited. Never rejects; `done` resolves with the exit code.
 *
 * The common case (`process.stdin` is a TTY, or Windows, or no `/dev/tty`) keeps
 * using execa with `stdin:'inherit'` exactly as before — so vendor binary
 * resolution (PATH, Windows `.cmd` shims) is unchanged on every platform. ONLY the
 * pipe-stdin-shell case (a real POSIX `/dev/tty` fd) uses `child_process.spawn`,
 * which is the correct primitive for sharing a raw tty fd with the child; on POSIX
 * spawn resolves the bin via PATH just like execa.
 */
export function runInteractiveChild(
  bin: string,
  args: readonly string[],
  opts: { readonly env?: NodeJS.ProcessEnv } = {},
): InteractiveChildHandle {
  const { stdin, cleanup } = resolveInteractiveChildStdin();
  const env = opts.env ?? process.env;

  if (stdin === 'inherit') {
    const sub = execa(bin, [...args], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      reject: false,
      env,
    });
    const done = sub.then(
      (result) => {
        cleanup();
        return result.exitCode ?? null;
      },
      () => {
        cleanup();
        return null;
      },
    );
    return {
      done,
      kill: (signal) => {
        try {
          sub.kill(signal);
        } catch {
          /* already exited */
        }
      },
    };
  }

  // POSIX pipe-stdin shell: hand the child /dev/tty as fd0 so it reads real keys.
  // spawn() can throw SYNCHRONOUSLY (EMFILE, ENOENT on a bad bin, etc.) BEFORE the
  // exit/error handlers attach — in that case the /dev/tty fd we opened would never
  // be closed (a fd leak across repeated logins). Guard it: on a synchronous throw,
  // close the fd via cleanup() and return an inert handle (done → null, kill → noop),
  // matching the "never rejects" contract.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, [...args], { stdio: [stdin, 'inherit', 'inherit'], env });
  } catch {
    cleanup();
    return { done: Promise.resolve(null), kill: () => {} };
  }
  const done = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      cleanup();
      resolve(code);
    });
    child.on('error', () => {
      cleanup();
      resolve(null);
    });
  });
  return {
    done,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /* already exited */
      }
    },
  };
}
