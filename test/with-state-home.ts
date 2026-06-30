/**
 * test/with-state-home.ts — shared test helper for isolating app state into a
 * temp directory. Sets HOME/USERPROFILE/APPDATA/LOCALAPPDATA to the given
 * directory, clears XDG + cloud IDE vars, and restores env after the callback.
 */
export async function withStateHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const keys = [
    'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'REPL_ID', 'REPLIT_DEV_DOMAIN',
    'CODESPACES', 'CODESPACE_NAME', 'GITPOD_WORKSPACE_ID', 'MYSHELL_CLOUD_WORKSPACE',
  ] as const;
  const orig = new Map(keys.map((k) => [k, process.env[k]] as const));
  const restore = (k: string, v: string | undefined): void => {
    if (v !== undefined) process.env[k] = v;
    else Reflect.deleteProperty(process.env, k);
  };
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  process.env['APPDATA'] = home;
  process.env['LOCALAPPDATA'] = home;
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'REPL_ID', 'REPLIT_DEV_DOMAIN', 'CODESPACES', 'CODESPACE_NAME', 'GITPOD_WORKSPACE_ID', 'MYSHELL_CLOUD_WORKSPACE']) {
    Reflect.deleteProperty(process.env, k);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of orig) restore(k, v);
  }
}
