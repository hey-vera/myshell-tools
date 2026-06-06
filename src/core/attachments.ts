/**
 * src/core/attachments.ts — PURE image-attachment path extraction.
 *
 * The image-attachment channel (provider-capability audit opportunity #4, scoped
 * to images) reuses the EXISTING path notion: a user references a local image
 * path in their message, optionally `@`-mentioned. This module owns the PURE
 * parsing half — extracting candidate local image paths from a message string —
 * and nothing impure. The existence check (does the file actually exist on disk?)
 * lives in the impure interface layer (menu.ts / cli.ts), where fs is allowed,
 * NOT here: core must stay free of I/O (see test/arch purity guard). No `path`/
 * `os`/`fs` imports — only string operations.
 *
 * Contract:
 *  - Recognises bare paths and `@`-mentioned paths whose final segment ends in a
 *    known image extension (.png .jpg .jpeg .gif .webp .bmp .svg, case-insensitive).
 *  - Returns the de-duplicated list of candidate paths in first-seen order, with a
 *    leading `@` (mention marker) stripped so the impure layer can stat the real path.
 *  - Conservative: it only RECOGNISES image-extension tokens; it makes no judgement
 *    about existence. A message with no image-extension token → empty array, so the
 *    downstream behaviour is byte-for-byte unchanged (no attachments, needsVision
 *    stays false).
 */

/** The kind of an attachment. Images only for now (audit #4 scope). */
export type AttachmentKind = 'image';

/** A resolved attachment threaded onto a ProviderRequest. */
export interface Attachment {
  readonly path: string;
  readonly kind: AttachmentKind;
}

/**
 * Image file extensions recognised by the extractor. Lower-case; the match is
 * case-insensitive. Kept deliberately small + verified-renderable image types.
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
];

/**
 * True when `token`'s final path segment ends in a known image extension. PURE.
 * Case-insensitive on the extension. We look at the basename so a directory in
 * the path that merely contains a dotted name can't trip a false match.
 */
function hasImageExtension(token: string): boolean {
  const slash = token.lastIndexOf('/');
  const base = slash === -1 ? token : token.slice(slash + 1);
  const lower = base.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/**
 * Strip a single leading `@` mention marker, if present. PURE. The `@`-mention
 * form (`@./pic.png`) is the same path with a mention prefix; the real filesystem
 * path is the same string without the leading `@`.
 */
function stripMention(token: string): string {
  return token.startsWith('@') ? token.slice(1) : token;
}

/**
 * Trim trailing punctuation that commonly abuts a path in prose (e.g. a sentence
 * ending `…/pic.png.` or a parenthesised `(see @a.jpg)`), WITHOUT eating a
 * character that could be part of a real filename. We only strip a conservative
 * set of clearly-prose trailers from the END of the token. PURE.
 */
function trimTrailingPunctuation(token: string): string {
  return token.replace(/[).,;:!?'"]+$/u, '');
}

/**
 * PURE: extract candidate local image paths from a free-form message.
 *
 * Splits on whitespace, then for each token: trims surrounding prose quotes/parens,
 * strips a leading `@` mention marker, and keeps it iff its basename ends in a known
 * image extension. De-dupes (first-seen order). Returns the bare paths (no `@`); the
 * impure layer decides which actually exist on disk.
 *
 * It does NOT touch the filesystem and makes NO existence judgement — a returned
 * path is a *candidate* only. Non-image tokens and ordinary prose are ignored, so a
 * message with no image path yields an empty array (unchanged downstream behaviour).
 */
export function extractImagePaths(message: string): string[] {
  if (typeof message !== 'string' || message.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawToken of message.split(/\s+/u)) {
    if (rawToken.length === 0) continue;
    // Strip a leading mention marker, then trailing prose punctuation. We strip the
    // mention BEFORE punctuation so `(@a.png)` → `@a.png)` handled by token split,
    // then mention, then trailing `)`.
    const stripped = trimTrailingPunctuation(stripMention(rawToken));
    // Also strip a leading quote/paren left over from prose like `("@a.png`.
    const candidate = stripped.replace(/^["'(]+/u, '');
    if (candidate.length === 0) continue;
    if (!hasImageExtension(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}
