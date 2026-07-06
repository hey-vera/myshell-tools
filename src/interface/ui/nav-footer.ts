/**
 * src/interface/ui/nav-footer.ts — shared back/exit footer text for raw menus.
 *
 * Returns a dimmed plain string that mirrors the visual language of the Ink
 * <BottomLegend> component, gated on the caller's `color` flag so NO_COLOR /
 * non-TTY contexts stay ANSI-free.
 */

import { dim } from '../../ui/theme.js';

export type NavFooterMode = 'back-and-exit' | 'exit-only';

export function navFooterText(mode: NavFooterMode, color = false): string {
  const text = mode === 'back-and-exit' ? '← back · ESC to exit' : 'ESC to exit';
  return dim(text, color);
}
