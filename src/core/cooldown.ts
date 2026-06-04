/**
 * src/core/cooldown.ts — per-conversation provider rate-limit cooldown.
 *
 * The honest multi-plan win: when several providers are signed in, a rate-limit
 * (HTTP 429 / "quota exceeded") on one is a capacity signal — route AROUND it for
 * a while and lean on the others. orchestrate() already fails over to another
 * provider WITHIN a single task; the only gap is that the next turn forgets the
 * throttle and tries the same provider first again. This module is that memory.
 *
 * Pure: no I/O, no Date/Math — the caller (the conversation layer) owns the
 * mutable Map and passes `nowMs` from the injected Clock. Tested hermetically.
 */

import type { ProviderId } from '../providers/port.js';

/**
 * How long a provider stays in cooldown after a rate-limit error, in ms.
 *
 * Five minutes: long enough to meaningfully bias a session's routing toward
 * un-throttled providers, short enough that a transient 429 doesn't sideline a
 * provider for the whole session. It only DE-PRIORITISES (and never strands the
 * user — see {@link availableAfterCooldown}); it is not a hard ban, so erring
 * slightly long is cheap.
 */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/**
 * Compute the cooldown expiry for a provider that just hit a rate limit. Pure;
 * the caller stores this in its `Map<ProviderId, number>` keyed by provider.
 */
export function cooldownExpiry(nowMs: number): number {
  return nowMs + RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Filter an authenticated-provider preference list down to those NOT currently
 * in cooldown, so route() prefers an un-throttled provider on the next turn.
 *
 * Crucially, this NEVER returns an empty list: if every authenticated provider is
 * in cooldown (e.g. the user only has one provider, and it's throttled), it
 * returns the original list unchanged — better to retry a throttled provider than
 * to strand the user with no preference at all (orchestrate still has the full
 * provider pool to fall back on). Pure; case order preserved.
 *
 * @param authed - the providers known to be signed in (the preference list).
 * @param cooldownUntil - expiry epoch ms per provider; absent/expired = available.
 * @param nowMs - current epoch ms (from the injected Clock).
 */
export function availableAfterCooldown(
  authed: readonly ProviderId[],
  cooldownUntil: ReadonlyMap<ProviderId, number>,
  nowMs: number,
): readonly ProviderId[] {
  const available = authed.filter((id) => {
    const until = cooldownUntil.get(id);
    return until === undefined || until <= nowMs;
  });
  // Never strand the user: if all are cooling down, fall back to the full list.
  return available.length > 0 ? available : authed;
}
