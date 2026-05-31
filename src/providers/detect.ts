/**
 * src/providers/detect.ts
 *
 * Provider-detection logic.
 *
 * Claude detection is REAL: spawns `claude --version` to probe installation,
 * then `claude auth status` to probe real authentication state.
 * Codex detection is REAL: spawns `codex --version` to probe installation,
 * then `codex login status` to probe real authentication state.
 * Opencode detection is REAL: spawns `opencode --version` to probe installation.
 * Opencode is authenticated:true when installed because it ships free models
 * (e.g. opencode/deepseek-v4-flash-free) that require no credentials — the
 * honest statement is "usable immediately without credentials".
 *
 * Plan labels are only set when clearly present in CLI output — never fabricated.
 */

import { execa } from 'execa';
import { loadClaudeToken, claudeEnv } from '../infra/credentials.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  readonly id: 'claude' | 'codex' | 'opencode';
  readonly installed: boolean;
  readonly version: string | null;
  readonly authenticated: boolean;
  readonly plan: string | null;
  readonly binaryPath: string | null;
  readonly availableModels: readonly string[];
}

export interface EnvironmentStatus {
  readonly claude: ProviderStatus;
  readonly codex: ProviderStatus;
  readonly opencode: ProviderStatus;
  readonly hasAnyProvider: boolean;
  readonly platform: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Internal factory
// ---------------------------------------------------------------------------

function notDetected(id: 'claude' | 'codex' | 'opencode'): ProviderStatus {
  return {
    id,
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [],
  };
}

// ---------------------------------------------------------------------------
// Pure auth parsers (no I/O — hermetic-testable)
// ---------------------------------------------------------------------------

/**
 * Parse the output of `claude auth status` into an auth result.
 *
 * Real output shape (exit code 0, authenticated):
 * ```json
 * {
 *   "loggedIn": true,
 *   "authMethod": "claude.ai",
 *   "apiProvider": "firstParty",
 *   "email": "user@example.com",
 *   "orgId": "...",
 *   "orgName": "...",
 *   "subscriptionType": "pro"
 * }
 * ```
 *
 * Authenticated when: exitCode === 0 AND the JSON contains `"loggedIn": true`.
 * Plan: the `subscriptionType` string when present and non-empty, else null.
 * Conservative: on any parse error, authenticated stays false and plan is null.
 */
export function parseClaudeAuth(
  stdout: string,
  _stderr: string,
  exitCode: number,
): { authenticated: boolean; plan: string | null } {
  if (exitCode !== 0) {
    return { authenticated: false, plan: null };
  }

  try {
    const data = JSON.parse(stdout.trim()) as unknown;
    if (typeof data !== 'object' || data === null) {
      return { authenticated: false, plan: null };
    }

    const obj = data as Record<string, unknown>;
    const loggedIn = obj['loggedIn'] === true;
    if (!loggedIn) {
      return { authenticated: false, plan: null };
    }

    const sub = obj['subscriptionType'];
    const plan = typeof sub === 'string' && sub.length > 0 ? sub : null;

    return { authenticated: true, plan };
  } catch {
    return { authenticated: false, plan: null };
  }
}

/**
 * Parse the output of `codex login status` into an auth result.
 *
 * Real output shape (exit code 0, authenticated):
 * ```
 * Logged in using ChatGPT   ← written to stderr (not stdout)
 * ```
 *
 * Authenticated when: exitCode === 0 AND either stdout OR stderr contains
 * "logged in" (case-insensitive). The haystack is built from both streams
 * because `codex login status` writes to stderr in practice.
 *
 * Plan: null — codex login status does not expose a subscription/plan label.
 * Conservative: on any unexpected output, authenticated stays false and plan is null.
 *
 * @remarks Codex has no plan/subscription field in `codex login status` output.
 *   plan is always null; it is never fabricated.
 */
export function parseCodexAuth(
  stdout: string,
  stderr: string,
  exitCode: number,
): { authenticated: boolean; plan: string | null } {
  if (exitCode !== 0) {
    return { authenticated: false, plan: null };
  }

  // Build haystack from both streams — codex login status uses stderr in practice.
  const haystack = (stdout + '\n' + stderr).toLowerCase();
  const authenticated = haystack.includes('logged in');

  return { authenticated, plan: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether a provider CLI is installed and probe its real auth state.
 *
 * For 'claude': runs `claude --version` to confirm the binary is present, then
 * `claude auth status` (JSON output) to determine real auth state and plan.
 * On spawn failure of the status command, falls back gracefully: installed
 * remains true, authenticated false, plan null.
 *
 * For 'codex': runs `codex --version` to confirm the binary is present, then
 * `codex login status` to determine real auth state. Plan is always null because
 * `codex login status` does not expose subscription information.
 * On spawn failure of the status command, falls back gracefully: installed
 * remains true, authenticated false, plan null.
 *
 * For 'opencode': runs `opencode --version` to confirm the binary is present.
 * When installed, authenticated is always true because opencode ships free
 * models (e.g. opencode/deepseek-v4-flash-free) that require no credentials —
 * a fresh install is immediately usable without any sign-in step.
 * Plan is always null (opencode does not expose a subscription tier in
 * `opencode --version` output).
 */
export async function detectProvider(
  id: 'claude' | 'codex' | 'opencode',
): Promise<ProviderStatus> {
  if (id === 'claude') {
    // Load the stored token once so both the version probe and the auth probe
    // see it — but never inject it into the global process.env.
    // Fall back to process.env unchanged if loading fails.
    let claudeChildEnv: NodeJS.ProcessEnv = process.env;
    try {
      const token = await loadClaudeToken();
      claudeChildEnv = claudeEnv(process.env, token);
    } catch {
      // Never throw — detection must be robust
    }

    try {
      const result = await execa('claude', ['--version'], {
        reject: false,
        timeout: 10_000,
        env: claudeChildEnv,
      });

      if (result.exitCode === 0) {
        // Binary confirmed present — now probe real auth state.
        let authenticated = false;
        let plan: string | null = null;

        try {
          const authResult = await execa('claude', ['auth', 'status'], {
            reject: false,
            timeout: 10_000,
            env: claudeChildEnv,
          });
          const parsed = parseClaudeAuth(
            typeof authResult.stdout === 'string' ? authResult.stdout : '',
            typeof authResult.stderr === 'string' ? authResult.stderr : '',
            authResult.exitCode ?? 1,
          );
          authenticated = parsed.authenticated;
          plan = parsed.plan;
        } catch {
          // Spawn failure — leave authenticated false, plan null
        }

        return {
          id: 'claude',
          installed: true,
          version: (result.stdout as string).trim(),
          binaryPath: 'claude',
          availableModels: ['opus', 'sonnet', 'haiku'],
          authenticated,
          plan,
        };
      }
    } catch {
      // Binary not found or spawn error — fall through to notDetected
    }

    return notDetected('claude');
  }

  // opencode: delegate to the dedicated helper.
  if (id === 'opencode') {
    return detectOpencodeProvider();
  }

  // codex: run `codex --version` to probe installation, then `codex login status`
  try {
    const result = await execa('codex', ['--version'], {
      reject: false,
      timeout: 10_000,
    });

    if (result.exitCode === 0) {
      // Binary confirmed present — now probe real auth state.
      let authenticated = false;
      const plan: string | null = null; // codex login status never exposes plan

      try {
        const authResult = await execa('codex', ['login', 'status'], {
          reject: false,
          timeout: 10_000,
        });
        const parsed = parseCodexAuth(
          typeof authResult.stdout === 'string' ? authResult.stdout : '',
          typeof authResult.stderr === 'string' ? authResult.stderr : '',
          authResult.exitCode ?? 1,
        );
        authenticated = parsed.authenticated;
      } catch {
        // Spawn failure — leave authenticated false, plan null
      }

      return {
        id: 'codex',
        installed: true,
        version: (result.stdout as string).trim(),
        binaryPath: 'codex',
        availableModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
        authenticated,
        plan,
      };
    }
  } catch {
    // Binary not found or spawn error — fall through to notDetected
  }

  return notDetected('codex');
}

// ---------------------------------------------------------------------------
// opencode detection (private helper — called by detectProvider)
// ---------------------------------------------------------------------------

/**
 * Detect the opencode CLI. Returns installed:true + authenticated:true when the
 * binary is present, because opencode ships free models (e.g.
 * opencode/deepseek-v4-flash-free) that require no credentials — the binary is
 * immediately usable without any sign-in step.
 */
async function detectOpencodeProvider(): Promise<ProviderStatus> {
  try {
    const result = await execa('opencode', ['--version'], {
      reject: false,
      timeout: 10_000,
    });

    if (result.exitCode === 0) {
      return {
        id: 'opencode',
        installed: true,
        version: (result.stdout as string).trim(),
        binaryPath: 'opencode',
        // opencode ships free models that need no credentials — always usable.
        authenticated: true,
        plan: null,
        // All three free models covering the tiers used in pricing.ts (worker,
        // ic, manager) so route() can select the appropriate tier without
        // falling back to a model opencode may not actually advertise.
        availableModels: [
          'opencode/mimo-v2.5-free',       // worker tier
          'opencode/deepseek-v4-flash-free', // ic tier
          'opencode/big-pickle',             // manager tier
        ],
      };
    }
  } catch {
    // Binary not found or spawn error — fall through to notDetected
  }

  return notDetected('opencode');
}

/**
 * Detect the full environment — all three providers — in parallel.
 *
 * Delegates to detectProvider for each provider ID.
 */
export async function detectEnvironment(): Promise<EnvironmentStatus> {
  const [claude, codex, opencode] = await Promise.all([
    detectProvider('claude'),
    detectProvider('codex'),
    detectProvider('opencode'),
  ]);

  return {
    claude,
    codex,
    opencode,
    hasAnyProvider: claude.installed || codex.installed || opencode.installed,
    platform: process.platform,
  };
}

/**
 * Return the shell command a user should run to install the given provider.
 */
export function getInstallCommand(id: 'claude' | 'codex' | 'opencode'): string {
  switch (id) {
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
    case 'opencode':
      return 'npm install -g opencode-ai';
  }
}
