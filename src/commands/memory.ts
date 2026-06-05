/**
 * src/commands/memory.ts — shared user-memory command logic (Phase 5,
 * docs/memory-architecture-5.5.md §8 "Capture UX + User Control").
 *
 * This module owns the BEHAVIOUR of the explicit memory commands (`/remember`,
 * `/forget`, `/memory[ all/edit/export/loaded]`), the model-proposed-memory
 * approval selector (`remember_user` → Save/Skip/Edit), and the CLI one-shot
 * subcommands (`memory list|add|forget|export`). The chat-loop dispatch in
 * `menu.ts` and the subcommand dispatch in `cli.ts` are thin shims onto these.
 *
 * Design:
 *   - Each handler takes an injected `OutputSink`, an injected `readLine` (so the
 *     numbered selectors are testable WITHOUT a TTY — the same pattern as
 *     `runQuestionSelector`), and the `UserMemoryStore` (Phase 3). NO model call:
 *     the kind/subject are inferred deterministically by the pure core
 *     (`worthGate`, `normalizeSubject`, `decideConsolidation`). This is
 *     subscription-auth — memory never costs a turn.
 *   - The write path always runs `worthGate` BEFORE any disk write or any echo,
 *     so a secret is refused WITHOUT echoing the value (§8(a), §10).
 *   - `commit()` runs `decideConsolidation` internally; we report the op
 *     (Remembered / Updated / Replaced / already known).
 *
 * Pure-ish: the only impurity is the injected store + injected reader + the
 * injected clock (via the store) + an injected `writeFile` for export. No
 * `Date`/`Math.random`/`console`.
 */

import type { OutputSink } from '../interface/render.js';
import { dim, green, bold } from '../ui/theme.js';
import {
  worthGate,
  type Candidate,
  type MemoryScope,
  type MemoryKind,
  type MemoryShape,
  type RememberProposal,
  type ProposedFact,
  type UserMemoryFact,
} from '../core/user-memory.js';
import type { CommitResult, UserMemoryStore } from '../infra/user-memory-store.js';
import type { Clock } from '../core/types.js';
import { createFileUserMemoryStore, resolveProjectKey } from '../infra/user-memory-store.js';
import { loadConfig } from '../infra/config.js';

// ---------------------------------------------------------------------------
// Deterministic kind inference for free-text `/remember` (no model call)
// ---------------------------------------------------------------------------

const KIND_KEYWORDS: ReadonlyArray<readonly [MemoryKind, RegExp]> = [
  ['constraint', /\b(node|python|deno|bun|runtime|version|no paid|free tier|budget|platform|replit|linux|windows|macos|docker|accessib|a11y|dependenc|library|package|api|sdk|must use|never use|only use|requires?)\b/i],
  ['identity', /\b(i am a|i'm a|i am an|i'm an|work as|my role|my stack|my domain|i use|engineer|developer|designer|founder|student|fintech|healthcare)\b/i],
  ['correction', /\b(failed|didn't work|doesn't work|broke|wrong|mistake|instead of|avoid|stop using|that approach|don't do)\b/i],
  ['preference', /\b(prefer|like|want|concise|brief|short|verbose|tone|format|bullet|markdown|test|tests|tdd|always|never)\b/i],
];

/** Profile vs collection per kind (§1): only `correction` is a collection. */
function shapeForKind(kind: MemoryKind): MemoryShape {
  return kind === 'correction' ? 'collection' : 'profile';
}

/**
 * Infer a `kind` for a free-text `/remember` fact (deterministic, no model).
 * Defaults to `preference` — the most common general-purpose kind — when no
 * keyword class matches. The closed-subject `normalizeSubject` (run inside the
 * gate / consolidation) then maps the text to one allowed subject for that kind.
 */
export function inferRememberKind(text: string): MemoryKind {
  const t = (text ?? '').trim();
  if (t.length === 0) return 'preference';
  for (const [kind, re] of KIND_KEYWORDS) {
    if (re.test(t)) return kind;
  }
  return 'preference';
}

// ---------------------------------------------------------------------------
// Shared config slice + result reporting
// ---------------------------------------------------------------------------

/** Memory-relevant slice of `AppConfig` the commands consult. */
export interface MemoryCommandConfig {
  /** Master switch — `false` is the kill-switch (no writes, list still works). */
  readonly memory?: boolean;
  /** Where a scope-unspecified fact defaults (§9). Default `'project'`. */
  readonly memoryDefaultScope?: 'global' | 'project';
}

/** Whether memory writes are enabled (absent/true → on; false → kill-switch). */
export function memoryWritesEnabled(config: MemoryCommandConfig): boolean {
  return config.memory !== false;
}

/** Human one-line outcome for a commit op (§8(a)). */
export function describeCommitOutcome(result: CommitResult): string {
  switch (result.op) {
    case 'ADD':
      return `Remembered: ${result.fact?.text ?? ''}`;
    case 'UPDATE':
      return `Updated existing memory: ${result.fact?.text ?? ''}`;
    case 'SUPERSEDE':
      return `Replaced a stale fact: ${result.fact?.text ?? ''}`;
    case 'NOOP':
    default:
      if (result.flagForUser === true) {
        return 'Not saved — it conflicts with a higher-trust fact you already set.';
      }
      return 'Already known — nothing to change.';
  }
}

// ---------------------------------------------------------------------------
// /remember  (and CLI `memory add`)
// ---------------------------------------------------------------------------

export interface RememberInput {
  readonly text: string;
  readonly store: UserMemoryStore;
  readonly config: MemoryCommandConfig;
  readonly projectKey: string | null;
  /** Override the inferred scope (CLI/explicit). */
  readonly scope?: MemoryScope;
}

/**
 * Run `/remember <fact>` (and the CLI `memory add`): build a `user_stated /
 * user_explicit` candidate, run `worthGate` FIRST (so a secret is refused
 * without echo), then `store.commit` (which runs consolidation) and report the
 * outcome. Returns the printed line for testability. Never throws — store errors
 * degrade to a calm "could not save".
 */
export async function runRemember(input: RememberInput): Promise<string> {
  const text = (input.text ?? '').trim();
  if (text.length === 0) {
    return 'Usage: /remember <fact to remember>';
  }
  if (!memoryWritesEnabled(input.config)) {
    return 'Memory is off — turn it on in Settings to save facts.';
  }

  const kind = inferRememberKind(text);
  const scope: MemoryScope = input.scope ?? input.config.memoryDefaultScope ?? 'project';
  const candidate: Candidate = {
    scope,
    projectKey: scope === 'project' ? input.projectKey : null,
    shape: shapeForKind(kind),
    kind,
    subjectHint: text,
    text,
    trust: 'user_stated',
    source: 'user_explicit',
  };

  // Gate BEFORE any write or echo: a secret is refused without surfacing the value.
  const gate = worthGate(candidate);
  if (!gate.ok) {
    if (gate.reason === 'secret') {
      return 'Not saved — that looks like a secret. I never store credentials.';
    }
    if (gate.reason === 'instruction_shaped') {
      return 'Not saved — that reads like an instruction, not a fact about you.';
    }
    // transient / noise / re_derivable / empty_subject / untrusted / malformed
    return "Not saved — that doesn't look like a durable fact worth remembering.";
  }

  try {
    const result = await input.store.commit(candidate, { projectKey: input.projectKey });
    return describeCommitOutcome(result);
  } catch {
    return 'Could not save that right now — memory is unavailable.';
  }
}

// ---------------------------------------------------------------------------
// /forget  (numbered selector, or `/forget <id>` direct; CLI `memory forget <id>`)
// ---------------------------------------------------------------------------

/** Facts visible to the user in the current scope: global + this project (§8(a)). */
async function relevantFacts(
  store: UserMemoryStore,
  projectKey: string | null,
): Promise<UserMemoryFact[]> {
  const all = await store.listAll();
  return all.filter(
    (f) =>
      !f.archived &&
      f.validTo === null &&
      f.supersededBy === null &&
      (f.scope === 'global' || f.projectKey === projectKey),
  );
}

export interface ForgetInput {
  readonly store: UserMemoryStore;
  readonly projectKey: string | null;
  readonly out: OutputSink;
  readonly readLine: () => Promise<string | null>;
  /** Direct id from `/forget <id>` (skips the selector). */
  readonly id?: string;
}

/**
 * Run `/forget`: either delete the given id directly, or open a numbered selector
 * of current-scope + global facts and delete the chosen one (hard delete +
 * audit, performed by the store). Returns the outcome line. The reader is
 * injected, so the selector is testable without a TTY (Enter/blank/EOF cancels).
 */
export async function runForget(input: ForgetInput): Promise<string> {
  const { store, out, readLine } = input;

  // Direct `/forget <id>` path.
  if (input.id !== undefined && input.id.trim().length > 0) {
    const id = input.id.trim();
    const ok = await store.forget(id).catch(() => false);
    return ok ? `Forgotten ${id}.` : `No memory with id ${id}.`;
  }

  const facts = await relevantFacts(store, input.projectKey).catch(() => []);
  if (facts.length === 0) {
    return 'Nothing to forget — no facts in this scope.';
  }

  out.write('\nWhich memory should I forget?\n');
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i];
    if (f === undefined) continue;
    out.write(`  ${formatFactLine(i + 1, f, out.color)}\n`);
  }
  out.write('Pick a number, or Enter to cancel: ');

  const line = await readLine();
  const trimmed = (line ?? '').trim();
  if (trimmed.length === 0) return 'Cancelled — nothing forgotten.';
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < 1 || n > facts.length) {
    return 'Cancelled — that was not a listed number.';
  }
  const target = facts[n - 1];
  if (target === undefined) return 'Cancelled — nothing forgotten.';
  const ok = await store.forget(target.id).catch(() => false);
  return ok ? `Forgotten: ${target.text}` : 'Could not forget that right now.';
}

// ---------------------------------------------------------------------------
// /memory [all|edit <id>|export|loaded]  (and CLI `memory list|export`)
// ---------------------------------------------------------------------------

function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(iso ?? '');
  return m === null ? '' : (m[1] ?? '');
}

function trustLabel(trust: UserMemoryFact['trust']): string {
  return trust === 'user_stated' ? 'you' : trust === 'agent_inferred' ? 'inferred' : 'ingested';
}

/** A compact `[n] id · trust · date · ×uses  text` listing line. */
function formatFactLine(n: number, f: UserMemoryFact, color: boolean): string {
  const tags: string[] = [];
  if (f.scope === 'project') tags.push('this project');
  tags.push(trustLabel(f.trust));
  const date = isoDate(f.validFrom || f.createdAt);
  if (date.length > 0) tags.push(date);
  tags.push(`×${f.useCount}`);
  const head = `[${n}] ${dim(f.id, color)} ${dim(`(${tags.join(', ')})`, color)}`;
  return `${head}\n      ${f.text}`;
}

export interface MemoryListInput {
  readonly store: UserMemoryStore;
  readonly projectKey: string | null;
  readonly out: OutputSink;
  /** `all` includes archived/superseded; default lists only live facts. */
  readonly all?: boolean;
}

/**
 * Run `/memory` (default) or `/memory all`: list facts relevant to the current
 * scope + global, each with id / trust / date / use count. `all` additionally
 * shows archived + superseded facts (so the user can audit/export/forget them).
 * Returns the rendered text (also written to `out`) for testability.
 */
export async function runMemoryList(input: MemoryListInput): Promise<string> {
  const all = await input.store.listAll().catch(() => [] as UserMemoryFact[]);
  const scoped = all.filter((f) => f.scope === 'global' || f.projectKey === input.projectKey);
  const facts = input.all === true
    ? scoped
    : scoped.filter((f) => !f.archived && f.validTo === null && f.supersededBy === null);

  if (facts.length === 0) {
    const msg = input.all === true
      ? 'No memories stored yet.'
      : 'No memories for this scope yet. Type /remember <fact> to add one.';
    input.out.write(`${msg}\n`);
    return msg;
  }

  const header = input.all === true
    ? bold('All memories (incl. archived/superseded):', input.out.color)
    : bold('Memories for this scope:', input.out.color);
  const lines = facts.map((f, i) => {
    let line = formatFactLine(i + 1, f, input.out.color);
    if (input.all === true && (f.archived || f.validTo !== null || f.supersededBy !== null)) {
      line += dim('  [inactive]', input.out.color);
    }
    return line;
  });
  const body = `${header}\n${lines.map((l) => `  ${l}`).join('\n')}`;
  input.out.write(`${body}\n`);
  return body;
}

export interface MemoryLoadedInput {
  readonly out: OutputSink;
  /** The facts actually injected this session (tracked by the chat loop). */
  readonly loaded: readonly UserMemoryFact[];
}

/**
 * Run `/memory loaded`: show EXACTLY which facts were injected into a prompt this
 * session (the transparency feature, §8(a)). When nothing loaded, says so plainly
 * (so the user doesn't think memory broke). Returns the rendered text.
 */
export function runMemoryLoaded(input: MemoryLoadedInput): string {
  if (input.loaded.length === 0) {
    const msg = 'No memory has been loaded into a prompt this session yet.';
    input.out.write(`${msg}\n`);
    return msg;
  }
  const header = bold('Loaded into the model this session:', input.out.color);
  const lines = input.loaded.map((f, i) => `  ${formatFactLine(i + 1, f, input.out.color)}`);
  const body = `${header}\n${lines.join('\n')}`;
  input.out.write(`${body}\n`);
  return body;
}

/** Render a Markdown export view of facts (§8(a) `/memory export`). Pure. */
export function renderMemoryExport(facts: readonly UserMemoryFact[]): string {
  const lines: string[] = ['# myshell-tools — user memory export', ''];
  if (facts.length === 0) {
    lines.push('_No facts stored._', '');
    return lines.join('\n');
  }
  const sorted = [...facts].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1));
  for (const f of sorted) {
    const date = isoDate(f.validFrom || f.createdAt);
    const status = f.archived
      ? 'archived'
      : f.supersededBy !== null
        ? 'superseded'
        : f.validTo !== null
          ? 'invalidated'
          : 'active';
    lines.push(`- **${f.text}**`);
    lines.push(
      `  - id: \`${f.id}\` · kind: ${f.kind}/${f.subject} · scope: ${f.scope}` +
        ` · trust: ${trustLabel(f.trust)} · uses: ${f.useCount} · ${status}${date.length > 0 ? ` · ${date}` : ''}`,
    );
    if (f.reason.trim().length > 0) lines.push(`  - why: ${f.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface MemoryExportInput {
  readonly store: UserMemoryStore;
  readonly out: OutputSink;
  /** Absolute path to write the Markdown export to. */
  readonly path: string;
  /** Injected file writer (so the command is testable without disk). */
  readonly writeFile: (path: string, data: string) => Promise<void>;
}

/**
 * Run `/memory export`: render ALL facts (incl. archived/superseded for a full
 * audit view) as Markdown and write it to `path` via the injected writer.
 * Returns the outcome line.
 */
export async function runMemoryExport(input: MemoryExportInput): Promise<string> {
  const facts = await input.store.listAll().catch(() => [] as UserMemoryFact[]);
  const md = renderMemoryExport(facts);
  try {
    await input.writeFile(input.path, md);
    return `Exported ${facts.length} memor${facts.length === 1 ? 'y' : 'ies'} to ${input.path}`;
  } catch {
    return `Could not write the export to ${input.path}.`;
  }
}

// ---------------------------------------------------------------------------
// Model-proposed memory approval — Save / Skip / Edit (mirrors ask_user)
// ---------------------------------------------------------------------------

/**
 * Gate a parsed `remember_user` proposal: keep only the facts that pass
 * `worthGate` as `agent_inferred / model_proposed` candidates (so a secret or
 * noise never even surfaces as a proposal — §8(b)). Returns the surviving facts.
 * PURE; never throws.
 */
export function gateProposal(
  proposal: RememberProposal | null,
  projectKey: string | null,
): readonly ProposedFact[] {
  if (proposal === null) return [];
  const kept: ProposedFact[] = [];
  for (const f of proposal.facts) {
    const candidate = proposedToCandidate(f, projectKey);
    if (worthGate(candidate).ok) kept.push(f);
  }
  return kept;
}

/** Build a store Candidate from a model-proposed fact. */
function proposedToCandidate(f: ProposedFact, projectKey: string | null): Candidate {
  return {
    scope: f.scope,
    projectKey: f.scope === 'project' ? projectKey : null,
    shape: shapeForKind(f.kind),
    kind: f.kind,
    subjectHint: f.text,
    text: f.text,
    reason: f.reason,
    trust: 'agent_inferred',
    source: 'model_proposed',
  };
}

export interface MemoryApprovalInput {
  readonly proposal: RememberProposal;
  readonly store: UserMemoryStore;
  readonly projectKey: string | null;
  readonly out: OutputSink;
  readonly readLine: () => Promise<string | null>;
  readonly config: MemoryCommandConfig;
}

/**
 * Run the `remember_user` Save / Skip / Edit approval selector after the normal
 * answer has rendered (§8(b)). Mirrors the `ask_user` selector machinery (an
 * injected line reader, numbered choices) — NOT the menu raw-input internals.
 * Only the gate-passing facts are offered; each is approved individually:
 *   - Save  → commit (after consolidation) + "Remembered: …"
 *   - Edit  → read a replacement line, re-gate, commit
 *   - Skip  → nothing stored ("Skipped").
 * Returns the lines printed (for testability). Never throws.
 *
 * IMPORTANT: this function reads the user's choice via the SAME injected reader
 * as the chat prompt; it must only ever be reached from the post-turn slot AFTER
 * `discard-typeahead` (MASTER-PLAN MF3) so a queued line can never become a Save.
 */
export async function runMemoryApproval(input: MemoryApprovalInput): Promise<readonly string[]> {
  const { out, readLine } = input;
  const printed: string[] = [];
  const say = (s: string): void => {
    out.write(`${s}\n`);
    printed.push(s);
  };

  if (!memoryWritesEnabled(input.config)) return printed;

  const facts = gateProposal(input.proposal, input.projectKey);
  if (facts.length === 0) return printed;

  for (const f of facts) {
    out.write(`\n${bold('Remember this for future chats?', out.color)}\n`);
    out.write(`  ${dim('“', out.color)}${f.text}${dim('”', out.color)}\n`);
    out.write('  [1] Save   [2] Skip   [3] Edit\n');
    out.write('Pick one, or Enter to skip: ');

    const choice = (await readLine().catch(() => null) ?? '').trim();

    if (choice === '1' || /^s(ave)?$/i.test(choice)) {
      say(await commitProposed(input, f, f.text));
      continue;
    }
    if (choice === '3' || /^e(dit)?$/i.test(choice)) {
      out.write('Type the corrected fact: ');
      const edited = (await readLine().catch(() => null) ?? '').trim();
      if (edited.length === 0) {
        say(dim('Skipped.', out.color));
        continue;
      }
      say(await commitProposed(input, f, edited));
      continue;
    }
    // '2', blank, EOF, or anything else → Skip (nothing stored).
    say(dim('Skipped.', out.color));
  }

  return printed;
}

/** Commit one approved/edited proposed fact; re-gate the edited text. */
async function commitProposed(
  input: MemoryApprovalInput,
  f: ProposedFact,
  text: string,
): Promise<string> {
  const candidate: Candidate = {
    ...proposedToCandidate({ ...f, text }, input.projectKey),
  };
  // Re-gate (the edit may have introduced a secret / instruction).
  const gate = worthGate(candidate);
  if (!gate.ok) {
    if (gate.reason === 'secret') {
      return 'Not saved — that looks like a secret. I never store credentials.';
    }
    return "Not saved — that doesn't look like a durable fact.";
  }
  try {
    const result = await input.store.commit(candidate, { projectKey: input.projectKey });
    return green(describeCommitOutcome(result), input.out.color);
  } catch {
    return 'Could not save that right now — memory is unavailable.';
  }
}

// ---------------------------------------------------------------------------
// CLI one-shot subcommands — `memory list|add "<fact>"|forget <id>|export`
// ---------------------------------------------------------------------------

/**
 * Drive the CLI `memory` subcommands (§8(a) "CLI one-shot equivalents"):
 *   - `memory list`        — list current-scope + global live facts
 *   - `memory add "<fact>"` — `/remember` (writes user_stated/user_explicit)
 *   - `memory forget <id>` — hard delete by id
 *   - `memory export`      — write a Markdown view to `<cwd>/myshell-memory.md`
 *
 * Returns the process exit code (0 ok, 1 on a usage error). Never calls
 * `process.exit` — `cli.ts` owns that. Injected `store` + `clock` keep it
 * testable; defaults wire the real file store. NO model call.
 */
export async function runMemoryCli(
  args: readonly string[],
  cwd: string,
  out: OutputSink,
  clock: Clock,
  deps?: {
    store?: UserMemoryStore;
    projectKey?: string | null;
    config?: MemoryCommandConfig;
    writeFile?: (path: string, data: string) => Promise<void>;
    join?: (a: string, b: string) => string;
  },
): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase();
  const store = deps?.store ?? createFileUserMemoryStore({ clock });
  const config = deps?.config ?? (await loadConfig().catch(() => ({}) as MemoryCommandConfig));
  const projectKey =
    deps?.projectKey !== undefined ? deps.projectKey : await resolveProjectKey(cwd).catch(() => null);

  if (sub === 'list' || sub === '') {
    await runMemoryList({ store, projectKey, out });
    return 0;
  }

  if (sub === 'add') {
    const text = args.slice(1).join(' ').trim();
    if (text.length === 0) {
      out.write('Usage: myshell-tools memory add "<fact to remember>"\n');
      return 1;
    }
    out.write(`${await runRemember({ text, store, config, projectKey })}\n`);
    return 0;
  }

  if (sub === 'forget') {
    const id = (args[1] ?? '').trim();
    if (id.length === 0) {
      out.write('Usage: myshell-tools memory forget <id>\n');
      return 1;
    }
    const ok = await store.forget(id).catch(() => false);
    out.write(ok ? `Forgotten ${id}.\n` : `No memory with id ${id}.\n`);
    return ok ? 0 : 1;
  }

  if (sub === 'export') {
    const joiner = deps?.join ?? ((a: string, b: string): string => `${a}/${b}`);
    const path = joiner(cwd, 'myshell-memory.md');
    const writeFile =
      deps?.writeFile ??
      (async (p: string, data: string): Promise<void> => {
        const { writeFile: wf } = await import('node:fs/promises');
        await wf(p, data, 'utf8');
      });
    out.write(`${await runMemoryExport({ store, out, path, writeFile })}\n`);
    return 0;
  }

  out.write('Usage: myshell-tools memory list | add "<fact>" | forget <id> | export\n');
  return 1;
}
