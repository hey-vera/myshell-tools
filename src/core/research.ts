/**
 * src/core/research.ts - the PURE core for RESEARCH-UNTIL-CONFIDENT.
 *
 * This module supplies bounded, externally anchored retrieval composers for local
 * code and web evidence. Core stays pure except for the injected ResearchPort.
 */

import { renderUntrustedBlock } from './untrusted-content.js';
import type { EvidenceReceiptV1 } from './evidence-investigation.js';

// ---------------------------------------------------------------------------
// The injected retrieval port.
// ---------------------------------------------------------------------------

export interface ResearchPort {
  /**
   * Locate up to `maxHits` repo-relative paths whose content matches `query`.
   * Most-relevant first when the port can order them.
   */
  grepRepo(cwd: string, query: string, maxHits: number): Promise<readonly string[]>;
  /** Read a UTF-8 file by repo-relative path; null when absent/unreadable. */
  readFile(cwd: string, rel: string): Promise<string | null>;
  /**
   * Optional native web search. Returns a short plain-text findings/sources
   * string, or '' on no result / error.
   */
  webSearch?(query: string, signal: AbortSignal): Promise<string>;
}

// ---------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------

/** Max grep hit paths considered per retrieval round. */
export const RETRIEVAL_MAX_HITS = 6;
/** Max files actually READ per retrieval round. */
export const RETRIEVAL_MAX_FILES = 3;
/** Max chars excerpted from a single read file. */
export const RETRIEVAL_FILE_EXCERPT_CAP = 600;
/** Hard cap on the whole rendered FINDINGS block. */
export const RETRIEVAL_CONTEXT_CHAR_CAP = 2000;
/** Hard cap on the whole rendered web SOURCES block. */
export const WEB_CONTEXT_CHAR_CAP = 1500;

export interface CollectLocalEvidenceInput {
  readonly port: ResearchPort;
  readonly cwd: string;
  readonly needId: string;
  readonly query: string;
  readonly signal: AbortSignal;
}

export interface CollectWebEvidenceInput {
  readonly port: ResearchPort;
  readonly needId: string;
  readonly query: string;
  readonly signal: AbortSignal;
}

/**
 * Derive a compact, deterministic keyword query from a goal/task string for the grep
 * pass. PURE; never throws. Lowercases, strips punctuation, drops very short / common
 * stop words, de-dupes, and keeps the first few content tokens.
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

function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function localReceipt(input: {
  readonly needId: string;
  readonly query: string;
  readonly status: EvidenceReceiptV1['status'];
  readonly pathsLocated?: readonly string[];
  readonly pathsRead?: readonly string[];
  readonly renderedContext?: string;
}): EvidenceReceiptV1 {
  return {
    version: 1,
    needId: input.needId,
    kind: 'local-code',
    status: input.status,
    query: input.query,
    pathsLocated: input.pathsLocated ?? [],
    pathsRead: input.pathsRead ?? [],
    renderedContext: input.renderedContext ?? '',
  };
}

function webReceipt(input: {
  readonly needId: string;
  readonly query: string;
  readonly status: EvidenceReceiptV1['status'];
  readonly sourceText?: string;
  readonly renderedContext?: string;
}): EvidenceReceiptV1 {
  return {
    version: 1,
    needId: input.needId,
    kind: 'external-source',
    status: input.status,
    query: input.query,
    sourceText: input.sourceText ?? '',
    renderedContext: input.renderedContext ?? '',
  };
}

function renderRetrievalFindings(content: string): string {
  const wrapperOverhead = renderUntrustedBlock({
    source: 'repo-file',
    label: 'retrieval-findings',
    content: '',
  }).length;
  return renderUntrustedBlock({
    source: 'repo-file',
    label: 'retrieval-findings',
    content: content.slice(0, Math.max(0, RETRIEVAL_CONTEXT_CHAR_CAP - wrapperOverhead)),
  });
}

function renderWebFindings(text: string): string {
  const wrapperOverhead = renderUntrustedBlock({
    source: 'tool-output',
    label: 'web-findings',
    content: '',
  }).length;
  return renderUntrustedBlock({
    source: 'tool-output',
    label: 'web-findings',
    content: `WEB FINDINGS (current external sources, for grounding):\n${text}`.slice(
      0,
      Math.max(0, WEB_CONTEXT_CHAR_CAP - wrapperOverhead),
    ),
  });
}

/**
 * Collect bounded local-code evidence. `obtained` means at least one successful
 * nonempty file read. Located-only evidence is `missing`; port rejection is
 * `failed`; aborts are `cancelled`.
 */
export async function collectLocalEvidence(
  input: CollectLocalEvidenceInput,
): Promise<EvidenceReceiptV1> {
  const { port, cwd, needId, query, signal } = input;
  if (isCancelled(signal)) return localReceipt({ needId, query, status: 'cancelled' });

  const tokens = deriveQueryTokens(query);
  if (tokens.length === 0) return localReceipt({ needId, query, status: 'missing' });

  const hits: string[] = [];
  const seen = new Set<string>();
  let hadFailure = false;

  for (const tok of tokens) {
    if (hits.length >= RETRIEVAL_MAX_HITS) break;
    if (isCancelled(signal)) {
      return localReceipt({ needId, query, status: 'cancelled', pathsLocated: hits });
    }

    let found: readonly string[];
    try {
      found = await port.grepRepo(cwd, tok, RETRIEVAL_MAX_HITS);
    } catch {
      if (isCancelled(signal)) return localReceipt({ needId, query, status: 'cancelled' });
      hadFailure = true;
      found = [];
    }

    if (isCancelled(signal)) {
      return localReceipt({ needId, query, status: 'cancelled', pathsLocated: hits });
    }

    for (const rel of found) {
      const p = (rel ?? '').trim();
      if (p.length === 0 || seen.has(p)) continue;
      seen.add(p);
      hits.push(p);
      if (hits.length >= RETRIEVAL_MAX_HITS) break;
    }
  }

  if (hits.length === 0) {
    return localReceipt({ needId, query, status: hadFailure ? 'failed' : 'missing' });
  }

  const lines: string[] = ['RETRIEVAL FINDINGS (read-only â€” files relevant to the goal, for grounding):'];
  const pathsRead: string[] = [];
  let readAttempts = 0;

  for (const rel of hits) {
    if (readAttempts >= RETRIEVAL_MAX_FILES) {
      lines.push(`- located: ${rel}`);
      continue;
    }

    if (isCancelled(signal)) {
      return localReceipt({
        needId,
        query,
        status: 'cancelled',
        pathsLocated: hits,
        pathsRead,
      });
    }

    readAttempts++;
    let content: string | null;
    try {
      content = await port.readFile(cwd, rel);
    } catch {
      if (isCancelled(signal)) {
        return localReceipt({
          needId,
          query,
          status: 'cancelled',
          pathsLocated: hits,
          pathsRead,
        });
      }
      hadFailure = true;
      content = null;
    }

    if (isCancelled(signal)) {
      return localReceipt({
        needId,
        query,
        status: 'cancelled',
        pathsLocated: hits,
        pathsRead,
      });
    }

    if (content === null) {
      lines.push(`- located: ${rel}`);
      continue;
    }

    const excerpt = content.trim().slice(0, RETRIEVAL_FILE_EXCERPT_CAP).replace(/\s+/g, ' ').trim();
    lines.push(`- ${rel}: ${excerpt}`);
    if (excerpt.length > 0) pathsRead.push(rel);
  }

  const renderedContext = renderRetrievalFindings(lines.join('\n'));
  return localReceipt({
    needId,
    query,
    status: hadFailure ? 'failed' : pathsRead.length > 0 ? 'obtained' : 'missing',
    pathsLocated: hits,
    pathsRead,
    renderedContext,
  });
}

/**
 * The legacy string-returning local retrieval wrapper. Delegates to receipt
 * collection and preserves the rendered context format.
 */
export async function buildRetrievalContext(
  port: ResearchPort,
  cwd: string,
  goal: string,
): Promise<string> {
  const receipt = await collectLocalEvidence({
    port,
    cwd,
    needId: 'LEGACY_RETRIEVAL',
    query: goal,
    signal: new AbortController().signal,
  });
  return receipt.renderedContext;
}

/**
 * Collect bounded web evidence. `obtained` means a nonempty search result.
 */
export async function collectWebEvidence(
  input: CollectWebEvidenceInput,
): Promise<EvidenceReceiptV1> {
  const { port, needId, query, signal } = input;
  if (isCancelled(signal)) return webReceipt({ needId, query, status: 'cancelled' });

  const webSearch = port.webSearch;
  if (typeof webSearch !== 'function') return webReceipt({ needId, query, status: 'missing' });

  const q = (query ?? '').trim();
  if (q.length === 0) return webReceipt({ needId, query, status: 'missing' });

  let result: string;
  try {
    result = await webSearch(q, signal);
  } catch {
    return webReceipt({ needId, query, status: isCancelled(signal) ? 'cancelled' : 'failed' });
  }

  if (isCancelled(signal)) return webReceipt({ needId, query, status: 'cancelled' });

  const text = (result ?? '').trim();
  if (text.length === 0) return webReceipt({ needId, query, status: 'missing' });

  return webReceipt({
    needId,
    query,
    status: 'obtained',
    sourceText: text.slice(0, WEB_CONTEXT_CHAR_CAP),
    renderedContext: renderWebFindings(text),
  });
}

/**
 * The legacy string-returning web wrapper. Delegates to receipt collection and
 * preserves the rendered context format.
 */
export async function buildWebContext(
  port: ResearchPort,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  const receipt = await collectWebEvidence({
    port,
    needId: 'LEGACY_WEB',
    query,
    signal,
  });
  return receipt.renderedContext;
}
