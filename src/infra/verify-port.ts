/**
 * src/infra/verify-port.ts — the IMPURE git/test exec behind the verify stage's
 * {@link VerifyPort} (master-plan PHASE 3, the centerpiece).
 *
 * Mirrors repo-scan.ts EXACTLY: every git/fs/exec operation is wrapped so a missing
 * `git`, a non-repo dir, a missing test runner, or a hanging test degrades to an
 * empty/null/`errored` result rather than failing the turn. The pure four-state
 * mapping + receipt + diff-scoped critic prompt live in core/verify.ts; this is
 * only the raw-facts reader + the bounded, non-destructive test exec.
 *
 * NON-DESTRUCTIVE + BOUNDED: tests run with a TIMEOUT, output captured, and a
 * non-zero exit is read as RED (never thrown). No network is forced; the command
 * is the project's own (`package.json` "test" or a detected runner) — arbitrary
 * code, so the caller gates it (confirm/flag) and we bound it hard.
 *
 * NO model call, NO embeddings, NO metered service — just `git` + the project's
 * own test command via execa (already a dep). Subscription-clean.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile as fsReadFile, stat as fsStat, readdir as fsReaddir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

import type {
  VerifyPort,
  CapturedDiff,
  DetectedTestCommand,
  TestRunResult,
} from '../core/verify.js';
import type { CommandGatePort, CommandGateDecision } from '../core/command-gate.js';

const execFileAsync = promisify(execFile);
type ExecaRunner = typeof execa;

/** Cap so a pathological `git diff` can never hang the verify gather. */
const GIT_TIMEOUT_MS = 4000;
/** Bound the diff text we carry into the critic prompt (token-safety upstream too). */
const MAX_DIFF_BUFFER = 8 * 1024 * 1024;
/** Bound the captured test output. */
const MAX_TEST_OUTPUT_CHARS = 64 * 1024;

/**
 * The production {@link VerifyPort}. Each method swallows its own failure so the
 * pure caller's try/catch is belt-and-suspenders — a misbehaving port can never
 * break the turn.
 */
export function createNodeVerifyPort(deps: { readonly execa?: ExecaRunner } = {}): VerifyPort & {
  runTests(
    cwd: string,
    command: DetectedTestCommand,
    timeoutMs: number,
    commandGate?: CommandGatePort,
  ): Promise<TestRunResult>;
} {
  const runExeca = deps.execa ?? execa;

  return {
  async captureDiff(cwd: string, editedFiles?: readonly string[]): Promise<CapturedDiff> {
    // Prefer the turn's real edited-files signal when work-call tracks it: scope
    // the diff to exactly those paths. Otherwise diff the whole working tree.
    const scoped = Array.isArray(editedFiles) && editedFiles.length > 0
      ? editedFiles.filter((f) => typeof f === 'string' && f.length > 0)
      : undefined;

    // First settle WHICH files changed (porcelain) so an empty diff is detected
    // even when `git diff` text is empty (e.g. new untracked files).
    const changedFiles = await dirtyFiles(cwd);
    const files = scoped !== undefined
      ? scoped.map((f) => f.replace(/\\/g, '/')).filter((f) => changedFiles.has(f))
      : [...changedFiles];

    if (files.length === 0) {
      // No tracked change. (Untracked-only changes also land here — git diff would
      // be empty; we honestly report no diff rather than guess.)
      return { files: [], patch: '' };
    }

    const patch = await gitDiffText(cwd, scoped !== undefined ? files : undefined);
    return { files, patch };
  },

  async detectTestCommand(cwd: string): Promise<DetectedTestCommand | null> {
    // CONSERVATIVE detection — package.json "test" script primarily. We require a
    // real, non-placeholder script before claiming a runner exists; a missing or
    // placeholder script ⇒ null ⇒ honest `unverified (no test command detected)`.
    const pkgRaw = await readFileSafe(cwd, 'package.json');
    if (pkgRaw !== null) {
      try {
        const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown>; packageManager?: string };
        const test = pkg.scripts?.['test'];
        if (typeof test === 'string' && isRealTestScript(test)) {
          // pnpm / yarn workspace: if their lockfile is present, prefer their CLI.
          if ((await existsSafe(cwd, 'pnpm-lock.yaml'))) {
            return { label: 'pnpm test', command: 'pnpm', args: ['test'] };
          }
          if ((await existsSafe(cwd, 'yarn.lock'))) {
            return { label: 'yarn test', command: 'yarn', args: ['test'] };
          }
          return { label: 'npm test', command: 'npm', args: ['test', '--silent'] };
        }
      } catch {
        // Malformed package.json → fall through to other detectors.
      }
    }

    // Known-runner config files (still conservative — only when the manifest exists).
    if ((await readFileSafe(cwd, 'pyproject.toml')) !== null
      || (await readFileSafe(cwd, 'pytest.ini')) !== null
      || (await readFileSafe(cwd, 'tox.ini')) !== null) {
      return { label: 'pytest', command: 'pytest', args: ['-q'] };
    }
    if ((await readFileSafe(cwd, 'Cargo.toml')) !== null) {
      return { label: 'cargo test', command: 'cargo', args: ['test'] };
    }
    if ((await readFileSafe(cwd, 'go.mod')) !== null) {
      return { label: 'go test', command: 'go', args: ['test', './...'] };
    }

    // ---------------------------------------------------------------------------
    // Extended detectors — only reached when none of the above matched.
    // Each is fail-soft: any fs error → skip to next detector.
    // ---------------------------------------------------------------------------

    // Elixir: mix.exs present → `mix test`
    if ((await existsSafe(cwd, 'mix.exs'))) {
      return { label: 'mix test', command: 'mix', args: ['test'] };
    }

    // .NET: any *.csproj or *.sln → `dotnet test`
    if ((await globExistsSafe(cwd, ['.csproj', '.sln']))) {
      return { label: 'dotnet test', command: 'dotnet', args: ['test'] };
    }

    // Gradle: gradlew wrapper first, then bare gradle
    if ((await existsSafe(cwd, 'gradlew'))) {
      return { label: 'gradle test', command: './gradlew', args: ['test'] };
    }
    if ((await existsSafe(cwd, 'build.gradle'))
      || (await existsSafe(cwd, 'build.gradle.kts'))) {
      return { label: 'gradle test', command: 'gradle', args: ['test'] };
    }

    // Ruby: Rakefile with a test task → `rake test`; spec/ + .rspec → `rspec`
    const rakefileRaw = await readFileSafe(cwd, 'Rakefile');
    if (rakefileRaw !== null && hasRakeTestTask(rakefileRaw)) {
      return { label: 'rake test', command: 'rake', args: ['test'] };
    }
    if ((await existsSafe(cwd, '.rspec')) || (await existsSafe(cwd, 'spec'))) {
      return { label: 'rspec', command: 'rspec', args: [] };
    }

    // PHP: composer.json with a `test` script → `composer test`
    const composerRaw = await readFileSafe(cwd, 'composer.json');
    if (composerRaw !== null) {
      try {
        const composer = JSON.parse(composerRaw) as { scripts?: Record<string, unknown> };
        const test = composer.scripts?.['test'];
        if (typeof test === 'string' && isRealTestScript(test)) {
          return { label: 'composer test', command: 'composer', args: ['test'] };
        }
      } catch {
        // Malformed composer.json → skip.
      }
    }

    // Make / justfile: check for a `test` target
    if ((await hasMakeTestTarget(cwd, 'justfile'))
      || (await hasMakeTestTarget(cwd, 'Justfile'))) {
      return { label: 'just test', command: 'just', args: ['test'] };
    }
    if ((await hasMakeTestTarget(cwd, 'Makefile'))
      || (await hasMakeTestTarget(cwd, 'makefile'))
      || (await hasMakeTestTarget(cwd, 'GNUmakefile'))) {
      return { label: 'make test', command: 'make', args: ['test'] };
    }

    // Nothing clearly detected — NEVER fabricate a runner.
    return null;
  },

  async runTests(
    cwd: string,
    command: DetectedTestCommand,
    timeoutMs: number,
    commandGate?: CommandGatePort,
  ): Promise<TestRunResult> {
    const start = Date.now();
    if (commandGate !== undefined) {
      const display = displayCommand(command.command, command.args);
      const gate = commandGate.gate(display);
      const confirmed = await confirmGate(commandGate, gate);
      if (!gate.allowed || confirmed === false) {
        await recordGate(commandGate, cwd, display, gate, confirmed, 'denied');
        return { outcome: 'errored', output: '', durationMs: Date.now() - start };
      }

      const result = await runTestCommand(runExeca, cwd, command, timeoutMs, start);
      await recordGate(commandGate, cwd, display, gate, confirmed, 'ran');
      return result;
    }

    return runTestCommand(runExeca, cwd, command, timeoutMs, start);
  },
  };
}

export const nodeVerifyPort = createNodeVerifyPort();

async function runTestCommand(
  runExeca: ExecaRunner,
  cwd: string,
  command: DetectedTestCommand,
  timeoutMs: number,
  start: number,
): Promise<TestRunResult> {
    try {
      const result = await runExeca(command.command, [...command.args], {
        cwd,
        timeout: Math.max(1000, timeoutMs),
        // Capture, never inherit (non-interactive); a non-zero exit must NOT throw
        // — we read it as RED ourselves.
        reject: false,
        all: true,
        stripFinalNewline: false,
        // No input; tests must not block on stdin.
        stdin: 'ignore',
        env: { CI: 'true', NO_COLOR: '1' },
      });
      const durationMs = Date.now() - start;
      const output = clip(typeof result.all === 'string' ? result.all : '', MAX_TEST_OUTPUT_CHARS);

      if (result.timedOut === true) {
        return { outcome: 'timeout', output, durationMs };
      }
      // execa with reject:false sets failed=false and exitCode=0 on success.
      if (result.exitCode === 0 && result.failed !== true) {
        return { outcome: 'green', output, durationMs };
      }
      // A non-zero exit from a real runner = RED. But a spawn failure (ENOENT —
      // runner not installed) sets exitCode undefined → treat as errored, NOT red,
      // so a missing runner never reads as a test failure.
      if (result.exitCode === undefined) {
        return { outcome: 'errored', output, durationMs };
      }
      return { outcome: 'red', output, durationMs };
    } catch {
      // Any unexpected throw (spawn error not caught by reject:false) → errored.
      return { outcome: 'errored', output: '', durationMs: Date.now() - start };
    }
}

function displayCommand(command: string, args: readonly string[]): string {
  return `${command} ${args.join(' ')}`;
}

async function confirmGate(
  commandGate: CommandGatePort,
  decision: CommandGateDecision,
): Promise<boolean | null> {
  if (!decision.allowed) return false;
  if (!decision.requireConfirmation) return null;
  if (commandGate.confirm === undefined) return false;
  return commandGate.confirm(decision.rationale);
}

async function recordGate(
  commandGate: CommandGatePort,
  cwd: string,
  command: string,
  decision: CommandGateDecision,
  confirmed: boolean | null,
  outcome: 'ran' | 'skipped' | 'denied',
): Promise<void> {
  if (!decision.mustRecord || commandGate.record === undefined) return;
  try {
    await commandGate.record({
      ts: new Date().toISOString(),
      command,
      commandTier: decision.commandTier,
      requireConfirmation: decision.requireConfirmation,
      forbidBackground: decision.forbidBackground,
      confirmed,
      outcome,
      cwd,
    });
  } catch {
    // Audit failures must not break fail-soft verification.
  }
}

// ---------------------------------------------------------------------------
// Helpers (best-effort, no-throw — the repo-scan discipline)
// ---------------------------------------------------------------------------

/** npm's default placeholder test script — present but NOT a real runner. */
function isRealTestScript(script: string): boolean {
  const s = script.trim().toLowerCase();
  if (s.length === 0) return false;
  // The classic `npm init` placeholder: exit-1-with-an-error message.
  if (s.includes('no test specified')) return false;
  if (s.includes('error: no test') || s.includes('echo "error')) return false;
  return true;
}

/** The set of changed files (`git status --porcelain`), repo-relative POSIX. */
async function dirtyFiles(cwd: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    const set = new Set<string>();
    for (const line of stdout.split('\n')) {
      const rel = line.slice(3).trim();
      if (rel.length > 0) set.add(rel.replace(/\\/g, '/'));
    }
    return set;
  } catch {
    return new Set<string>();
  }
}

/**
 * The unified-diff text of the working tree (tracked changes), optionally scoped
 * to specific paths. Includes staged + unstaged via `git diff HEAD`. Best-effort.
 */
async function gitDiffText(cwd: string, files?: readonly string[]): Promise<string> {
  const pathArgs = files !== undefined && files.length > 0 ? ['--', ...files] : [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--no-color', ...pathArgs],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BUFFER },
    );
    return stdout;
  } catch {
    // No HEAD (fresh repo) or git error → try a plain working-tree diff.
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', ...pathArgs],
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BUFFER },
      );
      return stdout;
    } catch {
      return '';
    }
  }
}

/** Read a project file relative to cwd, no-throw → null on any failure. */
async function readFileSafe(cwd: string, rel: string): Promise<string | null> {
  try {
    return await fsReadFile(join(cwd, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Return true if a file/directory at cwd/rel exists (any type), no-throw.
 * Used instead of readFileSafe when we only need presence, not content.
 */
async function existsSafe(cwd: string, rel: string): Promise<boolean> {
  try {
    // fsStat resolves both files and directories; ENOENT → false.
    await fsStat(join(cwd, rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true if any file in cwd has one of the given extensions (e.g. ".csproj").
 * Only reads the directory listing — never recurses — so it is fast and safe.
 */
async function globExistsSafe(cwd: string, exts: string[]): Promise<boolean> {
  try {
    const entries = await fsReaddir(cwd);
    return entries.some((e) => exts.some((x) => e.endsWith(x)));
  } catch {
    return false;
  }
}

/**
 * Return true if the given Makefile-like file contains a bare `test:` or
 * `test ` target line.  Fail-soft: any read/parse error → false.
 */
async function hasMakeTestTarget(cwd: string, filename: string): Promise<boolean> {
  const content = await readFileSafe(cwd, filename);
  if (content === null) return false;
  // Match a line that starts with "test:" or "test " (phony target declaration).
  return /^test[: \t]/m.test(content);
}

/**
 * Return true if the Rakefile contains a task named "test".
 * Conservative — matches `task :test`, `task "test"`, `task 'test'`.
 * The symbol form `:test` has no trailing delimiter; the string forms do.
 */
function hasRakeTestTask(content: string): boolean {
  // Symbol form:  task :test  (colon prefix, no trailing delimiter)
  // String forms: task "test" / task 'test' (matching quote delimiters)
  return /task\s+:test\b/.test(content) || /task\s+["']test["']/.test(content);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
