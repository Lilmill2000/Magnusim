import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const phase0Rules = {
  'no-unused-vars': 'warn',
  'no-undef': 'error',
  eqeqeq: 'warn',
  'no-empty': 'warn',
  'no-irregular-whitespace': 'warn',
  'no-useless-assignment': 'warn',
  'no-redeclare': 'warn',
  'no-constant-condition': 'warn',
  'no-prototype-builtins': 'warn',
  'no-cond-assign': 'warn',
  'no-fallthrough': 'warn',
  'no-unsafe-finally': 'warn',
  'no-extra-boolean-cast': 'warn',
  'no-useless-catch': 'warn',
  'no-sparse-arrays': 'warn',
  'no-func-assign': 'warn',
  'no-import-assign': 'warn',
  'no-setter-return': 'warn',
  'no-unsafe-negation': 'warn',
  'no-unsafe-optional-chaining': 'warn',
  'no-unreachable': 'warn',
  'no-case-declarations': 'warn',
  'no-useless-escape': 'warn',
  'no-control-regex': 'warn',
  'no-useless-backreference': 'warn',
  'getter-return': 'warn',
  'valid-typeof': 'warn',
  'no-global-assign': 'warn',
  'no-self-assign': 'warn',
  'no-dupe-keys': 'warn',
  'no-dupe-args': 'warn',
  'no-dupe-class-members': 'warn',
  'no-duplicate-case': 'warn',
  'no-loss-of-precision': 'warn',
  'no-obj-calls': 'warn',
  'no-compare-neg-zero': 'warn',
  'use-isnan': 'warn',
  'no-constant-binary-expression': 'warn',
  'no-constructor-return': 'warn',
  'no-new-native-nonconstructor': 'warn',
  'no-unused-private-class-members': 'warn',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'python/**',
      'projects/**',
      '.cache/**',
      'e2e/**',
      'scripts/diag-*.cjs',
      'scripts/prove-*.cjs',
      'src/app/shell.html',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: phase0Rules,
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: phase0Rules,
  },
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/home/controller.ts', 'src/wizard/controller.ts', 'src/workbench/**'],
    rules: {
      ...(cfg.rules || {}),
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  })),
];