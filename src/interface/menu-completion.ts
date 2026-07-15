/**
 * src/interface/menu-completion.ts — Smart Tab completion (T1–T4).
 *
 * Extracted from menu.ts — behavior-preserving, pure helpers.
 *
 * A pure dispatcher `classifyCompletion` inspects the line and routes Tab to
 * one of: slash-name (T1), slash-ARGUMENT (T2), file/PATH or @-MENTION (T3),
 * with FUZZY ranking (T4) layered over slash-name/arg. The single impure
 * async completer `completeChat` composes these over an injected `fs.readdir`
 * port so unit tests stay filesystem-free. No model call: instant, local,
 * deterministic. Plain prose → strict no-op (never corrupt a sentence).
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { createFileGoalStore } from '../infra/goal-store.js';
import { createFileUserMemoryStore, resolveProjectKey } from '../infra/user-memory-store.js';
import { createFileRulesStore } from '../infra/rules-store.js';
import { defaultStateContext } from '../infra/state-layout.js';
import type { Goal } from '../core/goal-todo.js';
import type { UserMemoryFact } from '../core/user-memory.js';
import type { Rule } from '../core/rules.js';
import type { Clock } from '../core/types.js';

/**
 * The slash-commands available at the chat prompt — the canonical command set
 * (Tab T1, docs/tab-completion-5.5.md). Tab-completion offers exactly these;
 * keep in sync with the dispatch in `runOneChatInput` (/retry, /edit, /style,
 * /oversight, /mode, /goal, /goals, /todo, /rule, /recap, /remember, /forget,
 * /memory, /help, /back, /exit).
 * Ordered most-used first.
 */
export const CHAT_SLASH_COMMANDS: readonly string[] = [
  '/help',
  '/retry',
  '/edit',
  '/style',
  '/oversight',
  '/mode',
  '/speed',
  '/goal',
  '/goals',
  '/todo',
  '/rule',
  '/recap',
  '/copy',
  '/export',
  '/remember',
  '/forget',
  '/memory',
  '/back',
  '/exit',
];

/**
 * Pure completer for a readline `completer` option, scoped to slash-commands.
 *
 * Returns `[hits, line]` per the Node readline contract. Only fires for a line
 * that starts with `/` (the chat prompt is otherwise free-form prose, where
 * shell-style completion would corrupt sentences), and only when there is more
 * than one candidate or a genuine prefix to extend — so pressing Tab on plain
 * text is a harmless no-op. Never throws.
 *
 * @param line     the current input line (substring up to the cursor)
 * @param commands the candidate command set (defaults to the chat commands)
 */
export function completeSlash(
  line: string,
  commands: readonly string[] = CHAT_SLASH_COMMANDS,
): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const hits = commands.filter((c) => c.startsWith(line));
  // Return all commands as the candidate list when the bare `/` is typed, so
  // readline lists them; otherwise the filtered prefix matches.
  return [hits.length > 0 ? hits : [], line];
}

/**
 * Per-command argument candidate sets for slash-argument completion (T2).
 * Keyed by the canonical command. A command absent from this map (or mapped to
 * `null`) takes FREE-TEXT args and is never completed — e.g. `/goal` (a goal
 * sentence) and `/remember`/`/forget`/`/edit` (free text / numeric id), so Tab
 * never mangles them. The values are the user-facing labels accepted by the
 * dispatch (`/mode` → the tiers, `/style` → the styles, `/memory` → its
 * subcommands).
 */
export const CHAT_SLASH_ARG_MAP: Readonly<Record<string, readonly string[]>> = {
  '/mode': ['Budget', 'Balanced', 'High', 'Max', 'Auto'],
  '/speed': ['Auto', '1', '2', '3', '4', '5'],
  '/style': ['Direct', 'Balanced', 'Collaborative'],
  '/memory': ['list', 'all', 'loaded', 'export', 'edit'],
  '/goals': ['list', 'show', 'go', 'drop', 'cancel'],
};

/** A classified Tab-completion request. PURE output of {@link classifyCompletion}. */
type CompletionKind = 'slash-name' | 'slash-arg' | 'path' | 'mention' | 'none';
export interface Completion {
  readonly kind: CompletionKind;
  /** For 'slash-arg': the canonical command (e.g. '/mode'). */
  readonly command?: string;
  /** The trailing token the candidates are matched against (the readline `substring`). */
  readonly token: string;
  /** Index where the trailing token starts in `line` (so `substring` covers exactly it). */
  readonly prefixLen: number;
}

/** True when a token looks like a filesystem path (conservative — drives prose no-op). */
function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    token.startsWith('~/') ||
    token === '~' ||
    token === '.' ||
    token === '..' ||
    // An embedded slash anywhere (e.g. `src/inter`) — a clear path signal, but
    // NOT a bare slash-command (handled separately) and NOT plain prose.
    (token.includes('/') && !token.startsWith('/'))
  );
}

/**
 * Pure dispatcher: classify the trailing token of `line` into a completion kind.
 *
 * The single load-bearing safety property is that ordinary prose returns
 * `kind: 'none'` — only a clear signal (`/` command, a path-shaped token, or a
 * leading `@`) routes to an active completer. PURE; never throws.
 */
export function classifyCompletion(
  line: string,
  argMap: Readonly<Record<string, readonly string[]>> = CHAT_SLASH_ARG_MAP,
): Completion {
  const text = typeof line === 'string' ? line : '';
  // The trailing token = text after the last whitespace run.
  const lastWs = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t'));
  const token = lastWs === -1 ? text : text.slice(lastWs + 1);
  const prefixLen = lastWs === -1 ? 0 : lastWs + 1;

  // @-mention: trailing token starts with '@' (Claude-Code-style file mention).
  if (token.startsWith('@')) {
    return { kind: 'mention', token, prefixLen };
  }

  // Slash command name vs argument. A slash only counts when it's the FIRST
  // token of the line (a leading-`/` line); a mid-sentence `/` is prose/path.
  const trimmedStart = text.replace(/^\s+/, '');
  if (trimmedStart.startsWith('/')) {
    const firstSpace = text.search(/\s/);
    if (firstSpace === -1) {
      // No space yet → completing the command NAME itself.
      return { kind: 'slash-name', token: text, prefixLen: 0 };
    }
    // There is a space → completing the ARGUMENT of a known command.
    const command = text.slice(0, firstSpace);
    if (Object.prototype.hasOwnProperty.call(argMap, command)) {
      return { kind: 'slash-arg', command, token, prefixLen };
    }
    // Known-shaped but free-text / unknown command arg → no completion.
    return { kind: 'none', token, prefixLen };
  }

  // File/path token.
  if (looksLikePath(token)) {
    return { kind: 'path', token, prefixLen };
  }

  // Plain prose → strict no-op.
  return { kind: 'none', token, prefixLen };
}

/**
 * Complete a slash command's ARGUMENT from its candidate set (T2). PURE.
 *
 * Returns the candidates matching `partial` (fuzzy: prefix first, then
 * substring/subsequence). A command with no arg set (free text) → `[]`, so a
 * `/goal <sentence>` is never mangled.
 */
export function completeSlashArg(
  command: string,
  partial: string,
  argMap: Readonly<Record<string, readonly string[]>> = CHAT_SLASH_ARG_MAP,
): string[] {
  const candidates = argMap[command];
  if (candidates === undefined) return [];
  return fuzzyRank(partial, candidates);
}

/**
 * Rank `candidates` against `partial` (T4 fuzzy). PURE; case-insensitive.
 *
 * Order: exact-prefix matches first (so readline's longest-common-prefix
 * insertion works), then substring matches, then subsequence matches. Within a
 * tier the original candidate order is preserved (stable). An empty `partial`
 * returns all candidates unchanged; no match → `[]`.
 */
export function fuzzyRank(partial: string, candidates: readonly string[]): string[] {
  const list = Array.isArray(candidates) ? candidates.filter((c) => typeof c === 'string') : [];
  const p = (partial ?? '').toLowerCase();
  if (p.length === 0) return [...list];
  const prefix: string[] = [];
  const substr: string[] = [];
  const subseq: string[] = [];
  for (const c of list) {
    const lc = c.toLowerCase();
    if (lc.startsWith(p)) prefix.push(c);
    else if (lc.includes(p)) substr.push(c);
    else if (isSubsequence(p, lc)) subseq.push(c);
  }
  return [...prefix, ...substr, ...subseq];
}

/** True when `needle`'s chars appear in `hay` in order (gaps allowed). PURE. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Split a path-ish token into the directory to `readdir`, the basename prefix to
 * filter by, and the display prefix to re-prepend to each hit. PURE — does all
 * the `~`/`cwd` math but touches NO filesystem. Handles a leading `@` mention by
 * carrying it in `displayPrefix` (so the completed mention stays well-formed).
 *
 * @param token the trailing token (may start with `@`, `~/`, `./`, `../`, `/`)
 * @param home  the home directory used for `~` expansion (defaults to os.homedir)
 * @param cwd   the directory relative paths resolve against (defaults to cwd)
 */
export function expandPathToken(
  token: string,
  home: string = defaultStateContext().homeDir,
  cwd: string = process.cwd(),
): { dir: string; base: string; displayPrefix: string } {
  let raw = token;
  let mention = '';
  if (raw.startsWith('@')) {
    mention = '@';
    raw = raw.slice(1);
  }
  // Split into the typed directory portion and the basename fragment.
  const slash = raw.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : raw.slice(0, slash + 1); // includes trailing '/'
  const base = slash === -1 ? raw : raw.slice(slash + 1);
  // displayPrefix is exactly what the user typed up to the basename — we
  // re-prepend it to each hit so readline's `substring` (the whole token) is
  // replaced by a well-formed token.
  const displayPrefix = mention + dirPart;

  // Resolve the directory to actually read.
  let resolveBase: string;
  if (dirPart.startsWith('~')) {
    // ~ or ~/...  → expand home for the fs read only.
    const afterTilde = dirPart.slice(1); // '' or '/...'
    resolveBase = join(home, afterTilde.replace(/^\//, ''));
  } else if (dirPart.startsWith('/')) {
    resolveBase = dirPart;
  } else {
    resolveBase = join(cwd, dirPart);
  }
  // Normalize away a trailing separator (except the filesystem root) so `dir` is
  // a clean directory path for `readdir`. Strip BOTH separators: `join` emits the
  // OS separator, so on Windows the trailing char is a backslash, not a slash —
  // a POSIX-only `/\/+$/` would leave `C:\a\` un-normalized.
  resolveBase = resolveBase.length > 1 ? resolveBase.replace(/[/\\]+$/, '') : resolveBase;
  const dir = resolveBase === '' ? cwd : resolveBase;
  return { dir, base, displayPrefix };
}

/**
 * Filter+sort a `readdir` result against a basename prefix (T3). PURE.
 *
 * `entries` is the raw `readdir(..., {withFileTypes:true})` output (or plain
 * names). Directory hits get a trailing `/` and sort before files. Fuzzy:
 * prefix first, then substring. Hidden entries (dot-files) are only shown when
 * the basename itself starts with `.`. Capped at `limit` to avoid flooding.
 */
export function matchPathEntries(
  base: string,
  entries: readonly PathEntry[],
  limit = 50,
): string[] {
  const wantHidden = base.startsWith('.');
  const dirs: { name: string; rank: number }[] = [];
  const files: { name: string; rank: number }[] = [];
  const b = base.toLowerCase();
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!wantHidden && name.startsWith('.')) continue;
    const ln = name.toLowerCase();
    let rank: number;
    if (b.length === 0) rank = 0;
    else if (ln.startsWith(b)) rank = 0;
    else if (ln.includes(b)) rank = 1;
    else continue;
    const isDir = typeof e !== 'string' && (e?.isDirectory?.() ?? false);
    (isDir ? dirs : files).push({ name: isDir ? `${name}/` : name, rank });
  }
  const byRankThenName = (
    x: { name: string; rank: number },
    y: { name: string; rank: number },
  ): number => (x.rank !== y.rank ? x.rank - y.rank : x.name.localeCompare(y.name));
  dirs.sort(byRankThenName);
  files.sort(byRankThenName);
  return [...dirs, ...files].slice(0, limit).map((h) => h.name);
}

/** A `readdir` entry: a bare name or a `Dirent`-like object. */
export type PathEntry = string | { name: string; isDirectory?: () => boolean };

/** Injected ports for the impure {@link completeChat} — defaults to real fs/cwd. */
export interface CompleteChatDeps {
  /** Lists a directory; should resolve to Dirent-like entries. Errors → no completions. */
  readdir: (dir: string) => Promise<PathEntry[]>;
  cwd: string;
  home: string;
  commands: readonly string[];
  argMap: Readonly<Record<string, readonly string[]>>;
  /**
   * Live dynamic items for @-mentions (goals, board todos, memories, etc.).
   * Each group has a prefix (e.g. '@goal', '@board') and list of item strings.
   * Merged into mention/path hits when token starts with '@'.
   */
  dynamicWorldItems?: ReadonlyArray<{ prefix: string; items: readonly string[] }>;
}

const defaultCompleteChatDeps = (): CompleteChatDeps => ({
  readdir: (dir: string) => fs.promises.readdir(dir, { withFileTypes: true }),
  cwd: process.cwd(),
  home: defaultStateContext().homeDir,
  commands: CHAT_SLASH_COMMANDS,
  argMap: CHAT_SLASH_ARG_MAP,
  dynamicWorldItems: [],
});

/**
 * The single async completer for the chat prompt (T2–T4). Composes the pure
 * seams over an injected `readdir` port. Returns the Node readline
 * `[completions, substring]` pair where `substring` is the trailing token so
 * readline replaces only that token. FAIL-SOFT: a throwing/rejecting `readdir`
 * (or any error) degrades to the safe no-op `[[], line]` — never throws.
 */
export async function completeChat(
  line: string,
  deps: Partial<CompleteChatDeps> = {},
): Promise<[string[], string]> {
  try {
    const d = { ...defaultCompleteChatDeps(), ...deps };
    const c = classifyCompletion(line, d.argMap);
    switch (c.kind) {
      case 'none':
        return [[], line];
      case 'slash-name': {
        const hits = fuzzyRank(c.token.slice(1), d.commands.map((x) => x.slice(1)));
        // Re-prepend '/'; preserve "bare slash lists all" via completeSlash for
        // the exact-prefix case so today's contract is unchanged.
        const [prefixHits] = completeSlash(line, d.commands);
        const ranked = prefixHits.length > 0 ? prefixHits : hits.map((h) => `/${h}`);
        return [ranked, line];
      }
      case 'slash-arg': {
        const hits = completeSlashArg(c.command ?? '', c.token, d.argMap);
        return [hits, c.token];
      }
      case 'path':
      case 'mention': {
        const { dir, base, displayPrefix } = expandPathToken(c.token, d.home, d.cwd);
        let entries: PathEntry[];
        try {
          entries = await d.readdir(dir);
        } catch {
          entries = [];
        }
        let hits = matchPathEntries(base, entries).map((h) => displayPrefix + h);

        // Merge live dynamic world items (golden: live @ from actual stores)
        let dynGroups = d.dynamicWorldItems ?? [];
        if (c.token.startsWith('@') && dynGroups.length === 0) {
          // Auto-load from real stores (best-effort, small stores) — final smartness: richer live @
          try {
            const clock: Clock = {
              now: () => Date.now(),
              isoNow: () => new Date().toISOString(),
              uuid: () => 'mock-uuid-' + Date.now(),
              random: () => 0.5,
            };
            const gStore = createFileGoalStore({ clock });
            const gs: Goal[] = await gStore.list();
            if (gs.length) {
              const goalItems: string[] = [];
              const todoItems: string[] = [];
              for (const g of gs) {
                const slug = (g.title || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 32);
                goalItems.push(slug);
                if (Array.isArray(g.roadmap)) {
                  for (const item of g.roadmap.slice(0, 3)) {
                    if (item && !item.done && item.text) {
                      const t = String(item.text).replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 32);
                      if (t) todoItems.push(t);
                    }
                  }
                }
              }
              dynGroups = [...dynGroups, { prefix: '@goal-', items: goalItems }];
              dynGroups = [...dynGroups, { prefix: '@', items: goalItems }];
              if (todoItems.length) {
                dynGroups = [...dynGroups, { prefix: '@todo-', items: todoItems }];
                dynGroups = [...dynGroups, { prefix: '@', items: todoItems }];
              }
            }
            const pk = await resolveProjectKey(process.cwd()).catch(() => 'default');
            const mStore = createFileUserMemoryStore({ clock });
            const mems: UserMemoryFact[] = await mStore.listAll(pk ? { scope: 'project', projectKey: pk } : undefined).catch(() => []);
            if (mems.length) {
              const memItems = mems.slice(0, 30).map((m: UserMemoryFact) => (m.id || m.text || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 32));
              dynGroups = [...dynGroups, { prefix: '@mem-', items: memItems }];
              dynGroups = [...dynGroups, { prefix: '@', items: memItems }];
            }
            // Rules for @rule-
            try {
              const rStore = createFileRulesStore({ clock });
              const rs: Rule[] = await rStore.list().catch(() => []);
              if (rs.length) {
                const ruleItems = rs.slice(0, 20).map((r: Rule) => (r.text || r.id || '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 32)).filter(Boolean);
                if (ruleItems.length) {
                  dynGroups = [...dynGroups, { prefix: '@rule-', items: ruleItems }];
                  dynGroups = [...dynGroups, { prefix: '@', items: ruleItems }];
                }
              }
            } catch {
              // no rules, ignore
            }
          } catch {
            // fail soft, no dynamic
          }
        }
        if (c.token.startsWith('@') && dynGroups.length > 0) {
          const tokenLower = c.token.toLowerCase();
          const dynHits: string[] = [];
          for (const group of dynGroups) {
            if (tokenLower.startsWith(group.prefix.toLowerCase()) || tokenLower === '@') {
              for (const item of group.items) {
                const full = item.startsWith('@') ? item : `${group.prefix}${item}`;
                if (full.toLowerCase().startsWith(tokenLower) || tokenLower === '@') dynHits.push(full);
              }
            }
          }
          const seen = new Set(hits);
          hits = [...dynHits.filter((h) => !seen.has(h)), ...hits];
        }
        return [hits, c.token];
      }
      default:
        return [[], line];
    }
  } catch {
    return [[], line];
  }
}
