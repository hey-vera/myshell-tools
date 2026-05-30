// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strict,

  // Global ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  // Base rules for all TypeScript source files
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },

  // Allow console in UI, interface, and CLI entry-point files
  {
    files: ['src/ui/**/*.ts', 'src/interface/**/*.ts', 'src/cli.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Tests may use non-null assertions after explicit existence assertions —
  // a wrong assumption simply fails the test, so the strictness buys nothing here.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // ANSI-detection regexes legitimately contain the ESC control char.
      'no-control-regex': 'off',
    },
  },
);
