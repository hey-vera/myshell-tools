/**
 * src/commands/eval.ts — `myshell eval` : the OWNER-INVOKED ruler (Phase 0).
 *
 * Runs the frozen eval suite (src/core/eval/suite.ts) through the partner's REAL
 * answer path, has a DIFFERENT vendor judge each answer against the fixed rubric,
 * prints a scorecard, and STORES the timestamped result so runs can be compared
 * over time (did a phase move the number?).
 *
 * COST-RESPECT (the load-bearing rule): this NEVER auto-runs. It is invoked
 * deliberately by the owner, STATES its cost up front (~N answer calls + ~N judge
 * calls), and refuses to spend quota until the owner confirms with `--yes`. With
 * no `--yes` it prints the cost statement and exits without a single model call.
 *
 * HONESTY: every score is a REAL judge call. If a provider/judge is unavailable
 * the run reports it honestly (prompts recorded UNJUDGED) — it never invents a
 * number. The cross-vendor provenance (who answered, who judged) is printed and
 * stored. Subscription-clean: the only I/O is the injected provider runs + the
 * append-only JSONL store — no API key, no metered eval service, no embeddings.
 *
 * This file holds NO hardcoded scores/percentages (honesty-lint): every figure is
 * computed by the pure core (score.ts/scorecard.ts) and merely printed here. It
 * does NOT call process.exit — it returns an exit code to cli.ts (single-entry).
 */

import type { OutputSink } from '../interface/render.js';
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import type { OrchestrateDeps, Policy } from '../core/types.js';
import { SUITE_SIZE } from '../core/eval/suite.js';
import { runEval } from '../core/eval/harness.js';
import { makeAnswerPort } from '../core/eval/answer-runner.js';
import { makeJudgePort } from '../core/eval/judge-runner.js';
import { formatScorecard, compareRuns, formatComparison } from '../core/eval/scorecard.js';
import { appendEvalRun, readEvalRuns } from '../infra/eval-store.js';

/** Everything the command needs, injected by cli.ts so this file stays testable. */
export interface EvalCommandDeps {
  readonly cwd: string;
  readonly version: string;
  /** ISO timestamp source (cli passes the real clock). */
  readonly nowIso: () => string;
  /** Installed providers, keyed by id (same map orchestrate uses). */
  readonly providers: Partial<Record<ProviderId, Provider>>;
  /** The shared policy for routing answer + judge runs. */
  readonly policy: Policy;
  /** Hard wall-clock cap per provider run. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  /** Authenticated providers (cross-vendor judge prefers a different signed-in vendor). */
  readonly authenticatedProviders: readonly ProviderId[];
  /** Advertised model lists per provider (so routing prefers a model the CLI has). */
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  /**
   * Build a FRESH OrchestrateDeps for one prompt run (fresh session, no carried
   * history). cli.ts supplies this so the real ledger/session/capability wiring is
   * reused — identical to the `run` subcommand's answer path.
   */
  readonly makeDeps: (promptId: string) => OrchestrateDeps;
}

/** Parsed flags for the eval command. */
export interface EvalOptions {
  /** Show the latest-two-runs comparison instead of running. */
  readonly compare?: boolean;
  /** Confirm the model spend and actually run (without it, only the cost is printed). */
  readonly yes?: boolean;
}

/** Parse eval argv flags. Pure, total. */
export function parseEvalArgs(args: readonly string[]): EvalOptions {
  return {
    compare: args.includes('--compare'),
    yes: args.includes('--yes') || args.includes('-y'),
  };
}

/** The provider that will answer: the first authenticated/installed one, deterministically. */
function pickAnswerProvider(deps: EvalCommandDeps): ProviderId | null {
  const installed = (Object.keys(deps.providers) as ProviderId[]).filter(
    (id) => deps.providers[id] !== undefined,
  );
  if (installed.length === 0) return null;
  const authed = deps.authenticatedProviders.filter((id) => installed.includes(id));
  return (authed[0] ?? installed[0]) as ProviderId;
}

/**
 * Run the eval command. Returns an exit code (0 ok, 1 problem). No process.exit.
 */
export async function runEvalCommand(
  args: readonly string[],
  deps: EvalCommandDeps,
  out: OutputSink,
  signal: AbortSignal,
): Promise<number> {
  const opts = parseEvalArgs(args);

  // ---- --compare : read-only, no model calls ------------------------------
  if (opts.compare === true) {
    const runs = await readEvalRuns(deps.cwd);
    if (runs.length < 2) {
      out.write(
        `Need at least two stored eval runs to compare — found ${runs.length}. ` +
          'Run `myshell eval --yes` (at least twice, before & after a change) first.\n',
      );
      return 0;
    }
    const before = runs[runs.length - 2];
    const after = runs[runs.length - 1];
    if (before === undefined || after === undefined) return 1;
    for (const line of formatComparison(compareRuns(before, after))) out.write(line + '\n');
    return 0;
  }

  // ---- Cost statement + opt-in gate ---------------------------------------
  const answerProvider = pickAnswerProvider(deps);
  if (answerProvider === null) {
    out.write(
      'No providers detected — cannot run the eval. Sign in first: `myshell login`.\n',
    );
    return 1;
  }

  // ~SUITE_SIZE answer calls + up to ~SUITE_SIZE judge calls. Stated up front.
  const maxCalls = SUITE_SIZE * 2;
  if (opts.yes !== true) {
    out.write('myshell eval — the answer-quality ruler (Phase 0).\n\n');
    out.write(`This runs the frozen suite of ${SUITE_SIZE} prompts through your real partner,\n`);
    out.write('then has a different vendor judge each answer against a fixed rubric.\n\n');
    out.write(
      `COST: up to ${SUITE_SIZE} answer calls + ${SUITE_SIZE} judge calls = ~${maxCalls} model calls ` +
        'on your own subscription (no API key, no metered service).\n',
    );
    out.write('It is opt-in and never runs automatically.\n\n');
    out.write('Re-run with `--yes` to spend the quota and produce a scorecard:\n');
    out.write('  myshell eval --yes\n');
    return 0;
  }

  // ---- The real run (owner confirmed) -------------------------------------
  out.write(`Running ${SUITE_SIZE} prompts (~${maxCalls} model calls). Answered by ${answerProvider}.\n`);

  const judgeBuild = makeJudgePort({
    providers: deps.providers,
    policy: deps.policy,
    cwd: deps.cwd,
    timeoutMs: deps.timeoutMs,
    ...(deps.sandbox !== undefined ? { sandbox: deps.sandbox } : {}),
    answerProvider,
    ...(deps.availableModels !== undefined ? { availableModels: deps.availableModels } : {}),
    authenticatedProviders: deps.authenticatedProviders,
  });
  if (judgeBuild.judgeProvider !== null && judgeBuild.judgeProvider !== answerProvider) {
    out.write(`Judged by ${judgeBuild.judgeProvider} (cross-vendor).\n`);
  } else if (judgeBuild.judgeProvider !== null) {
    out.write(
      `Judged by ${judgeBuild.judgeProvider} (same vendor — no second vendor is signed in; ` +
        'sign in another for an honest cross-vendor check).\n',
    );
  }
  out.write('\n');

  const answerPort = makeAnswerPort({
    makeDeps: deps.makeDeps,
    answerProvider,
  });

  const run = await runEval(
    answerPort,
    judgeBuild.port,
    signal,
    {
      timestamp: deps.nowIso(),
      version: deps.version,
      provenance: {
        answerProvider,
        judgeProvider: judgeBuild.judgeProvider ?? '',
      },
    },
    (done, total, promptId) => {
      out.write(`  [${done}/${total}] ${promptId}\n`);
    },
  );

  // Store first (so a render failure never loses the measured run), then print.
  try {
    await appendEvalRun(deps.cwd, run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.write(`[warn] could not store run: ${msg}\n`);
  }

  out.write('\n');
  for (const line of formatScorecard(run)) out.write(line + '\n');
  out.write('\nStored. Compare against a later run with: myshell eval --compare\n');

  // Exit non-zero only if NOTHING was judged (the run produced no signal at all).
  return run.scorecard.judgedCount > 0 ? 0 : 1;
}
