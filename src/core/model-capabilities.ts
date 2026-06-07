/**
 * src/core/model-capabilities.ts — Model/Provider Capability Registry, Layer 1
 * (objective declarative capabilities). See docs/model-capability-registry-5.6.md
 * §2 Layer 1 and §8 Stage 1.
 *
 * This is the pure, provider-agnostic FACT layer the chat partner reads from to
 * answer "what models and reasoning efforts can you see for my setup?" honestly.
 * It is reference data + types only: NO fs, NO child_process, NO Date, NO provider
 * adapters, NO network, NO model call, NO embeddings. It imports `ProviderId` /
 * `Tier` as TYPES only (zero runtime coupling).
 *
 * THE ONE INVARIANT (§2): unknown is ABSENT. No capability is guessed from a brand,
 * marketing name, or reputation. A missing field means "we do not know" — never
 * "false unless convenient". The declarative defaults below are deliberately sparse:
 * only the few objective facts that are stable and verifiable (tier hint, native
 * session support, model id/aliases). Reasoning efforts, context windows, vision,
 * and tool support are LEFT ABSENT here and only ever filled by Layer 2's merge of
 * machine-readable local sources (detect.ts availableModels + Codex models_cache.json).
 *
 * Provider-agnostic on purpose: adding Gemini later is a clean drop-in (extend
 * ProviderId, add a `gemini` key, add a refresh parser) — but NO Gemini data is
 * added here in Stage 1.
 */

import type { ProviderId } from '../providers/port.js';
import type { Tier } from './types.js';

// ---------------------------------------------------------------------------
// Enums — every value is a known, closed set (the guard "every enum is known").
// ---------------------------------------------------------------------------

/** Where a capability fact came from. `source` accumulates all contributors. */
export type CapabilitySource = 'declarative' | 'detect' | 'codex-cache' | 'ledger';

/** Reasoning-effort knob values, ordered from cheapest to deepest. `max` is the
 * deepest level (Claude CLI's `--effort max`); deeper than `xhigh`. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Coarse cost/speed bucket; `unknown` is a first-class value, never guessed. */
type CostSpeedTier = 'fast' | 'standard' | 'premium' | 'unknown';

/** Closed set of input modalities a model accepts. */
export type InputModality = 'text' | 'image' | 'audio' | 'video';

/**
 * The known, ordered reasoning efforts (excluding `none`), used to validate
 * dynamic-source effort strings and to step efforts up/down later. PURE constant.
 */
export const KNOWN_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/** True when `s` is a recognized reasoning-effort string. Unknown strings are dropped. */
export function isReasoningEffort(s: string): s is ReasoningEffort {
  return (KNOWN_REASONING_EFFORTS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Core shape (§2 Layer 1) — objective fields only; optional = "unknown".
// ---------------------------------------------------------------------------

/**
 * One model's objective, provider-agnostic capability record. Every field beyond
 * the four required ones (provider/id/aliases/supportedReasoningEfforts/source) is
 * OPTIONAL on purpose: absent = unknown, never a guessed default. Booleans are only
 * ever set `true` from a real source; they are left `undefined` (not `false`) when
 * unknown so the renderer can distinguish "known no" from "don't know".
 */
export interface ModelCapability {
  readonly provider: ProviderId;
  /** Canonical model id / alias (e.g. 'opus', 'gpt-5.5', 'github-copilot/gpt-4o'). */
  readonly id: string;
  /** Other names this model answers to (for matching dynamic ids to declarative). */
  readonly aliases: readonly string[];
  readonly displayName?: string;
  /** Conservative tier hint; NEVER invented for unknown dynamic models. */
  readonly tierHint?: Tier;
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxOutputTokens?: number;
  /** Known reasoning efforts. Empty `[]` = "no machine-readable effort metadata". */
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly supportsExtendedThinking?: boolean;
  readonly supportsVision?: boolean;
  readonly inputModalities?: readonly InputModality[];
  readonly supportsToolCalling?: boolean;
  readonly supportsSearchTool?: boolean;
  readonly supportsParallelToolCalls?: boolean;
  readonly supportsNativeSession?: boolean;
  readonly costSpeedTier?: CostSpeedTier;
  // --- Provider-native feature inventory (Stage 5, §6 + §8). NON-ROUTABLE. -----
  // These describe what the PROVIDER's CLI supports natively (e.g. Claude Code's
  // Skills + sub-agents). They are FACTS for honest self-awareness disclosure ONLY:
  // myshell-tools does NOT invoke them and they NEVER enter route()/scoreModel/
  // selectReasoningEffort or any selection (see §6 verdict: "non-routable facts").
  // Set `true` ONLY from a real local source or a well-grounded declarative fact
  // (with providerFeatureSource naming the basis); unknown = ABSENT, never `false`,
  // never guessed from a brand.
  /** Provider CLI natively supports Skills (filesystem instruction packs). NON-ROUTABLE. */
  readonly supportsProviderSkills?: boolean;
  /** Provider CLI natively supports sub-agents (delegated agents). NON-ROUTABLE. */
  readonly supportsProviderSubagents?: boolean;
  /** Where the provider-feature facts came from (e.g. 'claude-code-docs', a local dir). */
  readonly providerFeatureSource?: string;
  /** All contributing sources, in merge order. Always at least one entry. */
  readonly source: readonly CapabilitySource[];
  /** ISO timestamp of the dynamic data that set this; set ONLY for dynamic facts. */
  readonly lastRefreshedAt?: string;
}

/** Provider-keyed registry. Keyed by ProviderId so new providers drop in cleanly. */
export type CapabilityRegistry = Readonly<Record<ProviderId, readonly ModelCapability[]>>;

/**
 * Coarse, deterministic task category used by capability-fit ranking (Stage 2)
 * and, later, by the model-level outcome ledger (Stage 4, §2 Layer 3). Defined
 * here in the pure registry module so both consumers reuse ONE shape rather than
 * duplicating it. `'unknown'` is a first-class value — never guessed.
 */
export type TaskKind =
  | 'trivial'
  | 'implementation'
  | 'debug'
  | 'review'
  | 'architecture'
  | 'large-context'
  | 'unknown';

/**
 * A single (provider, model) preference produced by a learned outcome aggregator
 * (Stage 4). Stage 2 accepts an ordered list of these in the capability context
 * but only consumes it minimally (it never expands the bounded candidate set).
 */
export interface ModelPreference {
  readonly provider: ProviderId;
  readonly model: string;
}

// ---------------------------------------------------------------------------
// Declarative defaults (§2 Layer 1) — deliberately SPARSE. Facts only.
// ---------------------------------------------------------------------------

/**
 * The conservative built-in capability defaults. These are the floor: dynamic
 * refresh (Layer 2) ADDS to them but never deletes them when a source is missing.
 *
 * Declared (stable, objective):
 *  - reasoning efforts for Claude: the Claude Code CLI exposes a verifiable
 *    `--effort <low|medium|high|xhigh|max>` flag (`claude --help`), so the five
 *    levels it accepts are an honest declarative fact, NOT a guess.
 *
 * Deliberately NOT declared here (left absent = unknown):
 *  - reasoning efforts for Codex: empty here. Codex efforts come ONLY from the
 *    local models_cache.json (the CLI's own machine-readable source).
 *  - context windows / vision / tool support: only ever set from a dynamic source.
 *
 * Declared (stable, objective):
 *  - id + aliases (the matching key for dynamic ids).
 *  - conservative tierHint (matches detect.ts's current static tiering).
 *  - supportsNativeSession: true — Claude and Codex both support `--resume`/native
 *    continuity, which myshell already relies on in detect/native-session.
 *  - supportsProviderSkills / supportsProviderSubagents: true for Claude only
 *    (providerFeatureSource: 'claude-code-docs') — Claude Code natively supports
 *    Skills and sub-agents per official docs. Stage 5 NON-ROUTABLE inventory facts:
 *    myshell-tools does NOT invoke them and they NEVER enter route()/effort scoring.
 *    Codex/OpenCode are left ABSENT (no grounded local fact = unknown, not false).
 *
 * OpenCode stays empty: it is a meta-provider whose real models come from
 * `opencode models` (detect.ts), never from a guessed default. Gemini is absent.
 */
export const DECLARATIVE_MODEL_CAPABILITIES: CapabilityRegistry = {
  claude: [
    {
      provider: 'claude',
      id: 'opus',
      aliases: ['claude-opus-4-7', 'opus-4.7', 'claude-opus-4.7'],
      tierHint: 'manager',
      // Claude Code's CLI exposes `--effort <low|medium|high|xhigh|max>` (verified
      // via `claude --help`); these are the levels the installed CLI accepts.
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsNativeSession: true,
      // Provider-native features (Stage 5): Claude Code natively supports Skills and
      // sub-agents (official Claude Code docs). NON-ROUTABLE inventory facts only —
      // myshell-tools does NOT invoke them; they never enter routing.
      supportsProviderSkills: true,
      supportsProviderSubagents: true,
      providerFeatureSource: 'claude-code-docs',
      source: ['declarative'],
    },
    {
      provider: 'claude',
      id: 'sonnet',
      aliases: ['claude-sonnet-4-6', 'sonnet-4.6', 'claude-sonnet-4.6'],
      tierHint: 'ic',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsNativeSession: true,
      supportsProviderSkills: true,
      supportsProviderSubagents: true,
      providerFeatureSource: 'claude-code-docs',
      source: ['declarative'],
    },
    {
      provider: 'claude',
      id: 'haiku',
      aliases: ['claude-haiku-4-5', 'haiku-4.5', 'claude-haiku-4.5'],
      tierHint: 'worker',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsNativeSession: true,
      supportsProviderSkills: true,
      supportsProviderSubagents: true,
      providerFeatureSource: 'claude-code-docs',
      source: ['declarative'],
    },
  ],
  codex: [
    {
      provider: 'codex',
      id: 'gpt-5.5',
      aliases: [],
      tierHint: 'manager',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      // `codex exec` supports the native web_search tool via `-c tools.web_search=true`
      // (CLI-verified with --strict-config). Honest declarative fact — the Codex
      // adapter gates the override on this flag.
      supportsSearchTool: true,
      source: ['declarative'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.4',
      aliases: [],
      tierHint: 'ic',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      supportsSearchTool: true,
      source: ['declarative'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.4-mini',
      aliases: [],
      tierHint: 'worker',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      supportsSearchTool: true,
      source: ['declarative'],
    },
  ],
  opencode: [],
};

// ---------------------------------------------------------------------------
// Small pure helpers (used by Layer 2 merge + the self-awareness summary).
// ---------------------------------------------------------------------------

/**
 * Find a declarative capability for `(provider, id)` matching on id OR alias
 * (case-insensitive). Returns `undefined` when the registry has no entry — the
 * caller then adds a dynamic-only record with NO invented tier. PURE.
 */
export function findCapability(
  registry: CapabilityRegistry,
  provider: ProviderId,
  id: string,
): ModelCapability | undefined {
  const lower = id.toLowerCase();
  return (registry[provider] ?? []).find(
    (c) => c.id.toLowerCase() === lower || c.aliases.some((a) => a.toLowerCase() === lower),
  );
}
