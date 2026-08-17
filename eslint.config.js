import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    ignores: ['dist/**', 'dist-firefox/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // .mjs as well as .js: tests/helpers/fake-amo.mjs is loaded with
    // `node --import` from a fixture directory that has no package.json, so the
    // extension is the only thing telling Node it is a module.
    files: ['tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // node for fs-based tests, browser + webextensions for the jsdom tests
      // that drive the popup/options/background scripts against a fake chrome.
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
    },
  },
];
