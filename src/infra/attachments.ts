/**
 * src/infra/attachments.ts — IMPURE resolver for image attachments.
 *
 * The image-attachment channel (provider-capability audit opportunity #4, image
 * scope) splits into a PURE half and an IMPURE half:
 *  - PURE   (src/core/attachments.ts): extract candidate image paths from the
 *           user's message string. No I/O.
 *  - IMPURE (here): take those candidates, resolve `~`/relative paths against home
 *           + cwd, and keep ONLY the ones that EXIST on disk as a regular file. The
 *           filesystem touch lives here (the interface/infra layer), never in core.
 *
 * Conservative by design: a candidate that does not exist (typo, deleted, a
 * directory, or a path the user never created) is silently dropped — we never
 * fabricate or attach a non-existent file. A message with no real image →
 * empty array → downstream behaviour byte-for-byte unchanged (no attachments,
 * needsVision stays false).
 *
 * Fail-soft: any stat error (permission, race, ENOENT) is treated as "does not
 * exist" — it never throws, so a malformed path can never break a turn.
 *
 * Subscription-auth note: the only thing produced is a local filesystem PATH,
 * handed to the logged-in provider CLI (codex `-i`, opencode `-f`). No upload
 * service, no api key, no metered endpoint.
 */

import fs from 'node:fs';
import os from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { extractImagePaths, type Attachment } from '../core/attachments.js';

/** Injected ports for {@link resolveImageAttachments} — defaults to real fs/os. */
export interface ResolveAttachmentsDeps {
  /** True iff the path is an existing regular file. Errors → false (fail-soft). */
  fileExists: (absPath: string) => boolean;
  cwd: string;
  home: string;
}

const defaultDeps = (cwd: string): ResolveAttachmentsDeps => ({
  fileExists: (absPath: string): boolean => {
    try {
      return fs.statSync(absPath).isFile();
    } catch {
      return false;
    }
  },
  cwd,
  home: os.homedir(),
});

/**
 * Expand a leading `~` / `~/` to the home directory, then resolve a relative path
 * against cwd. Absolute paths pass through. PURE w.r.t. the injected home/cwd.
 */
function toAbsolute(path: string, home: string, cwd: string): string {
  let p = path;
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = resolve(home, p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(cwd, p);
}

/**
 * IMPURE: resolve the REAL, existing local image attachments referenced in a
 * message. Composes the pure extractor over an injected existence check.
 *
 * Returns `{ path, kind: 'image' }[]` for each candidate that resolves to an
 * existing regular file, de-duplicated by absolute path (the pure extractor
 * already de-dupes by raw token; this also collapses `./a.png` and `a.png`). The
 * stored `path` is the ABSOLUTE resolved path so the provider CLI receives an
 * unambiguous location regardless of its own cwd.
 *
 * Empty array when the message references no real image — the caller then omits
 * `deps.attachments` entirely, leaving behaviour byte-for-byte unchanged.
 */
export function resolveImageAttachments(
  message: string,
  deps: Partial<ResolveAttachmentsDeps> = {},
): Attachment[] {
  const d = { ...defaultDeps(deps.cwd ?? process.cwd()), ...deps };
  const candidates = extractImagePaths(message);
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const candidate of candidates) {
    const abs = toAbsolute(candidate, d.home, d.cwd);
    if (seen.has(abs)) continue;
    if (!d.fileExists(abs)) continue;
    seen.add(abs);
    out.push({ path: abs, kind: 'image' });
  }
  return out;
}
