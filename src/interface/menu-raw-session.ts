/**
 * src/interface/menu-raw-session.ts — Extracted from menu.ts — behavior-preserving.
 *
 * Raw provider passthrough: launch the native claude/codex/opencode interactive
 * CLI directly (stdio:inherit) and hand over the terminal until it exits.
 */

import type { EnvironmentStatus } from '../providers/detect.js';
import type { OutputSink } from './render.js';
import { readMenuKey } from './menu-key-confirm.js';
import { countRecentInterrupts } from './menu-display.js';
import { runInteractiveChild } from '../infra/controlling-tty.js';

/**
 * Decide whether a raw-session SIGINT count warrants escaping back to the menu.
 *
 * Returns true when count >= 2 (rapid double Ctrl+C), false otherwise.
 * A single press (count === 1) is left entirely to the child process — the
 * terminal already delivers SIGINT to the whole foreground process group, so
 * claude/codex/opencode handles its own cancel without interference from us.
 *
 * Pure — no I/O, no side effects, never throws.
 *
 * @param count - Number of recent Ctrl+C presses (from countRecentInterrupts).
 * @returns True when the user should be returned to the myshell-tools menu.
 */
export function shouldEscapeRawSession(count: number): boolean {
  return count >= 2;
}

/**
 * Launch the native `claude`, `codex`, or `opencode` interactive CLI directly
 * (stdio:inherit), so the user gets a raw provider session. The session is owned
 * by the native CLI (not by myshell-tools); we simply hand over the terminal and wait.
 *
 * On Unix, a best-effort "Ctrl+C twice → back to menu" escape is registered:
 *   - A single Ctrl+C is left entirely to the child (the terminal delivers SIGINT
 *     to the whole foreground group; we must NOT interfere with single presses).
 *   - Two presses within 1 500 ms → SIGTERM the child and return to the menu.
 * On Windows the SIGINT handler is NOT registered (process-group semantics differ
 * and forced interception risks a broken console) — behaviour is exactly as today.
 *
 * The SIGINT listener is always removed in a finally block so it never leaks back
 * to the menu loop. This is best-effort: forcibly terminating the child to return
 * to the menu may leave the terminal in a non-ideal state; the existing
 * "Returned from <bin>." message and menu re-render happen on return regardless.
 *
 * On exit (any exit code), control returns to the myshell-tools menu.
 */
export async function runRawProviderSession(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  env: EnvironmentStatus,
  suspendStdin?: () => () => void,
  // Single-key reader for the Ink path. When provided, the provider-pick keypress
  // resolves on a SINGLE key through Ink's own input pipeline (the legacy raw
  // single-key feel). Absent → legacy path is byte-identical.
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  const choices: Array<{ label: string; bin: string }> = [];
  for (const ps of [env.claude, env.codex, env.opencode, env.grok]) {
    if (!ps.installed) continue;
    const label =
      ps.id === 'claude' ? 'Claude' : ps.id === 'codex' ? 'Codex' : ps.id === 'grok' ? 'Grok' : 'opencode';
    choices.push({ label, bin: ps.binaryPath ?? ps.id });
  }

  if (choices.length === 0) {
    out.write('\nNo provider CLI is installed yet. Install one from the Auth section or run: myshell-tools doctor --fix\n');
    return;
  }

  const choiceLines = choices.map((c, i) => `  [${i + 1}] ${c.label}`).join('\n');
  out.write(`\nOpen raw session with:\n${choiceLines}\n\n[Enter] cancel\n> `);
  const choice = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (choice === null) return;
  // Empty input (bare Enter) = cancel. Write visible feedback so the action
  // resolves on screen instead of silently dropping back to the menu (matching
  // the out-of-range "Cancelled." branch below).
  if (choice.length === 0) {
    out.write('Cancelled.\n');
    return;
  }

  const idx = parseInt(choice, 10) - 1;
  const selected = choices[idx];
  if (selected === undefined) {
    out.write('Cancelled.\n');
    return;
  }

  const bin = selected.bin;
  out.write(`\nLaunching ${bin} — press Ctrl+C or type /exit inside ${bin} to return.\n`);

  // Best-effort escape hint (Unix only — on Windows we skip the handler).
  if (process.platform !== 'win32') {
    out.write('(Ctrl+C twice quickly → back to the myshell menu)\n');
  }

  // Hand the terminal to the native CLI so its interactive session runs in place.
  // runInteractiveChild gives the child /dev/tty as stdin in a pipe-stdin wrapper
  // shell (data-tools) so it reads real keystrokes — a no-op ('inherit') on a normal
  // terminal. stdout/stderr stay inherited; it never rejects (return to menu on any exit).
  // Suspend the menu reader so it cannot race the inherited-stdio child for keys.
  const resumeStdin = suspendStdin?.();
  try {
    const subprocess = runInteractiveChild(bin, []);

    // Unix-only: register the rapid-double-Ctrl+C escape handler.
    // On Windows: skip entirely — SIGINT/process-group semantics differ and
    // forced interception risks a broken console. Behaviour is as before today.
    if (process.platform !== 'win32') {
      const INTERRUPT_WINDOW_MS = 1_500;
      const interruptTimes: number[] = [];

      const rawSigintHandler = (): void => {
        const now = Date.now();
        interruptTimes.push(now);
        const count = countRecentInterrupts(interruptTimes, now, INTERRUPT_WINDOW_MS);

        // count === 1: do nothing — let the single Ctrl+C reach the child via the
        // terminal's foreground-group delivery. Do NOT kill or write anything here.
        if (shouldEscapeRawSession(count)) {
          // Rapid double press → user wants to return to the menu.
          out.write('\n[info] Returning to menu…\n');
          subprocess.kill('SIGTERM');
        }
      };

      process.on('SIGINT', rawSigintHandler);
      try {
        await subprocess.done;
      } finally {
        process.removeListener('SIGINT', rawSigintHandler);
      }
    } else {
      // Windows: no SIGINT handler — await the child normally.
      await subprocess.done;
    }
  } finally {
    // Resume the menu reader only after the inherited child and SIGINT handler are gone.
    resumeStdin?.();
  }

  out.write(`\nReturned from ${bin}.\n`);
}
