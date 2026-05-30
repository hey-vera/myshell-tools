/**
 * src/providers/detect.ts
 *
 * Provider-detection logic.
 *
 * Claude detection is REAL: spawns `claude --version` to probe installation,
 * then `claude auth status` to probe real authentication state.
 * Codex detection is REAL: spawns `codex --version` to probe installation,
 * then `codex login status` to probe real authentication state.
 *
 * Plan labels are only set when clearly present in CLI output — never fabricated.
 */

import { execa } from 'execa';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  readonly id: 'claude' | 'codex';
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
  readonly hasAnyProvider: boolean;
  readonly platform: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Internal factory
// ---------------------------------------------------------------------------

function notDetected(id: 'claude' | 'codex'): ProviderStatus {
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
 * Logged in using ChatGPT
 * ```
 *
 * Authenticated when: exitCode === 0 AND stdout contains "logged in" (case-insensitive).
 * Plan: null — codex login status does not expose a subscription/plan label.
 * Conservative: on any unexpected output, authenticated stays false and plan is null.
 *
 * @remarks Codex has no plan/subscription field in `codex login status` output.
 *   plan is always null; it is never fabricated.
 */
export function parseCodexAuth(
  stdout: string,
  _stderr: string,
  exitCode: number,
): { authenticated: boolean; plan: string | null } {
  if (exitCode !== 0) {
    return { authenticated: false, plan: null };
  }

  const lower = stdout.toLowerCase();
  const authenticated = lower.includes('logged in');

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
 */
export async function detectProvider(
  id: 'claude' | 'codex',
): Promise<ProviderStatus> {
  if (id === 'claude') {
    try {
      const result = await execa('claude', ['--version'], {
        reject: false,
        timeout: 10_000,
      });

      if (result.exitCode === 0) {
        // Binary confirmed present — now probe real auth state.
        let authenticated = false;
        let plan: string | null = null;

        try {
          const authResult = await execa('claude', ['auth', 'status'], {
            reject: false,
            timeout: 10_000,
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

/**
 * Detect the full environment — both providers — in parallel.
 *
 * Stub: delegates to detectProvider for each provider ID.
 */
export async function detectEnvironment(): Promise<EnvironmentStatus> {
  const [claude, codex] = await Promise.all([
    detectProvider('claude'),
    detectProvider('codex'),
  ]);

  return {
    claude,
    codex,
    hasAnyProvider: claude.installed || codex.installed,
    platform: process.platform,
  };
}

/**
 * Return the shell command a user should run to install the given provider.
 */
export function getInstallCommand(id: 'claude' | 'codex'): string {
  switch (id) {
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
  }
}
