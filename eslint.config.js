import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v6 folded the React Compiler strict rules
      // into `recommended`. This codebase predates them, and fixing ~87 hits
      // properly means restructuring effects one by one. Keep them visible
      // as warnings (ratchet: fix a rule, then restore it to 'error') while
      // the classic bug-catching rules (rules-of-hooks, exhaustive-deps)
      // stay errors and gate CI.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      // Fast-refresh ergonomics, not correctness.
      'react-refresh/only-export-components': 'warn',
    },
  },
])
