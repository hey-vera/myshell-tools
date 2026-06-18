/**
 * src/interface/ui/core-event.ts — PURE mapping from one CoreEvent to the
 * zero-or-more structural {@link Action}s the reducer consumes (STEP 3a).
 *
 * This isolates the event→action translation so 3b's wiring is trivial and the
 * mapping is unit-tested here. It is PURE: NO Ink, NO I/O, NO EnvelopeFilter, NO
 * Date/Math.random/fs.
 *
 * TEXT BOUNDARY: a `provider-event` of type `text` carries raw prose that may
 * contain a trailing confidence envelope. The reducer must only ever see
 * ALREADY-CLEANED prose, so this helper does NOT turn `text` deltas into
 * `stream/prose` — in 3b the impure per-tier EnvelopeFilter receives the raw
 * delta and, as it flushes clean chunks, the wiring dispatches `stream/prose`
 * with the cleaned text. Every NON-text event maps deterministically here.
 *
 * The completion-line inputs that the renderer computes impurely (the real
 * spinner elapsed seconds, and the actionable CLI-error string built from
 * cliErrorForCategory/formatErrorMessage) are NOT available to this pure helper,
 * so `final` maps to a `turn/final` action WITHOUT them; 3b enriches the action
 * with `elapsedSecs` / `actionableError` before dispatch. Everything else on the
 * final is mapped faithfully here.
 */

import type { CoreEvent } from '../../core/types.js';
import type { Action, Verbosity } from './state.js';

const MYSHELL_DEBUG = 'MYSHELL_DEBUG';

/**
 * Map a single CoreEvent to the structural actions it produces. `debug` reflects
 * whether MYSHELL_DEBUG is set (computed impurely by the caller and threaded in,
 * keeping this helper pure); it only affects the `classified` event.
 */
export function coreEventToActions(
  ev: CoreEvent,
  verbosity: Verbosity,
  debug = false,
): readonly Action[] {
  switch (ev.type) {
    case 'classified':
      return [
        {
          type: 'classified',
          tier: ev.classification.tier,
          risk: ev.classification.risk,
          rationale: ev.classification.rationale,
          verbosity,
          debug,
        },
      ];

    case 'intent':
      return [{ type: 'intent' }];

    case 'engagement':
      return [{ type: 'engagement' }];

    case 'phase':
      if (ev.phase === 'panel') {
        return [{ type: 'phase/panel', participants: ev.participants ?? [] }];
      }
      return [{ type: 'phase/synthesis', count: ev.count ?? 0 }];

    case 'tier-start':
      return [
        {
          type: 'tier-start',
          tier: ev.tier,
          provider: ev.provider,
          model: ev.model,
          attempt: ev.attempt,
          verbosity,
          // Human goal label (Phase 2) — copied through verbatim when the engine
          // supplied one (already capped/truthful); absent → the reducer falls
          // back to the bare tier id, never fabricating a title.
          ...(ev.title !== undefined ? { title: ev.title } : {}),
          // Multi-goal seam: pass the goalId through when the (future) scheduler
          // stamped one; absent → the reducer's per-tier keying is unchanged.
          ...(ev.goalId !== undefined ? { goalId: ev.goalId } : {}),
        },
      ];

    case 'provider-event': {
      const pe = ev.event;
      // text → handled by the impure EnvelopeFilter in 3b (NOT here).
      // usage / done → accounted via tier-done / final.
      if (pe.type === 'tool') {
        return [
          {
            type: 'stream/tool',
            name: pe.name,
            phase: pe.phase,
            verbosity,
            ...(ev.goalId !== undefined ? { goalId: ev.goalId } : {}),
            // Carry the real target through ONLY when the provider supplied one
            // (codex/opencode `detail`); absent for the Claude subscription
            // provider, so its live action shows the verb alone (no fabrication).
            ...(pe.detail !== undefined && pe.detail.length > 0 ? { detail: pe.detail } : {}),
          },
        ];
      }
      if (pe.type === 'reasoning') {
        return [{ type: 'stream/reasoning', text: pe.delta, verbosity }];
      }
      // 'text', 'usage', 'done', 'error' produce no structural action here. (The
      // rate-limit bookkeeping render.ts does on an 'error' event is impure
      // OutputSink-free side state owned by 3b, not a visible-state transition.)
      return [];
    }

    case 'tier-done':
      return [
        {
          type: 'stream/flush-tier',
          tier: ev.tier,
          success: ev.success,
          confidence: ev.confidence,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          durationMs: ev.durationMs,
          // The reducer decides candidate-vs-normal from phase, but render.ts keys
          // it off panelMode && synthesizing===null at dispatch time; we pass the
          // structural intent and let 3b set this from live panel state. Defaulting
          // false here keeps the pure mapping deterministic for non-panel turns;
          // 3b overrides for panel candidates.
          panelCandidate: false,
          verbosity,
          // Multi-goal seam: pass the goalId through so flush-tier settles the
          // right goal; absent → settle the lone running goal (today's behaviour).
          ...(ev.goalId !== undefined ? { goalId: ev.goalId } : {}),
        },
      ];

    case 'goal-enqueue':
      return [{ type: 'goal/enqueue', goalId: ev.id, label: ev.title, ...(ev.dependsOn ? { dependsOn: ev.dependsOn } : {}) }];

    case 'goal-phase':
      return [
        { type: 'goal/phase', goalId: ev.goalId, current: ev.current, total: ev.total },
      ];

    case 'escalate':
      return [
        { type: 'escalate', from: ev.from, to: ev.to, reason: ev.reason, verbosity },
      ];

    case 'failover':
      return [
        { type: 'failover', from: ev.from, to: ev.to, tier: ev.tier, reason: ev.reason, verbosity },
      ];

    case 'notice':
      return [{ type: 'notice', level: ev.level, message: ev.message, verbosity }];

    case 'final':
      return [
        {
          type: 'turn/final',
          success: ev.success,
          tier: ev.tier,
          attempts: ev.attempts,
          sessionId: ev.sessionId,
          verbosity,
          ...(ev.canceled !== undefined ? { canceled: ev.canceled } : {}),
          ...(ev.errorCategory !== undefined ? { errorCategory: ev.errorCategory } : {}),
          ...(ev.provider !== undefined ? { provider: ev.provider } : {}),
          ...(ev.questions !== undefined ? { hasQuestions: true } : {}),
          ...(ev.bestEffort === true ? { bestEffort: true } : {}),
        },
      ];
  }
}

/** Convenience: read MYSHELL_DEBUG from an env bag (impure caller passes
 *  process.env). Kept separate so coreEventToActions itself stays pure. */
export function isDebugEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  const v = env?.[MYSHELL_DEBUG];
  return v !== undefined && v !== '';
}
