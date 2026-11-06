import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
  {
    // Lint tests with the program `typecheck:tests` checks, which resolves the
    // workspace packages to their sources as vitest does (no build needed).
    files: ['tests/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
