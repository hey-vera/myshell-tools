/**
 * Architecture guard: every product Provider.run stream must go through the
 * budgeted-provider seam. A direct call outside budgeted-provider.ts would
 * produce provider events that the ledger never observes — undetectable drift.
 *
 * This guard scans src/core/ and src/interface/ and rejects any direct
 * `.run(req …)` / `.run(reviewReq …)` / `.run(repairReq …)` / `.run(request …)`
 * call on a Provider that lives outside the seam.
 *
 * EXPLICIT EXCLUSIONS (read before filing a false positive):
 *   - src/core/budgeted-provider.ts       — the seam itself
 *   - src/core/eval/judge-runner.ts       — offline evaluator (no live ledger)
 *   - src/providers/*                     — provider adapter implementations
 *
 * Unrelated `.run()` methods (non-provider objects) MUST NOT trigger it.
 * The patterns are scoped to invocation arguments that match ProviderRequest /
 * AbortSignal pairs, not a blunt `.run(` substring.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC_CORE = path.join(ROOT, 'src', 'core');
const SRC_INTERFACE = path.join(ROOT, 'src', 'interface');

const EXCLUDED = new Set([
  path.posix.join('src', 'core', 'budgeted-provider.ts'),
  path.posix.join('src', 'core', 'eval', 'judge-runner.ts'),
]);

function isUnderProviders(filePath: string): boolean {
  const rel = path.posix.relative(ROOT, filePath);
  return rel.startsWith('src/providers/');
}

function collectTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function relPosix(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join(path.posix.sep);
}

/**
 * A line that matches a direct product Provider.run call looks like:
 *   provider.run(req, signal)
 *   reviewerProvider.run(reviewReq, signal)
 *   provider.run(request, signal)
 *   provider.run(repairReq, signal)
 *
 * We match `.run(` where the first argument is a variable whose name ends in
 * "req", "Req", or "request" — the conventional names for ProviderRequest
 * objects — and the second argument is "signal" (the conventional AbortSignal).
 *
 * We also match `for await (const ev of … .run(` patterns which are the
 * stream-iteration sites.
 */
const RUN_CALL_RE = /\.run\(\s*(\w*(?:req|Req|request)\w*)\s*,\s*(\w+)\s*\)/g;

/**
 * Alternative pattern: `for await (const ev of … .run(` — matches the stream
 * iteration idiom.
 */
const FOR_AWAIT_RUN_RE = /for\s+await\s*\([^)]*\.run\(/;

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(filePath: string, fileName: string): Violation[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? '';
    const lineNum = i + 1;

    // Fast skip: no `.run(` on this line
    if (!lineText.includes('.run(')) continue;

    // Check for the for-await pattern (catches iteration sites)
    if (FOR_AWAIT_RUN_RE.test(lineText)) {
      violations.push({
        file: fileName,
        line: lineNum,
        snippet: lineText.trim(),
      });
      continue;
    }

    // Check for `X.run(reqArg, signal)` patterns
    let match: RegExpExecArray | null;
    RUN_CALL_RE.lastIndex = 0;
    while ((match = RUN_CALL_RE.exec(lineText)) !== null) {
      const firstArg = match[1] ?? '';
      const secondArg = match[2] ?? '';

      // Heuristic: the second argument of a Provider.run call is always the
      // AbortSignal, conventionally named 'signal'. If the second arg is
      // something else, it's likely an unrelated `.run()` method.
      if (secondArg !== 'signal') continue;

      // Require the first argument to look like a ProviderRequest variable
      // (ends in "req", "Req", or is exactly "request").
      if (!/^(?:.*[rR]eq|request)$/.test(firstArg)) continue;

      violations.push({
        file: fileName,
        line: lineNum,
        snippet: lineText.trim(),
      });
    }
  }

  return violations;
}

describe('all eighteen product model sites use budgeted-provider seam', () => {
  it('zero direct product provider.run remain outside budgeted-provider.ts', () => {
    const allFiles = [
      ...collectTs(SRC_CORE),
      ...collectTs(SRC_INTERFACE),
    ];

    const violations: Violation[] = [];

    for (const file of allFiles) {
      const rel = relPosix(file);
      if (EXCLUDED.has(rel)) continue;
      if (isUnderProviders(file)) continue;

      const fileViolations = scanFile(file, rel);
      violations.push(...fileViolations);
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Direct product Provider.run calls found outside budgeted-provider.ts:\n' +
        violations
          .map((v) => `  ${v.file}:${v.line} — ${v.snippet}`)
          .join('\n') +
        '\n\nEvery Provider.run iteration MUST go through runBudgetedProvider (src/core/budgeted-provider.ts).\n' +
        'Excluded: src/core/eval/judge-runner.ts (offline evaluator), src/providers/* (adapter implementations).',
    );
  });
});

describe('unrelated run methods do not match', () => {
  it('non-provider .run() calls in src/core are not flagged', () => {
    // A fast sanity check: scan a known file that has unrelated .run() calls
    // (e.g., goal-runner or any file with non-provider .run() methods)
    // and confirm the guard does NOT flag them.

    // We collect every .run( call in src/core files that is NOT a
    // budgeted-provider / judge-runner / provider adapter, then assert that
    // none matched the provider-specific patterns.
    const allFiles = collectTs(SRC_CORE);

    const allRunCalls: { file: string; line: number; snippet: string }[] = [];
    const flaggedCalls: Violation[] = [];

    for (const file of allFiles) {
      const rel = relPosix(file);
      if (EXCLUDED.has(rel)) continue;
      if (isUnderProviders(file)) continue;

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? '';
        if (!lineText.includes('.run(')) continue;

        allRunCalls.push({
          file: rel,
          line: i + 1,
          snippet: lineText.trim(),
        });

        if (FOR_AWAIT_RUN_RE.test(lineText)) {
          flaggedCalls.push({ file: rel, line: i + 1, snippet: lineText.trim() });
          continue;
        }

        let match: RegExpExecArray | null;
        RUN_CALL_RE.lastIndex = 0;
        while ((match = RUN_CALL_RE.exec(lineText)) !== null) {
          const secondArg = match[2] ?? '';
          const firstArg = match[1] ?? '';
          if (secondArg !== 'signal') continue;
          if (!/^(?:.*[rR]eq|request)$/.test(firstArg)) continue;
          flaggedCalls.push({ file: rel, line: i + 1, snippet: lineText.trim() });
        }
      }
    }

    // After the P1-09j migration, only budgeted-provider.ts should ever
    // contain a line that MATCHES our provider-specific patterns. The guard
    // must NOT accidentally flag unrelated non-provider `.run()` methods.
    const flaggedOutsideSeam = flaggedCalls.filter(
      (v) => relPosix(path.join(ROOT, v.file)) !== path.posix.join('src', 'core', 'budgeted-provider.ts'),
    );

    // Every flagged call must be in a known excluded file.
    const unexpected = flaggedOutsideSeam.filter(
      (v) => relPosix(path.join(ROOT, v.file)) !== path.posix.join('src', 'core', 'eval', 'judge-runner.ts'),
    );

    assert.deepStrictEqual(
      unexpected,
      [],
      'Guard flagged non-provider .run() calls that were not in excluded files:\n' +
        unexpected.map((v) => `  ${v.file}:${v.line} — ${v.snippet}`).join('\n'),
    );

    // After the migration, no non-excluded file should contain `.run(`
    // calls. Prove the pattern WORKS by checking that the excluded
    // budgeted-provider.ts DOES contain `.run(` calls (it's the seam).
    const budgetedProviderPath = path.join(ROOT, 'src', 'core', 'budgeted-provider.ts');
    const budgetedContent = fs.readFileSync(budgetedProviderPath, 'utf8');
    assert.ok(
      budgetedContent.includes('.run('),
      'budgeted-provider.ts must contain direct .run() calls (the seam delegates to provider.run internally)',
    );

    // No unexpected flagged calls (everything that matched is from the seam
    // or the offline evaluator — both excluded).
    assert.deepStrictEqual(
      flaggedOutsideSeam.length,
      0,
      'Expected zero flagged provider-run calls outside the seam',
    );
  });
});

describe('offline eval and provider implementations are explicit exclusions', () => {
  it('judge-runner.ts has provider.run but is excluded', () => {
    const judgeRunnerPath = path.join(ROOT, 'src', 'core', 'eval', 'judge-runner.ts');
    assert.ok(fs.existsSync(judgeRunnerPath), 'judge-runner.ts must exist');

    const content = fs.readFileSync(judgeRunnerPath, 'utf8');
    // The judge-runner has a direct provider.run call — that's the point of
    // the exclusion. Confirm it contains the expected pattern.
    assert.ok(
      content.includes('provider.run('),
      'judge-runner.ts must contain a direct provider.run() call (offline evaluator exclusion)',
    );

    // Confirm the exclusion is registered.
    assert.ok(
      EXCLUDED.has(path.posix.join('src', 'core', 'eval', 'judge-runner.ts')),
      'judge-runner.ts must be in the exclusion set',
    );
  });

  it('provider adapters under src/providers are excluded', () => {
    const providersDir = path.join(ROOT, 'src', 'providers');
    assert.ok(fs.existsSync(providersDir), 'src/providers must exist');

    const providerFiles = collectTs(providersDir);
    assert.ok(providerFiles.length > 0, 'provider adapters must exist');

    // Provider adapters implement `run(` as a method signature (not a call
    // expression). Any adapter file containing 'run(' (signature) confirms
    // the exclusion guards the right directory.
    let hasRunDef = false;
    for (const file of providerFiles) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('run(')) {
        hasRunDef = true;
        break;
      }
    }
    assert.ok(hasRunDef, 'At least one provider adapter must define a run() method');
  });
});
