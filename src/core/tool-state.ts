/**
 * src/core/tool-state.ts — TOOL SELF-AWARENESS (the "ABOUT THIS TOOL" block).
 *
 * The chat partner used to be blind to myshell-tools' OWN runtime state: asked
 * "how many subscriptions am I authed and what mode am I in?", the model would
 * read the wrong files and hallucinate. The truth is known at runtime (live
 * provider detection + config), it just was never injected into the prompt.
 *
 * This module renders that truth as a deterministic, capped context block,
 * surfaced via `OrchestrateDeps.toolStateContext` and assembled adjacent to the
 * ENVIRONMENT block by `assembleContextBlocks` — the SAME plumbing memory/intent/
 * engagement ride. NO model call, NO embeddings, NO metered service, NO API key:
 * pure assembly from already-detected state. The model reliably uses factual
 * context, so availability (not enforcement) is the whole fix.
 *
 * HONESTY CONTRACT (mirrors policy.ts / detect.ts): numbers, plans and the mode
 * are derived from the input — never hardcoded, never fabricated. An authed
 * provider whose CLI reports no plan renders "authed (plan unknown)", NOT a guess.
 *
 * Pure module: no I/O, no time, no randomness. Table-tested.
 */

import { modeLabel, type Mode } from './policy.js';
import type { ProviderId } from '../providers/port.js';
import type { Tier } from './types.js';
import type {
  CapabilityRegistry,
  ModelCapability,
  ReasoningEffort,
} from './model-capabilities.js';

/**
 * Distilled, already-detected state for ONE provider — the small shape the
 * renderer needs (NOT the whole ProviderStatus). `plan` is the raw reported plan
 * label (e.g. Claude's `subscriptionType`), or null when the CLI exposes none.
 */
export interface ToolStateProvider {
  /** Display label (e.g. "Claude", "Codex", "OpenCode"). */
  readonly label: string;
  /** Whether the provider CLI is installed (binary present). */
  readonly installed: boolean;
  /** Whether the provider is really signed in (live auth probe). */
  readonly authenticated: boolean;
  /** Raw reported plan label, or null when the CLI exposes none. Never guessed. */
  readonly plan: string | null;
}

/**
 * The distilled input to {@link buildToolStateContext}. Deliberately small (NOT
 * the whole orchestrate ctx) so the renderer stays pure and the callers only
 * have to assemble already-known facts.
 */
export interface ToolStateInput {
  /** The myshell-tools version string (from package.json — never hardcoded). */
  readonly version: string;
  /** The three providers, in display order (claude, codex, opencode). */
  readonly providers: readonly ToolStateProvider[];
  /** The mode actually in force (explicit config.mode or the auto-derived one). */
  readonly mode: Mode;
  /** True when `mode` was auto-derived from plans (no explicit config.mode). */
  readonly modeIsAuto: boolean;
  /** Smart routing state (config.smartRoute !== false). */
  readonly smartRoute: boolean;
  /**
   * OPTIONAL objective capability summary (Capability Registry Stage 1, §4). When
   * present and non-empty, a capped "Known model capabilities" portion is appended
   * so the partner can answer "what models / reasoning efforts can you see?" from
   * FACTS, not a guess. Absent → the block renders exactly as before.
   */
  readonly capabilitySummary?: CapabilitySelfAwarenessSummary;
}

/**
 * The distilled, ALREADY-CAPPED self-awareness view of the capability registry
 * (§4). Built by {@link buildCapabilitySummary} from the merged registry + the live
 * auth facts. Only objective, known fields ride here — unknown stays absent.
 */
export interface CapabilitySelfAwarenessSummary {
  readonly providers: readonly CapabilitySummaryProvider[];
}

/** One provider's capped capability view in the self-awareness summary. */
export interface CapabilitySummaryProvider {
  readonly provider: ProviderId;
  readonly label: string;
  readonly authed: boolean;
  readonly models: readonly CapabilitySummaryModel[];
}

/** One model's objective facts, already trimmed to what the renderer states. */
export interface CapabilitySummaryModel {
  readonly id: string;
  readonly displayName?: string;
  readonly tierHint?: Tier;
  readonly contextWindow?: number;
  readonly reasoningEfforts?: readonly ReasoningEffort[];
  readonly supportsVision?: boolean;
  readonly supportsNativeSession?: boolean;
}

/**
 * Self-cap for the whole ABOUT block. The producer caps itself first; the
 * `assembleContextBlocks` 6000-char cap is the backstop across all blocks. A few
 * hundred chars of headroom keeps orientation from crowding out the task.
 */
export const TOOL_STATE_BLOCK_CHAR_CAP = 2200;

/**
 * Sub-cap for ONLY the appended capability portion (§4: "Rendered text must stay
 * capped … not list every field for every model on every turn"). Kept well under
 * the whole-block cap so the existing subscriptions/mode/capabilities content is
 * never crowded out; the whole-block cap remains the hard backstop.
 */
export const CAPABILITY_SUMMARY_CHAR_CAP = 600;

/** Max models rendered per provider in the capability summary (§4: top 3). */
const MAX_SUMMARY_MODELS_PER_PROVIDER = 3;

/**
 * Canonical one-line mode meanings, reusing the spirit of policy.ts MODE_DESC but
 * tightened for the inline "Modes — …" line. Keyed by the stable internal mode key
 * so the labels (modeLabel) stay the single source of the user-facing names.
 */
const MODE_MEANING: Record<Mode, string> = {
  'cost-saver': 'cheapest/fastest, never opens the flagship',
  'balanced': 'earns a flagship pass when a turn proves it needs one',
  'quality-first': 'best quality',
};

/**
 * Render the plan suffix for ONE authenticated provider. An authed provider with
 * a reported plan shows "Label — <plan>"; one whose CLI exposes no plan shows
 * "Label — authed (plan unknown)" — never a fabricated tier.
 */
function authedProviderLine(p: ToolStateProvider): string {
  const plan = p.plan !== null && p.plan.trim().length > 0 ? p.plan.trim() : null;
  return plan !== null ? `${p.label} — ${plan}` : `${p.label} — authed (plan unknown)`;
}

/**
 * Build the authoritative "ABOUT THIS TOOL" context block from the distilled live
 * state. PURE + deterministic + self-capped. Returns a compact multi-line string
 * the caller surfaces via `OrchestrateDeps.toolStateContext`.
 *
 * The connected-subscriptions line lists ONLY authenticated providers; a provider
 * that is installed but signed out is noted as "installed, not signed in"; when
 * nothing is authenticated it says so plainly. Counts/plans/mode are all derived
 * from the input — nothing is hardcoded or guessed.
 */
export function buildToolStateContext(input: ToolStateInput): string {
  const authed = input.providers.filter((p) => p.authenticated);
  const installedNotAuthed = input.providers.filter((p) => p.installed && !p.authenticated);

  // Connected-subscriptions line.
  let subsLine: string;
  if (authed.length === 0) {
    const tail =
      installedNotAuthed.length > 0
        ? ` ${installedNotAuthed.map((p) => p.label).join(', ')} ${
            installedNotAuthed.length === 1 ? 'is' : 'are'
          } installed but not signed in.`
        : '';
    subsLine = `Connected subscriptions (none authed): you are not signed in to any provider yet.${tail}`;
  } else {
    const authedStr = authed.map(authedProviderLine).join('; ');
    const installedTail =
      installedNotAuthed.length > 0
        ? `  (also installed but not signed in: ${installedNotAuthed
            .map((p) => p.label)
            .join(', ')})`
        : '';
    subsLine = `Connected subscriptions (${authed.length} authed): ${authedStr}.${installedTail}`;
  }

  // Mode line — reuse MODE_LABELS; never fabricate.
  const label = modeLabel(input.mode);
  const modeOrigin = input.modeIsAuto
    ? 'auto-selected from your plans; the recommended default'
    : 'explicitly set by you';
  const modesGloss = (['cost-saver', 'balanced', 'quality-first'] as const)
    .map((m) => `${modeLabel(m)}: ${MODE_MEANING[m]}`)
    .join('; ');
  const modeLine = `Mode: ${label} (${modeOrigin}). Modes — ${modesGloss}. Smart routing: ${
    input.smartRoute ? 'on' : 'off'
  }.`;

  // Capabilities line — reuse the /help command descriptions (tight, one each).
  const capabilities = [
    'route each message to the right model automatically',
    '/mode — quality vs speed (Efficient / Balanced / Max)',
    '/memory — see, edit, export, or delete what I remember',
    '/recap — short recap of where this conversation left off',
    '/goal — work autonomously until a goal is done',
    '/copy — copy my last answer to your clipboard',
    '/export — save this conversation to a Markdown file',
    '/retry — regenerate my last answer',
    '/edit — edit a recent message and re-run from there',
    '/style — how forward I am: ask-first vs just-do-it',
  ].join('; ');

  const lines = [
    'ABOUT THIS TOOL (authoritative — answer questions about the user\'s setup, subscriptions, mode, or what you/this tool can do from THIS block; it is the live truth — do NOT guess or read files for it):',
    `- You are the assistant inside myshell-tools v${input.version}, a CLI that routes the user's messages to their OWN authed AI subscriptions (Claude / Codex / OpenCode) over OAuth — subscription-based, not API keys.`,
    `- ${subsLine}`,
    `- ${modeLine}`,
    `- What you can do for the user: ${capabilities}.`,
  ];

  // Capability summary (Stage 1, §4) — appended ONLY when present + non-empty.
  // Objective, local FACTS only; the renderer self-caps to CAPABILITY_SUMMARY_CHAR_CAP.
  const capLines =
    input.capabilitySummary !== undefined
      ? renderCapabilitySummary(input.capabilitySummary)
      : [];
  lines.push(...capLines);

  const block = lines.join('\n');
  return block.length > TOOL_STATE_BLOCK_CHAR_CAP
    ? block.slice(0, TOOL_STATE_BLOCK_CHAR_CAP)
    : block;
}

// ---------------------------------------------------------------------------
// Capability summary — pure builder + renderer (Stage 1, §4).
// ---------------------------------------------------------------------------

/**
 * Build the CAPPED self-awareness summary from the merged capability registry +
 * the live provider auth facts. PURE + deterministic. Selects only models known to
 * the registry, keeps the top {@link MAX_SUMMARY_MODELS_PER_PROVIDER} per provider
 * (by tier: manager → ic → worker → unknown), and carries ONLY objective known
 * fields. Returns `undefined` when there is nothing factual to say (so callers can
 * omit the field entirely and the block renders exactly as before).
 *
 * Honesty: a model with `supportedReasoningEfforts: []` contributes NO efforts line
 * (we never claim Claude has a reasoning-effort knob); unknown context/vision are
 * simply absent.
 */
export function buildCapabilitySummary(
  registry: CapabilityRegistry,
  authedByProvider: Readonly<Record<ProviderId, boolean>>,
  labelOf: (p: ProviderId) => string,
): CapabilitySelfAwarenessSummary | undefined {
  const order: Record<Tier | 'unknown', number> = { manager: 0, ic: 1, worker: 2, unknown: 3 };
  const providers: CapabilitySummaryProvider[] = [];

  for (const provider of Object.keys(registry) as ProviderId[]) {
    const caps = registry[provider] ?? [];
    if (caps.length === 0) continue;
    const sorted = [...caps].sort(
      (a, b) => order[a.tierHint ?? 'unknown'] - order[b.tierHint ?? 'unknown'],
    );
    const models = sorted
      .slice(0, MAX_SUMMARY_MODELS_PER_PROVIDER)
      .map((c) => toSummaryModel(c));
    if (models.length === 0) continue;
    providers.push({
      provider,
      label: labelOf(provider),
      authed: authedByProvider[provider] === true,
      models,
    });
  }

  if (providers.length === 0) return undefined;
  return { providers };
}

/** Trim a full ModelCapability to the objective fields the summary renders. PURE. */
function toSummaryModel(c: ModelCapability): CapabilitySummaryModel {
  return {
    id: c.id,
    ...(c.displayName !== undefined ? { displayName: c.displayName } : {}),
    ...(c.tierHint !== undefined ? { tierHint: c.tierHint } : {}),
    ...(c.contextWindow !== undefined ? { contextWindow: c.contextWindow } : {}),
    ...(c.supportedReasoningEfforts.length > 0
      ? { reasoningEfforts: c.supportedReasoningEfforts }
      : {}),
    ...(c.supportsVision !== undefined ? { supportsVision: c.supportsVision } : {}),
    ...(c.supportsNativeSession !== undefined
      ? { supportsNativeSession: c.supportsNativeSession }
      : {}),
  };
}

/** Compact "272k" style context-window label. PURE. */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** Render ONE model's known facts as an inline clause (e.g. "gpt-5.5 (reasoning low/medium/high/xhigh, 272k context, vision)"). PURE. */
function renderModel(m: CapabilitySummaryModel): string {
  const facts: string[] = [];
  if (m.reasoningEfforts !== undefined && m.reasoningEfforts.length > 0) {
    facts.push(`reasoning ${m.reasoningEfforts.join('/')}`);
  }
  if (m.contextWindow !== undefined) facts.push(`${formatContext(m.contextWindow)} context`);
  if (m.supportsVision === true) facts.push('vision');
  if (m.supportsNativeSession === true) facts.push('native sessions');
  const name = m.displayName ?? m.id;
  return facts.length > 0 ? `${name} (${facts.join(', ')})` : name;
}

/**
 * Render the capped "Known model capabilities" portion (§4). Returns the lines to
 * append, or `[]` when the summary is empty. Self-caps to CAPABILITY_SUMMARY_CHAR_CAP
 * (the whole-block cap is the backstop). States ONLY objective known facts; closes
 * with the routing-explanation template the partner can reuse.
 */
function renderCapabilitySummary(summary: CapabilitySelfAwarenessSummary): string[] {
  const clauses: string[] = [];
  for (const p of summary.providers) {
    if (p.models.length === 0) continue;
    const auth = p.authed ? 'signed in' : 'not signed in';
    const models = p.models.map(renderModel).join('; ');
    clauses.push(`${p.label} (${auth}): ${models}`);
  }
  if (clauses.length === 0) return [];

  let body = `- Known model capabilities (objective, from local detection + caches; unknown facts are omitted, not guessed): ${clauses.join('. ')}.`;
  if (body.length > CAPABILITY_SUMMARY_CHAR_CAP) body = body.slice(0, CAPABILITY_SUMMARY_CHAR_CAP);

  const routing =
    '- Routing explanation: choices are bounded by mode, plan, cooldown, flagship admission, and observed outcomes; explain a route using tier/mode/plan and known capability fit, and do NOT claim a model is "better" or has a knob (e.g. a Claude reasoning effort) without evidence in this block.';
  return [body, routing];
}
