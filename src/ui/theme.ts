/**
 * src/ui/theme.ts — Centralised ANSI colour / format helpers.
 *
 * Every helper accepts a `color` boolean flag. When false the text is returned
 * unchanged, which honours NO_COLOR and non-TTY contexts. No other module in
 * the project should hardcode ANSI escape codes.
 *
 * Honesty contract: this file contains no hardcoded percentages, no fabricated
 * figures, and no mock phrases.
 */

// ---------------------------------------------------------------------------
// Primitive colour helpers
// ---------------------------------------------------------------------------

/** Dim / faint text. */
export function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}

/** Bold text. */
export function bold(text: string, color: boolean): string {
  return color ? `\x1b[1m${text}\x1b[0m` : text;
}

/** Green text (success / ok). */
export function green(text: string, color: boolean): string {
  return color ? `\x1b[32m${text}\x1b[0m` : text;
}

/** Red text (failure / error). */
export function red(text: string, color: boolean): string {
  return color ? `\x1b[31m${text}\x1b[0m` : text;
}

/** Yellow text (warning / caution). */
export function yellow(text: string, color: boolean): string {
  return color ? `\x1b[33m${text}\x1b[0m` : text;
}

/** Cyan text (informational accent). */
export function cyan(text: string, color: boolean): string {
  return color ? `\x1b[36m${text}\x1b[0m` : text;
}

// ---------------------------------------------------------------------------
// Composite helpers
// ---------------------------------------------------------------------------

/**
 * Render a labelled key in a key/value pair.
 * e.g. `label('Status', true)` → bold cyan "Status"
 */
export function label(text: string, color: boolean): string {
  return bold(cyan(text, color), color);
}

/**
 * Return a horizontal rule of the given width (default 40).
 * The divider is dim when colour is enabled.
 */
export function divider(color: boolean, width = 40): string {
  const line = '─'.repeat(width);
  return dim(line, color);
}
