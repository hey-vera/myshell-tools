import type { AppConfig } from '../../infra/config.js';

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function accountParallelismEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: Pick<AppConfig, 'experimentalAccountParallelism'> | undefined,
): boolean {
  if (config?.experimentalAccountParallelism === true) return true;
  const raw = env?.['MYSHELL_ACCOUNT_PARALLELISM'];
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}
