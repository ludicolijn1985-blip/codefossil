import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@codefossil/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@codefossil/source'],
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Tests drive real git processes, which are slow to spawn on Windows.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
