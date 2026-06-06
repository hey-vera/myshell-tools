/**
 * src/core/model-capability-refresh.ts — Model/Provider Capability Registry,
 * Layer 2 (dynamic refresh / merge). See docs/model-capability-registry-5.6.md
 * §2 Layer 2 and §8 Stage 1.
 *
 * Merges the SPARSE declarative defaults (Layer 1) with the two machine-readable
 * LOCAL sources myshell already has access to:
 *   1. `detect.ts` ProviderStatus.availableModels  — the model ids the provider CLI
 *      advertises right now (adds new ids; never invents tier/effort).
 *   2. `$CODEX_HOME/models_cache.json`              — richer Codex metadata: per-model
 *      `supported_reasoning_levels[].effort`, `default_reasoning_level`,
 *      `context_window`, `input_modalities`, tool-support flags.
 *
 * FAIL-SOFT is the contract (§2 Layer 2 failure modes):
 *   - missing/unreadable cache  → keep declarative + detect facts; reasoning efforts
 *                                 stay "unknown" (empty), NEVER fabricated.
 *   - corrupt JSON / bad schema → emit a 'warn' diagnostic and keep what we have.
 *   - unknown effort string     → drop that one effort, keep the rest.
 *   - declarative entries are NEVER deleted when a dynamic source is unavailable.
 *
 * PURITY: this module lives in src/core/, so (like repo-map.ts) it touches NO fs /
 * child_process directly. The single local-file read is behind an injected port
 * (`CapabilityRefreshPort.readCodexModelsCache`); the node-fs-backed port is wired
 * in the impure layer (cli.ts / menu.ts). NO model call, NO network, NO embeddings,
 * NO metered service, NO Date (the caller supplies `nowIso`).
 */

import type { ProviderId } from '../providers/port.js';
import {
  DECLARATIVE_MODEL_CAPABILITIES,
  isReasoningEffort,
  type CapabilityRegistry,
  type CapabilitySource,
  type InputModality,
  type ModelCapability,
  type ReasoningEffort,
} from './model-capabilities.js';

// ---------------------------------------------------------------------------
// Inputs / outputs (§2 Layer 2).
// ---------------------------------------------------------------------------

/** Per-provider already-detected facts the merge consumes (subset of detect.ts). */
export interface ProviderDetectFacts {
  readonly provider: ProviderId;
  readonly authenticated: boolean;
  /** Model ids the provider CLI advertises right now (detect.ts availableModels). */
  readonly availableModels: readonly string[];
}

/**
 * The distilled, already-gathered input the refresh merges. Deliberately small and
 * pre-resolved (the caller resolves CODEX_HOME + reads detect.ts) so this stays a
 * pure-ish assembler over an injected file port.
 */
export interface RefreshCapabilityInput {
  /** Per-provider detection facts (claude/codex/opencode). */
  readonly providers: readonly ProviderDetectFacts[];
  /** ISO timestamp to stamp dynamic facts with when a source has no `fetched_at`. */
  readonly nowIso: string;
}

/** A single non-fatal note from the refresh (surfaced for diagnostics, not the prompt). */
export interface CapabilityRefreshDiagnostic {
  readonly provider: ProviderId;
  readonly source: CapabilitySource;
  readonly level: 'info' | 'warn';
  readonly message: string;
}

/** The merged registry plus any diagnostics from the dynamic sources. */
export interface CapabilitySnapshot {
  readonly registry: CapabilityRegistry;
  readonly diagnostics: readonly CapabilityRefreshDiagnostic[];
}

/**
 * The narrow port the refresh needs. Injected so this core module reads no fs
 * directly (mirrors repo-map.ts's RepoScanPort). The node-fs-backed impl lives in
 * the infra/impure layer. May reject / return null; the refresh catches everything.
 */
export interface CapabilityRefreshPort {
  /**
   * Read the raw text of `$CODEX_HOME/models_cache.json`. Returns `null` when the
   * file is absent / unreadable / CODEX_HOME cannot be resolved. MUST NOT throw in
   * the common-absent case, but the refresh tolerates rejection anyway.
   */
  readCodexModelsCache(): Promise<string | null>;
  /**
   * Read the raw stdout of `opencode models --verbose` (the OAuth CLI's own
   * machine-readable per-model metadata: limit/capabilities/variants). Returns
   * `null` when opencode is absent / old / errors / times out — the refresh then
   * keeps the detect/declarative facts for opencode (efforts stay unknown). MUST
   * NOT throw in the common-absent case; the refresh tolerates rejection anyway.
   * Optional so existing/fake ports without it keep compiling and degrade fail-soft.
   */
  readOpencodeModelsVerbose?(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Codex cache schema (the REAL local shape — see $CODEX_HOME/models_cache.json).
// ---------------------------------------------------------------------------

interface CodexModelsCache {
  readonly fetched_at?: string;
  readonly client_version?: string;
  readonly models?: readonly unknown[];
}

interface CodexCacheModel {
  readonly slug?: string;
  readonly display_name?: string;
  readonly default_reasoning_level?: string;
  readonly supported_reasoning_levels?: readonly { readonly effort?: string }[];
  readonly context_window?: number;
  readonly max_context_window?: number;
  readonly input_modalities?: readonly string[];
  readonly supports_search_tool?: boolean;
  readonly supports_parallel_tool_calls?: boolean;
  /** 'hide' models are present in the cache but not user-facing; we skip them. */
  readonly visibility?: string;
}

const KNOWN_MODALITIES: readonly InputModality[] = ['text', 'image', 'audio', 'video'];

// ---------------------------------------------------------------------------
// OpenCode verbose schema (the REAL local shape — `opencode models --verbose`).
// Output is a series of `providerID/id` header lines, each followed by a
// pretty-printed JSON object. We parse the JSON objects (header lines are skipped)
// and key the registry entry by `${providerID}/${id}` to match detect.ts ids.
// ---------------------------------------------------------------------------

interface OpencodeVerboseModel {
  readonly id?: string;
  readonly providerID?: string;
  readonly name?: string;
  readonly limit?: {
    readonly context?: number;
    readonly input?: number;
    readonly output?: number;
  };
  readonly capabilities?: {
    readonly reasoning?: boolean;
    readonly toolcall?: boolean;
    readonly input?: Record<string, unknown>;
  };
  readonly variants?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public entry — refreshCapabilities. Fully fail-soft; NEVER throws.
// ---------------------------------------------------------------------------

/**
 * Build the merged capability snapshot from the declarative defaults + detection +
 * the Codex local cache. Total + fail-soft: ANY error degrades to the best facts
 * available (worst case = the declarative defaults unchanged). NEVER throws.
 *
 * Merge order (§2 Layer 2 rules):
 *   1. start from DECLARATIVE_MODEL_CAPABILITIES (deep-copied, mutable working set).
 *   2. merge detect.ts availableModels (adds unknown ids with source ['detect'],
 *      no invented tier/effort).
 *   3. merge the Codex cache (efforts/context/modalities/tool flags), source += codex-cache.
 *   4. declarative entries are kept even when dynamic sources are empty.
 */
export async function refreshCapabilities(
  input: RefreshCapabilityInput,
  port: CapabilityRefreshPort,
): Promise<CapabilitySnapshot> {
  const diagnostics: CapabilityRefreshDiagnostic[] = [];
  // Mutable working copy of the declarative floor (deep clone of the records).
  const working: Record<ProviderId, ModelCapability[]> = {
    claude: cloneList(DECLARATIVE_MODEL_CAPABILITIES.claude),
    codex: cloneList(DECLARATIVE_MODEL_CAPABILITIES.codex),
    opencode: cloneList(DECLARATIVE_MODEL_CAPABILITIES.opencode),
  };

  // --- Source 2: detect.ts availableModels ---------------------------------
  for (const p of input.providers) {
    for (const id of p.availableModels) {
      const trimmed = id.trim();
      if (trimmed.length === 0) continue;
      const existing = matchById(working[p.provider], trimmed);
      if (existing === undefined) {
        // New dynamic id: add with NO invented tier (§2 rule 6) and source ['detect'].
        working[p.provider].push({
          provider: p.provider,
          id: trimmed,
          aliases: [],
          supportedReasoningEfforts: [],
          source: ['detect'],
          lastRefreshedAt: input.nowIso,
        });
      } else {
        addSource(existing, 'detect');
        (existing as Mutable<ModelCapability>).lastRefreshedAt = input.nowIso;
      }
    }
  }

  // --- Source 3: Codex $CODEX_HOME/models_cache.json -----------------------
  try {
    const raw = await port.readCodexModelsCache().catch(() => null);
    if (raw === null) {
      // Missing/unreadable cache is the COMMON case (offline/headless/no codex):
      // declarative + detect facts stand; reasoning efforts stay unknown. Info-level.
      diagnostics.push({
        provider: 'codex',
        source: 'codex-cache',
        level: 'info',
        message: 'Codex models_cache.json not found; using detection/declarative facts only.',
      });
    } else {
      mergeCodexCache(raw, working, input.nowIso, diagnostics);
    }
  } catch {
    // Defensive: any unexpected error → keep declarative+detect, warn.
    diagnostics.push({
      provider: 'codex',
      source: 'codex-cache',
      level: 'warn',
      message: 'Unexpected error reading Codex models cache; kept existing facts.',
    });
  }

  // --- Source 4: OpenCode `opencode models --verbose` ----------------------
  try {
    const raw = (await port.readOpencodeModelsVerbose?.().catch(() => null)) ?? null;
    if (raw === null) {
      // Absent/old opencode (or the port doesn't implement the read): keep
      // declarative + detect facts; opencode efforts/context/vision stay unknown.
      diagnostics.push({
        provider: 'opencode',
        source: 'detect',
        level: 'info',
        message:
          'opencode models --verbose unavailable; using detection/declarative facts only for OpenCode.',
      });
    } else {
      mergeOpencodeVerbose(raw, working, input.nowIso, diagnostics);
    }
  } catch {
    diagnostics.push({
      provider: 'opencode',
      source: 'detect',
      level: 'warn',
      message: 'Unexpected error reading opencode models --verbose; kept existing facts.',
    });
  }

  const registry: CapabilityRegistry = {
    claude: working.claude,
    codex: working.codex,
    opencode: working.opencode,
  };
  return { registry, diagnostics };
}

// ---------------------------------------------------------------------------
// OpenCode verbose merge — pure given the raw text. Fail-soft on parse/schema.
// ---------------------------------------------------------------------------

/**
 * Parse `opencode models --verbose` stdout and merge OBJECTIVE facts into the
 * working `opencode` set. The output is a stream of `providerID/id` header lines,
 * each followed by a pretty-printed JSON object; we collect the JSON objects (the
 * header lines fail JSON.parse and are skipped). On a total parse failure (no
 * objects recoverable) we emit a single 'warn' and leave declarative/detect facts
 * untouched — NEVER throws. PURE given `raw`.
 */
function mergeOpencodeVerbose(
  raw: string,
  working: Record<ProviderId, ModelCapability[]>,
  nowIso: string,
  diagnostics: CapabilityRefreshDiagnostic[],
): void {
  const models = parseOpencodeVerbose(raw);
  if (models.length === 0) {
    diagnostics.push({
      provider: 'opencode',
      source: 'detect',
      level: 'warn',
      message:
        'opencode models --verbose produced no parseable model JSON; kept declarative/detect facts.',
    });
    return;
  }

  let merged = 0;
  for (const m of models) {
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    const providerID = typeof m.providerID === 'string' ? m.providerID.trim() : '';
    if (id.length === 0 || providerID.length === 0) continue;
    // Key by `${providerID}/${id}` to match the ids detect.ts advertises.
    const key = `${providerID}/${id}`;

    const facts = extractOpencodeFacts(m, nowIso);
    const existing = matchById(working.opencode, key);
    if (existing === undefined) {
      working.opencode.push({
        provider: 'opencode',
        id: key,
        aliases: [],
        supportedReasoningEfforts: facts.efforts,
        source: ['detect'],
        lastRefreshedAt: nowIso,
        ...facts.optional,
      });
    } else {
      applyOpencodeFacts(existing, facts);
    }
    merged++;
  }

  diagnostics.push({
    provider: 'opencode',
    source: 'detect',
    level: 'info',
    message: `Merged ${merged} OpenCode model${merged === 1 ? '' : 's'} from opencode models --verbose.`,
  });
}

/**
 * Split the verbose stdout into JSON objects. The CLI pretty-prints one object per
 * model preceded by a `providerID/id` header line. We accumulate from each `{` at
 * column 0 to the matching `}` at column 0 and JSON.parse each block, skipping any
 * block that fails to parse (header/banner noise). Tolerant: returns [] on garbage.
 */
function parseOpencodeVerbose(raw: string): OpencodeVerboseModel[] {
  const out: OpencodeVerboseModel[] = [];
  const lines = raw.split('\n');
  let buf: string[] = [];
  let collecting = false;
  const flush = (): void => {
    if (buf.length === 0) return;
    try {
      const obj = JSON.parse(buf.join('\n')) as unknown;
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        out.push(obj as OpencodeVerboseModel);
      }
    } catch {
      // Not a JSON block (header/banner) — skip.
    }
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith('{')) {
      flush();
      collecting = true;
      buf.push(line);
      continue;
    }
    if (collecting) {
      buf.push(line);
      if (line.startsWith('}')) {
        flush();
        collecting = false;
      }
    }
  }
  flush();
  return out;
}

interface OpencodeFacts {
  readonly efforts: readonly ReasoningEffort[];
  readonly optional: Partial<ModelCapability>;
}

/**
 * Pull OBJECTIVE facts out of one OpenCode verbose model. Absent fields stay ABSENT
 * (never fabricated):
 *   - contextWindow ← limit.context; maxOutputTokens ← limit.output.
 *   - supportsVision ← capabilities.input.image === true (ONLY when explicitly true).
 *   - supportsToolCalling ← capabilities.toolcall === true.
 *   - efforts: ONLY when capabilities.reasoning === true AND `variants` is a non-empty
 *     object — derived from the variant KEYS mapped onto our ReasoningEffort set
 *     (unknown keys dropped). Empty/absent variants → [] (no fabricated levels), even
 *     when reasoning is true. PURE.
 */
function extractOpencodeFacts(m: OpencodeVerboseModel, refreshedAt: string): OpencodeFacts {
  const optional: {
    displayName?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsVision?: boolean;
    supportsToolCalling?: boolean;
    inputModalities?: readonly InputModality[];
    lastRefreshedAt?: string;
  } = { lastRefreshedAt: refreshedAt };

  if (typeof m.name === 'string' && m.name.length > 0) optional.displayName = m.name;

  const limit = m.limit;
  if (limit !== null && typeof limit === 'object') {
    if (typeof limit.context === 'number' && Number.isFinite(limit.context)) {
      optional.contextWindow = limit.context;
    }
    if (typeof limit.output === 'number' && Number.isFinite(limit.output)) {
      optional.maxOutputTokens = limit.output;
    }
  }

  const caps = m.capabilities;
  if (caps !== null && typeof caps === 'object') {
    if (caps.toolcall === true) optional.supportsToolCalling = true;
    const inputCaps = caps.input;
    if (inputCaps !== null && typeof inputCaps === 'object') {
      // Vision ONLY when image is explicitly true — false/absent leaves it unknown.
      if (inputCaps['image'] === true) optional.supportsVision = true;
      const mods = KNOWN_MODALITIES.filter((k) => inputCaps[k] === true);
      if (mods.length > 0) optional.inputModalities = mods;
    }
  }

  const efforts: ReasoningEffort[] = [];
  const variants = m.variants;
  const reasoning = caps !== null && typeof caps === 'object' && caps.reasoning === true;
  if (reasoning && variants !== null && typeof variants === 'object' && !Array.isArray(variants)) {
    for (const key of Object.keys(variants)) {
      const lvl = key.trim();
      if (lvl.length > 0 && isReasoningEffort(lvl) && !efforts.includes(lvl)) efforts.push(lvl);
    }
  }

  return { efforts, optional };
}

/** Layer the extracted OpenCode facts onto an existing (declarative/detect) record. */
function applyOpencodeFacts(target: ModelCapability, facts: OpencodeFacts): void {
  const mut = target as Mutable<ModelCapability>;
  if (facts.efforts.length > 0) mut.supportedReasoningEfforts = facts.efforts;
  for (const [k, v] of Object.entries(facts.optional)) {
    if (v !== undefined) (mut as Record<string, unknown>)[k] = v;
  }
  addSource(target, 'detect');
}

// ---------------------------------------------------------------------------
// Codex cache merge — pure given the raw text. Fail-soft on parse/schema.
// ---------------------------------------------------------------------------

/**
 * Parse + merge the Codex cache text into the working set. On JSON-parse failure or
 * a non-conforming top-level shape, pushes a single 'warn' diagnostic and returns
 * without mutating (declarative facts stand). Per-model bad data is skipped, not fatal.
 */
function mergeCodexCache(
  raw: string,
  working: Record<ProviderId, ModelCapability[]>,
  nowIso: string,
  diagnostics: CapabilityRefreshDiagnostic[],
): void {
  let parsed: CodexModelsCache;
  try {
    parsed = JSON.parse(raw) as CodexModelsCache;
  } catch {
    diagnostics.push({
      provider: 'codex',
      source: 'codex-cache',
      level: 'warn',
      message: 'Codex models_cache.json is corrupt (invalid JSON); kept declarative/detect facts.',
    });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
    diagnostics.push({
      provider: 'codex',
      source: 'codex-cache',
      level: 'warn',
      message: 'Codex models_cache.json has an unexpected shape; kept declarative/detect facts.',
    });
    return;
  }

  // `fetched_at` is the most faithful refresh stamp; fall back to caller's nowIso.
  const refreshedAt =
    typeof parsed.fetched_at === 'string' && parsed.fetched_at.length > 0
      ? parsed.fetched_at
      : nowIso;

  let merged = 0;
  for (const rawModel of parsed.models) {
    if (rawModel === null || typeof rawModel !== 'object') continue;
    const m = rawModel as CodexCacheModel;
    const slug = typeof m.slug === 'string' ? m.slug.trim() : '';
    if (slug.length === 0) continue;
    // Skip non-user-facing models (e.g. visibility 'hide' = codex-auto-review).
    if (typeof m.visibility === 'string' && m.visibility !== 'list') continue;

    const facts = extractCodexFacts(m, refreshedAt);
    const existing = matchById(working.codex, slug);
    if (existing === undefined) {
      // New Codex model from the cache: add it. No invented tier (§2 rule 6).
      working.codex.push({
        provider: 'codex',
        id: slug,
        aliases: [],
        supportedReasoningEfforts: facts.efforts,
        source: ['codex-cache'],
        lastRefreshedAt: refreshedAt,
        ...facts.optional,
      });
    } else {
      applyCodexFacts(existing, facts);
    }
    merged++;
  }

  diagnostics.push({
    provider: 'codex',
    source: 'codex-cache',
    level: 'info',
    message: `Merged ${merged} Codex model${merged === 1 ? '' : 's'} from local cache (fetched ${refreshedAt}).`,
  });
}

interface CodexFacts {
  readonly efforts: readonly ReasoningEffort[];
  readonly optional: Partial<ModelCapability>;
}

/**
 * Pull the OBJECTIVE facts out of one Codex cache model. Unknown effort strings are
 * dropped (§2: "Unknown reasoning effort string: ignore that effort"). A field that
 * is absent in the cache stays ABSENT here — NEVER fabricated from another field
 * (e.g. missing `input_modalities` leaves `supportsVision` undefined). PURE.
 */
function extractCodexFacts(m: CodexCacheModel, refreshedAt: string): CodexFacts {
  const efforts: ReasoningEffort[] = [];
  for (const lvl of m.supported_reasoning_levels ?? []) {
    const e = typeof lvl?.effort === 'string' ? lvl.effort.trim() : '';
    if (e.length > 0 && isReasoningEffort(e) && !efforts.includes(e)) efforts.push(e);
  }

  const optional: {
    displayName?: string;
    defaultReasoningEffort?: ReasoningEffort;
    contextWindow?: number;
    maxContextWindow?: number;
    inputModalities?: readonly InputModality[];
    supportsVision?: boolean;
    supportsSearchTool?: boolean;
    supportsParallelToolCalls?: boolean;
    lastRefreshedAt?: string;
  } = { lastRefreshedAt: refreshedAt };

  if (typeof m.display_name === 'string' && m.display_name.length > 0) {
    optional.displayName = m.display_name;
  }
  if (
    typeof m.default_reasoning_level === 'string' &&
    isReasoningEffort(m.default_reasoning_level)
  ) {
    optional.defaultReasoningEffort = m.default_reasoning_level;
  }
  if (typeof m.context_window === 'number' && Number.isFinite(m.context_window)) {
    optional.contextWindow = m.context_window;
  }
  if (typeof m.max_context_window === 'number' && Number.isFinite(m.max_context_window)) {
    optional.maxContextWindow = m.max_context_window;
  }
  if (Array.isArray(m.input_modalities)) {
    const mods = m.input_modalities
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x): x is InputModality => (KNOWN_MODALITIES as readonly string[]).includes(x));
    if (mods.length > 0) {
      optional.inputModalities = [...new Set(mods)];
      // Vision is DERIVED ONLY from an explicit modality fact — never guessed.
      if (mods.includes('image')) optional.supportsVision = true;
    }
  }
  if (typeof m.supports_search_tool === 'boolean') optional.supportsSearchTool = m.supports_search_tool;
  if (typeof m.supports_parallel_tool_calls === 'boolean') {
    optional.supportsParallelToolCalls = m.supports_parallel_tool_calls;
  }

  return { efforts, optional };
}

/** Layer the extracted Codex facts onto an existing (declarative/detect) record. */
function applyCodexFacts(target: ModelCapability, facts: CodexFacts): void {
  const mut = target as Mutable<ModelCapability>;
  if (facts.efforts.length > 0) mut.supportedReasoningEfforts = facts.efforts;
  for (const [k, v] of Object.entries(facts.optional)) {
    if (v !== undefined) (mut as Record<string, unknown>)[k] = v;
  }
  addSource(target, 'codex-cache');
}

// ---------------------------------------------------------------------------
// Small mutation helpers (operate on the cloned working set only).
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Deep-ish clone of a declarative list into mutable records. */
function cloneList(list: readonly ModelCapability[]): ModelCapability[] {
  return list.map((c) => ({
    ...c,
    aliases: [...c.aliases],
    supportedReasoningEfforts: [...c.supportedReasoningEfforts],
    source: [...c.source],
    ...(c.inputModalities !== undefined ? { inputModalities: [...c.inputModalities] } : {}),
  }));
}

/** Match a capability in a list by id or alias (case-insensitive). */
function matchById(list: readonly ModelCapability[], id: string): ModelCapability | undefined {
  const lower = id.toLowerCase();
  return list.find(
    (c) => c.id.toLowerCase() === lower || c.aliases.some((a) => a.toLowerCase() === lower),
  );
}

/** Append a source contributor if not already present (preserves merge order). */
function addSource(target: ModelCapability, source: CapabilitySource): void {
  if (!target.source.includes(source)) {
    (target as Mutable<ModelCapability>).source = [...target.source, source];
  }
}
