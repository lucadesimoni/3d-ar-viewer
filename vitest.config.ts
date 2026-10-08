import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Scripts' own tests are plain ESM, run in Node: they test the check tooling.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    setupFiles: ['src/test-setup.ts'],
  },
});
