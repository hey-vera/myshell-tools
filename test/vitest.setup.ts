// Vitest global setup.
//
// Vitest intercepts `console` to capture output, and its replacement object does
// not expose the `Console` constructor. Ink's `patchConsole` (used by ink's
// `render`) calls `new console.Console(...)`, so under vitest it throws
// "console.Console is not a constructor". Restore it from node:console so Ink
// render-based UI tests behave exactly as they do under node:test.
import { Console } from 'node:console';

const c = globalThis.console as unknown as { Console?: unknown };
if (typeof c.Console !== 'function') {
  c.Console = Console;
}
