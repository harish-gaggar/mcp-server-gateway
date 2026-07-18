import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      enabled: true,
      reporter: ['html'],
    },

    reporters: ['default', 'json'],
    outputFile: {
      json: './coverage/test-summary.json',
    },
  },

  resolve: { tsconfigPaths: true },
})
