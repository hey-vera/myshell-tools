/**
 * src/providers/hang-cap.ts — the UNIVERSAL HANG CAP at the provider port boundary.
 *
 * THE PROBLEM (precise):
 *  Each provider adapter (claude.ts / codex.ts / opencode.ts) spawns its CLI via
 *  `execa(..., { timeout: req.timeoutMs })` and drains stdout with
 *  `for await (const line of subprocess)`. execa's `timeout` SIGKILLs only the
 *  DIRECT child — but a GRANDCHILD (a tool subprocess, an MCP server, a PTY) that
 *  inherited and still holds the stdout pipe keeps the pipe open, so the `for await`
 *  iteration NEVER resolves and `await subprocess` NEVER settles. The whole call
 *  hangs forever. Because every model call (worker turn, intent/understanding pre-turn
 *  passes, route classifier, planners, ensemble, hedge, recap, …) flows through
 *  `provider.run`, one such hang freezes the entire app — the exact failure 3.77.0
 *  patched for `verifyStage` ALONE with a wall-clock `Promise.race`.
 *
 * THE FIX (generalised from the proven 3.77.0 pattern, applied at the PORT layer so
 * NO call site can forget it):
 *  1. PROCESS-TREE KILL (spawnGuarded): spawn the child `detached: true` so it leads
 *     its own process GROUP. On the wall-clock cap (or abort) we kill the WHOLE group
 *     (`process.kill(-pid, 'SIGKILL')`) — not just the direct child — so a pipe-holding
 *     grandchild can no longer keep the call alive. `forceKillAfterDelay` (execa's
 *     SIGTERM→SIGKILL escalation) is kept as the inner belt; the group-kill is the
 *     suspenders that actually reaches grandchildren.
 *  2. WALL-CLOCK RACE (withHangCap): wrap the ENTIRE `provider.run` iteration. If the
 *     hard cap elapses with no terminal (`done`/`error`) event, we kill the tree, emit
 *     the EXISTING honest `timeout` ProviderEvent (classifyError → category 'timeout',
 *     recoverable) — NEVER a fabricated `done`/text — and stop. The cap is a SAFETY
 *     CEILING strictly ABOVE the normal `req.timeoutMs` (see providerHangCapMs): a
 *     legitimate long turn that finishes via execa's own timeout path is BYTE-IDENTICAL;
 *     the cap only ever changes behaviour for a run that would otherwise hang forever.
 *
 * Each adapter routes its inner generator through `withHangCap` and spawns through
 * `spawnGuarded`. The happy path (a run that terminates) is unaffected: the race
 * resolves on the inner event, the cap timer is cleared, and the same events are
 * yielded in the same order.
 *
 * Pure-ish: the only side effects are the timer and the group `process.kill`. No new
 * dependency (execa is already present).
 */

import { execa, type Options } from 'execa';
import type { ProviderEvent } from './port.js';
import { classifyError } from './errors.js';

/**
 * Derive the hard wall-clock SAFETY CEILING from a request's normal timeout.
 *
 * The ceiling must sit STRICTLY ABOVE `req.timeoutMs` so a legitimate long turn —
 * which terminates through execa's own `timeout` path and emits the honest `timeout`
 * event in the adapter — is NEVER pre-empted by this cap (that path stays
 * byte-identical). The cap only fires when the child has BLOWN PAST its own timeout
 * and STILL not terminated, i.e. the genuine pipe-holding-grandchild hang.
 *
 * Formula: `timeoutMs + max(timeoutMs * 0.25, 30s)`, then floored at 30s so a tiny
 * (e.g. test) timeout still leaves room for the normal kill/escalation to land before
 * the cap. A non-finite/≤0 timeout falls back to a flat 30s ceiling.
 */
export function providerHangCapMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 30_000;
  const grace = Math.max(timeoutMs * 0.25, 30_000);
  return Math.max(timeoutMs + grace, 30_000);
}

/**
 * The honest terminal event emitted when the hang cap fires. Reuses the SAME
 * `classifyError('timed out', …)` → category 'timeout' (recoverable) that the
 * adapters already emit on a normal timeout, so the rest of the pipeline treats a
 * capped hang exactly like any other timeout — never a fabricated success.
 */
function hangCapTimeoutEvent(provider: string, capMs: number): ProviderEvent {
  const seconds = Math.round(capMs / 1000);
  const base = classifyError('timed out', 1); // → category 'timeout', recoverable
  return {
    type: 'error',
    error: {
      ...base,
      message: `${provider} stopped responding and was force-stopped after ${seconds}s (hung process).`,
    },
  };
}

/**
 * Spawn a provider CLI with the process-TREE-kill guard wired in.
 *
 * Returns the execa subprocess (an AsyncIterable<string> of stdout lines, awaitable
 * for the final result — exactly as the adapters already use it) plus a `killTree()`
 * that force-kills the child AND its descendants by signalling the whole process
 * GROUP. Because the child is spawned `detached: true`, on POSIX it is a group leader
 * and `process.kill(-pid, 'SIGKILL')` reaches every grandchild that inherited the
 * stdout pipe — which a plain `subprocess.kill()` (direct child only) would miss.
 *
 * The caller's existing execa options (cwd, input, cancelSignal, timeout, reject,
 * env) are passed through unchanged; we only ADD `detached` and `forceKillAfterDelay`.
 */
export function spawnGuarded<OptionsType extends Options>(
  bin: string,
  args: readonly string[],
  options: OptionsType,
): { subprocess: ReturnType<typeof execa<OptionsType>>; killTree: () => void } {
  const subprocess = execa<OptionsType>(bin, [...args], {
    ...options,
    // Lead a new process group so the whole TREE can be signalled at once.
    detached: true,
    // Belt: if SIGTERM doesn't land, escalate to SIGKILL. (execa default is 5s; we
    // set it explicitly so the intent is local and stable.)
    forceKillAfterDelay: 5_000,
  });

  let killed = false;
  const killTree = (): void => {
    if (killed) return;
    killed = true;
    const pid = subprocess.pid;
    if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
      // Windows has no POSIX process groups. Kill the captured provider root and
      // descendants with argument-array execution; never interpolate a command.
      void execa('taskkill', ['/PID', String(pid), '/T', '/F'], {
        reject: false,
        windowsHide: true,
      }).catch(() => undefined);
      return;
    }
    // Kill the whole GROUP (negative pid) so grandchildren holding the stdout pipe
    // die too. Fall back to the direct-child kill if the group signal can't be sent
    // (e.g. pid unknown, group already gone, or a platform without process groups).
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        // Group gone / unsupported — fall through to the direct kill below.
      }
    }
    try {
      subprocess.kill('SIGKILL');
    } catch {
      // Already dead — nothing to do.
    }
  };

  // Execa cancels its direct child for cancelSignal, but a Windows command wrapper
  // can leave a pipe-holding descendant alive. Route ordinary abort through the
  // same latched process-tree kill used by the hang-cap backstop.
  const abortListener = (): void => killTree();
  options.cancelSignal?.addEventListener('abort', abortListener, { once: true });
  void subprocess.then(
    () => options.cancelSignal?.removeEventListener('abort', abortListener),
    () => options.cancelSignal?.removeEventListener('abort', abortListener),
  );

  return { subprocess, killTree };
}

/**
 * Wrap a provider's inner event stream in the WALL-CLOCK HANG CAP.
 *
 * Yields the inner events unchanged until either:
 *  - the inner stream ends (happy path — byte-identical: same events, same order), or
 *  - a terminal (`done`/`error`) event is yielded (we keep yielding what the inner
 *    stream gives but the consumers stop on terminal anyway), or
 *  - `capMs` elapses with NO further inner event AND no terminal seen yet — the genuine
 *    hang. We then run `onCap()` (the tree-kill), emit the honest `timeout` event, and
 *    return. We NEVER fabricate a `done`/text.
 *
 * Implementation: drive the inner async iterator manually and race each `next()`
 * against a single shared deadline. The deadline is armed once (wall-clock from the
 * first step) so a stream that dribbles partial events but never terminates still
 * trips the cap. The cap timer is always cleared so it can't keep the event loop alive.
 *
 * On abort (`signal`) we let the inner stream's own cancellation (execa cancelSignal)
 * settle the `next()`; the cap is the backstop if that, too, hangs.
 */
export async function* withHangCap(
  inner: AsyncIterable<ProviderEvent>,
  opts: { provider: string; capMs: number; onCap: () => void },
): AsyncIterable<ProviderEvent> {
  const { provider, capMs, onCap } = opts;
  const iterator = inner[Symbol.asyncIterator]();

  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let capped = false;
  // A single wall-clock deadline shared across every step. Resolves to the cap
  // sentinel exactly once when the ceiling is hit. We hold the resolver so the
  // cleanup path can SETTLE it on the happy path (timer cleared) — leaving it
  // forever-pending would dangle a promise (harmless at runtime, but it keeps a
  // reference and trips strict pending-promise detection).
  const CAP = Symbol('hang-cap');
  let settleDeadline: (v: typeof CAP) => void = () => undefined;
  const deadline = new Promise<typeof CAP>((resolve) => {
    settleDeadline = resolve;
    capTimer = setTimeout(() => {
      capped = true;
      resolve(CAP);
    }, capMs);
    // NOTE: we deliberately do NOT `unref()` this timer. It is the SAFETY mechanism
    // that breaks a hang — if it were unref'd and the hung subprocess were (somehow)
    // the only thing keeping the loop alive, the cap could never fire. The timer is
    // always cleared the instant the run settles (see finally), so it never outlives
    // a normal turn.
  });

  // Best-effort release of the inner iterator. NOTE: we deliberately do NOT `await`
  // this. An async generator suspended at an `await` (the genuine hang — its inner
  // `for await` is blocked on a dead/hung subprocess) cannot be resumed, so awaiting
  // `iterator.return()` would itself hang — re-introducing the very deadlock we're
  // capping. We've already killed the process tree (onCap), so the abandoned iterator
  // unwinds on its own (or is GC'd) without blocking us. Fire-and-forget, swallow.
  const releaseInner = (): void => {
    try {
      const ret = iterator.return?.();
      if (ret !== undefined && typeof (ret as Promise<unknown>).then === 'function') {
        (ret as Promise<unknown>).then(
          () => undefined,
          () => undefined,
        );
      }
    } catch {
      // ignore — best effort
    }
  };

  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), deadline]);
      if (step === CAP) {
        // The hang cap fired: tear down the process tree and emit an honest timeout.
        try {
          onCap();
        } catch {
          // best-effort kill — never let teardown mask the timeout event.
        }
        releaseInner();
        yield hangCapTimeoutEvent(provider, capMs);
        return;
      }
      if (step.done === true) return;
      yield step.value;
      if (step.value.type === 'done' || step.value.type === 'error') {
        // Terminal event already surfaced by the adapter — stop racing the cap and
        // release the inner iterator (its post-terminal cleanup runs on its own).
        releaseInner();
        return;
      }
    }
  } finally {
    if (capTimer !== undefined) clearTimeout(capTimer);
    // Settle the deadline promise so it doesn't dangle forever once we're done racing
    // it (the race has already concluded, so the resolved value is inert).
    settleDeadline(CAP);
    if (capped) releaseInner();
  }
}
