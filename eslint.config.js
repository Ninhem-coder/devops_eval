// Configuration ESLint (lint du code JavaScript)
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'reports/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // dans les tests, describe / test / expect existent (fournis par Jest)
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.jest } },
  },
];
