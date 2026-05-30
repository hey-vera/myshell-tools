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
    return ['No usage recorded yet — run a task first.'];
  }

  const summary = summarizeLedger(entries);
  // Counterfactual uses the flagship from paid providers only (claude/codex).
  // opencode's zero-cost sentinel entries must not suppress the counterfactual
  // by making the "flagship" appear free.
  const flagship = getCheapestForTier('manager', ['claude', 'codex']);

  // Apples-to-apples: price BOTH the models actually used AND the flagship on the
  // SAME basis (list price × tokens). We do NOT compare the billed total (which
  // includes caching/discounts) against a list-price flagship estimate.
  let routedListUsd = 0;
  let flagshipListUsd = 0;
  for (const entry of entries) {
    const entryPricing = getModelPricing(entry.provider, entry.model);
    if (entryPricing) {
      routedListUsd += calculateCost(entry.inputTokens, entry.outputTokens, entryPricing);
    }
    flagshipListUsd += calculateCost(entry.inputTokens, entry.outputTokens, flagship);
  }

  const lines: string[] = [];

  lines.push(bold('myshell-tools cost', color));
  lines.push(divider(color));

  // ---- Summary ---------------------------------------------------------------
  lines.push(
    `${label('Billed total', color)}: $${summary.totalUsd.toFixed(4)} ` +
      `${dim('(as billed, incl. caching/discounts)', color)}`,
  );
  lines.push(`${label('Total calls', color)}: ${summary.calls}`);

  lines.push(divider(color));

  // ---- Per-model breakdown ---------------------------------------------------
  lines.push(bold('Per-model breakdown', color));
  for (const [model, ms] of Object.entries(summary.byModel)) {
    const callStr = ms.calls === 1 ? '1 call' : `${ms.calls} calls`;
    lines.push(
      `  ${cyan(model, color)}: ${callStr}, $${ms.usd.toFixed(4)}`,
    );
  }

  lines.push(divider(color));

  // ---- Counterfactual (list-price, token-for-token, apples-to-apples) --------
  const flagshipLabel = `${flagship.model} (${flagship.tier} tier)`;
  lines.push(bold('Counterfactual — list price, token-for-token', color));
  lines.push(
    `${dim('Flagship model', color)}: ${flagshipLabel}` +
      `  ${dim(`($${flagship.inputPer1M}/M in, $${flagship.outputPer1M}/M out)`, color)}`,
  );
  lines.push(`${label('Routed (models used)', color)}: $${routedListUsd.toFixed(4)}`);
  lines.push(`${label('Always-flagship', color)}:      $${flagshipListUsd.toFixed(4)}`);

  if (routedListUsd > 0 && flagshipListUsd > routedListUsd) {
    const multiplier = flagshipListUsd / routedListUsd;
    lines.push(
      `Routing saved you money: always-flagship would cost ${multiplier.toFixed(1)}x more ` +
        `($${flagshipListUsd.toFixed(4)} vs $${routedListUsd.toFixed(4)} at list price).`,
    );
  } else if (routedListUsd > 0) {
    lines.push(
      'Every call already used a flagship-tier (or pricier) model — no routing savings to show.',
    );
  } else {
    lines.push(
      dim('No priced models in the ledger — cannot compute a list-price comparison.', color),
    );
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
