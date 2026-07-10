/**
 * src/interface/build-orchestrate-deps.ts — shared OrchestrateDeps core assembly.
 *
 * P2.4 slice 1: extract the largest non-controversial pure subset that both
 * CLI `run` (`cli.ts` buildDeps) and menu (`menu.ts` buildDeps) already build
 * identically from detection env + shipped-on flags.
 *
 * Why this exists:
 *   menu and CLI diverged into dual products — features landed only on menu.
 *   A shared pure adapter for env → routing fields + shipped-on core flags is
 *   the safe first seam so new core routing facts do not need two copy-pastes.
 *
 * Intentionally NOT in slice 1 (follow-ups):
 *   - vendorNeutralEnabled (menu-only today; enabling on CLI changes routing)
 *   - menu-only context blocks (goals, rules, taste, governor, tribunal, …)
 *   - preflight extractors (already shared via preflight-deps.ts)
 *   - learnedProviderOrder / cooldown / native-session planning
 *   - unfinished r7 experimental flags as default-on
 *
 * Pure data transforms only — no I/O, no process.exit, no clocks.
 */

import type { EnvironmentStatus } from '../providers/detect.js';
import type { ProviderId } from '../providers/port.js';
import type { CapabilityRegistry } from '../core/model-capabilities.js';
import { classifyPlan, type PlanInfo } from '../core/policy.js';
import type { OrchestrateDeps } from '../core/types.js';

/** Provider ids known to EnvironmentStatus — single iteration order. */
const ENV_PROVIDER_IDS = ['claude', 'codex', 'opencode', 'grok'] as const satisfies readonly ProviderId[];

/**
 * Raw routing facts derived from a live EnvironmentStatus.
 * Empty collections are valid (no installed/authed providers).
 */
export interface EnvRoutingFacts {
  readonly availableModels: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders: readonly ProviderId[];
  readonly planInfos: Partial<Record<ProviderId, PlanInfo>>;
}

/**
 * Collect installed advertised models, authenticated provider ids, and
 * observed plan classifications from detection. Pure.
 *
 * Callers that apply session cooldown (menu) should start from
 * `authenticatedProviders` and filter with `availableAfterCooldown` themselves.
 */
export function collectEnvRoutingFacts(env: EnvironmentStatus): EnvRoutingFacts {
  const availableModels: Partial<Record<ProviderId, readonly string[]>> = {};
  const authenticatedProviders: ProviderId[] = [];
  const planInfos: Partial<Record<ProviderId, PlanInfo>> = {};

  for (const id of ENV_PROVIDER_IDS) {
    const status = env[id];
    if (status.installed && status.availableModels.length > 0) {
      availableModels[id] = status.availableModels;
    }
    if (status.authenticated) {
      authenticatedProviders.push(id);
      planInfos[id] = classifyPlan(status.plan);
    }
  }

  return { availableModels, authenticatedProviders, planInfos };
}

/**
 * Spread-ready routing slice for OrchestrateDeps: omit empty maps/arrays so
 * exactOptionalPropertyTypes stays happy and orchestrate OFF paths stay
 * byte-identical when nothing is installed/authed.
 */
export type EnvRoutingDepsSlice = Pick<
  OrchestrateDeps,
  'availableModels' | 'authenticatedProviders' | 'planInfos'
>;

export function buildEnvRoutingDepsSlice(
  env: EnvironmentStatus,
  options?: {
    /**
     * Override the authenticated list (e.g. after menu cooldown filtering).
     * When provided, planInfos still come from the full env authed set unless
     * `planInfos` is also overridden.
     */
    readonly authenticatedProviders?: readonly ProviderId[];
    readonly planInfos?: Partial<Record<ProviderId, PlanInfo>>;
  },
): EnvRoutingDepsSlice {
  const facts = collectEnvRoutingFacts(env);
  const authenticatedProviders = options?.authenticatedProviders ?? facts.authenticatedProviders;
  const planInfos = options?.planInfos ?? facts.planInfos;

  const slice: {
    availableModels?: Partial<Record<ProviderId, readonly string[]>>;
    authenticatedProviders?: readonly ProviderId[];
    planInfos?: Partial<Record<ProviderId, PlanInfo>>;
  } = {};

  if (Object.keys(facts.availableModels).length > 0) {
    slice.availableModels = facts.availableModels;
  }
  if (authenticatedProviders.length > 0) {
    slice.authenticatedProviders = authenticatedProviders;
  }
  if (Object.keys(planInfos).length > 0) {
    slice.planInfos = planInfos;
  }

  return slice;
}

/**
 * Shipped-on core flags both CLI and menu already set unconditionally.
 * Does NOT invent experimental/r7 flags as default-on.
 */
export type ShippedCoreOrchestrateFlags = Pick<
  OrchestrateDeps,
  | 'cacheAccountingV2'
  | 'accountAux'
  | 'evidenceReceiptV2'
  | 'blockedStateV1'
  | 'nativeSessionsPromote'
>;

export function buildShippedCoreOrchestrateFlags(): ShippedCoreOrchestrateFlags {
  return {
    cacheAccountingV2: true,
    accountAux: true,
    evidenceReceiptV2: true,
    blockedStateV1: true,
    nativeSessionsPromote: true,
  };
}

/**
 * Optional prompt / routing context fields shared by CLI and menu when present.
 * Empty strings are omitted (same as today's call sites).
 */
export interface OptionalSharedContextInput {
  readonly memoryContext?: string;
  readonly environmentContext?: string;
  readonly toolStateContext?: string;
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type OptionalSharedContextDeps = Pick<
  OrchestrateDeps,
  'memoryContext' | 'environmentContext' | 'toolStateContext' | 'capabilityRegistry' | 'sleep'
>;

export function buildOptionalSharedContextDeps(
  input: OptionalSharedContextInput,
): OptionalSharedContextDeps {
  const slice: {
    memoryContext?: string;
    environmentContext?: string;
    toolStateContext?: string;
    capabilityRegistry?: CapabilityRegistry;
    sleep?: (ms: number) => Promise<void>;
  } = {};

  if (input.memoryContext !== undefined && input.memoryContext.length > 0) {
    slice.memoryContext = input.memoryContext;
  }
  if (input.environmentContext !== undefined && input.environmentContext.length > 0) {
    slice.environmentContext = input.environmentContext;
  }
  if (input.toolStateContext !== undefined && input.toolStateContext.length > 0) {
    slice.toolStateContext = input.toolStateContext;
  }
  if (input.capabilityRegistry !== undefined) {
    slice.capabilityRegistry = input.capabilityRegistry;
  }
  if (input.sleep !== undefined) {
    slice.sleep = input.sleep;
  }

  return slice;
}

/**
 * Shared keys produced by the slice-1 pure builder for a given env.
 * Useful for tests and for callers that want to assert parity surface.
 */
export const SHARED_ORCHESTRATE_CORE_KEYS = [
  'availableModels',
  'authenticatedProviders',
  'planInfos',
  'cacheAccountingV2',
  'accountAux',
  'evidenceReceiptV2',
  'blockedStateV1',
  'nativeSessionsPromote',
  'memoryContext',
  'environmentContext',
  'toolStateContext',
  'capabilityRegistry',
  'sleep',
] as const satisfies readonly (keyof OrchestrateDeps)[];

/**
 * Assemble the shared pure core: env routing + shipped-on flags + optional
 * contexts. Does not construct ledger/session/providers/policy — those remain
 * path-owned (CLI vs menu differ on writers, cooldown, auth filter, etc.).
 */
export function buildSharedOrchestrateCore(
  env: EnvironmentStatus,
  options?: {
    readonly authenticatedProviders?: readonly ProviderId[];
    readonly planInfos?: Partial<Record<ProviderId, PlanInfo>>;
    readonly context?: OptionalSharedContextInput;
  },
): EnvRoutingDepsSlice & ShippedCoreOrchestrateFlags & OptionalSharedContextDeps {
  return {
    ...buildEnvRoutingDepsSlice(env, {
      ...(options?.authenticatedProviders !== undefined
        ? { authenticatedProviders: options.authenticatedProviders }
        : {}),
      ...(options?.planInfos !== undefined ? { planInfos: options.planInfos } : {}),
    }),
    ...buildShippedCoreOrchestrateFlags(),
    ...buildOptionalSharedContextDeps(options?.context ?? {}),
  };
}
