import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Raised again as the suite grew (15s → 30s → 60s): every
    // authenticated test file pays scrypt (~57ms per login, deliberately
    // slow) on top of migrations and temp-directory setup, and the whole
    // suite runs sequentially in one forked worker (see fileParallelism
    // below). A clean run is ~20s total; no individual test should come
    // near this cap — it is headroom against a loaded machine, not an
    // expected duration. If the suite keeps growing, the real fix is to
    // let `pool: 'forks'` run files in parallel (each fork has its own
    // cwd, so the .env isolation still holds) rather than raising this.
    testTimeout: 60000,
    hookTimeout: 60000,
    // 'forks' (child processes) support process.chdir(), which tests use
    // to isolate .env writes from the real project directory.
    pool: 'forks',
    fileParallelism: false,
  },
});
