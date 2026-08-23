import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // 'forks' (child processes) support process.chdir(), which tests use
    // to isolate .env writes from the real project directory.
    pool: 'forks',
    fileParallelism: false,
  },
});
