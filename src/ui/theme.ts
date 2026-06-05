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

// ---------------------------------------------------------------------------
// Glyph + turn-marker vocabulary
// ---------------------------------------------------------------------------
//
// A small, fixed glyph set shared by the renderer. All glyphs are single-cell,
// width-stable, and contain NO emoji — `●` (U+25CF) is the same marker Claude
// Code uses and renders in virtually every terminal font; if a font lacks it,
// it degrades to a visible box but never corrupts layout. Colour is applied via
// the existing gated primitives, so NO_COLOR / non-TTY callers (which pass
// `color: false`) get the bare glyph with zero ANSI bytes.

/** The fixed glyph vocabulary (see docs/chat-presentation-5.5.md §3). */
export const GLYPHS = {
  /** Assistant turn marker — `●` (U+25CF BLACK CIRCLE). */
  turn: '●',
  /** User echo marker (chat history view). */
  user: '›',
  /** Success outcome. */
  success: '✓',
  /** Failure outcome. */
  fail: '✗',
  /** Cancelled outcome. */
  cancel: '■',
} as const;

/** The lifecycle/outcome states an assistant turn marker can reflect. */
export type TurnState = 'streaming' | 'success' | 'fail' | 'cancel' | 'ask';

/**
 * Is the runtime in MYSHELL_PLAIN mode? Plain mode drops the structural turn
 * marker entirely for the cleanest possible machine/pipe output. It is honoured
 * ONLY when colour is already off (NO_COLOR / non-TTY); a coloured interactive
 * terminal always keeps the marker. Reads the env each call so tests can toggle
 * it without re-importing.
 */
export function isPlainMode(): boolean {
  const v = process.env['MYSHELL_PLAIN'];
  return v !== undefined && v !== '' && v !== '0';
}

/**
 * Render the assistant turn marker `●` coloured by state, honouring the same
 * `color` gate as every other helper:
 *
 *   - streaming → cyan   (the assistant is working / answering)
 *   - success   → green
 *   - fail      → red
 *   - ask       → yellow (the turn ends asking the user a question)
 *   - cancel    → dim    (the turn was interrupted)
 *
 * When `color` is false the bare `●` is returned (NO_COLOR / non-TTY), UNLESS
 * MYSHELL_PLAIN is set, in which case the empty string is returned so the marker
 * is dropped from machine output. Because a streamed cyan dot cannot be
 * retro-recoloured, the renderer prints the streaming dot at first prose and the
 * COMPLETION line carries the final-state colour — see render.ts.
 */
export function turnMarker(state: TurnState, color: boolean): string {
  if (!color && isPlainMode()) return '';
  const glyph = GLYPHS.turn;
  switch (state) {
    case 'streaming':
      return cyan(glyph, color);
    case 'success':
      return green(glyph, color);
    case 'fail':
      return red(glyph, color);
    case 'ask':
      return yellow(glyph, color);
    case 'cancel':
      return dim(glyph, color);
  }
}
