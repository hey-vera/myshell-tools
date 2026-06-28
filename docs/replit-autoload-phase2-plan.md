# Replit Autoload Phase 2 Plan

## Problem

`myshell-tools install` currently treats a shell rc symlink as something to
preserve. On normal machines that is conservative, but in a modern Nix-based
Replit container it points `~/.bashrc` at a read-only Nix store file:

```text
/home/runner/.bashrc -> /nix/store/...-replit-bashrc/bashrc
```

The existing installer resolves that symlink and attempts to upsert the
`HOOK_BEGIN` / `HOOK_END` block into the Nix target. That write fails with
`Permission denied`, so respawned non-login interactive Replit shell tabs source
the original Replit bashrc and never launch `myshell-tools`.

Ground truth for this plan:

- Replit shell tabs are interactive, non-login bash shells.
- They source `~/.bashrc`, not `~/.profile`.
- Replit needs its original bashrc sourced on every shell because it contains
  command tracking, pwd tracking, completion, and aliases.
- `~/.profile` is writable but is not sourced by normal shell tabs.
- `REPL_ID` is present, so use `isReplit(process.env)` from
  `src/infra/state-dir.ts`.
- `/home/runner/workspace` persists, but `/home/runner` may be recreated across
  container restarts.

## Recommendation

Implement approach 1 only for this phase: a Replit-specific `~/.bashrc` wrapper
that replaces the read-only symlink with a writable regular file.

The wrapper must:

1. Source the original Nix bashrc target first.
2. Then include the normal guarded `myshell-tools` bash hook block.
3. Store the original symlink target in a managed comment so uninstall can
   restore the symlink.
4. Be installed and healed only when `isReplit(process.env)` is true.
5. Never alter the non-Replit Linux, macOS, or Windows install paths.

Do not use `~/.profile` for this fix. Do not edit `.replit` in this phase.

This is the most robust minimal fix for the verified failure: killed Replit
shell tabs respawn as non-login interactive bash shells that source
`~/.bashrc`. Replacing only the Replit read-only symlink with a wrapper changes
the one file Replit actually sources while preserving Replit's original startup
logic exactly.

## Approach Evaluation

### 1. Symlink-Replacement Wrapper

Recommended.

Current code path:

- `detectShellTarget()` returns `${HOME}/.bashrc` for bash.
- `resolveRcWriteTarget()` follows symlinks.
- `upsertOneFile()` writes the resolved target.

In Replit that means trying to write `/nix/store/.../bashrc`, which is
read-only. The Replit path needs a special case before the generic symlink
preservation logic.

The replacement should happen only when all are true:

- `isReplit(process.env)` is true.
- `process.platform !== 'win32'`.
- The detected shell target is bash, or the target is explicitly
  `${HOME}/.bashrc`.
- `lstat("~/.bashrc")` reports a symlink whose resolved target is under
  `/nix/store/`.

The wrapper should source the original target by absolute path. Use Node's
`realpath(rcPath)` as the `readlink -f` equivalent. Optionally also call
`readlink(rcPath)` for diagnostics, but persist the canonical absolute
`realpath()` result in the wrapper because that is what uninstall should restore.

Avoid double-sourcing by never sourcing `~/.bashrc` from the wrapper. Source only
the captured original target:

```bash
if [ -r '/nix/store/...-replit-bashrc/bashrc' ]; then
  . '/nix/store/...-replit-bashrc/bashrc'
fi
```

Detect "already wrapped" by separate Replit wrapper markers plus the normal
hook markers:

```text
# >>> myshell-tools replit bashrc wrapper >>>
# myshell-tools-replit-original-bashrc: /nix/store/...-replit-bashrc/bashrc
...
# <<< myshell-tools replit bashrc wrapper <<<
```

The wrapper marker is intentionally separate from `HOOK_BEGIN` /
`HOOK_END`. The standard hook markers still identify the actual launch block,
while the wrapper marker records Replit-specific restore metadata.

### 2. `~/.profile` Hook

Not recommended for this phase.

It is harmless only in the narrow sense that normal Replit shell tabs will not
source it. Because the verified shell is non-login interactive bash, writing
`~/.profile` alone does not fix the bug.

Do not add it as belt-and-suspenders now:

- It does not participate in the stated kill-tab respawn path.
- It creates a second startup surface to install, upgrade, and uninstall.
- It can make future login shells launch `myshell-tools` from a path that Replit
  shell tabs do not actually use, making support harder.

If a future issue proves Replit login shells need coverage, add it as a
separate Replit login-shell feature with its own verification.

### 3. `.replit` `onBoot` Managed Segment

Not recommended for this phase.

`onBoot` could heal `~/.bashrc` before the first user shell after a cold
container boot, but it expands the blast radius:

- `.replit` is project configuration, not a shell rc file.
- There is already an unrelated managed `onBoot` line from another tool.
- Replit supports a single effective `onBoot` command, so safely merging means
  parsing and rewriting the existing value rather than appending a duplicate key.
- Incorrect `.replit` edits can affect project boot behavior outside
  `myshell-tools`.

Rely on launch-time heal for phase 2. If Replit recreates `~/.bashrc` on boot,
the next explicit `myshell-tools` launch should re-wrap it, and killed shell
tabs after that will auto-launch again.

If product requirements later demand first-shell-after-cold-boot autoload, add a
separate phase with a dedicated `.replit` updater:

- Parse `.replit` as TOML or with a narrowly tested line-preserving updater.
- Preserve the existing `onBoot` command exactly.
- Merge one managed command into the existing `onBoot` string rather than adding
  a second `onBoot` key.
- Use distinct markers inside the command string, for example
  `# >>> myshell-tools onBoot >>>` and `# <<< myshell-tools onBoot <<<`.
- The managed command should run a non-interactive heal command only, never the
  full UI, for example:

```sh
command -v myshell-tools >/dev/null 2>&1 && MYSHELL_SKIP=1 myshell-tools replit-heal >/dev/null 2>&1 || true
```

- Uninstall must remove only that managed command segment and leave the existing
  DATA-Tools `onBoot` command untouched.

That is useful later, but unnecessary for the kill-tab bug once `~/.bashrc`
itself is wrapped.

## Proposed Code Shape

All changes should be in `src/commands/install.ts` and `src/cli.ts`, but this
document is the only file to edit for this planning task.

Add Replit-specific helpers near the existing hook helpers in
`src/commands/install.ts`.

```ts
const REPLIT_WRAPPER_BEGIN = '# >>> myshell-tools replit bashrc wrapper >>>';
const REPLIT_WRAPPER_END = '# <<< myshell-tools replit bashrc wrapper <<<';
const REPLIT_ORIGINAL_PREFIX = '# myshell-tools-replit-original-bashrc: ';

interface ReplitShellHookResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly installed: boolean;
  readonly restored?: boolean;
  readonly rcPath: string;
  readonly originalTarget?: string;
  readonly reason?: string;
}
```

Recommended public helper:

```ts
export async function ensureReplitShellHook(
  out: OutputSink,
  opts?: { uninstall?: boolean },
): Promise<ReplitShellHookResult>
```

The helper should be fail-soft. It should catch its own I/O errors, write a
short `[warn]` or `[error]` line when called from install/uninstall, and return
`{ ok: false, ... }` instead of throwing. `cli.ts` self-heal should still wrap
the call in `.catch(() => undefined)`.

### Pseudocode

```ts
export async function ensureReplitShellHook(out, opts = {}) {
  const uninstall = opts.uninstall === true;

  if (!isReplit(process.env) || process.platform === 'win32') {
    return { ok: true, changed: false, installed: false, rcPath: '' };
  }

  const home = process.env.HOME ?? '/home/runner';
  const rcPath = `${home}/.bashrc`;

  try {
    const st = await lstat(rcPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    });

    if (uninstall) {
      return await uninstallReplitBashrcWrapper(rcPath, out);
    }

    if (st?.isSymbolicLink() === true) {
      const originalTarget = await realpath(rcPath); // readlink -f equivalent
      if (!originalTarget.startsWith('/nix/store/')) {
        return {
          ok: true,
          changed: false,
          installed: false,
          rcPath,
          reason: 'bashrc symlink is not a Nix store target',
        };
      }

      const content = buildReplitWrappedBashrc(originalTarget);
      // atomicWrite writes a temp file in the same directory and renames it
      // over rcPath. On POSIX this replaces the symlink itself, not the target.
      await atomicWrite(rcPath, content, 0o644);
      return { ok: true, changed: true, installed: true, rcPath, originalTarget };
    }

    if (st !== undefined && st.isFile()) {
      const existing = await readFile(rcPath, 'utf8');

      if (isReplitWrappedBashrc(existing)) {
        const originalTarget = parseReplitOriginalTarget(existing);
        if (originalTarget === undefined) {
          return {
            ok: false,
            changed: false,
            installed: false,
            rcPath,
            reason: 'wrapped bashrc is missing original target metadata',
          };
        }

        const updated = buildReplitWrappedBashrc(originalTarget);
        if (existing === updated) {
          return { ok: true, changed: false, installed: true, rcPath, originalTarget };
        }

        await atomicWrite(rcPath, updated, st.mode & 0o7777);
        return { ok: true, changed: true, installed: true, rcPath, originalTarget };
      }

      // A regular unwrapped file is not the verified Replit failure mode. Let
      // the generic installer handle it, so user-owned bashrc content is not
      // replaced by the wrapper.
      return {
        ok: true,
        changed: false,
        installed: existing.includes(HOOK_BEGIN),
        rcPath,
        reason: 'regular unwrapped bashrc',
      };
    }

    return {
      ok: true,
      changed: false,
      installed: false,
      rcPath,
      reason: 'bashrc is not a symlink or regular file',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.write(`[warn] Replit shell hook heal failed: ${message}\n`);
    return { ok: false, changed: false, installed: false, rcPath, reason: message };
  }
}
```

Use `rename(tempPath, rcPath)` to replace the symlink with a regular file.
Do not use the existing `resolveRcWriteTarget()` path for this case, because it
is explicitly designed to preserve symlinks.

### Wrapper Builder

```ts
function buildReplitWrappedBashrc(originalTarget: string): string {
  const quotedTarget = shellSingleQuote(originalTarget);
  return [
    REPLIT_WRAPPER_BEGIN,
    '# Managed by myshell-tools for Replit read-only bashrc symlinks.',
    `${REPLIT_ORIGINAL_PREFIX}${originalTarget}`,
    '',
    '# Source Replit original startup logic first: tracking, completion, aliases.',
    `if [ -r ${quotedTarget} ]; then`,
    `  . ${quotedTarget}`,
    'fi',
    '',
    buildHookBlock('bash'),
    REPLIT_WRAPPER_END,
    '',
  ].join('\n');
}
```

`shellSingleQuote()` should be a small pure helper:

```ts
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

### Exact Hook Block Inside Wrapped Bashrc

Use the existing `buildHookBlock('bash')` output unchanged:

```bash
# >>> myshell-tools >>>
# Launch myshell-tools on new interactive shells. Opt out: export MYSHELL_SKIP=1
case "$-" in
  *i*) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac
if [ -t 1 ] && [ -z "$MYSHELL_LOADED" ] && [ -z "$MYSHELL_SKIP" ]; then
  export MYSHELL_LOADED=1
  command -v myshell-tools >/dev/null 2>&1 && myshell-tools || true
fi
# Convenience aliases: cm / mst -> myshell-tools (control menu)
if command -v myshell-tools >/dev/null 2>&1; then
  alias cm='myshell-tools'
  alias mst='myshell-tools'
fi
# <<< myshell-tools <<<
```

The `MYSHELL_LOADED` guard is the recursion guard. The hook exports
`MYSHELL_LOADED=1` before launching `myshell-tools`, so any child shell spawned
by `myshell-tools` inherits it and skips auto-launch. A new Replit shell tab
starts with a clean environment and launches normally unless `MYSHELL_SKIP=1`
is set.

## Install, Heal, and Uninstall Flow

### `runInstall()`

At the start of `runInstall()`, after detecting `enable` and the shell target:

```ts
if (isReplit(process.env) && process.platform !== 'win32' && kind === 'bash') {
  const result = await ensureReplitShellHook(out, { uninstall: !enable });

  if (result.ok && result.installed && enable) return 0;
  if (result.ok && result.restored && !enable) return 0;

  // For regular unwrapped writable bashrc files, fall through to existing
  // upsertOneFile() behavior.
}
```

This keeps the existing generic path available for non-symlink files and avoids
rewriting unrelated user-owned bashrc files.

On install, if the current `~/.bashrc` is a Nix-store symlink, replace it with
the wrapper and report:

```text
[info] Replit shell hook installed in: /home/runner/.bashrc
[info] Replit original bashrc preserved: /nix/store/...-replit-bashrc/bashrc
[info] New Replit shell tabs will launch myshell-tools automatically.
```

### `cli.ts` Self-Heal

In the existing `config.setAsDefault` block around `src/cli.ts:819`, run the
Replit heal before the generic `isHookInstalled()` check:

```ts
if (config.setAsDefault) {
  try {
    if (isReplit(process.env)) {
      await ensureReplitShellHook(out).catch(() => undefined);
    }

    const hookPresent = await isHookInstalled(process.env, process.platform).catch(() => false);
    if (!hookPresent) {
      await runInstall(out).catch(() => undefined);
    }
  } catch {
    // never block launch
  }
}
```

This makes launch-time healing explicit:

- If Replit recreated the symlink on boot, the next `myshell-tools` launch wraps
  it again.
- If it is already wrapped with current content, no write occurs.
- If it is a regular unwrapped file, existing generic behavior remains in
  charge.

`cli.ts` will need to import both `ensureReplitShellHook` and `isReplit`.

### Uninstall

Add a helper:

```ts
async function uninstallReplitBashrcWrapper(
  rcPath: string,
  out: OutputSink,
): Promise<ReplitShellHookResult>
```

Behavior:

1. If `~/.bashrc` is a symlink, do nothing and return success.
2. If it is a regular file with Replit wrapper markers, parse
   `REPLIT_ORIGINAL_PREFIX`.
3. Create a temporary symlink in the same directory pointing to that original
   target.
4. `rename(tempSymlink, rcPath)` to atomically restore
   `~/.bashrc -> /nix/store/...-replit-bashrc/bashrc`.
5. Return `{ ok: true, changed: true, installed: false, restored: true }`.
6. If the file has only normal `HOOK_BEGIN` / `HOOK_END` and no Replit wrapper
   markers, fall through to existing `upsertOneFile(..., enable=false, ...)`.

Never delete the original Nix target. Never remove Replit's original startup
logic. Never alter `.profile`.

## Idempotency Guarantees

Install or heal:

- Symlink to Nix store: replace with wrapper once.
- Current wrapper with same original target and same hook block: no write.
- Current wrapper with old hook content: replace only the wrapper file content,
  preserving the recorded original target.
- Current wrapper missing restore metadata: fail soft and ask for manual repair.
- Regular unwrapped bashrc: let the existing generic installer handle it.

Uninstall:

- Current wrapper: restore original symlink.
- Current symlink: no-op success.
- Regular file with standard hook only: existing uninstall removes only the
  managed hook block.
- Malformed markers: use existing malformed marker failure behavior; do not
  guess.

## Fail-Soft Guarantees

All Replit-specific install/heal paths should return a result object rather than
throwing past their public boundary. `cli.ts` should keep its existing
best-effort self-heal style.

Shell startup itself remains fail-soft because the hook block already ends the
launch command with `|| true`, and the wrapper should guard the original source
with `if [ -r ... ]; then`.

If the original Nix target disappears, the wrapper should not prevent a shell
from starting. Replit tracking may be absent in that one bad state, but the
shell remains usable and `myshell-tools` can still launch.

## Non-Replit Regression Boundary

Do not change behavior for:

- Windows PowerShell profiles.
- macOS or Linux zsh.
- non-Replit bash rc symlinks.
- fish manual guidance.
- regular writable bashrc files outside Replit.

The key containment rule is: the wrapper path is reachable only through
`isReplit(process.env)` and the Replit bash `~/.bashrc` target.

## Verification Sequence in Replit

Run after implementing the code change in a Replit container.

1. Confirm starting state:

```sh
echo "flags=$- shell0=$0"
ls -l ~/.bashrc
readlink -f ~/.bashrc
test -w ~/.profile && echo "profile writable"
```

Expected before install: `~/.bashrc` is a symlink to `/nix/store/.../bashrc`.

2. Enable default shell launch:

```sh
myshell-tools install
```

Expected:

```sh
test -f ~/.bashrc && echo "bashrc is regular file"
grep -F '# >>> myshell-tools replit bashrc wrapper >>>' ~/.bashrc
grep -F '# myshell-tools-replit-original-bashrc: /nix/store/' ~/.bashrc
grep -F '# >>> myshell-tools >>>' ~/.bashrc
grep -F '_replit_command_tracking' "$(sed -n 's/^# myshell-tools-replit-original-bashrc: //p' ~/.bashrc)"
```

3. Confirm the wrapper sources Replit's original file before the hook:

```sh
sed -n '1,80p' ~/.bashrc
```

Expected order:

- Replit wrapper begin marker.
- Original Nix bashrc target metadata.
- `. '/nix/store/...-replit-bashrc/bashrc'`.
- Standard `HOOK_BEGIN` / `HOOK_END` block.
- Replit wrapper end marker.

4. Kill the Replit shell tab from the UI, then let Replit respawn it.

Expected: `myshell-tools` auto-launches in the new shell tab.

5. Confirm Replit tracking still works after exiting `myshell-tools`:

```sh
pwd
cd /tmp
pwd
history | tail
alias ls
```

Expected: no shell startup errors, aliases still exist, and Replit command/pwd
tracking behavior remains intact.

6. Confirm recursive launch is blocked:

```sh
echo "$MYSHELL_LOADED"
bash -i
```

Expected: the child interactive bash shell does not auto-launch
`myshell-tools` because `MYSHELL_LOADED=1` is inherited.

7. Confirm idempotency:

```sh
cp ~/.bashrc /tmp/myshell-bashrc-before
myshell-tools install
cmp ~/.bashrc /tmp/myshell-bashrc-before && echo "idempotent"
```

Expected: no content change when already wrapped with current markers.

8. Confirm uninstall restores the symlink:

```sh
myshell-tools uninstall
ls -l ~/.bashrc
readlink -f ~/.bashrc
grep -F '# >>> myshell-tools >>>' ~/.bashrc || echo "hook absent"
```

Expected:

- `~/.bashrc` is again a symlink to the original `/nix/store/.../bashrc`.
- The managed hook is absent from the sourced file.
- A newly killed/respawned shell tab no longer auto-launches
  `myshell-tools`.
