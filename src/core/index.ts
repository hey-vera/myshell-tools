/**
 * src/core/index.ts — public surface of the pure orchestration core.
 */
export { orchestrate } from './orchestrate.js';
export { classify } from './classify.js';
export { route } from './route.js';
export { assess } from './assess.js';
export { buildPrompt } from './prompt.js';
export { DEFAULT_POLICY } from './policy.js';
export { nextTierUp, pickReviewer } from './escalate.js';
export { buildReviewPrompt, parseReviewVerdict } from './review.js';
export type { ReviewVerdict } from './review.js';
export type {
  Tier,
  Risk,
  Classification,
  RouteDecision,
  Assessment,
  Clock,
  SessionEntry,
  SessionWriter,
  LedgerEntry,
  LedgerWriter,
  Policy,
  OrchestrateDeps,
  CoreEvent,
} from './types.js';
