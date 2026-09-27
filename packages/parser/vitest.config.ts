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
    // Forked workers loading the WebAssembly grammars intermittently crash
    // natively on Windows (0xC0000409) when the whole workspace tests at
    // once; worker threads do not.
    pool: 'threads',
  },
});
