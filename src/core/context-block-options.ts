import type { OrchestrateDeps } from './types.js';
import type { ContextBlockOptions } from './prompt-context.js';

interface SharedContextBlockOptionFlags {
  readonly includeUnderstanding?: boolean;
  readonly salvagedDraft?: string;
}

type MutableContextBlockOptions = {
  -readonly [K in keyof ContextBlockOptions]?: ContextBlockOptions[K];
};

/**
 * Build the shared per-turn context block options for prompt assembly.
 * Callers opt into the deliberate divergences that still exist today
 * (for example, panel prompts currently omit understanding).
 */
export function buildSharedContextBlockOptions(
  deps: OrchestrateDeps,
  flags: SharedContextBlockOptionFlags = {},
): ContextBlockOptions | undefined {
  const ctx: MutableContextBlockOptions = {};

  if (deps.partnerStyle !== undefined) ctx.partnerStyle = deps.partnerStyle;
  if (deps.environmentContext !== undefined) ctx.environmentContext = deps.environmentContext;
  if (deps.toolStateContext !== undefined) ctx.toolStateContext = deps.toolStateContext;
  if (deps.memoryContext !== undefined) ctx.memoryContext = deps.memoryContext;
  if (deps.tasteContext !== undefined) ctx.tasteContext = deps.tasteContext;
  if (deps.workStateContext !== undefined) ctx.workStateContext = deps.workStateContext;
  if (flags.salvagedDraft !== undefined) ctx.salvagedDraft = flags.salvagedDraft;
  if (deps.goalContext !== undefined) ctx.goalContext = deps.goalContext;
  if (deps.rulesContext !== undefined) ctx.rulesContext = deps.rulesContext;
  if (deps.visionTriageContext !== undefined) ctx.visionTriageContext = deps.visionTriageContext;
  if (flags.includeUnderstanding === true && deps.understandingContext !== undefined) {
    ctx.understandingContext = deps.understandingContext;
  }
  if (deps.investigationContext !== undefined) ctx.investigationContext = deps.investigationContext;
  if (deps.intentFrame !== undefined) ctx.intentFrame = deps.intentFrame;
  if (deps.engagementPlan !== undefined) ctx.engagementPlan = deps.engagementPlan;

  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/**
 * The exact context block shape the initial sequential executor receives.
 * This is the shape the routing estimate must mirror.
 */
export function buildInitialExecutorContextBlockOptions(
  deps: OrchestrateDeps,
  opts: { readonly salvagedDraft?: string } = {},
): ContextBlockOptions | undefined {
  return buildSharedContextBlockOptions(deps, {
    includeUnderstanding: true,
    ...(opts.salvagedDraft !== undefined ? { salvagedDraft: opts.salvagedDraft } : {}),
  });
}
