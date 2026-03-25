import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['server/**/*.test.ts', 'tests/**/*.test.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['default', './vitest-test-logger.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts'],
      exclude: ['server/**/*.test.ts', 'node_modules']
    }
  }
})
