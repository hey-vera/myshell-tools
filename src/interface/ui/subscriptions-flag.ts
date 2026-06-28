import type { AppConfig } from '../../infra/config.js';

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function subscriptionsEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: Pick<AppConfig, 'experimentalSubscriptions'> | undefined,
): boolean {
  if (config?.experimentalSubscriptions === true) return true;
  const raw = env?.['MYSHELL_SUBSCRIPTIONS'];
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}
