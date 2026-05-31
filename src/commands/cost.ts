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
import { getCheapestForTier, calculateCost, getModelPricing } from '../infra/pricing.js';
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
export function formatCostReport(entries: LedgerEntry[], color = false): string[] {
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
  lines.push(`${label('Tasks run', color)}:   ${summary.calls}`);
  lines.push(`${label('Tokens used', color)}: ${formatTokens(totalTokens)} ${dim('(real, measured)', color)}`);

  lines.push(divider(color));
  lines.push(bold('Per-model usage', color));
  for (const [model, ms] of Object.entries(summary.byModel)) {
    const callStr = ms.calls === 1 ? '1 task' : `${ms.calls} tasks`;
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

  // ---- Estimated cost (API-equivalent, NOT your subscription bill) ----------
  // myshell-tools drives your SUBSCRIPTION CLIs — you pay a flat fee, not per
  // token. This is a rough "if this were metered API usage" estimate, shown for
  // devs who want the magnitude; it is not what you are billed. Both figures use
  // the SAME basis (list price × tokens) so "routed vs always-flagship" is
  // apples-to-apples and internally consistent (routed never exceeds flagship).
  lines.push(divider(color));
  lines.push(bold('Estimated cost', color) + dim('  — API-equivalent (list price), not your subscription bill', color));
  if (routedListUsd > 0) {
    let line = `${label('Routed', color)}: ~$${routedListUsd.toFixed(4)}`;
    if (flagshipListUsd > routedListUsd) {
      line += `   ·   ${dim(`always-flagship: ~$${flagshipListUsd.toFixed(4)}`, color)}`;
    }
    lines.push(line);
  } else {
    lines.push(dim('No priced models in the ledger — no estimate available.', color));
  }

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
  const entries = await readLedger(cwd);
  const lines = formatCostReport(entries, out.color);
  for (const line of lines) {
    out.write(line + '\n');
  }
  return 0;
}
