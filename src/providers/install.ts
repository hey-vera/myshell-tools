/**
 * src/providers/install.ts — One-command provider install helper.
 *
 * Provides the install command string and an async installer that delegates to
 * `npm install -g` via execa.  The user MUST confirm before this module runs
 * anything — consent is enforced by the caller (runWelcome in menu.ts).
 *
 * Honesty Contract:
 *   - Never claims success unless `npm install -g` exited with code 0.
 *   - On failure, prints the exact manual command the user can run themselves.
 *   - Never throws — all errors are caught and reported via OutputSink.
 *   - No digit-% literals.
 */

import { execa } from 'execa';
import type { OutputSink } from '../interface/render.js';
import type { ProviderId } from './port.js';

// ---------------------------------------------------------------------------
// Package map
// ---------------------------------------------------------------------------

/** npm package name for each provider. */
const PACKAGES: Record<ProviderId, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the `npm install -g <pkg>` command string for a provider.
 *
 * Pure, I/O-free — safe to call in tests without spawning anything.
 */
export function installCommandFor(id: ProviderId): string {
  const pkg = PACKAGES[id];
  return `npm install -g ${pkg}`;
}

/**
 * Run `npm install -g <pkg>` for the given provider, streaming output to the
 * terminal via `stdio:'inherit'`.
 *
 * @param id  - The provider to install ('claude' or 'codex').
 * @param out - OutputSink for status messages (not for npm's own stdout/stderr,
 *              which flow directly to the terminal via stdio:'inherit').
 * @returns   `true` if the install exited with code 0, `false` otherwise.
 *
 * Never throws.  On failure, writes the manual command to `out` so the user
 * can run it themselves.
 */
export async function installProvider(id: ProviderId, out: OutputSink): Promise<boolean> {
  const pkg = PACKAGES[id];
  out.write(`\nInstalling ${pkg} … (this can take a minute)\n`);

  try {
    const result = await execa('npm', ['install', '-g', pkg], {
      stdio: 'inherit',
      reject: false,
    });

    if (result.exitCode === 0) {
      out.write(`✓ ${id} installed.\n`);
      return true;
    }

    out.write(`✗ install failed — run it yourself: ${installCommandFor(id)}\n`);
    return false;
  } catch {
    // Spawn failure (e.g. npm not found) — still honest, never rethrows.
    out.write(`✗ install failed — run it yourself: ${installCommandFor(id)}\n`);
    return false;
  }
}
