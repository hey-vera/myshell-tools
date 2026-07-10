/**
 * Optional terminal mouse support (P1.3).
 *
 * Fail-soft: pure parse/hit helpers never throw; enable/disable only writes
 * escape sequences when the stream looks like a TTY. Keyboard remains primary.
 *
 * Protocol: xterm SGR (1006) + VT200 click tracking (1000). Ink's useInput
 * strips the leading ESC, so parsers accept both raw CSI and post-strip forms.
 */

import type { ControlPanelSection } from './state.js';

/** Kept in lockstep with BottomLegend FULL/NARROW (avoid import cycle). */
const FULL_LEGEND =
  'Alt+\u2190 menu  \u00b7  Shift+Tab mode  \u00b7  Ctrl+G panel  \u00b7  Esc leave';
const NARROW_LEGEND = 'Alt+\u2190 menu  \u00b7  Ctrl+G panel';
const NARROW_COLUMNS = 60;

function legendTextForColumns(columns: number): string {
  return columns < NARROW_COLUMNS ? NARROW_LEGEND : FULL_LEGEND;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | 'other';
export type MouseAction = 'press' | 'release' | 'drag';

export interface TerminalMouseEvent {
  /** 0-based column. */
  readonly col: number;
  /** 0-based row. */
  readonly row: number;
  readonly button: MouseButton;
  readonly action: MouseAction;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly ctrl: boolean;
}

export type LegendClickAction = 'menu' | 'mode' | 'panel' | 'interrupt';

export interface HitZone<T extends string> {
  readonly id: T;
  /** Inclusive start column (0-based). */
  readonly start: number;
  /** Exclusive end column (0-based). */
  readonly end: number;
}

// ---------------------------------------------------------------------------
// Tracking enable / disable (impure, fail-soft)
// ---------------------------------------------------------------------------

/** Click tracking + SGR encoding (no motion spam). */
const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

export function enableMouseTracking(
  stream: { isTTY?: boolean; write?: (s: string) => unknown } | null | undefined,
): boolean {
  try {
    if (stream == null || stream.isTTY !== true || typeof stream.write !== 'function') {
      return false;
    }
    stream.write(ENABLE_MOUSE);
    return true;
  } catch {
    return false;
  }
}

export function disableMouseTracking(
  stream: { isTTY?: boolean; write?: (s: string) => unknown } | null | undefined,
): boolean {
  try {
    // Only write when the stream is a real TTY — writing CSI into ink-testing
    // / captured stdout pollutes golden frames and CI logs.
    if (stream == null || stream.isTTY !== true || typeof stream.write !== 'function') {
      return false;
    }
    stream.write(DISABLE_MOUSE);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parse (pure)
// ---------------------------------------------------------------------------

/**
 * SGR mouse: ESC [ < btn ; col ; row M|m
 * After Ink useInput strips leading ESC: [ < btn ; col ; row M|m
 * Also accept raw form with ESC still present.
 * ESC via fromCharCode so eslint no-control-regex does not flag a CSI parse.
 */
const ESC = String.fromCharCode(27);
const SGR_MOUSE_RE = new RegExp(`^${ESC}?\\[<(\\d+);(\\d+);(\\d+)([Mm])$`);

/** True when `input` looks like a terminal mouse report (SGR). */
export function isMouseInput(input: string): boolean {
  if (input.length === 0) return false;
  return SGR_MOUSE_RE.test(input);
}

/**
 * Parse a mouse report delivered via Ink useInput (or raw stdin string).
 * Returns null when the string is not a complete SGR mouse event.
 */
export function parseMouseInput(input: string): TerminalMouseEvent | null {
  if (input.length === 0) return null;
  const m = SGR_MOUSE_RE.exec(input);
  if (m === null) return null;

  const code = Number.parseInt(m[1] ?? '', 10);
  const col1 = Number.parseInt(m[2] ?? '', 10);
  const row1 = Number.parseInt(m[3] ?? '', 10);
  const suffix = m[4];
  if (!Number.isFinite(code) || !Number.isFinite(col1) || !Number.isFinite(row1)) {
    return null;
  }

  // SGR button encoding: low 2 bits = button; bit 5 (32) = motion/drag;
  // 64/65 = wheel. Release uses lowercase `m` (except wheel which is press-only).
  const shift = (code & 4) !== 0;
  const meta = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;
  const motion = (code & 32) !== 0;
  const base = code & ~0b11100; // strip modifiers (shift/meta/ctrl)

  let button: MouseButton;
  let action: MouseAction;

  if (base === 64 || base === 96) {
    button = 'wheelUp';
    action = 'press';
  } else if (base === 65 || base === 97) {
    button = 'wheelDown';
    action = 'press';
  } else {
    const btnId = base & 0b11;
    button = btnId === 0 ? 'left' : btnId === 1 ? 'middle' : btnId === 2 ? 'right' : 'other';
    if (suffix === 'm') {
      action = 'release';
    } else if (motion) {
      action = 'drag';
    } else {
      action = 'press';
    }
  }

  return {
    col: Math.max(0, col1 - 1),
    row: Math.max(0, row1 - 1),
    button,
    action,
    shift,
    meta,
    ctrl,
  };
}

/** Left-button press only — the high-value click we wire to UI actions. */
export function isPrimaryClick(ev: TerminalMouseEvent): boolean {
  return ev.button === 'left' && ev.action === 'press';
}

// ---------------------------------------------------------------------------
// Legend hit zones (pure)
// ---------------------------------------------------------------------------

const LEGEND_SEGMENT_ACTIONS: Readonly<Record<string, LegendClickAction>> = {
  'Alt+\u2190 menu': 'menu',
  'Shift+Tab mode': 'mode',
  'Ctrl+G panel': 'panel',
  'Esc leave': 'interrupt',
};

/**
 * Build column ranges for each legend segment (clustered middot form).
 * Columns are 0-based offsets within the legend line (left-aligned).
 */
export function buildLegendHitZones(columns: number): readonly HitZone<LegendClickAction>[] {
  const text = legendTextForColumns(columns);
  const zones: HitZone<LegendClickAction>[] = [];
  const parts = text.split('  \u00b7  ');
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? '';
    const action = LEGEND_SEGMENT_ACTIONS[part];
    if (action !== undefined && part.length > 0) {
      zones.push({ id: action, start: offset, end: offset + part.length });
    }
    offset += part.length;
    if (i < parts.length - 1) {
      offset += 5; // `  ·  `
    }
  }
  return zones;
}

/**
 * Hit-test a 0-based column against the chat bottom legend.
 * Returns null when the click misses every segment.
 */
export function hitTestLegend(col: number, columns: number): LegendClickAction | null {
  if (col < 0) return null;
  for (const zone of buildLegendHitZones(columns)) {
    if (col >= zone.start && col < zone.end) return zone.id;
  }
  return null;
}

/**
 * Legend sits on the last terminal row when chat is active (bottom dock).
 * `terminalRows` is 1-based height; `row` is 0-based from the mouse event.
 */
export function isLegendRow(row: number, terminalRows: number): boolean {
  if (terminalRows < 1) return false;
  return row === terminalRows - 1;
}

// ---------------------------------------------------------------------------
// Control Panel tab + footer hit zones (pure)
// ---------------------------------------------------------------------------

/** Leading indent before the first tab label (matches ControlPanel render). */
const PANEL_TABS_INDENT = 2;

const PANEL_TAB_SPECS: readonly { readonly id: ControlPanelSection; readonly label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'goals', label: 'Goals' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Tab row layout mirrors ControlPanel: leading two spaces, then
 * ` Status ` / ` Goals ` / ` Settings ` (space-padded labels).
 */
export function buildPanelTabHitZones(): readonly HitZone<ControlPanelSection>[] {
  const zones: HitZone<ControlPanelSection>[] = [];
  let offset = PANEL_TABS_INDENT;
  for (const spec of PANEL_TAB_SPECS) {
    // Rendered as ` ${label} ` (one space each side).
    const width = spec.label.length + 2;
    zones.push({ id: spec.id, start: offset, end: offset + width });
    offset += width;
  }
  return zones;
}

export function hitTestPanelTabs(col: number): ControlPanelSection | null {
  if (col < 0) return null;
  for (const zone of buildPanelTabHitZones()) {
    if (col >= zone.start && col < zone.end) return zone.id;
  }
  return null;
}

export type PanelFooterClickAction = 'close';

/**
 * Footer is one dim line. Wide/narrow share `← chat` and `Esc close` as close hits.
 */
export function buildPanelFooterHitZones(columns: number): readonly HitZone<PanelFooterClickAction>[] {
  // Importing the footer builder would create a cycle via ControlPanel → mouse;
  // duplicate the narrow threshold + strings (kept in lockstep with ControlPanel).
  const narrow = columns < 60;
  const text = narrow
    ? '\u2190 chat  \u00b7  Tab  \u00b7  Esc close'
    : '\u2190 chat  \u00b7  Tab sections  \u00b7  \u2191\u2193 select  \u00b7  Enter goal  \u00b7  Esc close';
  const zones: HitZone<PanelFooterClickAction>[] = [];
  for (const needle of ['\u2190 chat', 'Esc close'] as const) {
    const idx = text.indexOf(needle);
    if (idx >= 0) {
      zones.push({ id: 'close', start: idx, end: idx + needle.length });
    }
  }
  return zones;
}

export function hitTestPanelFooter(col: number, columns: number): PanelFooterClickAction | null {
  if (col < 0) return null;
  for (const zone of buildPanelFooterHitZones(columns)) {
    if (col >= zone.start && col < zone.end) return zone.id;
  }
  return null;
}

/**
 * Approximate which chrome row a Control Panel mouse event hit.
 *
 * When the panel fills most of the viewport (fullscreen route), chrome is at the
 * top: title (row 0), optional summary (row 1), tabs, …, footer on last row.
 * `showSummary` matches `liveRows >= 6` in ControlPanel.
 *
 * Returns null when the click is in content (not chrome we wire).
 */
export function hitTestPanelChromeRow(
  row: number,
  terminalRows: number,
  showSummary: boolean,
): 'tabs' | 'footer' | null {
  if (terminalRows < 1 || row < 0 || row >= terminalRows) return null;
  // Fullscreen panel: live region ≈ entire viewport → yoga row ≈ terminal row.
  const tabsRow = showSummary ? 2 : 1;
  if (row === tabsRow) return 'tabs';
  if (row === terminalRows - 1) return 'footer';
  // Also accept footer one row up when InputBox reserves a blank line under the panel
  // (App gives ControlPanel height liveRows-1, InputBox still mounts 1 blank row).
  if (row === terminalRows - 2) return 'footer';
  return null;
}
