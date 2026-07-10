/**
 * src/core/model-ghost.ts — optional budgeted model ghost completion (P1.5).
 *
 * Mirrors route-classifier: wrap the cheapest worker-tier provider in a tiny
 * SuggestGhost port. Short timeout, read-only sandbox, fail-soft → null on any
 * error / abort / garbled output. Subscription-native (existing Provider path;
 * no API-key surface). Never throws.
 *
 * Cost discipline: only fires when the UI already decided local layers missed
 * and the user toggled modelGhost on. The UI owns debounce + cancel-on-keystroke.
 * Prompt/parse pure helpers live here so core does not import interface/.
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import { route } from './route.js';
import { runBudgetedProvider } from './budgeted-provider.js';
import type { TurnCallBudget } from './turn-call-budget.js';

/** Hard wall-clock cap for an optional model ghost run (ms). Keep tiny. */
export const MODEL_GHOST_TIMEOUT_MS = 2_000;

/** Max characters the model may append as a ghost suffix (prompt contract). */
export const MODEL_GHOST_MAX_SUFFIX = 80;

/**
 * Injected port for optional budgeted model ghost. Returns raw completion text
 * (suffix or full line), or null on any failure. Cancel via `signal`.
 */
export type SuggestGhost = (
  line: string,
  signal: AbortSignal,
) => Promise<string | null>;

/** Everything the model-ghost adapter needs to pick and run the cheapest model. */
export interface ModelGhostDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap. Keep short (default MODEL_GHOST_TIMEOUT_MS). */
  readonly timeoutMs?: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly turnCallBudget?: TurnCallBudget;
}

const GHOST_TIER: Tier = 'worker';
const GHOST_SANDBOX: SandboxLevel = 'read-only';

/**
 * Tiny one-shot prompt for the ghost model. PURE. Deliberately small volume.
 */
export function buildModelGhostPrompt(line: string): string {
  const prefix = typeof line === 'string' ? line : '';
  if (prefix.length === 0) {
    return [
      'You complete the next short chat prompt a developer might type in a coding CLI.',
      'Reply with ONLY the full prompt text on one line (no quotes, no markdown, no explanation).',
      'Max 12 words. Prefer a concrete next action (e.g. continue the active goal, open a PR).',
    ].join('\n');
  }
  return [
    'You are inline tab-complete for a coding CLI chat box.',
    "Continue the user's partial message with a short natural suffix.",
    'Rules:',
    '- Reply with ONLY the completion SUFFIX (text after what they already typed), OR the full completed line starting with their exact prefix.',
    '- One line only. No quotes, no markdown fences, no explanation.',
    `- Max ${MODEL_GHOST_MAX_SUFFIX} characters of new text.`,
    '- Do NOT restart the sentence unless completing a tiny typo-free prefix.',
    '',
    `Typed so far: ${prefix}`,
  ].join('\n');
}

/**
 * Build a {@link SuggestGhost} backed by the cheapest available provider.
 * Returns null text (via the port) when nothing is available — never throws.
 */
export function makeModelGhostSuggester(deps: ModelGhostDeps): SuggestGhost {
  return async (line: string, signal: AbortSignal): Promise<string | null> => {
    try {
      if (signal.aborted) return null;

      const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
        (id) => deps.providers[id] !== undefined,
      );
      if (pool.length === 0) return null;

      let provider: Provider | undefined;
      let model: string;
      try {
        const decision = route(
          GHOST_TIER,
          pool,
          deps.policy,
          deps.availableModels,
          deps.authenticatedProviders,
        );
        provider = deps.providers[decision.provider];
        model = decision.model;
      } catch {
        return null;
      }
      if (provider === undefined) return null;

      const timeoutMs = Math.min(
        deps.timeoutMs ?? MODEL_GHOST_TIMEOUT_MS,
        MODEL_GHOST_TIMEOUT_MS,
      );
      const req: ProviderRequest = {
        model,
        prompt: buildModelGhostPrompt(line),
        cwd: deps.cwd,
        sandbox: deps.sandbox ?? GHOST_SANDBOX,
        timeoutMs,
      };

      let finalText: string | undefined;
      try {
        for await (const ev of runBudgetedProvider(provider, req, signal, {
          ...(deps.turnCallBudget !== undefined ? { budget: deps.turnCallBudget } : {}),
          purpose: 'ghost',
          bucket: 'discretionary',
          provider: provider.id,
        })) {
          if (signal.aborted) return null;
          if (ev.type === 'done') {
            finalText = ev.text;
          } else if (ev.type === 'error') {
            return null;
          }
        }
      } catch {
        return null;
      }

      if (signal.aborted) return null;
      if (finalText === undefined) return null;
      const trimmed = finalText.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  };
}
