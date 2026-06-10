/**
 * src/infra/research-port.ts — the IMPURE fs/git/search reader behind the brain's
 * `ResearchPort` (vision-brain §2 / master-plan Phase 3a/3b).
 *
 * Mirrors repo-scan.ts: every git/fs/search operation is wrapped so a missing `git`,
 * a non-repo dir, an unreadable file, or a search failure degrades to a []/null/''
 * no-throw result rather than failing the turn. The pure, bounded retrieval composers
 * live in core/research.ts; this is only the raw-facts reader.
 *
 * NO new dep — `git grep` (best-effort, read-only) for code retrieval + node:fs for
 * reads. The optional native web search is INJECTED (a provider's subscription tool —
 * no api key / metered service); absent → the web angle has no capability.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResearchPort } from '../core/research.js';

const execFileAsync = promisify(execFile);

/** Cap so a pathological `git grep` can never hang the retrieval round. */
const GREP_TIMEOUT_MS = 4000;

/**
 * Build the production {@link ResearchPort}. `webSearch` is OPTIONAL and injected by
 * the deps layer (a native subscription web-search call); when omitted the web
 * re-research angle reports no capability and the brain stops that angle honestly.
 *
 * `grepRepo` uses read-only `git grep` (tracked files only, fixed-string,
 * case-insensitive, files-with-matches) so it is fast and never mutates. Any failure
 * (no git / not a repo / no match) → []. `readFile` mirrors repo-scan.ts.
 */
export function createNodeResearchPort(opts?: {
  webSearch?: (query: string, signal: AbortSignal) => Promise<string>;
}): ResearchPort {
  const port: ResearchPort = {
    async grepRepo(cwd: string, query: string, maxHits: number): Promise<readonly string[]> {
      const q = (query ?? '').trim();
      if (q.length === 0) return [];
      try {
        // -l files-with-matches · -i ignore-case · -F fixed-string (literal) so a
        // keyword with regex metachars never errors. Read-only.
        const { stdout } = await execFileAsync(
          'git',
          ['grep', '-l', '-i', '-F', q],
          { cwd, timeout: GREP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        );
        const files: string[] = [];
        for (const line of stdout.split('\n')) {
          const rel = line.trim();
          if (rel.length === 0) continue;
          files.push(rel.replace(/\\/g, '/'));
          if (files.length >= maxHits) break;
        }
        return files;
      } catch {
        // No git / not a repo / no match / exit-1 → no hits (fail-soft).
        return [];
      }
    },

    async readFile(cwd: string, rel: string): Promise<string | null> {
      try {
        return await fsReadFile(join(cwd, rel), 'utf8');
      } catch {
        return null;
      }
    },
  };

  // Attach the injected native web search ONLY when provided (keeps the optional
  // method genuinely absent when there is no capability — the composer checks typeof).
  if (opts?.webSearch !== undefined) {
    const ws = opts.webSearch;
    return {
      ...port,
      async webSearch(query: string, signal: AbortSignal): Promise<string> {
        try {
          return await ws(query, signal);
        } catch {
          return '';
        }
      },
    };
  }
  return port;
}
