/**
 * src/core/live-model-inventory.ts — live model auto-adapt helpers.
 *
 * Product rule: when a provider CLI ships model Y, myshell users get it via
 * CLI/local detect — not a static catalog alone. This module is pure timing +
 * merge: no fs, no child_process, no network, no invented tier/effort.
 *
 * Inventory sources (merged elsewhere into ProviderStatus / CapabilityRegistry):
 *   - detect.ts availableModels (opencode models, grok models, Codex cache, Claude aliases)
 *   - Layer 2 capability refresh (detect merge + Codex models_cache + opencode verbose)
 *
 * Routing inventory = detect advertised ids ∪ registry ids from live sources
 * (detect / codex-cache), so unknown models are usable with worker-floor /
 * unknown profile in vendor-neutral routing.
 */

import type { ProviderId } from '../providers/port.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { CapabilityRegistry } from './model-capabilities.js';

/** Bounded mid-session re-detect interval. Background only — never blocks a turn hard. */
export const DEFAULT_MODEL_REDETECT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * True when a light model re-detect should run.
 * - first call (no last timestamp) → true
 * - interval elapsed → true
 * - invalid clocks → true (fail open to refresh, not invent facts)
 */
export function shouldRedetectModels(
  lastRedetectAtMs: number | undefined,
  nowMs: number,
  intervalMs: number = DEFAULT_MODEL_REDETECT_INTERVAL_MS,
): boolean {
  if (lastRedetectAtMs === undefined) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastRedetectAtMs)) return true;
  if (!(intervalMs > 0)) return true;
  return nowMs - lastRedetectAtMs >= intervalMs;
}

/**
 * Stable union of model ids. First-seen order, case-insensitive de-dupe,
 * case-preserving. Empty/blank tokens dropped. Pure.
 */
export function unionModelIds(
  ...lists: readonly (readonly string[] | undefined)[]
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (list === undefined) continue;
    for (const raw of list) {
      const id = raw.trim();
      if (id.length === 0) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
  }
  return out;
}

const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'opencode', 'grok'];

/**
 * True when a registry row is a real Layer-2 live discovery that should expand
 * routing inventory beyond detect's advertised list:
 *   - pure detect additions (source has `detect`, no `declarative`) — new CLI ids
 *   - codex-cache contributions (may list models before detect mirrors them)
 *
 * Declarative rows that merely gained a `detect` tag because an *alias* appeared
 * in availableModels must NOT re-emit their canonical id. That would invent a
 * second routing candidate for the same model and flip VN session-hash ties
 * (e.g. detect `claude-sonnet-4-6` tagging declarative `sonnet`).
 */
function isLiveDiscoverySource(source: readonly string[]): boolean {
  if (source.includes('codex-cache')) return true;
  return source.includes('detect') && !source.includes('declarative');
}

/**
 * Build routing inventory from detection + capability registry.
 *
 * Includes:
 *   - every id advertised by detect (installed providers),
 *   - registry ids that are true live Layer-2 discoveries (pure `detect` or
 *     `codex-cache`) so newly shipped models enter Auto route even when not yet
 *     mirrored into ProviderStatus.availableModels.
 *
 * Never invents tier/effort — ids only. Pure. Does not re-emit canonical ids for
 * declarative entries only tagged `detect` via alias match.
 */
export function routingInventoryFromDetectAndRegistry(
  availableFromDetect: Partial<Record<ProviderId, readonly string[]>>,
  registry: CapabilityRegistry | undefined,
): Partial<Record<ProviderId, readonly string[]>> {
  if (registry === undefined) {
    return { ...availableFromDetect };
  }
  const out: Partial<Record<ProviderId, readonly string[]>> = {};
  for (const p of PROVIDER_IDS) {
    const fromDetect = availableFromDetect[p];
    const fromRegistry = registry[p]
      .filter((c) => isLiveDiscoverySource(c.source))
      .map((c) => c.id);
    const merged = unionModelIds(fromDetect, fromRegistry);
    if (merged.length > 0) out[p] = merged;
  }
  return out;
}

/**
 * Patch EnvironmentStatus availableModels with a fresh per-provider map.
 * Pure (returns a new object); never invents auth/plan/version.
 */
export function withUpdatedAvailableModels(
  env: EnvironmentStatus,
  models: Partial<Record<ProviderId, readonly string[]>>,
): EnvironmentStatus {
  const patch = (id: ProviderId): EnvironmentStatus[typeof id] => {
    const next = models[id];
    if (next === undefined) return env[id];
    return { ...env[id], availableModels: next };
  };
  return {
    claude: patch('claude'),
    codex: patch('codex'),
    opencode: patch('opencode'),
    grok: patch('grok'),
    hasAnyProvider: env.hasAnyProvider,
    platform: env.platform,
  };
}

/**
 * Build a per-account model inventory map (R1.5 foundation).
 *
 * Pure merge helper for callers that already know account → model lists
 * (e.g. future per-account detect probe). Multiple entries for the same
 * provider+account union model ids (first-seen order, case-insensitive de-dupe).
 * Live CLI probe wiring is follow-on; this only shapes the inventory structure.
 *
 * Shape matches `AvailableModelsByAccount` in execution-lane (kept structural
 * here to avoid a module cycle with execution-lane → unionModelIds).
 */
export function buildAvailableModelsByAccount(
  entries: readonly {
    readonly provider: ProviderId;
    readonly accountId: string;
    readonly models: readonly string[];
  }[],
): Partial<Record<ProviderId, Readonly<Record<string, readonly string[]>>>> {
  const acc: Partial<
    Record<ProviderId, Record<string, readonly string[]>>
  > = {};
  for (const e of entries) {
    const accountId = e.accountId.trim();
    if (accountId.length === 0) continue;
    const prevProvider = acc[e.provider] ?? {};
    const prevList = prevProvider[accountId];
    const merged = unionModelIds(prevList, e.models);
    acc[e.provider] = { ...prevProvider, [accountId]: merged };
  }
  return acc;
}

/**
 * Provisional per-account model inventory for multi-account routing (P1 wire).
 *
 * When managed subscription accounts exist, copy the current provider-global
 * `availableModels` list onto each account key for that provider so
 * `OrchestrateDeps.availableModelsByAccount` is populated and turn-lane freeze /
 * `selectExecutionLane` see account-keyed rows.
 *
 * Honest limitation: this does **not** isolate true per-account entitlements.
 * Detect still probes ambient/home credentials once; each managed account gets
 * the same provider list until a future per-account CLI probe (accountEnv /
 * isolated homeDir) lands. Empty/missing provider lists skip that account.
 *
 * Pure. Returns `undefined` when there are no account rows to emit (no accounts,
 * or no non-empty provider model lists matching any account).
 */
export function provisionalAvailableModelsByAccount(
  availableModels: Partial<Record<ProviderId, readonly string[]>> | undefined,
  accounts: readonly {
    readonly provider: ProviderId;
    readonly id: string;
  }[],
): Partial<Record<ProviderId, Readonly<Record<string, readonly string[]>>>> | undefined {
  if (availableModels === undefined || accounts.length === 0) {
    return undefined;
  }
  const entries: {
    readonly provider: ProviderId;
    readonly accountId: string;
    readonly models: readonly string[];
  }[] = [];
  for (const account of accounts) {
    const models = availableModels[account.provider];
    if (models === undefined || models.length === 0) continue;
    const accountId = account.id.trim();
    if (accountId.length === 0) continue;
    entries.push({
      provider: account.provider,
      accountId,
      models,
    });
  }
  if (entries.length === 0) return undefined;
  return buildAvailableModelsByAccount(entries);
}
