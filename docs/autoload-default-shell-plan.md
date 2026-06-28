# Auto-Load Default Shell Plan

Scope: plan only. Do not edit `src/**/*.ts` or tests in this pass.

## Diagnosis

The feature currently has two different failure modes that need to stay separate:

1. **Never installed**: `setAsDefault` defaults to `false`, onboarding asks with default `no`, and the CLI startup self-heal only runs when `config.setAsDefault` is already true. On a fresh or default-config install, no rc/profile block is written, so killing and respawning a shell cannot auto-launch `myshell-tools`.
2. **Installed but does not trigger**: the installer targets one startup file per detected shell and assumes that startup file is sourced by future shells. That is correct for ordinary bash/zsh interactive shells, but can fail on Replit if the respawn path bypasses the target rc file, and can fail on Windows when PowerShell startup is locked down or when the user launches a different PowerShell profile path than the installer wrote.

Current grounding:

- [src/infra/config.ts:575](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/infra/config.ts:575): `DEFAULTS.setAsDefault` is `false`.
- [src/interface/menu-welcome.ts:207](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/menu-welcome.ts:207): first-run setup makes default shell opt-in with default `no`.
- [src/interface/menu-welcome.ts:245](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/menu-welcome.ts:245): onboarding only runs `runInstall()` if the user opted in.
- [src/cli.ts:819](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/cli.ts:819): self-heal only re-installs when persisted `config.setAsDefault` is already true.
- [src/commands/install.ts:49](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/commands/install.ts:49): shell target detection writes one rc/profile file.
- [src/commands/install.ts:92](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/commands/install.ts:92): bash/zsh/PowerShell hook block generation is centralized and idempotently managed by marker lines.

## Product Default

Recommend **default-on, opt-out** for the default shell experience.

That matches the owner expectation: after install/onboarding, killing the shell should return to the `myshell-tools` experience without manual `myshell-tools` typing. The current default-off behavior is the main reason this does not happen today.

Implementation nuance:

- New users and missing/corrupt config should resolve to `setAsDefault: true`.
- Onboarding should present the default shell prompt as `(Y/n)`, install on Enter, and persist `setAsDefault: true` only after the installer succeeds.
- Settings must remain the explicit opt-out path. Turning it off should uninstall the hook and persist `setAsDefault: false`.
- Existing configs that already contain `setAsDefault: false` are ambiguous: some are real opt-outs, some are just old default-off state. Product should decide whether to preserve them or run a one-time migration. My recommendation is conservative off-Replit, assertive on Replit:
  - Off-Replit: preserve explicit `false`; show a one-time settings/onboarding nudge if desired.
  - Replit: default to installing when no hook is present unless the user has explicitly toggled off after the migration. Add a migration marker such as `defaultShellDecisionVersion?: number` or `defaultShellOptOut?: true` so future false values are distinguishable from old inherited defaults.

## Environment Root Causes And Fixes

### Replit

Root cause:

- The persisted config is Replit-aware through `defaultStateHome()` and survives in the workspace, but the shell hook is written to `$HOME/.bashrc` via `detectShellTarget()`.
- The code already knows `$HOME` can be ephemeral on Replit. The install output says the persisted flag will re-install the hook on next launch, but that does not help the shell that is supposed to auto-launch `myshell-tools`; it only helps after `myshell-tools` has already started.
- If the current Replit terminal respawn is a normal interactive non-login bash, `$HOME/.bashrc` is the right hook for kill->respawn within the same container. If Replit uses a login shell, custom PTY launcher, or a freshly recreated home, `.bashrc` alone is not reliable.

Recommended fix:

1. Reuse `isReplit(process.env)` from [src/infra/state-dir.ts:30](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/infra/state-dir.ts:30).
2. Add a Replit-specific install path that writes both:
   - normal shell rc/profile files for the current container, so same-container kill->respawn works immediately;
   - a persistent workspace bootstrap, so container restart can rehydrate the ephemeral rc/profile before new shells spawn.
3. Treat Replit shell targets as multiple files, not a single file:
   - `$HOME/.bashrc` for interactive non-login bash;
   - `$HOME/.profile` and/or `$HOME/.bash_profile` for login-shell paths, guarded by the same `MYSHELL_LOADED` variable to prevent double launch;
   - optional zsh target if `$SHELL` contains zsh.
4. Create a persistent bootstrap script under the Replit-persistent state/workspace, for example `<stateHome>/.myshell-tools/replit-shell-bootstrap.sh`, that writes or upserts the current-container rc/profile hooks.
5. Wire that bootstrap through Replit's official startup mechanism only after verification. This repo has `.replit` `onBoot = "source /home/runner/workspace/.replit-tools/scripts/setup-claude-code.sh 2>/dev/null || true"`, which suggests `onBoot` can be used to restore ephemeral shell state. Do not blindly overwrite `.replit`; append a guarded myshell command and make uninstall remove only the managed segment.

Items to mark `VERIFY`:

- `VERIFY`: Whether Replit's interactive terminal respawn currently launches bash as interactive non-login, login, or through a custom shell entrypoint.
- `VERIFY`: Whether Replit terminal respawn sources `$HOME/.bashrc`, `$HOME/.profile`, `$HOME/.bash_profile`, or none of them.
- `VERIFY`: Whether `.replit` `onBoot` runs before interactive terminal shells are available and can reliably rewrite `/home/runner/.bashrc`.
- `VERIFY`: The safest documented way to append multiple `onBoot` commands without clobbering an existing `.replit` file.

### Linux

Root cause:

- For ordinary bash/zsh, the installed hook should trigger for interactive shells that source `~/.bashrc` or `~/.zshrc`.
- The common failure today is usually **never installed**, because default config and onboarding do not install it.
- Login bash reads profile files rather than `.bashrc` unless the profile sources `.bashrc`, so a login-shell environment can be an **installed but does not trigger** case.

Recommended fix:

- Keep the bash/zsh hook shape, but strengthen the interactive guard from only `[ -t 1 ]` to include shell interactivity:

```sh
case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac
if [ -t 1 ] && [ -z "$MYSHELL_LOADED" ] && [ -z "$MYSHELL_SKIP" ]; then
  export MYSHELL_LOADED=1
  command -v myshell-tools >/dev/null 2>&1 && myshell-tools || true
fi
```

- For normal Linux, keep targeting one primary rc file by shell to avoid surprising profile edits. For Replit, use the broader multi-file strategy above because the owner requirement explicitly needs respawn reliability in that environment.
- Preserve marker idempotency: install twice must leave exactly one managed block per target file.

### Windows / PowerShell

Root causes:

- Current Windows target is only `Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`, so PowerShell 7 users may launch `Documents\PowerShell\Microsoft.PowerShell_profile.ps1` and never read the installed hook.
- Locked-down hosts can run PowerShell in ConstrainedLanguage mode. The known failing installed hook uses operations that throw at startup:
  - dot-sourcing a command from a different language mode;
  - `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`.
- Any profile hook failure must not break shell startup.

Recommended fix:

- Do not set `[Console]::OutputEncoding` in the hook.
- Do not dot-source external scripts from the hook.
- Prefer external executable shims (`myshell-tools.cmd` or `.exe`) before falling back to `myshell-tools`, so Windows npm PowerShell shims are not required under ConstrainedLanguage.
- Wrap launch and aliases in `try/catch` and use `-ErrorAction SilentlyContinue`.
- Consider installing to both Windows PowerShell and PowerShell 7 profile paths on Windows, or detect the active shell profile when possible.

Corrected `buildHookBlock('powershell')` string:

```ts
return (
  `${HOOK_BEGIN}\n` +
  `# Launch myshell-tools on new interactive shells. Opt out: $env:MYSHELL_SKIP = '1'\n` +
  `try {\n` +
  `  if ($null -eq $env:MYSHELL_LOADED -and $null -eq $env:MYSHELL_SKIP) {\n` +
  `    $env:MYSHELL_LOADED = '1'\n` +
  `    if (Get-Command myshell-tools.cmd -CommandType Application -ErrorAction SilentlyContinue) { myshell-tools.cmd }\n` +
  `    elseif (Get-Command myshell-tools.exe -CommandType Application -ErrorAction SilentlyContinue) { myshell-tools.exe }\n` +
  `    elseif (Get-Command myshell-tools -ErrorAction SilentlyContinue) { myshell-tools }\n` +
  `  }\n` +
  `} catch {\n` +
  `}\n` +
  `# Convenience aliases: cm / mst -> myshell-tools (control menu)\n` +
  `try {\n` +
  `  if (Get-Command myshell-tools.cmd -CommandType Application -ErrorAction SilentlyContinue) {\n` +
  `    Set-Alias -Name cm -Value myshell-tools.cmd -Scope Global -ErrorAction SilentlyContinue\n` +
  `    Set-Alias -Name mst -Value myshell-tools.cmd -Scope Global -ErrorAction SilentlyContinue\n` +
  `  } elseif (Get-Command myshell-tools.exe -CommandType Application -ErrorAction SilentlyContinue) {\n` +
  `    Set-Alias -Name cm -Value myshell-tools.exe -Scope Global -ErrorAction SilentlyContinue\n` +
  `    Set-Alias -Name mst -Value myshell-tools.exe -Scope Global -ErrorAction SilentlyContinue\n` +
  `  } elseif (Get-Command myshell-tools -ErrorAction SilentlyContinue) {\n` +
  `    Set-Alias -Name cm -Value myshell-tools -Scope Global -ErrorAction SilentlyContinue\n` +
  `    Set-Alias -Name mst -Value myshell-tools -Scope Global -ErrorAction SilentlyContinue\n` +
  `  }\n` +
  `} catch {\n` +
  `}\n` +
  `${HOOK_END}`
);
```

## Exact Code Change Plan

### `src/infra/config.ts:575`

Before:

```ts
const DEFAULTS: AppConfig = {
  onboarded: false,
  setAsDefault: false,
  autoUpdate: true,
};
```

After:

```ts
const DEFAULTS: AppConfig = {
  onboarded: false,
  setAsDefault: true,
  autoUpdate: true,
};
```

If preserving existing opt-outs matters, add migration metadata before flipping old persisted false values:

```ts
defaultShellDecisionVersion?: number;
```

### `src/interface/menu-welcome.ts:170-247`

Before:

```ts
setAsDefault = await confirm(false);
...
await saveConfig(saved);
if (setAsDefault && !alreadyDefault) {
  await runInstall(out);
}
```

After:

```ts
out.write(`Set myshell-tools as your default shell tool? ${yesNoHint('yes', out.color)} `);
const wantsDefault = await confirm(true);

let setAsDefault = alreadyDefault;
if (wantsDefault && !alreadyDefault) {
  const code = await runInstall(out);
  setAsDefault = code === 0;
}

const saved: AppConfig = {
  onboarded: true,
  setAsDefault,
  ...
};
await saveConfig(saved);
```

Reason: persist `true` only when the hook actually installs, so config remains honest. If the install fails, the user can still reach Settings and retry.

Also update the EOF path at [src/interface/menu-welcome.ts:170](/C:/Users/Josh/Desktop/Github/Repositories/myshell-tools/src/interface/menu-welcome.ts:170): do not save `setAsDefault: false` by default. Either omit it or use `mutableConfig.setAsDefault`, so `DEFAULTS.setAsDefault: true` can apply.

### `src/cli.ts:812-827`

Before:

```ts
if (config.setAsDefault) {
  try {
    const hookPresent = await isHookInstalled(process.env, process.platform).catch(() => false);
    if (!hookPresent) {
      await runInstall(out).catch(() => undefined);
    }
  } catch {
    // never block launch
  }
}
```

After:

```ts
if (config.setAsDefault) {
  try {
    const hookPresent = await isHookInstalled(process.env, process.platform).catch(() => false);
    if (!hookPresent) {
      await runInstall(out).catch(() => undefined);
    }
    if (isReplit(process.env)) {
      await ensureReplitShellBootstrap(out).catch(() => undefined);
    }
  } catch {
    // never block launch
  }
}
```

Reason: same-container self-heal remains best-effort, and Replit gets persistent bootstrap coverage for future fresh shells.

### `src/commands/install.ts:49-72`

Before:

```ts
export function detectShellTarget(...): { kind: DetectShellKind; path: string } {
  ...
  return { kind: 'bash', path: `${home}/.bashrc` };
}
```

After:

```ts
export interface ShellTarget {
  readonly kind: DetectShellKind;
  readonly path: string;
  readonly role: 'primary' | 'login-profile' | 'replit-bootstrap';
}

export function detectShellTargets(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): readonly ShellTarget[] {
  ...
}

export function detectShellTarget(...) {
  return detectShellTargets(env, platform)[0] ?? ...
}
```

Reason: keep the old single-target API for compatibility while allowing Replit and Windows to install multiple startup points.

Recommended target rules:

- Linux bash: primary `$HOME/.bashrc`.
- Linux zsh: primary `$HOME/.zshrc`.
- Replit bash: `$HOME/.bashrc`, `$HOME/.profile`, and `$HOME/.bash_profile` if present or if verification shows login shells require them.
- Windows: both `%USERPROFILE%\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1` and `%USERPROFILE%\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`.

### `src/commands/install.ts:92-124`

Before: current PowerShell block uses unguarded launch/alias function definitions.

After: use the ConstrainedLanguage-safe PowerShell block shown above. Also update unit tests at `test/unit/install.test.ts:219-279` to assert:

- no `[Console]::OutputEncoding`;
- no dot-sourcing;
- contains `try`;
- contains `catch`;
- prefers `myshell-tools.cmd`;
- defines aliases with `Set-Alias` rather than functions.

### `src/commands/install.ts:159-260`

The current `upsertHook()` only recognizes an exact current block. If `buildHookBlock()` changes, previously installed blocks may become "malformed" instead of replaceable.

Plan:

- Keep begin/end marker safety, but change managed-block detection to accept any single block bounded by `HOOK_BEGIN` and `HOOK_END`.
- On install, replace bounded old-version blocks with the new block.
- On uninstall, remove bounded blocks.
- Still fail if:
  - there is a begin without an end;
  - there is an end before begin;
  - there are multiple managed blocks in the same file unless the migration deliberately collapses them.

This preserves idempotency while allowing hook upgrades.

## Idempotency And Fail-Soft Guarantees

- Install is idempotent per target file: one begin marker and one end marker after any number of installs.
- Multi-target install is idempotent across all target files: each target is upserted independently.
- Uninstall removes only managed marker blocks and only managed `.replit`/bootstrap segments.
- A missing `myshell-tools` command never breaks shell startup.
- Any hook runtime error is swallowed inside the hook.
- Any installer I/O error returns non-zero and leaves config unchanged when called from onboarding/settings.
- Any CLI startup self-heal error is caught and does not block the menu.
- `MYSHELL_SKIP=1` remains the per-shell opt-out.
- `MYSHELL_LOADED=1` remains the double-launch guard across `.profile` plus `.bashrc` chains.

## Verification Plan

### Unit

- `config.test.ts`: update default assertions from `false` to `true`; add explicit false opt-out case.
- `menu-flow.test.ts`: onboarding Enter should install by default; explicit `n` should skip and persist false; failed install should persist false.
- `install.test.ts`: idempotent install with upgraded hook block replaces old managed block rather than failing malformed.
- `install.test.ts`: Replit target detection returns multiple targets when `REPL_ID` or `REPLIT_DEV_DOMAIN` is set.
- `install.test.ts`: Windows target detection includes WindowsPowerShell and PowerShell profile paths.
- `install.test.ts`: PowerShell block has no `[Console]::OutputEncoding`, no dot-source, and uses try/catch plus `.cmd` preference.

### Linux

1. Fresh temp home, no config: run `myshell-tools` onboarding with Enter through default-shell prompt.
2. Confirm `~/.bashrc` contains one managed block.
3. Start `bash -i`; confirm `myshell-tools` launches.
4. Start `bash -lc 'true'`; confirm no launch/no hang.
5. Install twice; confirm one marker block.
6. Uninstall; confirm block removed and original file bytes preserved around it.

### Replit

1. In a Replit container with default-on config, run onboarding and accept default shell.
2. Confirm managed blocks exist in the verified Replit startup file(s).
3. Kill the active shell process; confirm the respawned terminal auto-launches `myshell-tools`.
4. Restart the container; confirm the persistent bootstrap rehydrates ephemeral rc/profile files.
5. Open a fresh terminal without manually running `myshell-tools`; confirm it auto-launches.
6. Toggle default shell off; confirm rc/profile blocks and any `.replit`/bootstrap segment are removed without touching unrelated config.

### Windows

1. Normal Windows PowerShell: install, open a new shell, confirm auto-launch.
2. PowerShell 7: install, open `pwsh`, confirm auto-launch if multi-profile install is implemented.
3. Locked-down ConstrainedLanguage host: install, open a new shell, confirm no profile startup errors.
4. Confirm `[Console]::OutputEncoding` is absent from installed profile.
5. Confirm aliases `cm` and `mst` work when permitted, and failures are silent when not permitted.
6. Uninstall; confirm profile marker block is removed.

