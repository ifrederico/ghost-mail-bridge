var js = require('@eslint/js');
var globals = require('globals');

module.exports = [
  {
    ignores: [
      'docs/**',
      'data/**',
      'node_modules/**'
    ]
  },
  {
    files: ['server.js', 'lib/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 2022,
      sourceType: 'commonjs'
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  }
];
