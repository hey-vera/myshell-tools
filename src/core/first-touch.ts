/**
 * src/core/first-touch.ts — the PURE "show this once, ever" decision seam
 * (whole-tool-finish-5.5.md §0.1, §1.2).
 *
 * The new chat surfaces (a memory Save/Skip approval, the intent reflection
 * line, the "Waiting on N models" panel, the ※ recap, an APE engagement
 * posture) each get ONE dim, dismissible, shown-once first-touch explainer the
 * first time the user encounters them. Tracking lives in `AppConfig.seen` (per
 * user, not per conversation) — one additive key merged over defaults by
 * `loadConfig`, so an absent `seen` means "nothing shown yet" and upgraders
 * whose config predates this key see each line exactly once (never re-onboarded
 * for surfaces they have already met if the flag is present).
 *
 * This module is PURE: no I/O, no time, no randomness (`test/arch/guards.ts`
 * purity guard). The RENDERING of a first-touch line and the best-effort
 * `saveConfig` persistence live in the interface layer, which gates on
 * {@link shouldShowFirstTouch} and persists {@link markSeen}. A failed save only
 * risks showing the line once more — it never blocks the turn (fail-soft).
 */

import type { AppConfig, FirstTouchKey } from '../infra/config.js';

/** Canonical, frozen list of every first-touch key — the menu of explainers. */
export const FIRST_TOUCH_KEYS: readonly FirstTouchKey[] = [
  'memorySave',
  'intentReflect',
  'panelWaiting',
  'recap',
  'apeEngage',
] as const;

/**
 * The dim one-liner shown the first time each surface occurs. Plain text (no
 * ANSI): the interface layer wraps the chosen line in `dim()`/`out.color` so it
 * degrades to plain text off-TTY / under NO_COLOR (never suppressed — these are
 * informational, not decorative). Kept short so a plain terminal stays calm.
 */
export const FIRST_TOUCH_LINES: Readonly<Record<FirstTouchKey, string>> = {
  memorySave:
    'I can remember this for next time. Save keeps it; Skip forgets it. Manage anytime with /memory.',
  intentReflect: '(I restate what I understood before working — correct me if I\'m off.)',
  panelWaiting:
    'Running your signed-in models in parallel and combining their answers — costs no extra on your plan.',
  recap: '※ marks a short recap of where we left off.',
  apeEngage:
    '(I chose this approach because the task warranted it — type to steer me.)',
} as const;

/**
 * Should the first-touch explainer for `key` be shown? True only when the key
 * has never been marked seen for this user. PURE; tolerant of an absent/garbage
 * `seen` map (treated as "nothing shown yet"). Mirrors the router's
 * free-fast-path discipline: a missing flag is a valid default, never an error.
 */
export function shouldShowFirstTouch(
  key: FirstTouchKey,
  seen: AppConfig['seen'],
): boolean {
  if (seen === null || seen === undefined || typeof seen !== 'object') return true;
  return seen[key] !== true;
}

/**
 * Return a NEW config with `key` marked seen. Immutable: the input config and
 * its `seen` map are never mutated, every other key is preserved, and an absent
 * `seen` is created. PURE; never throws. The caller persists the result through
 * a best-effort `saveConfig` (a failure only risks showing the line once more).
 */
export function markSeen(key: FirstTouchKey, cfg: AppConfig): AppConfig {
  const prior =
    cfg.seen !== null && cfg.seen !== undefined && typeof cfg.seen === 'object'
      ? cfg.seen
      : {};
  return { ...cfg, seen: { ...prior, [key]: true } };
}

/**
 * Has this user seen ALL first-touch surfaces already (a seasoned user, or an
 * upgrader whose config carries a full `seen` map)? Used by tests/onboarding to
 * assert "show nothing" for users past the first-touch window. PURE.
 */
export function hasSeenAll(seen: AppConfig['seen']): boolean {
  return FIRST_TOUCH_KEYS.every((k) => !shouldShowFirstTouch(k, seen));
}
