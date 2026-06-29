import { defineConfig } from 'vitest/config';

// Vitest config for myshell-tools. The suite was authored against node:test; the
// migration keeps node:assert (vitest runs it natively) and swaps only the
// describe/it import to 'vitest'. Node environment, no injected globals — tests
// import describe/it/vi explicitly, matching the existing explicit-import style.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./test/vitest.setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Long app-level flows (menu-flow etc.) need headroom on Windows.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
