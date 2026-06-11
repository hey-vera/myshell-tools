/**
 * src/core/eval/judge-runner.ts — build a live cross-vendor JUDGE port.
 *
 * The PURE half (rubric/prompt/parse) is in ./judge.ts. This is the thin composer
 * that turns it into a runnable {@link JudgePort}: route to a DIFFERENT vendor than
 * the one that answered (cross-vendor honesty — the whole point of the substrate),
 * send the judge prompt read-only, take the final text, and parse it FAIL-SOFT.
 *
 * A near-twin of core/intent-extractor.ts and core/decompose.ts: the only I/O is
 * the injected provider CLI run (OAuth subscription — NO API key, NO metered eval
 * service, NO embeddings). Every failure mode — no other-vendor provider, route
 * throws, run errors/times out, unparseable output — returns `null`, so the
 * harness records the prompt as UNJUDGED and never fabricates a score.
 *
 * PURITY: core — no fs/path/child_process; the real I/O is in the injected
 * provider, exactly like intent-extractor.ts.
 */

import type { Policy, Tier } from '../types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../../providers/port.js';
import { route } from '../route.js';
import { buildJudgePrompt, parseJudgeVerdict } from './judge.js';
import type { EvalPrompt } from './suite.js';
import type { JudgePort } from './harness.js';
import type { JudgeVerdict } from './judge.js';

/** Everything the judge port needs to pick + run a cross-vendor model. */
export interface JudgeRunnerDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for a single judge run. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  /**
   * The provider that PRODUCED the answers. The judge deliberately routes to a
   * DIFFERENT vendor for an honest outside check; when no other vendor is signed
   * in we fall back to the same vendor (still a real, separate call) so the ruler
   * still works on a single-provider setup — the provenance records the truth.
   */
  readonly answerProvider: ProviderId;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
}

/** Judging is a reasoning task — route at the manager tier for a careful read. */
const JUDGE_TIER: Tier = 'manager';
/** The judge only reads a prompt + an answer and emits JSON — never touches files. */
const JUDGE_SANDBOX: SandboxLevel = 'read-only';

/**
 * Choose the provider id the judge should use: prefer ANY signed-in vendor that is
 * NOT the one that answered (cross-vendor); fall back to the answer provider only
 * when it is the sole option. Returns null when there is no usable provider.
 */
export function pickJudgeProvider(deps: JudgeRunnerDeps): ProviderId | null {
  const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
    (id) => deps.providers[id] !== undefined,
  );
  if (pool.length === 0) return null;
  const authed = new Set(deps.authenticatedProviders ?? pool);
  const others = pool.filter((id) => id !== deps.answerProvider && authed.has(id));
  if (others.length > 0) return others[0] as ProviderId;
  // No other vendor available — fall back to the answer provider so the ruler
  // still runs (a real, separate call); provenance records that it was same-vendor.
  return authed.has(deps.answerProvider) ? deps.answerProvider : (pool[0] as ProviderId);
}

/**
 * Build a {@link JudgePort} backed by a cross-vendor provider. Returns the port
 * plus the resolved judge provider id (for run provenance). The port itself never
 * throws and returns null on any failure.
 */
export function makeJudgePort(deps: JudgeRunnerDeps): {
  readonly port: JudgePort;
  readonly judgeProvider: ProviderId | null;
} {
  const judgeProvider = pickJudgeProvider(deps);

  const port: JudgePort = async (
    prompt: EvalPrompt,
    answer: string,
    signal: AbortSignal,
  ): Promise<JudgeVerdict | null> => {
    if (judgeProvider === null) return null;
    const provider = deps.providers[judgeProvider];
    if (provider === undefined) return null;

    let model: string;
    try {
      const decision = route(
        JUDGE_TIER,
        [judgeProvider],
        deps.policy,
        deps.availableModels,
        deps.authenticatedProviders,
      );
      model = decision.model;
    } catch {
      return null;
    }

    const req: ProviderRequest = {
      model,
      prompt: buildJudgePrompt(prompt, answer),
      cwd: deps.cwd,
      sandbox: deps.sandbox ?? JUDGE_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    try {
      for await (const ev of provider.run(req, signal)) {
        if (ev.type === 'done') finalText = ev.text;
        else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    return parseJudgeVerdict(prompt, finalText);
  };

  return { port, judgeProvider };
}
