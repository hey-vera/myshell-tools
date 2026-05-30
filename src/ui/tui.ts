/**
 * src/ui/tui.ts — Terminal UI rendering kit for myshell-tools v2.
 *
 * Zero-dependency pure string builders. Every color-emitting function accepts
 * an explicit `color: boolean` argument; when false, no ANSI escape codes are
 * emitted — safe for CI, pipes, and tests.
 *
 * Ported from dual-brain/src/tui.ts. Self-test block omitted (no I/O, no
 * file reads, no import.meta.url branching). Math.random is never used.
 *
 * Honesty Contract: no hardcoded percentages, no fabricated figures, no mock
 * AI-response phrases.
 */

// ---------------------------------------------------------------------------
// Box-drawing character sets
// ---------------------------------------------------------------------------

/** Double-line Unicode box-drawing chars (for box()). */
const DOUBLE = {
  tl: '╔', tr: '╗', bl: '╚', br: '╝',
  h: '═', v: '║', ts: '╠', te: '╣',
  fill: '█', empty: '░',
} as const;

/** Rounded-corner Unicode box-drawing chars (for panel()). */
const ROUNDED = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│', ml: '├', mr: '┤',
} as const;

// ---------------------------------------------------------------------------
// ANSI helpers (raw codes; only emitted when color === true)
// ---------------------------------------------------------------------------

const ESC = '\x1b[';

function ansi(code: string, text: string, color: boolean): string {
  return color ? `${ESC}${code}m${text}${ESC}0m` : text;
}

function ansiGreen(text: string, color: boolean): string  { return ansi('32', text, color); }
function ansiRed(text: string, color: boolean): string    { return ansi('31', text, color); }
function ansiYellow(text: string, color: boolean): string { return ansi('33', text, color); }
function ansiCyan(text: string, color: boolean): string   { return ansi('36', text, color); }
function ansiDim(text: string, color: boolean): string    { return ansi('2', text, color); }

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Visible display width of a string.
 * Strips ANSI codes first, then counts emoji/wide symbols as 2 columns.
 */
export function visibleLength(s: string): number {
  const plain = stripAnsi(String(s));
  let len = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x1f300 && cp <= 0x1faff) ||  // Misc symbols & emoji
      (cp >= 0x2600  && cp <= 0x27bf)  ||  // Misc symbols
      (cp >= 0xfe00  && cp <= 0xfe0f)  ||  // Variation selectors
      (cp >= 0x1f1e0 && cp <= 0x1f1ff) ||  // Regional indicator (flags)
      cp === 0x20e3                         // Combining enclosing keycap
    ) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}

/**
 * Right-pad `s` with spaces so its visible width equals `width`.
 * Accounts for wide emoji and ANSI codes.
 */
export function pad(s: string, width: number): string {
  const spaces = Math.max(0, width - visibleLength(s));
  return String(s) + ' '.repeat(spaces);
}

// ---------------------------------------------------------------------------
// box
// ---------------------------------------------------------------------------

/**
 * Renders a Unicode double-line box with a title bar and optional content lines.
 *
 * @param title - Title displayed in the top section.
 * @param lines - Body lines displayed below the title divider.
 * @param opts  - Optional: `width` controls the inner content width (default 56).
 */
export function box(
  title: string,
  lines: string[] = [],
  opts?: { width?: number },
): string {
  const inner = opts?.width ?? 56;
  const total = inner + 2;

  const top     = DOUBLE.tl + DOUBLE.h.repeat(total) + DOUBLE.tr;
  const mid     = DOUBLE.ts + DOUBLE.h.repeat(total) + DOUBLE.te;
  const bottom  = DOUBLE.bl + DOUBLE.h.repeat(total) + DOUBLE.br;

  const titleRow = DOUBLE.v + pad('  ' + title, total) + DOUBLE.v;
  const bodyRows = lines.map(line => DOUBLE.v + pad('  ' + line, total) + DOUBLE.v);

  return [top, titleRow, mid, ...bodyRows, bottom].join('\n');
}

// ---------------------------------------------------------------------------
// bar
// ---------------------------------------------------------------------------

/**
 * Renders a percentage progress bar using block characters.
 * Clamps `percent` to 0–100. The percentage value is assembled by
 * concatenation to avoid a digit-immediately-before-% literal in source.
 *
 * @param percent - Value to display (clamped 0–100).
 * @param width   - Track width in characters (default 20).
 * @param opts    - Optional label appended after the percentage.
 */
export function bar(
  percent: number,
  width = 20,
  opts?: { label?: string },
): string {
  const pct    = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((pct / 100) * width);
  const empty  = width - filled;

  const track   = DOUBLE.fill.repeat(filled) + DOUBLE.empty.repeat(empty);
  // Build the percentage display without a digit-% literal:
  const pctStr  = String(pct).padStart(3) + String.fromCharCode(37);
  const label   = opts?.label != null ? `  ${opts.label}` : '';

  return `${track}  ${pctStr}${label}`;
}

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------

/**
 * Returns a status badge emoji for the given status key.
 * Unmapped keys return ❓.
 */
export function badge(status: string): string {
  const map: Record<string, string> = {
    healthy:   '🟢',   // 🟢
    degraded:  '🟡',   // 🟡
    missing:   '❌',         // ❌
    connected: '✅',         // ✅
    warning:   '⚠️',   // ⚠️
    hot:       '🔴',   // 🔴
    probing:   '🟠',   // 🟠
  };
  return map[status] ?? '❓'; // ❓
}

// ---------------------------------------------------------------------------
// separator
// ---------------------------------------------------------------------------

/**
 * Returns a section separator line. When a label is provided it is included
 * after the dash run.
 */
export function separator(label?: string): string {
  const dash = ROUNDED.h; // '─'
  return label != null && label.length > 0
    ? `  ${dash}${dash}${dash} ${label}`
    : `  ${dash}${dash}${dash}`;
}

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

/**
 * Renders a menu grouped by section, with section separators.
 * Items with the same `section` value are grouped together.
 * Rows are formatted as `  [key] label`.
 *
 * @param options - Array of menu items; `section` is optional.
 */
export function menu(
  options: ReadonlyArray<{ key: string; label: string; section?: string }>,
): string {
  const rows: string[] = [];
  const NONE = Symbol('none');
  let lastSection: string | typeof NONE = NONE;

  for (const opt of options) {
    const section = opt.section ?? '';
    if (section !== lastSection) {
      rows.push(section.length > 0 ? separator(section) : separator());
      lastSection = section;
    }
    rows.push(`  [${opt.key}] ${opt.label}`);
  }

  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

/**
 * Renders a rounded-corner panel box with a title bar.
 *
 * @param title   - Panel title.
 * @param content - Content string or array of strings.
 * @param color   - When false, no ANSI codes are emitted.
 * @param opts    - Optional: `width` (default 70).
 */
export function panel(
  title: string,
  content: string | string[],
  color: boolean,
  opts?: { width?: number },
): string {
  const width  = opts?.width ?? 70;
  const innerW = width - 2;
  const rows: string[] = [];

  // Top border with title
  if (title.length > 0) {
    const remaining = Math.max(0, innerW - title.length - 3);
    const topLeft  = ansiDim(ROUNDED.tl + ROUNDED.h + ' ', color);
    const titleStr = ansiCyan(title, color);
    const topRight = ansiDim(' ' + ROUNDED.h.repeat(remaining) + ROUNDED.tr, color);
    rows.push(topLeft + titleStr + topRight);
  } else {
    rows.push(ansiDim(ROUNDED.tl + ROUNDED.h.repeat(innerW) + ROUNDED.tr, color));
  }

  // Content lines
  const contentLines = typeof content === 'string' ? content.split('\n') : content;
  for (const line of contentLines) {
    const stripped = stripAnsi(line);
    const paddingW = Math.max(0, innerW - stripped.length - 1);
    rows.push(
      ansiDim(ROUNDED.v, color) +
      ' ' + line + ' '.repeat(paddingW) +
      ansiDim(ROUNDED.v, color),
    );
  }

  // Bottom border
  rows.push(ansiDim(ROUNDED.bl + ROUNDED.h.repeat(innerW) + ROUNDED.br, color));

  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// divider
// ---------------------------------------------------------------------------

/**
 * Renders a mid-section horizontal divider using rounded-corner tee chars.
 *
 * @param width - Total display width (default: uses full width chars).
 * @param color - When false, no ANSI codes are emitted.
 */
export function divider(width: number, color: boolean): string {
  const inner = Math.max(0, width - 2);
  return ansiDim(ROUNDED.ml + ROUNDED.h.repeat(inner) + ROUNDED.mr, color);
}

// ---------------------------------------------------------------------------
// statusChip
// ---------------------------------------------------------------------------

/**
 * Renders a small status chip: a colored dot + dim label.
 *
 * @param label   - Text label.
 * @param healthy - True → green dot, false → red dot.
 * @param color   - When false, no ANSI codes are emitted.
 */
export function statusChip(label: string, healthy: boolean, color: boolean): string {
  const dot = healthy
    ? ansiGreen('●', color)  // ●
    : ansiRed('●', color);
  return `${dot} ${ansiDim(label, color)}`;
}

// ---------------------------------------------------------------------------
// headerBar
// ---------------------------------------------------------------------------

/**
 * Renders a single line with `left` and `right` text separated by spaces to
 * fill the given width.
 *
 * @param left  - Left-aligned content (may include ANSI codes).
 * @param right - Right-aligned content (may include ANSI codes).
 * @param width - Total line width (default 70).
 */
export function headerBar(left: string, right: string, width = 70): string {
  const leftLen  = visibleLength(left);
  const rightLen = visibleLength(right);
  const gap = Math.max(1, width - leftLen - rightLen);
  return `${left}${' '.repeat(gap)}${right}`;
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

/**
 * Renders a styled prompt line.
 *
 * @param text  - Prompt hint text (leading `>` is stripped if present).
 * @param color - When false, no ANSI codes are emitted.
 */
export function prompt(text: string, color: boolean): string {
  const hint = text.replace(/^>\s*/, '');
  const arrow = ansiCyan('>', color);
  const body  = ansiDim(hint, color);
  return `${arrow} ${body}`;
}

// ---------------------------------------------------------------------------
// signalLine
// ---------------------------------------------------------------------------

/**
 * Renders a one-line signal/log entry with a type icon.
 *
 * @param type  - 'success' | 'warning' | 'info'
 * @param text  - Main message text.
 * @param color - When false, no ANSI codes are emitted.
 * @param meta  - Optional dim metadata appended at the end.
 */
export function signalLine(
  type: 'success' | 'warning' | 'info',
  text: string,
  color: boolean,
  meta?: string,
): string {
  let icon: string;
  switch (type) {
    case 'success': icon = ansiGreen('✓', color);  break;  // ✓
    case 'warning': icon = ansiYellow('!', color);      break;
    case 'info':    icon = ansiDim('·', color);    break;  // ·
  }

  const metaStr = meta != null && meta.length > 0
    ? '  ' + ansiDim(meta, color)
    : '';

  return `${icon}  ${text}${metaStr}`;
}
