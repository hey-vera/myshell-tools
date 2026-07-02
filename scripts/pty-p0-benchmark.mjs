/**
 * scripts/pty-p0-benchmark.mjs — aggregate benchmark runner for P0-Wave2.
 *
 * Loads the P0-06b component JSON, refuses to publish if any of the 7 IDs are
 * absent, then measures real PTY key-write-to-Library latency on the compiled
 * Ink CLI.  Produces a single JSON document covering all cases.
 *
 * CLI:  node scripts/pty-p0-benchmark.mjs --samples <n> --warmup <n> --output <path>
 *   --samples   positive int  (default 20)
 *   --warmup    nonnegative int  (default 2)
 *   --output    REQUIRED output file path
 */

/* global process, console, URL, setTimeout, clearTimeout */

import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;

const COLS = 80;
const ROWS = 24;
const TIMEOUT_MS = 15000;
const POLL_MS = 10;
const EXPECTED_COMPONENT_IDS = [
  'manage-early-key',
  'surface-replace-1000',
  'legacy-buffer-mm',
  'ctrl-c-contexts',
  'login-child-handoff',
  'dirty-worktree-verify',
  'auto-stage-success',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveHost() {
  const cpuList = cpus();
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCount: cpuList.length,
  };
}

function resolveCommit() {
  try {
    const c = execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
    return c.length > 0 ? c : 'unknown';
  } catch {
    return 'unknown';
  }
}

function hasScript() {
  if (process.env['MYSHELL_BENCH_SIMULATE_MISSING_SCRIPT'] === '1') return false;
  if (process.platform === 'win32') return false;
  const result = spawnSync('script', ['--version'], { stdio: 'ignore' });
  return result.status === 0 || result.status === 1;
}

function hasXterm() {
  if (process.env['MYSHELL_BENCH_SIMULATE_MISSING_XTERM'] === '1') return false;
  try {
    require.resolve('@xterm/headless');
    return true;
  } catch {
    return false;
  }
}

function hasCli() {
  if (process.env['MYSHELL_BENCH_SIMULATE_MISSING_CLI'] === '1') return false;
  return existsSync(CLI);
}

function normalizeScreenText(lines) {
  return lines
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');
}

async function reconstructScreen(raw, Terminal) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 6000 });
  return new Promise((resolve) => {
    term.write(raw, () => {
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i += 1) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
      }
      resolve(normalizeScreenText(lines));
    });
  });
}

// nearest-rank percentile: ceil(p * n) - 1 (0-indexed)
function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Component JSON loading ──────────────────────────────────────────────────

async function loadComponentSuite() {
  const overridePath = process.env['MYSHELL_BENCH_COMPONENT_JSON'];
  if (overridePath) {
    const raw = readFileSync(overridePath, 'utf8');
    return JSON.parse(raw);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', 'scripts/p0-component-benchmark.tsx'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`component suite exited code ${code}: ${stderr.trim()}`));
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Failed to parse component JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

// ── PTY sample measurement ──────────────────────────────────────────────────

async function runPtySample() {
  const tempHome = join(tmpdir(), `myshell-pty-bench-${randomBytes(6).toString('hex')}`);
  const configDir = join(tempHome, '.myshell-tools');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: false, defaultShellOptOut: true }));

  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    MYSHELL_INK: '1',
    MYSHELL_NO_UPDATE: '1',
    COLUMNS: String(COLS),
    LINES: String(ROWS),
    FORCE_COLOR: '1',
    NO_COLOR: '1',
  };
  delete env['REPL_ID'];
  delete env['REPLIT_DEV_DOMAIN'];
  delete env['REPL_SLUG'];
  delete env['REPL_OWNER'];
  delete env['CODESPACES'];
  delete env['CODESPACE_NAME'];
  delete env['GITPOD_WORKSPACE_ID'];
  delete env['GITPOD_WORKSPACE_URL'];
  delete env['MYSHELL_CLOUD_WORKSPACE'];
  delete env['XDG_CONFIG_HOME'];
  delete env['XDG_STATE_HOME'];
  delete env['XDG_CACHE_HOME'];
  delete env['XDG_DATA_HOME'];

  const { Terminal } = require('@xterm/headless');

  const child = spawn('script', ['-qec', `node ${CLI}`, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  let raw = '';
  child.stdout.on('data', (chunk) => {
    raw += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    raw += chunk.toString('utf8');
  });

  const write = (text) => {
    try {
      child.stdin.write(text);
    } catch {
      /* child already exited */
    }
  };
  const getScreen = async () => reconstructScreen(raw, Terminal);

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code: code ?? 0, signal: signal ?? null }));
    child.on('error', (error) => resolve({ code: 1, signal: 'error', error }));
  });

  const hardStop = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }, TIMEOUT_MS + 30000);

  try {
    const menuStart = Date.now();
    let lastScreen = null;
    let stableCount = 0;
    let menuReady = false;

    const menuTimeout = TIMEOUT_MS + 20000;
    while (!menuReady) {
      await new Promise((r) => setTimeout(r, 150));
      const screen = await getScreen();
      const hadContent = screen.length > 0 && screen.split('\n').length >= 3;
      if (lastScreen !== null && screen === lastScreen && hadContent) {
        stableCount += 1;
      } else {
        stableCount = 0;
      }
      lastScreen = screen;
      if (stableCount >= 2) {
        menuReady = true;
      }
      if (Date.now() - menuStart >= menuTimeout) {
        const err = new Error('Root menu never stabilized');
        err.screen = screen;
        throw err;
      }
    }

    const latencyStart = process.hrtime.bigint();
    write('e');

    const pollStart = Date.now();
    let latencyEnd = null;
    let foundScreen = '';

    while (latencyEnd === null) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const screen = await getScreen();
      if (screen.includes('Library')) {
        latencyEnd = process.hrtime.bigint();
        foundScreen = screen;
        break;
      }
      if (Date.now() - pollStart >= TIMEOUT_MS) {
        const err = new Error('Library heading never appeared in xterm buffer');
        const currentScreen = await getScreen();
        err.screen = currentScreen;
        throw err;
      }
    }

    const elapsedMs = Number(latencyEnd - latencyStart) / 1e6;

    write('b');
    await new Promise((resolve) => setTimeout(resolve, 200));
    write('q');

    const exit = await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 8000)),
    ]);

    if (exit.code !== 0 || exit.signal !== null) {
      const err = new Error(
        `expected clean exit after b+q, got code=${String(exit.code)} signal=${String(exit.signal)}`,
      );
      err.screen = await getScreen();
      throw err;
    }

    clearTimeout(hardStop);
    return { elapsedMs, screen: foundScreen };
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    if (hardStop) clearTimeout(hardStop);
    try {
      await rm(tempHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── Build output ────────────────────────────────────────────────────────────

function buildOutput({ status, componentSuite, ptyCase, config, host, commit, detail }) {
  const cases = [];
  if (componentSuite && componentSuite.cases) {
    for (const c of componentSuite.cases) {
      cases.push(c);
    }
  }
  if (ptyCase) cases.push(ptyCase);

  return {
    version: 1,
    status,
    commit,
    host,
    config,
    cases,
    ...(detail ? { detail } : {}),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // ── Parse args ────────────────────────────────────────────────────────────
  let samples = 20;
  let warmup = 2;
  let outputPath = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--samples' && i + 1 < argv.length) {
      samples = parseInt(argv[++i], 10);
    } else if (argv[i] === '--warmup' && i + 1 < argv.length) {
      warmup = parseInt(argv[++i], 10);
    } else if (argv[i] === '--output' && i + 1 < argv.length) {
      outputPath = argv[++i];
    }
  }

  if (outputPath === null) {
    console.error('Error: --output <path> is required');
    process.exit(1);
  }
  if (!Number.isInteger(samples) || samples < 1) {
    console.error('Error: --samples must be a positive integer');
    process.exit(1);
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    console.error('Error: --warmup must be a nonnegative integer');
    process.exit(1);
  }

  const host = resolveHost();
  const commit = resolveCommit();
  const config = {
    warmup,
    samples,
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
    latencyStart: 'before-key-write',
    latencyEnd: 'first-xterm-frame-containing-destination-marker',
  };

  // ── Capability guard ──────────────────────────────────────────────────────
  const missing = [];
  if (!hasCli()) missing.push('dist/cli.js not built');
  if (!hasXterm()) missing.push('@xterm/headless not installed');
  if (!hasScript()) missing.push('util-linux script unavailable');

  if (missing.length > 0) {
    const output = buildOutput({
      status: 'unsupported',
      componentSuite: null,
      ptyCase: {
        id: 'pty-root-to-library',
        status: 'unsupported',
        samples: 0,
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
        actions: 0,
        editorRemainder: '',
        rawMs: [],
        detail: missing.join('; '),
      },
      config,
      host,
      commit,
      detail: missing.join('; '),
    });
    const json = JSON.stringify(output);
    const parentDir = outputPath.includes('/')
      ? outputPath.slice(0, outputPath.lastIndexOf('/'))
      : '.';
    if (parentDir !== '.') mkdirSync(parentDir, { recursive: true });
    writeFileSync(outputPath, json, 'utf8');
    console.log(json);
    process.exit(2);
  }

  // ── Load component JSON ───────────────────────────────────────────────────
  let componentSuite;
  try {
    componentSuite = await loadComponentSuite();
  } catch (err) {
    console.error(`Failed to load component suite: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const componentIds = (componentSuite.cases ?? []).map((c) => c.id);
  for (const expectedId of EXPECTED_COMPONENT_IDS) {
    if (!componentIds.includes(expectedId)) {
      console.error(`Missing component case: "${expectedId}" — aggregate refused`);
      process.exit(1);
    }
  }

  // ── PTY benchmark samples ─────────────────────────────────────────────────
  const rawMs = [];
  let ptyStatus = 'pass';
  let ptyDetail = undefined;

  const totalRuns = warmup + samples;
  for (let i = 0; i < totalRuns; i += 1) {
    const isWarmup = i < warmup;
    try {
      const { elapsedMs } = await runPtySample();
      if (!isWarmup) {
        rawMs.push(elapsedMs);
      }
    } catch (err) {
      ptyStatus = 'failed';
      ptyDetail =
        err instanceof Error
          ? `${err.message}${err.screen ? `\n--- screen tail ---\n${err.screen}` : ''}`
          : String(err);
      break;
    }
  }

  const sorted = [...rawMs].sort((a, b) => a - b);

  const ptyCase = {
    id: 'pty-root-to-library',
    status: ptyStatus,
    samples: rawMs.length,
    p50Ms: nearestRank(sorted, 0.50),
    p95Ms: nearestRank(sorted, 0.95),
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    actions: 1,
    editorRemainder: '',
    rawMs,
    ...(ptyDetail ? { detail: ptyDetail } : {}),
  };

  const overallStatus = ptyStatus === 'pass' && componentSuite.status === 'pass' ? 'pass' : 'failed';

  // ── Assemble and write JSON ───────────────────────────────────────────────
  const output = buildOutput({
    status: overallStatus,
    componentSuite,
    ptyCase,
    config,
    host,
    commit,
  });
  const json = JSON.stringify(output);
  const parentDir = outputPath.includes('/')
    ? outputPath.slice(0, outputPath.lastIndexOf('/'))
    : '.';
  if (parentDir !== '.') mkdirSync(parentDir, { recursive: true });
  writeFileSync(outputPath, json, 'utf8');
  console.log(json);

  if (ptyStatus !== 'pass') {
    // Surface the failure detail (incl. captured screen tail) to stderr so CI logs
    // reveal WHY the PTY run failed without a second diagnostic round.
    console.error(`[pty-benchmark] FAILED status=${ptyStatus}: ${ptyDetail ?? 'unknown'}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
