/**
 * src/interface/ui/nav-footer.ts — shared back/exit footer text for raw menus.
 *
 * Returns a dimmed plain string that mirrors the visual language of the Ink
 * <BottomLegend> / Control Panel chrome footers, gated on the caller's `color`
 * flag so NO_COLOR / non-TTY contexts stay ANSI-free.
 *
 * Home root uses `exit-only` (P0.11): a single dim chrome line under Choice,
 * not a second control row. Submenus use `back-and-exit` so Esc is never buried
 * inside a long action list without a visible escape path.
 */

import { dim } from '../../ui/theme.js';

export type NavFooterMode = 'back-and-exit' | 'exit-only';

export function navFooterText(mode: NavFooterMode, color = false): string {
  // Clustered middot form matches BottomLegend / ControlPanel footer language.
  const text = mode === 'back-and-exit' ? '\u2190 back  \u00b7  ESC to exit' : 'ESC to exit';
  return dim(text, color);
}
