import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescriptConfig from 'eslint-config-next/typescript';

/**
 * Flat config. Next 16 ships flat configs directly, so no eslintrc compat layer
 * is needed.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'data/**',
      'backups/**',
      'screenshots/**',
      'traces/**',
      '.chrome-profile/**',
      'next-env.d.ts',
    ],
  },
  ...coreWebVitals,
  ...typescriptConfig,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Structured logging goes through src/lib/logger.ts; CLIs are exempt below.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'src/**/cli/**/*.ts', 'src/lib/logger.ts', 'src/worker/main.ts', 'src/app/error.tsx'],
    rules: { 'no-console': 'off' },
  },
];

export default config;
