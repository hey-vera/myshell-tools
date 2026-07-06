/**
 * src/core/patch-apply.ts — host-controlled precise patch layer (Aider-style).
 * Captures minimal patches from git diff or provider tool events.
 * Preview, atomic apply (via worktree or git apply), commit on accept.
 * Provider-agnostic: works for solo or any combo.
 * Integrates with accept-stage for preview/commit on clean accept.
 * Uses existing captureDiff, worktree infra.
 */

import { execa } from 'execa';
import type { ProviderEvent } from '../providers/port.js';
import { createNodeWorktreePort } from '../infra/worktree.js';

export interface Patch {
  readonly path: string;
  readonly diff: string;
  readonly files?: readonly string[];
  readonly preview?: string;
}

export interface ApplyResult {
  readonly success: boolean;
  readonly message: string;
  readonly appliedFiles: string[];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizePath(value: string): string | null {
  const trimmed = value.trim().replace(/^["'`]|["'`]$/g, '');
  if (!trimmed) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return trimmed.replace(/\\/g, '/');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) return trimmed.replace(/\\/g, '/');
  if (/\.[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
  return null;
}

function extractFilesFromText(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?[^\s,;:(){}\[\]<>]+/g) ?? [];
  const out: string[] = [];
  for (const match of matches) {
    const normalized = normalizePath(match);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

function extractFilesFromToolEvents(providerEvents: readonly ProviderEvent[]): string[] {
  const files: string[] = [];
  for (const event of providerEvents) {
    if (event.type !== 'tool') continue;
    const toolName = event.name.toLowerCase();
    const detail = event.detail ?? '';
    const looksFiley =
      toolName.includes('file') ||
      toolName === 'edit' ||
      toolName === 'write' ||
      toolName === 'patch' ||
      toolName === 'apply' ||
      toolName === 'tool_use';
    if (!looksFiley && !detail.includes('/') && !detail.includes('\\')) continue;
    files.push(...extractFilesFromText(detail));
  }
  return uniqueStrings(files);
}

function buildPatchPreview(path: string, diff: string): string {
  return `--- Patch for ${path} ---\n${diff.slice(0, 2000)}${diff.length > 2000 ? '\n... (truncated)' : ''}`;
}

/**
 * Capture patch from post-edit git diff (using existing infra).
 * Provider agnostic.
 */
export async function capturePatchFromDiff(
  cwd: string,
  editedFiles?: readonly string[],
  providerEvents?: readonly ProviderEvent[],
): Promise<Patch[]> {
  const hintedFiles = uniqueStrings([
    ...(editedFiles ?? []),
    ...(providerEvents !== undefined ? extractFilesFromToolEvents(providerEvents) : []),
  ]);

  const args = ['diff', 'HEAD', '--no-color', '--'];
  if (hintedFiles.length > 0) args.push(...hintedFiles);

  try {
    const result = await execa('git', args, { cwd, reject: false });
    const diff = result.stdout.trim().length > 0 ? result.stdout : '';
    if (diff.length === 0) return [];
    const path = hintedFiles[0] ?? 'changes.diff';
    return [{
      path,
      diff,
      ...(hintedFiles.length > 0 ? { files: hintedFiles } : {}),
      preview: buildPatchPreview(path, diff),
    }];
  } catch {
    return [];
  }
}

/**
 * Preview the patch (for chat UI or accept gate).
 */
export function previewPatch(patch: Patch): string {
  return patch.preview ?? buildPatchPreview(patch.path, patch.diff);
}

async function runGitApply(cwd: string, diff: string): Promise<{ success: boolean; message: string }> {
  const check = await execa('git', ['apply', '--check', '--no-color', '--'], {
    cwd,
    input: diff,
    reject: false,
  });
  if (check.exitCode !== 0) {
    return { success: false, message: check.stderr || check.stdout || 'git apply --check failed' };
  }

  const apply = await execa('git', ['apply', '--no-color', '--'], {
    cwd,
    input: diff,
    reject: false,
  });
  if (apply.exitCode !== 0) {
    return { success: false, message: apply.stderr || apply.stdout || 'git apply failed' };
  }
  return { success: true, message: 'applied' };
}

/**
 * Apply patch atomically.
 * Uses worktree if available for isolation, else git apply.
 * Safe for any provider.
 */
export async function applyPatch(cwd: string, patch: Patch): Promise<ApplyResult> {
  const worktreePort = createNodeWorktreePort();
  const worktree = await worktreePort.createWorktree(cwd, 'patch-apply');
  if (worktree !== null) {
    try {
      const isolated = await runGitApply(worktree.cwd, patch.diff);
      if (!isolated.success) {
        return { success: false, message: isolated.message, appliedFiles: [] };
      }
    } finally {
      await worktreePort.removeWorktree(cwd, worktree).catch(() => {});
    }
  }

  const applied = await runGitApply(cwd, patch.diff);
  if (!applied.success) {
    return { success: false, message: applied.message, appliedFiles: [] };
  }
  return {
    success: true,
    message: worktree !== null ? 'applied via worktree' : 'applied',
    appliedFiles: patch.files !== undefined ? [...patch.files] : [patch.path],
  };
}

/**
 * Commit the applied patch on accept (rich metadata).
 */
export async function commitPatch(cwd: string, patch: Patch, metadata: string): Promise<boolean> {
  try {
    await execa('git', ['add', '-A'], { cwd });
    const preview = previewPatch(patch);
    await execa('git', ['commit', '-m', `patch: ${patch.path}\n\n${metadata}\n\n${preview}`], { cwd });
    return true;
  } catch {
    return false;
  }
}
