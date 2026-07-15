/**
 * scripts/packed-install-smoke.mjs — real packed-artifact install smoke (R9.1).
 *
 * Proves what `npm pack --dry-run` cannot:
 *   1. `npm pack` produces a real tarball from the built package
 *   2. That tarball installs into an empty consumer project
 *   3. Both bin names (`myshell-tools`, `myshell`) respond to --help / --version
 *   4. No-provider / unsigned path is actionable (exit non-zero + guidance), not a crash
 *   5. The consumer project is not corrupted (marker file intact; no surprise top-level files)
 *
 * Hermetic: provider CLI homes point at an empty temp dir and PATH is narrowed so host
 * provider CLIs are not visible. Quota-free — no live model calls.
 *
 * Exit 0 on success; non-zero with a clear message on failure.
 * Safe to run from CI package-check and from `npm run smoke:packed`.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const isWin = process.platform === 'win32';

function fail(msg) {
  process.stderr.write(`packed-install-smoke: FAIL — ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`packed-install-smoke: ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWin,
    ...opts,
  });
  return result;
}

function mustRun(cmd, args, opts = {}) {
  const result = run(cmd, args, opts);
  if (result.error) {
    fail(`${cmd} ${args.join(' ')}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${cmd} ${args.join(' ')} exited ${result.status}\n` +
        `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

function binPath(installDir, name) {
  const base = join(installDir, 'node_modules', '.bin', name);
  // On Windows npm installs .cmd shims; on POSIX the bare name is the shim.
  if (isWin) {
    const cmd = `${base}.cmd`;
    if (existsSync(cmd)) return cmd;
  }
  return base;
}

function listTopLevel(dir) {
  return readdirSync(dir).filter((n) => n !== '.' && n !== '..').sort();
}

// --- main --------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const expectedVersion = String(pkg.version);

if (!existsSync(join(REPO_ROOT, 'dist', 'cli.js'))) {
  ok('dist/ missing — building…');
  mustRun('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

const packDir = mkdtempSync(join(tmpdir(), 'myshell-r9-pack-'));
const installDir = mkdtempSync(join(tmpdir(), 'myshell-r9-install-'));
const emptyAuth = mkdtempSync(join(tmpdir(), 'myshell-r9-noauth-'));

let exitCode = 0;
try {
  // Empty consumer project with an integrity marker the package must not delete.
  writeFileSync(
    join(installDir, 'package.json'),
    JSON.stringify({ name: 'myshell-r9-empty-consumer', version: '0.0.0', private: true }),
  );
  writeFileSync(join(installDir, 'KEEPME.txt'), 'project-integrity-marker\n');
  const topBefore = new Set(listTopLevel(installDir));

  ok(`npm pack → ${packDir}`);
  const packResult = mustRun('npm', ['pack', '--pack-destination', packDir], {
    cwd: REPO_ROOT,
  });
  const packLines = (packResult.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // npm pack prints the tarball filename as the last line of stdout.
  const tarballName = packLines[packLines.length - 1];
  if (!tarballName || !tarballName.endsWith('.tgz')) {
    fail(`could not parse tarball name from npm pack output:\n${packResult.stdout}`);
  }
  const tarballPath = join(packDir, tarballName);
  if (!existsSync(tarballPath)) {
    fail(`tarball not found at ${tarballPath}`);
  }
  ok(`packed ${tarballName}`);

  ok(`npm install ${tarballName} into empty project`);
  mustRun('npm', ['install', tarballPath], {
    cwd: installDir,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });

  if (!existsSync(join(installDir, 'node_modules', 'myshell-tools', 'dist', 'cli.js'))) {
    fail('installed package missing dist/cli.js');
  }
  for (const name of ['myshell-tools', 'myshell']) {
    if (!existsSync(binPath(installDir, name))) {
      fail(`missing bin shim for ${name} at ${binPath(installDir, name)}`);
    }
  }
  ok('tarball installed; both bin shims present');

  // Hermetic env: empty vendor homes + PATH that cannot see host provider CLIs.
  const nodeDir = dirname(process.execPath);
  const localBin = join(installDir, 'node_modules', '.bin');
  // Keep only node + local bins so claude/codex/opencode/grok on the host PATH
  // cannot masquerade as "authenticated/installed" during the no-provider check.
  const narrowPath = [localBin, nodeDir].join(delimiter);

  const hermeticEnv = {
    ...process.env,
    NO_COLOR: '1',
    PATH: narrowPath,
    Path: narrowPath, // Windows also reads Path
    CLAUDE_CONFIG_DIR: emptyAuth,
    CODEX_HOME: emptyAuth,
    GROK_HOME: emptyAuth,
    XDG_CONFIG_HOME: emptyAuth,
    XDG_DATA_HOME: emptyAuth,
    HOME: emptyAuth,
    USERPROFILE: emptyAuth,
    APPDATA: emptyAuth,
    LOCALAPPDATA: emptyAuth,
  };
  for (const k of ['REPL_ID', 'REPLIT_DEV_DOMAIN', 'REPL_SLUG', 'REPL_OWNER']) {
    delete hermeticEnv[k];
  }

  for (const name of ['myshell-tools', 'myshell']) {
    const bin = binPath(installDir, name);

    const help = run(bin, ['--help'], {
      cwd: installDir,
      env: hermeticEnv,
      timeout: 30_000,
    });
    if (help.error) fail(`${name} --help: ${help.error.message}`);
    if (help.status !== 0) {
      fail(`${name} --help exited ${help.status}\nstderr:\n${help.stderr}`);
    }
    const helpOut = `${help.stdout ?? ''}${help.stderr ?? ''}`;
    if (!/Usage:|myshell-tools|Commands/i.test(helpOut)) {
      fail(`${name} --help output missing usage:\n${helpOut}`);
    }
    ok(`${name} --help ok`);

    const ver = run(bin, ['--version'], {
      cwd: installDir,
      env: hermeticEnv,
      timeout: 30_000,
    });
    if (ver.error) fail(`${name} --version: ${ver.error.message}`);
    if (ver.status !== 0) {
      fail(`${name} --version exited ${ver.status}\nstderr:\n${ver.stderr}`);
    }
    const verOut = (ver.stdout ?? '').trim();
    if (verOut !== expectedVersion) {
      fail(`${name} --version expected ${expectedVersion}, got ${JSON.stringify(verOut)}`);
    }
    ok(`${name} --version = ${expectedVersion}`);
  }

  // No-provider / first-run refusal must be actionable, not a crash/hang.
  const runBin = binPath(installDir, 'myshell-tools');
  const noProv = run(runBin, ['run', 'say hello'], {
    cwd: installDir,
    env: hermeticEnv,
    timeout: 60_000,
  });
  if (noProv.error) {
    fail(`myshell-tools run (no provider): ${noProv.error.message}`);
  }
  if (noProv.status === 0) {
    fail(
      'myshell-tools run with no providers exited 0 — expected actionable refusal\n' +
        `stdout:\n${noProv.stdout}\nstderr:\n${noProv.stderr}`,
    );
  }
  // Exit codes other than 0 are fine; signal-kill / crash would often be null status
  // with a signal — treat null as failure.
  if (noProv.status === null) {
    fail(
      `myshell-tools run crashed (signal ${noProv.signal})\n` +
        `stdout:\n${noProv.stdout}\nstderr:\n${noProv.stderr}`,
    );
  }
  const refusalText = `${noProv.stdout ?? ''}${noProv.stderr ?? ''}`;
  const actionable =
    /login/i.test(refusalText) ||
    /provider/i.test(refusalText) ||
    /sign[- ]?in/i.test(refusalText) ||
    /install/i.test(refusalText) ||
    /not signed/i.test(refusalText) ||
    /no providers/i.test(refusalText);
  if (!actionable) {
    fail(
      'no-provider run exit was non-zero but message was not actionable ' +
        `(expected login/provider/sign-in guidance)\n${refusalText}`,
    );
  }
  ok(`no-provider run refused actionably (exit ${noProv.status})`);

  // Project integrity: marker intact; only expected new top-level entries.
  const keepme = readFileSync(join(installDir, 'KEEPME.txt'), 'utf8');
  if (keepme !== 'project-integrity-marker\n') {
    fail(`KEEPME.txt corrupted: ${JSON.stringify(keepme)}`);
  }
  const topAfter = listTopLevel(installDir);
  const allowedNew = new Set(['node_modules', 'package-lock.json']);
  for (const name of topAfter) {
    if (topBefore.has(name)) continue;
    if (!allowedNew.has(name)) {
      fail(`unexpected top-level entry after install: ${name} (possible project corruption)`);
    }
  }
  // Must not have written myshell state into the project cwd.
  for (const forbidden of ['.myshell-tools', 'myshell-tools']) {
    if (existsSync(join(installDir, forbidden))) {
      fail(`package wrote state dir into project: ${forbidden}${sep}`);
    }
  }
  ok('project integrity preserved (KEEPME + no surprise top-level / state dirs)');

  ok('ALL CHECKS PASSED');
} catch (err) {
  exitCode = 1;
  process.stderr.write(
    `packed-install-smoke: unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
} finally {
  for (const d of [packDir, installDir, emptyAuth]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

process.exit(exitCode);
