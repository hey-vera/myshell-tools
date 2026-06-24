/**
 * src/core/research.ts — the PURE core for RESEARCH-UNTIL-CONFIDENT (vision-brain
 * §2 / master-plan Phase 3a/3b).
 *
 * Today the brain "investigates" the STATIC repo-map only: the codebase round
 * appends the already-in-context environment block and re-runs the intent extractor.
 * This module supplies the two BOUNDED, EXTERNALLY-ANCHORED retrieval composers the
 * loop needs to actually DIVE IN:
 *
 *   - `buildRetrievalContext(port, goal, …)` — a bounded READ-ONLY Read/Grep sub-pass
 *     that grep-locates the files relevant to the goal and reads a few of them, then
 *     renders a capped FINDINGS block the re-extraction folds in. This is the REAL
 *     targeted retrieval (vs. the static map). It is "impure" ONLY through the
 *     injected {@link ResearchPort}, exactly like `repo-map.ts buildEnvironmentContext`
 *     — this module imports no fs/path/child_process and is hermetically table-tested.
 *
 *   - `buildWebContext(port, query, …)` — the SECOND-ANGLE external re-research:
 *     a native web search via the injected port's optional `webSearch` (no api key /
 *     metered service — the provider's own subscription tool). Renders a capped
 *     SOURCES block. Absent capability → '' (the loop stops honestly).
 *
 * BOUNDS (the guardrails): every pass is hard-capped — a small fixed number of grep
 * hits, files read, and a char budget — so cost/latency can never blow up. Both
 * composers are TOTAL + FAIL-SOFT: any port rejection / empty result yields '' and
 * the caller proceeds (or stops) honestly. NO embeddings, NO third-party search.
 *
 * SELF-CORRECTION IS EXTERNALLY ANCHORED: re-research is a NEW retrieval from a
 * different angle, never the model re-reading + second-guessing its own answer.
 */

import { renderUntrustedBlock } from './untrusted-content.js';

// ---------------------------------------------------------------------------
// The injected retrieval port (mirrors RepoScanPort — narrow, fail-soft).
// ---------------------------------------------------------------------------

/**
 * The narrow read-only retrieval port the research composers need. Injected so this
 * core module never imports node:fs / node:child_process and so the bounded passes
 * are hermetically table-testable. Every method MAY reject; the composers catch
 * everything and degrade to ''. The node-fs/ripgrep-backed impl lives in infra
 * (mirrors repo-scan.ts), keeping core pure.
 */
export interface ResearchPort {
  /**
   * Locate up to `maxHits` repo-relative paths whose content matches `query`
   * (a literal/keyword grep, read-only). Most-relevant first when the port can
   * order them. Returns [] on no match / error.
   */
  grepRepo(cwd: string, query: string, maxHits: number): Promise<readonly string[]>;
  /** Read a UTF-8 file by repo-relative path; null when absent/unreadable. */
  readFile(cwd: string, rel: string): Promise<string | null>;
  /**
   * OPTIONAL native web search (the provider's subscription tool — no api key). When
   * absent the web re-research angle has no capability and degrades to '' honestly.
   * Returns a short plain-text findings/sources string, or '' on no result / error.
   */
  webSearch?(query: string, signal: AbortSignal): Promise<string>;
}

// ---------------------------------------------------------------------------
// Bounds (the guardrails — right-sized, not maxed).
// ---------------------------------------------------------------------------

/** Max grep hit paths considered per retrieval round. */
export const RETRIEVAL_MAX_HITS = 6;
/** Max files actually READ per retrieval round (a subset of the hits). */
export const RETRIEVAL_MAX_FILES = 3;
/** Max chars excerpted from a single read file. */
export const RETRIEVAL_FILE_EXCERPT_CAP = 600;
/** Hard cap on the whole rendered FINDINGS block (defense in depth). */
export const RETRIEVAL_CONTEXT_CHAR_CAP = 2000;
/** Hard cap on the whole rendered web SOURCES block. */
export const WEB_CONTEXT_CHAR_CAP = 1500;

/** Run a possibly-throwing port call, returning `fallback` on any rejection. PURE-adjacent. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Derive a compact, deterministic keyword query from a goal/task string for the grep
 * pass. PURE; never throws. Lowercases, strips punctuation, drops very short / common
 * stop words, de-dupes, and keeps the first few content tokens — a small, stable
 * literal query (we grep each token; the port unions the hits). Returns [] when no
 * usable token remains (caller then does not retrieve).
 */
export function deriveQueryTokens(goal: string, max = 4): readonly string[] {
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
    'add', 'make', 'fix', 'update', 'change', 'use', 'using', 'how', 'what', 'when',
    'a', 'an', 'to', 'of', 'in', 'on', 'it', 'is', 'be', 'do', 'we', 'i',
  ]);
  const toks: string[] = [];
  const seen = new Set<string>();
  for (const raw of (goal ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    const w = raw.trim();
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    toks.push(w);
    if (toks.length >= max) break;
  }
  return toks;
}

/**
 * The BOUNDED read-only Read/Grep sub-pass (Phase 3a). Given the injected port and a
 * goal, grep-locates the relevant files, reads a few, and renders a capped FINDINGS
 * block (file paths + short excerpts) the re-extraction folds in. TOTAL + FAIL-SOFT:
 * returns '' on no usable query, no hits, or any port error (the caller then proceeds
 * with the static layout exactly as before). NO model call, NO network, NO embeddings.
 *
 * @param port the injected fs/grep retrieval port.
 * @param cwd  the working directory (the chat's cwd).
 * @param goal the goal/task to locate relevant code for.
 */
export async function buildRetrievalContext(
  port: ResearchPort,
  cwd: string,
  goal: string,
): Promise<string> {
  const tokens = deriveQueryTokens(goal);
  if (tokens.length === 0) return '';

  // Union the per-token grep hits, preserving first-seen order, bounded to MAX_HITS.
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (hits.length >= RETRIEVAL_MAX_HITS) break;
    const found = await safe(() => port.grepRepo(cwd, tok, RETRIEVAL_MAX_HITS), [] as readonly string[]);
    for (const rel of found) {
      const p = (rel ?? '').trim();
      if (p.length === 0 || seen.has(p)) continue;
      seen.add(p);
      hits.push(p);
      if (hits.length >= RETRIEVAL_MAX_HITS) break;
    }
  }
  if (hits.length === 0) return '';

  // Read a bounded subset and excerpt each (the real "dive in").
  const lines: string[] = ['RETRIEVAL FINDINGS (read-only — files relevant to the goal, for grounding):'];
  let filesRead = 0;
  for (const rel of hits) {
    if (filesRead >= RETRIEVAL_MAX_FILES) {
      // Still list the remaining located paths (cheap signal) without reading them.
      lines.push(`- located: ${rel}`);
      continue;
    }
    const content = await safe(() => port.readFile(cwd, rel), null);
    if (content === null) {
      lines.push(`- located: ${rel}`);
      continue;
    }
    const excerpt = content.trim().slice(0, RETRIEVAL_FILE_EXCERPT_CAP).replace(/\s+/g, ' ').trim();
    lines.push(`- ${rel}: ${excerpt}`);
    filesRead++;
  }
  if (filesRead === 0 && lines.length <= 1) return '';

  const content = lines.join('\n');
  const wrapperOverhead = renderUntrustedBlock({
    source: 'repo-file',
    label: 'retrieval-findings',
    content: '',
  }).length;
  const rendered = renderUntrustedBlock({
    source: 'repo-file',
    label: 'retrieval-findings',
    content: content.slice(0, Math.max(0, RETRIEVAL_CONTEXT_CHAR_CAP - wrapperOverhead)),
  });
  return rendered;
}

/**
 * The SECOND-ANGLE web re-research (Phase 3b). Runs a single native web search via the
 * port's optional `webSearch` (the provider's subscription tool — no api key / metered
 * service) and renders a capped SOURCES block the re-extraction folds in. TOTAL +
 * FAIL-SOFT: returns '' when the port has no `webSearch` capability, the search yields
 * nothing, or any error — the caller then stops the loop honestly (no fabricated
 * sources). EXTERNALLY ANCHORED: a fresh external retrieval, never a self re-read.
 */
export async function buildWebContext(
  port: ResearchPort,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const webSearch = port.webSearch;
  if (typeof webSearch !== 'function') return '';
  const q = (query ?? '').trim();
  if (q.length === 0) return '';
  const result = await safe(() => webSearch(q, signal), '');
  const text = (result ?? '').trim();
  if (text.length === 0) return '';
  const wrapperOverhead = renderUntrustedBlock({
    source: 'tool-output',
    label: 'web-findings',
    content: '',
  }).length;
  const rendered = renderUntrustedBlock({
    source: 'tool-output',
    label: 'web-findings',
    content: `WEB FINDINGS (current external sources, for grounding):\n${text}`.slice(
      0,
      Math.max(0, WEB_CONTEXT_CHAR_CAP - wrapperOverhead),
    ),
  });
  return rendered;
}
