import { defineConfig, globalIgnores } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-plugin-prettier/recommended'
import globals from 'globals'

export default defineConfig(
  globalIgnores(['**/dist/**']),
  {
    languageOptions: {
      ecmaVersion: 2025,
      globals: { ...globals.node },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  }
)
