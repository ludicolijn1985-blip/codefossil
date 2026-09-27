import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['apps/web/**/*.tsx'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.config.{js,mjs,ts}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
