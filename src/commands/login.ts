/**
 * src/commands/login.ts — `myshell-tools login [claude|codex]`.
 *
 * Frictionless authentication: rather than make the user remember each vendor's
 * CLI auth command, we delegate to the provider's OWN OAuth flow and inherit the
 * terminal so the browser/device sign-in works in place.
 *
 * Security: myshell-tools never sees, handles, or stores raw credentials. Each
 * CLI manages its own tokens; we only trigger its login. (This is what keeps the
 * "use your subscription, no API keys" model honest.)
 */

import { execa } from 'execa';
import type { OutputSink } from '../interface/render.js';
import type { ProviderId } from '../providers/port.js';
import { detectProvider, getInstallCommand } from '../providers/detect.js';
import { bold, dim, green, red } from '../ui/theme.js';

/** Each provider's interactive sign-in command. */
const LOGIN_COMMAND: Record<ProviderId, { readonly bin: string; readonly args: readonly string[] }> = {
  claude: { bin: 'claude', args: ['auth', 'login'] },
  codex: { bin: 'codex', args: ['login'] },
};

export function isProviderId(value: string): value is ProviderId {
  return value === 'claude' || value === 'codex';
}

/**
 * Run the interactive sign-in flow for one provider (or all installed providers
 * when no argument is given). Returns 0 on success, 1 only for an invalid
 * argument — individual sign-in failures are reported but do not fail the command.
 */
export async function runLogin(out: OutputSink, providerArg?: string): Promise<number> {
  let targets: ProviderId[];
  if (providerArg !== undefined) {
    if (!isProviderId(providerArg)) {
      out.write(red(`Unknown provider "${providerArg}". Use: claude or codex.\n`, out.color));
      return 1;
    }
    targets = [providerArg];
  } else {
    targets = ['claude', 'codex'];
  }

  for (const id of targets) {
    const status = await detectProvider(id);
    if (!status.installed) {
      out.write(
        dim(`${id}: not installed — skipping. Install with: ${getInstallCommand(id)}\n`, out.color),
      );
      continue;
    }

    out.write(bold(`\nSigning in to ${id} — a browser window may open…\n`, out.color));
    const { bin, args } = LOGIN_COMMAND[id];
    // stdio:'inherit' hands the terminal to the provider CLI so its OAuth/device
    // flow runs in place. reject:false so we report rather than throw.
    const result = await execa(bin, [...args], { stdio: 'inherit', reject: false });

    if (result.exitCode === 0) {
      out.write(green(`✓ ${id} sign-in complete.\n`, out.color));
    } else {
      out.write(
        red(`✗ ${id} sign-in did not complete (exit ${result.exitCode ?? 'unknown'}).\n`, out.color),
      );
    }
  }

  return 0;
}
