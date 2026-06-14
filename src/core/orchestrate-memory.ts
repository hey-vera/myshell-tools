/**
 * Memory-proposal helpers extracted from orchestrate.ts (behavior-preserving).
 * Parse a model-proposed `remember_user` block from a successful turn and, on the
 * delegated panel/hedge paths, attach the surviving proposal to the final event —
 * keeping parity with the sequential path. Pure / pass-through; never throws.
 */

import type { CoreEvent } from './types.js';
import {
  parseRememberUser,
  worthGate,
  type Candidate,
  type RememberProposal,
} from './user-memory.js';

/**
 * Parse a model-proposed `remember_user` block from a NORMAL successful turn's
 * final text and keep ONLY the facts that pass `worthGate` as
 * `agent_inferred / model_proposed` candidates (so a secret / noise / instruction
 * never even surfaces as a proposal — memory doc §8(b)). Returns a
 * `RememberProposal` of the surviving facts, or `undefined` when there is no
 * block or none survive the gate. Pure; never throws.
 *
 * Attached to the final ONLY on the normal (non-question) success path so it can
 * never ride alongside `questions` (the two are mutually exclusive). The
 * interface renders the Save/Skip/Edit selector for it via the post-turn slot.
 */
export function memoryProposalFor(finalText: string | undefined): RememberProposal | undefined {
  const proposal = parseRememberUser(finalText ?? '');
  if (proposal === null) return undefined;
  const kept = proposal.facts.filter((f) => {
    const candidate: Candidate = {
      scope: f.scope,
      projectKey: null,
      shape: f.kind === 'correction' ? 'collection' : 'profile',
      kind: f.kind,
      subjectHint: f.text,
      text: f.text,
      reason: f.reason,
      trust: 'agent_inferred',
      source: 'model_proposed',
    };
    return worthGate(candidate).ok;
  });
  if (kept.length === 0) return undefined;
  return { facts: kept };
}

/**
 * Wrap a delegated panel/hedge event stream and attach a model-proposed memory
 * block to its successful final — parity with the sequential path (closes the
 * Phase-9 implementation re-gate's F1 gap, where panel/hedge injected memory but
 * never proposed it). Attaches ONLY to a normal success final that carries
 * neither questions nor an existing proposal, preserving the questions ⊻ memory
 * mutual-exclusivity invariant. Pure pass-through for every other event.
 */
export async function* withMemoryProposalAttached<T = void>(
  source: AsyncGenerator<CoreEvent, T>,
): AsyncGenerator<CoreEvent, T> {
  while (true) {
    const next = await source.next();
    if (next.done) return next.value;
    const ev = next.value;
    if (
      ev.type === 'final' &&
      ev.success === true &&
      ev.questions === undefined &&
      ev.memoryProposal === undefined
    ) {
      const memoryProposal = memoryProposalFor(ev.output);
      yield memoryProposal !== undefined ? { ...ev, memoryProposal } : ev;
    } else {
      yield ev;
    }
  }
}
