/**
 * src/commands/rules.ts — the shared command logic for STANDING RULES (Phase 4).
 *
 * THE MODEL: a Rule is EXPLICIT user policy the partner remembers + enforces
 * ("always use automerge", "never touch package-lock.json", "pause before any
 * security-type goal"). These handlers let a user ADD a rule (`/rule add <text>`),
 * LIST rules (`/rule list`), and REMOVE one (`/rule rm <n>`). The chat-loop
 * dispatch in menu.ts is a thin shim onto these.
 *
 * Design (mirrors src/commands/goals.ts):
 *   - Each handler takes an injected `OutputSink` + the `RulesStore`.
 *   - NO model call: parsing `/rule add` is a DETERMINISTIC parser (rules.ts
 *     parseRule) — subscription-clean, never costs a turn.
 *
 * THE BOUNDARY (owner): a rule is authored by the user, trusted by construction;
 * it deliberately does NOT route through user-memory's `isInstructionShaped` gate
 * (that gate is for ingested facts, and is exactly why a rule could never be
 * stored before).
 */

import type { OutputSink } from '../interface/render.js';
import { dim, green, bold } from '../ui/theme.js';
import type { RulesStore } from '../infra/rules-store.js';
import { parseRule, type Rule, type RuleKind, type RuleTrigger } from '../core/rules.js';

// ---------------------------------------------------------------------------
// Pure arg parsing — `/rule <sub> [args]`
// ---------------------------------------------------------------------------

export type RuleCommand =
  | { readonly kind: 'add'; readonly text: string }
  | { readonly kind: 'list' }
  | { readonly kind: 'rm'; readonly n: number }
  | { readonly kind: 'usage' };

/**
 * Parse the argument string after `/rule`. Pure, never throws. Bare or `list` →
 * list; `add <text>` → add; `rm|remove|delete <n>` → remove rule #n (1-based); an
 * unrecognised form → usage.
 */
export function parseRuleCommand(arg: string): RuleCommand {
  const trimmed = (arg ?? '').trim();
  if (trimmed === '' || trimmed === 'list' || trimmed === 'ls') return { kind: 'list' };

  const add = /^add\s+(.+)$/s.exec(trimmed);
  if (add !== null) {
    const text = (add[1] ?? '').trim();
    if (text.length > 0) return { kind: 'add', text };
  }

  const rm = /^(rm|remove|delete|del)\s+(\d+)$/.exec(trimmed);
  if (rm !== null) {
    const n = Number.parseInt(rm[2] ?? '', 10);
    if (Number.isFinite(n) && n >= 1) return { kind: 'rm', n };
  }

  return { kind: 'usage' };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/** A short kind word for display: NEVER / PAUSE / PREFER. Pure, total. */
function kindLabel(kind: RuleKind): string {
  switch (kind) {
    case 'block':
      return 'NEVER';
    case 'prefer':
      return 'PREFER';
    case 'pause':
    default:
      return 'PAUSE';
  }
}

/** A short, human description of a rule's trigger. Pure, total. */
function triggerLabel(trigger: RuleTrigger): string {
  const parts: string[] = [];
  if (trigger.category !== undefined) parts.push(`${trigger.category} work`);
  if (trigger.pathGlob !== undefined && trigger.pathGlob.length > 0) parts.push(trigger.pathGlob);
  if (trigger.keyword !== undefined && trigger.keyword.length > 0) parts.push(`"${trigger.keyword}"`);
  return parts.length > 0 ? parts.join(', ') : 'any action';
}

/** One numbered display row for a rule. Pure. */
function formatRuleRow(rule: Rule, index1: number): string {
  const scope = rule.scope === 'global' ? 'global' : 'this repo';
  return `${index1}. [${kindLabel(rule.kind)} · ${triggerLabel(rule.trigger)}] ${rule.text} · ${scope}`;
}

// ---------------------------------------------------------------------------
// /rule add <text>
// ---------------------------------------------------------------------------

/**
 * Create a standing rule from `/rule add <text>`. Parses the free text with the
 * DETERMINISTIC parseRule (no model call), then persists. Returns the printed
 * message string (for testability). Never throws — a store error degrades calmly.
 */
export async function runRuleAdd(opts: {
  readonly store: RulesStore;
  readonly out: OutputSink;
  readonly text: string;
  readonly projectKey: string | null;
}): Promise<string> {
  const parsed = parseRule(opts.text);
  if (parsed === null) {
    const msg = 'Usage: /rule add <a standing rule> — e.g. "always use automerge" or "pause before any security goal".';
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  try {
    const rule = await opts.store.create({
      kind: parsed.kind,
      trigger: parsed.trigger,
      text: parsed.text,
      scope: opts.projectKey !== null ? 'project' : 'global',
      projectKey: opts.projectKey,
    });
    const msg = `Rule saved — [${kindLabel(rule.kind)} · ${triggerLabel(rule.trigger)}] ${rule.text}. /rule list to manage.`;
    opts.out.write(`  ${green('●', opts.out.color)} ${msg}\n`);
    return msg;
  } catch {
    const msg = 'Could not save that rule right now.';
    opts.out.write(`  ${msg}\n`);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// /rule list
// ---------------------------------------------------------------------------

/** The rules, newest-first — the canonical 1-based display index order. */
async function listRules(store: RulesStore): Promise<Rule[]> {
  try {
    return await store.list();
  } catch {
    return [];
  }
}

/** Resolve a 1-based index into the rules list, or null when out of range. */
function ruleAt(rules: readonly Rule[], n: number): Rule | null {
  if (!Number.isFinite(n) || n < 1 || n > rules.length) return null;
  return rules[n - 1] ?? null;
}

/**
 * The `/rule list` view. Returns the printed text (for testability). Never
 * throws — a store error degrades to a calm note.
 */
export async function runRulesList(opts: {
  readonly store: RulesStore;
  readonly out: OutputSink;
}): Promise<string> {
  let rules: Rule[] = [];
  try {
    rules = await opts.store.list();
  } catch {
    const msg = 'Could not read your rules right now.';
    opts.out.write(`  ${msg}\n`);
    return msg;
  }
  if (rules.length === 0) {
    const msg = 'No standing rules yet. Add one with /rule add <text>.';
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  const lines: string[] = [bold(`  Standing rules (${rules.length})`, opts.out.color)];
  rules.forEach((r, i) => lines.push(`    ${formatRuleRow(r, i + 1)}`));
  lines.push(dim('  /rule add <text> to add · /rule rm <n> to remove', opts.out.color));
  const text = lines.join('\n');
  opts.out.write(`${text}\n`);
  return text;
}

// ---------------------------------------------------------------------------
// /rule rm <n>
// ---------------------------------------------------------------------------

/** `/rule rm <n>` — remove rule #n (1-based). Returns the printed message. */
export async function runRuleRemove(opts: {
  readonly store: RulesStore;
  readonly out: OutputSink;
  readonly n: number;
}): Promise<string> {
  const rules = await listRules(opts.store);
  const target = ruleAt(rules, opts.n);
  if (target === null) {
    const msg = `No rule #${opts.n}. Run /rule list to see them.`;
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  try {
    await opts.store.remove(target.id);
  } catch {
    /* fail-soft: report removal regardless — the index purge is best-effort */
  }
  const msg = `Removed rule: ${target.text}.`;
  opts.out.write(`  ${msg}\n`);
  return msg;
}
