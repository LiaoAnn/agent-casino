import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts'],
    // A forgotten `.only` would silently skip the rest of the suite.
    allowOnly: false,
    passWithNoTests: false,
  },
});
