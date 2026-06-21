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

/** Dim / faint text. On light terminal backgrounds, skips ANSI faint (SGR 2) which
 *  is near-invisible on white — plain text is returned instead. */
export function dim(text: string, color: boolean): string {
  if (!color) return text;
  if (isLightTheme()) return text;
  return `\x1b[2m${text}\x1b[0m`;
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

/** Blue text (structural accent / composer rail). */
export function blue(text: string, color: boolean): string {
  return color ? `\x1b[34m${text}\x1b[0m` : text;
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
  /**
   * Orientation marker — `※` (U+203B REFERENCE MARK). Reserved EXCLUSIVELY for
   * the conversation recap ("before we continue, here's where we were"), distinct
   * from the `●` turn marker and the `⋮` notice (docs/recap-feature-5.5.md §5.3).
   * Single-cell, width-stable, renders widely.
   */
  recap: '※',
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
 * Is the terminal configured for a light background? When true, ANSI faint
 * (SGR 2) is skipped — it renders as near-invisible text on white/light
 * terminals. Set via MYSHELL_THEME=light (written from config at startup).
 * Reads the env each call so tests can toggle without re-importing.
 */
function isLightTheme(): boolean {
  return process.env['MYSHELL_THEME'] === 'light';
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

// ---------------------------------------------------------------------------
// Panel status line ("Waiting on N models") — Phase 8
// ---------------------------------------------------------------------------

/** One panelist's run state for the compact per-model strip. */
export type PanelistState = 'running' | 'done';

/**
 * Build the body of the multi-agent panel status line (WITHOUT the leading
 * spinner frame / `●` marker / trailing `· Ns` elapsed, which the renderer +
 * spinner add). PURE so it is unit-testable without animation timing.
 *
 * Two shapes, driven entirely by REAL panel state derived from the up-front
 * candidate `tier-start`s and their `tier-done`s:
 *
 *  - candidates running →
 *      `Waiting on 2 models · claude ✓ · codex …`
 *    where N = the count still `running`, pluralised, and the compact strip
 *    shows each panelist with `✓` (done, green) or `…` (running, dim), in the
 *    order the panel announced them.
 *  - synthesizing (all candidates done, the synthesizer is adjudicating) →
 *      `Synthesizing 2 answers…`
 *    where N = the number of successful candidate answers being synthesized.
 *
 * `color` gates every ANSI sequence exactly like the other helpers, so a
 * NO_COLOR / non-TTY caller (`color:false`) gets a clean, ANSI-free string.
 */
export function panelLabel(
  panelists: ReadonlyArray<{ readonly provider: string; readonly state: PanelistState }>,
  synthesizing: { readonly count: number } | null,
  color: boolean,
): string {
  if (synthesizing !== null) {
    const n = synthesizing.count;
    const noun = n === 1 ? 'answer' : 'answers';
    return `Synthesizing ${n} ${noun}…`;
  }
  const running = panelists.filter((p) => p.state === 'running').length;
  const noun = running === 1 ? 'model' : 'models';
  const head = `Waiting on ${running} ${noun}`;
  if (panelists.length === 0) return head;
  const strip = panelists
    .map((p) => {
      if (p.state === 'done') return `${p.provider} ${green(GLYPHS.success, color)}`;
      return `${p.provider} ${dim('…', color)}`;
    })
    .join(dim(' · ', color));
  return `${head}${dim(' · ', color)}${strip}`;
}

// ---------------------------------------------------------------------------
// Lightweight inline markdown — Phase 8 (conservative, stream-safe)
// ---------------------------------------------------------------------------

/**
 * Apply LIGHTWEIGHT, INLINE-ONLY markdown styling to a finished line of model
 * prose (docs/chat-presentation-5.5.md §5, Q1: inline-only — bold, inline code,
 * headings, bullets; NO fenced syntax highlighting). PURE.
 *
 * Conservative on purpose so it never corrupts a streamed transcript:
 *  - It is the IDENTITY function when `color` is false (NO_COLOR / non-TTY /
 *    MYSHELL_PLAIN-style pipes), so raw markdown characters are preserved for
 *    machine consumers — exactly what a pipe wants.
 *  - It styles only COMPLETE, paired inline spans on the given text: `**bold**`
 *    / `__bold__` → bold, `` `code` `` → a subtle inverse. A lone unmatched
 *    marker (e.g. a `**` whose closer hasn't streamed yet, or a single backtick)
 *    is left verbatim, so a token split across deltas can never produce a stray
 *    escape or eat following text. The renderer applies this per-flush, so each
 *    call sees only already-flushed bytes.
 *  - Line-leading structure is styled only when this text STARTS a line (the
 *    caller passes `atLineStart`): a `#`/`##`/`###` heading → bold (markers
 *    kept), and a `- `/`* ` bullet marker → a `•` bullet. Mid-line `#`/`-`/`*`
 *    are untouched so prose like "C# is great" or "5 - 3" is never mangled.
 *
 * It deliberately does NOT touch fenced code blocks, links, tables, or reflow —
 * those need Glamour-class machinery and would fight the streaming model.
 */
export function styleInlineMarkdown(
  text: string,
  color: boolean,
  atLineStart = true,
): string {
  if (!color || text.length === 0) return text;

  // Process line by line so heading/bullet structure is per-line and a styled
  // span never spans a newline. The first line inherits `atLineStart`; every
  // subsequent line begins a fresh line by construction.
  const lines = text.split('\n');
  const styled = lines.map((line, i) => {
    const lineStart = i === 0 ? atLineStart : true;
    return styleInlineSpans(styleLineStructure(line, lineStart, color), color);
  });
  return styled.join('\n');
}

/** Heading / bullet structure for a single line (only when it begins a line). */
function styleLineStructure(line: string, atLineStart: boolean, color: boolean): string {
  if (!atLineStart) return line;
  // ATX heading: `#`, `##`, `###` then a space then text → embolden the line,
  // keeping the `#` markers (we do not reflow or strip).
  const heading = line.match(/^(\s*)(#{1,3})(\s+)(.*)$/);
  if (heading) {
    const [, lead, hashes, gap, body] = heading;
    return `${lead ?? ''}${bold(`${hashes ?? ''}${gap ?? ''}${body ?? ''}`, color)}`;
  }
  // Bullet: `- ` or `* ` at line start → a `•` bullet marker.
  const bullet = line.match(/^(\s*)[-*](\s+)(.*)$/);
  if (bullet) {
    const [, lead, gap, body] = bullet;
    return `${lead ?? ''}•${gap ?? ''}${body ?? ''}`;
  }
  return line;
}

/** Paired inline spans (bold, inline code) within a single line. */
function styleInlineSpans(line: string, color: boolean): string {
  // Inline code first (so a backtick span isn't re-scanned for bold markers).
  // Only COMPLETE `` `…` `` pairs (non-greedy, no embedded backtick) are styled;
  // a lone backtick is left verbatim.
  let out = line.replace(/`([^`\n]+)`/g, (_m, code: string) => inverse(code, color));
  // Bold: **…** or __…__ — complete pairs only, non-greedy, no embedded marker.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, b: string) => bold(b, color));
  out = out.replace(/__([^_\n]+)__/g, (_m, b: string) => bold(b, color));
  return out;
}

/** Subtle inverse for inline code, gated on colour. */
function inverse(text: string, color: boolean): string {
  return color ? `\x1b[7m${text}\x1b[0m` : text;
}

/**
 * Render the conversation recap orientation line — `※ recap  <text>` — honouring
 * the same `color` gate as every other helper. The `※` glyph is dim-cyan
 * (orientation), the word `recap` dim, the body in normal weight. When `color` is
 * false the bare `※ recap  <text>` is returned (NO_COLOR / non-TTY), UNLESS
 * MYSHELL_PLAIN is set, in which case the glyph is dropped and a plain
 * `recap  <text>` is returned for the cleanest machine output. Returns '' for an
 * empty/whitespace-only body so a vacuous recap prints nothing. Mirrors
 * `turnMarker`'s gating discipline (docs/recap-feature-5.5.md §5.3).
 */
export function formatRecapLine(text: string, color: boolean): string {
  const body = text.trim();
  if (body.length === 0) return '';
  const plain = !color && isPlainMode();
  const glyph = plain ? '' : `${dim(cyan(GLYPHS.recap, color), color)} `;
  return `${glyph}${dim('recap', color)}  ${body}`;
}
