/**
 * src/infra/update-prefix.ts — derive the npm install PREFIX that owns the
 * currently-running myshell-tools binary.
 *
 * The problem this solves
 * -----------------------
 * The self-updater runs `npm install -g myshell-tools@latest`, which installs
 * into npm's *global* prefix. But the `myshell-tools` actually on the user's
 * PATH can live under a DIFFERENT prefix (e.g. a Volta/asdf/fnm shim dir, or a
 * version manager's per-version node_modules). When that happens the update
 * lands somewhere the user never executes, and the running copy stays stale.
 *
 * The fix: figure out which prefix owns the *running* entry file and pass it to
 * npm via `--prefix <prefix>` so the update lands on the copy that's executing.
 *
 * This module is PURE string/path logic — no fs, no Date, no random, and no
 * dependence on the *host* path separator (it infers the path's own style from
 * the input, so Windows-style paths parse correctly even on a POSIX test host).
 * The impure `fs.realpathSync(import.meta.url)` lookup stays in cli.ts (the
 * shell). Keeping this pure makes the matching logic unit-testable in isolation
 * and safe to keep out of the way of the core-purity guard.
 */

/**
 * Given the realpath of the running CLI entry file, return the npm install
 * PREFIX that owns it — or null when the path doesn't look like a *global*
 * npm install (e.g. a local dev checkout, or an npx cache path).
 *
 * Two global-install layouts are recognised, both ending at the package's own
 * `node_modules/myshell-tools` directory:
 *
 *   POSIX / typical Unix global:
 *     <prefix>/lib/node_modules/myshell-tools/dist/cli.js   → <prefix>
 *
 *   Windows global (npm puts the package directly under the prefix, no `lib`):
 *     <prefix>\\node_modules\\myshell-tools\\dist\\cli.js    → <prefix>
 *
 * Conservative by design: anything that doesn't match one of these shapes —
 * including npx cache paths (which contain a `_npx` segment) and local source
 * checkouts (where the package dir is NOT named `node_modules/myshell-tools`) —
 * returns null so the caller falls back to a plain `npm install -g`.
 *
 * Pure / never throws.
 */
export function prefixForRunningEntry(entryRealPath: string): string | null {
  if (typeof entryRealPath !== 'string' || entryRealPath.length === 0) {
    return null;
  }

  // Infer the path's own separator style from the input rather than the host's,
  // so Windows-style paths parse correctly even when this runs on POSIX (and
  // vice versa). A leading drive letter (`C:`) or any backslash → Windows.
  const isWindowsStyle = /^[a-zA-Z]:[\\/]/.test(entryRealPath) || entryRealPath.includes('\\');
  const sep = isWindowsStyle ? '\\' : '/';

  // Split into non-empty path segments on either separator.
  const segments = entryRealPath.split(/[\\/]+/).filter((s) => s.length > 0);

  // npx-cache paths are never a stable global install we should target.
  if (segments.includes('_npx')) {
    return null;
  }

  // Locate the package's own install directory: a `node_modules` segment
  // immediately followed by `myshell-tools`.
  let pkgNodeModulesIdx = -1;
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'node_modules' && segments[i + 1] === 'myshell-tools') {
      pkgNodeModulesIdx = i;
      break;
    }
  }
  if (pkgNodeModulesIdx === -1) {
    return null;
  }

  // The prefix is everything BEFORE the install dir, with two recognised shapes:
  //   …/<prefix>/lib/node_modules/myshell-tools  → strip `lib` + `node_modules`
  //   …/<prefix>/node_modules/myshell-tools      → strip `node_modules`
  let prefixEndIdx: number;
  if (pkgNodeModulesIdx >= 1 && segments[pkgNodeModulesIdx - 1] === 'lib') {
    prefixEndIdx = pkgNodeModulesIdx - 1; // drop `lib` and `node_modules`
  } else {
    prefixEndIdx = pkgNodeModulesIdx; // drop `node_modules`
  }

  // Need at least one segment of prefix to be a real install root.
  if (prefixEndIdx <= 0) {
    return null;
  }

  const prefixSegments = segments.slice(0, prefixEndIdx);
  const joined = prefixSegments.join(sep);

  // On Windows the drive letter (`C:`) is the first segment and is already
  // absolute; on POSIX the leading separator was consumed by the split, so
  // re-add it.
  const isWindowsAbsolute = /^[a-zA-Z]:$/.test(prefixSegments[0] ?? '');
  return isWindowsAbsolute ? joined : sep + joined;
}
