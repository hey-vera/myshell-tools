/**
 * src/infra/config.ts — Global app configuration persisted at
 * <homeDir>/.myshell-tools/config.json.
 *
 * Reads merge over defaults so that new keys added in future versions are
 * always present even when the on-disk file pre-dates them.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppConfig {
  onboarded: boolean;
  setAsDefault: boolean;
  /** Active routing mode. Absent → use DEFAULT_POLICY (same as 'balanced'). */
  mode?: 'cost-saver' | 'balanced' | 'quality-first';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: AppConfig = {
  onboarded: false,
  setAsDefault: false,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getConfigDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools');
}

function getConfigPath(homeDir: string): string {
  return join(getConfigDir(homeDir), 'config.json');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the global app config.  Returns defaults merged with any on-disk
 * values so unknown/corrupt files never throw and new keys are always present.
 */
export async function loadConfig(homeDir?: string): Promise<AppConfig> {
  const home = homeDir ?? homedir();
  let raw: string;
  try {
    raw = await readFile(getConfigPath(home), 'utf8');
  } catch {
    // Missing file — return defaults
    return { ...DEFAULTS };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // Merge: defaults first, then on-disk values (new keys default safely)
    return { ...DEFAULTS, ...parsed };
  } catch {
    // Corrupt JSON — return defaults
    return { ...DEFAULTS };
  }
}

/**
 * Persist the app config atomically.  Creates the `.myshell-tools` directory
 * if it does not exist.
 */
export async function saveConfig(config: AppConfig, homeDir?: string): Promise<void> {
  const home = homeDir ?? homedir();
  await mkdir(getConfigDir(home), { recursive: true });
  await atomicWrite(getConfigPath(home), JSON.stringify(config, null, 2));
}
