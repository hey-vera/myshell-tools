import { execFile } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PressureSignal, SubscriptionPressureLevel } from '../core/capability-budget.js';
import { getStateDir } from './paths.js';

const execFileAsync = promisify(execFile);
const TRANSCRIPT_FILE_LIMIT = 24;
const TRANSCRIPT_LINE_LIMIT = 50;
const WALK_DEPTH_LIMIT = 4;
const MONITOR_TIMEOUT_MS = 1200;

type EnvLike = Record<string, string | undefined>;

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function envString(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function hasCounts(counts: TokenCounts): boolean {
  return counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheWriteTokens > 0;
}

function signalFromCounts(counts: TokenCounts, source: PressureSignal['source'], trust: PressureSignal['trust'], note: string): PressureSignal | undefined {
  if (!hasCounts(counts)) return undefined;
  return {
    kind: counts.cacheReadTokens + counts.cacheWriteTokens > counts.inputTokens + counts.outputTokens ? 'cache-usage' : 'tokens-used',
    source,
    trust,
    provider: 'claude',
    ...(counts.inputTokens > 0 ? { inputTokens: counts.inputTokens } : {}),
    ...(counts.outputTokens > 0 ? { outputTokens: counts.outputTokens } : {}),
    ...(counts.cacheReadTokens > 0 ? { cacheReadTokens: counts.cacheReadTokens } : {}),
    ...(counts.cacheWriteTokens > 0 ? { cacheWriteTokens: counts.cacheWriteTokens } : {}),
    note,
  };
}

export function detectClaudeHome(input?: { env?: EnvLike }): string | undefined {
  const env = input?.env ?? process.env;
  const explicit = envString(env, 'CLAUDE_HOME');
  if (explicit !== undefined) return explicit;
  const userProfile = envString(env, 'USERPROFILE');
  if (userProfile !== undefined) return join(userProfile, '.claude');
  const home = envString(env, 'HOME');
  return home !== undefined ? join(home, '.claude') : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function jsonlFilesUnder(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    } else if (entry.isDirectory()) {
      files.push(...await jsonlFilesUnder(path, depth - 1));
    }
  }
  return files;
}

export async function findClaudeTranscripts(input?: { claudeHome?: string }): Promise<string[]> {
  const claudeHome = input?.claudeHome;
  if (claudeHome === undefined || !(await exists(claudeHome))) return [];
  const candidates: string[] = [];
  const history = join(claudeHome, 'history.jsonl');
  if (await exists(history)) candidates.push(history);
  candidates.push(...await jsonlFilesUnder(join(claudeHome, 'projects'), WALK_DEPTH_LIMIT));
  candidates.push(...await jsonlFilesUnder(join(claudeHome, 'subagents'), WALK_DEPTH_LIMIT));

  const withStats = await Promise.all(candidates.map(async (path) => {
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs };
    } catch {
      return { path, mtimeMs: 0 };
    }
  }));
  return [...new Map(withStats
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, TRANSCRIPT_FILE_LIMIT)
    .map((item) => [item.path, item.path])).values()];
}

function tokenCountsFromObject(value: unknown, depth = 0): TokenCounts {
  const counts: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (value === null || typeof value !== 'object' || depth > 6) return counts;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const amount = positive(rawValue);
    if (amount > 0) {
      if (key === 'inputtokens' || key === 'prompttokens') counts.inputTokens += amount;
      else if (key === 'outputtokens' || key === 'completiontokens') counts.outputTokens += amount;
      else if (key === 'cachereadtokens' || key === 'cachereadinputtokens') counts.cacheReadTokens += amount;
      else if (key === 'cachewritetokens' || key === 'cachecreationinputtokens' || key === 'cachewriteinputtokens') counts.cacheWriteTokens += amount;
      else if (key === 'totaltokens' || key === 'tokencount') counts.inputTokens += amount;
    }
    counts.inputTokens += tokenCountsFromObject(rawValue, depth + 1).inputTokens;
    counts.outputTokens += tokenCountsFromObject(rawValue, depth + 1).outputTokens;
    counts.cacheReadTokens += tokenCountsFromObject(rawValue, depth + 1).cacheReadTokens;
    counts.cacheWriteTokens += tokenCountsFromObject(rawValue, depth + 1).cacheWriteTokens;
  }
  return counts;
}

export function tryParseTranscriptTokens(lineOrJson: string | unknown): TokenCounts {
  try {
    const parsed = typeof lineOrJson === 'string' ? JSON.parse(lineOrJson) : lineOrJson;
    return tokenCountsFromObject(parsed);
  } catch {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
}

async function collectClaudeTranscriptSignal(env: EnvLike): Promise<PressureSignal | undefined> {
  const claudeHome = detectClaudeHome({ env });
  const files = await findClaudeTranscripts({ claudeHome });
  let total: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const file of files) {
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/).filter(Boolean).slice(-TRANSCRIPT_LINE_LIMIT)) {
      total = addCounts(total, tryParseTranscriptTokens(line));
    }
  }
  return signalFromCounts(total, 'transcript', 'local-transcript-consumption', 'local Claude transcript estimate - observed; estimates or observed, not exact quota');
}

function executableCandidates(bin: string): string[] {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  return suffixes.map((suffix) => `${bin}${suffix}`);
}

async function findOnPath(bin: string, env: EnvLike): Promise<string | undefined> {
  const pathEnv = envString(env, 'PATH');
  if (pathEnv === undefined) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    for (const name of executableCandidates(bin)) {
      const candidate = resolve(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function estimateLevelFromText(text: string): SubscriptionPressureLevel | undefined {
  const lower = text.toLowerCase();
  if (/\b(high|critical|exhausted|rate[- ]?limited)\b/.test(lower)) return 'high';
  if (/\b(medium|moderate|warning)\b/.test(lower)) return 'medium';
  if (/\b(low|ok|normal)\b/.test(lower)) return 'low';
  return undefined;
}

function tokenCountsFromText(text: string): TokenCounts {
  const counts: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const matches = text.matchAll(/([0-9][0-9,._]*)\s*(?:tokens?|tok)\b/gi);
  for (const match of matches) {
    counts.inputTokens += positive(Number(match[1]?.replace(/[,_]/g, '')));
  }
  return counts;
}

export async function detectClaudeMonitor(input?: { env?: EnvLike }): Promise<PressureSignal | undefined> {
  const env = input?.env ?? process.env;
  for (const bin of ['claude-monitor', 'cmonitor']) {
    const command = await findOnPath(bin, env);
    if (command === undefined) continue;
    let stdout = '';
    try {
      const result = await execFileAsync(command, ['status'], { timeout: MONITOR_TIMEOUT_MS, env });
      stdout = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    } catch {
      try {
        const result = await execFileAsync(command, ['--version'], { timeout: MONITOR_TIMEOUT_MS, env });
        stdout = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      } catch {
        stdout = '';
      }
    }
    const counts = tokenCountsFromText(stdout);
    return {
      kind: 'external-monitor-estimate',
      source: 'third-party-monitor',
      trust: 'third-party-estimate',
      provider: 'claude',
      ...(counts.inputTokens > 0 ? { inputTokens: counts.inputTokens } : {}),
      ...(estimateLevelFromText(stdout) !== undefined ? { estimateLevel: estimateLevelFromText(stdout) as Exclude<SubscriptionPressureLevel, 'cooling' | 'unknown'> } : {}),
      note: `${bin} detected; claude-monitor estimate (estimates or observed, not exact quota)`,
    };
  }
  return undefined;
}

function pressureJsonPaths(input: { cwd: string; env: EnvLike }): Array<{ path: string; source: PressureSignal['source']; trust: PressureSignal['trust'] }> {
  const paths: Array<{ path: string; source: PressureSignal['source']; trust: PressureSignal['trust'] }> = [];
  for (const key of ['MYSHELL_PRESSURE_OTEL_PATH', 'MYSHELL_OTEL_PRESSURE_PATH', 'OTEL_PRESSURE_PATH']) {
    const path = envString(input.env, key);
    if (path !== undefined) paths.push({ path, source: 'otel', trust: 'official-telemetry-consumption' });
  }
  for (const key of ['MYSHELL_PRESSURE_HOOK_PATH', 'MYSHELL_CUSTOM_PRESSURE_PATH']) {
    const path = envString(input.env, key);
    if (path !== undefined) paths.push({ path, source: 'custom-hook', trust: 'user-configured-threshold' });
  }
  paths.push({ path: join(input.cwd, 'myshell-pressure-otel.json'), source: 'otel', trust: 'official-telemetry-consumption' });
  paths.push({ path: join(input.cwd, 'myshell-pressure-hook.json'), source: 'custom-hook', trust: 'user-configured-threshold' });
  try {
    const stateDir = getStateDir(input.cwd);
    paths.push({ path: join(stateDir, 'myshell-pressure-otel.json'), source: 'otel', trust: 'official-telemetry-consumption' });
    paths.push({ path: join(stateDir, 'myshell-pressure-hook.json'), source: 'custom-hook', trust: 'user-configured-threshold' });
  } catch {
    /* best-effort */
  }
  return paths;
}

export async function tryLoadOtelSignals(input: { cwd: string; env?: EnvLike }): Promise<PressureSignal[]> {
  const env = input.env ?? process.env;
  const signals: PressureSignal[] = [];
  const seen = new Set<string>();
  for (const candidate of pressureJsonPaths({ cwd: input.cwd, env })) {
    const path = resolve(candidate.path);
    if (seen.has(path)) continue;
    seen.add(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    const counts = tokenCountsFromObject(parsed);
    const signal = signalFromCounts(
      counts,
      candidate.source,
      candidate.trust,
      `${candidate.source === 'otel' ? 'OTel' : 'custom hook'} pressure signal (estimates or observed); headroom unknown`,
    );
    if (signal !== undefined) signals.push(signal);
  }
  return signals;
}

export async function collectOptionalPressureSignals(input?: {
  cwd?: string;
  nowMs?: number;
  env?: EnvLike;
  clock?: { now?: () => number };
}): Promise<PressureSignal[]> {
  const cwd = input?.cwd ?? process.cwd();
  const env = input?.env ?? process.env;
  const signals: PressureSignal[] = [];
  const collectors: Array<() => Promise<PressureSignal | PressureSignal[] | undefined>> = [
    () => collectClaudeTranscriptSignal(env),
    () => detectClaudeMonitor({ env }),
    () => tryLoadOtelSignals({ cwd, env }),
  ];
  for (const collect of collectors) {
    try {
      const result = await collect();
      if (Array.isArray(result)) signals.push(...result);
      else if (result !== undefined) signals.push(result);
    } catch {
      /* Optional pressure adapters must never break the caller. */
    }
  }
  void input?.nowMs;
  void input?.clock;
  return signals;
}
