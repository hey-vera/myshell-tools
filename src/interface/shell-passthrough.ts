import { execaCommand } from 'execa';

import type { CommandGatePort, CommandGateDecision } from '../core/command-gate.js';
import type { OutputSink } from './render.js';
import { dim } from '../ui/theme.js';

export interface ShellRunResult {
  readonly exitCode: number | null;
}

/** Injectable so tests never spawn a real shell. */
export interface ShellRunnerPort {
  run(command: string, cwd: string, out: OutputSink): Promise<ShellRunResult>;
}

type ExecaCommandRunner = typeof execaCommand;

/** Production runner: execute via the platform shell and forward output chunks. */
export function createNodeShellRunner(
  deps: { readonly execaCommand?: ExecaCommandRunner } = {},
): ShellRunnerPort {
  const runExecaCommand = deps.execaCommand ?? execaCommand;

  return {
    async run(command: string, cwd: string, out: OutputSink): Promise<ShellRunResult> {
      try {
        const child = runExecaCommand(command, {
          cwd,
          shell: true,
          reject: false,
          stdin: 'ignore',
          stripFinalNewline: false,
          all: true,
        });

        child.all?.on('data', (chunk: string | Uint8Array) => {
          out.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          out.flush?.();
        });

        const result = await child;
        if (result.exitCode === undefined) {
          const detail =
            typeof result.shortMessage === 'string' && result.shortMessage.trim().length > 0
              ? result.shortMessage.trim()
              : typeof result.message === 'string' && result.message.trim().length > 0
                ? result.message.trim()
                : 'spawn failed';
          out.write(dim(`  Shell command failed to start: ${detail}\n`, out.color));
          return { exitCode: null };
        }
        return { exitCode: result.exitCode };
      } catch {
        out.write(dim('  Shell command failed to start.\n', out.color));
        return { exitCode: null };
      }
    },
  };
}

function previousNonWhitespaceChar(command: string, start: number): string | null {
  for (let index = start; index >= 0; index -= 1) {
    const char = command[index];
    if (char !== undefined && /\S/.test(char)) return char;
  }
  return null;
}

function requestsTrailingBackground(command: string): boolean {
  const trimmedEnd = command.search(/\s*$/);
  const lastIndex = trimmedEnd > 0 ? trimmedEnd - 1 : command.length - 1;
  if (lastIndex < 0 || command[lastIndex] !== '&') return false;

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index <= lastIndex; index += 1) {
    const char = command[index];
    if (char === undefined) break;
    if (escaped) {
      if (index === lastIndex) return false;
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (char === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (index === lastIndex) {
      if (inSingle || inDouble) return false;
      return previousNonWhitespaceChar(command, lastIndex - 1) !== '&';
    }
  }

  return false;
}

/**
 * Gate + run a `!`-prefixed shell command. Denied commands print a short notice
 * and never execute.
 */
export async function runShellPassthrough(
  command: string,
  cwd: string,
  out: OutputSink,
  commandGate: CommandGatePort,
  runner: ShellRunnerPort,
): Promise<void> {
  const requestedBackground = requestsTrailingBackground(command);
  const gate = commandGate.gate(command, { requestedBackground });
  if (requestedBackground && gate.forbidBackground) {
    out.write(dim('  Background execution is not allowed for this command.\n', out.color));
    await recordGate(commandGate, cwd, command, gate, null, 'denied');
    return;
  }

  const confirmed = await confirmGate(commandGate, gate);
  if (!gate.allowed || confirmed === false) {
    out.write(dim('  Shell command not run.\n', out.color));
    await recordGate(commandGate, cwd, command, gate, confirmed, 'denied');
    return;
  }

  await runner.run(command, cwd, out);
  await recordGate(commandGate, cwd, command, gate, confirmed, 'ran');
}

async function confirmGate(
  commandGate: CommandGatePort,
  decision: CommandGateDecision,
): Promise<boolean | null> {
  if (!decision.allowed) return false;
  if (!decision.requireConfirmation) return null;
  if (commandGate.confirm === undefined) return false;
  return commandGate.confirm(decision.rationale);
}

async function recordGate(
  commandGate: CommandGatePort,
  cwd: string,
  command: string,
  decision: CommandGateDecision,
  confirmed: boolean | null,
  outcome: 'ran' | 'skipped' | 'denied',
): Promise<void> {
  if (!decision.mustRecord || commandGate.record === undefined) return;
  try {
    await commandGate.record({
      ts: new Date().toISOString(),
      command,
      commandTier: decision.commandTier,
      requireConfirmation: decision.requireConfirmation,
      forbidBackground: decision.forbidBackground,
      confirmed,
      outcome,
      cwd,
    });
  } catch {
    // Audit failures must not break fail-soft shell execution.
  }
}
