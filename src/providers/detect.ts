/**
 * src/providers/detect.ts
 *
 * Provider-detection logic.
 *
 * Claude detection is REAL: spawns `claude --version` to probe installation,
 * then `claude auth status` to probe real authentication state.
 * Codex detection is REAL: spawns `codex --version` to probe installation,
 * then `codex login status` to probe real authentication state.
 * Opencode detection is REAL: spawns `opencode --version` to probe installation,
 * then classifies its on-disk credentials (auth.json) to probe real auth state.
 * GUARDRAIL (correct nuance): myshell-tools itself NEVER stores or handles a raw
 * API key — it DELEGATES sign-in to opencode, which stores the credential in its
 * OWN secure auth.json. So opencode is authenticated whenever it holds ANY
 * recognized credential (`type === "oauth"` OR `type === "api"`): the secret lives
 * inside opencode, never inside myshell. This is intentional — opencode brokers
 * many models from a single credential (e.g. Kimi via the `opencode-go` provider),
 * including its recommended "OpenCode Zen" gateway key. See detectOpencodeProvider
 * / opencodeCredentialCount.
 *
 * Plan labels are only set when clearly present in CLI output — never fabricated.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadClaudeToken, claudeEnv, replitPersistentEnv } from '../infra/credentials.js';
import {
  parseClaudeOauth,
  resolveClaudeCredsPath,
} from '../infra/claude-oauth-refresh.js';

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
 * Plan: the `subscriptionType` string when present and non-empty, else null —
 * ENRICHED with the Max sub-tier when both `subscriptionType` is a Max plan and a
 * `rateLimitTier` field is present that carries a "5x"/"20x" marker (see
 * foldRateLimitTier). `rateLimitTier` is read from the status JSON when present;
 * detectProvider additionally folds it from the on-disk credentials file (where
 * Claude actually stores `claudeAiOauth.rateLimitTier`).
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
    const basePlan = typeof sub === 'string' && sub.length > 0 ? sub : null;
    // Enrich with the Max sub-tier when the status JSON happens to carry it.
    const rateLimitTier = obj['rateLimitTier'];
    const plan = foldRateLimitTier(
      basePlan,
      typeof rateLimitTier === 'string' ? rateLimitTier : null,
    );

    return { authenticated: true, plan };
  } catch {
    return { authenticated: false, plan: null };
  }
}

/**
 * Fold a Claude account's `rateLimitTier` into the plan string so the generic
 * "max" plan becomes the honest sub-tier "max_5x" / "max_20x" when known. This
 * keeps the existing `plan: string` contract intact — classifyPlan still matches
 * the "max" substring — while preserving which Max the user has so display and
 * quota-aware auto behaviour can differ.
 *
 * Robust matching: we look for the "20x" / "5x" SUBSTRING in rateLimitTier
 * (Claude reports e.g. "default_claude_max_5x"; a 20x account carries the
 * analogous "...max_20x"). We deliberately do NOT hardcode the exact surrounding
 * string, so a relabel of the prefix does not break detection. 20x is checked
 * before 5x so a hypothetical "...max_20x" never mis-matches a stray "5x".
 *
 * Fail-soft: only enriches when `plan` is already a Max plan. A null/non-Max
 * plan, or a missing/garbage rateLimitTier with no recognised marker, returns the
 * plan unchanged → downstream behaves exactly as before (generic max → 3-way).
 * Pure; case-insensitive.
 */
export function foldRateLimitTier(
  plan: string | null,
  rateLimitTier: string | null | undefined,
): string | null {
  if (plan === null) return null;
  if (!plan.toLowerCase().includes('max')) return plan;
  // Already carries a sub-tier marker — keep it (don't double-fold).
  const pl = plan.toLowerCase();
  if (pl.includes('20x') || pl.includes('5x')) return plan;
  if (typeof rateLimitTier !== 'string' || rateLimitTier.length === 0) return plan;
  const rt = rateLimitTier.toLowerCase();
  if (rt.includes('20x')) return 'max_20x';
  if (rt.includes('5x')) return 'max_5x';
  return plan;
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
 * Plan: null — `codex login status` text output does not expose a
 * subscription/plan label. The honest ChatGPT plan IS available, but only from
 * codex's on-disk `auth.json` token claim (see {@link codexPlanFromAuthJson});
 * detectProvider folds that in after this parse. We deliberately do NOT fabricate
 * a plan here.
 * Conservative: on any unexpected output, authenticated stays false and plan is null.
 *
 * @remarks Codex has no plan/subscription field in `codex login status` output.
 *   plan is always null from THIS function; it is never fabricated.
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

/**
 * Decode the CLAIMS payload of a JWT WITHOUT verifying its signature.
 *
 * We only ever read non-sensitive DISPLAY claims (e.g. a plan-type string) from a
 * token that codex itself already trusts on disk — we are not authenticating with
 * it, so no signature trust is needed. The token material is never logged and
 * never returned; only the parsed claims object is.
 *
 * A JWT is `header.payload.signature`; the payload is base64url-encoded JSON. This
 * is fully fail-soft: any malformed token (wrong segment count, bad base64, non-JSON,
 * non-object) returns null. Pure / never throws.
 *
 * @param token - A JWT string (or anything; non-JWTs simply return null).
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    if (typeof payload !== 'string' || payload.length === 0) return null;
    // base64url → base64, then pad to a multiple of 4.
    let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the honest ChatGPT plan/tier label from codex's on-disk `auth.json`.
 *
 * What is TRUTHFULLY available locally (no metered API call): when codex is signed
 * in via ChatGPT (`auth_mode === "chatgpt"`), it stores OAuth tokens under
 * `tokens.{id_token,access_token}`. Both are JWTs whose `https://api.openai.com/auth`
 * claim carries `chatgpt_plan_type` — the real account plan (e.g. "pro", "plus",
 * "prolite", "free", "team"). We decode that claim (no signature trust — see
 * {@link decodeJwtClaims}) and return it verbatim, lowercased+trimmed, so the banner
 * can show the user's actual ChatGPT plan exactly like claude's tier.
 *
 * HONESTY: returns the plan string ONLY when it is genuinely present in the token
 * claim. When codex is signed in with an API key (`auth_mode` other than chatgpt,
 * or no decodable plan claim) there is NO subscription plan to show → returns null,
 * and the banner stays at plain "ready". We never fabricate a tier and never log the
 * token. Pure / fail-soft: any missing field / parse error returns null; never throws.
 *
 * @param rawAuthJson - the raw contents of codex's `auth.json`.
 */
export function codexPlanFromAuthJson(rawAuthJson: string): string | null {
  try {
    const parsed = JSON.parse(rawAuthJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    const tokens = obj['tokens'];
    if (typeof tokens !== 'object' || tokens === null) return null;
    const tk = tokens as Record<string, unknown>;

    // Prefer the id_token, fall back to the access_token — both carry the claim.
    for (const key of ['id_token', 'access_token']) {
      const token = tk[key];
      if (typeof token !== 'string' || token.length === 0) continue;
      const claims = decodeJwtClaims(token);
      if (claims === null) continue;
      const authClaim = claims['https://api.openai.com/auth'];
      if (typeof authClaim !== 'object' || authClaim === null) continue;
      const planType = (authClaim as Record<string, unknown>)['chatgpt_plan_type'];
      if (typeof planType === 'string' && planType.trim().length > 0) {
        return planType.trim().toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve where codex's `auth.json` lives — the same way codex / the rest of this
 * codebase does (mirrors model-capability-port.resolveCodexHome):
 *   1. explicit `CODEX_HOME` env var when set;
 *   2. else the Replit-persistent `.replit-tools/.codex-persistent` dir when it
 *      actually holds an auth.json;
 *   3. else `~/.codex`.
 * Pure-ish (reads env + existsSync). Never throws.
 */
export function resolveCodexAuthPath(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home: string = homedir(),
): string {
  const explicit = env['CODEX_HOME'];
  if (typeof explicit === 'string' && explicit.length > 0) {
    return join(explicit, 'auth.json');
  }
  try {
    const persistent = join(cwd, '.replit-tools', '.codex-persistent');
    if (existsSync(join(persistent, 'auth.json'))) return join(persistent, 'auth.json');
  } catch {
    // ignore — fall through to the default home.
  }
  return join(home, '.codex', 'auth.json');
}

/**
 * Fallback auth signal from the on-disk credentials file. True when the file
 * holds a usable Claude credential — a non-expired OAuth token (expiresAt in
 * the future, or absent) or an API key — even if `claude auth status` couldn't
 * confirm it (e.g. it timed out during launch-time update churn). Pure; never throws.
 */
export function credentialFileIndicatesAuth(rawCredsJson: string, nowMs: number): boolean {
  try {
    const parsed = JSON.parse(rawCredsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;

    // API key path
    if (typeof obj['primaryApiKey'] === 'string' && obj['primaryApiKey'].length > 0) {
      return true;
    }

    // OAuth path
    const oauth = parseClaudeOauth(rawCredsJson);
    if (oauth !== null) {
      // Accept when expiresAt is absent or in the future
      return oauth.expiresAt === null || oauth.expiresAt > nowMs;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Extract the `claudeAiOauth.rateLimitTier` string from the raw credentials JSON,
 * or null when absent/garbage. This is the account's rate-limit tier (e.g.
 * "default_claude_max_5x") that distinguishes Max 5x from Max 20x. Pure /
 * fail-soft: returns null on any non-object / missing-field / parse error; never
 * throws. We read only this one string — no token material is touched or logged.
 */
export function rateLimitTierFromCreds(rawCredsJson: string): string | null {
  try {
    const parsed = JSON.parse(rawCredsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const oauth = (parsed as Record<string, unknown>)['claudeAiOauth'];
    if (typeof oauth !== 'object' || oauth === null) return null;
    const tier = (oauth as Record<string, unknown>)['rateLimitTier'];
    return typeof tier === 'string' && tier.length > 0 ? tier : null;
  } catch {
    return null;
  }
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
 * `codex login status` to determine real auth state. `codex login status` text
 * exposes no plan, but when authenticated we read codex's on-disk auth.json and
 * surface the real ChatGPT plan from its OAuth token claim (chatgpt_plan_type) —
 * see codexPlanFromAuthJson; null for an API-key login or when no claim is present.
 * On spawn failure of the status command, falls back gracefully: installed
 * remains true, authenticated false, plan null.
 *
 * For 'opencode': runs `opencode --version` to confirm the binary is present,
 * then delegates to detectOpencodeProvider, which reads opencode's auth.json and
 * classifies its credentials. authenticated is true when opencode holds at least
 * one recognized credential (`type === "oauth"` OR `type === "api"`). myshell never
 * sees or stores that secret — opencode does — so an API-key credential (e.g.
 * OpenCode Zen) counts: opencode then brokers many models (e.g. Kimi via
 * opencode-go). Plan is null for an api/gateway credential (opencode stores no tier
 * for it); the one honest exception is an oauth credential whose token carries a
 * ChatGPT plan claim, which opencodePlanFromAuthJson surfaces.
 */
export async function detectProvider(
  id: 'claude' | 'codex' | 'opencode',
  opts: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    credentialFileFallback?: boolean;
    storedCredentialInjection?: boolean;
  } = {},
): Promise<ProviderStatus> {
  const baseEnv = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const credentialFileFallback = opts.credentialFileFallback ?? true;
  const storedCredentialInjection = opts.storedCredentialInjection ?? true;

  if (id === 'claude') {
    // Load the stored token once so both the version probe and the auth probe
    // see it — but never inject it into the global process.env.
    // Fall back to process.env unchanged if loading fails.
    let claudeChildEnv: NodeJS.ProcessEnv = baseEnv;
    try {
      const token = storedCredentialInjection ? await loadClaudeToken() : null;
      // Point claude at the Replit-persistent config dir when present so detection
      // sees the one-time sign-in that survives restarts (matches replit-tools).
      claudeChildEnv = {
        ...claudeEnv(baseEnv, token),
        ...replitPersistentEnv(baseEnv, cwd),
      };
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

        // Credential-file fallback: if the spawn didn't confirm auth (timed out
        // or failed), check the on-disk credentials file as a best-effort signal.
        if (!authenticated && credentialFileFallback) {
          try {
            const credsPath = resolveClaudeCredsPath(claudeChildEnv, cwd);
            const raw = await readFile(credsPath, 'utf8');
            if (credentialFileIndicatesAuth(raw, Date.now())) {
              authenticated = true;
              // Leave plan as-is (null) — we can't determine plan from the file alone.
            }
          } catch {
            // File missing or unreadable — leave authenticated false
          }
        }

        // Sub-tier enrichment: `claude auth status` reports the generic
        // `subscriptionType` ("max") but the on-disk credentials carry the
        // account's `rateLimitTier` (e.g. "default_claude_max_5x"). When we have a
        // Max plan with no sub-tier marker yet, read the creds file and fold the
        // rateLimitTier in so display + auto behaviour can distinguish 5x from 20x.
        // Fail-soft: any read/parse failure leaves the plan exactly as-is.
        if (plan !== null && plan.toLowerCase().includes('max')) {
          const pl = plan.toLowerCase();
          if (!pl.includes('20x') && !pl.includes('5x')) {
            try {
              const credsPath = resolveClaudeCredsPath(claudeChildEnv, cwd);
              const raw = await readFile(credsPath, 'utf8');
              plan = foldRateLimitTier(plan, rateLimitTierFromCreds(raw));
            } catch {
              // File missing/unreadable — leave plan as the generic Max.
            }
          }
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
    return detectOpencodeProvider(baseEnv, cwd);
  }

  // codex: run `codex --version` to probe installation, then `codex login status`
  try {
    // Point codex at the Replit-persistent CODEX_HOME when present so detection
    // sees the one-time sign-in that survives restarts (matches replit-tools).
    const codexChildEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      ...replitPersistentEnv(baseEnv, cwd),
    };
    const result = await execa('codex', ['--version'], {
      reject: false,
      timeout: 10_000,
      env: codexChildEnv,
    });

    if (result.exitCode === 0) {
      // Binary confirmed present — now probe real auth state.
      let authenticated = false;
      let plan: string | null = null; // `codex login status` text exposes no plan

      try {
        const authResult = await execa('codex', ['login', 'status'], {
          reject: false,
          timeout: 10_000,
          env: codexChildEnv,
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

      // Plan/tier enrichment (honest, no metered call): `codex login status` text
      // doesn't expose the ChatGPT plan, but codex's on-disk auth.json stores OAuth
      // tokens whose JWT claim carries `chatgpt_plan_type` (e.g. "pro"/"plus"/"free").
      // Read that ONE display string from the local file so the banner can show the
      // user's real ChatGPT plan like claude's. Only when authenticated; fail-soft —
      // any missing file / API-key login / parse failure leaves plan null (plain
      // "ready"), never a fabricated tier. The token itself is never read out or logged.
      if (authenticated) {
        try {
          const authPath = resolveCodexAuthPath(codexChildEnv, cwd);
          const raw = await readFile(authPath, 'utf8');
          plan = codexPlanFromAuthJson(raw);
        } catch {
          // File missing/unreadable — leave plan null (plain "ready").
        }
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
 * Classify opencode's on-disk credentials (auth.json) into a real auth verdict.
 *
 * GUARDRAIL (correct nuance): myshell-tools itself NEVER stores or handles a raw
 * API key — it DELEGATES sign-in to opencode, which stores the credential in its
 * OWN secure auth.json. opencode stores credentials there as a JSON object keyed
 * by provider id; each value carries a `type` field of either `"oauth"` (a real
 * subscription/OAuth login) or `"api"` (a provider/gateway key, e.g. OpenCode
 * Zen). opencode is authenticated when it holds AT LEAST ONE recognized credential
 * of EITHER type, because the secret lives inside opencode, never inside myshell.
 * With one credential opencode brokers many models (e.g. Kimi via opencode-go).
 *
 * Note: `opencode auth list`'s text output only prints a count ("N credentials"),
 * not the per-credential type, so we read auth.json directly and classify
 * (see opencodeCredentialCount).
 *
 * @param rawAuthJson - the raw contents of opencode's auth.json.
 */
export function parseOpencodeAuth(
  rawAuthJson: string,
): { authenticated: boolean; credentialCount: number } {
  const count = opencodeCredentialCount(rawAuthJson);
  return { authenticated: count > 0, credentialCount: count };
}

/**
 * Count opencode's recognized credentials in the raw contents of its auth.json.
 * auth.json is a JSON object keyed by provider id (e.g.
 * `{ "anthropic": { "type": "oauth", ... } }`); a recognized credential is an
 * object value whose `type` is `"oauth"` OR `"api"`. Both count: opencode (not
 * myshell) holds the secret, so an API-key credential (e.g. OpenCode Zen) is a
 * valid authenticated state from which opencode brokers many models.
 * Pure / fail-soft: returns 0 on missing/garbage/non-object input. Never throws.
 *
 * @param rawAuthJson - the raw contents of opencode's auth.json.
 */
export function opencodeCredentialCount(rawAuthJson: string): number {
  try {
    const parsed = JSON.parse(rawAuthJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return 0;
    let count = 0;
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        const type = (value as Record<string, unknown>)['type'];
        if (type === 'oauth' || type === 'api') {
          count += 1;
        }
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Derive a TRUTHFUL plan/tier label from opencode's on-disk `auth.json`.
 *
 * What is honestly available — and what is NOT:
 *  - opencode's auth.json `Info` union is `{type:"oauth", access, refresh, expires}`
 *    | `{type:"api", key}` | `{type:"wellknown", ...}`. It stores ONLY the
 *    credential TYPE and the secret — there is NO `plan` / `tier` / `subscription`
 *    field. (Verified against the opencode binary's auth schema.) So an OpenCode
 *    Zen / gateway `api` key carries NO plan we could read — pricing is a billing
 *    relationship with the gateway, not something opencode persists. We do NOT
 *    fabricate a "$10/mo"/"Zen" tier: there is nothing local to read it from.
 *  - The ONE honest exception: when the user signed opencode into a ChatGPT/OpenAI
 *    account, opencode stores an `oauth` credential whose `access` token is the SAME
 *    kind of JWT codex stores, carrying `https://api.openai.com/auth.chatgpt_plan_type`.
 *    When such a claim is genuinely decodable we surface it (e.g. "openai: pro"),
 *    keyed by the provider id so it's clear which connected account it describes.
 *
 * Returns null when no credential carries a decodable plan claim → the banner
 * stays at plain "ready" (honest: opencode is connected, but we can't name a tier).
 * Pure / fail-soft: any parse error returns null; the token is never logged. Never throws.
 *
 * @param rawAuthJson - the raw contents of opencode's auth.json.
 */
export function opencodePlanFromAuthJson(rawAuthJson: string): string | null {
  try {
    const parsed = JSON.parse(rawAuthJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (v['type'] !== 'oauth') continue;
      // An oauth credential's `access` token MAY be a ChatGPT/OpenAI JWT that
      // carries the account plan. Decode defensively (no signature trust) and
      // surface only a genuinely-present plan claim.
      const access = v['access'];
      if (typeof access !== 'string' || access.length === 0) continue;
      const claims = decodeJwtClaims(access);
      if (claims === null) continue;
      const authClaim = claims['https://api.openai.com/auth'];
      if (typeof authClaim !== 'object' || authClaim === null) continue;
      const planType = (authClaim as Record<string, unknown>)['chatgpt_plan_type'];
      if (typeof planType === 'string' && planType.trim().length > 0) {
        return `${providerId}: ${planType.trim().toLowerCase()}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve where opencode's `auth.json` lives — the same way opencode does:
 * `$XDG_DATA_HOME/opencode/auth.json` when XDG_DATA_HOME is set (Replit points it
 * at the persistent workspace via replitPersistentEnv), else
 * `$HOME/.local/share/opencode/auth.json`. Pure / never throws.
 */
export function resolveOpencodeAuthPath(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const xdg = env['XDG_DATA_HOME'];
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(home, '.local', 'share');
  return join(base, 'opencode', 'auth.json');
}

/**
 * Parse `opencode models` output into a list of `provider/model` ids.
 *
 * The command prints one model id per line (e.g. `opencode/deepseek-v4-flash-free`,
 * `opencode-go/kimi-k2.6`). We keep only lines that look like a provider/model id
 * (contain a slash, no whitespace) so banner/blank lines are ignored. Tolerant —
 * returns [] on empty/garbage input. Never throws.
 *
 * @param stdout - stdout from `opencode models`.
 */
export function parseOpencodeModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/[\w./:-]+$/.test(line));
}

/**
 * Detect the opencode CLI. `installed` is true when `opencode --version`
 * succeeds; `authenticated` reflects a REAL credential probe — we read opencode's
 * auth.json and treat it as authenticated when it holds at least one recognized
 * credential (`type === "oauth"` OR `type === "api"`). myshell never stores or sees
 * that secret — opencode does — so an API-key credential (e.g. OpenCode Zen) counts;
 * opencode then brokers many models (e.g. Kimi via opencode-go). We do NOT treat the
 * binary as authenticated-when-installed: the realistic flow is sign in via opencode
 * (OAuth or a pasted provider/gateway key) → then it's ready.
 */
async function detectOpencodeProvider(
  baseEnv: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ProviderStatus> {
  try {
    const env = { ...baseEnv, ...replitPersistentEnv(baseEnv, cwd) };
    const result = await execa('opencode', ['--version'], {
      reject: false,
      timeout: 10_000,
      env,
    });

    if (result.exitCode === 0) {
      // Binary present — now probe real auth state from opencode's auth.json.
      // authenticated when ≥1 recognized credential is present (`type:"oauth"` OR
      // `type:"api"`). opencode holds the secret, not myshell, so a pasted gateway/
      // provider key (e.g. OpenCode Zen) counts. `opencode auth list` only prints a
      // count, not the per-credential type, so we read auth.json directly.
      let authenticated = false;
      let plan: string | null = null;
      try {
        const raw = await readFile(resolveOpencodeAuthPath(env), 'utf8');
        authenticated = parseOpencodeAuth(raw).authenticated;
        // Plan/tier (honest, no metered call): opencode's auth.json stores only the
        // credential TYPE + secret — there is NO plan/tier field for a gateway/api
        // key (e.g. OpenCode Zen), so we do NOT invent one. The sole truthful case
        // is an oauth credential whose token carries a ChatGPT plan claim, which
        // opencodePlanFromAuthJson surfaces (else null → plain "ready").
        if (authenticated) {
          plan = opencodePlanFromAuthJson(raw);
        }
      } catch {
        // File missing/unreadable — leave authenticated false (offer sign-in,
        // don't pretend).
      }

      // Probe the user's REAL available models (`opencode models`) so the router
      // can pick the best one per tier and pass it to `opencode run -m`. The set
      // depends entirely on what they've connected (free models, OpenCode Go, or
      // Zen credits) — never hardcode it. Best-effort: empty on failure, which
      // makes the adapter omit -m and use opencode's own default.
      let availableModels: string[] = [];
      try {
        const modelsResult = await execa('opencode', ['models'], {
          reject: false,
          timeout: 10_000,
          env,
        });
        availableModels = parseOpencodeModels(
          typeof modelsResult.stdout === 'string' ? modelsResult.stdout : '',
        );
      } catch {
        // Spawn failure — leave availableModels empty (adapter falls back to -m omitted).
      }

      return {
        id: 'opencode',
        installed: true,
        version: (result.stdout as string).trim(),
        binaryPath: 'opencode',
        authenticated,
        plan,
        availableModels,
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
