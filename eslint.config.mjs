import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/', 'data/', 'coverage/', '.claude/']),
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // CSP-friendly client: DOM is built with textContent via dom.js only.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use the h() helper from dom.js (textContent only).' },
        { property: 'outerHTML', message: 'Use the h() helper from dom.js (textContent only).' },
        { property: 'insertAdjacentHTML', message: 'Use the h() helper from dom.js (textContent only).' },
      ],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['shared/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
