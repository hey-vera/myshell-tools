/**
 * test/register.mjs — registers the .js→.ts resolve hook for the test runner
 * without the deprecated `--experimental-loader` flag.
 *
 * Usage: node --import ./test/register.mjs --test "<globs>"
 */
import { register } from 'node:module';

register('./ts-loader.mjs', import.meta.url);
