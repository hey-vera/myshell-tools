/**
 * src/core/semantic-preflight-extractor.ts - dark semantic-preflight model pass.
 *
 * Mirrors intent-extractor dependency injection and call discipline, but parses
 * the Item-8 semantic V1 contract instead of the legacy IntentFrame.
 */

import type { Clock, LedgerWriter, Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel, Usage } from '../providers/port.js';
import { route } from './route.js';
import { parseSemanticPreflight } from './semantic-preflight.js';
import type { SemanticPreflightExtractor, SemanticPreflightExtraction } from './semantic-preflight.js';
import { runBudgetedProvider } from './budgeted-provider.js';
import type { TurnCallBudget } from './turn-call-budget.js';
import type { IntentUsage } from './intent.js';
import type { ReasoningEffort } from './model-capabilities.js';

export interface SemanticPreflightExtractorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the extraction run. Clamped to 8 seconds. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly accountAux?: boolean;
  readonly ledger?: LedgerWriter;
  readonly clock?: Clock;
  readonly sessionId?: string;
  readonly cacheAccountingV2?: boolean;
  readonly turnCallBudget?: TurnCallBudget;
}

const SEMANTIC_PREFLIGHT_TIER: Tier = 'worker';
const SEMANTIC_PREFLIGHT_SANDBOX: SandboxLevel = 'read-only';
const SEMANTIC_PREFLIGHT_TIMEOUT_MS = 8_000;
const KNOWN_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function candidateProviderIds(deps: SemanticPreflightExtractorDeps): ProviderId[] {
  const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
    (id) => deps.providers[id] !== undefined,
  );
  if (deps.authenticatedProviders === undefined || deps.authenticatedProviders.length === 0) {
    return pool;
  }
  return pool.filter((id) => deps.authenticatedProviders?.includes(id) === true);
}

function buildSemanticPreflightPrompt(
  task: string,
  candidateProviders: readonly ProviderId[],
): string {
  const effortList = KNOWN_EFFORTS.join(', ');
  const providerLines =
    candidateProviders.length === 0
      ? '- auto: none'
      : candidateProviders.map((id) => `- ${id}: ${effortList}`).join('\n');

  return [
    'You are the myshell-tools semantic preflight extractor.',
    'Return exactly one JSON object and no prose.',
    '',
    'Required top-level fields:',
    '- objective',
    '- taskShape { kind, scope, mutatesWorkspace }',
    '- route { tier, plan, rationale }',
    '- risk { level, reasons }',
    '- uncertainty { level, reasons, forks }',
    '- evidenceNeeded',
    '- doneCondition',
    '- planSteps',
    '- proposedExecution { provider, effort, rationale }',
    '',
    'Allowed enums:',
    '- taskShape.kind: conversation, lookup, analysis, change, decision',
    '- taskShape.scope: single-step, multi-step',
    '- route.tier: worker, ic, manager',
    '- risk.level: low, medium, high, critical',
    '- uncertainty.level: low, medium, high',
    '- evidenceNeeded.kind: local-code, external-source, command-output, test-result, user-input',
    '- evidenceNeeded.phase: before-answer, before-execution, before-completion',
    '- doneCondition.status: specified, unknown',
    '- doneCondition.reason: not-inferable',
    '- proposedExecution.effort: none, low, medium, high, xhigh, max',
    '',
    'Authenticated provider proposals and supported effort enums:',
    providerLines,
    '',
    'If no listed provider is clearly appropriate, set proposedExecution.provider to "auto".',
    'Do not include secrets, account limits, account details, or provider output.',
    '',
    'User task:',
    task,
  ].join('\n');
}

function toIntentUsage(usage: Usage | undefined): IntentUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
  };
}

export function makeSemanticPreflightExtractor(
  deps: SemanticPreflightExtractorDeps,
): SemanticPreflightExtractor {
  return async (task: string, signal: AbortSignal): Promise<SemanticPreflightExtraction> => {
    const pool = candidateProviderIds(deps);
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      const decision = route(
        SEMANTIC_PREFLIGHT_TIER,
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

    const req: ProviderRequest = {
      model,
      prompt: buildSemanticPreflightPrompt(task, pool),
      cwd: deps.cwd,
      sandbox: deps.sandbox ?? SEMANTIC_PREFLIGHT_SANDBOX,
      timeoutMs: Math.min(deps.timeoutMs, SEMANTIC_PREFLIGHT_TIMEOUT_MS),
    };

    let finalText: string | undefined;
    let usage: Usage | undefined;
    try {
      for await (const ev of runBudgetedProvider(provider, req, signal, {
        ...(deps.turnCallBudget !== undefined ? { budget: deps.turnCallBudget } : {}),
        purpose: 'intent',
        bucket: 'discretionary',
        provider: provider.id,
      })) {
        if (ev.type === 'done') {
          finalText = ev.text;
          usage = ev.usage;
        } else if (ev.type === 'error') {
          return null;
        }
      }
    } catch {
      return null;
    }

    const result = parseSemanticPreflight(finalText);
    if (result === null) return null;

    const intentUsage = toIntentUsage(usage);
    return { result, ...(intentUsage !== undefined ? { usage: intentUsage } : {}) };
  };
}
