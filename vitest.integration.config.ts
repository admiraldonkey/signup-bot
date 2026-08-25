import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],

    globalSetup: ["./tests/support/integration-global-setup.ts"],

    setupFiles: ["./tests/support/integration-test-setup.ts"],

    /*
     * All integration tests currently share one disposable PostgreSQL
     * database. Run test files one at a time so one file cannot reset
     * database state underneath another file.
     *
     * Tests inside an individual file are sequential by default.
     * Explicit concurrency tests can still opt into concurrent work when
     * that behaviour is what we actually intend to test.
     */
    fileParallelism: false,

    /*
     * Ordinary tests should still fail reasonably quickly, while database
     * setup/cleanup hooks get more room for Docker/PostgreSQL operations.
     */
    testTimeout: 10_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
  },
});
