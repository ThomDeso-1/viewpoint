import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Raised from 15s as the suite grew: every authenticated test file
    // now pays scrypt (~57ms per login, deliberately slow) on top of
    // migrations and temp-directory setup, and the whole suite runs in
    // one forked worker. No individual test should come close to this —
    // it is headroom against contention, not an expected duration.
    testTimeout: 30000,
    hookTimeout: 30000,
    // 'forks' (child processes) support process.chdir(), which tests use
    // to isolate .env writes from the real project directory.
    pool: 'forks',
    fileParallelism: false,
  },
});
