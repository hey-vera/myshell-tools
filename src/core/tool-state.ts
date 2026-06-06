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
}

/**
 * Self-cap for the whole ABOUT block. The producer caps itself first; the
 * `assembleContextBlocks` 6000-char cap is the backstop across all blocks. A few
 * hundred chars of headroom keeps orientation from crowding out the task.
 */
export const TOOL_STATE_BLOCK_CHAR_CAP = 1600;

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

  const block = lines.join('\n');
  return block.length > TOOL_STATE_BLOCK_CHAR_CAP
    ? block.slice(0, TOOL_STATE_BLOCK_CHAR_CAP)
    : block;
}
