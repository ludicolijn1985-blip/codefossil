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
  },
});
