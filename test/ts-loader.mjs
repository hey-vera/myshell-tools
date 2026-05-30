/**
 * test/ts-loader.mjs — ESM loader hook for node --experimental-strip-types tests.
 *
 * Node's --experimental-strip-types can load .ts files directly but does NOT
 * remap .js specifiers to .ts files when a src/ module imports its siblings
 * using the TypeScript/ESM convention of `from './foo.js'`.
 *
 * This loader resolves the mismatch: if a .js specifier would resolve into the
 * project's src/ tree but no .js file exists there, try replacing the .js
 * extension with .ts and return that URL instead.
 *
 * Usage (single file):
 *   node --import ./test/ts-loader.mjs --experimental-strip-types --test <files>
 *
 * This file is an ES module (.mjs) and has no TypeScript — it must be plain JS
 * so Node can load it without stripping.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ESM resolve hook.
 *
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {Function} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  // Only intercept .js specifiers that originate from within src/
  if (
    specifier.endsWith('.js') &&
    context.parentURL &&
    context.parentURL.includes('/src/')
  ) {
    // Build the candidate .ts path
    const tsSpecifier = specifier.slice(0, -3) + '.ts';

    // Try to resolve the .ts version using the default resolver
    try {
      const resolved = await nextResolve(tsSpecifier, context);
      // Verify the file actually exists (avoids resolving .ts phantom files)
      const filePath = fileURLToPath(resolved.url);
      if (existsSync(filePath)) {
        return resolved;
      }
    } catch {
      // Fall through to default resolution
    }
  }

  return nextResolve(specifier, context);
}
