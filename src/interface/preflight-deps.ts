/**
 * src/interface/preflight-deps.ts — shared route/intent/auto-brain construction.
 *
 * Extracted from menu.ts so `run` and plain REPL can wire the same preflight
 * machinery without duplicating the constructor logic.
 */

import type { AppConfig } from '../infra/config.js';
import type { Policy, OrchestrateDeps, LedgerWriter, Clock } from '../core/types.js';
import type { TurnCallBudget } from '../core/turn-call-budget.js';
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import { makeRouteClassifier } from '../core/route-classifier.js';
import { makeIntentExtractor } from '../core/intent-extractor.js';
import { makeSemanticPreflightExtractor } from '../core/semantic-preflight-extractor.js';
import { fuseRung, type FuseRungResult } from '../core/auto-brain.js';
import { helperSandbox } from '../infra/sandbox.js';
import { experimentalEnabledByDefault } from './ui/experimental-default.js';
import { byproductFallbackEnabled } from './ui/byproduct-fallback-flag.js';
import { autoBrainEnabled } from './ui/auto-brain-flag.js';
import { semanticPreflightV1Enabled } from './ui/semantic-preflight-flag.js';
import type { Mode } from '../core/policy.js';

export interface BuildPreflightDepsInput {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly sandbox: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly config: AppConfig;
  readonly env: typeof process.env;
  readonly autoMode: Mode;
  readonly intentPass?: boolean;
  readonly accountAux?: boolean;
  readonly ledger?: LedgerWriter;
  readonly clock?: Clock;
  readonly sessionId?: string;
  readonly cacheAccountingV2?: boolean;
  readonly memoryBias?: -1 | 0 | 1;
  readonly turnCallBudget?: TurnCallBudget;
}

export function buildPreflightDeps(
  input: BuildPreflightDepsInput,
): Pick<
  OrchestrateDeps,
  'routeClassifier' | 'intentExtractor' | 'semanticPreflightV1' | 'semanticPreflightExtractor' | 'autoBrainRungTuple'
> {
  const { providers, policy, cwd, timeoutMs, sandbox, availableModels, authenticatedProviders } = input;
  const { config, env, autoMode, intentPass } = input;
  const { accountAux, ledger, clock, sessionId } = input;
  const { memoryBias, turnCallBudget } = input;

  // Route classifier — smart routing, worker-tier model call to disambiguate tier.
  const ROUTER_TIMEOUT_MS = 20_000;
  const routeClassifier =
    config.smartRoute !== false
      ? makeRouteClassifier({
          providers,
          policy,
          cwd,
          timeoutMs: Math.min(timeoutMs, ROUTER_TIMEOUT_MS),
          sandbox: helperSandbox(sandbox),
          ...(availableModels !== undefined && Object.keys(availableModels).length > 0
            ? { availableModels }
            : {}),
          ...(authenticatedProviders !== undefined && authenticatedProviders.length > 0
            ? { authenticatedProviders }
            : {}),
          ...(accountAux
            ? {
                accountAux: true,
                ledger,
                clock,
                sessionId,
                cacheAccountingV2: true,
              }
            : {}),
          ...(turnCallBudget !== undefined ? { turnCallBudget } : {}),
        })
      : undefined;

  // Intent extractor — cheap worker-tier model pass to populate IntentFrame.
  const INTENT_TIMEOUT_MS = 8_000;
  const intentExtractor =
    config.intentEngine !== false && intentPass !== false
      ? makeIntentExtractor({
          providers,
          policy,
          cwd,
          timeoutMs: Math.min(timeoutMs, INTENT_TIMEOUT_MS),
          sandbox: helperSandbox(sandbox),
          ...(availableModels !== undefined && Object.keys(availableModels).length > 0
            ? { availableModels }
            : {}),
          ...(authenticatedProviders !== undefined && authenticatedProviders.length > 0
            ? { authenticatedProviders }
            : {}),
          ...(byproductFallbackEnabled(env, config) ? { byproductFallback: true } : {}),
          ...(accountAux
            ? {
                accountAux: true,
                ledger,
                clock,
                sessionId,
                cacheAccountingV2: true,
              }
            : {}),
          ...(turnCallBudget !== undefined ? { turnCallBudget } : {}),
        })
      : undefined;

  // Semantic preflight extractor — dark Item-8 path. This is exposed alongside
  // the legacy closures for rollback; orchestrate reads it only when its
  // semanticPreflightV1 test seam is explicitly true.
  const semanticPreflightOn = semanticPreflightV1Enabled(env, config);
  const semanticPreflightBaseDeps = {
    providers,
    policy,
    cwd,
    timeoutMs: Math.min(timeoutMs, INTENT_TIMEOUT_MS),
    sandbox: helperSandbox(sandbox),
    ...(availableModels !== undefined && Object.keys(availableModels).length > 0
      ? { availableModels }
      : {}),
    ...(authenticatedProviders !== undefined && authenticatedProviders.length > 0
      ? { authenticatedProviders }
      : {}),
    ...(accountAux
      ? {
          accountAux: true,
          ledger,
          clock,
          sessionId,
          cacheAccountingV2: true,
        }
      : {}),
  } as const;
  const semanticPreflightExtractor =
    semanticPreflightOn
      ? function semanticPreflightExtractor(
          this: Pick<OrchestrateDeps, 'turnCallBudget'> | undefined,
          task: string,
          signal: AbortSignal,
        ) {
          return makeSemanticPreflightExtractor({
            ...semanticPreflightBaseDeps,
            ...(this?.turnCallBudget !== undefined
              ? { turnCallBudget: this.turnCallBudget }
              : turnCallBudget !== undefined
                ? { turnCallBudget }
                : {}),
          })(task, signal);
        }
      : undefined;

  // Auto brain — rung-fusion from intent byproduct + classify + memory bias.
  const autoBrainRungTuple: FuseRungResult | undefined =
    experimentalEnabledByDefault(
      env,
      config,
      'MYSHELL_AUTO_BRAIN',
      config.experimentalAutoBrain,
      autoBrainEnabled,
    )
      ? fuseRung({
          ...(config.mode !== undefined ? { persistedMode: config.mode } : {}),
          autoMode,
          ...(memoryBias !== undefined && memoryBias !== 0 ? { memoryBias } : {}),
        })
      : undefined;

  return {
    ...(routeClassifier !== undefined ? { routeClassifier } : {}),
    ...(intentExtractor !== undefined ? { intentExtractor } : {}),
    ...(semanticPreflightOn ? { semanticPreflightV1: true } : {}),
    ...(semanticPreflightExtractor !== undefined ? { semanticPreflightExtractor } : {}),
    ...(autoBrainRungTuple !== undefined ? { autoBrainRungTuple } : {}),
  };
}
