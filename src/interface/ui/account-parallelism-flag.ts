import type { AppConfig } from '../../infra/config.js';
import { subscriptionsEnabled } from './subscriptions-flag.js';

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function accountParallelismEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: Pick<AppConfig, 'experimentalSubscriptions' | 'experimentalAccountParallelism'> | undefined,
): boolean {
  if (!subscriptionsEnabled(env, config)) return false;
  if (config?.experimentalAccountParallelism === true) return true;
  const raw = env?.['MYSHELL_ACCOUNT_PARALLELISM'];
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}
