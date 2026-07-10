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
 * Build routing inventory from detection + capability registry.
 *
 * Includes:
 *   - every id advertised by detect (installed providers),
 *   - every registry id whose `source` includes a live contributor (`detect` or
 *     `codex-cache`) so Layer 2 discoveries enter Auto route even when not yet
 *     mirrored into ProviderStatus.availableModels.
 *
 * Never invents tier/effort — ids only. Pure.
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
      .filter((c) => c.source.includes('detect') || c.source.includes('codex-cache'))
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
