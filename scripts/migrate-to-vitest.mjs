#!/usr/bin/env node
// One-shot codemod: node:test -> vitest for the test suite.
//
// What it does (deterministic, reviewable):
//   - Rewrites `import ... from 'node:test'` to `import { ... } from 'vitest'`,
//     normalising default `import test` / `import test, { mock }` to named imports.
//   - Maps hook names: before -> beforeAll, after -> afterAll (node:test's
//     file/suite-level hooks are vitest's beforeAll/afterAll). beforeEach/afterEach
//     and describe/it/test keep their names.
//   - Maps `mock` -> `vi` in the import list AND renames bare `before(` / `after(`
//     call sites to beforeAll( / afterAll(.
//
// It does NOT rewrite `mock.fn`/`mock.timers`/`mock.method` call bodies — those
// have different signatures in vi and are converted by hand. Files using them are
// listed at the end so they can be finished manually.
//
// Idempotent: files already importing from 'vitest' are skipped.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TEST_DIR = join(ROOT, 'test');

/** Recursively collect *.test.ts / *.test.tsx files. */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...collect(p));
    else if (/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const HOOK_MAP = { before: 'beforeAll', after: 'afterAll' };
const NAME_MAP = { mock: 'vi' };

const importRe = /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]node:test['"];?/;

const touched = [];
const needsMockReview = [];

for (const file of collect(TEST_DIR)) {
  let src = readFileSync(file, 'utf8');
  const m = src.match(importRe);
  if (!m) continue;

  const defaultImport = m[1]; // e.g. `test` from `import test from 'node:test'`
  const named = (m[2] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const finalNames = new Set();
  if (defaultImport) finalNames.add(defaultImport); // default `test` -> named test
  for (const n of named) finalNames.add(NAME_MAP[n] ?? HOOK_MAP[n] ?? n);

  // Rewrite the import statement.
  const sorted = [...finalNames].sort();
  const newImport = `import { ${sorted.join(', ')} } from 'vitest';`;
  src = src.replace(importRe, newImport);

  // Rename before()/after() call sites to beforeAll()/afterAll() (word-boundary,
  // only the bare hook calls — never beforeEach/afterEach or *.before).
  if (named.includes('before')) src = src.replace(/(^|[^.\w])before\s*\(/g, '$1beforeAll(');
  if (named.includes('after')) src = src.replace(/(^|[^.\w])after\s*\(/g, '$1afterAll(');

  writeFileSync(file, src);
  touched.push(file);
  if (finalNames.has('vi')) needsMockReview.push(file);
}

console.log(`migrated ${touched.length} files`);
if (needsMockReview.length) {
  console.log(`\nNEEDS MANUAL mock->vi body review (${needsMockReview.length}):`);
  for (const f of needsMockReview) console.log('  ' + f.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
}
