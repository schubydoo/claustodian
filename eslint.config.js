// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'scratch/**',
      '.claude/**',
      'data/**/*.yaml',
      'data/**/*.toml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
  },
  {
    // The Cloudflare Worker is plain JS running on workerd, not Node, so its
    // globals have to be declared or no-undef flags the whole runtime.
    files: ['worker/**/*.js'],
    languageOptions: {
      globals: {
        atob: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
      },
    },
  }
);
