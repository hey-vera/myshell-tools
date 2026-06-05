/**
 * src/core/teach.ts — the one "error that teaches" formatter
 * (whole-tool-finish-5.5.md §0.2, §2).
 *
 * A single shared formatter so every NEW feature's *surfaced* failure reads the
 * same way: **what happened · what the tool did · what you can do.** The
 * GOLDEN-PLAN tenet "error messages that teach" made concrete and unified across
 * memory, intent, recap, approval, and APE.
 *
 * This module is PURE: no I/O, no time, no randomness — it returns the formatted
 * string and never writes (`test/arch/guards.ts` purity guard). It honours the
 * same `color` gate as the theme helpers, so it degrades to plain text off-TTY /
 * under NO_COLOR. Crucially `teach()` NEVER throws and NEVER renders red: red is
 * reserved for a *terminal core failure* (the turn itself failed), which is the
 * existing renderer's job. Our features failing is never red, because the answer
 * survived.
 *
 * The ANSI gating is inlined (rather than importing the `ui/theme` helpers) so
 * this stays a self-contained `src/core` leaf — exactly like `intent.ts` and
 * `engagement.ts` keep their block renderers self-contained. The escape codes
 * match `theme.ts`'s `dim`/`yellow` byte-for-byte.
 */

/** Dim (faint) ANSI wrap, gated on colour — matches theme.ts `dim`. */
function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}

/** Yellow ANSI wrap, gated on colour — matches theme.ts `yellow`. */
function yellow(text: string, color: boolean): string {
  return color ? `\x1b[33m${text}\x1b[0m` : text;
}

/** A single teach notice: the three plain-language parts plus a severity. */
export interface TeachNotice {
  /** What happened, in plain language ("Memory was busy"). */
  readonly what: string;
  /** What the tool did about it ("answered without it"). */
  readonly did: string;
  /** Optional: what the user can do next ("/memory to inspect"). */
  readonly you?: string;
  /**
   * `info` → dim (a transient capability was skipped; the answer is unaffected).
   * `warn` → yellow (a terminal-for-a-feature recovery the user should know).
   * NEVER red — see the module header.
   */
  readonly severity: 'info' | 'warn';
}

/** Leading glyph per severity. `⚠` for warn, `·` for info — never an error `✗`. */
const SEVERITY_GLYPH: Readonly<Record<TeachNotice['severity'], string>> = {
  info: '·',
  warn: '⚠',
};

/**
 * Coerce any field into a safe, trimmed single-line string. Defensive at runtime
 * so a malformed notice can never throw or inject a newline that corrupts the
 * surrounding transcript. PURE.
 */
function line(value: unknown): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else if (value === null || value === undefined) s = '';
  else {
    try {
      s = String(value);
    } catch {
      s = '';
    }
  }
  // Collapse internal whitespace/newlines so the teach line stays single-line.
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Format a {@link TeachNotice} into a single dim/yellow line, honouring the
 * `color` gate exactly like the theme helpers. The shape is:
 *
 *   `<glyph> <what> — <did>. <you?>`
 *
 * `severity:'info'` is dim, `severity:'warn'` is yellow; never red. When `you`
 * is omitted it is simply absent (renders cleanly). `color:false` strips all
 * ANSI for off-TTY / NO_COLOR parity. Returns '' only when there is genuinely
 * nothing to say (both `what` and `did` empty) so a vacuous notice prints
 * nothing. NEVER throws.
 */
export function teach(n: TeachNotice, color: boolean): string {
  const what = line(n?.what);
  const did = line(n?.did);
  if (what.length === 0 && did.length === 0) return '';

  const severity: TeachNotice['severity'] = n?.severity === 'warn' ? 'warn' : 'info';
  const glyph = SEVERITY_GLYPH[severity];

  let body = what;
  if (did.length > 0) body = body.length > 0 ? `${body} — ${did}` : did;

  const you = line(n?.you);
  const full = you.length > 0 ? `${glyph} ${body}. ${you}` : `${glyph} ${body}`;

  return severity === 'warn' ? yellow(full, color) : dim(full, color);
}
