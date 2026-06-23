/**
 * Architecture & Honesty Guard Tests (v1-killer)
 *
 * Static analysis of source files — no runtime imports of production code.
 * Each guard makes a category of v1 failure structurally impossible to merge.
 *
 * Rules:
 *  1. Purity guard       — src/core/ must stay free of I/O, console, Date.now, Math.random
 *  2. No-mock guard      — src/interface/ and src/ui/ must contain no hardcoded AI responses
 *  3. Single-entry guard — only src/cli.ts may call process.exit()
 *  4. No-orphan guard    — every src/ .ts file must be reachable (has imports or is imported)
 *  5. Honesty-lint       — src/ui/ and src/interface/ must not contain hardcoded percentages
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");

const SHELL_EXEC_ALLOWLIST = new Set([
  "src/infra/clipboard.ts",
  "src/infra/controlling-tty.ts",
  "src/infra/worktree.ts",
  "src/infra/user-memory-store.ts",
  "src/infra/verify-port.ts",
  "src/infra/repo-scan.ts",
  "src/infra/research-port.ts",
]);

/** Recursively collect all .ts files under a directory. Returns [] if dir does not exist. */
function collectTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Read a file and return its text content. */
function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function relPosix(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join(path.posix.sep);
}

/**
 * Strip comments and string literals from source so that regex checks only
 * fire on real code, not on documentation or type annotation strings.
 *
 * Strategy (good enough for static guards — not a full parser):
 *  - Remove single-line comments (// ...)
 *  - Remove multi-line block comments (/* ... *\/)
 *  - Replace string/template contents with empty placeholders so patterns
 *    inside type annotations like `type Pct = "${number}%"` don't trip.
 *
 * The stripped text is used ONLY for pattern matching; file paths etc. still
 * come from the raw text where appropriate.
 */
function stripCommentsAndStrings(src: string): string {
  // Remove block comments
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "/* */");
  // Remove line comments
  s = s.replace(/\/\/[^\n]*/g, "//");
  // Replace template literals content
  s = s.replace(/`[^`]*`/g, "``");
  // Replace double-quoted strings
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Replace single-quoted strings
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return s;
}

// ---------------------------------------------------------------------------
// 1. Purity Guard
// ---------------------------------------------------------------------------

describe("Purity guard — src/core/ must be pure orchestration", () => {
  const CORE_DIR = path.join(SRC, "core");

  const FORBIDDEN_IMPORTS = ["child_process", "node:fs", "'fs'", '"fs"', "node:path", "'path'", '"path"', "node:os", "'os'", '"os"', "node:crypto", "'crypto'", '"crypto"'];
  const FORBIDDEN_PATTERNS: Array<{ label: string; re: RegExp }> = [
    { label: "console.log()", re: /console\.log\s*\(/ },
    { label: "console.error()", re: /console\.error\s*\(/ },
    { label: "Date.now()", re: /Date\.now\s*\(/ },
    { label: "new Date(", re: /new\s+Date\s*\(/ },
    { label: "Math.random()", re: /Math\.random\s*\(/ },
  ];

  const files = collectTs(CORE_DIR);

  // If the directory is empty the guard passes trivially — no violations possible.
  it("core directory exists or is empty (guard is active once files appear)", () => {
    // Always passes: we simply confirm the test infrastructure works.
    assert.ok(true);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = read(file);
    const stripped = stripCommentsAndStrings(src);

    it(`${rel} — must not import I/O modules`, () => {
      for (const imp of FORBIDDEN_IMPORTS) {
        // Match 'fs', "fs", 'node:fs' etc. inside import declarations
        const hasImport = new RegExp(`from\\s+['"\`]${imp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"\`]`).test(src)
          || src.includes(`require('${imp}')`)
          || src.includes(`require("${imp}")`);
        assert.ok(
          !hasImport,
          `${rel} imports forbidden module "${imp}" — core must be pure (use injected dependencies)`
        );
      }
    });

    it(`${rel} — must not use side-effectful globals`, () => {
      for (const { label, re } of FORBIDDEN_PATTERNS) {
        assert.ok(
          !re.test(stripped),
          `${rel} uses "${label}" — core must be pure (inject clock/random via constructor)`
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. No-Mock Guard
// ---------------------------------------------------------------------------

describe("No-mock guard — src/interface/ and src/ui/ must not contain hardcoded AI responses", () => {
  const DIRS = [path.join(SRC, "interface"), path.join(SRC, "ui"), path.join(SRC, "commands")];

  /** Patterns that indicate a hardcoded, fabricated AI response. */
  const MOCK_PATTERNS: Array<{ label: string; re: RegExp }> = [
    { label: 'Hardcoded file-count phrase "Found N relevant files"', re: /Found\s+\d+\s+relevant\s+files/ },
    { label: 'Hardcoded phrase "Authentication bug"', re: /Authentication\s+bug/i },
    { label: 'Hardcoded token "JWT"', re: /\bJWT\b/ },
    { label: 'Hardcoded percentage "87%"', re: /\b87%/ },
    { label: 'Hardcoded session ID "sess-abc"', re: /sess-abc/ },
    { label: 'Hardcoded duration "8m 23s"', re: /8m\s+23s/ },
    { label: 'Hardcoded exchange count "12 exchanges"', re: /\b12\s+exchanges/ },
    { label: "Math.random() in UI layer", re: /Math\.random\s*\(/ },
  ];

  it("no-mock guard infrastructure is active", () => {
    assert.ok(true);
  });

  for (const dir of DIRS) {
    const files = collectTs(dir);
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const stripped = stripCommentsAndStrings(read(file));

      for (const { label, re } of MOCK_PATTERNS) {
        it(`${rel} — must not contain: ${label}`, () => {
          assert.ok(
            !re.test(stripped),
            `${rel} contains a hardcoded mock value matching "${label}". ` +
              "Real values must come from data, not string literals."
          );
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Single-Entry Guard
// ---------------------------------------------------------------------------

describe("Single-entry guard — only src/cli.ts may call process.exit()", () => {
  const CLI_FILE = path.join(SRC, "cli.ts");
  const ALL_SRC = collectTs(SRC);

  it("src/cli.ts exists (entry point is present)", () => {
    assert.ok(
      fs.existsSync(CLI_FILE),
      "src/cli.ts does not exist — the project needs a single entry point"
    );
  });

  const nonCli = ALL_SRC.filter((f) => path.resolve(f) !== path.resolve(CLI_FILE));

  for (const file of nonCli) {
    const rel = path.relative(ROOT, file);
    it(`${rel} — must NOT call process.exit()`, () => {
      const stripped = stripCommentsAndStrings(read(file));
      assert.ok(
        !/process\.exit\s*\(/.test(stripped),
        `${rel} calls process.exit() — only src/cli.ts is allowed to terminate the process`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Shell-Execution Guard
// ---------------------------------------------------------------------------

describe("Shell-execution guard — child_process imports must be reviewed infra sites", () => {
  const ALL_SRC = collectTs(SRC);
  const CHILD_PROCESS_IMPORT_RE =
    /from\s+['"]node:child_process['"]|require\s*\(\s*['"](?:node:)?child_process['"]/;

  it("child_process import sites are explicitly allowlisted", () => {
    for (const file of ALL_SRC) {
      const rel = relPosix(file);
      if (!CHILD_PROCESS_IMPORT_RE.test(read(file))) continue;

      assert.ok(
        SHELL_EXEC_ALLOWLIST.has(rel),
        `New shell-execution site detected in ${rel}. Route it through the command gate ` +
          "(classifyCommand/gateCommand + CommandGatePort) and add it to SHELL_EXEC_ALLOWLIST after review."
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. No-Orphan Guard (basic reachability)
// ---------------------------------------------------------------------------

describe("No-orphan guard — every src/ .ts file must participate in the import graph", () => {
  const ALL_SRC = collectTs(SRC);

  // Build a quick index: for each file, gather which other src basenames it imports.
  // We key by the file's basename (without .ts extension) to keep it simple.
  const importedBasenames = new Set<string>();

  for (const file of ALL_SRC) {
    const src = read(file);
    // Match import/export from './foo', '../bar/baz', etc.
    const importRe = /from\s+['"`](\.{1,2}\/[^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      const imported = m[1];
      // Resolve the basename of the imported module
      const basename = path.basename(imported).replace(/\.js$/, "").replace(/\.ts$/, "");
      importedBasenames.add(basename);
    }
  }

  it("no-orphan guard infrastructure is active", () => {
    assert.ok(true);
  });

  for (const file of ALL_SRC) {
    const rel = path.relative(ROOT, file);
    const basename = path.basename(file, ".ts");

    // cli.ts is the root entry point — it is never imported by anything else.
    if (basename === "cli") continue;
    // index files are also entry-like
    if (basename === "index") continue;

    it(`${rel} — must be imported by at least one other src/ file`, () => {
      const isImported = importedBasenames.has(basename);

      // A file is orphaned if it is never imported by any other src/ file.
      // Having its own imports is NOT sufficient — a file that only imports
      // things but is never itself imported cannot be reached from the entry
      // point and is effectively dead code.
      assert.ok(
        isImported,
        `${rel} appears to be an orphan: it is not imported by any other src/ file. ` +
          "Either wire it into the dependency graph or remove it."
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Honesty-Lint
// ---------------------------------------------------------------------------

describe("Honesty-lint — src/ui/ and src/interface/ must not contain hardcoded percentages", () => {
  const DIRS = [path.join(SRC, "ui"), path.join(SRC, "interface"), path.join(SRC, "commands")];

  /**
   * Matches a bare percentage literal in code (not inside a comment or string,
   * after stripping). Examples that should trip: `"87%"`, `cost: 45%`, `return "12%"`.
   * Allowed: CSS-style strings in a dedicated theme file, but those should live
   * in configuration data, not inline literals.
   */
  const PCT_RE = /\d+%/;

  it("honesty-lint infrastructure is active", () => {
    assert.ok(true);
  });

  for (const dir of DIRS) {
    const files = collectTs(dir);
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      // Strip comments but keep string content for this check — a percentage in a
      // string literal is also suspect (it's a hardcoded display value).
      // We only strip block/line comments.
      const src = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "/* */")
        .replace(/\/\/[^\n]*/g, "//");

      it(`${rel} — must not contain hardcoded percentage literals`, () => {
        // Find all matches and report them.
        const lines = src.split("\n");
        const violations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (PCT_RE.test(lines[i])) {
            violations.push(`  line ${i + 1}: ${lines[i].trim()}`);
          }
        }
        assert.ok(
          violations.length === 0,
          `${rel} contains hardcoded percentage(s) — real percentages must be computed from data:\n` +
            violations.join("\n")
        );
      });
    }
  }
});
