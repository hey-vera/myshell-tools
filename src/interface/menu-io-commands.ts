/**
 * src/interface/menu-io-commands.ts
 *
 * Extracted from menu.ts — behavior-preserving.
 *
 * The testable, I/O-injected helpers behind the chat `/copy` and `/export`
 * commands (real-chat gap #3). The dispatch in menu.ts is a thin wrapper over
 * these so the clipboard / fs I/O is injected and the logic stays hermetic.
 */

import type { SessionEntry } from '../core/types.js';
import type { OutputSink } from './render.js';
import { pickCopyText, renderConversationMarkdown } from './render.js';
import type { ClipboardPort } from '../infra/clipboard.js';
import { dim } from '../ui/theme.js';

// ---------------------------------------------------------------------------
// /copy + /export — real-chat gap #3 (local-only, fail-soft). The dispatch is a
// thin wrapper over these testable helpers so the clipboard/fs I/O is injected.
// ---------------------------------------------------------------------------

/** A short, deterministic, fs-safe slug for an export filename. PURE. */
export function exportFileSlug(title: string | undefined): string {
  const base = (typeof title === 'string' ? title : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'conversation';
}

export interface CopyCommandInput {
  readonly entries: readonly SessionEntry[];
  readonly out: OutputSink;
  /** Injected clipboard port (real one shells out; tests inject a fake). */
  readonly clipboard: ClipboardPort;
}

/**
 * Run `/copy`: pick the last assistant answer (stripped), try the injected
 * clipboard port, and on success print a confirmation. On a headless host (no
 * clipboard tool → port returns false) print an honest "clipboard unavailable —
 * here's the text:" fallback block the user can mouse-select. When there is
 * nothing to copy, print a gentle notice. Fully fail-soft — never throws.
 */
export async function runCopyCommand(input: CopyCommandInput): Promise<void> {
  const { out } = input;
  const text = pickCopyText(input.entries);
  if (text === null) {
    out.write(dim('  Nothing to copy yet — ask me something first.\n', out.color));
    return;
  }
  let ok = false;
  try {
    ok = await input.clipboard(text);
  } catch {
    ok = false; // a misbehaving port must still reach the fallback, never crash
  }
  if (ok) {
    out.write(dim('  Copied my last answer to your clipboard.\n', out.color));
    return;
  }
  // Headless / no clipboard tool: be honest and print the text to select.
  out.write(
    dim("  Clipboard unavailable here — here's the text to select:\n\n", out.color) +
      text +
      '\n',
  );
}

export interface ExportCommandInput {
  readonly meta: { readonly title?: string } | undefined;
  readonly entries: readonly SessionEntry[];
  readonly out: OutputSink;
  /** Absolute path to write the Markdown transcript to. */
  readonly path: string;
  /** Injected file writer (so the command is testable without disk). */
  readonly writeFile: (path: string, data: string) => Promise<void>;
}

/**
 * Run `/export`: render the conversation to Markdown via the pure
 * `renderConversationMarkdown` seam and write it to `path` through the injected
 * writer (mirrors `/memory export`). Prints the path on success, a gentle note
 * on failure. Fail-soft — never throws.
 */
export async function runExportCommand(input: ExportCommandInput): Promise<void> {
  const { out } = input;
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    out.write(dim('  Nothing to export yet — this conversation is empty.\n', out.color));
    return;
  }
  const md = renderConversationMarkdown(input.meta ?? {}, input.entries);
  try {
    await input.writeFile(input.path, md);
    out.write(dim(`  Exported this conversation to ${input.path}\n`, out.color));
  } catch {
    out.write(dim(`  Couldn't write the export to ${input.path} just now.\n`, out.color));
  }
}
