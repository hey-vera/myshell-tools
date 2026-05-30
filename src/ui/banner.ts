/**
 * src/ui/banner.ts — Compact product banner for myshell-tools-sh.
 *
 * Renders a tasteful multi-line banner showing the product name, real version,
 * and a one-line tagline. The version is always supplied by the caller (no
 * hardcoded value). No fake stats, no fabricated figures.
 *
 * Honesty Contract: this file contains no hardcoded percentages, no fabricated
 * figures, and no mock phrases.
 */

import { bold, cyan, dim } from './theme.js';

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/**
 * Build a compact product banner string.
 *
 * @param version - The real semver string for this release (e.g. '1.2.3').
 * @param color   - When false, no ANSI escape codes are emitted.
 * @returns A multi-line banner string (does not end with a newline beyond the
 *          last line so the caller controls spacing).
 */
export function banner(version: string, color: boolean): string {
  const name = bold(cyan('myshell-tools', color), color);
  const ver  = dim(`v${version}`, color);
  const tag  = dim('AI task orchestrator — honest, tier-aware, streaming', color);

  return [
    `${name} ${ver}`,
    tag,
  ].join('\n');
}
