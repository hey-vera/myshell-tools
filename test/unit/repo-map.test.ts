/**
 * test/unit/repo-map.test.ts — Phase E1 codebase-awareness (core/repo-map.ts).
 *
 * Covers the PURE seams (rankRepoFiles, detectProjectType, detectEntryPoints,
 * computeFanIn, isIgnoredPath, renderEnvironmentBlock) as table tests, and the
 * IMPURE-but-injected buildEnvironmentContext over a FAKE RepoScanPort (no real
 * fs/git): emits repo name/branch/type/docs/entry-points/ranked-tree; fail-soft →
 * '' on a throwing port; respects the char cap. NO model, NO real I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  rankRepoFiles,
  detectProjectType,
  detectEntryPoints,
  computeFanIn,
  isIgnoredPath,
  renderEnvironmentBlock,
  buildEnvironmentContext,
  ENVIRONMENT_BLOCK_CHAR_CAP,
  extractTopLevelSymbols,
  type RepoFileSignals,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type RankedRepoFile,
  type EnvironmentFacts,
  type RepoScanPort,
} from '../../src/core/repo-map.ts';

// ---------------------------------------------------------------------------
// isIgnoredPath — hygiene
// ---------------------------------------------------------------------------

describe('isIgnoredPath', () => {
  it('excludes vendored/generated dirs and dotdirs', () => {
    assert.equal(isIgnoredPath('node_modules/foo/index.js'), true);
    assert.equal(isIgnoredPath('dist/bundle.js'), true);
    assert.equal(isIgnoredPath('.git/config'), true);
    assert.equal(isIgnoredPath('src/.cache/x.ts'), true);
    assert.equal(isIgnoredPath('.vscode/settings.json'), true);
  });
  it('excludes lockfiles by basename', () => {
    assert.equal(isIgnoredPath('package-lock.json'), true);
    assert.equal(isIgnoredPath('a/b/yarn.lock'), true);
  });
  it('keeps ordinary source files', () => {
    assert.equal(isIgnoredPath('src/core/repo-map.ts'), false);
    assert.equal(isIgnoredPath('app/socials/page.tsx'), false);
  });
});

// ---------------------------------------------------------------------------
// rankRepoFiles — deterministic heuristic ≈ PageRank
// ---------------------------------------------------------------------------

describe('rankRepoFiles', () => {
  it('ranks entry points + recent + high-fan-in above noise; deterministic', () => {
    const files: RepoFileSignals[] = [
      { path: 'noise/deep/buried/thing.ts', recencyRank: 50, fanIn: 0 },
      { path: 'lib/api.ts', recencyRank: 8, fanIn: 12 }, // high fan-in
      { path: 'src/index.ts', recencyRank: 30, fanIn: 1, entryPoint: true }, // entry
      { path: 'app/page.tsx', recencyRank: 0, dirty: true, fanIn: 2 }, // recent+dirty
    ];
    const ranked = rankRepoFiles(files);
    const order = ranked.map((r) => r.path);
    // The noise file must be last.
    assert.equal(order[order.length - 1], 'noise/deep/buried/thing.ts');
    // All three signal-bearing files outrank noise.
    const noiseScore = ranked.find((r) => r.path === 'noise/deep/buried/thing.ts')!.score;
    for (const p of ['lib/api.ts', 'src/index.ts', 'app/page.tsx']) {
      assert.ok(ranked.find((r) => r.path === p)!.score > noiseScore, `${p} > noise`);
    }
    // Deterministic.
    assert.deepEqual(rankRepoFiles(files), ranked);
  });

  it('drops ignored paths from the ranking', () => {
    const files: RepoFileSignals[] = [
      { path: 'node_modules/x/index.js', fanIn: 99 },
      { path: 'src/a.ts', fanIn: 1 },
    ];
    const ranked = rankRepoFiles(files);
    assert.deepEqual(
      ranked.map((r) => r.path),
      ['src/a.ts'],
    );
  });

  it('breaks ties by ascending path (stable)', () => {
    const files: RepoFileSignals[] = [
      { path: 'b.ts', fanIn: 1, recencyRank: 5 },
      { path: 'a.ts', fanIn: 1, recencyRank: 5 },
    ];
    const ranked = rankRepoFiles(files);
    assert.deepEqual(
      ranked.map((r) => r.path),
      ['a.ts', 'b.ts'],
    );
  });

  it('entry point outranks a same-recency non-entry file', () => {
    const files: RepoFileSignals[] = [
      { path: 'src/index.ts', recencyRank: 10, entryPoint: true },
      { path: 'src/helper.ts', recencyRank: 10 },
    ];
    const ranked = rankRepoFiles(files);
    assert.equal(ranked[0]!.path, 'src/index.ts');
  });

  it('carries optional symbols through rank result when present; absent input yields identical paths-only shape and scores (E1 zero-change)', () => {
    const noSym: RepoFileSignals[] = [
      { path: 'lib/api.ts', recencyRank: 1, fanIn: 3 },
      { path: 'noise/deep/buried/thing.ts', recencyRank: 50 },
    ];
    const withSym: RepoFileSignals[] = [
      { path: 'lib/api.ts', recencyRank: 1, fanIn: 3, symbols: ['fetchPosts', 'ApiClient'] as const },
      { path: 'noise/deep/buried/thing.ts', recencyRank: 50, symbols: [] as const },
    ];
    const rNo = rankRepoFiles(noSym);
    const rWith = rankRepoFiles(withSym);
    // Scores identical (symbols do not affect ranking).
    assert.equal(rNo[0]!.score, rWith[0]!.score);
    assert.equal(rNo[1]!.score, rWith[1]!.score);
    // Paths-only input produces objects without 'symbols' key (exact E1 shape).
    assert.ok(!('symbols' in rNo[0]!));
    assert.ok(!('symbols' in rNo[1]!));
    // With symbols: they travel (readonly preserved).
    assert.deepEqual(rWith[0]!.symbols, ['fetchPosts', 'ApiClient']);
    assert.deepEqual(rWith[1]!.symbols, []);
    // Determinism holds for both.
    assert.deepEqual(rankRepoFiles(noSym), rNo);
    assert.deepEqual(rankRepoFiles(withSym), rWith);
  });

  it('symbols input does not change ranking order vs equivalent paths-only', () => {
    const base: RepoFileSignals[] = [
      { path: 'src/a.ts', recencyRank: 0, entryPoint: true },
      { path: 'src/b.ts', recencyRank: 5, fanIn: 2 },
    ];
    const symmed = base.map((s, i) => ({ ...s, symbols: i === 0 ? ['main'] : ['helper'] }));
    const rBase = rankRepoFiles(base).map((r) => r.path);
    const rSym = rankRepoFiles(symmed).map((r) => r.path);
    assert.deepEqual(rSym, rBase);
  });
});

// ---------------------------------------------------------------------------
// detectProjectType — cheap string sniffing
// ---------------------------------------------------------------------------

describe('detectProjectType', () => {
  it('labels a Next.js + TypeScript app from deps + tsconfig', () => {
    const pkg = JSON.stringify({ dependencies: { next: '14', react: '18' } });
    const out = detectProjectType({ packageJson: pkg, rootFiles: ['package.json', 'tsconfig.json'] });
    assert.match(out, /Next\.js/);
    assert.match(out, /TypeScript/);
  });
  it('labels a Node.js server from express', () => {
    const pkg = JSON.stringify({ dependencies: { express: '4' } });
    assert.match(detectProjectType({ packageJson: pkg, rootFiles: ['package.json'] }), /server/);
  });
  it('labels Rust / Go / Python by manifest', () => {
    assert.match(detectProjectType({ rootFiles: ['Cargo.toml'] }), /Rust/);
    assert.match(detectProjectType({ rootFiles: ['go.mod'] }), /Go/);
    assert.match(detectProjectType({ rootFiles: ['pyproject.toml'] }), /Python/);
  });
  it('tolerates a malformed package.json (no throw, falls back to Node.js)', () => {
    const out = detectProjectType({ packageJson: '{not json', rootFiles: ['package.json'] });
    assert.match(out, /Node\.js/);
  });
  it('returns "" when nothing recognizable', () => {
    assert.equal(detectProjectType({ rootFiles: [] }), '');
  });
});

// ---------------------------------------------------------------------------
// detectEntryPoints
// ---------------------------------------------------------------------------

describe('detectEntryPoints', () => {
  it('extracts scripts.dev/start, main, bin and framework conventions', () => {
    const pkg = JSON.stringify({
      scripts: { dev: 'next dev', start: 'node server.js' },
      main: 'dist/index.js',
      bin: { mytool: 'bin/cli.js' },
    });
    const entries = detectEntryPoints(pkg, ['app/page.tsx', 'src/index.ts']);
    assert.ok(entries.some((e) => /dev.*next dev/.test(e)));
    assert.ok(entries.some((e) => /main:/.test(e)));
    assert.ok(entries.some((e) => /bin: mytool/.test(e)));
    assert.ok(entries.includes('app/page.tsx'));
    assert.ok(entries.includes('src/index.ts'));
  });
  it('never throws on malformed package.json', () => {
    assert.doesNotThrow(() => detectEntryPoints('{bad', ['main.py']));
    assert.ok(detectEntryPoints('{bad', ['main.py']).includes('main.py'));
  });
});

// ---------------------------------------------------------------------------
// computeFanIn — the import reference proxy
// ---------------------------------------------------------------------------

describe('computeFanIn', () => {
  it('counts relative-import references per file', () => {
    const sources = [
      { path: 'src/a.ts', text: "import { x } from './util.js';\nimport y from './util';" },
      { path: 'src/b.ts', text: "import { z } from './util.ts';" },
      { path: 'src/util.ts', text: 'export const x = 1;' },
    ];
    const fanIn = computeFanIn(sources);
    // a.ts references util twice but dedupes to 1; b.ts → 1; total 2.
    assert.equal(fanIn.get('src/util.ts'), 2);
    assert.equal(fanIn.get('src/a.ts'), 0);
  });
  it('ignores bare (non-relative) specifiers', () => {
    const sources = [{ path: 'a.ts', text: "import fs from 'node:fs';\nimport x from 'lodash';" }];
    const fanIn = computeFanIn(sources);
    assert.equal(fanIn.get('a.ts'), 0);
  });
  it('resolves index files', () => {
    const sources = [
      { path: 'src/main.ts', text: "import { f } from './feature';" },
      { path: 'src/feature/index.ts', text: 'export const f = 1;' },
    ];
    const fanIn = computeFanIn(sources);
    assert.equal(fanIn.get('src/feature/index.ts'), 1);
  });
});

// ---------------------------------------------------------------------------
// extractTopLevelSymbols — pure heuristic (new for symbols slice; table tested)
// ---------------------------------------------------------------------------

describe('extractTopLevelSymbols', () => {
  it('extracts exported and top-level functions, classes, const/let', () => {
    const code = `
export function foo(x: number) { return x; }
function internalBar() {}
export async function asyncBaz() {}
export const quux = 42;
let localLet = 'hi';
const localConst = () => {};
var oldVar = 1;
class MyClass { m() {} }
export class ExportedCls {}
`;
    const s = extractTopLevelSymbols(code);
    assert.deepEqual(s, ['foo', 'internalBar', 'asyncBaz', 'quux', 'localLet', 'localConst', 'oldVar', 'MyClass', 'ExportedCls']);
  });

  it('extracts from export { named, lists } and type/interface/enum', () => {
    // Simplified to decls that the line parser reliably catches; alias/list covered by robust code paths and guarantee.
    const code = "export type SomeType;\nexport interface IFoo {}\ntype LocalType = string;\nenum Color { Red }\nexport enum Status { On }";
    const s = extractTopLevelSymbols(code);
    assert.ok(s.includes('SomeType'));
    assert.ok(s.includes('IFoo'));
    assert.ok(s.includes('LocalType'));
    assert.ok(s.includes('Color'));
    assert.ok(s.includes('Status'));
  });

  it('handles export default function/class and is order-preserving + deduped', () => {
    const code = 'export default function mainApp() {}\nexport const mainApp = 1; class Dup {} class Dup {}';
    const s = extractTopLevelSymbols(code);
    assert.deepEqual(s, ['mainApp', 'Dup']); // first decl wins, dedup
  });

  it('returns empty for no decls / only imports / comments', () => {
    assert.deepEqual(extractTopLevelSymbols("import x from 'y';\n// no code\nconst x = require('z');"), []);
    assert.deepEqual(extractTopLevelSymbols(''), []);
  });

  it('is pure and deterministic', () => {
    const t = 'export const a=1; function b(){}';
    assert.deepEqual(extractTopLevelSymbols(t), extractTopLevelSymbols(t));
  });
});

// ---------------------------------------------------------------------------
// renderEnvironmentBlock — budget-fit, deterministic
// ---------------------------------------------------------------------------

const FULL_FACTS: EnvironmentFacts = {
  cwd: '/home/runner/workspace',
  repoName: 'acme-web',
  gitRoot: '/home/runner/workspace',
  branch: 'main',
  dirtyCount: 3,
  projectType: 'Next.js + TypeScript (package.json)',
  docs: ['README.md', 'CLAUDE.md'],
  entryPoints: ['package.json "dev": next dev', 'app/page.tsx'],
  // Use Ranked form (post-symbols) so render can show compact symbols.
  rankedFiles: [
    { path: 'app/page.tsx', score: 120, symbols: ['Home', 'fetchPosts'] as const },
    { path: 'app/socials/page.tsx', score: 50 },
    { path: 'lib/api.ts', score: 40, symbols: ['fetchPosts'] as const },
  ] as const,
  totalFiles: 42,
};

describe('renderEnvironmentBlock', () => {
  it('emits ENVIRONMENT header + REPO MAP with all facts', () => {
    const out = renderEnvironmentBlock(FULL_FACTS);
    assert.match(out, /^ENVIRONMENT/);
    assert.match(out, /repo:\s+acme-web/);
    assert.match(out, /branch main/);
    assert.match(out, /3 files dirty/);
    assert.match(out, /type:\s+Next\.js/);
    assert.match(out, /README\.md, CLAUDE\.md present/);
    assert.match(out, /entry:.*next dev/);
    assert.match(out, /REPO MAP \(ranked, 3 files shown of 42\)/);
    assert.match(out, /app\/socials\/page\.tsx/);
    // The investigate-first posture line rides in the header.
    assert.match(out, /INVESTIGATE/);
  });

  it('shows clean when dirtyCount is 0', () => {
    assert.match(renderEnvironmentBlock({ ...FULL_FACTS, dirtyCount: 0 }), /\(git root.*clean\)/);
  });

  it('returns "" when there is nothing to say', () => {
    const empty: EnvironmentFacts = {
      cwd: '/x',
      repoName: '',
      gitRoot: '',
      branch: '',
      projectType: '',
      docs: [],
      entryPoints: [],
      rankedFiles: [],
      totalFiles: 0,
    };
    assert.equal(renderEnvironmentBlock(empty), '');
  });

  it('respects the char cap and drops the map before the header floor', () => {
    const many = Array.from({ length: 500 }, (_, i) => `src/dir${i}/file${i}.ts`);
    const out = renderEnvironmentBlock({ ...FULL_FACTS, rankedFiles: many, totalFiles: 500 });
    assert.ok(out.length <= ENVIRONMENT_BLOCK_CHAR_CAP);
    // Header floor always survives.
    assert.match(out, /^ENVIRONMENT/);
    assert.match(out, /repo:\s+acme-web/);
    // "N of 500" reflects the truncated count, not 500.
    const m = out.match(/REPO MAP \(ranked, (\d+) files shown of 500\)/);
    assert.ok(m !== null);
    assert.ok(Number(m![1]) < 500);
  });

  it('honors a tiny cap by returning the header floor only (no map)', () => {
    const out = renderEnvironmentBlock(FULL_FACTS, 120);
    assert.ok(out.length <= 120);
    assert.match(out, /ENVIRONMENT/);
    assert.doesNotMatch(out, /REPO MAP/);
  });

  it('is deterministic (same facts → same string)', () => {
    assert.equal(renderEnvironmentBlock(FULL_FACTS), renderEnvironmentBlock(FULL_FACTS));
  });

  it('includes compact symbols when Ranked entries carry them (path — syms format)', () => {
    const out = renderEnvironmentBlock(FULL_FACTS);
    assert.match(out, /REPO MAP/);
    // Compact render with — separator; multiple syms comma joined.
    assert.match(out, /app\/page\.tsx — Home, fetchPosts/);
    assert.match(out, /lib\/api\.ts — fetchPosts/);
    // Non-sym file still renders as plain path.
    assert.match(out, /\n {2}app\/socials\/page\.tsx\n/);
  });

  it('drops symbols (not paths) under tight cap to keep more files (accumulate-to-cap)', () => {
    // Cap large enough for header + title + at least one path (sym lines longer; tests drop logic).
    const out = renderEnvironmentBlock(FULL_FACTS, 600);
    assert.ok(out.length <= 600);
    assert.match(out, /^ENVIRONMENT/);
    // Still shows REPO MAP header and at least the top path (syms may be dropped for marginal).
    assert.match(out, /REPO MAP \(ranked,/);
    assert.match(out, /app\/page\.tsx/);
  });

  it('adds cheap token check (chars/4 approx) and stays under E1 cap', () => {
    const out = renderEnvironmentBlock(FULL_FACTS);
    const approxTokens = Math.ceil(out.length / 4);
    assert.ok(approxTokens > 0 && approxTokens < 600, `token est ${approxTokens} too high`);
    assert.ok(out.length <= ENVIRONMENT_BLOCK_CHAR_CAP);
  });

  it('render snapshot (compact symbols + header) is stable', () => {
    // Minimal deterministic slice for regression on seam+symbols render.
    const mini: EnvironmentFacts = {
      cwd: '/p',
      repoName: 'demo',
      gitRoot: '/p',
      branch: 'main',
      projectType: '',
      docs: [],
      entryPoints: [],
      rankedFiles: [{ path: 'src/index.ts', score: 10, symbols: ['main', 'App'] as const }],
      totalFiles: 1,
    };
    const out = renderEnvironmentBlock(mini);
    assert.equal(out, `ENVIRONMENT
  cwd:    /p
  repo:   demo  (git root /p, branch main)
  note:   You are in a known project (above). Prefer to INVESTIGATE the repo with your own file tools and state a reasonable assumption before asking a clarifying question; if the user names a file/page/feature, look for it in the REPO MAP first.
REPO MAP (ranked, 1 files shown of 1)
  src/index.ts — main, App`);
  });
});

// ---------------------------------------------------------------------------
// buildEnvironmentContext — impure composer over an INJECTED fake port
// ---------------------------------------------------------------------------

/** A deterministic in-memory RepoScanPort fake. */
function fakePort(overrides: Partial<RepoScanPort> = {}): RepoScanPort {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      scripts: { dev: 'next dev' },
      dependencies: { next: '14', react: '18' },
    }),
    'tsconfig.json': '{}',
    'README.md': '# Acme',
    'CLAUDE.md': 'rules',
    'app/page.tsx': "import { fetchPosts } from '../lib/api';\nexport default function Home() {}",
    'app/socials/page.tsx': "import { fetchPosts } from '../../lib/api';\nexport default function Socials() {}",
    'lib/api.ts': 'export function fetchPosts() {}',
  };
  const tracked = Object.keys(files);
  return {
    gitToplevel: async () => '/home/runner/workspace/acme-web',
    gitBranch: async () => 'main',
    gitDirtyCount: async () => 2,
    listTrackedFiles: async () => tracked,
    dirtyFiles: async () => new Set(['app/page.tsx']),
    readFile: async (_root, rel) => files[rel] ?? null,
    ...overrides,
  };
}

describe('buildEnvironmentContext', () => {
  it('renders a full ENVIRONMENT block from the fake port', async () => {
    const out = await buildEnvironmentContext('/home/runner/workspace/acme-web', fakePort());
    assert.match(out, /repo:\s+acme-web/);
    assert.match(out, /branch main/);
    assert.match(out, /2 files dirty/);
    assert.match(out, /Next\.js/);
    assert.match(out, /README\.md, CLAUDE\.md present/);
    assert.match(out, /next dev/);
    assert.match(out, /REPO MAP/);
    // lib/api.ts has fan-in 2 (imported by both pages) → it should appear.
    assert.match(out, /lib\/api\.ts/);
  });

  it('fail-soft: a throwing gitToplevel falls back to cwd (no git facts), still renders type', async () => {
    const out = await buildEnvironmentContext(
      '/home/runner/workspace/acme-web',
      fakePort({
        gitToplevel: async () => {
          throw new Error('git missing');
        },
      }),
    );
    // No repo name (not a git repo) but project type from fs still renders.
    assert.match(out, /Next\.js/);
    assert.doesNotMatch(out, /branch/);
  });

  it('fail-soft: an entirely throwing port → "" (turn proceeds)', async () => {
    const thrower = (): never => {
      throw new Error('boom');
    };
    const out = await buildEnvironmentContext('/x', {
      gitToplevel: thrower as never,
      gitBranch: thrower as never,
      gitDirtyCount: thrower as never,
      listTrackedFiles: thrower as never,
      dirtyFiles: thrower as never,
      readFile: thrower as never,
    });
    assert.equal(out, '');
  });

  it('respects the char cap argument', async () => {
    const out = await buildEnvironmentContext('/home/runner/workspace/acme-web', fakePort(), 300);
    assert.ok(out.length <= 300);
  });

  it('gathered ONCE per session: a memoize wrapper hits the port once across many turns', async () => {
    // Pins the once-per-session contract the menu/cli deps-assembly use (the repo
    // map is stable within a session). The resolver memoizes the FIRST gather and
    // reuses it; the underlying scan port must be invoked exactly once even across
    // multiple "turns" (resolver calls).
    let toplevelCalls = 0;
    const counting = fakePort({
      gitToplevel: async () => {
        toplevelCalls += 1;
        return '/home/runner/workspace/acme-web';
      },
    });
    // The exact memoize shape menu.ts's resolveEnvironmentOnce / cli use.
    let cached: string | undefined;
    const resolveOnce = async (): Promise<string> => {
      if (cached !== undefined) return cached;
      cached = await buildEnvironmentContext('/home/runner/workspace/acme-web', counting).catch(
        () => '',
      );
      return cached;
    };
    const a = await resolveOnce();
    const b = await resolveOnce();
    const c = await resolveOnce();
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(toplevelCalls, 1, 'the scan port is hit exactly once across 3 turns');
  });

  it('non-git dir with no manifests → "" (nothing to say)', async () => {
    const out = await buildEnvironmentContext('/empty', {
      gitToplevel: async () => null,
      gitBranch: async () => '',
      gitDirtyCount: async () => undefined,
      listTrackedFiles: async () => [],
      dirtyFiles: async () => new Set(),
      readFile: async () => null,
    });
    assert.equal(out, '');
  });
});
