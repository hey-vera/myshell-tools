/**
 * src/commands/cost.ts — `myshell-tools cost` spend-summary command.
 *
 * Reads the on-disk ledger, computes real totals, and prints an honest
 * per-model breakdown together with a counterfactual "what if you had used
 * the manager-tier flagship for every call?" comparison.
 *
 * Counterfactual (apples-to-apples)
 * ---------------------------------
 * The "Billed total" is the real amount from the ledger (includes caching and
 * discounts). The counterfactual compares ONLY like-for-like list prices:
 *   routed   = sum over entries of listPrice(entry.model) × entry tokens
 *   flagship = sum over entries of listPrice(manager flagship) × entry tokens
 *   multiplier = flagship / routed
 * We never compare the cache-adjusted billed total against a list-price flagship
 * estimate — that would understate flagship and mislead.
 *
 * Honesty contract: every figure comes from the real ledger; no values are
 * fabricated. If the ledger is empty the command says so and returns 0.
 */

import type { LedgerEntry } from '../core/types.js';
import type { OutputSink } from '../interface/render.js';
import { readLedger, summarizeLedger } from '../infra/ledger.js';
import { formatTokens } from '../infra/insights.js';
import { getCheapestForTier, calculateCost, calculateEffectiveCost, getModelPricing } from '../infra/pricing.js';
import { bold, dim, cyan, divider, label } from '../ui/theme.js';

// ---------------------------------------------------------------------------
// Pure report builder — testable with hand-built LedgerEntry[]
// ---------------------------------------------------------------------------

/**
 * Build the cost-report lines from a (possibly empty) ledger entry array.
 *
 * Pure function: no I/O, no process.exit, no Date/Math.random.
 * Called by runCost after reading the real ledger, and by unit tests.
 */
export function formatCostReport(entries: LedgerEntry[], color = false, opts?: { cacheAccountingV2?: boolean }): string[] {
  if (entries.length === 0) {
    return ['No usage recorded yet. Run a task first, e.g.  myshell-tools run "summarize this repo"'];
  }

  const summary = summarizeLedger(entries);
  // Counterfactual uses the flagship from paid providers only (claude/codex).
  // opencode's zero-cost sentinel entries must not suppress the counterfactual
  // by making the "flagship" appear free.
  const flagship = getCheapestForTier('manager', ['claude', 'codex']);

  // Apples-to-apples: price BOTH the models actually used AND the flagship on the
  // SAME basis (list price × tokens). We do NOT compare the billed total (which
  // includes caching/discounts) against a list-price flagship estimate.
  // Also accumulate REAL token totals (overall + per model) — the honest signal.
  let routedListUsd = 0;
  let flagshipListUsd = 0;
  let totalTokens = 0;
  const tokensByModel: Record<string, number> = {};
  for (const entry of entries) {
    const entryTokens = entry.inputTokens + entry.outputTokens;
    totalTokens += entryTokens;
    tokensByModel[entry.model] = (tokensByModel[entry.model] ?? 0) + entryTokens;

    const entryPricing = getModelPricing(entry.provider, entry.model);
    if (entryPricing) {
      routedListUsd += calculateCost(entry.inputTokens, entry.outputTokens, entryPricing);
    }
    flagshipListUsd += calculateCost(entry.inputTokens, entry.outputTokens, flagship);
  }

  const lines: string[] = [];

  lines.push(bold('myshell-tools — usage & efficiency', color));
  lines.push(divider(color));

  // ---- Usage (REAL, measured) -----------------------------------------------
  // Tokens are measured, not estimated — the trustworthy primary figure.
  lines.push(`${label('Model calls', color)}: ${summary.calls}`);
  lines.push(`${label('Tokens used', color)}: ${formatTokens(totalTokens)} ${dim('(real, measured)', color)}`);

  lines.push(divider(color));
  lines.push(bold('Per-model usage', color));
  for (const [model, ms] of Object.entries(summary.byModel)) {
    const callStr = ms.calls === 1 ? '1 call' : `${ms.calls} calls`;
    lines.push(
      `  ${cyan(model, color)}: ${callStr}, ${formatTokens(tokensByModel[model] ?? 0)} tokens`,
    );
  }

  lines.push(divider(color));

  // ---- Routing efficiency (billing-agnostic ratio) --------------------------
  // The savings RATIO is honest regardless of billing model: it compares how
  // many flagship tokens you avoided by routing to cheaper tiers. This is the
  // value-prop number, and it holds true on a subscription too.
  lines.push(bold('Routing efficiency', color));
  if (routedListUsd > 0 && flagshipListUsd > routedListUsd) {
    const multiplier = flagshipListUsd / routedListUsd;
    lines.push(
      `Routing picked cheaper-tier models where it could — ` +
        `${cyan(`~${multiplier.toFixed(1)}× less`, color)} than sending every task to ` +
        `the flagship (${flagship.model}).`,
    );
  } else if (routedListUsd > 0) {
    lines.push(
      dim('Every task already used a flagship-tier (or pricier) model — no routing savings to show.', color),
    );
  } else {
    lines.push(
      dim('No priced models in the ledger — cannot compute a routing comparison.', color),
    );
  }

  // ---- Cache accounting (opt-in) ------------------------------------------
  if (opts?.cacheAccountingV2 === true) {
    let totalCacheReads = 0;
    let totalCacheWrites = 0;
    let effectiveEstimate = 0;
    let naiveEstimate = 0;
    for (const entry of entries) {
      const entryCacheReads = entry.cachedInputTokens ?? 0;
      const entryCacheWrites = entry.cacheWriteInputTokens ?? 0;
      totalCacheReads += entryCacheReads;
      totalCacheWrites += entryCacheWrites;

      const entryPricing = getModelPricing(entry.provider, entry.model);
      if (entryPricing) {
        effectiveEstimate += calculateEffectiveCost(
          entry.inputTokens, entry.outputTokens, entryPricing,
          { cachedInputTokens: entryCacheReads, cacheWriteInputTokens: entryCacheWrites },
        );
        naiveEstimate += calculateCost(entry.inputTokens, entry.outputTokens, entryPricing);
      }
    }

    lines.push(divider(color));
    lines.push(bold('Cache accounting', color));
    lines.push(`${label('Total cache reads', color)}: ${formatTokens(totalCacheReads)}`);
    lines.push(`${label('Total cache writes', color)}: ${formatTokens(totalCacheWrites)}`);
    lines.push(`${label('Cache-aware effective estimate', color)}: $${effectiveEstimate.toFixed(4)} ${dim('(list-pricing estimate, not a subscription bill)', color)}`);
    lines.push(`${label('Naive list estimate', color)}: $${naiveEstimate.toFixed(4)} ${dim('(list-pricing estimate, not a subscription bill)', color)}`);
  }

  // No dollar figures. myshell-tools drives your SUBSCRIPTION CLIs — you pay a
  // flat fee, not per token — so a "$x.xx" estimate would be fiction dressed as a
  // bill. Tokens are the honest unit; the efficiency RATIO above is billing-
  // agnostic. (List prices are still used INTERNALLY to compute that ratio, but
  // never displayed as a cost.)
  return lines;
}

// ---------------------------------------------------------------------------
// I/O runner — called by cli.ts
// ---------------------------------------------------------------------------

/**
 * Read the ledger for `cwd`, build the cost report, and write it to `out`.
 *
 * Returns 0 always (cost reporting is informational, not an error condition).
 * Never calls process.exit — that is handled exclusively by src/cli.ts.
 */
export async function runCost(cwd: string, out: OutputSink): Promise<number> {
  // FIX 5: readLedger re-throws non-ENOENT errors (a permission/IO fault on the
  // ledger file). The home menu's [$] handler has no catch, so an escaping error
  // would crash the whole menu. Fail soft here — matching the menu's own spend read
  // (`.catch(() => [])`) — so a broken ledger prints a friendly note and returns
  // cleanly to the menu instead of taking it down. A missing ledger already reads as
  // [] inside readLedger, so this only changes the genuine-error path.
  let entries: Awaited<ReturnType<typeof readLedger>>;
  try {
    entries = await readLedger(cwd);
  } catch {
    out.write('Could not read the usage ledger right now — try again later.\n');
    return 0;
  }
  const lines = formatCostReport(entries, out.color, { cacheAccountingV2: true });
  for (const line of lines) {
    out.write(line + '\n');
  }
  return 0;
}
